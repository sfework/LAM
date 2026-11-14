import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colNum, colStr, getRow, type SqlRow } from "../db/rows.js";

/** 项目画像：每项目一条，Markdown 全文，version 递增。 */
export interface ProfileRow {
  id: string;
  projectId: string;
  content: string;
  version: number;
  updatedAt: number;
}

function mapProfile(r: SqlRow): ProfileRow {
  return {
    id: colStr(r, "id"),
    projectId: colStr(r, "project_id"),
    content: colStr(r, "content"),
    version: colNum(r, "version"),
    updatedAt: colNum(r, "updated_at"),
  };
}

export class ProfileRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  findByProject(projectId: string): ProfileRow | undefined {
    const r = getRow(this.db, "SELECT * FROM profiles WHERE project_id = ? AND deleted_at IS NULL", projectId);
    return r ? mapProfile(r) : undefined;
  }

  /** 读取画像全文（快照注入用；无画像返回空串）。 */
  read(projectId: string): string {
    return this.findByProject(projectId)?.content ?? "";
  }

  /** 写入画像：不存在则创建（version=1），存在则覆盖并 version+1。 */
  upsert(projectId: string, content: string): ProfileRow {
    const now = Date.now();
    const existing = this.findByProject(projectId);
    if (existing) {
      this.db
        .prepare("UPDATE profiles SET content = ?, version = ?, updated_at = ? WHERE id = ?")
        .run(content, existing.version + 1, now, existing.id);
    } else {
      this.db
        .prepare("INSERT INTO profiles (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)")
        .run(newId("prf"), projectId, content, now);
    }
    return this.findByProject(projectId)!;
  }
}
