import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colNum, colStr, getRow, getRows, type SqlRow } from "../db/rows.js";

/** 对话记录：一轮里 user / assistant 各一条原始消息切片。 */
export interface ConversationRow {
  id: string;
  projectId: string;
  sessionKey: string;
  turnSeq: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export function mapConversation(r: SqlRow): ConversationRow {
  return {
    id: colStr(r, "id"),
    projectId: colStr(r, "project_id"),
    sessionKey: colStr(r, "session_key"),
    turnSeq: colNum(r, "turn_seq"),
    role: colStr(r, "role") as ConversationRow["role"],
    content: colStr(r, "content"),
    createdAt: colNum(r, "created_at"),
  };
}

/** 对话仓储：仅写入 + 按会话/时间读取，不参与关键词召回。 */
export class ConversationRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 插入一条对话（turn_seq 由调用方按会话内 MAX+1 分配）。 */
  insert(input: {
    projectId: string;
    sessionKey: string;
    turnSeq: number;
    role: "user" | "assistant";
    content: string;
    createdAt: number;
  }): string {
    const id = newId("conv");
    this.db
      .prepare(
        "INSERT INTO conversations (id, project_id, session_key, turn_seq, role, content, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)",
      )
      .run(id, input.projectId, input.sessionKey, input.turnSeq, input.role, input.content, input.createdAt);
    return id;
  }

  /** 会话内当前最大 turn_seq（无记录返回 0）。 */
  maxTurnSeq(projectId: string, sessionKey: string): number {
    const r = getRow(
      this.db,
      "SELECT COALESCE(MAX(turn_seq), 0) AS m FROM conversations WHERE project_id = ? AND session_key = ? AND deleted_at IS NULL",
      projectId, sessionKey,
    );
    return r ? colNum(r, "m") : 0;
  }

  /** 按 id 批量取对话内容（供记忆来源溯源）。 */
  findByIds(ids: string[]): ConversationRow[] {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return getRows(this.db, `SELECT * FROM conversations WHERE id IN (${marks})`, ...ids).map(mapConversation);
  }

  /** 管理端分页列出某项目对话（时间倒序）。 */
  listByProject(projectId: string, limit: number, offset: number): ConversationRow[] {
    return getRows(
      this.db,
      "SELECT * FROM conversations WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?",
      projectId, limit, offset,
    ).map(mapConversation);
  }
}
