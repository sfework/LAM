import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTables } from "../src/db/fts.js";
import { ensureVecTable } from "../src/db/vec.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { L1Store } from "../src/memory/l1-store.js";
import type { L1Kind } from "../src/memory/prompts.js";
import { MemoryRecaller, cleanQueryText, prependRecall } from "../src/memory/recall.js";
import { EmbeddingBackfiller } from "../src/memory/embed-backfill.js";
import { rrfMerge } from "../src/memory/rrf.js";
import { EMBEDDING_DIM } from "../src/memory/embedding.js";

const requireCjs = createRequire(import.meta.url);

function loadVec(raw: DatabaseSync): boolean {
  try {
    const vec = requireCjs("sqlite-vec");
    raw.loadExtension(vec.getLoadablePath());
    return true;
  } catch {
    return false;
  }
}

// 模块级探测：本环境能否加载 sqlite-vec（决定向量用例是否运行）
const VEC_OK = (() => {
  const probe = new DatabaseSync(":memory:", { allowExtension: true });
  const ok = loadVec(probe);
  probe.close();
  return ok;
})();

function fresh(vecOn = true) {
  const raw = new DatabaseSync(":memory:", { allowExtension: true });
  runMigrations(raw);
  ensureFtsTables(raw);
  const vecAvailable = vecOn && loadVec(raw);
  if (vecAvailable) ensureVecTable(raw);
  const models = new ModelRepo(raw);
  const settings = new SettingsService(raw, models);
  settings.init();
  const projects = new ProjectRepo(raw);
  const store = new L1Store(raw, true, vecAvailable);
  const { project } = projects.upsertOnRequest("d:/work/p");
  return { raw, settings, models, store, projectId: project.id, vecAvailable };
}

const mk = (content: string, kind: L1Kind = "fact", priority = 80) => ({
  kind,
  content,
  priority,
  sceneName: "s",
  sourceL0Ids: [],
  batchId: null,
  createdAt: Date.now(),
});

describe("cleanQueryText", () => {
  it("剥离注入标签与环境噪音块", () => {
    const q = cleanQueryText(
      "真实问题<project>path: e:/p</project>\n<workspace_info>\n- e:\\x\n</workspace_info><environment_info>os</environment_info>",
    );
    expect(q).toBe("真实问题");
  });
  it("截断 2048", () => {
    expect(cleanQueryText("a".repeat(3000)).length).toBe(2048);
  });
});

describe("prependRecall", () => {
  it("拼到最后一条 user 之前", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一问" },
      { role: "assistant", content: "答" },
      { role: "user", content: "第二问" },
    ];
    const out = prependRecall(msgs, "RECALL");
    expect(out[1]!.content).toBe("第一问"); // 首条 user 不动
    expect(out[3]!.content).toBe("RECALL\n\n第二问"); // 最后一条 user 前缀
    expect(msgs[3]!.content).toBe("第二问"); // 不改入参
  });
  it("空块原样返回", () => {
    const msgs = [{ role: "user", content: "x" }];
    expect(prependRecall(msgs, "")).toEqual(msgs);
  });
});

describe("rrfMerge", () => {
  it("两榜并集，共现项得分更高", () => {
    const a = [{ id: "1" }, { id: "2" }];
    const b = [{ id: "2" }, { id: "3" }];
    const merged = rrfMerge([a, b], (x) => x.id);
    expect(merged[0]!.item.id).toBe("2"); // 两榜都出现 → 最高
    expect(merged).toHaveLength(3);
  });
});

describe.skipIf(!VEC_OK)("L1Store 向量检索（sqlite-vec）", () => {
  let ctx: ReturnType<typeof fresh>;
  beforeEach(() => {
    ctx = fresh(true);
  });

  const unit = (dims: number[]) => {
    const v = new Float32Array(EMBEDDING_DIM);
    dims.forEach((d, i) => (v[i] = d));
    return v;
  };

  it("upsert + searchVector kNN 按项目隔离", () => {
    const id1 = ctx.store.insert(ctx.projectId, mk("a"));
    const id2 = ctx.store.insert(ctx.projectId, mk("b"));
    ctx.store.upsertVector(id1, ctx.projectId, unit([1, 0, 0]));
    ctx.store.upsertVector(id2, ctx.projectId, unit([0, 1, 0]));
    const hits = ctx.store.searchVector(ctx.projectId, unit([1, 0, 0]), 2);
    expect(hits[0]!.id).toBe(id1); // 最近
    expect(hits[0]!.distance).toBeCloseTo(0, 3);
  });

  it("searchHybrid：向量命中即使 FTS 不中也并入", () => {
    const id1 = ctx.store.insert(ctx.projectId, mk("alpha beta"));
    ctx.store.upsertVector(id1, ctx.projectId, unit([1, 0, 0]));
    // FTS 查 gamma 不中，但向量查 [1,0,0] 命中
    const hits = ctx.store.searchHybrid(ctx.projectId, "gamma", unit([1, 0, 0]), 5);
    expect(hits.some((h) => h.record.id === id1)).toBe(true);
  });

  it("listActiveMissingEmbedding 返回未建向量的", () => {
    const id1 = ctx.store.insert(ctx.projectId, mk("x y"));
    const id2 = ctx.store.insert(ctx.projectId, mk("z w"));
    ctx.store.upsertVector(id1, ctx.projectId, unit([1]));
    const missing = ctx.store.listActiveMissingEmbedding(ctx.projectId, 10);
    expect(missing.map((m) => m.id)).toEqual([id2]);
  });
});

describe.skipIf(!VEC_OK)("EmbeddingBackfiller", () => {
  it("批量补嵌入后可向量检索", async () => {
    const ctx = fresh(true);
    const em = ctx.models.create({ category: "embedding", name: "e", url: "http://fake", key: "", model: "em" });
    ctx.settings.set("embedding_model", em.id);
    ctx.store.insert(ctx.projectId, mk("内容一"));
    ctx.store.insert(ctx.projectId, mk("内容二"));
    const backfiller = new EmbeddingBackfiller(ctx.store, ctx.settings, async (_cfg, texts) =>
      texts.map(() => new Float32Array(EMBEDDING_DIM).fill(0.5)),
    );
    const n = await backfiller.backfillProject(ctx.projectId);
    expect(n).toBe(2);
    expect(ctx.store.listActiveMissingEmbedding(ctx.projectId, 10)).toHaveLength(0);
  });

  it("未配置 embedding_model 时 no-op", async () => {
    const ctx = fresh(true);
    ctx.store.insert(ctx.projectId, mk("x"));
    const backfiller = new EmbeddingBackfiller(ctx.store, ctx.settings, async () => []);
    expect(await backfiller.backfillProject(ctx.projectId)).toBe(0);
  });
});

describe("MemoryRecaller", () => {
  it("BM25 命中渲染 <recalled> 块", async () => {
    const ctx = fresh(false);
    const id = ctx.store.insert(ctx.projectId, mk("用户偏好使用 pnpm 管理依赖", "persona", 90));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block, count } = await recaller.recall(ctx.projectId, ["我该怎么管理依赖？pnpm 还是 npm"]);
    expect(count).toBe(1);
    expect(block).toContain("<recalled>");
    expect(block).toContain("仅用于辅助回答当前这一轮");
    // 决策 90：行首方括号内带全量记忆 id（批量工具入参），格式 [id:xxx,type:xxx,score:x.xxx]
    expect(block).toContain(`[id:${id},type:persona,score:`);
    expect(block).toContain("pnpm");    // 决策 88：块尾自维护提示——只授权改/删本轮条目，新增仍走提取管线
    expect(block).toContain("memory_batch_update");
    expect(block).toContain("不要新增记忆");
    expect(block).toContain("记忆 id"); // 决策 90：提示中点明方括号内首项即 id
  });

  it("l1_recall_top_k 限制注入条数上限", async () => {
    const ctx = fresh(false);
    for (let i = 0; i < 5; i++) ctx.store.insert(ctx.projectId, mk(`记忆 编号 ${i} 内容`));
    ctx.settings.set("l1_recall_top_k", "2");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, ["记忆 编号"])).count).toBeLessThanOrEqual(2);
  });

  it("instruction 类记忆不参与注入召回（决策 79），memory_search 通道仍可命中", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, { kind: "instruction", content: "要求使用 pnpm 管理依赖", priority: 90, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() });
    ctx.store.insert(ctx.projectId, mk("项目采用 pnpm workspace 管理依赖", "fact", 80));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { items } = await recaller.recall(ctx.projectId, ["pnpm 依赖 管理"]);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind !== "instruction")).toBe(true);
    // 显式检索（MCP memory_search 走的 search()）不受排除影响
    const hits = await recaller.search(ctx.projectId, "pnpm 依赖", 5);
    expect(hits.some((h) => h.kind === "instruction")).toBe(true);
  });

  it.skipIf(!VEC_OK)("纯 BM25 低分尾部被门槛滤除，双源命中保留（决策 79）", async () => {
    const ctx = fresh(true);
    if (!ctx.vecAvailable) return;
    const em = ctx.models.create({ category: "embedding", name: "e", url: "http://fake", key: "", model: "em" });
    ctx.settings.set("embedding_model", em.id);
    ctx.settings.set("l1_recall_top_k", "2");
    // 4 条都含"记忆 条目"（FTS 全命中）；仅甲/乙建向量且与查询向量同向（vec 确认 → both）
    const idA = ctx.store.insert(ctx.projectId, mk("记忆 条目 甲 主题", "fact", 90));
    const idB = ctx.store.insert(ctx.projectId, mk("记忆 条目 乙 主题", "method", 85));
    ctx.store.insert(ctx.projectId, mk("记忆 条目 丙 杂项", "fact", 60));
    ctx.store.insert(ctx.projectId, mk("记忆 条目 丁 杂项", "fact", 55));
    const unit = (i: number) => {
      const v = new Float32Array(EMBEDDING_DIM);
      v[i] = 1;
      return v;
    };
    ctx.store.upsertVector(idA, ctx.projectId, unit(0));
    ctx.store.upsertVector(idB, ctx.projectId, unit(0));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings, async () => unit(0));
    const { items } = await recaller.recall(ctx.projectId, ["记忆 条目"]);
    // 榜首为双源命中，bm25-only 的丙/丁分数远低于榜首×0.4 被滤除
    expect(items.map((i) => i.id).sort()).toEqual([idA, idB].sort());
    expect(items.every((i) => i.source !== "bm25")).toBe(true);
  });

  it("小文档集豁免：候选数 ≤ topK 时不启用 BM25 门槛（决策 79）", async () => {
    const ctx = fresh(false);
    // 向量不可用 → source 恒为 bm25；候选仅 1 条，低于任何"榜首×0.4"也应保留
    ctx.store.insert(ctx.projectId, mk("唯一的 pnpm 依赖记忆", "fact", 70));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { items } = await recaller.recall(ctx.projectId, ["pnpm 依赖 记忆"]);
    expect(items).toHaveLength(1);
  });

  it("无命中返回空块", async () => {
    const ctx = fresh(false);
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, ["完全无关的问题 xyz"])).block).toBe("");
  });

  it("检索词清洗后为空则跳过", async () => {
    const ctx = fresh(false);
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, ["<project>path: x</project>"])).count).toBe(0);
  });

  it("超时降级为空召回", async () => {
    const ctx = fresh(true);
    if (!ctx.vecAvailable) return;
    ctx.store.insert(ctx.projectId, mk("x"));
    const models = ctx.models;
    const m = models.create({ category: "embedding", name: "e", url: "http://fake", key: "", model: "em" });
    ctx.settings.set("embedding_model", m.id);
    ctx.settings.set("recall_timeout_ms", "500");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings, async () => {
      await new Promise((r) => setTimeout(r, 1500)); // 慢于超时
      return new Float32Array(EMBEDDING_DIM);
    });
    const { block } = await recaller.recall(ctx.projectId, ["查询内容"]);
    expect(block).toBe("");
  });

  it("召回块不再做字符预算截断（决策：取消 l1_recall_max_chars*）", async () => {
    const ctx = fresh(false);
    for (let i = 0; i < 5; i++) ctx.store.insert(ctx.projectId, mk(`记忆条目编号 ${i} 内容较长`));
    ctx.settings.set("l1_recall_top_k", "5");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block, count } = await recaller.recall(ctx.projectId, ["记忆 条目 编号"]);
    expect(count).toBe(5);
    expect(block).not.toContain("已截断");
    // 每条完整正文原样渲染
    for (let i = 0; i < 5; i++) expect(block).toContain(`记忆条目编号 ${i} 内容较长`);
  });

  it("纯寒暄输入（好的）经停用词短路，不产生召回", async () => {
    const ctx = fresh(false);
    // 库中存在含"好的"的记忆，若不短路则 BM25 会命中并注入噪音
    ctx.store.insert(ctx.projectId, mk("用户说好的表示同意"));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, ["好的"])).count).toBe(0);
    expect((await recaller.recall(ctx.projectId, ["好的"])).block).toBe("");
  });

  it("含实义词的指令（按此执行）不被停用词误杀", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("执行部署脚本前先跑测试"));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    // "执行"为实义 bigram，应正常检索命中
    expect((await recaller.recall(ctx.projectId, ["按此执行"])).count).toBeGreaterThan(0);
  });

  it("单条超长正文也完整渲染（per-item 截断已取消）", async () => {
    const ctx = fresh(false);
    const long = "记忆甲" + "长".repeat(300);
    ctx.store.insert(ctx.projectId, mk(long));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block } = await recaller.recall(ctx.projectId, ["记忆甲"]);
    expect(block).toContain(long);
    expect(block).not.toContain("…");
  });

  it("多条 user 消息拼接检索：短追问靠上文命中", async () => {
    const ctx = fresh(false);
    // 记忆主题词只出现在上文（第一轮），本轮是省略主语的短追问
    ctx.store.insert(ctx.projectId, mk("CodeGraph 索引必须外置于 DATA_DIR 目录", "fact", 90));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    // 仅本轮短词：召回不到
    expect((await recaller.recall(ctx.projectId, ["那方案呢"])).count).toBe(0);
    // 带上文：拼接后命中
    const { count } = await recaller.recall(ctx.projectId, ["CodeGraph 索引外置方案讨论", "那方案呢"]);
    expect(count).toBeGreaterThan(0);
  });

  it("本轮为寒暄时短路，不因上文有话题而刷新召回", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("用户偏好使用 pnpm 管理依赖", "persona", 90));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { count } = await recaller.recall(ctx.projectId, ["pnpm 依赖怎么管理", "好的"]);
    expect(count).toBe(0);
  });

  it("召回缓存：同项目同检索词第二次命中缓存（不重复检索，块字节一致）", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("用户偏好使用 pnpm 管理依赖", "persona", 90));
    let embedCalls = 0;
    const recaller = new MemoryRecaller(ctx.store, ctx.settings, async () => {
      embedCalls++;
      return new Float32Array(EMBEDDING_DIM);
    });
    const r1 = await recaller.recall(ctx.projectId, ["依赖管理用什么工具"]);
    expect(r1.count).toBe(1);
    expect(embedCalls).toBe(1);
    const r2 = await recaller.recall(ctx.projectId, ["依赖管理用什么工具"]);
    // 缓存命中：不再调 embedding，且注入块逐字节一致（利上游 KV cache）
    expect(embedCalls).toBe(1);
    expect(r2.block).toBe(r1.block);
    // 不同检索词不命中缓存
    await recaller.recall(ctx.projectId, ["另一个完全不同的问题 abc"]);
    expect(embedCalls).toBe(2);
  });

  it("审计字段：items 携带 score 与 source", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("用户偏好使用 pnpm 管理依赖", "persona", 90));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { items } = await recaller.recall(ctx.projectId, ["pnpm 依赖管理"]);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ kind: "persona", source: "bm25" });
    expect(typeof items[0]!.score).toBe("number");
  });
});

describe.skipIf(!VEC_OK)("召回软重排（决策 78）", () => {
  const unit = (dims: number[]) => {
    const v = new Float32Array(EMBEDDING_DIM);
    dims.forEach((d, i) => (v[i] = d));
    return v;
  };

  it("searchHybrid 标注 source：双源=both / 仅向量=vec / 仅词面=bm25", () => {
    const ctx = fresh(true);
    if (!ctx.vecAvailable) return;
    const both = ctx.store.insert(ctx.projectId, mk("alpha beta 双源命中"));
    const vecOnly = ctx.store.insert(ctx.projectId, mk("gamma 仅向量"));
    ctx.store.upsertVector(both, ctx.projectId, unit([1, 0, 0]));
    ctx.store.upsertVector(vecOnly, ctx.projectId, unit([1, 0, 0]));
    const hits = ctx.store.searchHybrid(ctx.projectId, "alpha beta", unit([1, 0, 0]), 5);
    const byId = new Map(hits.map((h) => [h.record.id, h.source]));
    expect(byId.get(both)).toBe("both"); // FTS + 向量都中
    expect(byId.get(vecOnly)).toBe("vec"); // FTS 不中 gamma
  });

  it("软重排：双源命中的 episodic 排在纯词面 episodic 之前（不硬删）", async () => {
    const ctx = fresh(true);
    if (!ctx.vecAvailable) return;
    const em = ctx.models.create({ category: "embedding", name: "e", url: "http://fake", key: "", model: "em" });
    ctx.settings.set("embedding_model", em.id);
    // 两条 episodic 都含词面"部署"，但只有前者有向量确认
    const strong = ctx.store.insert(ctx.projectId, mk("用户于上周完成部署流程改造", "episodic", 90));
    const weak = ctx.store.insert(ctx.projectId, mk("用户提到过部署这个词", "episodic", 90));
    ctx.store.upsertVector(strong, ctx.projectId, unit([1, 0, 0]));
    ctx.store.upsertVector(weak, ctx.projectId, unit([0, 0, 1])); // 与查询向量远
    const recaller = new MemoryRecaller(ctx.store, ctx.settings, async (_cfg, text) =>
      text.includes("部署") ? unit([1, 0, 0]) : unit([0, 1, 0]),
    );
    const { items } = await recaller.recall(ctx.projectId, ["部署流程现在什么样"]);
    expect(items.length).toBe(2); // 软重排不减候选
    expect(items[0]!.id).toBe(strong); // 双源确认者居前
    expect(items[0]!.source).toBe("both");
    expect(items[1]!.source).toBe("bm25");
  });
});
