import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTable } from "../src/db/fts.js";
import { ProjectRepo, DbConnRepo } from "../src/projects/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { ProfileRefiner } from "../src/memory/profile-refiner.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { SqlService } from "../src/sqlquery/service.js";
import { assertReadOnlySql, SqlGuardError, splitStatements } from "../src/sqlquery/guard.js";
import { createInternalRouter, type InternalDeps } from "../src/api/internal.js";
import { createApp, type AppDeps } from "../src/server.js";

let dir: string;
let db: DatabaseSync;
let projects: ProjectRepo;
let conns: DbConnRepo;
let internalDeps: InternalDeps;
let sqliteFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-mcp-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  ensureFtsTable(db);
  projects = new ProjectRepo(db);
  conns = new DbConnRepo(db);

  // 外部业务库（sqlite）：目标项目连接的查询对象
  sqliteFile = path.join(dir, "business.db").replace(/\\/g, "/");
  const biz = new DatabaseSync(sqliteFile);
  biz.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
  biz.exec("INSERT INTO users (name) VALUES ('alice'), ('bob')");
  biz.close();

  const assets = new AssetsRepo(db);
  const models = new ModelRepo(db);
  const settings = new SettingsService(db, models);
  settings.init();
  const memories = new MemoryRepo(db, true, false);
  const recaller = new MemoryRecaller(memories, settings);
  const sql = new SqlService({ projects, conns, maxRows: () => settings.getInt("sql_query_max_rows") });
  internalDeps = { projects, assets, memories, profiles: new ProfileRefiner(db, memories, settings), recaller, settings, sql };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqlGuard", () => {
  it("放行 SELECT/WITH，拒绝写语句与多语句", () => {
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
    expect(() => assertReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t")).not.toThrow();
    expect(() => assertReadOnlySql("SELECT * FROM a; DELETE FROM a")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySql("INSERT INTO a VALUES (1)")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySql("SELECT * FROM t WHERE name = 'DROP TABLE x'")).not.toThrow(); // 字面量内关键字不误伤
    expect(() => assertReadOnlySql("")).toThrow(/不能为空/);
  });

  it("splitStatements 不被字符串内分号误拆", () => {
    expect(splitStatements("SELECT 'a;b' AS x")).toHaveLength(1);
  });
});

describe("SqlService（新功能 2：按项目 + 连接名解析连接）", () => {
  it("未配置连接 → 未找到数据库连接并提示无连接", async () => {
    projects.upsertOnRequest("E:/Code/NoConn");
    const res = await internalDeps.sql.queryByProject("E:/Code/NoConn", "main", "SELECT 1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/未找到数据库连接/);
    expect(res.error).toMatch(/未配置任何数据库连接/);
  });

  it("连接名不存在 → 报错并列出可用连接名供自纠", async () => {
    const p = projects.upsertOnRequest("E:/Code/Off").project;
    conns.save({ projectId: p.id, name: "main", dbType: "sqlite", connectionString: sqliteFile });
    const res = await internalDeps.sql.queryByProject("E:/Code/Off", "nope", "SELECT 1");
    expect(res.error).toMatch(/未找到数据库连接/);
    expect(res.error).toMatch(/main\(sqlite\)/);
  });

  it("按连接名查询成功返回行集", async () => {
    const p = projects.upsertOnRequest("E:/Code/On").project;
    conns.save({ projectId: p.id, name: "main", dbType: "sqlite", connectionString: sqliteFile });
    const res = await internalDeps.sql.queryByProject("E:\\code\\on", "main", "SELECT name FROM users ORDER BY id");
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([{ name: "alice" }, { name: "bob" }]);
  });

  it("listConnections 只返回名称与类型", () => {
    const p = projects.upsertOnRequest("E:/Code/Lc").project;
    conns.save({ projectId: p.id, name: "a", dbType: "sqlite", connectionString: sqliteFile });
    conns.save({ projectId: p.id, name: "b", dbType: "mysql", connectionString: "Server=h" });
    expect(internalDeps.sql.listConnections("e:/code/lc")).toEqual([
      { name: "a", dbType: "sqlite" },
      { name: "b", dbType: "mysql" },
    ]);
    expect(internalDeps.sql.listConnections("e:/code/ghost")).toBeNull();
  });

  it("写 SQL 先被守卫拒绝（早于连接解析）", async () => {
    const res = await internalDeps.sql.queryByProject("E:/Code/None", "main", "DELETE FROM users");
    expect(res.error).toMatch(/只支持 SELECT/);
  });

  it("行数超上限截断并提示", async () => {
    const p = projects.upsertOnRequest("E:/Code/Cap").project;
    conns.save({ projectId: p.id, name: "main", dbType: "sqlite", connectionString: sqliteFile });
    internalDeps.settings.set("sql_query_max_rows", "1");
    const res = await internalDeps.sql.queryByProject("E:/Code/Cap", "main", "SELECT name FROM users");
    expect(res.rows).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });
});

describe("MCP 工具目录（sql_query 合并 + 术语）", () => {
  it("17 个工具：无 sql_query_* 方言工具，有单一 sql_query 与 list_db_connections", async () => {
    const { TOOL_DEFS } = await import("../src/mcp/tools.js");
    expect(TOOL_DEFS.find((t) => t.name === "sql_query")).toBeDefined();
    expect(TOOL_DEFS.find((t) => t.name === "list_db_connections")).toBeDefined();
    expect(TOOL_DEFS.filter((t) => t.name.startsWith("sql_query_"))).toHaveLength(0);
    expect(TOOL_DEFS).toHaveLength(17);
    // 描述与参数不得出现 L0/L1/L2 字样
    for (const t of TOOL_DEFS) {
      expect(`${t.description}${JSON.stringify(t.inputSchema)}`).not.toMatch(/L[012]/);
    }
  });

  it("RollingLimiter 滚动窗口限流", async () => {
    const { RollingLimiter } = await import("../src/mcp/server.js");
    const lim = new RollingLimiter(3, 100);
    expect(lim.take("k").allowed).toBe(true);
    lim.take("k");
    lim.take("k");
    expect(lim.take("k").allowed).toBe(false); // 第 4 次超限
    expect(lim.take("other").allowed).toBe(true); // 按 key 分组
    await new Promise((r) => setTimeout(r, 120));
    expect(lim.take("k").allowed).toBe(true); // 窗口滚出
  });
});

describe("/internal 端点（统一 POST JSON body）", () => {
  const post = async (endpoint: string, body: Record<string, unknown>) => {
    const router = createInternalRouter(internalDeps);
    const r = await router.fetch(new Request(`http://internal.local${endpoint.replace("/internal", "")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  it("knowledge CRUD 走项目隔离", async () => {
    const p = projects.upsertOnRequest("E:/Code/Kn").project;
    const other = projects.upsertOnRequest("E:/Code/KnOther").project;

    const created = await post("/internal/knowledge/create", { project_path: "e:/code/kn", title: "k1", body: "b1" });
    expect(created.json.ok).toBe(true);
    const id = ((created.json.data as Record<string, unknown>).id as string);

    // 其他项目不能读 project 级条目
    const crossRead = await post("/internal/knowledge/read", { project_path: "e:/code/knother", id });
    expect(crossRead.status).toBe(404);

    const read = await post("/internal/knowledge/read", { project_path: "E:\\Code\\Kn", id });
    expect((read.json.data as { body: string }).body).toBe("b1");

    const upd = await post("/internal/knowledge/update", { project_path: "e:/code/kn", id, body: "b2" });
    expect(upd.json.ok).toBe(true);

    const del = await post("/internal/knowledge/delete", { project_path: "e:/code/kn", id });
    expect(del.json.ok).toBe(true);
    expect(assets(db).getKnowledge(id)).toBeUndefined();
    void other;
  });

  it("sql/query 端点：未配置时 data.error 供模型自纠（ok:true）", async () => {
    projects.upsertOnRequest("E:/Code/SqlEp");
    const res = await post("/internal/sql/query", { project_path: "e:/code/sqlep", conn: "main", sql: "SELECT 1" });
    expect(res.json.ok).toBe(true);
    expect((res.json.data as { error?: string }).error).toMatch(/未找到数据库连接/);
  });

  it("sql/query 端点：缺 conn → 400", async () => {
    const res = await post("/internal/sql/query", { project_path: "e:/code/sqlep", sql: "SELECT 1" });
    expect(res.status).toBe(400);
  });

  it("sql/conns 端点：返回连接名与类型", async () => {
    const p = projects.upsertOnRequest("E:/Code/SqlConns").project;
    conns.save({ projectId: p.id, name: "db", dbType: "sqlite", connectionString: sqliteFile });
    const res = await post("/internal/sql/conns", { project_path: "e:/code/sqlconns" });
    expect((res.json.data as { connections: { name: string; dbType: string }[] }).connections).toEqual([
      { name: "db", dbType: "sqlite" },
    ]);
  });

  it("sql/query 端点：配置后按连接名返回行集", async () => {
    const p = projects.upsertOnRequest("E:/Code/SqlEp2").project;
    conns.save({ projectId: p.id, name: "db", dbType: "sqlite", connectionString: sqliteFile });
    const res = await post("/internal/sql/query", { project_path: "e:/code/sqlep2", conn: "db", sql: "SELECT count(*) AS c FROM users" });
    expect((res.json.data as { rows: { c: number }[] }).rows[0]!.c).toBe(2);
  });

  it("memory/search 需要可解析的 project_path", async () => {
    const res = await post("/internal/memory/search", { project_path: "e:/code/ghost", query: "x" });
    expect(res.status).toBe(400);
  });
});

function assets(db: DatabaseSync): AssetsRepo {
  return new AssetsRepo(db);
}

describe("createApp MCP 端到端", () => {
  function makeDeps(): AppDeps {
    return { internal: internalDeps, healthExtra: { fts5: true, vec: false } };
  }

  it("tools/list 经 /mcp 返回 17 工具", async () => {
    const app = createApp(makeDeps());
    const res = await app.fetch(new Request("http://local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(json.result.tools).toHaveLength(17);
    expect(json.result.tools.map((t) => t.name)).toContain("sql_query");
    expect(json.result.tools.map((t) => t.name)).toContain("list_db_connections");
  });

  it("tools/call sql_query 走完整链路（进程内 caller → internal → SqlService）", async () => {
    const app = createApp(makeDeps());
    const p = projects.upsertOnRequest("E:/Code/E2E").project;
    conns.save({ projectId: p.id, name: "db", dbType: "sqlite", connectionString: sqliteFile });
    const res = await app.fetch(new Request("http://local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "sql_query", arguments: { project_path: "e:/code/e2e", conn: "db", sql: "SELECT name FROM users WHERE id = 1" } },
      }),
    }));
    const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(json.result.isError).not.toBe(true);
    expect(json.result.content[0]!.text).toContain("alice");
  });
});
