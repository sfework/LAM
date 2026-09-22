import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
 * P10 管理 API：/api/db 备份、/api/memories 查看/删除。
 */

let dataDirBak: string | undefined;
let tmpData: string;

beforeEach(() => {
  dataDirBak = process.env.DATA_DIR;
  tmpData = mkdtempSync(path.join(tmpdir(), "cg-data-"));
  process.env.DATA_DIR = tmpData;
});
afterEach(() => {
  if (dataDirBak === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = dataDirBak;
  rmSync(tmpData, { recursive: true, force: true });
});

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
  };
  return { app: createApp(deps), raw, models, projects, denoise, assets, l0, l1Store, settings };
}

async function call(app: ReturnType<typeof createApp>, method: string, url: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://local${url}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: res.status, body: (await res.json()) as { success: boolean; code: number; message: string | null; data?: unknown } };
}

describe("/api/projects", () => {
  it("POST /update 改名", async () => {
    const { app, projects } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const r = await call(app, "POST", "/api/projects/update", { id: project.id, name: "改名后" });
    expect(r.status).toBe(200);
    expect((r.body.data as { name: string; path: string }).name).toBe("改名后");
    expect((r.body.data as { path: string }).path).toBe("d:/work/p");
  });

  it("POST /update 换目录（规范化）", async () => {
    const { app, projects } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const r = await call(app, "POST", "/api/projects/update", { id: project.id, path: "D:\\Work\\P\\" });
    expect((r.body.data as { path: string }).path).toBe("d:/work/p");
    // 新路径命中该项目
    const g = await call(app, "POST", "/api/projects/get-by-path", { path: "d:/work/p" });
    expect((g.body.data as { id: string }).id).toBe(project.id);
  });

  it("POST /update 无字段 → 400", async () => {
    const { app, projects } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const r = await call(app, "POST", "/api/projects/update", { id: project.id });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  });

  it("POST /update 路径撞车 → 400", async () => {
    const { app, projects } = makeApp();
    const a = projects.upsertOnRequest("d:/work/a").project;
    projects.upsertOnRequest("d:/work/b");
    const r = await call(app, "POST", "/api/projects/update", { id: a.id, path: "d:/work/b" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("占用");
  });

  it("POST /update 不存在 → 404", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/projects/update", { id: "nope", name: "x" });
    expect(r.status).toBe(404);
  });
});

describe("/api/db", () => {
  it("POST /backup 产出一致性快照文件", async () => {
    const { app, projects } = makeApp();
    projects.upsertOnRequest("d:/work/p"); // 写点数据确保非空库
    const r = await call(app, "POST", "/api/db/backup");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const file = (r.body.data as { path: string }).path;
    expect(existsSync(file)).toBe(true);

    // 备份文件可独立打开且含数据
    const check = new DatabaseSync(file, { readOnly: true });
    const cnt = check.prepare("SELECT count(*) AS c FROM projects").get() as { c: number };
    expect(cnt.c).toBeGreaterThanOrEqual(1);
    check.close();

    const list = await call(app, "POST", "/api/db/list");
    expect((list.body.data as { list: unknown[] }).list.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /list 支持 keyword 对文件名模糊", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/db/backup");
    const name = (r.body.data as { path: string }).path.split(/[\\/]/).pop()!;
    const hit = await call(app, "POST", "/api/db/list", { keyword: name.slice(0, 15) });
    expect((hit.body.data as { list: { name: string }[] }).list.map((x) => x.name)).toContain(name);
    const miss = await call(app, "POST", "/api/db/list", { keyword: "zzz-no-such-backup-zzz" });
    expect((miss.body.data as { list: unknown[] }).list).toHaveLength(0);
  });

  it("POST /delete 删除备份；非法名/不存在被拒", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/db/backup");
    const name = (r.body.data as { path: string }).path.split(/[\\/]/).pop()!;
    const file = (r.body.data as { path: string }).path;

    // 路径穿越 / 非 .db / 缺参数 → 400
    expect((await call(app, "POST", "/api/db/delete", { name: "../gateway.db" })).status).toBe(400);
    expect((await call(app, "POST", "/api/db/delete", { name: "a.txt" })).status).toBe(400);
    expect((await call(app, "POST", "/api/db/delete", {})).status).toBe(400);
    // 不存在 → 404
    expect((await call(app, "POST", "/api/db/delete", { name: "gateway-1970-01-01_00-00-00.db" })).status).toBe(404);

    // 正常删除
    const d = await call(app, "POST", "/api/db/delete", { name });
    expect(d.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });
});

describe("/api/logs", () => {
  function writeLogFile(date: string, hour: string, content: string): string {
    const [yyyy, MM, dd] = date.split("-") as [string, string, string];
    const dir = path.join(tmpData, "Logs", yyyy, MM, dd);
    mkdirSync(dir, { recursive: true });
    const full = path.join(dir, `${hour}.txt`);
    writeFileSync(full, content, "utf8");
    return full;
  }

  it("POST /list 返回指定日期的小时日志（升序）", async () => {
    const { app } = makeApp();
    writeLogFile("2026-01-05", "09", "line a\n");
    writeLogFile("2026-01-05", "08", "line b\n");
    const r = await call(app, "POST", "/api/logs/list", { date: "2026-01-05" });
    const files = (r.body.data as { files: { name: string; hour: string }[] }).files;
    expect(files.map((f) => f.hour)).toEqual(["08", "09"]);
  });

  it("POST /list 目录不存在 → 空", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/logs/list", { date: "2020-01-01" });
    expect((r.body.data as { files: unknown[] }).files).toHaveLength(0);
  });

  it("POST /get 读取日志内容；/delete 删除文件", async () => {
    const { app } = makeApp();
    const full = writeLogFile("2026-01-05", "10", "hello log\nsecond line\n");
    const g = await call(app, "POST", "/api/logs/get", { date: "2026-01-05", name: "10.txt" });
    expect((g.body.data as { content: string }).content).toContain("hello log");
    const d = await call(app, "POST", "/api/logs/delete", { date: "2026-01-05", name: "10.txt" });
    expect(d.status).toBe(200);
    expect(existsSync(full)).toBe(false);
  });

  it("POST /get|delete 路径穿越/非法名/不存在被拒", async () => {
    const { app } = makeApp();
    expect((await call(app, "POST", "/api/logs/get", { date: "2026-01-05", name: "../x.txt" })).status).toBe(400);
    expect((await call(app, "POST", "/api/logs/get", { date: "bad-date", name: "10.txt" })).status).toBe(400);
    expect((await call(app, "POST", "/api/logs/delete", { date: "2026-01-05", name: "99.txt" })).status).toBe(404);
    expect((await call(app, "POST", "/api/logs/list", { date: "2026-1-5" })).status).toBe(400);
  });
});

describe("/api/memories", () => {
  it("列出活跃 L1 + L2 画像", async () => {
    const { app, projects, l1Store } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    l1Store.insert(project.id, {
      kind: "fact",
      content: "用户偏好 pnpm",
      priority: 90,
      sceneName: null,
      sourceL0Ids: [],
      batchId: null,
      createdAt: Date.now(),
    });
    const r = await call(app, "POST", "/api/memories/list", { project_path: "d:/work/p" });
    const data = r.body.data as { list: { content: string }[] };
    expect(data.list.map((m) => m.content)).toContain("用户偏好 pnpm");
    const prof = await call(app, "POST", "/api/memories/profile", { project_path: "d:/work/p" });
    expect((prof.body.data as { content: string }).content).toBe("");
  });

  it("POST /delete 物理删除并从 FTS 检索移除", async () => {
    const { app, raw, projects, l1Store } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const id = l1Store.insert(project.id, {
      kind: "fact",
      content: "临时记忆待删除",
      priority: 80,
      sceneName: null,
      sourceL0Ids: [],
      batchId: null,
      createdAt: Date.now(),
    });
    expect(l1Store.search(project.id, "临时记忆", 5).length).toBe(1);
    const r = await call(app, "POST", "/api/memories/delete", { id });
    expect(r.body.success).toBe(true);
    // 物理删除：行不再存在（决策 56）
    expect(l1Store.get(id)).toBeUndefined();
    expect((raw.prepare("SELECT count(*) AS c FROM mem_l1 WHERE id='" + id + "'").get() as { c: number }).c).toBe(0);
    // FTS 检索不再命中（已移出索引）
    expect(l1Store.search(project.id, "临时记忆", 5).length).toBe(0);
    // 二次删除返回 404
    const r2 = await call(app, "POST", "/api/memories/delete", { id });
    expect(r2.status).toBe(404);
  });

  it("未知项目返回 400", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/memories/list", { project_path: "e:/nope" });
    expect(r.status).toBe(400);
  });

  it("L0：l0-list 内容/角色检索 + 时间倒序；l0-delete 物理删", async () => {
    const { app, raw, projects } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const ins = raw.prepare(
      "INSERT INTO mem_l0 (id, project_id, session_key, turn_seq, role, content, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)",
    );
    ins.run("l0_a", project.id, "s1", 0, "user", "第一句用户消息", 1000);
    ins.run("l0_b", project.id, "s1", 1, "assistant", "第一句助手回复", 2000);
    ins.run("l0_c", project.id, "s1", 2, "user", "另一条无关文本", 3000);

    const all = await call(app, "POST", "/api/memories/l0-list", { project_id: project.id });
    const list = (all.body.data as { list: { id: string; role: string; createdAt: number }[] }).list;
    // 时间倒序
    expect(list.map((x) => x.id)).toEqual(["l0_c", "l0_b", "l0_a"]);
    // 角色筛选
    const users = await call(app, "POST", "/api/memories/l0-list", { project_id: project.id, role: "user" });
    expect((users.body.data as { list: { id: string }[] }).list.map((x) => x.id)).toEqual(["l0_c", "l0_a"]);
    // 关键字
    const kw = await call(app, "POST", "/api/memories/l0-list", { project_id: project.id, keyword: "助手" });
    expect((kw.body.data as { list: { id: string }[] }).list.map((x) => x.id)).toEqual(["l0_b"]);

    // 删除（物理：行从表中消失）
    const d = await call(app, "POST", "/api/memories/l0-delete", { id: "l0_b" });
    expect(d.body.success).toBe(true);
    expect((raw.prepare("SELECT count(*) AS c FROM mem_l0 WHERE id='l0_b'").get() as { c: number }).c).toBe(0);
    const after = await call(app, "POST", "/api/memories/l0-list", { project_id: project.id });
    expect((after.body.data as { list: { id: string }[] }).list.map((x) => x.id)).toEqual(["l0_c", "l0_a"]);
    expect((await call(app, "POST", "/api/memories/l0-delete", { id: "l0_b" })).status).toBe(404);
  });

  it("知识库加载：所属项目软删则不加载，恢复后可见（决策 56）", async () => {
    const { app, projects, assets } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/kp");
    assets.createKnowledge({ title: "项目知识", description: "d", body: "b", scope: "project", projectId: project.id, enabled: true });
    assets.createKnowledge({ title: "全局知识", description: "d", body: "b", scope: "global", enabled: true });
    expect(assets.listKnowledge().map((k) => k.title).sort()).toEqual(["全局知识", "项目知识"]);

    // 项目软删 → project 知识不再加载（global 不受影响）
    projects.softDelete(project.id);
    const titles = assets.listKnowledge().map((k) => k.title);
    expect(titles).toContain("全局知识");
    expect(titles).not.toContain("项目知识");
    const r = await call(app, "POST", "/api/knowledge/list", {});
    expect((r.body.data as { list: { title: string }[] }).list.map((k) => k.title)).toEqual(["全局知识"]);

    // 恢复 → 重新可见
    projects.restore(project.id);
    expect(assets.listKnowledge().map((k) => k.title)).toContain("项目知识");
  });

  it("L1 update：sha 一致才写；内容未变 changed=false；sha 过期 400", async () => {
    const { app, projects, l1Store } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const id = l1Store.insert(project.id, {
      kind: "fact", content: "紫色大象跳舞", priority: 60, sceneName: null, sourceL0Ids: [], batchId: null, createdAt: Date.now(),
    });
    const sha = (await call(app, "POST", "/api/memories/list", { project_id: project.id }))
      .body.data as { list: { sha256: string }[] };
    const oldSha = sha.list[0]!.sha256;

    // 带正确 sha 修改 → changed=true，FTS 可搜到新内容、搜不到旧内容
    const u = await call(app, "POST", "/api/memories/update", { id, content: "蓝色鲸鱼唱歌", sha256: oldSha });
    expect((u.body.data as { changed: boolean }).changed).toBe(true);
    expect(l1Store.search(project.id, "蓝色鲸鱼", 5).length).toBe(1);
    expect(l1Store.search(project.id, "紫色大象", 5).length).toBe(0);

    // 内容相同 → changed=false
    const newSha = (u.body.data as { sha256: string }).sha256;
    const same = await call(app, "POST", "/api/memories/update", { id, content: "蓝色鲸鱼唱歌", sha256: newSha });
    expect((same.body.data as { changed: boolean }).changed).toBe(false);

    // 用过期 sha → 400
    const stale = await call(app, "POST", "/api/memories/update", { id, content: "再改", sha256: oldSha });
    expect(stale.status).toBe(400);
  });

  it("L2 save-profile：sha 一致才写、version 自增；未变 changed=false；过期 sha 400", async () => {
    const { app, projects } = makeApp();
    const { project } = projects.upsertOnRequest("d:/work/p");
    const p0 = await call(app, "POST", "/api/memories/profile", { project_id: project.id });
    const emptySha = (p0.body.data as { sha256: string }).sha256;

    const s1 = await call(app, "POST", "/api/memories/save-profile", { project_id: project.id, content: "# 画像 v1", sha256: emptySha });
    expect((s1.body.data as { changed: boolean; version: number }).changed).toBe(true);
    expect((s1.body.data as { version: number }).version).toBe(1);
    const sha1 = (s1.body.data as { sha256: string }).sha256;

    // 同内容再存 → changed=false，version 不动
    const s2 = await call(app, "POST", "/api/memories/save-profile", { project_id: project.id, content: "# 画像 v1", sha256: sha1 });
    expect((s2.body.data as { changed: boolean; version: number }).changed).toBe(false);
    expect((s2.body.data as { version: number }).version).toBe(1);

    // 改内容 → version=2
    const s3 = await call(app, "POST", "/api/memories/save-profile", { project_id: project.id, content: "# 画像 v2", sha256: sha1 });
    expect((s3.body.data as { version: number }).version).toBe(2);

    // 过期 sha（用 sha1 但库已是 v2）→ 400
    const stale = await call(app, "POST", "/api/memories/save-profile", { project_id: project.id, content: "# 冲突", sha256: sha1 });
    expect(stale.status).toBe(400);
  });
});

describe("/api/tools", () => {
  it("POST /list 返回全部 MCP 工具（分组+名称+描述），与 TOOL_DEFS 一致", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/tools/list", { pageSize: 100 });
    expect(r.status).toBe(200);
    const page = r.body.data as { list: { id: string; name: string; group: string; description: string }[]; totalCount: number };
    expect(page.totalCount).toBeGreaterThanOrEqual(27);
    const names = page.list.map((t) => t.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("codegraph_status");
    expect(names).toContain("sql_query_sqlite");
    // 分组派生正确
    expect(page.list.find((t) => t.name === "sql_query_sqlite")?.group).toBe("SQL");
    expect(page.list.find((t) => t.name === "knowledge_read")?.group).toBe("知识库");
    // id 唯一
    expect(new Set(names).size).toBe(names.length);
  });

  it("POST /list keyword 模糊匹配名称/描述", async () => {
    const { app } = makeApp();
    const byName = await call(app, "POST", "/api/tools/list", { keyword: "codegraph", pageSize: 100 });
    const nameList = (byName.body.data as { list: { name: string }[] }).list;
    expect(nameList.length).toBeGreaterThanOrEqual(8);
    expect(nameList.every((t) => t.name.includes("codegraph"))).toBe(true);
    const byDesc = await call(app, "POST", "/api/tools/list", { keyword: "画像", pageSize: 100 });
    expect((byDesc.body.data as { list: unknown[] }).list.length).toBeGreaterThan(0);
    const none = await call(app, "POST", "/api/tools/list", { keyword: "不存在的工具xyz", pageSize: 100 });
    expect((none.body.data as { list: unknown[] }).list).toHaveLength(0);
  });
});

describe("/api/* 结构复核", () => {
  it("非 POST 方法返回 501（统一 POST 约定）", async () => {
    const { app } = makeApp();
    const r = await call(app, "GET", "/api/models/list");
    expect(r.status).toBe(501);
    expect((r.body as { data?: unknown; message?: string }).message).toContain("POST");
  });

  it("未实现路由返回 501 且带 path", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/does-not-exist");
    expect(r.status).toBe(501);
    expect((r.body as { data?: unknown; message?: string }).message).toContain("不存在");
  });

  it("settings 可枚举（前端渲染用）", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/settings/list");
    const page = r.body.data as { list: { key: string; type: string; defaultValue: string }[]; totalCount: number };
    expect(page.totalCount).toBeGreaterThan(20);
    expect(page.list.find((s) => s.key === "gateway_llm")?.type).toBe("modelRef");
  });

  it("settings set/get 走 body 参数", async () => {
    const { app } = makeApp();
    const s = await call(app, "POST", "/api/settings/set", { key: "l1_recall_top_k", value: "7" });
    expect((s.body.data as { value: string }).value).toBe("7");
    const g = await call(app, "POST", "/api/settings/get", { key: "l1_recall_top_k" });
    expect((g.body.data as { value: string }).value).toBe("7");
    // 非法值 → 400
    const bad = await call(app, "POST", "/api/settings/set", { key: "l1_recall_top_k", value: "abc" });
    expect(bad.status).toBe(400);
  });

  it("models CRUD 全 POST", async () => {
    const { app } = makeApp();
    const c = await call(app, "POST", "/api/models/create", { category: "llm", name: "m", url: "http://x/v1", model: "mm", key: "sk-1" });
    const id = (c.body.data as { id: string }).id;
    expect(c.status).toBe(200);
    const g = await call(app, "POST", "/api/models/get", { id });
    expect((g.body.data as { model: string }).model).toBe("mm");
    const u = await call(app, "POST", "/api/models/update", { id, name: "m2" });
    expect((u.body.data as { name: string }).name).toBe("m2");
    const d = await call(app, "POST", "/api/models/delete", { id });
    expect(d.body.success).toBe(true);
    const g2 = await call(app, "POST", "/api/models/get", { id });
    expect(g2.status).toBe(404);
  });

  it("models create 缺 key → 400（密钥必填）", async () => {
    const { app } = makeApp();
    const r = await call(app, "POST", "/api/models/create", { category: "llm", name: "m", url: "http://x/v1", model: "mm" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("key");
  });

  it("models update 传空 key → 400", async () => {
    const { app } = makeApp();
    const c = await call(app, "POST", "/api/models/create", { category: "llm", name: "m", url: "http://x/v1", model: "mm", key: "sk-1" });
    const id = (c.body.data as { id: string }).id;
    const r = await call(app, "POST", "/api/models/update", { id, key: "  " });
    expect(r.status).toBe(400);
  });

  it("models list keyword 模糊匹配名称/模型名", async () => {
    const { app, models } = makeApp();
    models.create({ category: "llm", name: "通义", url: "u", key: "k", model: "qwen-max" });
    models.create({ category: "llm", name: "gpt", url: "u", key: "k", model: "gpt-4o" });
    // 命中名称
    const byName = await call(app, "POST", "/api/models/list", { keyword: "通义" });
    const l1 = (byName.body.data as { list: { name: string }[] }).list;
    expect(l1.map((x) => x.name)).toEqual(["通义"]);
    // 命中模型名（大小写不敏感）
    const byModel = await call(app, "POST", "/api/models/list", { keyword: "QWEN" });
    expect((byModel.body.data as { list: unknown[] }).list).toHaveLength(1);
    // 无匹配
    const none = await call(app, "POST", "/api/models/list", { keyword: "zzz" });
    expect((none.body.data as { list: unknown[] }).list).toHaveLength(0);
  });

  it("models list 排序：LLM 靠前，同分类按名称 ASC", async () => {
    const { app, models } = makeApp();
    models.create({ category: "embedding", name: "b-emb", url: "u", key: "k", model: "e" });
    models.create({ category: "llm", name: "z-llm", url: "u", key: "k", model: "l" });
    models.create({ category: "llm", name: "a-llm", url: "u", key: "k", model: "l" });
    const r = await call(app, "POST", "/api/models/list", {});
    const names = (r.body.data as { list: { name: string }[] }).list.map((x) => x.name);
    expect(names).toEqual(["a-llm", "z-llm", "b-emb"]);
  });

  it("models 被设置引用：list 标 inUse，update/delete 禁止", async () => {
    const { app, models, settings } = makeApp();
    const m = models.create({ category: "llm", name: "bound", url: "u", key: "k", model: "l" });
    settings.set("gateway_llm", m.id); // 绑定到设置
    const list = await call(app, "POST", "/api/models/list", {});
    const row = (list.body.data as { list: { id: string; inUse: boolean; usedBy: string[] }[] }).list.find((x) => x.id === m.id)!;
    expect(row.inUse).toBe(true);
    expect(row.usedBy).toContain("gateway_llm");
    // 编辑被禁
    const upd = await call(app, "POST", "/api/models/update", { id: m.id, name: "changed" });
    expect(upd.status).toBe(400);
    expect(upd.body.message).toContain("不可编辑");
    // 删除被禁
    const del = await call(app, "POST", "/api/models/delete", { id: m.id });
    expect(del.status).toBe(400);
    expect(del.body.message).toContain("不可删除");
    // 解绑后可删
    settings.set("gateway_llm", "");
    const del2 = await call(app, "POST", "/api/models/delete", { id: m.id });
    expect(del2.body.success).toBe(true);
  });

  it("denoise-rules list 分页 + keyword 过滤", async () => {
    const { app, denoise } = makeApp();
    denoise.create({ startText: "<context>", endText: "</context>", applyForward: true, applyMemory: true });
    denoise.create({ startText: "<env>", endText: "</env>", applyForward: true, applyMemory: false });
    const all = await call(app, "POST", "/api/denoise-rules/list", {});
    expect((all.body.data as { totalCount: number }).totalCount).toBe(2);
    // 展示按创建时间倒序：后创建的 <env> 靠前
    const order = (all.body.data as { list: { startText: string }[] }).list.map((x) => x.startText);
    expect(order).toEqual(["<env>", "<context>"]);
    // keyword 命中开始文本
    const byStart = await call(app, "POST", "/api/denoise-rules/list", { keyword: "context" });
    const l = (byStart.body.data as { list: { startText: string }[] }).list;
    expect(l).toHaveLength(1);
    expect(l[0]!.startText).toBe("<context>");
  });

  it("denoise-rules toggle 切换启用", async () => {
    const { app, denoise } = makeApp();
    const r = denoise.create({ startText: "a", endText: "b", enabled: true });
    const t = await call(app, "POST", "/api/denoise-rules/toggle", { id: r.id });
    expect((t.body.data as { enabled: boolean }).enabled).toBe(false);
    const t2 = await call(app, "POST", "/api/denoise-rules/toggle", { id: r.id });
    expect((t2.body.data as { enabled: boolean }).enabled).toBe(true);
  });

  it("prompts list keyword 过滤（名称/内容）", async () => {
    const { app } = makeApp();
    await call(app, "POST", "/api/prompts/create", { name: "核心人格", content: "你是助手", enabled: false });
    await call(app, "POST", "/api/prompts/create", { name: "other", content: "包含关键字XYZ的正文", enabled: false });
    const byName = await call(app, "POST", "/api/prompts/list", { keyword: "人格" });
    expect((byName.body.data as { list: unknown[] }).list).toHaveLength(1);
    const byContent = await call(app, "POST", "/api/prompts/list", { keyword: "xyz" });
    expect((byContent.body.data as { list: { name: string }[] }).list[0]?.name).toBe("other");
  });

  it("prompts list 名称正序 + enabled 筛选", async () => {
    const { app } = makeApp();
    await call(app, "POST", "/api/prompts/create", { name: "b-mid", content: "cb", enabled: false });
    await call(app, "POST", "/api/prompts/create", { name: "A-top", content: "ca", enabled: true }); // 大小写不敏感正序：A 在 b 前
    await call(app, "POST", "/api/prompts/create", { name: "c-bottom", content: "cc", enabled: false });
    // 名称正序（NOCASE）：A-top, b-mid, c-bottom
    const all = await call(app, "POST", "/api/prompts/list", {});
    const names = (all.body.data as { list: { name: string }[] }).list.map((x) => x.name);
    expect(names).toEqual(["A-top", "b-mid", "c-bottom"]);
    // enabled=true 只剩 A-top
    const on = await call(app, "POST", "/api/prompts/list", { enabled: true });
    const onList = (on.body.data as { list: { name: string }[] }).list;
    expect(onList.map((x) => x.name)).toEqual(["A-top"]);
    // enabled=false 剩两条
    const off = await call(app, "POST", "/api/prompts/list", { enabled: false });
    expect((off.body.data as { totalCount: number }).totalCount).toBe(2);
  });

  it("prompts 启用互斥：启用第二条自动停用第一条", async () => {
    const { app } = makeApp();
    const a = await call(app, "POST", "/api/prompts/create", { name: "A", content: "ca", enabled: true });
    const aId = (a.body.data as { id: string }).id;
    const b = await call(app, "POST", "/api/prompts/create", { name: "B", content: "cb", enabled: true });
    const bId = (b.body.data as { id: string; enabled: boolean }).id;
    // 列表里仅 B 生效
    const list = await call(app, "POST", "/api/prompts/list", {});
    const rows = (list.body.data as { list: { id: string; enabled: boolean }[] }).list;
    expect(rows.find((x) => x.id === aId)?.enabled).toBe(false);
    expect(rows.find((x) => x.id === bId)?.enabled).toBe(true);
    // /active 返回 B
    const active = await call(app, "POST", "/api/prompts/active", {});
    expect((active.body.data as { name: string }).name).toBe("B");
    // 编辑 B 不回传 enabled → 保持启用
    const u = await call(app, "POST", "/api/prompts/update", { id: bId, content: "cb2" });
    expect((u.body.data as { enabled: boolean }).enabled).toBe(true);
  });

  it("agents list 按 sortOrder 升序 + keyword/enabled 筛选", async () => {
    const { app, assets } = makeApp();
    assets.createAgent({ name: "b-agent", description: "第二", sortOrder: 20 });
    assets.createAgent({ name: "a-agent", description: "第一", sortOrder: 10, enabled: true });
    assets.createAgent({ name: "c-agent", description: "包含ZZZ描述", sortOrder: 30 });
    const all = await call(app, "POST", "/api/agents/list", {});
    expect((all.body.data as { list: { name: string }[] }).list.map((x) => x.name)).toEqual(["a-agent", "b-agent", "c-agent"]);
    // keyword 命中描述
    const kw = await call(app, "POST", "/api/agents/list", { keyword: "zzz" });
    expect((kw.body.data as { list: { name: string }[] }).list[0]?.name).toBe("c-agent");
    // enabled 筛选
    const on = await call(app, "POST", "/api/agents/list", { enabled: true });
    expect((on.body.data as { list: { name: string }[] }).list.map((x) => x.name)).toEqual(["a-agent"]);
  });

  it("agents update 只传 enabled 不清空标题/描述（回归）", async () => {
    const { app, assets } = makeApp();
    const a = assets.createAgent({ name: "保留我", description: "别清空", body: "{\"a\":1}" });
    const r = await call(app, "POST", "/api/agents/update", { id: a.id, enabled: true });
    const d = r.body.data as { name: string; description: string; body: string; enabled: boolean };
    expect(d.name).toBe("保留我");
    expect(d.description).toBe("别清空");
    expect(d.body).toBe("{\"a\":1}");
    expect(d.enabled).toBe(true);
  });

  it("skills update 只传 enabled 不清空标题（回归）", async () => {
    const { app, assets } = makeApp();
    const s = assets.createSkill({ name: "技能A", description: "d", body: "正文" });
    const r = await call(app, "POST", "/api/skills/update", { id: s.id, enabled: true });
    const d = r.body.data as { name: string; description: string; body: string; enabled: boolean };
    expect(d.name).toBe("技能A");
    expect(d.description).toBe("d");
    expect(d.body).toBe("正文");
    expect(d.enabled).toBe(true);
  });

  it("skills 正文变化生成新版本，旧版置 superseded，版本链可回溯", async () => {
    const { app, assets } = makeApp();
    const s = assets.createSkill({ name: "发布", description: "d", body: "v1 正文", enabled: true });
    expect(s.version).toBe(1);
    // 改正文 → 新版本
    const r = await call(app, "POST", "/api/skills/update", { id: s.id, body: "v2 正文" });
    const d = r.body.data as { id: string; version: number; body: string; versioned: boolean };
    expect(d.versioned).toBe(true);
    expect(d.version).toBe(2);
    expect(d.body).toBe("v2 正文");
    expect(d.id).not.toBe(s.id);
    // 旧版仍在库，置 superseded 指向新版
    const old = assets.getSkill(s.id)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBe(d.id);
    // 版本链：给新版 id 也能回溯全部两版，version 升序
    const chain = await call(app, "POST", "/api/skills/versions", { id: d.id });
    const list = chain.body.data as { version: number }[];
    expect(list.map((x) => x.version)).toEqual([1, 2]);
    // list 只含 active 版
    const ls = await call(app, "POST", "/api/skills/list", {});
    const active = (ls.body.data as { list: { id: string }[] }).list.filter((x) => x.id === s.id);
    expect(active.length).toBe(0);
  });

  it("skills 仅元数据变化不产生新版本", async () => {
    const { assets } = makeApp();
    const s = assets.createSkill({ name: "稳定", description: "d", body: "正文", enabled: false });
    const res = assets.updateSkill(s.id, { enabled: true })!;
    expect(res.versioned).toBe(false);
    expect(res.row.version).toBe(1);
    expect(res.row.id).toBe(s.id);
    expect(res.row.enabled).toBe(true);
  });

  it("agents/skills/knowledge create：描述必填，正文必填，缺字段报 400", async () => {
    const { app } = makeApp();
    // agents：仅标题、缺描述 → 400；有描述缺正文 → 400
    expect((await call(app, "POST", "/api/agents/create", { name: "a1" })).status).toBe(400);
    expect((await call(app, "POST", "/api/agents/create", { name: "a1", description: "d" })).status).toBe(400);
    const okA = await call(app, "POST", "/api/agents/create", { name: "a1", description: "d", body: "b" });
    expect(okA.status).toBe(200);
    // skills：缺描述 → 400；有描述缺正文 → 400
    expect((await call(app, "POST", "/api/skills/create", { name: "s1" })).status).toBe(400);
    expect((await call(app, "POST", "/api/skills/create", { name: "s1", description: "d" })).status).toBe(400);
    // 齐备 → 成功
    const ok = await call(app, "POST", "/api/skills/create", { name: "s1", description: "d", body: "b" });
    expect(ok.status).toBe(200);
    // knowledge：缺描述 → 400；有描述缺正文 → 400
    expect((await call(app, "POST", "/api/knowledge/create", { title: "k1", scope: "global" })).status).toBe(400);
    expect((await call(app, "POST", "/api/knowledge/create", { title: "k1", description: "d", scope: "global" })).status).toBe(400);
  });

  it("skills 不再包含 resources 字段", async () => {
    const { app, assets } = makeApp();
    const s = assets.createSkill({ name: "无资源", description: "d", body: "b" });
    expect((s as unknown as Record<string, unknown>).resources).toBeUndefined();
    const r = await call(app, "POST", "/api/skills/get", { id: s.id });
    expect((r.body.data as Record<string, unknown>).resources).toBeUndefined();
  });

  it("knowledge list 按 sortOrder + keyword，scope=project 缺 projectId 报 400", async () => {
    const { app, assets } = makeApp();
    assets.createKnowledge({ title: "全局指南", description: "gd", scope: "global", sortOrder: 5, enabled: true });
    assets.createKnowledge({ title: "项目知识", description: "pd", scope: "global", sortOrder: 1 });
    const all = await call(app, "POST", "/api/knowledge/list", {});
    expect((all.body.data as { list: { title: string }[] }).list.map((x) => x.title)).toEqual(["项目知识", "全局指南"]);
    const kw = await call(app, "POST", "/api/knowledge/list", { keyword: "指南" });
    expect((kw.body.data as { list: { title: string }[] }).list[0]?.title).toBe("全局指南");
    // scope=project 但无 projectId → 400
    const bad = await call(app, "POST", "/api/knowledge/create", { title: "x", scope: "project" });
    expect(bad.status).toBe(400);
  });

  it("knowledge update 只传 enabled 不清空标题（回归）", async () => {
    const { app, assets } = makeApp();
    const k = assets.createKnowledge({ title: "保留标题", description: "d", body: "b", scope: "global" });
    const r = await call(app, "POST", "/api/knowledge/update", { id: k.id, enabled: true });
    const d = r.body.data as { title: string; description: string; body: string; scope: string; enabled: boolean };
    expect(d.title).toBe("保留标题");
    expect(d.body).toBe("b");
    expect(d.scope).toBe("global");
    expect(d.enabled).toBe(true);
  });
});
