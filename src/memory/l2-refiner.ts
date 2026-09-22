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

/** refine 模式：incremental = 只喂水位后新增的 L1；full = 全量重凝练。 */
export type RefineMode = "incremental" | "full";

/**
 * refine 结果状态：
 *  - stored    写入新画像（version 自增）；
 *  - unchanged LLM 返回与现有画像一致，未写库（调度器应推进水位防重触发）；
 *  - skipped   无活跃 L1 / 无新增 L1，未调 LLM（同上，推进水位）；
 *  - failed    LLM 调用失败或返回空（不推进水位，下轮重试）。
 */
export interface RefineResult {
  status: "stored" | "unchanged" | "skipped" | "failed";
  /** 当前画像 version（从未写过为 0）。 */
  version: number;
}

/**
 * L2 项目画像凝练（DESIGN §2.7，参考 persona-generation）。
 * 首次全量 / 增量更新（增量只喂上次凝练后新增的活跃 L1，无新增直接跳过）；
 * 长度上限；替换式更新 version 自增；结果与现有画像一致时不写库、不涨版本。
 */
export class L2Refiner {
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

  private get(projectId: string): { id: string; content: string; version: number; updated_at: number } | undefined {
    const r = this.raw
      .prepare("SELECT id, content, version, updated_at FROM mem_l2 WHERE project_id = ? AND deleted_at IS NULL")
      .get(projectId) as { id: string; content: string; version: number; updated_at: number } | undefined;
    return r;
  }

  /**
   * 用活跃 L1 凝练/更新画像。
   * 增量模式只喂水位（watermarkMs，默认取画像 updated_at）之后新增的 L1，无新增则零 LLM 成本跳过；
   * 结果与现有画像逐字一致时不写库、不涨版本（防无变化空转导致 version 膨胀）。
   */
  async refine(
    projectId: string,
    llm: LlmCallConfig,
    mode: RefineMode = "incremental",
    watermarkMs?: number,
  ): Promise<RefineResult> {
    const all = this.store.listActive(projectId);
    if (!all.length) {
      log.debug({ projectId }, "无活跃 L1，跳过画像凝练");
      return { status: "skipped", version: this.get(projectId)?.version ?? 0 };
    }
    const existing = this.get(projectId);
    let active = all;
    if (!existing) {
      mode = "full"; // 无画像时全量首凝
    } else if (mode === "incremental") {
      // 真增量：只喂水位后新增的活跃 L1；无新增则零 LLM 成本直接跳过。
      // 水位由调用方控制：调度器传 last_l2_at（上次凝练时刻），避免管理端手动保存画像污染水位。
      const watermark = watermarkMs ?? existing.updated_at;
      const changed = all.filter((m) => m.createdAt > watermark);
      if (!changed.length) {
        log.debug({ projectId, version: existing.version }, "L2 无新增 L1，跳过凝练");
        return { status: "skipped", version: existing.version };
      }
      active = changed;
    }
    const maxChars = this.settings.getInt("l2_max_chars");
    // token 累加（凝练可能多轮/重试，目前单次；统一收集）
    const tokens = { prompt: 0, completion: 0, total: 0 };

    let out: string;
    try {
      out = await this.llmCall(
        llm,
        [
          { role: "system", content: getPersonaSystemPrompt(maxChars) },
          {
            role: "user",
            content: formatPersonaPrompt({
              mode: existing ? "incremental" : "first",
              existingProfile: existing?.content,
              changedMemories: active.map((m) => ({ kind: m.kind, content: m.content, createdAt: m.createdAt })),
            }),
          },
        ],
        {
          temperature: 0.3,
          onUsage: (u) => {
            tokens.prompt += u.promptTokens;
            tokens.completion += u.completionTokens;
            tokens.total += u.totalTokens;
          },
        },
      );
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "L2 凝练 LLM 调用失败");
      return { status: "failed", version: existing?.version ?? 0 };
    }

    let profile = (out || "").trim();
    // 去掉可能的 ``` 包裹
    profile = profile.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```$/i, "").trim();
    if (!profile) {
      log.warn({ projectId }, "L2 凝练返回空，跳过");
      return { status: "failed", version: existing?.version ?? 0 };
    }
    if (profile.length > maxChars) profile = profile.slice(0, maxChars);

    const now = Date.now();
    // 结果比对：规范化后与现有画像一致 → 不写库、不涨版本。
    // 逐字比对对 LLM 输出的空白/换行/标点抖动过于敏感，会凭空涨 version（决策 71）。
    if (existing && normalizeProfile(existing.content) === normalizeProfile(profile)) {
      log.debug({ projectId, version: existing.version, l1Count: active.length, tokens }, "L2 画像凝练无变化，跳过写入");
      return { status: "unchanged", version: existing.version };
    }
    const base = {
      projectId,
      path: this.pathOf?.(projectId) ?? "",
      l1Count: active.length,
      tokens,
    };
    if (existing) {
      const version = existing.version + 1;
      this.raw
        .prepare("UPDATE mem_l2 SET content = ?, version = ?, updated_at = ? WHERE id = ?")
        .run(profile, version, now, existing.id);
      log.info({ ...base, version }, "L2 画像已增量更新（L1→L2）");
      return { status: "stored", version };
    }
    const id = newId("l2");
    this.raw
      .prepare("INSERT INTO mem_l2 (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)")
      .run(id, projectId, profile, now);
    log.info({ ...base, version: 1 }, "L2 画像首次生成（L1→L2）");
    return { status: "stored", version: 1 };
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
      log.debug({ projectId, version }, "L2 画像已由管理端保存");
      return { changed: true, version };
    }
    this.raw
      .prepare("INSERT INTO mem_l2 (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)")
      .run(newId("l2"), projectId, content, now);
    log.debug({ projectId }, "L2 画像首次保存（管理端）");
    return { changed: true, version: 1 };
  }
}

/**
 * 画像内容规范化：用于凝练结果与现有画像的"实质一致"比对（决策 71）。
 * 去除首尾空白、统一换行、压缩行内连续空白、剥离行尾多余空格、去掉整体空行差异，
 * 吸收 LLM 输出的排版抖动（空格/换行/尾随空白），避免无实质变化却涨 version。
 * 不做语义归一（标点/措辞仍由 LLM 决定）——仅消除纯格式噪音。
 */
function normalizeProfile(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}
