import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/migrate.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
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
      "projects", "prompts", "agents", "skills", "knowledge", "denoise_rules",
      "models", "settings", "mem_l0", "mem_l1", "mem_l2", "extract_queue",
      "pipeline_state", "sessions", "cg_status",
    ]) {
      expect(names, `缺表 ${t}`).toContain(t);
    }
    // 决策 67：图数据外置到 {DATA_DIR}/codegraph/<项目>/codegraph.db，旧 cg_* 明细表已全部删除
    for (const gone of ["cg_files", "cg_symbols", "cg_edges", "cg_calls", "cg_extends", "cg_imports", "cg_bindings"]) {
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
    expect(parseSettingValue(getSettingDef("l1_warmup_enabled")!, "false")).toBe(false);
    expect(parseSettingValue(getSettingDef("memory_similarity_threshold")!, "0.9")).toBeCloseTo(0.9);
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
    expect(svc.getInt("l1_recall_top_k")).toBe(5);
    expect(svc.getBool("l1_recall_enabled")).toBe(true);
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
    expect(() => svc.set("l1_recall_enabled", "yes")).toThrow();
  });

  it("变更订阅回调", () => {
    const seen: number[] = [];
    const off = svc.subscribe("l1_recall_top_k", (v) => seen.push(v as number));
    svc.set("l1_recall_top_k", "6");
    svc.set("l1_recall_top_k", "7");
    off();
    svc.set("l1_recall_top_k", "8");
    expect(seen).toEqual([6, 7]);
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
});
