import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTable } from "../src/db/fts.js";
import { ProjectRepo, DbConnRepo, isValidDbType } from "../src/projects/repo.js";
import { normalizeProjectPath, deriveProjectName } from "../src/projects/normalize.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { ProfileRepo } from "../src/memory/profile-repo.js";
import { ConversationRepo } from "../src/memory/conversation-repo.js";
import { ModelRepo } from "../src/models/repo.js";
import { DenoiseRepo } from "../src/denoise/repo.js";
import { SettingsService, SettingValidationError, parseModelBinding } from "../src/settings/service.js";

import type { ProjectRow } from "../src/projects/repo.js";

let dir: string;
let db: DatabaseSync;
let projects: ProjectRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-repo-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  ensureFtsTable(db);
  projects = new ProjectRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedProject(pathStr = "E:/Code/Demo"): ProjectRow {
  return projects.upsertOnRequest(pathStr).project;
}

describe("normalizeProjectPath", () => {
  it("统一小写、正斜杠、去尾斜杠", () => {
    expect(normalizeProjectPath("E:\\Code\\Demo\\")).toBe("e:/code/demo");
    expect(normalizeProjectPath("e:/code//demo")).toBe("e:/code/demo");
    expect(normalizeProjectPath("")).toBe("");
  });
  it("盘符根保留斜杠", () => {
    expect(normalizeProjectPath("E:/")).toBe("e:/");
  });
  it("推断项目名", () => {
    expect(deriveProjectName("e:/code/demo")).toBe("demo");
    expect(deriveProjectName("e:/")).toBe("e");
  });
});

describe("ProjectRepo", () => {
  it("自动登记 + 按路径查找 + 重复登记幂等", () => {
    const p = seedProject();
    expect(p.name).toBe("demo");
    const again = projects.upsertOnRequest("e:\\code\\demo");
    expect(again.project.id).toBe(p.id);
    expect(again.revived).toBe(false);
  });

  it("软删级联对话/记忆/画像/project 知识，恢复后重新可见", () => {
    const p = seedProject();
    const assets = new AssetsRepo(db);
    const memories = new MemoryRepo(db, true);
    const profiles = new ProfileRepo(db);
    const conv = new ConversationRepo(db);

    conv.insert({ projectId: p.id, sessionKey: "s1", turnSeq: 1, role: "user", content: "hello", createdAt: Date.now() });
    memories.insert(p.id, { kind: "fact", content: "项目使用 Hono 框架", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });
    profiles.upsert(p.id, "# 画像");
    assets.createKnowledge({ title: "k", body: "b", scope: "project", projectId: p.id, enabled: true });

    projects.softDelete(p.id);
    expect(assets.listKnowledge().find((k) => k.title === "k")).toBeUndefined();
    expect(memories.listActive(p.id)).toHaveLength(0);
    expect(profiles.findByProject(p.id)).toBeUndefined();

    projects.restore(p.id);
    expect(memories.listActive(p.id)).toHaveLength(1);
    expect(assets.listKnowledge().find((k) => k.title === "k")).toBeDefined();
  });

  it("换目录冲突检查", () => {
    const a = seedProject("E:/Code/A");
    const b = seedProject("E:/Code/B");
    expect(() => projects.update(b.id, { path: "e:/code/a" })).toThrow(/占用/);
    const updated = projects.update(a.id, { name: "renamed", path: "E:/Code/C" });
    expect(updated?.name).toBe("renamed");
    expect(updated?.path).toBe("e:/code/c");
  });
});

describe("DbConnRepo（新功能 1）", () => {
  let conns: DbConnRepo;
  let pid: string;

  beforeEach(() => {
    conns = new DbConnRepo(db);
    pid = seedProject().id;
  });

  it("新增/编辑统一 save：id 空新增，非空编辑", () => {
    const c = conns.save({ projectId: pid, name: "main", dbType: "sqlite", connectionString: "Data Source=x.db" });
    const edited = conns.save({ id: c.id, projectId: pid, name: "main", dbType: "mysql", connectionString: "Server=h;Db=d" });
    expect(edited.dbType).toBe("mysql");
    expect(conns.list(pid)).toHaveLength(1);
  });

  it("编辑不存在的连接抛错", () => {
    expect(() => conns.save({ id: "conn_nope", projectId: pid, name: "x", dbType: "sqlite", connectionString: "s" })).toThrow(/不存在/);
  });

  it("同项目连接名唯一", () => {
    conns.save({ projectId: pid, name: "main", dbType: "sqlite", connectionString: "a" });
    expect(() => conns.save({ projectId: pid, name: "main", dbType: "sqlite", connectionString: "b" })).toThrow(/已存在/);
  });

  it("多条连接平等可用，按名解析", () => {
    conns.save({ projectId: pid, name: "a", dbType: "sqlite", connectionString: "a" });
    conns.save({ projectId: pid, name: "b", dbType: "mysql", connectionString: "b" });
    expect(conns.list(pid)).toHaveLength(2);
    expect(conns.findByName(pid, "a")!.dbType).toBe("sqlite");
    expect(conns.findByName(pid, "b")!.dbType).toBe("mysql");
    expect(conns.findByName(pid, "nope")).toBeUndefined();
  });

  it("非法 dbType 拒绝", () => {
    expect(isValidDbType("oracle")).toBe(false);
    expect(() => conns.save({ projectId: pid, name: "x", dbType: "oracle" as never, connectionString: "s" })).toThrow(/非法/);
  });

  it("删除连接", () => {
    const c = conns.save({ projectId: pid, name: "a", dbType: "sqlite", connectionString: "a" });
    expect(conns.delete(c.id)).toBe(true);
    expect(conns.delete(c.id)).toBe(false);
  });
});

describe("AssetsRepo", () => {
  it("提示词互斥：启用新提示词自动停用旧的", () => {
    const assets = new AssetsRepo(db);
    const a = assets.createPrompt({ name: "a", content: "A", enabled: true });
    const b = assets.createPrompt({ name: "b", content: "B", enabled: true });
    expect(assets.getPrompt(a.id)!.enabled).toBe(false);
    expect(assets.getActivePrompt()!.id).toBe(b.id);
  });

  it("agents 排序与启停", () => {
    const assets = new AssetsRepo(db);
    assets.createAgent({ name: "x", body: "X", sortOrder: 2 });
    const y = assets.createAgent({ name: "y", body: "Y", sortOrder: 1 });
    expect(assets.listAgents()[0]!.id).toBe(y.id);
    assets.updateAgent(y.id, { enabled: false });
    expect(assets.enabledAssetLists(null).agents).toHaveLength(0);
  });

  it("系统级 Agent 不可删除、可修改", () => {
    const assets = new AssetsRepo(db);
    const a = assets.createAgent({ name: "普通", body: "B" });
    db.prepare("UPDATE agents SET system = 1 WHERE id = ?").run(a.id);
    expect(assets.getAgent(a.id)!.system).toBe(true);
    expect(() => assets.deleteAgent(a.id)).toThrow(/系统级/);
    // 修改不受限
    expect(assets.updateAgent(a.id, { description: "改过了" })!.description).toBe("改过了");
    // 普通 Agent 可删
    const b = assets.createAgent({ name: "可删", body: "B" });
    expect(assets.deleteAgent(b.id)).toBe(true);
  });

  it("knowledge 作用域：global 恒可见", () => {
    const assets = new AssetsRepo(db);
    const g = assets.createKnowledge({ title: "g", body: "G", scope: "global", enabled: true });
    const lists = assets.enabledAssetLists(null);
    expect(lists.knowledge.map((k) => k.id)).toContain(g.id);
  });
});

describe("MemoryRepo", () => {
  let mem: MemoryRepo;
  let pid: string;

  beforeEach(() => {
    mem = new MemoryRepo(db, true);
    pid = seedProject().id;
  });

  const newRec = (content: string, kind: "fact" | "method" = "fact") => ({
    kind, content, priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now(),
  });

  it("FTS BM25 检索命中中文二元组", () => {
    mem.insert(pid, newRec("项目使用 Hono 框架做网关"));
    mem.insert(pid, newRec("数据库采用 SQLite WAL 模式"));
    const hits = mem.searchBm25(pid, "Hono 框架", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.record.content).toContain("Hono");
  });

  it("supersede：冲突决策 update 后旧条目被替换不再活跃", () => {
    const oldId = mem.insert(pid, newRec("旧事实"));
    const newIdStr = mem.applyDecision(pid, { action: "update", targetIds: [oldId] }, newRec("新事实"))!;
    expect(mem.findById(oldId)!.supersededBy).toBe(newIdStr);
    const active = mem.listActive(pid);
    expect(active.map((m) => m.id)).toEqual([newIdStr]);
  });

  it("update 内容同步重建 FTS 索引", () => {
    const id = mem.insert(pid, newRec("端口是 8000"));
    mem.update(id, { content: "端口是 8790" });
    expect(mem.searchBm25(pid, "8000", 5).find((h) => h.record.id === id)).toBeUndefined();
    const hits = mem.searchBm25(pid, "8790", 5);
    expect(hits.find((h) => h.record.id === id)).toBeDefined();
  });

  it("软删后检索与列表均不可见", () => {
    const id = mem.insert(pid, newRec("待删记忆"));
    mem.softDelete(id);
    expect(mem.listActive(pid)).toHaveLength(0);
    expect(mem.searchBm25(pid, "待删记忆", 5)).toHaveLength(0);
  });

  it("按项目隔离检索", () => {
    const other = seedProject("E:/Code/Other");
    mem.insert(pid, newRec("A 项目专属事实"));
    const hits = mem.searchBm25(other.id, "A 项目专属", 5);
    expect(hits).toHaveLength(0);
  });
});

describe("ProfileRepo", () => {
  it("upsert 首次 version=1，覆盖后递增", () => {
    const profiles = new ProfileRepo(db);
    const pid = seedProject().id;
    expect(profiles.upsert(pid, "v1").version).toBe(1);
    expect(profiles.upsert(pid, "v2").version).toBe(2);
    expect(profiles.findByProject(pid)!.content).toBe("v2");
  });
});

describe("ConversationRepo", () => {
  it("插入 + maxTurnSeq + 按 id 回取", () => {
    const conv = new ConversationRepo(db);
    const pid = seedProject().id;
    const id = conv.insert({ projectId: pid, sessionKey: "s", turnSeq: 1, role: "user", content: "hi", createdAt: Date.now() });
    expect(conv.maxTurnSeq(pid, "s")).toBe(1);
    const back = conv.findByIds([id]);
    expect(back[0]!.content).toBe("hi");
    // 唯一键（project, session, turn, role）防回流重复
    expect(() => conv.insert({ projectId: pid, sessionKey: "s", turnSeq: 1, role: "user", content: "hi again", createdAt: Date.now() })).toThrow();
  });
});

describe("ModelRepo + SettingsService", () => {
  it("模型 CRUD 与关键词过滤", () => {
    const models = new ModelRepo(db);
    models.create({ category: "llm", name: "GPT", url: "https://api.x/v1", key: "k", model: "gpt-5", models: ["gpt-5", "o3"] });
    models.create({ category: "embedding", name: "Emb", url: "https://api.x/v1", model: "emb-1024" });
    expect(models.list()).toHaveLength(2);
    expect(models.list("llm", "gpt")[0]!.name).toBe("GPT");
  });

  it("parseModelBinding 支持覆盖模型名", () => {
    expect(parseModelBinding("mdl_abc")).toEqual({ modelId: "mdl_abc", modelName: "" });
    expect(parseModelBinding("mdl_abc:gpt-5-mini")).toEqual({ modelId: "mdl_abc", modelName: "gpt-5-mini" });
  });

  it("设置：默认回填、校验、热更新、模型绑定校验", () => {
    const models = new ModelRepo(db);
    const settings = new SettingsService(db, models);
    settings.init();
    expect(settings.getInt("memory_trigger_user_messages")).toBe(3);
    expect(settings.getInt("session_ttl_minutes")).toBe(120);

    // 越界拒绝
    expect(() => settings.set("memory_trigger_user_messages", "0")).toThrow(SettingValidationError);
    // 未知键拒绝
    expect(() => settings.set("nonexistent_key", "1")).toThrow(/未知设置项/);

    // 模型绑定：分类不符拒绝
    const llm = models.create({ category: "llm", name: "L", url: "u", model: "m" });
    expect(() => settings.set("embedding_model", llm.id)).toThrow(/分类不符/);
    settings.set("gateway_llm", llm.id);
    const cfg = settings.getResolvedLlmConfig("gateway_llm");
    expect(cfg).toEqual({ baseUrl: "u", apiKey: "", model: "m" });
    expect(settings.modelUsage(llm.id)).toContain("gateway_llm");
  });

  it("init 清理注册表外野键", () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)").run("legacy_key", "x", Date.now());
    const settings = new SettingsService(db, new ModelRepo(db));
    settings.init();
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'legacy_key'").get() as { c: number };
    expect(cnt.c).toBe(0);
  });
});

describe("DenoiseRepo", () => {
  it("缓存随写失效", () => {
    const denoise = new DenoiseRepo(db);
    // 基线相对断言：迁移可能预置规则（如 0004），不假设表初始为空
    const before = denoise.list().length;
    const r = denoise.create({ startText: "<a>", endText: "</a>", enabled: true });
    expect(denoise.list()).toHaveLength(before + 1);
    denoise.update(r.id, { enabled: false });
    expect(denoise.get(r.id)!.enabled).toBe(false);
    denoise.delete(r.id);
    expect(denoise.list()).toHaveLength(before);
  });
});
