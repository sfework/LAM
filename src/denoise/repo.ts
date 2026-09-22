import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import type { DenoiseRuleData } from "./engine.js";

export interface DenoiseRuleInput {
  startText: string;
  endText: string;
  extract?: boolean;
  applyForward?: boolean;
  applyMemory?: boolean;
  enabled?: boolean;
}

function toRule(r: Record<string, unknown>): DenoiseRuleData {
  return {
    id: r.id as string,
    startText: r.start_text as string,
    endText: r.end_text as string,
    extract: Boolean(r.extract),
    applyForward: Boolean(r.apply_forward),
    applyMemory: Boolean(r.apply_memory),
    enabled: Boolean(r.enabled),
    createdAt: r.created_at as number,
  };
}

/** 除噪规则仓储（DESIGN §2.3）。物理删除，无软删。 */
export class DenoiseRepo {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  /** 全部规则（createdAt 升序，应用顺序即此序；同毫秒用 rowid 稳定兜底）。 */
  list(): DenoiseRuleData[] {
    const rows = this.raw
      .prepare("SELECT * FROM denoise_rules ORDER BY created_at ASC, rowid ASC")
      .all() as Record<string, unknown>[];
    return rows.map(toRule);
  }

  get(id: string): DenoiseRuleData | undefined {
    const r = this.raw.prepare("SELECT * FROM denoise_rules WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toRule(r) : undefined;
  }

  create(input: DenoiseRuleInput): DenoiseRuleData {
    const now = Date.now();
    const id = newId("dr");
    this.raw
      .prepare(
        "INSERT INTO denoise_rules (id, start_text, end_text, extract, apply_forward, apply_memory, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.startText,
        input.endText,
        input.extract ?? false ? 1 : 0,
        input.applyForward ?? true ? 1 : 0,
        input.applyMemory ?? true ? 1 : 0,
        input.enabled ?? false ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, input: Partial<DenoiseRuleInput>): DenoiseRuleData | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = {
      startText: input.startText ?? existing.startText,
      endText: input.endText ?? existing.endText,
      extract: input.extract ?? existing.extract,
      applyForward: input.applyForward ?? existing.applyForward,
      applyMemory: input.applyMemory ?? existing.applyMemory,
      enabled: input.enabled ?? existing.enabled,
    };
    this.raw
      .prepare(
        "UPDATE denoise_rules SET start_text=?, end_text=?, extract=?, apply_forward=?, apply_memory=?, enabled=?, updated_at=? WHERE id=?",
      )
      .run(
        merged.startText,
        merged.endText,
        merged.extract ? 1 : 0,
        merged.applyForward ? 1 : 0,
        merged.applyMemory ? 1 : 0,
        merged.enabled ? 1 : 0,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.raw.prepare("DELETE FROM denoise_rules WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }
}
