import type { DatabaseSync } from "node:sqlite";
import { chatComplete, type LlmCallConfig, type LlmMessage, type LlmCallOptions } from "../llm/client.js";
import { parseLlmJsonArray } from "../utils/json.js";
import { newId } from "../infra/id.js";
import { createLogger } from "../infra/logger.js";
import {
  getExtractSystemPrompt,
  formatExtractionPrompt,
  getConflictSystemPrompt,
  formatBatchConflictPrompt,
  type L1Kind,
  type ConflictMatch,
  type ExtractMessage,
} from "./prompts.js";
import { L1Store, type L1Record } from "./l1-store.js";
import type { SettingsService } from "../settings/service.js";

const log = createLogger("memory:l1");

export interface ExtractResult {
  extracted: number;
  stored: number;
  skipped: number;
  lastSceneName: string | null;
}

interface LlmSceneSegment {
  scene_name?: unknown;
  message_ids?: unknown;
  memories?: unknown;
}

interface LlmMemory {
  content?: unknown;
  type?: unknown;
  priority?: unknown;
  source_message_ids?: unknown;
  metadata?: unknown;
}

interface ConflictDecision {
  record_id?: unknown;
  action?: unknown;
  target_ids?: unknown;
  merged_content?: unknown;
  merged_type?: unknown;
  merged_priority?: unknown;
  merged_timestamps?: unknown;
}

export type LlmCall = (
  cfg: LlmCallConfig,
  messages: LlmMessage[],
  opts?: LlmCallOptions,
) => Promise<string>;

/** LLM token 消耗累加器（多次调用合并）。 */
interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

function usageRecorder(u: TokenUsage): LlmCallOptions["onUsage"] {
  return (x) => {
    u.prompt += x.promptTokens;
    u.completion += x.completionTokens;
    u.total += x.totalTokens;
  };
}

/**
 * L1 两阶段提取管线（DESIGN §2.7，参考 l1-extractor + l1-dedup）：
 *  阶段一：LLM 提取（情境切分 + 小颗粒记忆，JSON mode）
 *  阶段二：批量冲突检测（FTS 候选召回 → 一次 LLM 判定 store/skip/update/merge）
 */
export class L1Extractor {
  private readonly raw: DatabaseSync;
  private readonly store: L1Store;
  private readonly settings: SettingsService;
  private readonly llmCall: LlmCall;
  /** projectId → 项目磁盘路径（日志用，由装配方注入）。 */
  pathOf: ((projectId: string) => string | undefined) | null = null;

  constructor(raw: DatabaseSync, store: L1Store, settings: SettingsService, llmCall: LlmCall = chatComplete) {
    this.raw = raw;
    this.store = store;
    this.settings = settings;
    this.llmCall = llmCall;
  }

  /**
   * 对一批 L0 消息执行提取。
   * @param l0Ids pipeline_state 缓冲的 L0 记录 id
   * @param sessionKey 来源会话（日志用，可选）
   */
  async extract(projectId: string, l0Ids: string[], llm: LlmCallConfig, sessionKey?: string): Promise<ExtractResult> {
    const rows = this.raw
      .prepare(
        `SELECT id, role, content, created_at FROM mem_l0
         WHERE project_id = ? AND id IN (${l0Ids.map(() => "?").join(",")}) AND deleted_at IS NULL
         ORDER BY turn_seq`,
      )
      .all(projectId, ...l0Ids) as { id: string; role: "user" | "assistant"; content: string; created_at: number }[];
    if (!rows.length) return { extracted: 0, stored: 0, skipped: 0, lastSceneName: null };

    const maxNew = this.settings.getInt("extract_max_new_messages");
    const maxBg = this.settings.getInt("extract_max_bg_messages");
    const newOnes = rows.slice(-maxNew);
    const bgOnes = rows.slice(0, Math.max(0, rows.length - maxNew)).slice(-maxBg);

    const prev = this.raw
      .prepare("SELECT last_scene_name FROM pipeline_state WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(projectId) as { last_scene_name: string | null } | undefined;

    // ── 阶段一：提取 ──
    const usage: TokenUsage = { prompt: 0, completion: 0, total: 0 };
    const segments = await this.runExtraction(llm, newOnes, bgOnes, prev?.last_scene_name ?? undefined, usage);
    // segments === null 表示提取阶段失败（LLM 调用异常或返回非法 JSON），与"合法空产出 []"区分：
    // 失败必须抛出，让调度器保留缓冲下轮重试，绝不静默丢弃整批对话（决策 72）。
    if (!segments) throw new Error("L1 提取阶段失败：LLM 调用异常或返回非法 JSON");

    const minPriority = this.settings.getInt("extract_min_priority");
    const maxItems = this.settings.getInt("memory_extract_max_items");
    const batchId = newId("bat");

    const pending: { recordId: string; kind: L1Kind; content: string; priority: number; sceneName: string; sourceL0Ids: string[]; metadata: string; createdAt: number }[] = [];
    // 批内去重：阶段二候选池在任何插入前一次性算好，同批重复内容互相不可见会双双落库，这里先按规范化内容去重（决策 72）。
    const seen = new Set<string>();
    let lastSceneName: string | null = prev?.last_scene_name ?? null;

    for (const seg of segments) {
      const sceneName = typeof seg.scene_name === "string" ? seg.scene_name.trim() : "";
      if (sceneName) lastSceneName = sceneName;
      const mems = Array.isArray(seg.memories) ? (seg.memories as LlmMemory[]) : [];
      for (const m of mems) {
        if (pending.length >= maxItems) break;
        const content = typeof m.content === "string" ? m.content.trim() : "";
        if (!content) continue;
        const kind = (m.type as string) ?? "";
        if (!isL1Kind(kind)) continue;
        const priority = typeof m.priority === "number" ? m.priority : 70;
        if (priority < minPriority) continue;
        const dedupeKey = content.replace(/\s+/g, " ").toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const sourceIds = Array.isArray(m.source_message_ids)
          ? (m.source_message_ids as unknown[]).map(String).filter((id) => l0Ids.includes(id))
          : [];
        pending.push({
          recordId: newId("l1c"),
          kind,
          content,
          priority,
          sceneName: sceneName || lastSceneName || "",
          sourceL0Ids: sourceIds,
          metadata: normalizeMetadata(m.metadata),
          createdAt: Date.now(),
        });
      }
    }

    if (!pending.length) {
      this.updateSceneName(projectId, lastSceneName);
      return { extracted: 0, stored: 0, skipped: 0, lastSceneName };
    }

    // ── 阶段二：批量冲突检测 ──
    const topK = this.settings.getInt("conflict_recall_top_k");
    const matches: ConflictMatch[] = pending.map((p) => ({
      newMemory: { recordId: p.recordId, content: p.content, type: p.kind, priority: p.priority, sceneName: p.sceneName },
      candidates: this.store.search(projectId, p.content, topK).map((h) => candOf(h.record)),
    }));

    let decisions: ConflictDecision[] = [];
    const hasPool = matches.some((m) => m.candidates.length > 0);
    if (hasPool) {
      decisions = (await this.runConflictDetection(llm, matches, usage)) ?? [];
    }
    const decMap = new Map(decisions.map((d) => [String(d.record_id), d]));

    let stored = 0;
    let skipped = 0;
    for (const p of pending) {
      const d = decMap.get(p.recordId);
      const action = normalizeAction(d?.action);
      const targetIds = Array.isArray(d?.target_ids) ? (d.target_ids as unknown[]).map(String) : [];
      const mergedContent = typeof d?.merged_content === "string" && d.merged_content.trim() ? d.merged_content.trim() : null;

      const content = (action === "merge" || action === "update") && mergedContent ? mergedContent : p.content;
      const kindRaw = (action === "merge" || action === "update") && typeof d?.merged_type === "string" ? d.merged_type : p.kind;
      const kind = isL1Kind(kindRaw) ? kindRaw : p.kind;
      const prRaw = (action === "merge" || action === "update") && typeof d?.merged_priority === "number" ? d.merged_priority : p.priority;
      // merge/update：时间戳并集（去重排序）写回 metadata，保留旧记忆的活动时间
      const metadata =
        action === "merge" || action === "update"
          ? mergeTimestamps(
              [p.metadata, ...targetIds.map((t) => this.store.get(t)?.metadata ?? "{}")],
              Array.isArray(d?.merged_timestamps) ? (d!.merged_timestamps as unknown[]).map(String) : [],
            )
          : p.metadata;

      const id = this.store.applyDecision(
        projectId,
        { action, targetIds },
        { kind, content, priority: prRaw, sceneName: p.sceneName || null, sourceL0Ids: p.sourceL0Ids, metadata, batchId, createdAt: p.createdAt },
      );
      if (id) stored++;
      else skipped++;
    }

    this.updateSceneName(projectId, lastSceneName);
    log.info(
      {
        projectId,
        path: this.pathOf?.(projectId) ?? "",
        sessionKey: sessionKey ?? "",
        extracted: pending.length,
        stored,
        skipped,
        memories: pending.map((p) => ({ kind: p.kind, priority: p.priority, content: p.content })),
        tokens: usage,
      },
      "L1 提取完成（L0→L1）",
    );
    return { extracted: pending.length, stored, skipped, lastSceneName };
  }

  private async runExtraction(
    llm: LlmCallConfig,
    newOnes: { id: string; role: "user" | "assistant"; content: string; created_at: number }[],
    bgOnes: { id: string; role: "user" | "assistant"; content: string; created_at: number }[],
    previousSceneName?: string,
    usage?: TokenUsage,
  ): Promise<LlmSceneSegment[] | null> {
    const toMsg = (m: { id: string; role: "user" | "assistant"; content: string; created_at: number }): ExtractMessage => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.created_at,
    });
    try {
      const out = await this.llmCall(
        llm,
        [
          { role: "system", content: getExtractSystemPrompt(this.settings.getInt("l1_max_chars")) },
          {
            role: "user",
            content: formatExtractionPrompt({
              newMessages: newOnes.map(toMsg),
              backgroundMessages: bgOnes.map(toMsg),
              previousSceneName,
            }),
          },
        ],
        { json: true, temperature: 0.2, onUsage: usage ? usageRecorder(usage) : undefined },
      );
      const parsed = parseLlmJsonArray<LlmSceneSegment>(out);
      if (!parsed) {
        log.warn({ raw: out.slice(0, 500), len: out.length }, "L1 提取返回非法 JSON（非数组）");
        return null;
      }
      return parsed;
    } catch (err) {
      log.warn({ err: String(err) }, "L1 提取 LLM 调用失败");
      return null;
    }
  }

  private async runConflictDetection(llm: LlmCallConfig, matches: ConflictMatch[], usage?: TokenUsage): Promise<ConflictDecision[] | null> {
    try {
      const out = await this.llmCall(
        llm,
        [
          { role: "system", content: getConflictSystemPrompt() },
          { role: "user", content: formatBatchConflictPrompt(matches) },
        ],
        { json: true, temperature: 0.1, onUsage: usage ? usageRecorder(usage) : undefined },
      );
      const parsed = parseLlmJsonArray<ConflictDecision>(out);
      if (!parsed) {
        log.warn({ raw: out.slice(0, 500), len: out.length }, "冲突检测返回非法 JSON（非数组），全部按 store 落库");
        return null;
      }
      return parsed;
    } catch (err) {
      log.warn({ err: String(err) }, "冲突检测 LLM 调用失败，全部按 store 落库");
      return null;
    }
  }

  private updateSceneName(projectId: string, sceneName: string | null): void {
    if (!sceneName) return;
    this.raw
      .prepare("UPDATE pipeline_state SET last_scene_name = ? WHERE project_id = ?")
      .run(sceneName, projectId);
  }
}

function candOf(r: L1Record): ConflictMatch["candidates"][number] {
  return { id: r.id, content: r.content, kind: r.kind, priority: r.priority, sceneName: r.sceneName, createdAt: r.createdAt };
}

/** 提取侧 metadata 归一化：仅保留对象，序列化为 JSON 字符串；非法/空 → "{}"。 */
function normalizeMetadata(m: unknown): string {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "{}";
  try {
    return JSON.stringify(m);
  } catch {
    return "{}";
  }
}

/**
 * merge/update 时把 LLM 给的 merged_timestamps 并入各来源 metadata（新记忆 + 被替换旧记忆），
 * 键做浅合并（旧键优先保留），时间戳去重排序后写入 timestamps 数组。
 */
function mergeTimestamps(sources: string[], merged: string[]): string {
  const base: Record<string, unknown> = {};
  for (const src of sources) {
    try {
      const parsed = JSON.parse(src || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (k !== "timestamps" && base[k] === undefined) base[k] = v;
        }
      }
    } catch {
      /* 单条 metadata 损坏不影响其余来源 */
    }
  }
  const prev: string[] = [];
  for (const src of sources) {
    try {
      const parsed = JSON.parse(src || "{}") as { timestamps?: unknown };
      if (Array.isArray(parsed?.timestamps)) prev.push(...(parsed.timestamps as unknown[]).map(String));
    } catch {
      /* 同上 */
    }
  }
  const all = [...new Set([...prev, ...merged.filter((t) => !!t)])].sort();
  if (all.length) base.timestamps = all;
  return JSON.stringify(base);
}

const KIND_SET = new Set<string>(["persona", "episodic", "instruction", "fact", "method", "artifact"]);
function isL1Kind(s: unknown): s is L1Kind {
  return typeof s === "string" && KIND_SET.has(s);
}

function normalizeAction(a: unknown): "store" | "update" | "skip" | "merge" {
  return a === "update" || a === "skip" || a === "merge" ? a : "store";
}
