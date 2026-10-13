import { createLogger } from "../infra/logger.js";
import type { SettingsService } from "../settings/service.js";
import type { LlmCallConfig } from "../llm/client.js";
import type { L1Store, L1Record } from "./l1-store.js";
import type { LlmCall } from "./l1-extractor.js";
import { getMemoryExpirySystemPrompt, formatExpiryPrompt, parseExpiryDecisions } from "./prompts.js";
import { chatComplete } from "../llm/client.js";

const log = createLogger("memory:expiry");

/**
 * 过期记忆维护（DESIGN 决策 76）：调度器常驻维护循环的清扫阶段。
 *
 * - 按 kind 的 TTL 找出超龄活跃 L1（episodic/artifact 默认 30/90 天，其余默认 0=永不过期）；
 * - 候选不直接删：一批交 LLM 评审，逐条判 delete（完全过时）/ rewrite（部分过时，
 *   输出修剪后内容）/ keep（仍有效，续期）；
 * - delete → L1Store.remove（物理删 + 同步移出 FTS/vec，溯源 L0 保留）；
 *   rewrite → L1Store.updateContent（FTS 重建 + 向量失效，由补嵌入下轮重建）；
 *   keep → 刷新 created_at 之外的"续期锚点"：写 metadata.expiry_kept_at，下轮以该时间为龄起点；
 * - 全规则驱动、单批限量，失败不影响记忆主管线。
 */

export interface ExpiryResult {
  scanned: number;
  deleted: number;
  rewritten: number;
  kept: number;
}

export class MemoryExpirer {
  private readonly store: L1Store;
  private readonly settings: SettingsService;
  private readonly llmCall: LlmCall;

  constructor(store: L1Store, settings: SettingsService, llmCall: LlmCall = chatComplete) {
    this.store = store;
    this.settings = settings;
    this.llmCall = llmCall;
  }

  get enabled(): boolean {
    return this.settings.getBool("memory_expiry_enabled");
  }

  /** 某 kind 的 TTL 天数（0=永不过期）。 */
  ttlDaysOf(kind: string): number {
    switch (kind) {
      case "episodic":
        return this.settings.getInt("memory_expiry_days_episodic");
      case "artifact":
        return this.settings.getInt("memory_expiry_days_artifact");
      default:
        return this.settings.getInt("memory_expiry_days_other");
    }
  }

  /**
   * 执行一轮清扫（节流与 LLM 配置由调度器负责）。
   * 评审失败/坏输出整轮跳过（不删）——存疑保守，宁漏删不误删。
   */
  async sweepOneProject(projectId: string, llm: LlmCallConfig): Promise<ExpiryResult> {
    const res: ExpiryResult = { scanned: 0, deleted: 0, rewritten: 0, kept: 0 };
    const now = Date.now();
    const maxItems = this.settings.getInt("memory_expiry_max_items");
    const candidates = this.listCandidates(projectId, now).slice(0, maxItems);
    res.scanned = candidates.length;
    if (!candidates.length) return res;

    const decisions = await this.review(llm, candidates, now);
    if (!decisions) {
      log.warn({ projectId, candidates: candidates.length }, "过期评审失败/无输出，本轮跳过（不删）");
      return res;
    }
    const byId = new Map(candidates.map((c) => [c.record.id, c]));
    for (const d of decisions) {
      const cand = byId.get(d.id);
      if (!cand) continue;
      if (d.action === "delete") {
        if (this.store.remove(d.id)) res.deleted++;
      } else if (d.action === "rewrite" && d.new_content && d.new_content.trim()) {
        const r = this.store.updateContent(d.id, d.new_content.trim());
        if (r.changed) res.rewritten++;
      } else {
        // keep：写续期锚点（metadata.expiry_kept_at），本轮不再评审；超过再多个 TTL 周期仍会回到候选
        this.markKept(cand.record, now);
        res.kept++;
      }
    }
    if (res.deleted || res.rewritten || res.kept) {
      log.info({ projectId, ...res }, "过期记忆清扫完成");
    }
    return res;
  }

  /** 超龄候选：按 kind TTL 过滤；keep 续期锚点参与龄计算。 */
  private listCandidates(projectId: string, now: number): { record: L1Record; ageDays: number }[] {
    const out: { record: L1Record; ageDays: number }[] = [];
    for (const rec of this.store.listActive(projectId)) {
      const ttl = this.ttlDaysOf(rec.kind);
      if (ttl <= 0) continue;
      const anchor = keptAtOf(rec) ?? rec.createdAt;
      const ageDays = (now - anchor) / 86_400_000;
      if (ageDays >= ttl) out.push({ record: rec, ageDays: Math.round(ageDays) });
    }
    // 最老的先评审
    out.sort((a, b) => a.record.createdAt - b.record.createdAt);
    return out;
  }

  private async review(llm: LlmCallConfig, candidates: { record: L1Record; ageDays: number }[], now: number) {
    const today = new Date(now);
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    try {
      const items = candidates.map((c) => ({ id: c.record.id, kind: c.record.kind, content: c.record.content, ageDays: c.ageDays }));
      const out = await this.llmCall(llm, [
        { role: "system", content: getMemoryExpirySystemPrompt() },
        { role: "user", content: formatExpiryPrompt(items, dateStr) },
      ], { json: true });
      return parseExpiryDecisions(out);
    } catch (err) {
      log.warn({ err: String(err) }, "过期评审 LLM 调用失败");
      return null;
    }
  }

  /** keep 续期：把锚点时间写入 metadata（保留原键，追加 expiry_kept_at）。 */
  private markKept(rec: L1Record, now: number): void {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(rec.metadata || "{}") as Record<string, unknown>;
    } catch {
      meta = {};
    }
    meta.expiry_kept_at = now;
    this.store.patchMetadata(rec.id, JSON.stringify(meta));
  }
}

/** 读 metadata 中的 keep 续期锚点（无则 null）。 */
function keptAtOf(rec: L1Record): number | null {
  try {
    const m = JSON.parse(rec.metadata || "{}") as Record<string, unknown>;
    const v = m.expiry_kept_at;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
