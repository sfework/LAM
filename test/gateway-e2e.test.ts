import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTables } from "../src/db/fts.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { DenoiseRepo } from "../src/denoise/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { SessionRepo } from "../src/gateway/sessions.js";
import { SnapshotBuilder } from "../src/gateway/snapshot.js";
import { L0Recorder } from "../src/memory/l0-recorder.js";
import { L1Store } from "../src/memory/l1-store.js";
import { L2Refiner } from "../src/memory/l2-refiner.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { CodeGraphService } from "../src/codegraph/service.js";
import { SqlService } from "../src/sql/service.js";
import { createApp, type AppDeps } from "../src/server.js";

/**
 * 网关主链路集成测试：mock 上游，验证转发、model 重写、注入、会话复用、错误处理。
 */

let upstream: Server;
let upstreamPort = 0;
let lastUpstreamBody: Record<string, unknown> = {};
let upstreamMode: "json" | "stream" = "json";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastUpstreamBody = JSON.parse(raw || "{}");
      if (upstreamMode === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi there" } }] }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "localhost", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(() => upstream?.close());

function makeApp() {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  ensureFtsTables(raw);
  const models = new ModelRepo(raw);
  const settings = new SettingsService(raw, models);
  settings.init();
  const projects = new ProjectRepo(raw);
  const denoise = new DenoiseRepo(raw);
  const assets = new AssetsRepo(raw);
  const sessions = new SessionRepo(raw);
  const snapshot = new SnapshotBuilder(assets, settings);
  const l0 = new L0Recorder(raw);
  const l1Store = new L1Store(raw, true, false);
  const l2 = new L2Refiner(raw, l1Store, settings);
  const recaller = new MemoryRecaller(l1Store, settings);
  const codegraph = new CodeGraphService(raw, settings, projects);
  settings.set("codegraph_enabled", "false"); // 测试不启动 watcher/索引
  const deps: AppDeps = {
    api: { models, settings, projects, denoise, assets, codegraph, l0, l1: l1Store, l2, raw },
    gateway: { projects, denoise, assets, settings, sessions, snapshot, l0, l2, recaller, codegraph },
    internal: { projects, assets, l1: l1Store, l0, l2, recaller, settings, codegraph, sql: new SqlService({ maxRows: () => settings.getInt("sql_query_max_rows") }) },
  };
  return { app: createApp(deps), raw, models, settings, assets, denoise, sessions, l0, l1Store, recaller, projects };
}

async function postChat(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("gateway e2e", () => {
  it("未配置 gateway_llm → 友好错误", async () => {
    const { app } = makeApp();
    const res = await postChat(app, { model: "x", messages: [{ role: "user", content: "hi" }] }, { "x-project-path": "d:/work/p" });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("llm_not_configured");
  });

  it("配置后转发：重写 model、注入快照到 system、透传 extra", async () => {
    const { app, models, settings } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "k", model: "real-model" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");

    const res = await postChat(
      app,
      { model: "client-ignored", messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }], temperature: 0.3 },
      { "x-project-path": "d:/work/p" },
    );
    expect(res.status).toBe(200);
    await res.text(); // 消费 body

    expect(lastUpstreamBody.model).toBe("real-model"); // 重写
    expect(lastUpstreamBody.temperature).toBe(0.3); // 透传
    const msgs = lastUpstreamBody.messages as { role: string; content: string }[];
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("You are helpful.");
    expect(msgs[0]!.content).toContain("<project>");
    expect(msgs[0]!.content).toContain("path: d:/work/p");
  });

  it("同会话第二轮复用快照（system 注入字节一致）", async () => {
    const { app, models, settings } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");

    const sys1 = [{ role: "system", content: "BASE" }, { role: "user", content: "q1" }];
    await (await postChat(app, { model: "x", messages: sys1 }, { "x-session-id": "sess-A", "x-project-path": "d:/work/p" })).text();
    const injected1 = (lastUpstreamBody.messages as { content: string }[])[0]!.content;

    // 第二轮：历史里带上上一轮 assistant
    await (
      await postChat(
        app,
        { model: "x", messages: [...sys1, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }] },
        { "x-session-id": "sess-A", "x-project-path": "d:/work/p" },
      )
    ).text();
    const injected2 = (lastUpstreamBody.messages as { content: string }[])[0]!.content;

    expect(injected2).toBe(injected1); // 快照复用，字节一致
    // 且快照只在 system 注入一次，不随轮次累积
    expect((injected2.match(/<project>/g) ?? []).length).toBe(1);
  });

  it("资产清单注入：生效提示词 + 知识/agents/skills", async () => {
    const { app, models, settings, assets } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");
    assets.createPrompt({ name: "p", content: "ALWAYS BE CONCISE", enabled: true });
    const kn = assets.createKnowledge({ title: "架构指南", description: "系统架构", scope: "global", enabled: true });
    const ag = assets.createAgent({ name: "reviewer", description: "代码评审", body: "b", enabled: true });
    const sk = assets.createSkill({ name: "deploy", description: "发布流程", body: "b", enabled: true });

    await (await postChat(app, { model: "x", messages: [{ role: "user", content: "hi" }] }, { "x-project-path": "d:/work/p" })).text();
    const sys = (lastUpstreamBody.messages as { role: string; content: string }[]).find((m) => m.role === "system")!.content;
    expect(sys).toContain("<prompts>");
    expect(sys).toContain("ALWAYS BE CONCISE");
    // 清单注入 id + 标题 + 描述（正文仍按 id 经 MCP 读取）
    expect(sys).toContain("<knowledge>");
    expect(sys).toContain(`${kn.id}：架构指南：系统架构`);
    expect(sys).toContain("<agents>");
    expect(sys).toContain(`${ag.id}：reviewer：代码评审`);
    expect(sys).toContain("<skills>");
    expect(sys).toContain(`${sk.id}：deploy：发布流程`);
  });

  it("除噪在转发通道生效", async () => {
    const { app, models, settings, denoise } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");
    denoise.create({ startText: "<replaced>", endText: "</replaced>", applyForward: true, applyMemory: true, enabled: true });

    await (
      await postChat(app, { model: "x", messages: [{ role: "user", content: "keep<replaced>NOISE</replaced>rest" }] }, { "x-project-path": "d:/work/p" })
    ).text();
    const user = (lastUpstreamBody.messages as { role: string; content: string }[]).find((m) => m.role === "user")!;
    expect(user.content).toBe("keeprest");
  });

  it("SSE 流式透传", async () => {
    const { app, models, settings } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");
    upstreamMode = "stream";
    try {
      const res = await postChat(app, { model: "x", stream: true, messages: [{ role: "user", content: "hi" }] }, { "x-project-path": "d:/work/p" });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("Hel");
      expect(text).toContain("lo");
    } finally {
      upstreamMode = "json";
    }
  });

  it("不开放 /v1/models", async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request("http://local/v1/models"));
    expect(res.status).toBe(404);
  });

  it("每轮 L1 召回：命中的记忆拼到最后一条 user 之前", async () => {
    const { app, models, settings, l1Store, projects } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "true");
    const { project } = projects.upsertOnRequest("d:/work/p");
    l1Store.insert(project.id, { kind: "persona", content: "用户偏好使用 pnpm 管理依赖", priority: 90, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() });

    await (
      await postChat(
        app,
        { model: "x", messages: [{ role: "system", content: "BASE" }, { role: "user", content: "我该怎么装依赖 pnpm" }] },
        { "x-session-id": "sess-R", "x-project-path": "d:/work/p" },
      )
    ).text();

    const msgs = lastUpstreamBody.messages as { role: string; content: string }[];
    // system 仍只有快照注入（含 <project>），不含 <recalled>
    expect(msgs[0]!.content).toContain("<project>");
    expect(msgs[0]!.content).not.toContain("<recalled>");
    // 最后一条 user 前缀了召回块
    const lastUser = [...msgs].reverse().find((mm) => mm.role === "user")!;
    expect(lastUser.content).toContain("<recalled>");
    expect(lastUser.content).toContain("pnpm");
    expect(lastUser.content).toContain("我该怎么装依赖 pnpm");
  });

  it("缺项目路径 → 400", async () => {
    const { app } = makeApp();
    const res = await postChat(app, { model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("final answer 经网关后 L0 回流落库", async () => {
    const { app, raw, models, settings, sessions } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");
    settings.set("extraction_enabled", "true");

    const res = await postChat(
      app,
      { model: "x", messages: [{ role: "user", content: "L0 回流测试问题" }] },
      { "x-session-id": "sess-L0", "x-project-path": "d:/work/p" },
    );
    await res.text();
    // 等待 fire-and-forget 的聚合 + 回流完成
    await new Promise((r) => setTimeout(r, 150));

    const rows = raw.prepare("SELECT role, content FROM mem_l0 WHERE session_key = ? ORDER BY turn_seq").all("sess-L0") as {
      role: string;
      content: string;
    }[];
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[0]!.content).toBe("L0 回流测试问题");
    expect(rows[1]!.content).toBe("hi there"); // mock 上游的非流式回答
    expect(sessions.get("sess-L0")!.handledCount).toBe(1);
    // pipeline_state 已累积（阶段 6 调度器消费）
    const ps = raw.prepare("SELECT conversation_count FROM pipeline_state WHERE session_key = ?").get("sess-L0") as { conversation_count: number };
    expect(ps.conversation_count).toBe(1);
  });

  it("extraction_enabled=false 时 L0 仍落库（该开关只 gate 阶段6提取）", async () => {
    const { app, raw, models, settings } = makeApp();
    const m = models.create({ category: "llm", name: "mock", url: `http://localhost:${upstreamPort}`, key: "", model: "rm" });
    settings.set("gateway_llm", m.id);
    settings.set("l1_recall_enabled", "false");
    settings.set("extraction_enabled", "false");

    const res = await postChat(
      app,
      { model: "x", messages: [{ role: "user", content: "仍应入库" }] },
      { "x-session-id": "sess-OFF", "x-project-path": "d:/work/p" },
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 150));
    const rows = raw.prepare("SELECT content FROM mem_l0 WHERE session_key='sess-OFF'").all() as { content: string }[];
    expect(rows.map((r) => r.content)).toEqual(["仍应入库", "hi there"]);
  });
});
