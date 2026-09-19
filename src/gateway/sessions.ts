import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";

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

function toRow(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    sessionKey: r.session_key as string,
    projectId: r.project_id as string,
    source: r.source as "derived" | "header",
    injectSnapshot: r.inject_snapshot as string,
    createdAt: r.created_at as number,
    lastSeenAt: r.last_seen_at as number,
    handledCount: r.handled_count as number,
  };
}

/**
 * 推导 session_key（DESIGN §2.6）：
 * sha256(projectId + 首条 user 消息文本 trim)。
 * OpenAI 协议每轮全量上传历史，同一会话内首条 user 消息稳定不变。
 */
export function deriveSessionKey(projectId: string, firstUserText: string): string {
  return createHash("sha256").update(`${projectId}\u0000${firstUserText.trim()}`).digest("hex");
}

/**
 * 会话仓储（DESIGN §2.6）。
 * 会话状态存服务端：注入内容不会留在客户端，不能依赖回传标记。
 */
export class SessionRepo {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  get(sessionKey: string): SessionRow | undefined {
    const r = this.raw.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as
      | Record<string, unknown>
      | undefined;
    return r ? toRow(r) : undefined;
  }

  /** 创建会话（快照先置空，注入后 setSnapshot 回填）。 */
  create(sessionKey: string, projectId: string, source: "derived" | "header", now: number): SessionRow {
    const id = newId("ses");
    this.raw
      .prepare(
        "INSERT INTO sessions (id, session_key, project_id, source, inject_snapshot, created_at, last_seen_at, handled_count) VALUES (?,?,?,?,?,?,?,0)",
      )
      .run(id, sessionKey, projectId, source, "", now, now);
    return this.get(sessionKey)!;
  }

  touch(sessionKey: string, now: number): void {
    this.raw.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_key = ?").run(now, sessionKey);
  }

  /** 首轮生成快照后回填（此后每轮复用，字节级不变）。 */
  setSnapshot(sessionKey: string, snapshot: string): void {
    this.raw
      .prepare("UPDATE sessions SET inject_snapshot = ? WHERE session_key = ?")
      .run(snapshot, sessionKey);
  }

  /** 回流后更新已处理消息数（阶段 5 消费）。 */
  setHandledCount(sessionKey: string, count: number): void {
    this.raw.prepare("UPDATE sessions SET handled_count = ? WHERE session_key = ?").run(count, sessionKey);
  }

  /** TTL 过期判定：last_seen_at 距今超过 ttlMinutes。 */
  static isExpired(row: SessionRow, ttlMinutes: number, now: number): boolean {
    return now - row.lastSeenAt > ttlMinutes * 60_000;
  }
}
