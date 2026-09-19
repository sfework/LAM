import type { DatabaseSync } from "node:sqlite";
import { chatComplete, type LlmCallConfig, type LlmMessage, type LlmCallOptions } from "../llm/client.js";
import { parseLlmJson } from "../utils/json.js";
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
}

interface ConflictDecision {
  record_id?: unknown;
  action?: unknown;
  target_ids?: unknown;
  merged_content?: unknown;
  merged_type?: unknown;
  merged_priority?: unknown;
}

export type LlmCall = (
  cfg: LlmCallConfig,
  messages: LlmMessage[],
  opts?: LlmCallOptions,
) => Promise<string>;

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

  constructor(raw: DatabaseSync, store: L1Store, settings: SettingsService, llmCall: LlmCall = chatComplete) {
    this.raw = raw;
    this.store = store;
    this.settings = settings;
    this.llmCall = llmCall;
  }

  /**
   * 对一批 L0 消息执行提取。
   * @param l0Ids pipeline_state 缓冲的 L0 记录 id
   */
  async extract(projectId: string, l0Ids: string[], llm: LlmCallConfig): Promise<ExtractResult> {
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
    const segments = await this.runExtraction(llm, newOnes, bgOnes, prev?.last_scene_name ?? undefined);
    if (!segments) return { extracted: 0, stored: 0, skipped: 0, lastSceneName: prev?.last_scene_name ?? null };

    const minPriority = this.settings.getInt("extract_min_priority");
    const maxItems = this.settings.getInt("memory_extract_max_items");
    const l1MaxChars = this.settings.getInt("l1_max_chars");
    const batchId = newId("bat");

    const pending: { recordId: string; kind: L1Kind; content: string; priority: number; sceneName: string; sourceL0Ids: string[]; createdAt: number }[] = [];
    let lastSceneName: string | null = prev?.last_scene_name ?? null;

    for (const seg of segments) {
      const sceneName = typeof seg.scene_name === "string" ? seg.scene_name.trim() : "";
      if (sceneName) lastSceneName = sceneName;
      const mems = Array.isArray(seg.memories) ? (seg.memories as LlmMemory[]) : [];
      for (const m of mems) {
        if (pending.length >= maxItems) break;
        const content = typeof m.content === "string" ? m.content.trim() : "";
        if (!content) continue;
        if (content.length > l1MaxChars) {
          log.debug({ len: content.length, limit: l1MaxChars }, "L1 超颗粒度上限（保留入库，提取侧已提示拆分）");
        }
        const kind = (m.type as string) ?? "";
        if (!isL1Kind(kind)) continue;
        const priority = typeof m.priority === "number" ? m.priority : 70;
        if (priority < minPriority) continue;
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
      decisions = (await this.runConflictDetection(llm, matches)) ?? [];
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

      const id = this.store.applyDecision(
        projectId,
        { action, targetIds },
        { kind, content, priority: prRaw, sceneName: p.sceneName || null, sourceL0Ids: p.sourceL0Ids, batchId, createdAt: p.createdAt },
      );
      if (id) stored++;
      else skipped++;
    }

    this.updateSceneName(projectId, lastSceneName);
    log.info({ projectId, extracted: pending.length, stored, skipped }, "L1 提取完成");
    return { extracted: pending.length, stored, skipped, lastSceneName };
  }

  private async runExtraction(
    llm: LlmCallConfig,
    newOnes: { id: string; role: "user" | "assistant"; content: string; created_at: number }[],
    bgOnes: { id: string; role: "user" | "assistant"; content: string; created_at: number }[],
    previousSceneName?: string,
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
        { json: true, temperature: 0.2 },
      );
      const parsed = parseLlmJson<LlmSceneSegment[]>(out);
      return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      log.warn({ err: String(err) }, "L1 提取 LLM 调用失败");
      return null;
    }
  }

  private async runConflictDetection(llm: LlmCallConfig, matches: ConflictMatch[]): Promise<ConflictDecision[] | null> {
    try {
      const out = await this.llmCall(
        llm,
        [
          { role: "system", content: getConflictSystemPrompt() },
          { role: "user", content: formatBatchConflictPrompt(matches) },
        ],
        { json: true, temperature: 0.1 },
      );
      const parsed = parseLlmJson<ConflictDecision[]>(out);
      return Array.isArray(parsed) ? parsed : null;
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

const KIND_SET = new Set<string>(["persona", "episodic", "instruction", "fact", "method", "artifact"]);
function isL1Kind(s: unknown): s is L1Kind {
  return typeof s === "string" && KIND_SET.has(s);
}

function normalizeAction(a: unknown): "store" | "update" | "skip" | "merge" {
  return a === "update" || a === "skip" || a === "merge" ? a : "store";
}
