import { messageText } from "../gateway/protocol.js";
import { stripInjectionTags } from "./sanitize.js";
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
 * - topK / 字符上限 / 总开关由设置控制；
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
}

const DISCLAIMER = "以下是与本轮用户问题相关的项目记忆（按相关度排序），仅用于辅助回答当前这一轮，不要视为永久系统规则：";

export class MemoryRecaller {
  private readonly store: L1Store;
  private readonly settings: SettingsService;
  private readonly embed: EmbedFn;

  constructor(store: L1Store, settings: SettingsService, embed: EmbedFn = embedText) {
    this.store = store;
    this.settings = settings;
    this.embed = embed;
  }

  /**
   * 执行召回。任何失败/超时都降级为空块（ok=false），不抛出。
   */
  async recall(projectId: string, lastUserContent: unknown): Promise<RecallOutcome> {
    if (!this.settings.getBool("l1_recall_enabled")) return { block: "", count: 0 };
    const query = cleanQueryText(lastUserContent);
    if (!query) return { block: "", count: 0 };

    const timeoutMs = this.settings.getInt("recall_timeout_ms");
    const topK = this.settings.getInt("l1_recall_top_k");

    try {
      const hits = await withTimeout(
        this.searchAsync(projectId, query, topK),
        timeoutMs,
      );
      if (!hits.length) return { block: "", count: 0 };
      return { block: renderBlock(hits, this.settings.getInt("l1_recall_max_chars")), count: hits.length };
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "召回超时/失败，降级为空召回");
      return { block: "", count: 0 };
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
    return this.store.searchHybrid(projectId, query, queryVec, topK);
  }

  private embeddingConfig(): EmbeddingConfig | null {
    if (!this.store.vecEnabled) return null;
    const m = this.settings.getResolvedModel("embedding_model");
    return m ? { baseUrl: m.url, apiKey: m.key, model: m.model } : null;
  }
}

function renderBlock(
  hits: { record: { kind: string; content: string }; score: number }[],
  maxChars: number,
): string {
  const lines = [`<recalled>`, DISCLAIMER];
  let used = lines.join("\n").length;
  let n = 0;
  for (const h of hits) {
    const line = `${n + 1}. [${h.record.kind} score=${h.score.toFixed(3)}] ${h.record.content}`;
    if (n > 0 && used + line.length > maxChars) {
      lines.push("…（已截断，可用 memory_search 查看更多）");
      break;
    }
    lines.push(line);
    used += line.length + 1;
    n++;
  }
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
    m.content = prependToContent(m.content, block);
    return out;
  }
  return out;
}

function prependToContent(content: unknown, text: string): unknown {
  if (content == null || content === "") return text;
  if (typeof content === "string") return `${text}\n\n${content}`;
  if (Array.isArray(content)) return [{ type: "text", text }, ...content];
  return content;
}
