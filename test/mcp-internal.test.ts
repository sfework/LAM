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
  const sql = new SqlService({ maxRows: () => settings.getInt("sql_query_max_rows") });
  const internal: InternalDeps = { projects, assets, l1: l1Store, l0, l2, recaller, settings, sql };
  const deps: AppDeps = {
    api: { models, settings, projects, denoise, assets, l0, l1: l1Store, l2 },
    gateway: { projects, denoise, assets, settings, sessions, snapshot, l0, l2, recaller },
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

  it("knowledge/read 返回正文；project 级跨项目拒读（决策 82）", async () => {
    const { app, projects, assets } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const k = assets.createKnowledge({ title: "t", description: "d", body: "完整正文内容", scope: "global", enabled: true });
    const pp = encodeURIComponent("d:/work/p");
    const r = await get(app, `/internal/knowledge/read?id=${k.id}&project_path=${pp}`);
    expect((r.body.data as { body: string }).body).toBe("完整正文内容");
    // 缺 project_path → 400
    expect((await get(app, `/internal/knowledge/read?id=${k.id}`)).status).toBe(400);
    // project 级条目：本项目可读，他项目 404
    const pk = assets.createKnowledge({ title: "pt", description: "", body: "b", scope: "project", projectId: project.id, enabled: true });
    expect((await get(app, `/internal/knowledge/read?id=${pk.id}&project_path=${pp}`)).status).toBe(200);
    projects.upsertOnRequest("d:/work/q");
    const other = encodeURIComponent("d:/work/q");
    expect((await get(app, `/internal/knowledge/read?id=${pk.id}&project_path=${other}`)).status).toBe(404);
  });

  it("agents list+read（read 强制 project_path，决策 82）", async () => {
    const { app, projects, assets } = makeInternal();
    projects.upsertOnRequest("d:/work/p");
    const a = assets.createAgent({ name: "reviewer", description: "评审", body: '{"command":"x"}', enabled: true });
    expect(((await get(app, "/internal/agents/list")).body.data as unknown[]).length).toBe(1);
    expect(((await get(app, `/internal/agents/read?id=${a.id}&project_path=${encodeURIComponent("d:/work/p")}`)).body.data as { body: string }).body).toContain("command");
    expect((await get(app, `/internal/agents/read?id=${a.id}`)).status).toBe(400);
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

  it("memory/batch-read 分页读取 + memory/batch-update 批量改删（决策 79）", async () => {
    const { app, projects, l1Store } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const ids = ["记忆甲", "记忆乙", "记忆丙"].map((c) =>
      l1Store.insert(project.id, { kind: "fact", content: c, priority: 80, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() }),
    );
    const pp = encodeURIComponent("d:/work/p");

    const r1 = await get(app, `/internal/memory/batch-read?project_path=${pp}&page=1&page_size=2`);
    const page1 = r1.body.data as { list: { id: string }[]; total: number; page: number; pageSize: number };
    expect(page1.total).toBe(3);
    expect(page1.list).toHaveLength(2);
    expect(page1.pageSize).toBe(2);
    const r2 = await get(app, `/internal/memory/batch-read?project_path=${pp}&page=2&page_size=2`);
    const page2 = (await r2.body).data as { list: { id: string }[] };
    expect(page2.list).toHaveLength(1);
    // 翻页无重叠
    expect(new Set([...page1.list.map((x) => x.id), ...page2.list.map((x) => x.id)])).toHaveLength(3);

    // 批量：改乙 + 删丙 + 一条不存在的失败（部分成功语义）
    const res = await app.fetch(
      new Request(`http://local/internal/memory/batch-update?project_path=${pp}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { id: ids[1], content: "记忆乙（已修正）" },
            { id: ids[2], action: "delete" },
            { id: "l1_missing", content: "x" },
          ],
        }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; data: { results: { ok: boolean }[]; applied: number; skipped: number } };
    expect(body.data.applied).toBe(2);
    expect(body.data.skipped).toBe(1);
    expect(body.data.results[2]!.ok).toBe(false);
    expect(l1Store.get(ids[1]!)!.content).toBe("记忆乙（已修正）");
    expect(l1Store.get(ids[2]!)).toBeUndefined();

    // 跨项目记忆拒绝操作
    const other = projects.upsertOnRequest("d:/work/q").project;
    const otherId = l1Store.insert(other.id, { kind: "fact", content: "他项目记忆", priority: 80, sceneName: "", sourceL0Ids: [], batchId: null, createdAt: Date.now() });
    const bad = (await (
      await app.fetch(
        new Request(`http://local/internal/memory/batch-update?project_path=${pp}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ id: otherId, action: "delete" }] }),
        }),
      )
    ).json()) as { data: { applied: number } };
    expect(bad.data.applied).toBe(0);
  });

  it("memory/profile 读画像（含 version/updatedAt，决策 80）", async () => {
    const { app, projects, raw } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    raw.prepare("INSERT INTO mem_l2 (id, project_id, content, version, updated_at, deleted_at) VALUES (?,?,?,1,?,NULL)").run("l2x", project.id, "# 项目画像内容", Date.now());
    const r = await get(app, `/internal/memory/profile?project_path=${encodeURIComponent("d:/work/p")}`);
    const d = r.body.data as { content: string; version: number; updatedAt: number | null };
    expect(d.content).toContain("项目画像内容");
    expect(d.version).toBe(1);
    expect(d.updatedAt).toBeTypeOf("number");
  });

  it("memory/save-profile 保存画像：变化涨版本、未变跳过、空内容拒绝（决策 80）", async () => {
    const { app, projects, l2 } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const pp = encodeURIComponent("d:/work/p");
    // 先 text() 再 parse：规避 Hono 错误响应体在 .json() 直取时的流式竞态（决策 80 用例）。
    const post = async (payload: unknown) => {
      const res = await app.fetch(
        new Request(`http://local/internal/memory/save-profile?project_path=${pp}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      return JSON.parse(await res.text()) as { ok: boolean; data?: { changed: boolean; version: number }; error?: { message: string } };
    };

    // 首建：version=1
    const r1 = await post({ content: "# 画像 v1\n- 技术栈：Node.js" });
    expect(r1.ok).toBe(true);
    expect(r1.data).toEqual({ changed: true, version: 1 });
    // 再存相同内容：changed=false，version 不涨
    const r2 = await post({ content: "# 画像 v1\n- 技术栈：Node.js" });
    expect(r2.data).toEqual({ changed: false, version: 1 });
    // 实质变化：version 自增
    const r3 = await post({ content: "# 画像 v2\n- 技术栈：Node.js / Hono" });
    expect(r3.data).toEqual({ changed: true, version: 2 });
    expect(l2.read(project.id)).toContain("Hono");
    // 空内容拒绝
    const r4 = await post({ content: "   " });
    expect(r4.ok).toBe(false);
    // 未解析项目拒绝
    const r5res = await app.fetch(
      new Request("http://local/internal/memory/save-profile?project_path=d%3A%2Fwork%2Fmissing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      }),
    );
    const r5 = JSON.parse(await r5res.text()) as { ok: boolean };
    expect(r5.ok).toBe(false);
  });

  it("knowledge/update 部分更新：字段生效、空更新拒绝、跨项目拒绝（决策 81）", async () => {
    const { app, projects, assets } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const post = async (url: string, payload: unknown) =>
      (
        await app.fetch(
          new Request(`http://local${url}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
      ).json() as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { message: string } }>;
    const pp = encodeURIComponent("d:/work/p");

    // global 条目：同样强制带 project_path（决策 82），部分更新只动传入字段
    const g = assets.createKnowledge({ title: "指南", description: "gd", body: "原文", scope: "global", enabled: true });
    const r1 = await post(`/internal/knowledge/update?project_path=${pp}`, { id: g.id, body: "修订后正文" });
    expect(r1.ok).toBe(true);
    expect(assets.getKnowledge(g.id)!.body).toBe("修订后正文");
    expect(assets.getKnowledge(g.id)!.title).toBe("指南"); // 未传字段保持不变

    // project 条目：项目匹配才可改
    const k = assets.createKnowledge({ title: "项目知识", description: "", body: "b", scope: "project", projectId: project.id, enabled: true });
    const r2 = await post(`/internal/knowledge/update?project_path=${pp}`, { id: k.id, description: "新描述" });
    expect(r2.ok).toBe(true);
    expect(assets.getKnowledge(k.id)!.description).toBe("新描述");

    // 跨项目拒绝
    const other = projects.upsertOnRequest("d:/work/q").project;
    const ok2 = assets.createKnowledge({ title: "他项目", description: "", body: "b", scope: "project", projectId: other.id, enabled: true });
    const r3 = await post(`/internal/knowledge/update?project_path=${pp}`, { id: ok2.id, body: "x" });
    expect(r3.ok).toBe(false);
    // 缺 project_path 拒绝（决策 82 强制校验）
    const r4 = await post("/internal/knowledge/update", { id: k.id, body: "x" });
    expect(r4.ok).toBe(false);

    // 无任何可更新字段拒绝；不存在的 id 拒绝
    expect((await post(`/internal/knowledge/update?project_path=${pp}`, { id: g.id })).ok).toBe(false);
    expect((await post(`/internal/knowledge/update?project_path=${pp}`, { id: "kno_missing", body: "x" })).ok).toBe(false);
  });

  it("agents/update 部分更新：字段生效、空更新拒绝；强制 project_path（决策 81/82）", async () => {
    const { app, projects, assets } = makeInternal();
    projects.upsertOnRequest("d:/work/p");
    const a = assets.createAgent({ name: "keeper", description: "维护", body: "旧定义", enabled: true });
    const post = async (payload: unknown, path = encodeURIComponent("d:/work/p")) =>
      (
        await app.fetch(
          new Request(`http://local/internal/agents/update${path ? `?project_path=${path}` : ""}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
      ).json() as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { message: string } }>;

    const r1 = await post({ id: a.id, body: "新定义", description: "新描述" });
    expect(r1.ok).toBe(true);
    const got = assets.getAgent(a.id)!;
    expect(got.body).toBe("新定义");
    expect(got.description).toBe("新描述");
    expect(got.name).toBe("keeper"); // 未传字段保持不变
    expect(got.enabled).toBe(true); // enabled 不受影响

    expect((await post({ id: a.id })).ok).toBe(false);
    expect((await post({ id: "agt_missing", body: "x" })).ok).toBe(false);
    // 缺 project_path 拒绝（决策 82）
    expect((await post({ id: a.id, body: "x" }, "")).ok).toBe(false);
  });

  it("knowledge/create + knowledge/delete（决策 83）：建项默认挂本项目，跨项目拒删，global 可建可删", async () => {
    const { app, projects, assets } = makeInternal();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const pp = encodeURIComponent("d:/work/p");
    const post = async (url: string, payload: unknown) =>
      (
        await app.fetch(
          new Request(`http://local${url}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
      ).json() as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { message: string } }>;

    // 缺省 scope：建出的条目挂当前项目，本项目可读
    const r1 = await post(`/internal/knowledge/create?project_path=${pp}`, { title: "新指南", description: "d", body: "正文" });
    expect(r1.ok).toBe(true);
    const kid = r1.data!.id as string;
    expect(assets.getKnowledge(kid)!.scope).toBe("project");
    expect(assets.getKnowledge(kid)!.projectId).toBe(project.id);
    expect(assets.getKnowledge(kid)!.enabled).toBe(true);
    // 显式 global：不挂项目
    const r2 = await post(`/internal/knowledge/create?project_path=${pp}`, { title: "全局经验", body: "b", scope: "global" });
    expect((r2.data!.scope as string)).toBe("global");
    // 校验：缺 title/body 拒；缺 project_path 拒
    expect((await post(`/internal/knowledge/create?project_path=${pp}`, { title: "只标题" })).ok).toBe(false);
    expect((await post("/internal/knowledge/create", { title: "t", body: "b" })).ok).toBe(false);

    // 删除：本项目 project 条目可删（物理）
    const d1 = await post(`/internal/knowledge/delete?project_path=${pp}`, { id: kid });
    expect(d1.ok).toBe(true);
    expect(assets.getKnowledge(kid)).toBeUndefined();
    // 跨项目拒删
    const other = projects.upsertOnRequest("d:/work/q").project;
    const ok2 = assets.createKnowledge({ title: "他项目", description: "", body: "b", scope: "project", projectId: other.id, enabled: true });
    expect((await post(`/internal/knowledge/delete?project_path=${pp}`, { id: ok2.id })).ok).toBe(false);
    // global 可删；不存在拒
    expect((await post(`/internal/knowledge/delete?project_path=${pp}`, { id: r2.data!.id as string })).ok).toBe(true);
    expect((await post(`/internal/knowledge/delete?project_path=${pp}`, { id: "kno_missing" })).ok).toBe(false);
  });

  it("agents/create + agents/delete（决策 83）：强制 project_path，建后物删", async () => {
    const { app, projects, assets } = makeInternal();
    projects.upsertOnRequest("d:/work/p");
    const pp = encodeURIComponent("d:/work/p");
    const post = async (url: string, payload: unknown) =>
      (
        await app.fetch(
          new Request(`http://local${url}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
      ).json() as Promise<{ ok: boolean; data?: Record<string, unknown> }>;

    const r1 = await post(`/internal/agents/create?project_path=${pp}`, { name: "tester", description: "d", body: "定义正文" });
    expect(r1.ok).toBe(true);
    const aid = r1.data!.id as string;
    expect(assets.getAgent(aid)!.enabled).toBe(true);
    // 缺 name/body 拒；缺 project_path 拒
    expect((await post(`/internal/agents/create?project_path=${pp}`, { name: "只名字" })).ok).toBe(false);
    expect((await post("/internal/agents/create", { name: "t", body: "b" })).ok).toBe(false);
    // 删除；不存在拒
    expect((await post(`/internal/agents/delete?project_path=${pp}`, { id: aid })).ok).toBe(true);
    expect(assets.getAgent(aid)).toBeUndefined();
    expect((await post(`/internal/agents/delete?project_path=${pp}`, { id: "agt_missing" })).ok).toBe(false);
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

  it("listTools 返回全部工具定义（list 工具已移除，决策 70；memory_read/read_profile 已下线，决策 79）", async () => {
    const client = await mcpClient();
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(18);
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_batch_read");
    expect(toolNames).toContain("memory_batch_update");
    expect(toolNames).toContain("memory_profile_read");
    expect(toolNames).toContain("memory_profile_update");
    expect(toolNames).toContain("knowledge_update");
    expect(toolNames).toContain("agent_update");
    // 决策 83：资产增删工具开放；写类工具描述含使用红线
    expect(toolNames).toContain("knowledge_create");
    expect(toolNames).toContain("knowledge_delete");
    expect(toolNames).toContain("agent_create");
    expect(toolNames).toContain("agent_delete");
    const wr = tools.tools.find((t) => t.name === "knowledge_create");
    expect(JSON.stringify(wr?.description)).toContain("禁止自行调用");
    expect(toolNames).not.toContain("memory_read");
    expect(toolNames).not.toContain("memory_read_profile");
    expect(toolNames).toContain("knowledge_read");
    expect(toolNames).toContain("sql_query_sqlite");
    expect(toolNames).toContain("sql_list_tables_mysql");
    expect(toolNames).toContain("sql_describe_table_sqlserver");
    // CodeGraph 已移除：codegraph_* 工具不再暴露
    expect(toolNames).not.toContain("codegraph_search");
    expect(toolNames).not.toContain("codegraph_status");
    // knowledge/agent/skill 的 list 工具不再开放（清单已注入系统提示，按 id read 即可）
    expect(toolNames).not.toContain("knowledge_list");
    expect(toolNames).not.toContain("agent_list");
    expect(toolNames).not.toContain("skill_read");
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
