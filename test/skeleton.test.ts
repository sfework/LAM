import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/server.js";
import { runMigrations } from "../src/db/migrate.js";
import { newId } from "../src/infra/id.js";
import { formatLine } from "../src/infra/logger.js";
import { ProjectRepo, DbConnRepo } from "../src/projects/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { ProfileRefiner } from "../src/memory/profile-refiner.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { SqlService } from "../src/sqlquery/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeAppDeps(db: DatabaseSync, fts: boolean, vec: boolean): AppDeps {
  const projects = new ProjectRepo(db);
  const conns = new DbConnRepo(db);
  const assets = new AssetsRepo(db);
  const models = new ModelRepo(db);
  const settings = new SettingsService(db, models);
  settings.init();
  const memories = new MemoryRepo(db, fts, vec);
  const recaller = new MemoryRecaller(memories, settings);
  const sql = new SqlService({ projects, conns, maxRows: () => settings.getInt("sql_query_max_rows") });
  return {
    internal: { projects, assets, memories, profiles: new ProfileRefiner(db, memories, settings), recaller, settings, sql },
    healthExtra: { fts5: fts, vec },
  };
}

describe("health", () => {
  it("GET /health 返回就绪信息", async () => {
    const memDb = new DatabaseSync(":memory:");
    runMigrations(memDb);
    const app = createApp(makeAppDeps(memDb, true, false));
    const res = await app.fetch(new Request("http://localhost/health"));
    memDb.close();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.name).toBe("nlam");
    expect(json.fts5).toBe(true);
    expect(typeof json.time).toBe("string");
  });
});

describe("migrations", () => {
  let dir: string;
  let raw: DatabaseSync;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nlam-test-"));
    raw = new DatabaseSync(path.join(dir, "test.db"));
    runMigrations(raw);
  });

  afterAll(() => {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("初始迁移建齐全部核心表", () => {
    const names = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      "projects",
      "project_db_connections",
      "conversations",
      "memory_items",
      "profiles",
      "pipeline_states",
      "sessions",
      "prompts",
      "agents",
      "knowledges",
      "denoise_rules",
      "models",
      "settings",
      "__migrations",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("重复应用迁移幂等", () => {
    expect(() => runMigrations(raw)).not.toThrow();
    const cnt = raw.prepare("SELECT COUNT(*) AS c FROM __migrations").get() as { c: number };
    // 已应用数 = migrations 目录文件数（重跑不新增）
    const total = readdirSync(path.resolve(here, "../migrations")).filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;
    expect(cnt.c).toBe(total);
  });

  it("同项目连接名唯一（UNIQUE(project_id, name)）", () => {
    const ins = raw.prepare(
      "INSERT INTO project_db_connections (id, project_id, name, db_type, connection_string, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    // 先建项目满足外键
    raw.prepare("INSERT INTO projects (id, name, path, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)").run(
      "p1",
      "p1",
      "e:/tmp/p1",
      Date.now(),
      Date.now(),
    );
    ins.run(newId("conn"), "p1", "a", "sqlite", "x", Date.now(), Date.now());
    expect(() => ins.run(newId("conn"), "p1", "a", "sqlite", "y", Date.now(), Date.now())).toThrow();
    // 不同连接名可任意多条（无启停状态）
    ins.run(newId("conn"), "p1", "c", "sqlite", "z", Date.now(), Date.now());
    ins.run(newId("conn"), "p1", "d", "mysql", "z", Date.now(), Date.now());
  });
});

describe("infra", () => {
  it("newId 带前缀且唯一", () => {
    const a = newId("mem");
    const b = newId("mem");
    expect(a).toMatch(/^mem_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it("formatLine 把 pino JSON 转成人读行", () => {
    const line = formatLine('{"ts":"2026-11-07 10:00:00.000","level":"info","module":"db","msg":"ok","k":1}');
    expect(line).toBe('2026-11-07 10:00:00.000 [INFO] [db] ok {"k":1}');
  });
});
