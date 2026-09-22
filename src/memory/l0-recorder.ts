import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "../gateway/protocol.js";
import { denoiseMessages, type DenoiseRuleData } from "../denoise/engine.js";
import { shouldCaptureL0 } from "./sanitize.js";
import { tokenizeForFts, buildFtsQuery } from "./tokenize.js";
import { newId } from "../infra/id.js";
import { createLogger } from "../infra/logger.js";
import type { AssistantAggregate } from "../gateway/forwarder.js";

const log = createLogger("memory:l0");

export interface L0Row {
  id: string;
  projectId: string;
  sessionKey: string;
  turnSeq: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

/**
 * L0 回流记录器（DESIGN §2.7，参考 l0-recorder）。
 *
 * 时机：本轮为 final answer（响应无 tool_calls）才调用；残缺轮次不落库。
 * 增量：按 sessions.handled_count 取请求消息新增尾部（OpenAI 协议每轮全量上传）。
 * 双通道：memory 副本按 applyMemory 规则除噪后入库（≠ 转发副本）。
 * 原子：读游标 → 写 L0 → 推进游标在同一事务内，防并发重复。
 */
export class L0Recorder {
  private readonly raw: DatabaseSync;
  private readonly ftsAvailable: boolean;

  constructor(raw: DatabaseSync, ftsAvailable = true) {
    this.raw = raw;
    this.ftsAvailable = ftsAvailable;
  }

  /** 写入 mem_l0 行 + 同步 FTS 索引（ftsAvailable 时）。 */
  private insertL0(id: string, projectId: string, sessionKey: string, seq: number, role: "user" | "assistant", text: string, ts: number): void {
    this.raw
      .prepare("INSERT INTO mem_l0 (id, project_id, session_key, turn_seq, role, content, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)")
      .run(id, projectId, sessionKey, seq, role, text, ts);
    if (this.ftsAvailable) {
      this.raw
        .prepare("INSERT INTO mem_l0_fts (content, l0_id, project_id) VALUES (?,?,?)")
        .run(tokenizeForFts(text), id, projectId);
    }
  }

  /**
   * 记录一轮对话到 L0。
   * @param requestMessages 客户端本轮上传的全量消息（原始，未除噪）
   * @param aggregate 本轮 assistant 聚合结果（text/final）
   * @returns 新增的 L0 记录 id 列表；非 final 或无新增时为空。
   */
  recordTurn(params: {
    projectId: string;
    sessionKey: string;
    requestMessages: readonly ChatMessage[];
    aggregate: AssistantAggregate;
    allRules: readonly DenoiseRuleData[];
  }): string[] {
    const { projectId, sessionKey, requestMessages, aggregate, allRules } = params;
    if (!aggregate.final) return []; // 中间态不落库

    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const s = this.raw
        .prepare("SELECT id, handled_count FROM sessions WHERE session_key = ?")
        .get(sessionKey) as { id: string; handled_count: number } | undefined;
      if (!s) {
        this.raw.exec("ROLLBACK");
        log.warn({ sessionKey }, "回流时会话不存在，跳过");
        return [];
      }
      const handled = s.handled_count ?? 0;

      // 新增尾部（含 memory 通道除噪）
      const fresh = requestMessages.slice(Math.min(handled, requestMessages.length));
      const memRules = allRules.filter((r) => r.enabled && r.applyMemory);
      const denoisedFresh = denoiseMessages(fresh as ChatMessage[], memRules, "memory");

      // turn_seq：该项目+会话的下一个序号
      const maxSeq = (
        this.raw
          .prepare("SELECT COALESCE(MAX(turn_seq), -1) AS m FROM mem_l0 WHERE project_id = ? AND session_key = ?")
          .get(projectId, sessionKey) as { m: number }
      ).m;

      const insertedIds: string[] = [];
      let seq = maxSeq + 1;

      // 尾部新增里只取 user 消息：客户端回传的 assistant 历史已在往轮由聚合结果入库，
      // 重复入库会破坏去重（游标按请求消息数推进）。
      for (const msg of denoisedFresh) {
        if (msg.role !== "user") continue;
        const cap = shouldCaptureL0(msg.content);
        if (!cap.ok || !cap.text) continue;
        const id = newId("l0");
        this.insertL0(id, projectId, sessionKey, seq++, "user", cap.text, Date.now());
        insertedIds.push(id);
      }

      // 本轮 assistant 最终回答
      if (aggregate.text.trim()) {
        const cap = shouldCaptureL0(aggregate.text);
        if (cap.ok && cap.text) {
          const id = newId("l0");
          this.insertL0(id, projectId, sessionKey, seq++, "assistant", cap.text, Date.now());
          insertedIds.push(id);
        }
      }

      // 推进游标：已处理 = 本轮请求消息数（assistant 回答不在请求里，单独入库不计游标）
      this.raw
        .prepare("UPDATE sessions SET handled_count = ? WHERE session_key = ?")
        .run(requestMessages.length, sessionKey);

      // 累积调度器状态（阶段 6 的调度器按阈值/idle 从此决定何时触发 L1 提取）
      if (insertedIds.length > 0) {
        const ps = this.raw
          .prepare("SELECT id, conversation_count, buffered_message_ids FROM pipeline_state WHERE project_id = ? AND session_key = ?")
          .get(projectId, sessionKey) as { id: string; conversation_count: number; buffered_message_ids: string } | undefined;
        if (ps) {
          const buffered = (JSON.parse(ps.buffered_message_ids) as string[]).concat(insertedIds);
          this.raw
            .prepare("UPDATE pipeline_state SET conversation_count = conversation_count + 1, buffered_message_ids = ? WHERE id = ?")
            .run(JSON.stringify(buffered), ps.id);
        } else {
          this.raw
            .prepare(
              "INSERT INTO pipeline_state (id, project_id, session_key, conversation_count, warmup_threshold, buffered_message_ids) VALUES (?,?,?,?,0,?)",
            )
            .run(newId("ps"), projectId, sessionKey, 1, JSON.stringify(insertedIds));
        }
      }

      this.raw.exec("COMMIT");
      if (insertedIds.length) {
        log.debug({ projectId, sessionKey, count: insertedIds.length, turnSeq: seq - 1 }, "L0 回流完成");
      }
      return insertedIds;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      log.warn({ err: String(err), sessionKey }, "L0 回流失败（已回滚）");
      return [];
    }
  }

  /** BM25 检索 L0 原文（conversation_search 工具用）。 */
  search(projectId: string, query: string, limit: number): { row: L0Row; score: number }[] {
    if (!this.ftsAvailable) return [];
    const match = buildFtsQuery(query);
    if (!match) return [];
    const rows = this.raw
      .prepare(
        `SELECT m.*, bm25(mem_l0_fts) AS rank
         FROM mem_l0_fts f
         JOIN mem_l0 m ON m.id = f.l0_id
         WHERE mem_l0_fts MATCH ? AND f.project_id = ? AND m.deleted_at IS NULL
         ORDER BY rank LIMIT ?`,
      )
      .all(match, projectId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      row: {
        id: r.id as string,
        projectId: r.project_id as string,
        sessionKey: r.session_key as string,
        turnSeq: r.turn_seq as number,
        role: r.role as "user" | "assistant",
        content: r.content as string,
        createdAt: r.created_at as number,
      },
      score: -Number(r.rank),
    }));
  }

  /** 按 id 批量取 L0（L1 溯源回查用）。 */
  getByIds(ids: string[]): L0Row[] {
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(",");
    const rows = this.raw.prepare(`SELECT * FROM mem_l0 WHERE id IN (${ph}) AND deleted_at IS NULL`).all(...ids) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      sessionKey: r.session_key as string,
      turnSeq: r.turn_seq as number,
      role: r.role as "user" | "assistant",
      content: r.content as string,
      createdAt: r.created_at as number,
    }));
  }

  /**
   * 管理端列表：某项目 L0（时间倒序，新消息靠前），可选 keyword（内容模糊）/ role 精确筛选。
   * 个人本地数据量小，内存过滤即可。
   */
  listForAdmin(projectId: string, opts: { keyword?: string; role?: "user" | "assistant" } = {}): L0Row[] {
    const kw = opts.keyword?.toLowerCase();
    const rows = this.raw
      .prepare("SELECT * FROM mem_l0 WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, turn_seq DESC LIMIT 2000")
      .all(projectId) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        id: r.id as string,
        projectId: r.project_id as string,
        sessionKey: r.session_key as string,
        turnSeq: r.turn_seq as number,
        role: r.role as "user" | "assistant",
        content: r.content as string,
        createdAt: r.created_at as number,
      }))
      .filter((r) => (!opts.role || r.role === opts.role) && (!kw || r.content.toLowerCase().includes(kw)));
  }

  /**
   * 管理端单条删除 = 物理删除（DESIGN 决策 56）：删 mem_l0 行 + 移出 FTS。
   * L1 的 sourceL0Ids 溯源保留（getByIds 查不到即不显示）。
   * （项目级联软删走 ProjectRepo，另行处理，与此不同。）
   */
  remove(id: string): boolean {
    if (!this.raw.prepare("SELECT id FROM mem_l0 WHERE id = ?").get(id)) return false;
    if (this.ftsAvailable) this.raw.prepare("DELETE FROM mem_l0_fts WHERE l0_id = ?").run(id);
    const res = this.raw.prepare("DELETE FROM mem_l0 WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }
}
