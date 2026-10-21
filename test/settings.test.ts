import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/migrate.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService, parseModelBinding } from "../src/settings/service.js";
import { SETTING_DEFS, parseSettingValue, validateSettingValue, getSettingDef } from "../src/settings/registry.js";

function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  return raw;
}

describe("migrations", () => {
  it("建出全部业务表", () => {
    const raw = freshDb();
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const t of [
      "projects", "prompts", "agents", "knowledge", "denoise_rules",
      "models", "settings", "mem_l0", "mem_l1", "mem_l2",
      "pipeline_state", "sessions",
    ]) {
      expect(names, `缺表 ${t}`).toContain(t);
    }
    // CodeGraph 功能已整体移除：cg_* 全部表（含状态表 cg_status）均已删除；
    // extract_queue 早期设计残留，随迁移 0014 删除（崩溃恢复靠 pipeline_state 缓冲）。
    for (const gone of ["cg_status", "cg_files", "cg_symbols", "cg_edges", "cg_calls", "cg_extends", "cg_imports", "cg_bindings", "extract_queue"]) {
      expect(names, `应已删除 ${gone}`).not.toContain(gone);
    }
  });

  it("重复执行幂等", () => {
    const raw = freshDb();
    expect(() => runMigrations(raw)).not.toThrow();
  });
});

describe("registry", () => {
  it("所有 int 项默认值合法", () => {
    for (const def of SETTING_DEFS) {
      expect(validateSettingValue(def, def.defaultValue), `${def.key} 默认值非法`).toBeNull();
    }
  });
  it("类型解析正确", () => {
    expect(parseSettingValue(getSettingDef("l1_recall_top_k")!, "7")).toBe(7);
    expect(parseSettingValue(getSettingDef("l1_recall_similarity_min")!, "0.7")).toBeCloseTo(0.7);
  });
  it("越界/类型错误被拒", () => {
    const def = getSettingDef("l1_recall_top_k")!;
    expect(validateSettingValue(def, "abc")).not.toBeNull();
    expect(validateSettingValue(def, "-1")).not.toBeNull();
  });
});

describe("modelRepo", () => {
  let repo: ModelRepo;
  beforeEach(() => {
    repo = new ModelRepo(freshDb());
  });
  it("增删改查", () => {
    const m = repo.create({ category: "llm", name: "GPT", url: "https://a", key: "k", model: "gpt-4o" });
    expect(m.id).toMatch(/^mdl_/);
    expect(repo.get(m.id)?.name).toBe("GPT");
    const u = repo.update(m.id, { name: "GPT-4o" });
    expect(u?.name).toBe("GPT-4o");
    expect(repo.list("llm")).toHaveLength(1);
    expect(repo.delete(m.id)).toBe(true);
    expect(repo.get(m.id)).toBeUndefined();
  });
});

describe("settingsService", () => {
  let raw: DatabaseSync;
  let models: ModelRepo;
  let svc: SettingsService;
  beforeEach(() => {
    raw = freshDb();
    models = new ModelRepo(raw);
    svc = new SettingsService(raw, models);
    svc.init();
  });

  it("init 回填默认值", () => {
    expect(svc.getInt("l1_recall_top_k")).toBe(10);
  });

  it("set 落库 + 热更新读取", () => {
    svc.set("l1_recall_top_k", "9");
    expect(svc.getInt("l1_recall_top_k")).toBe(9);
    // 新实例从库读取，验证持久化
    const svc2 = new SettingsService(raw, models);
    svc2.init();
    expect(svc2.getInt("l1_recall_top_k")).toBe(9);
  });

  it("非法值抛错", () => {
    expect(() => svc.set("l1_recall_top_k", "0")).toThrow();
  });

  it("变更即时生效（读写一致性）", () => {
    svc.set("l1_recall_top_k", "6");
    expect(svc.getInt("l1_recall_top_k")).toBe(6);
    svc.set("l1_recall_top_k", "7");
    expect(svc.getInt("l1_recall_top_k")).toBe(7);
  });

  it("modelRef 校验模型存在与分类", () => {
    const llm = models.create({ category: "llm", name: "L", url: "u", model: "m" });
    const emb = models.create({ category: "embedding", name: "E", url: "u", model: "m" });
    expect(() => svc.set("gateway_llm", "nope")).toThrow();
    expect(() => svc.set("gateway_llm", emb.id)).toThrow(); // 分类不符
    expect(() => svc.set("gateway_llm", llm.id)).not.toThrow();
    expect(svc.getResolvedModel("gateway_llm")?.id).toBe(llm.id);
    // 允许置空（全部不生效）
    expect(() => svc.set("gateway_llm", "")).not.toThrow();
    expect(svc.getResolvedModel("gateway_llm")).toBeUndefined();
  });

  it("modelRef 绑定值支持 id:model 覆盖模型名", () => {
    const llm = models.create({ category: "llm", name: "L", url: "http://u/v1", model: "m" });
    svc.set("gateway_llm", `${llm.id}:gpt-5`);
    expect(svc.getResolvedModel("gateway_llm")?.id).toBe(llm.id);
    expect(svc.getResolvedLlmConfig("gateway_llm")).toEqual({ baseUrl: "http://u/v1", apiKey: "", model: "gpt-5" });
    // 引用统计按 id 部分匹配（覆盖名不影响 inUse 判定）
    expect(svc.modelUsage(llm.id)).toEqual(["gateway_llm"]);
    // 分类校验对覆盖名同样生效
    expect(() => svc.set("embedding_model", `${llm.id}:x`)).toThrow();
  });

  it("纯提供商条目（model 空）：绑定必须带覆盖模型名", () => {
    const prov = models.create({ category: "llm", name: "P", url: "http://p/v1", model: "" });
    // 无覆盖名 → 拒绝绑定（否则运行时拿不到模型名）
    expect(() => svc.set("gateway_llm", prov.id)).toThrow(/模型名/);
    expect(svc.getResolvedLlmConfig("gateway_llm")).toBeNull();
    // 带覆盖名 → 正常解析
    svc.set("gateway_llm", `${prov.id}:deepseek-chat`);
    expect(svc.getResolvedLlmConfig("gateway_llm")).toEqual({ baseUrl: "http://p/v1", apiKey: "", model: "deepseek-chat" });
  });

  it("parseModelBinding 三态", () => {
    expect(parseModelBinding("")).toEqual({ modelId: "", modelName: "" });
    expect(parseModelBinding("mdl_abc")).toEqual({ modelId: "mdl_abc", modelName: "" });
    expect(parseModelBinding("mdl_abc:gpt-4o")).toEqual({ modelId: "mdl_abc", modelName: "gpt-4o" });
  });
});
