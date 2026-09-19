import type { DatabaseSync } from "node:sqlite";
import { chatComplete, type LlmCallConfig, type LlmMessage, type LlmCallOptions } from "../llm/client.js";
import { newId } from "../infra/id.js";
import { createLogger } from "../infra/logger.js";
import { getPersonaSystemPrompt, formatPersonaPrompt } from "./prompts.js";
import { L1Store } from "./l1-store.js";
import type { SettingsService } from "../settings/service.js";

const log = createLogger("memory:l2");

export type LlmCall = (
  cfg: LlmCallConfig,
  messages: LlmMessage[],
  opts?: LlmCallOptions,
) => Promise<string>;

/**
 * L2 项目画像凝练（DESIGN §2.7，参考 persona-generation）。
 * 首次全量 / 增量更新；长度上限；替换式更新 version 自增。
 */
export class L2Refiner {
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

  private get(projectId: string): { id: string; content: string; version: number; updated_at: number } | undefined {
    const r = this.raw
      .prepare("SELECT id, content, version, updated_at FROM mem_l2 WHERE project_id = ? AND deleted_at IS NULL")
      .get(projectId) as { id: string; content: string; version: number; updated_at: number } | undefined;
    return r;
  }

  /** 用当前活跃 L1 凝练/更新画像。返回 version（无变化返回 0）。 */
  async refine(projectId: string, llm: LlmCallConfig): Promise<number> {
    const active = this.store.listActive(projectId);
    if (!active.length) {
      log.debug({ projectId }, "无活跃 L1，跳过画像凝练");
      return 0;
    }
    const existing = this.get(projectId);
    const mode = existing ? "incremental" : "first";
    const maxChars = this.settings.getInt("l2_max_chars");

    let out: string;
    try {
      out = await this.llmCall(
        llm,
        [
          { role: "system", content: getPersonaSystemPrompt(maxChars) },
          {
            role: "user",
            content: formatPersonaPrompt({
              mode,
              existingProfile: existing?.content,
              changedMemories: active.map((m) => ({ kind: m.kind, content: m.content, createdAt: m.createdAt })),
            }),
          },
        ],
        { temperature: 0.3 },
      );
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "L2 凝练 LLM 调用失败");
      return 0;
    }

    let profile = (out || "").trim();
    // 去掉可能的 ``` 包裹
    profile = profile.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```$/i, "").trim();
    if (!profile) {
      log.warn({ projectId }, "L2 凝练返回空，跳过");
      return 0;
    }
    if (profile.length > maxChars) profile = profile.slice(0, maxChars);

    const now = Date.now();
    if (existing) {
      const version = existing.version + 1;
      this.raw
        .prepare("UPDATE mem_l2 SET content = ?, version = ?, updated_at = ? WHERE id = ?")
        .run(profile, version, now, existing.id);
      log.info({ projectId, version }, "L2 画像已增量更新");
      return version;
    }
    const id = newId("l2");
    this.raw
      .prepare("INSERT INTO mem_l2 (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)")
      .run(id, projectId, profile, now);
    log.info({ projectId, version: 1 }, "L2 画像首次生成");
    return 1;
  }

  /** 读取画像全文（快照注入用）。 */
  read(projectId: string): string {
    return this.get(projectId)?.content ?? "";
  }

  /** 读取画像全文 + 版本（管理端展示/编辑用）。 */
  readMeta(projectId: string): { content: string; version: number; updatedAt: number | null } {
    const r = this.get(projectId);
    return { content: r?.content ?? "", version: r?.version ?? 0, updatedAt: r?.updated_at ?? null };
  }

  /**
   * 管理端保存画像：内容变化才写库（version 自增）；未变返回 changed=false 直接跳过。
   * L2 不参与检索召回（全文注入），故无需向量化——sha 比对只用于避免无意义的写与版本膨胀。
   */
  save(projectId: string, content: string): { changed: boolean; version: number } {
    const existing = this.get(projectId);
    if (existing && existing.content === content) return { changed: false, version: existing.version };
    const now = Date.now();
    if (existing) {
      const version = existing.version + 1;
      this.raw.prepare("UPDATE mem_l2 SET content = ?, version = ?, updated_at = ? WHERE id = ?").run(content, version, now, existing.id);
      log.info({ projectId, version }, "L2 画像已由管理端保存");
      return { changed: true, version };
    }
    this.raw
      .prepare("INSERT INTO mem_l2 (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)")
      .run(newId("l2"), projectId, content, now);
    log.info({ projectId }, "L2 画像首次保存（管理端）");
    return { changed: true, version: 1 };
  }
}
