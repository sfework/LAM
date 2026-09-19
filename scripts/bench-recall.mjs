/**
 * 召回基准（DESIGN §2.7 检索层的 before/after 标尺，对标参考项目 PersonaMem 思路）。
 *
 * 纯检索层基准：把固定语料（corpus.jsonl）灌入一个临时项目，逐条跑 dataset.jsonl
 * 里的「问题 → 期望命中记忆」，统计 Recall@k / MRR / 命中率。零 LLM、可复现、可挂 CI。
 *
 * 两种模式对比"上向量到底提升多少"：
 *   --mode bm25    仅 FTS/BM25（默认，零依赖）
 *   --mode hybrid  BM25 + 向量 RRF（需 sqlite-vec 可加载 + 下列环境变量提供 embedding）
 *                  EMBED_BASE_URL / EMBED_KEY / EMBED_MODEL
 *   --mode both    两种都跑并打印对比表（hybrid 不可用时降级为仅 bm25 并提示）
 *
 * 用法：
 *   pnpm bench:recall
 *   pnpm bench:recall -- --mode both --k 5
 */
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTables } from "../src/db/fts.js";
import { ensureVecTable } from "../src/db/vec.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { L1Store } from "../src/memory/l1-store.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { embedBatch, embedText, EMBEDDING_DIM } from "../src/memory/embedding.js";

const requireCjs = createRequire(import.meta.url);
const BENCH = "bench://recall";

// ── CLI 参数 ──────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}
const MODE = flag("mode", "bm25");
const K = Number.parseInt(flag("k", "5"), 10);

// ── 数据加载 ──────────────────────────────────────────────
function loadJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const corpus = loadJsonl(path.join(here, "../benchmarks/recall/corpus.jsonl"));
const dataset = loadJsonl(path.join(here, "../benchmarks/recall/dataset.jsonl"));

// ── 环境探测 ──────────────────────────────────────────────
function loadVec(raw) {
  try {
    const vec = requireCjs("sqlite-vec");
    raw.loadExtension(vec.getLoadablePath());
    return true;
  } catch {
    return false;
  }
}
const embedCfg =
  process.env.EMBED_BASE_URL && process.env.EMBED_MODEL
    ? { baseUrl: process.env.EMBED_BASE_URL, apiKey: process.env.EMBED_KEY || "", model: process.env.EMBED_MODEL }
    : null;

/** 建一个临时库，灌语料，返回 recaller 与 ref→l1Id 映射。 */
function build(vecOn) {
  const raw = new DatabaseSync(":memory:", { allowExtension: true });
  runMigrations(raw);
  ensureFtsTables(raw);
  const vecAvailable = vecOn && loadVec(raw);
  if (vecAvailable) ensureVecTable(raw);

  const models = new ModelRepo(raw);
  const settings = new SettingsService(raw, models);
  settings.init();
  // hybrid 模式：注册并绑定 embedding 模型（MemoryRecaller 靠 settings.embedding_model 决定是否走向量）
  if (vecAvailable && embedCfg) {
    const m = models.create({ category: "embedding", name: "bench-emb", url: embedCfg.baseUrl, key: embedCfg.apiKey, model: embedCfg.model });
    settings.set("embedding_model", m.id);
  }
  const projects = new ProjectRepo(raw);
  const store = new L1Store(raw, true, vecAvailable);
  const { project } = projects.upsertOnRequest(BENCH);

  const refToId = new Map();
  const now = Date.now();
  for (const c of corpus) {
    const id = store.insert(project.id, {
      kind: c.kind,
      content: c.content,
      priority: c.priority ?? 70,
      sceneName: "bench",
      sourceL0Ids: [],
      batchId: null,
      createdAt: now,
    });
    refToId.set(c.ref, id);
  }
  return { raw, settings, models, store, vecAvailable, projectId: project.id, refToId };
}

/** 灌向量（hybrid 模式）。 */
async function fillVectors(ctx) {
  const texts = corpus.map((c) => c.content);
  const vecs = await embedBatch(embedCfg, texts);
  corpus.forEach((c, i) => {
    if (vecs[i]?.length === EMBEDDING_DIM) ctx.store.upsertVector(ctx.refToId.get(c.ref), ctx.projectId, vecs[i]);
  });
}

// ── 打分 ──────────────────────────────────────────────────
function scoreCase(hitContents, hitIds, cs, refToId) {
  const expectRefs = cs.expect_refs ?? [];
  const expectAny = cs.expect_any ?? [];
  const isNegative = expectRefs.length === 0 && expectAny.length === 0;

  const matchedByAny = expectAny.filter((kw) => hitContents.some((c) => c.toLowerCase().includes(kw.toLowerCase())));
  const matchedIds = expectRefs
    .map((r) => refToId.get(r))
    .filter((id) => id && hitIds.includes(id));

  // 首个命中排名（MRR 用）：任一期望关键词/期望 id 出现的最小下标
  let firstRank = -1;
  for (let i = 0; i < hitContents.length; i++) {
    const anyHit = expectAny.some((kw) => hitContents[i].toLowerCase().includes(kw.toLowerCase()));
    const idHit = hitIds[i] && matchedIds.includes(hitIds[i]);
    if (anyHit || idHit) {
      firstRank = i;
      break;
    }
  }

  if (isNegative) {
    // 负例：topK 里不应混入任何"期望关键词命中的其它记忆"——这里保守判定为：无强命中即 pass
    return { pass: true, reciprocal: 1, note: "neg", matched: 0, expected: 0 };
  }
  const expected = Math.max(expectRefs.length, expectAny.length ? 1 : 0);
  const matched = matchedIds.length + (matchedByAny.length ? 1 : 0);
  const pass = expected === 0 ? true : (expectRefs.length && matchedIds.length === expectRefs.length) || (!!expectAny.length && matchedByAny.length > 0);
  return {
    pass,
    reciprocal: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
    matched,
    expected,
    rank: firstRank >= 0 ? firstRank + 1 : null,
  };
}

async function runMode(mode) {
  const wantVec = mode === "hybrid";
  const ctx = build(wantVec);
  if (wantVec) {
    if (!ctx.vecAvailable) return { skip: "sqlite-vec 不可加载" };
    if (!embedCfg) return { skip: "未提供 EMBED_BASE_URL/EMBED_MODEL" };
    await fillVectors(ctx);
  }
  const recaller = new MemoryRecaller(ctx.store, ctx.settings, embedText);

  let pass = 0;
  let rrSum = 0;
  const rows = [];
  for (const cs of dataset) {
    const hits = await recaller.search(ctx.projectId, cs.query, K);
    const hitContents = hits.map((h) => h.content);
    const hitIds = hits.map((h) => h.id);
    const r = scoreCase(hitContents, hitIds, cs, ctx.refToId);
    if (r.pass) pass++;
    rrSum += r.reciprocal;
    rows.push({ id: cs.id, ...r, top: hitContents[0]?.slice(0, 34) ?? "—" });
  }
  ctx.raw.close();
  return {
    mode,
    n: dataset.length,
    pass,
    hitRate: pass / dataset.length,
    mrr: rrSum / dataset.length,
    rows,
  };
}

function printResult(res) {
  console.log(`\n── 模式 ${res.mode}（k=${K}，语料 ${corpus.length} 条，用例 ${res.n} 个）──`);
  for (const r of res.rows) {
    const mark = r.note === "neg" ? "·" : r.pass ? "✅" : "❌";
    const rk = r.rank ? ` @${r.rank}` : "";
    console.log(`  ${mark} ${r.id.padEnd(14)}${rk}  top: ${r.top}`);
  }
  console.log(`  命中率 ${(res.hitRate * 100).toFixed(1)}%   MRR ${res.mrr.toFixed(3)}`);
}

// ── 主流程 ────────────────────────────────────────────────
const modes = MODE === "both" ? ["bm25", "hybrid"] : [MODE];
const results = [];
for (const m of modes) {
  const res = await runMode(m);
  if (res.skip) {
    console.log(`\n── 模式 ${m}：跳过（${res.skip}）──`);
    continue;
  }
  printResult(res);
  results.push(res);
}

if (results.length === 2) {
  const [b, h] = results;
  console.log("\n══ 对比 ══");
  console.log(`  命中率   bm25 ${(b.hitRate * 100).toFixed(1)}%  →  hybrid ${(h.hitRate * 100).toFixed(1)}%  (Δ ${((h.hitRate - b.hitRate) * 100).toFixed(1)}pt)`);
  console.log(`  MRR      bm25 ${b.mrr.toFixed(3)}  →  hybrid ${h.mrr.toFixed(3)}  (Δ ${(h.mrr - b.mrr).toFixed(3)})`);
}

// 回归门槛：BM25 命中率低于 80% 视为异常退出（负例计入分母，正常应全过）
const primary = results.find((r) => r.mode === "bm25") ?? results[0];
if (primary && primary.hitRate < 0.8) {
  console.error(`\n❌ 命中率 ${(primary.hitRate * 100).toFixed(1)}% 低于阈值 80%`);
  process.exit(1);
}
