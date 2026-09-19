import type { DatabaseSync } from "node:sqlite";

/**
 * cg_status 状态仓储（DESIGN 决策 67：图数据外置后，gateway.db 只保留每项目索引状态）。
 * 纯 node:sqlite 手写 DAO（与全库一致，运行时不加载 drizzle）。
 */

export type CgStatusValue = "pending" | "indexing" | "ready" | "failed";

export interface CgStatusRow {
  projectId: string;
  status: CgStatusValue;
  totalFiles: number;
  indexedFiles: number;
  /** 距上次索引累积的对话轮数（final answer 计 1）。 */
  turnsSinceIndex: number;
  lastError: string;
  lastIndexedAt: number | null;
  updatedAt: number;
}

function toRow(r: Record<string, unknown>): CgStatusRow {
  return {
    projectId: r.project_id as string,
    status: r.status as CgStatusValue,
    totalFiles: r.total_files as number,
    indexedFiles: r.indexed_files as number,
    turnsSinceIndex: r.turns_since_index as number,
    lastError: r.last_error as string,
    lastIndexedAt: (r.last_indexed_at as number | null) ?? null,
    updatedAt: r.updated_at as number,
  };
}

export class CgStatusRepo {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  get(projectId: string): CgStatusRow | undefined {
    const r = this.raw.prepare("SELECT * FROM cg_status WHERE project_id = ?").get(projectId) as
      | Record<string, unknown>
      | undefined;
    return r ? toRow(r) : undefined;
  }

  /** upsert 骨架行（幂等，已存在则不动）。 */
  ensure(projectId: string): void {
    this.raw
      .prepare(
        `INSERT INTO cg_status (project_id, status, total_files, indexed_files, turns_since_index, last_error, last_indexed_at, updated_at)
         VALUES (?, 'pending', 0, 0, 0, '', NULL, ?) ON CONFLICT(project_id) DO NOTHING`,
      )
      .run(projectId, Date.now());
  }

  setStatus(projectId: string, patch: Partial<Pick<CgStatusRow, "status" | "totalFiles" | "indexedFiles" | "lastError" | "lastIndexedAt">>): void {
    this.ensure(projectId);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
    if (patch.totalFiles !== undefined) { sets.push("total_files = ?"); args.push(patch.totalFiles); }
    if (patch.indexedFiles !== undefined) { sets.push("indexed_files = ?"); args.push(patch.indexedFiles); }
    if (patch.lastError !== undefined) { sets.push("last_error = ?"); args.push(patch.lastError); }
    if (patch.lastIndexedAt !== undefined) { sets.push("last_indexed_at = ?"); args.push(patch.lastIndexedAt); }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    args.push(Date.now(), projectId);
    this.raw.prepare(`UPDATE cg_status SET ${sets.join(", ")} WHERE project_id = ?`).run(...args);
  }

  /**
   * 记一轮对话并判断是否到达重建阈值：阈值 <=0 关闭；到达则清零并返回 true。
   */
  bumpTurn(projectId: string, every: number): boolean {
    this.ensure(projectId);
    if (every <= 0) return false;
    const r = this.raw.prepare("SELECT turns_since_index AS n FROM cg_status WHERE project_id = ?").get(projectId) as { n: number };
    const next = r.n + 1;
    if (next >= every) {
      this.raw.prepare("UPDATE cg_status SET turns_since_index = 0, updated_at = ? WHERE project_id = ?").run(Date.now(), projectId);
      return true;
    }
    this.raw.prepare("UPDATE cg_status SET turns_since_index = ?, updated_at = ? WHERE project_id = ?").run(next, Date.now(), projectId);
    return false;
  }

  /** 项目删除：清状态行。 */
  remove(projectId: string): void {
    this.raw.prepare("DELETE FROM cg_status WHERE project_id = ?").run(projectId);
  }
}
