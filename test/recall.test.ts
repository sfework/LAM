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

const mk = (content: string, kind: "fact" | "persona" = "fact", priority = 80) => ({
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
    ctx.store.insert(ctx.projectId, mk("用户偏好使用 pnpm 管理依赖", "persona", 90));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block, count } = await recaller.recall(ctx.projectId, "我该怎么管理依赖？pnpm 还是 npm");
    expect(count).toBe(1);
    expect(block).toContain("<recalled>");
    expect(block).toContain("仅用于辅助回答当前这一轮");
    expect(block).toContain("[persona");
    expect(block).toContain("pnpm");
  });

  it("l1_recall_enabled=false 关闭召回", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("记忆"));
    ctx.settings.set("l1_recall_enabled", "false");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, "记忆")).count).toBe(0);
  });

  it("无命中返回空块", async () => {
    const ctx = fresh(false);
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, "完全无关的问题 xyz")).block).toBe("");
  });

  it("检索词清洗后为空则跳过", async () => {
    const ctx = fresh(false);
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, "<project>path: x</project>")).count).toBe(0);
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
    const { block } = await recaller.recall(ctx.projectId, "查询内容");
    expect(block).toBe("");
  });

  it("字符上限截断召回块", async () => {
    const ctx = fresh(false);
    for (let i = 0; i < 5; i++) ctx.store.insert(ctx.projectId, mk(`记忆条目编号 ${i} 内容较长`));
    ctx.settings.set("l1_recall_max_chars", "80");
    ctx.settings.set("l1_recall_top_k", "5");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block } = await recaller.recall(ctx.projectId, "记忆 条目 编号");
    expect(block).toContain("已截断");
  });

  it("纯寒暄输入（好的）经停用词短路，不产生召回", async () => {
    const ctx = fresh(false);
    // 库中存在含"好的"的记忆，若不短路则 BM25 会命中并注入噪音
    ctx.store.insert(ctx.projectId, mk("用户说好的表示同意"));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    expect((await recaller.recall(ctx.projectId, "好的")).count).toBe(0);
    expect((await recaller.recall(ctx.projectId, "好的")).block).toBe("");
  });

  it("含实义词的指令（按此执行）不被停用词误杀", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("执行部署脚本前先跑测试"));
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    // "执行"为实义 bigram，应正常检索命中
    expect((await recaller.recall(ctx.projectId, "按此执行")).count).toBeGreaterThan(0);
  });

  it("单条超 per-item 上限时逐条截断保留头部", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("记忆甲" + "长".repeat(300)));
    ctx.settings.set("l1_recall_max_chars_per_item", "50");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block } = await recaller.recall(ctx.projectId, "记忆甲");
    const itemLine = block.split("\n").find((l) => l.includes("记忆甲"));
    expect(itemLine).toBeDefined();
    expect([...(itemLine ?? "")].length).toBeLessThanOrEqual(50);
    expect(itemLine).toContain("…");
  });

  it("总预算剩余足够时截半条塞入而非整条丢弃", async () => {
    const ctx = fresh(false);
    ctx.store.insert(ctx.projectId, mk("编号零 内容", "fact", 90));
    ctx.store.insert(ctx.projectId, mk("编号一 内容较长" + "字".repeat(100)));
    ctx.settings.set("l1_recall_max_chars_per_item", "0"); // 只考察总预算
    // 预算：头部两行 + 第一条 + 第二条放不下整行但够半条（≥40）
    ctx.settings.set("l1_recall_max_chars", "180");
    const recaller = new MemoryRecaller(ctx.store, ctx.settings);
    const { block } = await recaller.recall(ctx.projectId, "编号 内容");
    expect(block).toContain("已截断");
    // 第二条以截断形式部分出现（含"编号一"头部），而非直接消失
    expect(block).toContain("编号一");
  });
});
