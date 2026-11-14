import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colNum, colStr, colStrOrNull, getRow, type SqlRow } from "../db/rows.js";

export interface SessionRow {
  id: string;
  sessionKey: string;
  projectId: string;
  source: "derived" | "header";
  injectSnapshot: string;
  createdAt: number;
  lastSeenAt: number;
  handledCount: number;
}

function mapSession(r: SqlRow): SessionRow {
  return {
    id: colStr(r, "id"),
    sessionKey: colStr(r, "session_key"),
    projectId: colStr(r, "project_id"),
    source: colStr(r, "source") as "derived" | "header",
    injectSnapshot: colStrOrNull(r, "inject_snapshot") ?? "",
    createdAt: colNum(r, "created_at"),
    lastSeenAt: colNum(r, "last_seen_at"),
    handledCount: colNum(r, "handled_count"),
  };
}

/**
 * 推导 session_key：sha256(projectId + 首条 user 消息文本 trim)。
 * OpenAI 协议每轮全量上传历史，同一会话内首条 user 消息稳定不变。
 */
export function deriveSessionKey(projectId: string, firstUserText: string): string {
  return createHash("sha256").update(`${projectId}\u0000${firstUserText.trim()}`).digest("hex");
}

/**
 * 会话仓储。
 * 会话状态存服务端：注入内容不会留在客户端，不能依赖回传标记。
 */
export class SessionRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(sessionKey: string): SessionRow | undefined {
    const r = getRow(this.db, "SELECT * FROM sessions WHERE session_key = ?", sessionKey);
    return r ? mapSession(r) : undefined;
  }

  /** 创建会话（快照先置空，注入后 setSnapshot 回填）。 */
  create(sessionKey: string, projectId: string, source: "derived" | "header", now: number): SessionRow {
    const id = newId("ses");
    this.db
      .prepare(
        "INSERT INTO sessions (id, session_key, project_id, source, inject_snapshot, created_at, last_seen_at, handled_count) VALUES (?,?,?,?,?,?,?,0)",
      )
      .run(id, sessionKey, projectId, source, "", now, now);
    return this.get(sessionKey)!;
  }

  touch(sessionKey: string, now: number): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_key = ?").run(now, sessionKey);
  }

  /** 首轮生成快照后回填（此后每轮复用，字节级不变）。 */
  setSnapshot(sessionKey: string, snapshot: string): void {
    this.db.prepare("UPDATE sessions SET inject_snapshot = ? WHERE session_key = ?").run(snapshot, sessionKey);
  }

  /** 推进已处理消息游标（对话回流用）。 */
  setHandledCount(sessionKey: string, count: number): void {
    this.db.prepare("UPDATE sessions SET handled_count = ? WHERE session_key = ?").run(count, sessionKey);
  }

  /** TTL 过期判定：last_seen_at 距今超过 ttlMinutes。 */
  static isExpired(row: SessionRow, ttlMinutes: number, now: number): boolean {
    return now - row.lastSeenAt > ttlMinutes * 60_000;
  }
}
