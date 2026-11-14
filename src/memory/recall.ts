import { mergeContentText } from "../utils/content.js";
import type { MemoryRepo, MemoryRow } from "./memory-repo.js";
import type { SettingsService } from "../settings/service.js";
import { embedText, type EmbeddingConfig } from "./embedding.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("memory:recall");

/** 可注入的向量化函数（默认真实 embedText，测试可替换）。 */
export type EmbedFn = (cfg: EmbeddingConfig, text: string) => Promise<Float32Array>;

/**
 * 每轮记忆动态召回（轻量检索注入）。
 *
 * - 以最后一条 user 消息为查询词跑 BM25+向量 RRF 混合检索（searchHybrid，
 *   向量阈值 memory_similarity_min；embedding 不可用/失败自动降级纯 BM25），取 top-k；
 * - 无命中时回退近期段（created_at 倒序），保证冷启动/闲聊轮仍有上下文；
 * - 排除 instruction 类（恒定适用的偏好由画像常驻承载，避免重复注入）；
 * - 注入位置：拼在最后一条 user 消息之前（不进 system，保快照稳定）。
 *
 * 查询向量化有一次网络往返，靠按（项目+记忆版本位+查询词）缓存摊薄：
 * 客户端 tool-call 循环每轮全量重发历史，同查询只算 1 次。
 *
 * search() 为显式检索入口（MCP memory_search 与冲突检测共用），与召回同走混合检索。
 */

export interface RecallOutcome {
  block: string;
  count: number;
  /** 命中记忆清单（日志/审计用）：id/类型/正文。 */
  items: { id: string; kind: string; content: string }[];
}

const DISCLAIMER = "以下是本项目与当前问题相关或最近的记忆，仅用于辅助回答当前这一轮，不要视为永久系统规则：";

export class MemoryRecaller {
  private readonly memories: MemoryRepo;
  private readonly settings: SettingsService;
  private readonly embed: EmbedFn;
  /**
   * 召回缓存：key = projectId + 记忆库版本位（活跃记忆最新 created_at）。
   * 客户端 tool-call 循环每轮全量重发历史，缓存让重复请求只算 1 次，
   * 且注入块跨请求字节一致（利上游 KV cache）。版本位使新记忆入库即时让缓存失效。
   * TTL 对齐 session_ttl_minutes；空结果也缓存。
   */
  private readonly cache = new Map<string, { at: number; outcome: RecallOutcome }>();

  constructor(memories: MemoryRepo, settings: SettingsService, embed: EmbedFn = embedText) {
    this.memories = memories;
    this.settings = settings;
    this.embed = embed;
  }

  /**
   * 执行召回：
   * 1) 以最后一条 user 消息跑 BM25+向量 RRF 混合检索，取 top-k（排除 instruction）；
   *    向量按 memory_similarity_min 阈值过滤；embedding 不可用/失败自动降级纯 BM25；
   * 2) 无命中回退近期段（created_at 倒序 top-k，排除 instruction）。
   * @param queryText 本轮最后一条 user 消息文本（可空——空则直接走近期段）
   */
  async recall(projectId: string, queryText = ""): Promise<RecallOutcome> {
    const topK = this.settings.getInt("memory_recall_top_k");

    // 缓存版本位：活跃记忆的最新生成时刻 + 查询词。新记忆入库或问题变化即让 key 失效。
    const cacheKey = `${projectId}\u0000${this.memories.latestActiveCreatedAt(projectId)}\u0000${queryText.slice(0, 200)}`;
    const ttlMs = this.settings.getInt("session_ttl_minutes") * 60_000;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) {
      return hit.outcome;
    }

    let picked: MemoryRow[] = [];
    if (queryText.trim()) {
      // 混合检索：查询向量可用则 BM25+向量 RRF，否则纯 BM25（searchHybrid 内部降级）。
      picked = (await this.searchAsync(projectId, queryText.slice(0, 2048), topK * 3))
        .map((h) => h.record)
        .filter((r) => r.kind !== "instruction")
        .slice(0, topK);
    }
    if (!picked.length) {
      // 多取一些再过滤 instruction，避免近期全是偏好指令时整块空转。
      picked = this.memories
        .listActiveByRecency(projectId, topK * 3, ["instruction"])
        .slice(0, topK);
    }

    const outcome: RecallOutcome = picked.length
      ? {
          block: renderBlock(picked),
          count: picked.length,
          items: picked.map((r) => ({ id: r.id, kind: r.kind, content: r.content })),
        }
      : { block: "", count: 0, items: [] };
    this.pruneCache();
    this.cache.set(cacheKey, { at: Date.now(), outcome });
    return outcome;
  }

  /** 结构化检索（MCP memory_search 用）：向量+BM25 混合 RRF，返回记录。 */
  async search(projectId: string, query: string, topK: number): Promise<{ id: string; kind: string; content: string; priority: number; score: number }[]> {
    const hits = await this.searchAsync(projectId, query.trim().slice(0, 2048), topK);
    return hits.map((h) => ({
      id: h.record.id,
      kind: h.record.kind,
      content: h.record.content,
      priority: h.record.priority,
      score: Number(h.score.toFixed(4)),
    }));
  }

  private async searchAsync(projectId: string, query: string, topK: number) {
    let queryVec: Float32Array | null = null;
    const embCfg = this.embeddingConfig();
    if (embCfg) {
      try {
        queryVec = await this.embed(embCfg, query);
      } catch (err) {
        log.warn({ err: String(err) }, "查询向量化失败，降级 BM25");
      }
    }
    const simMin = this.settings.getFloat("memory_similarity_min");
    return this.memories.searchHybrid(projectId, query, queryVec, topK, simMin);
  }

  private embeddingConfig(): EmbeddingConfig | null {
    if (!this.memories.vecEnabled) return null;
    return this.settings.getResolvedLlmConfig("embedding_model");
  }

  /** 缓存清理：条目超上限时淘汰最旧的一半（防长时运行内存无界增长）。 */
  private pruneCache(): void {
    const MAX = 512;
    if (this.cache.size < MAX) return;
    const entries = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, Math.floor(MAX / 2))) this.cache.delete(k);
  }
}

/**
 * 渲染召回块（近期段，按生成时间倒序）：条数由 memory_recall_top_k 控制，
 * 单条正文原样渲染（提取侧不设长度上限）。行内不携带记忆 id（id 无入参用途，
 * 仅日志可查），只留 type。DISCLAIMER 为固定文案，命中缓存后同请求字节一致，
 * 不破坏 KV cache 前缀。
 */
function renderBlock(recent: { kind: string; content: string }[]): string {
  const lines = [`<recalled>`, DISCLAIMER];
  recent.forEach((r, n) => lines.push(`${n + 1}. [type:${r.kind}] ${r.content}`));
  lines.push(`</recalled>`);
  return lines.join("\n");
}

/** 把召回块拼到最后一条 user 消息之前（文本前缀），返回新数组。 */
export function prependRecall<T extends { role: string; content?: unknown }>(
  messages: readonly T[],
  block: string,
): T[] {
  if (!block.trim()) return messages.slice();
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "user") continue;
    m.content = mergeContentText(m.content, block, true);
    return out;
  }
  return out;
}
