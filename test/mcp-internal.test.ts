import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import type { InternalDeps } from "../src/api/internal.js";

/**
 * 内部只读 API（/internal/*）测试：MCP 薄壳转发目标。
 */

function makeInternal() {
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
  const l0 = new L0Recorder(raw, true);
  const l1Store = new L1Store(raw, true, false);
  const l2 = new L2Refiner(raw, l1Store, settings);
  const recaller = new MemoryRecaller(l1Store, settings);
  const codegraph = new CodeGraphService(raw, settings, projects);
  settings.set("codegraph_enabled", "false"); // 测试不启动 watcher/索引
  const sql = new SqlService({ maxRows: () => settings.getInt("sql_query_max_rows") });
  const internal: InternalDeps = { projects, assets, l1: l1Store, l0, l2, recaller, settings, codegraph, sql };
  const deps: AppDeps = {
    api: { models, settings, projects, denoise, assets, codegraph, l0, l1: l1Store, l2, raw },
    gateway: { projects, denoise, assets, settings, sessions, snapshot, l0, l2, recaller, codegraph },
    internal,
  };
  return { app: createApp(deps), projects, assets, l1Store, l0, l2, sessions, raw };
}

async function get(app: ReturnType<typeof createApp>, url: string) {
  const res = await app.fetch(new Request(`http://local${url}`));
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: unknown; error?: { message: string } } };
}

describe("internal read API", () => {
  it("knowledge/list 返回生效项（global + 本项目），不含正文", async () => {
    const { app, projects, assets } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    assets.createKnowledge({ title: "全局指南", description: "gd", body: "SECRET-BODY", scope: "global", enabled: true });
    assets.createKnowledge({ title: "项目知识", description: "pd", body: "x", scope: "project", projectId: project.id, enabled: true });
    assets.createKnowledge({ title: "禁用项", description: "", scope: "global", enabled: false });

    const r = await get(app, `/internal/knowledge/list?project_path=${encodeURIComponent("d:/work/p")}`);
    const titles = (r.body.data as { title: string }[]).map((k) => k.title);
    expect(titles).toContain("全局指南");
    expect(titles).toContain("项目知识");
    expect(titles).not.toContain("禁用项");
    // list 不含 body
    expect(JSON.stringify(r.body.data)).not.toContain("SECRET-BODY");
  });

  it("knowledge/read 返回正文", async () => {
    const { app, assets } = makeInternal();
    const k = assets.createKnowledge({ title: "t", description: "d", body: "完整正文内容", scope: "global", enabled: true });
    const r = await get(app, `/internal/knowledge/read?id=${k.id}`);
    expect((r.body.data as { body: string }).body).toBe("完整正文内容");
  });

  it("agents/skills list+read", async () => {
    const { app, assets } = makeInternal();
    const a = assets.createAgent({ name: "reviewer", description: "评审", body: '{"command":"x"}', enabled: true });
    const s = assets.createSkill({ name: "deploy", description: "发布", body: "步骤", enabled: true });
    expect(((await get(app, "/internal/agents/list")).body.data as unknown[]).length).toBe(1);
    expect(((await get(app, `/internal/agents/read?id=${a.id}`)).body.data as { body: string }).body).toContain("command");
    expect(((await get(app, "/internal/skills/list")).body.data as unknown[]).length).toBe(1);
    expect(((await get(app, `/internal/skills/read?id=${s.id}`)).body.data as { body: string }).body).toBe("步骤");
  });

  it("memory/search + memory/read（含溯源）", async () => {
    const { app, projects, l1Store } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    l1Store.insert(project.id, { kind: "persona", content: "用户偏好 pnpm 管理依赖", priority: 90, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() });
    const sr = await get(app, `/internal/memory/search?project_path=${encodeURIComponent("d:/work/p")}&query=pnpm 依赖`);
    const hits = sr.body.data as { id: string; kind: string }[];
    expect(hits.length).toBe(1);
    expect(hits[0]!.kind).toBe("persona");
    const rr = await get(app, `/internal/memory/read?id=${hits[0]!.id}`);
    expect((rr.body.data as { content: string }).content).toContain("pnpm");
  });

  it("memory/profile 读画像", async () => {
    const { app, projects, raw } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    raw.prepare("INSERT INTO mem_l2 (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)").run("l2x", project.id, "# 项目画像内容", Date.now());
    const r = await get(app, `/internal/memory/profile?project_path=${encodeURIComponent("d:/work/p")}`);
    expect((r.body.data as { content: string }).content).toContain("项目画像内容");
  });

  it("conversation/search 检索 L0 原文", async () => {
    const { app, projects, l0, sessions } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    sessions.create("s1", project.id, "header", Date.now());
    l0.recordTurn({
      projectId: project.id,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: "如何配置 nginx 反向代理" }],
      aggregate: { text: "在 nginx.conf 里配置 proxy_pass", toolCallCount: 0, final: true },
      allRules: [],
    });
    const r = await get(app, `/internal/conversation/search?project_path=${encodeURIComponent("d:/work/p")}&query=nginx 反向代理`);
    const hits = r.body.data as { content: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).toContain("nginx");
  });

  it("project_path 不存在 → 空/错误", async () => {
    const { app } = makeInternal();
    const r = await get(app, `/internal/memory/search?project_path=${encodeURIComponent("e:/nope")}&query=x`);
    expect(r.status).toBe(400);
  });

  it("缺 id → 400", async () => {
    const { app } = makeInternal();
    expect((await get(app, "/internal/knowledge/read")).status).toBe(400);
  });

  it("sql 端点：不支持方言 400，写语句以 data.error 返回", async () => {
    const { app } = makeInternal();
    expect((await get(app, `/internal/sql/oracle/query?connection_string=x&sql=SELECT%201`)).status).toBe(400);
    expect((await get(app, `/internal/sql/sqlite/query?sql=SELECT%201`)).status).toBe(400);
    const dir = mkdtempSync(path.join(tmpdir(), "lam-int-sql-"));
    const file = path.join(dir, "a.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (7);");
    db.close();
    const q = await get(app, `/internal/sql/sqlite/query?connection_string=${encodeURIComponent(file)}&sql=${encodeURIComponent("SELECT a FROM t")}`);
    expect((q.body.data as { rows: unknown[] }).rows).toEqual([{ a: 7 }]);
    const denied = await get(app, `/internal/sql/sqlite/query?connection_string=${encodeURIComponent(file)}&sql=${encodeURIComponent("DROP TABLE t")}`);
    expect(denied.status).toBe(200);
    expect((denied.body.data as { error: string }).error).toContain("只支持 SELECT");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MCP 薄壳端到端（真实 HTTP + InMemory client）", () => {
  let server: ServerType;
  let port = 0;
  let dataDir: string;
  let closeHandle: (() => void) | null = null;
  let stopScheduler: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    dataDir = path.join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;
    const { bootstrap } = await import("../src/server.js");
    const { app, handle, scheduler } = bootstrap();
    closeHandle = () => handle.close();
    stopScheduler = () => scheduler.stop();
    server = serve({ fetch: app.fetch, port: 0, hostname: "localhost" });
    await new Promise<void>((r) => server.on("listening", r));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (stopScheduler) await stopScheduler();
    if (closeHandle) closeHandle();
    // 关句柄后 Windows 文件锁释放可能有延迟，重试删除
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    delete process.env.DATA_DIR;
  });

  /** 连到主服务 /mcp（Streamable HTTP，无状态）的客户端。 */
  async function mcpClient() {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
    await client.connect(transport);
    return client;
  }

  it("listTools 返回全部工具定义", async () => {
    const client = await mcpClient();
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(30);
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("knowledge_read");
    expect(toolNames).toContain("codegraph_search");
    expect(toolNames).toContain("codegraph_impact");
    expect(toolNames).toContain("codegraph_status");
    expect(toolNames).toContain("sql_query_sqlite");
    expect(toolNames).toContain("sql_list_tables_mysql");
    expect(toolNames).toContain("sql_describe_table_sqlserver");
    await client.close();
  });

  it("callTool knowledge_list 经 /mcp → /internal 取数", async () => {
    const base = `http://localhost:${port}`;
    await fetch(`${base}/api/knowledge/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "MCP可见知识", description: "d", body: "b", scope: "global", enabled: true }) });

    const client = await mcpClient();
    const res = await client.callTool({ name: "knowledge_list", arguments: { project_path: "e:/mcp-test" } });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain("MCP可见知识");
    await client.close();
  });

  it("callTool sql_query_sqlite 查外部库（只读）", async () => {
    const file = path.join(dataDir, "biz.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('甲'), ('乙');");
    db.close();

    const client = await mcpClient();
    const ok = await client.callTool({ name: "sql_query_sqlite", arguments: { connection_string: file, sql: "SELECT name FROM t ORDER BY id" } });
    expect((ok.content as { text: string }[])[0]!.text).toContain("甲");

    const tables = await client.callTool({ name: "sql_list_tables_sqlite", arguments: { connection_string: file } });
    expect((tables.content as { text: string }[])[0]!.text).toContain("\"name\": \"t\"");

    const desc = await client.callTool({ name: "sql_describe_table_sqlite", arguments: { connection_string: file, table: "t" } });
    expect((desc.content as { text: string }[])[0]!.text).toContain("id");

    // 写操作：以文本结果返回拒绝原因（不是 isError）
    const denied = await client.callTool({ name: "sql_query_sqlite", arguments: { connection_string: file, sql: "DELETE FROM t" } });
    const deniedText = (denied.content as { text: string }[])[0]!.text;
    expect(deniedText).toContain("只支持 SELECT");
    expect(denied.isError).toBeUndefined();
    await client.close();
  });

  it("检索族限流：第 4 次调用返回上限提示", async () => {
    const client = await mcpClient();
    const uniqPath = `e:/limit-${Date.now()}`;
    let last = "";
    for (let i = 0; i < 4; i++) {
      const res = await client.callTool({ name: "memory_search", arguments: { project_path: uniqPath, query: "x" } });
      last = (res.content as { text: string }[])[0]!.text;
    }
    expect(last).toContain("检索上限");
    await client.close();
  });
});
