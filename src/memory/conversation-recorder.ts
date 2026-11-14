import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage } from "../gateway/protocol.js";
import { denoiseMessages } from "../denoise/engine.js";
import type { DenoiseRuleData } from "../denoise/repo.js";
import { shouldCaptureConversation } from "./sanitize.js";
import { newId } from "../infra/id.js";
import { colNum, colStr, colStrOrNull, getRow, getRows } from "../db/rows.js";
import { mapConversation, type ConversationRow } from "./conversation-repo.js";
import { createLogger } from "../infra/logger.js";
import type { AssistantAggregate } from "../gateway/forwarder.js";

const log = createLogger("memory:conversation");

/**
 * 对话回流记录器。
 *
 * 时机：本轮为 final answer（响应无 tool_calls）才调用；残缺轮次不落库。
 * 增量：按 sessions.handled_count 取请求消息新增尾部（OpenAI 协议每轮全量上传）。
 * 双通道：memory 副本按 applyMemory 规则除噪后入库（≠ 转发副本）。
 * 原子：读游标 → 写对话 → 推进游标 → 累积管线状态，同一事务内，防并发重复。
 */
export class ConversationRecorder {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private insert(id: string, projectId: string, sessionKey: string, seq: number, role: "user" | "assistant", text: string, ts: number): void {
    this.db
      .prepare("INSERT INTO conversations (id, project_id, session_key, turn_seq, role, content, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)")
      .run(id, projectId, sessionKey, seq, role, text, ts);
  }

  /**
   * 记录一轮对话。
   * @param requestMessages 客户端本轮上传的全量消息（原始，未除噪）
   * @param aggregate 本轮 assistant 聚合结果（text/final）
   * @returns 新增的对话记录 id 列表；非 final 或无新增时为空。
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

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const s = getRow(this.db, "SELECT id, handled_count FROM sessions WHERE session_key = ?", sessionKey);
      if (!s) {
        this.db.exec("ROLLBACK");
        log.warn({ sessionKey }, "回流时会话不存在，跳过");
        return [];
      }
      const handled = colNum(s, "handled_count");

      // 新增尾部（含 memory 通道除噪）
      const fresh = requestMessages.slice(Math.min(handled, requestMessages.length));
      const memRules = allRules.filter((r) => r.enabled && r.applyMemory);
      const denoisedFresh = denoiseMessages(fresh as ChatMessage[], memRules, "memory");

      // turn_seq：该项目+会话的下一个序号
      const maxRow = getRow(
        this.db,
        "SELECT COALESCE(MAX(turn_seq), -1) AS m FROM conversations WHERE project_id = ? AND session_key = ?",
        projectId, sessionKey,
      );
      let seq = (maxRow ? colNum(maxRow, "m") : -1) + 1;

      const insertedIds: string[] = [];
      let userCount = 0;

      // 尾部新增里只取 user 消息：客户端回传的 assistant 历史已在往轮由聚合结果入库，
      // 重复入库会破坏去重（游标按请求消息数推进）。
      for (const msg of denoisedFresh) {
        if (msg.role !== "user") continue;
        const cap = shouldCaptureConversation(msg.content);
        if (!cap.ok || !cap.text) continue;
        const id = newId("conv");
        this.insert(id, projectId, sessionKey, seq++, "user", cap.text, Date.now());
        insertedIds.push(id);
        userCount++;
      }

      // 本轮 assistant 最终回答
      if (aggregate.text.trim()) {
        const cap = shouldCaptureConversation(aggregate.text);
        if (cap.ok && cap.text) {
          const id = newId("conv");
          this.insert(id, projectId, sessionKey, seq++, "assistant", cap.text, Date.now());
          insertedIds.push(id);
        }
      }

      // 推进游标：已处理 = 本轮请求消息数（assistant 回答不在请求里，单独入库不计游标）
      this.db.prepare("UPDATE sessions SET handled_count = ? WHERE session_key = ?").run(requestMessages.length, sessionKey);

      // 累积管线状态（调度器按**未提炼的 user 消息条数**阈值决定何时触发记忆提取）。
      // 计数只加 user 条数：assistant 回答是提取素材的上下文，单独成轮不该推进触发；
      // 但缓冲仍照旧收全部新增 id（含纯 assistant 轮），否则那批内容会永久退出提取输入。
      if (insertedIds.length > 0) {
        const ps = getRow(
          this.db,
          "SELECT id, user_msg_count, buffered_message_ids FROM pipeline_states WHERE project_id = ? AND session_key = ?",
          projectId, sessionKey,
        );
        if (ps) {
          const buffered = JSON.parse(colStrOrNull(ps, "buffered_message_ids") ?? "[]") as string[];
          this.db
            .prepare("UPDATE pipeline_states SET user_msg_count = user_msg_count + ?, buffered_message_ids = ? WHERE id = ?")
            .run(userCount, JSON.stringify(buffered.concat(insertedIds)), colStr(ps, "id"));
        } else {
          this.db
            .prepare("INSERT INTO pipeline_states (id, project_id, session_key, user_msg_count, buffered_message_ids) VALUES (?,?,?,?,?)")
            .run(newId("ps"), projectId, sessionKey, userCount, JSON.stringify(insertedIds));
        }
      }

      this.db.exec("COMMIT");
      return insertedIds;
    } catch (err) {
      this.db.exec("ROLLBACK");
      log.warn({ err: String(err), sessionKey }, "对话回流失败（已回滚）");
      return [];
    }
  }

  /**
   * 管理端列表：某项目对话（时间倒序，新消息靠前），可选 keyword（内容模糊）/ role 精确筛选。
   * 个人本地数据量小，内存过滤即可。
   */
  listForAdmin(projectId: string, opts: { keyword?: string; role?: "user" | "assistant" } = {}): ConversationRow[] {
    const kw = opts.keyword?.toLowerCase();
    const rows = getRows(
      this.db,
      "SELECT * FROM conversations WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, turn_seq DESC LIMIT 2000",
      projectId,
    ).map(mapConversation);
    return rows.filter((r) => (!opts.role || r.role === opts.role) && (!kw || r.content.toLowerCase().includes(kw)));
  }

  /** 管理端单条删除 = 物理删除。记忆的来源溯源保留（查不到即不显示）。 */
  remove(id: string): boolean {
    if (!getRow(this.db, "SELECT id FROM conversations WHERE id = ?", id)) return false;
    return this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
  }
}
