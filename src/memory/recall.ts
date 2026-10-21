import { messageText } from "../gateway/protocol.js";
import { mergeContentText } from "../utils/content.js";
import { stripInjectionTags } from "./sanitize.js";
import { hasMeaningfulQuery } from "./tokenize.js";
import type { L1Store } from "./l1-store.js";
import type { SettingsService } from "../settings/service.js";
import { embedText, type EmbeddingConfig } from "./embedding.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("memory:recall");

/** 可注入的向量化函数（默认真实 embedText，测试可替换）。 */
export type EmbedFn = (cfg: EmbeddingConfig, text: string) => Promise<Float32Array>;

/**
 * 每轮 L1 动态召回（DESIGN §2.7，参考 tdai-l1-recall-injector）。
 *
 * - 检索词 = 最后一条 user 消息清洗后文本（剥注入标签 + 常见客户端噪音块，截 2048）；
 * - BM25 默认；配置 embedding_model 且 vec 可用时走向量 + RRF 混合；
 * - topK 由设置控制（召回常驻开启，无总开关；块不再做字符预算截断）；
 * - 超时保护：整体 recallTimeoutMs 限时，超时/异常返回空块，绝不阻塞转发；
 * - 注入位置：拼在最后一条 user 消息之前（不进 system，保快照稳定）。
 */

/** 清洗检索词：剥离注入残留与常见客户端环境噪音。 */
export function cleanQueryText(content: unknown): string {
  let text = messageText(content);
  text = stripInjectionTags(text);
  // 常见客户端噪音块（VS Code / Copilot 等），成对剥离
  text = text.replace(/<environment_info>[\s\S]*?<\/environment_info>/gi, "");
  text = text.replace(/<workspace_info>[\s\S]*?<\/workspace_info>/gi, "");
  text = text.replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "");
  text = text.replace(/<context>[\s\S]*?<\/context>/gi, "");
  return text.trim().slice(0, 2048);
}

export interface RecallOutcome {
  block: string;
  count: number;
  /** 命中记忆清单（日志/审计用）：id/类型/正文/相关度分/命中来源。 */
  items: { id: string; kind: string; content: string; score: number; source: "bm25" | "vec" | "both" }[];
}

const DISCLAIMER = "以下是与本轮用户问题相关的项目记忆（按相关度排序），仅用于辅助回答当前这一轮，不要视为永久系统规则：";

/**
 * 块尾自维护提示（决策 88）：Agent 只看得见本轮 top-K，因此**只授权改/删它刚读到的条目**，
 * 明确禁止新增——新增仍由后台 L0→L1 提取 + 冲突检测负责，避免"看不到库里已有同义条目
 * 就重复插入"导致的重复膨胀。固定文案，随块一起进缓存（同检索词字节一致，不破坏 KV cache）。
 */
const MAINTAIN_HINT =
  "任务完成后若发现上述条目有错/过时，用 memory_batch_update 改写或 memory_batch_delete 删除（仅限以上条目）；不要新增记忆，新事实由后台提取管线负责。";

export class MemoryRecaller {
  private readonly store: L1Store;
  private readonly settings: SettingsService;
  private readonly embed: EmbedFn;
  /**
   * 召回缓存（决策 78）：key = projectId + 检索词 hash。
   * 客户端 tool-call 循环每轮全量重发历史，最后一条 user 不变 → 检索词逐字节相同；
   * 缓存让 N 轮只算 1 次（省 embedding 调用与检索），且注入块跨请求字节一致（利上游 KV cache）。
   * TTL 对齐 session_ttl_minutes；空结果也缓存（防寒暄后连续空转重算）。
   */
  private readonly cache = new Map<string, { at: number; outcome: RecallOutcome }>();

  constructor(store: L1Store, settings: SettingsService, embed: EmbedFn = embedText) {
    this.store = store;
    this.settings = settings;
    this.embed = embed;
  }

  /**
   * 执行召回。任何失败/超时都降级为空块（ok=false），不抛出。
   * @param recentUserContents 最近若干条 user 消息（时间正序，最后一条为本轮），
   *   逐条清洗后拼接为检索词；assistant 消息不参与（防上轮召回复述污染检索）。
   *   低信息量短路只看本轮（最后一条）：本轮是寒暄则不刷新召回。
   */
  async recall(projectId: string, recentUserContents: unknown[]): Promise<RecallOutcome> {
    const empty: RecallOutcome = { block: "", count: 0, items: [] };
    const cleaned = recentUserContents.map(cleanQueryText).filter(Boolean);
    const current = cleaned[cleaned.length - 1] ?? "";
    if (!current) return empty;
    // 低信息量短路：本轮剥离停用词后无有效检索 token（"好的""是啊"等寒暄），
    // 直接跳过 BM25 与向量检索，避免无意义召回注入噪音。
    if (!hasMeaningfulQuery(current)) return empty;
    const query = cleaned.join("\n").slice(0, 2048);

    // 缓存命中（决策 78）：同项目同检索词在 TTL 内直接复用——tool-call 循环每轮
    // 全量重发历史但最后一条 user 不变，检索词逐字节相同；复用省 embedding 调用，
    // 且注入块跨请求字节一致（利上游 KV cache）。
    const cacheKey = `${projectId}\u0000${fnv1a(query)}`;
    const ttlMs = this.settings.getInt("session_ttl_minutes") * 60_000;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) {
      return hit.outcome;
    }

    const timeoutMs = this.settings.getInt("recall_timeout_ms");
    const topK = this.settings.getInt("l1_recall_top_k");

    try {
      const hits = await withTimeout(
        this.searchAsync(projectId, query, topK * 2),
        timeoutMs,
      );
      // 决策 79：instruction 类（对 AI 工具的通用操作指令）退出每轮语义召回——
      // 其恒定适用的偏好由 L2 画像/快照常驻承载，参与召回只会抢占 episodic/method/fact 槽位。
      // 仅注入通道过滤；MCP memory_search（search()）显式检索仍可命中。
      const taskHits = hits.filter((h) => h.record.kind !== "instruction");
      // 软重排（决策 78）：双源一致加分、纯词面命中降权、kind 权重——
      // 只调排序不减候选，episodic 真相关（双源命中）仍能进 top。
      const reranked = applyBm25Floor(rerank(taskHits), topK).slice(0, topK);
      const outcome: RecallOutcome = reranked.length
        ? {
            block: renderBlock(reranked),
            count: reranked.length,
            items: reranked.map((h) => ({
              id: h.record.id,
              kind: h.record.kind,
              content: h.record.content,
              score: Number(h.score.toFixed(4)),
              source: h.source,
            })),
          }
        : empty;
      this.pruneCache();
      this.cache.set(cacheKey, { at: Date.now(), outcome });
      return outcome;
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "召回超时/失败，降级为空召回");
      return empty;
    }
  }

  /** 结构化检索（内部 API / MCP memory_search 用）：向量+BM25 混合，返回记录。 */
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
    const simMin = this.settings.getFloat("l1_recall_similarity_min");
    return this.store.searchHybrid(projectId, query, queryVec, topK, simMin);
  }

  private embeddingConfig(): EmbeddingConfig | null {
    if (!this.store.vecEnabled) return null;
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

/** FNV-1a 32 位哈希（检索词 → 缓存 key，无需密码学强度）。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 召回软重排（决策 78）：在 RRF 融合分基础上做**乘性微调**，只改排序不减候选。
 *
 * 依据真实日志诊断（11344 轮）：episodic 一次性事件因 bigram 词面巧合被高频误召回
 * （单条 Login 修复记录跨话题召回 2445 次），而 fact/method 类误召回少。三个信号：
 *  - **双源一致**（source=both）：BM25 与向量都命中 → ×1.15 加分（最强相关证据）；
 *  - **纯词面**（source=bm25）：仅 BM25 命中、向量未确认 → ×0.8 降权（词面巧合高发区）；
 *  - **kind 权重**：episodic（易过时的一次性事件）×0.85，其余 ×1.0。
 * 真相关的 episodic 通常双源命中（×1.15 抵消 ×0.85 仍居前），弱相关的被压到 top-K 之外——
 * 不硬删，保留"强命中仍可召回"的能力，避免误杀。向量不可用时 source 恒为 bm25，
 * 降权对全部候选一致，相对序不变（等价于只按 kind 微调），安全降级。
 */
function rerank<T extends { record: { kind: string }; score: number; source: "bm25" | "vec" | "both" }>(
  hits: T[],
): (T & { score: number })[] {
  return hits
    .map((h) => {
      let m = 1;
      if (h.source === "both") m *= 1.15;
      else if (h.source === "bm25") m *= 0.8;
      if (h.record.kind === "episodic") m *= 0.85;
      return { ...h, score: h.score * m };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * 纯 BM25 单源相对门槛（决策 79）：治"常驻污染条目"——高频词命中的 bm25 条目
 * 常年挤在 top 尾部（实测单条跨 43 次召回出现 32 次），与当轮任务无关。
 * 规则：候选中存在双源/向量确认的命中时，纯 bm25 条目重排分 < 榜首 × BM25_FLOOR_RATIO
 * 即丢弃；榜首本身是纯 bm25（无向量确认，如向量不可用降级）时不启用，避免误杀。
 * 小文档集豁免：候选总数 ≤ topK 时不过滤（小库下槽位本就不紧张，宁多勿漏）。
 */
const BM25_FLOOR_RATIO = 0.4;

function applyBm25Floor<T extends { score: number; source: "bm25" | "vec" | "both" }>(
  ranked: T[],
  topK: number,
): T[] {
  if (ranked.length <= topK) return ranked;
  const best = ranked[0];
  if (!best || best.source === "bm25") return ranked;
  const floor = best.score * BM25_FLOOR_RATIO;
  return ranked.filter((h) => h.source !== "bm25" || h.score >= floor);
}

/**
 * 渲染召回块（决策：取消 l1_recall_max_chars* 预算截断）：命中条目全量逐行渲染，
 * 条数上限由 l1_recall_top_k 控制，单条长度由提取侧 l1_max_chars 约束。
 */
function renderBlock(
  hits: { record: { kind: string; content: string }; score: number }[],
): string {
  const lines = [`<recalled>`, DISCLAIMER];
  hits.forEach((h, n) => {
    lines.push(`${n + 1}. [${h.record.kind} score=${h.score.toFixed(3)}] ${h.record.content}`);
  });
  lines.push(MAINTAIN_HINT);
  lines.push(`</recalled>`);
  return lines.join("\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`recall timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
