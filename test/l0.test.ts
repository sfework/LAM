import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTables } from "../src/db/fts.js";
import { L0Recorder } from "../src/memory/l0-recorder.js";
import { SessionRepo } from "../src/gateway/sessions.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { stripInjectionTags, shouldCaptureL0 } from "../src/memory/sanitize.js";
import type { ChatMessage } from "../src/gateway/protocol.js";
import type { DenoiseRuleData } from "../src/denoise/engine.js";

function fresh() {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  ensureFtsTables(raw);
  const projects = new ProjectRepo(raw);
  const sessions = new SessionRepo(raw);
  const l0 = new L0Recorder(raw, true);
  const { project } = projects.upsertOnRequest("d:/work/p");
  return { raw, l0, sessions, projectId: project.id };
}

const final = (text: string) => ({ text, toolCallCount: 0, final: true });
const notFinal = { text: "", toolCallCount: 2, final: false };
const noRules: DenoiseRuleData[] = [];

function l0Rows(raw: DatabaseSync, projectId: string) {
  return raw.prepare("SELECT role, content, turn_seq FROM mem_l0 WHERE project_id = ? ORDER BY turn_seq").all(projectId) as {
    role: string;
    content: string;
    turn_seq: number;
  }[];
}

describe("sanitize", () => {
  it("剥离成对注入标签", () => {
    expect(stripInjectionTags("hi\n<prompts>x</prompts>\n<project>path: e:/p</project>")).toBe("hi");
  });
  it("剥离未闭合注入残留", () => {
    expect(stripInjectionTags("hi\n<knowledge>\n- a：b")).toBe("hi");
  });
  it("未闭合剥离仅认独占一行的标签，行内提及不误删", () => {
    // 正文里行内引用标签名（反引号包裹、非独占行首），其后的内容必须保留。
    const text = "把 `<knowledge>` / `<agents>` / `<skills>` 三节格式改为 id+标题+描述。";
    expect(stripInjectionTags(text)).toBe(text);
  });
  it("shouldCaptureL0 拒收空/纯注入/斜杠命令", () => {
    expect(shouldCaptureL0("").ok).toBe(false);
    expect(shouldCaptureL0("<project>path: x</project>").ok).toBe(false);
    expect(shouldCaptureL0("/clear").ok).toBe(false);
    expect(shouldCaptureL0("正常问题").ok).toBe(true);
  });
  it("块数组取 text", () => {
    expect(shouldCaptureL0([{ type: "text", text: "abc<project>x</project>" }]).text).toBe("abc");
  });
});

describe("L0Recorder", () => {
  let ctx: ReturnType<typeof fresh>;
  beforeEach(() => {
    ctx = fresh();
  });

  it("final answer：落 user + assistant 各一条", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    const msgs: ChatMessage[] = [{ role: "user", content: "第一个问题" }];
    const ids = ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: msgs,
      aggregate: final("回答一"),
      allRules: noRules,
    });
    expect(ids).toHaveLength(2);
    const rows = l0Rows(ctx.raw, ctx.projectId);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ["user", "第一个问题"],
      ["assistant", "回答一"],
    ]);
  });

  it("非 final（有 tool_calls）不落库", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    const ids = ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: "q" }],
      aggregate: notFinal,
      allRules: noRules,
    });
    expect(ids).toHaveLength(0);
    expect(l0Rows(ctx.raw, ctx.projectId)).toHaveLength(0);
  });

  it("多轮增量：只落新增尾部，游标推进", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    const m1: ChatMessage[] = [{ role: "user", content: "q1" }];
    ctx.l0.recordTurn({ projectId: ctx.projectId, sessionKey: "s1", requestMessages: m1, aggregate: final("a1"), allRules: noRules });
    // 第二轮全量上传（含上一轮 assistant，由请求带回）
    const m2: ChatMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1-from-client" },
      { role: "user", content: "q2" },
    ];
    ctx.l0.recordTurn({ projectId: ctx.projectId, sessionKey: "s1", requestMessages: m2, aggregate: final("a2"), allRules: noRules });

    const rows = l0Rows(ctx.raw, ctx.projectId);
    // 第二轮只新增 q2 + a2；客户端带回的 a1 不重复入库
    expect(rows.map((r) => r.content)).toEqual(["q1", "a1", "q2", "a2"]);
    const handled = ctx.sessions.get("s1")!.handledCount;
    expect(handled).toBe(3); // = 第二轮请求消息数
  });

  it("tool 角色消息不入库", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [
        { role: "user", content: "q" },
        { role: "tool", content: "big tool output", tool_call_id: "t1" },
      ],
      aggregate: final("a"),
      allRules: noRules,
    });
    expect(l0Rows(ctx.raw, ctx.projectId).map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("memory 通道除噪：applyMemory=true 的规则生效", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    const rules: DenoiseRuleData[] = [
      { id: "r1", startText: "<noise>", endText: "</noise>", applyForward: true, applyMemory: true, enabled: true, createdAt: 1 },
    ];
    ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: "keep<noise>gone</noise>rest" }],
      aggregate: final("ans"),
      allRules: rules,
    });
    expect(l0Rows(ctx.raw, ctx.projectId)[0]!.content).toBe("keeprest");
  });

  it("applyMemory=false 的规则不影响 L0（存原文）", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    const rules: DenoiseRuleData[] = [
      { id: "r1", startText: "<noise>", endText: "</noise>", applyForward: true, applyMemory: false, enabled: true, createdAt: 1 },
    ];
    ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: "keep<noise>gone</noise>rest" }],
      aggregate: final("ans"),
      allRules: rules,
    });
    expect(l0Rows(ctx.raw, ctx.projectId)[0]!.content).toBe("keep<noise>gone</noise>rest");
  });

  it("剥离注入标签：客户端回传带注入内容不入库其噪声", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: "真实问题\n<project>path: e:/p</project>" }],
      aggregate: final("a"),
      allRules: noRules,
    });
    expect(l0Rows(ctx.raw, ctx.projectId)[0]!.content).toBe("真实问题");
  });

  it("会话不存在时跳过（不抛）", () => {
    const ids = ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "ghost",
      requestMessages: [{ role: "user", content: "q" }],
      aggregate: final("a"),
      allRules: noRules,
    });
    expect(ids).toHaveLength(0);
  });

  it("final 且落库时累积 pipeline_state（供阶段6调度器消费）", () => {
    ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
    ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: "q" }],
      aggregate: final("a"),
      allRules: noRules,
    });
    const ps = ctx.raw
      .prepare("SELECT conversation_count, buffered_message_ids FROM pipeline_state WHERE session_key = ?")
      .get("s1") as { conversation_count: number; buffered_message_ids: string };
    expect(ps.conversation_count).toBe(1);
    expect((JSON.parse(ps.buffered_message_ids) as string[]).length).toBe(2); // user + assistant
  });
});
