import type { DatabaseSync } from "node:sqlite";
import { chatComplete, type LlmCallConfig, type LlmMessage, type LlmCallOptions } from "../llm/client.js";
import { parseLlmJsonArray } from "../utils/json.js";
import { createLogger } from "../infra/logger.js";
import {
  getSkillExtractSystemPrompt,
  formatSkillExtractPrompt,
  type SkillCandidate,
  type ExtractMessage,
} from "./prompts.js";
import type { AssetsRepo } from "../assets/repo.js";

const log = createLogger("memory:skill");

export type LlmCall = (
  cfg: LlmCallConfig,
  messages: LlmMessage[],
  opts?: LlmCallOptions,
) => Promise<string>;

export interface SkillExtractResult {
  extracted: number;
  stored: number;
  updated: number;
  skipped: number;
}

/**
 * 技能自动抽取（DESIGN 决策 68）：从 L0 对话萃取可复用 SOP，落成待审技能（enabled=false）。
 *
 * 复用 L1 提取的触发机制（调度器在 L1 批次成功后按需调用），一次 LLM pass 同时完成
 * "识别可复用流程 + 与已有 active 技能去重"。update 走 AssetsRepo 的版本化（生成新版本）。
 * 抽取受 skill_extract_enabled 总闸控制（默认关，成本可控）；confidence 低于阈值丢弃。
 */
export class SkillExtractor {
  private readonly raw: DatabaseSync;
  private readonly assets: AssetsRepo;
  private readonly settings: SettingsServiceLike;
  private readonly llmCall: LlmCall;

  constructor(raw: DatabaseSync, assets: AssetsRepo, settings: SettingsServiceLike, llmCall: LlmCall = chatComplete) {
    this.raw = raw;
    this.assets = assets;
    this.settings = settings;
    this.llmCall = llmCall;
  }

  /** 总闸：关闭时调度器不会调用，这里再兜一层。 */
  get enabled(): boolean {
    return this.settings.getBool("skill_extract_enabled");
  }

  /** 对一批 L0 消息执行技能抽取。 */
  async extract(projectId: string, l0Ids: string[], llm: LlmCallConfig): Promise<SkillExtractResult> {
    const empty: SkillExtractResult = { extracted: 0, stored: 0, updated: 0, skipped: 0 };
    if (!this.enabled || !l0Ids.length) return empty;

    const rows = this.raw
      .prepare(
        `SELECT id, role, content, created_at FROM mem_l0
         WHERE project_id = ? AND id IN (${l0Ids.map(() => "?").join(",")}) AND deleted_at IS NULL
         ORDER BY turn_seq`,
      )
      .all(projectId, ...l0Ids) as { id: string; role: "user" | "assistant"; content: string; created_at: number }[];
    if (!rows.length) return empty;

    const maxNew = this.settings.getInt("skill_extract_max_messages");
    const newOnes = rows.slice(-maxNew);
    const msgs: ExtractMessage[] = newOnes.map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.created_at }));

    // 已有 active 技能作为去重候选（全局 + 本项目）
    const existing = this.assets
      .listSkills()
      .filter((s) => s.projectId === null || s.projectId === projectId)
      .map((s) => ({ id: s.id, name: s.name, description: s.description }));

    let candidates: SkillCandidate[];
    try {
      const out = await this.llmCall(
        llm,
        [
          { role: "system", content: getSkillExtractSystemPrompt() },
          { role: "user", content: formatSkillExtractPrompt({ newMessages: msgs, existingSkills: existing }) },
        ],
        { json: true, temperature: 0.2 },
      );
      candidates = parseLlmJsonArray<SkillCandidate>(out) ?? [];
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "技能抽取 LLM 调用失败");
      return empty;
    }

    const minConf = this.settings.getInt("skill_extract_min_confidence");
    const maxItems = this.settings.getInt("skill_extract_max_items");
    const res: SkillExtractResult = { extracted: 0, stored: 0, updated: 0, skipped: 0 };

    for (const c of candidates) {
      if (res.extracted >= maxItems) break;
      const name = typeof c.name === "string" ? c.name.trim() : "";
      const body = typeof c.body === "string" ? c.body.trim() : "";
      if (!name || !body) continue;
      const confidence = typeof c.confidence === "number" ? c.confidence : 0;
      if (confidence < minConf) {
        res.skipped++;
        continue;
      }
      res.extracted++;
      const action = c.action === "update" || c.action === "skip" ? c.action : "store";

      if (action === "skip") {
        res.skipped++;
        continue;
      }
      if (action === "update" && c.target_id) {
        const upd = this.assets.updateSkill(c.target_id, { name, description: c.description ?? "", body });
        if (upd) {
          res.updated++;
          continue;
        }
        // target 不存在 → 退化为 store
      }
      // store / update 退化：新增待审技能（enabled=false，source=auto，绑定来源项目）
      this.assets.createSkill({
        name,
        description: c.description ?? "",
        body,
        enabled: false,
        source: "auto",
        projectId,
      });
      res.stored++;
    }

    if (res.extracted) log.debug({ projectId, ...res }, "技能抽取完成（待人工审核启用）");
    return res;
  }
}

/** 只依赖取值的窄接口，便于测试注入。 */
interface SettingsServiceLike {
  getBool(key: string): boolean;
  getInt(key: string): number;
}
