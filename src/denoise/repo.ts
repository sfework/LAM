import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colBool, colNum, colStr, getRow, getRows, type SqlRow } from "../db/rows.js";

/** 去噪规则（起止标记对），应用引擎见同目录 engine.ts。 */
export interface DenoiseRuleData {
  id: string;
  startText: string;
  endText: string;
  extract: boolean;
  applyForward: boolean;
  applyMemory: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface DenoiseRuleInput {
  startText: string;
  endText: string;
  extract?: boolean;
  applyForward?: boolean;
  applyMemory?: boolean;
  enabled?: boolean;
}

function mapRule(r: SqlRow): DenoiseRuleData {
  return {
    id: colStr(r, "id"),
    startText: colStr(r, "start_text"),
    endText: colStr(r, "end_text"),
    extract: colBool(r, "extract"),
    applyForward: colBool(r, "apply_forward"),
    applyMemory: colBool(r, "apply_memory"),
    enabled: colBool(r, "enabled"),
    createdAt: colNum(r, "created_at"),
  };
}

/** 去噪规则仓储。物理删除，无软删。 */
export class DenoiseRepo {
  private readonly db: DatabaseSync;
  /**
   * list() 缓存：网关每请求 forward/memory 两通道各调一次 list()，规则几乎不变。
   * 本类是唯一写入口（create/update/delete 即失效重载），消费方只读，返回同一引用安全。
   */
  private listCache: DenoiseRuleData[] | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 全部规则（createdAt 升序，应用顺序即此序；同毫秒用 rowid 稳定兜底）。 */
  list(): DenoiseRuleData[] {
    if (this.listCache) return this.listCache;
    this.listCache = getRows(this.db, "SELECT * FROM denoise_rules ORDER BY created_at ASC, rowid ASC").map(mapRule);
    return this.listCache;
  }

  get(id: string): DenoiseRuleData | undefined {
    const r = getRow(this.db, "SELECT * FROM denoise_rules WHERE id = ?", id);
    return r ? mapRule(r) : undefined;
  }

  create(input: DenoiseRuleInput): DenoiseRuleData {
    this.listCache = null;
    const now = Date.now();
    const id = newId("dr");
    this.db
      .prepare(
        "INSERT INTO denoise_rules (id, start_text, end_text, extract, apply_forward, apply_memory, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id, input.startText, input.endText,
        input.extract ?? false ? 1 : 0,
        input.applyForward ?? true ? 1 : 0,
        input.applyMemory ?? true ? 1 : 0,
        input.enabled ?? false ? 1 : 0,
        now, now,
      );
    return this.get(id)!;
  }

  update(id: string, input: Partial<DenoiseRuleInput>): DenoiseRuleData | undefined {
    this.listCache = null;
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
    this.db
      .prepare(
        "UPDATE denoise_rules SET start_text=?, end_text=?, extract=?, apply_forward=?, apply_memory=?, enabled=?, updated_at=? WHERE id=?",
      )
      .run(
        merged.startText, merged.endText,
        merged.extract ? 1 : 0, merged.applyForward ? 1 : 0,
        merged.applyMemory ? 1 : 0, merged.enabled ? 1 : 0,
        Date.now(), id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    this.listCache = null;
    return this.db.prepare("DELETE FROM denoise_rules WHERE id = ?").run(id).changes > 0;
  }
}
