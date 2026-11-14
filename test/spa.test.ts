import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/server.js";
import { runMigrations } from "../src/db/migrate.js";
import { ProjectRepo, DbConnRepo } from "../src/projects/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { ProfileRefiner } from "../src/memory/profile-refiner.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { SqlService } from "../src/sqlquery/service.js";

let dir: string;
let dist: string;
let db: DatabaseSync;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-spa-"));
  dist = path.join(dir, "dist");
  mkdirSync(path.join(dist, "assets"), { recursive: true });
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>NLAM</title><div id=root></div>");
  writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log(1)");

  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  const projects = new ProjectRepo(db);
  const models = new ModelRepo(db);
  const settings = new SettingsService(db, models);
  settings.init();
  const memories = new MemoryRepo(db, false, false);
  const deps: AppDeps = {
    internal: {
      projects,
      assets: new AssetsRepo(db),
      memories,
      profiles: new ProfileRefiner(db, memories, settings),
      recaller: new MemoryRecaller(memories, settings),
      settings,
      sql: new SqlService({ projects, conns: new DbConnRepo(db), maxRows: () => 200 }),
    },
    spaDistDir: dist,
  };
  app = createApp(deps);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (p: string) => app.fetch(new Request(`http://spa.local${p}`));

describe("SPA 托管", () => {
  it("静态文件直接命中并带缓存头", async () => {
    const res = await get("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("客户端路由回退 index.html", async () => {
    const res = await get("/Memories");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=root></div>");
  });

  it("带扩展名的缺失资源不回退 HTML（404 JSON）", async () => {
    const res = await get("/assets/missing-x12345.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("后端前缀不被 SPA 接管成 HTML：/health 正常，/api 未注册时 404 JSON", async () => {
    const h = await get("/health");
    expect(h.status).toBe(200);
    // 本测试未挂 api 路由：POST /api 不被 SPA 接管（SPA 只处理 GET/HEAD），走框架 404，绝不回退 HTML
    const res = await app.fetch(new Request("http://spa.local/api/nope/nope", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html");
    // GET 保留前缀同样不回退 HTML
    const g = await get("/api/nope/nope");
    expect(g.status).toBe(404);
    expect(g.headers.get("content-type")).toContain("application/json");
  });

  it("ETag 协商缓存命中 304", async () => {
    const res = await get("/assets/index-abc123.js");
    const etag = res.headers.get("etag")!;
    const res2 = await app.fetch(new Request("http://spa.local/assets/index-abc123.js", { headers: { "if-none-match": etag } }));
    expect(res2.status).toBe(304);
  });
});
