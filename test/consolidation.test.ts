import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTable } from "../src/db/fts.js";
import { createInternalRouter, type InternalDeps } from "../src/api/internal.js";
import { ProjectRepo, DbConnRepo } from "../src/projects/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { ProfileRefiner } from "../src/memory/profile-refiner.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { SqlService } from "../src/sqlquery/service.js";
import { TOOL_DEFS } from "../src/mcp/tools.js";

let dir: string;
let db: DatabaseSync;
let settings: SettingsService;
let memories: MemoryRepo;
let deps: InternalDeps;
let router: ReturnType<typeof createInternalRouter>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-cons-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  ensureFtsTable(db);

  const projects = new ProjectRepo(db);
  const models = new ModelRepo(db);
  settings = new SettingsService(db, models);
  settings.init();
  memories = new MemoryRepo(db, true, false);
  deps = {
    projects,
    assets: new AssetsRepo(db),
    memories,
    profiles: new ProfileRefiner(db, memories, settings),
    recaller: new MemoryRecaller(memories, settings),
    settings,
    sql: new SqlService({ projects, conns: new DbConnRepo(db), maxRows: () => 200 }),
  };
  router = createInternalRouter(deps);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(endpoint: string, body: Record<string, unknown>) {
  const r = await router.fetch(new Request(`http://internal.local${endpoint.replace("/internal", "")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const json = (await r.json()) as { ok: boolean; data?: unknown; error?: { message: string } };
  return { status: r.status, ...json };
}

function seedMemory(projectId: string, content: string, kind = "fact") {
  return memories.insert(projectId, {
    kind: kind as never, content, priority: 80, sceneName: null,
    sourceConversationIds: [], batchId: null, createdAt: Date.now(),
  });
}

describe("consolidation 写类工具：无口令限制（已取消硬闸）", () => {
  const p = () => "e:/code/cons";
  let pid: string;
  beforeEach(() => { pid = deps.projects.upsertOnRequest("E:/Code/Cons").project.id; });

  it("不带 consolidation_key 也能正常调用", async () => {
    const id = seedMemory(pid, "端口是 8790");
    const res = await post("/internal/memory/archive", { project_path: p(), ids: [id], reason: "测试" });
    expect(res.ok).toBe(true);
    expect((res.data as { archived: number }).archived).toBe(1);
  });

  it("多余 consolidation_key 参数不报错（schema additionalProperties 拒绝由 MCP 层把关，internal 容忍）", async () => {
    const id = seedMemory(pid, "x");
    const res = await post("/internal/memory/update", { project_path: p(), id, content: "y", consolidation_key: "whatever" });
    expect(res.ok).toBe(true);
  });

  it("参数校验仍在位：空 ids / 缺必填 → 400", async () => {
    const empty = await post("/internal/memory/archive", { project_path: p(), ids: [] });
    expect(empty.status).toBe(400);
    const noId = await post("/internal/memory/update", { project_path: p(), content: "y" });
    expect(noId.status).toBe(400);
    const noTarget = await post("/internal/memory/restore", { project_path: p() });
    expect(noTarget.status).toBe(400);
  });
});

describe("memory_archive / memory_restore 往返", () => {
  let pid: string;
  beforeEach(() => { pid = deps.projects.upsertOnRequest("E:/Code/AR").project.id; });

  it("归档→检索/列表/召回隐形→restore 整批复活", async () => {
    const a = seedMemory(pid, "旧模块 CodeGraph 负责图谱");
    const b = seedMemory(pid, "旧端口是 8000");
    const keep = seedMemory(pid, "网关用 Hono 框架");

    const arch = await post("/internal/memory/archive", {
      project_path: "e:/code/ar", ids: [a, b], reason: "功能已移除",
    });
    expect(arch.ok).toBe(true);
    const batchId = (arch.data as { batchId: string }).batchId;
    expect((arch.data as { archived: number }).archived).toBe(2);

    // 检索/活跃列表/召回版本位均不可见
    expect(memories.searchBm25(pid, "CodeGraph", 5)).toHaveLength(0);
    expect(memories.listActive(pid).map((m) => m.id)).toEqual([keep]);
    // reason 落 metadata
    expect(JSON.parse(memories.findById(a)!.metadata).archive_reason).toBe("功能已移除");

    // archived 枚举可见
    const listed = await post("/internal/memory/list", { project_path: "e:/code/ar", scope: "archived", });
    const rows = (listed.data as { list: { id: string; archiveBatch: string }[] }).list;
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(rows[0]!.archiveBatch).toBe(batchId);

    // 按批恢复
    const restore = await post("/internal/memory/restore", { project_path: "e:/code/ar", batch_id: batchId });
    expect((restore.data as { restored: number }).restored).toBe(2);
    expect(memories.listActive(pid)).toHaveLength(3);
    expect(memories.searchBm25(pid, "CodeGraph", 5).length).toBeGreaterThan(0); // FTS 未动，复活即命中
  });

  it("超 200 条拒绝；空 ids 拒绝；跨项目 id 不动", async () => {
    const other = deps.projects.upsertOnRequest("E:/Code/OtherAR").project.id;
    const foreign = seedMemory(other, "别的项目的记忆");
    const res = await post("/internal/memory/archive", {
      project_path: "e:/code/ar", ids: [foreign], reason: "越权尝试",
    });
    expect((res.data as { archived: number }).archived).toBe(0);
    expect(memories.findById(foreign)!.deletedAt).toBeNull();

    const big = Array.from({ length: 201 }, (_, i) => `m${i}`);
    const over = await post("/internal/memory/archive", { project_path: "e:/code/ar", ids: big });
    expect(over.status).toBe(400);
    const empty = await post("/internal/memory/archive", { project_path: "e:/code/ar", ids: [] });
    expect(empty.status).toBe(400);
  });
});

describe("memory_update / profile_save / memory_list / profile_read", () => {
  let pid: string;
  beforeEach(() => { pid = deps.projects.upsertOnRequest("E:/Code/UW").project.id; });

  it("update 改写后 BM25 命中新词、旧词失配", async () => {
    const id = seedMemory(pid, "端口是 8000");
    const res = await post("/internal/memory/update", {
      project_path: "e:/code/uw", id, content: "端口是 8790",
    });
    expect(res.ok).toBe(true);
    expect(memories.searchBm25(pid, "8790", 5).find((h) => h.record.id === id)).toBeDefined();
    expect(memories.searchBm25(pid, "8000", 5).find((h) => h.record.id === id)).toBeUndefined();
  });

  it("update 拒绝软删行与跨项目行", async () => {
    const id = seedMemory(pid, "x");
    memories.softDelete(id);
    const r1 = await post("/internal/memory/update", { project_path: "e:/code/uw", id, content: "y" });
    expect(r1.status).toBe(404);
    const other = deps.projects.upsertOnRequest("E:/Code/OtherUW").project.id;
    const foreign = seedMemory(other, "z");
    const r2 = await post("/internal/memory/update", { project_path: "e:/code/uw", id: foreign, content: "y" });
    expect(r2.status).toBe(404);
  });

  it("profile_save 版本递增；profile_read 回读", async () => {
    const s1 = await post("/internal/profile/save", { project_path: "e:/code/uw", content: "# 画像 v1" });
    expect((s1.data as { version: number }).version).toBe(1);
    const s2 = await post("/internal/profile/save", { project_path: "e:/code/uw", content: "# 画像 v2" });
    expect((s2.data as { version: number }).version).toBe(2);
    const s3 = await post("/internal/profile/save", { project_path: "e:/code/uw", content: "# 画像 v2" });
    expect((s3.data as { changed: boolean }).changed).toBe(false); // 未变不涨版本

    const read = await post("/internal/profile/read", { project_path: "e:/code/uw" });
    expect((read.data as { content: string }).content).toBe("# 画像 v2");
  });

  it("memory_list 分页 + kind 筛选 + keyword；只读不设闸", async () => {
    for (let i = 0; i < 5; i++) seedMemory(pid, `事实条目 ${i}`);
    seedMemory(pid, "用户偏好中文回复", "instruction");

    const all = await post("/internal/memory/list", { project_path: "e:/code/uw", pageSize: 3 });
    const d1 = all.data as { totalCount: number; list: unknown[]; page: number };
    expect(d1.totalCount).toBe(6);
    expect(d1.list).toHaveLength(3);

    const kinded = await post("/internal/memory/list", { project_path: "e:/code/uw", kind: "instruction" });
    expect((kinded.data as { totalCount: number }).totalCount).toBe(1);

    const kw = await post("/internal/memory/list", { project_path: "e:/code/uw", keyword: "条目 3" });
    expect((kw.data as { totalCount: number }).totalCount).toBe(1);
  });
});

describe("工具目录（17 个）", () => {
  it("6 个整理工具入目录：写类 4 个带红线文案、均无 key 参数", () => {
    expect(TOOL_DEFS).toHaveLength(17);
    const names = TOOL_DEFS.map((t) => t.name);
    for (const n of ["memory_list", "profile_read", "memory_archive", "memory_restore", "memory_update", "profile_save"]) {
      expect(names).toContain(n);
    }
    for (const t of TOOL_DEFS) {
      // 口令机制已整体取消：任何工具 schema 都不得再出现 consolidation_key
      expect(JSON.stringify(t.inputSchema)).not.toContain("consolidation_key");
    }
    for (const n of ["memory_archive", "memory_restore", "memory_update", "profile_save"]) {
      const t = TOOL_DEFS.find((x) => x.name === n)!;
      expect(t.description).toContain("仅限「记忆整理Agent」调用");
    }
  });
});
