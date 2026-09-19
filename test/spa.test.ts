import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
 * 前端 SPA 托管（DESIGN 决策 46）：同域同端口、静态资源命中、客户端路由回退、
 * 后端前缀不被回退吞掉、dist 缺失时纯后端模式。
 */

let tmpData: string;
let tmpDist: string;
let dataDirBak: string | undefined;

beforeEach(() => {
  dataDirBak = process.env.DATA_DIR;
  tmpData = mkdtempSync(path.join(tmpdir(), "spa-data-"));
  tmpDist = mkdtempSync(path.join(tmpdir(), "spa-dist-"));
  process.env.DATA_DIR = tmpData;
});
afterEach(() => {
  if (dataDirBak === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = dataDirBak;
  rmSync(tmpData, { recursive: true, force: true });
  rmSync(tmpDist, { recursive: true, force: true });
});

function writeDist(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpDist, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

function makeApp(spaDistDir?: string) {
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
  settings.set("codegraph_enabled", "false");
  const deps: AppDeps = {
    api: { models, settings, projects, denoise, assets, codegraph, l0, l1: l1Store, l2, raw },
    gateway: { projects, denoise, assets, settings, sessions, snapshot, l0, l2, recaller, codegraph },
    internal: { projects, assets, l1: l1Store, l0, l2, recaller, settings, codegraph, sql: new SqlService({ maxRows: () => settings.getInt("sql_query_max_rows") }) },
    spaDistDir: spaDistDir ?? tmpDist,
  };
  return { app: createApp(deps), settings };
}

const get = (app: ReturnType<typeof makeApp>["app"], url: string, headers?: Record<string, string>) =>
  app.fetch(new Request(`http://local${url}`, { headers }));

describe("SPA 托管", () => {
  it("GET / 返回 index.html", async () => {
    writeDist({ "index.html": "<!doctype html><title>app</title>", "assets/site.css": "body{margin:0}" });
    const { app } = makeApp();
    const res = await get(app, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("app");
  });

  it("静态资源按 MIME 返回，带 ETag 且支持 304", async () => {
    writeDist({ "index.html": "<html></html>", "assets/site.css": "body{margin:0}" });
    const { app } = makeApp();
    const res = await get(app, "/assets/site.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await get(app, "/assets/site.css", { "if-none-match": etag! });
    expect(again.status).toBe(304);
  });

  it("Vite 哈希产物标记 immutable，未哈希资源 must-revalidate", async () => {
    writeDist({ "index.html": "<html></html>", "assets/index-Bx2kQ9zL.js": "console.log(1)", "assets/probe.js": "x" });
    const { app } = makeApp();
    const hashed = await get(app, "/assets/index-Bx2kQ9zL.js");
    expect(hashed.headers.get("cache-control")).toContain("immutable");
    const plain = await get(app, "/assets/probe.js");
    expect(plain.headers.get("cache-control")).toContain("must-revalidate");
  });

  it("客户端路由（/projects、/memories/123）回退 index.html", async () => {
    writeDist({ "index.html": "<!doctype html><title>spa</title>" });
    const { app } = makeApp();
    for (const url of ["/projects", "/memories/m1/settings", "/deep/nested/route"]) {
      const res = await get(app, url);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("content-type"), url).toContain("text/html");
      expect(await res.text(), url).toContain("spa");
    }
  });

  it("缺失的静态资源返回 404 JSON，而不是 HTML", async () => {
    writeDist({ "index.html": "<html></html>" });
    const { app } = makeApp();
    const res = await get(app, "/assets/missing-AbCdEf123.js");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("后端路由优先于 SPA：/health 与 /api 不被接管", async () => {
    writeDist({ "index.html": "<html>spa</html>" });
    const { app } = makeApp();
    const health = await get(app, "/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, name: "local-agent-memory-gateway" });

    const api = await app.fetch(new Request("http://local/api/settings/list", { method: "POST", body: "{}" }));
    expect(api.status).toBe(200);

    // /api 下不存在的动作仍是 501（POST-only 约定），不会掉进 SPA
    const bad = await app.fetch(new Request("http://local/api/nope/missing", { method: "POST", body: "{}" }));
    expect(bad.status).toBe(501);

    // GET /api/... 仍按约定 501，而不是回退成 HTML
    const getApi = await get(app, "/api/models/list");
    expect(getApi.status).toBe(501);
  });

  it("目录穿越被拒绝", async () => {
    writeDist({ "index.html": "<html></html>" });
    const { app } = makeApp();
    const res = await get(app, "/../package.json");
    expect([400, 404]).toContain(res.status);
    if (res.status === 404) expect((await res.text()).slice(0, 12)).not.toContain('"name"');
  });

  it("dist 缺失时纯后端模式：根路径给提示，其余路径行为不变", async () => {
    const missing = path.join(tmpDist, "not-built");
    const { app } = makeApp(missing);
    const root = await get(app, "/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("未托管前端");

    const other = await get(app, "/projects");
    expect(other.status).toBe(404);
  });
});
