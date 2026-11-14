import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTable } from "../src/db/fts.js";
import { createApiRouter, type ApiDeps } from "../src/api/index.js";
import { ProjectRepo, DbConnRepo } from "../src/projects/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { ProfileRepo } from "../src/memory/profile-repo.js";
import { ProfileRefiner } from "../src/memory/profile-refiner.js";
import { ConversationRecorder } from "../src/memory/conversation-recorder.js";
import { ModelRepo } from "../src/models/repo.js";
import { DenoiseRepo } from "../src/denoise/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { sha256 } from "../src/infra/hash.js";

let dir: string;
let db: DatabaseSync;
let api: ReturnType<typeof createApiRouter>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-api-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  ensureFtsTable(db);

  const models = new ModelRepo(db);
  const settings = new SettingsService(db, models);
  settings.init();
  const memories = new MemoryRepo(db, true, false);

  const deps: ApiDeps = {
    projects: new ProjectRepo(db),
    conns: new DbConnRepo(db),
    assets: new AssetsRepo(db),
    models,
    settings,
    denoise: new DenoiseRepo(db),
    conversations: new ConversationRecorder(db),
    memories,
    profiles: new ProfileRefiner(db, memories, settings),
  };
  api = createApiRouter(deps);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(resource: string, action: string, body: Record<string, unknown> = {}) {
  const r = await api.fetch(new Request(`http://api.local/${resource}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const env = (await r.json()) as { success: boolean; code: number; message: string | null; data: unknown };
  return { status: r.status, success: env.success, code: env.code, message: env.message, data: env.data };
}

describe("/api/projects + 连接（新功能 1）", () => {
  it("登记项目后经 conn-save 新增连接", async () => {
    const created = await call("projects", "get-by-path", { path: "E:/Code/App" });
    // 项目未登记 → 404 包络
    expect(created.success).toBe(false);

    // 直接登记（网关未跑，用 repo 模拟）：conn-save 需 project_id，先建项目
    const projects = new ProjectRepo(db);
    const p = projects.upsertOnRequest("E:/Code/App").project;

    const saved = await call("projects", "conn-save", { project_id: p.id, name: "main", db_type: "sqlite", connection_string: "Data Source=x.db" });
    expect(saved.success).toBe(true);
    expect((saved.data as { name: string }).name).toBe("main");

    const list = await call("projects", "conn-list", { project_id: p.id });
    expect(Array.isArray(list.data)).toBe(true);
    expect((list.data as unknown[])).toHaveLength(1);
  });

  it("多条连接平等共存，conn-list 全量返回", async () => {
    const projects = new ProjectRepo(db);
    const p = projects.upsertOnRequest("E:/Code/Mut").project;
    const a = await call("projects", "conn-save", { project_id: p.id, name: "a", db_type: "sqlite", connection_string: "x" });
    const b = await call("projects", "conn-save", { project_id: p.id, name: "b", db_type: "mysql", connection_string: "y" });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const list = await call("projects", "conn-list", { project_id: p.id });
    const rows = list.data as { name: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });

  it("非法 db_type → 400", async () => {
    const p = new ProjectRepo(db).upsertOnRequest("E:/Code/Bad").project;
    const res = await call("projects", "conn-save", { project_id: p.id, name: "x", db_type: "oracle", connection_string: "s" });
    expect(res.success).toBe(false);
    expect(res.code).toBe(400);
  });
});

describe("/api/memories（对话/记忆/画像术语）", () => {
  it("记忆列表按项目解析 + 乐观并发 sha", async () => {
    const projects = new ProjectRepo(db);
    const p = projects.upsertOnRequest("E:/Code/Mem").project;
    const memories = new MemoryRepo(db, true, false);
    const id = memories.insert(p.id, { kind: "fact", content: "端口 8790", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });

    const list = await call("memories", "list", { project_path: "e:/code/mem" });
    const rows = list.data as { list: { id: string; content: string; sha256: string }[] };
    expect(rows.list[0]!.content).toBe("端口 8790");
    expect(rows.list[0]!.sha256).toBe(sha256("端口 8790"));

    // 陈旧 sha → 拒绝
    const stale = await call("memories", "update", { id, content: "新端口 9000", sha256: "deadbeef" });
    expect(stale.success).toBe(false);
    expect(stale.message).toMatch(/已变更/);

    // 正确 sha → 更新成功
    const upd = await call("memories", "update", { id, content: "新端口 9000", sha256: sha256("端口 8790") });
    expect(upd.success).toBe(true);
    expect(new MemoryRepo(db, true, false).findById(id)!.content).toBe("新端口 9000");
  });

  it("画像 save-profile 与 conversation-list", async () => {
    const projects = new ProjectRepo(db);
    const p = projects.upsertOnRequest("E:/Code/Pf").project;

    const save = await call("memories", "save-profile", { project_path: "e:/code/pf", content: "# 画像 v1" });
    expect(save.success).toBe(true);
    expect((save.data as { version: number }).version).toBe(1);

    const prof = await call("memories", "profile", { project_path: "e:/code/pf" });
    expect((prof.data as { content: string }).content).toBe("# 画像 v1");

    const conv = await call("memories", "conversation-list", { project_path: "e:/code/pf" });
    expect(Array.isArray((conv.data as { list: unknown[] }).list)).toBe(true);
  });
});

describe("/api/agents 系统级保护", () => {
  it("系统级 Agent 删除被拒（400），普通 Agent 可删", async () => {
    const assets = new AssetsRepo(db);
    const sys = assets.createAgent({ name: "系统级", body: "B" });
    db.prepare("UPDATE agents SET system = 1 WHERE id = ?").run(sys.id);
    const normal = assets.createAgent({ name: "普通", body: "B" });

    const denied = await call("agents", "delete", { id: sys.id });
    expect(denied.success).toBe(false);
    expect(denied.code).toBe(400);
    expect(denied.message).toMatch(/系统级/);

    const okDel = await call("agents", "delete", { id: normal.id });
    expect(okDel.success).toBe(true);
  });
});

describe("/api/tools 目录", () => {
  it("list 暴露 sql_query 单工具（合并方言）", async () => {
    const res = await call("tools", "list", {});
    const names = (res.data as { list: { name: string }[] }).list.map((t) => t.name);
    expect(names).toContain("sql_query");
    expect(names.filter((n) => n.startsWith("sql_query_"))).toHaveLength(0);
  });
});
