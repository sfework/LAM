import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTable } from "../src/db/fts.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { ConversationRecorder } from "../src/memory/conversation-recorder.js";
import { MemoryExtractor, type LlmCall } from "../src/memory/extractor.js";
import { ProfileRefiner, collectRemovedTopics } from "../src/memory/profile-refiner.js";
import { ExtractionScheduler } from "../src/memory/scheduler.js";
import { EmbeddingBackfiller } from "../src/memory/embed-backfill.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { SessionRepo } from "../src/gateway/sessions.js";
import { newId } from "../src/infra/id.js";

let dir: string;
let db: DatabaseSync;
let settings: SettingsService;
let memories: MemoryRepo;
let projects: ProjectRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-pipe-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  ensureFtsTable(db);
  projects = new ProjectRepo(db);
  memories = new MemoryRepo(db, true, false);
  const models = new ModelRepo(db);
  settings = new SettingsService(db, models);
  settings.init();
  models.create({ category: "llm", name: "M", url: "https://m.local/v1", model: "m-1" });
  const m = models.list("llm")[0]!;
  settings.set("memory_llm", m.id);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const llmCfg = { baseUrl: "https://m.local/v1", apiKey: "", model: "m-1" };

function seedConversation(projectId: string, sessionKey: string, role: "user" | "assistant", content: string): string {
  const maxRow = db.prepare("SELECT COALESCE(MAX(turn_seq), -1) AS m FROM conversations WHERE project_id = ? AND session_key = ?").get(projectId, sessionKey) as { m: number };
  const id = newId("conv");
  db.prepare("INSERT INTO conversations (id, project_id, session_key, turn_seq, role, content, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,NULL)")
    .run(id, projectId, sessionKey, maxRow.m + 1, role, content, Date.now());
  return id;
}

describe("MemoryExtractor", () => {
  it("两阶段：提取 + 冲突检测 store 落库", async () => {
    const p = projects.upsertOnRequest("E:/Code/Ex").project;
    const c1 = seedConversation(p.id, "s", "user", "我们用 Hono 做网关");
    const c2 = seedConversation(p.id, "s", "user", "端口定 8790");

    const llm: LlmCall = async (_cfg, msgs) => {
      const prompt = msgs[1]!.content;
      if (prompt.includes("待提取的新消息")) {
        return JSON.stringify([
          { scene_name: "NLAM 网关开发", memories: [
            { content: "网关使用 Hono 框架", type: "fact", priority: 85, source_message_ids: [c1], metadata: {} },
            { content: "服务端口是 8790", type: "fact", priority: 75, source_message_ids: [c2], metadata: {} },
          ] },
        ]);
      }
      // 冲突检测：第二条与第一条无关 → store；模拟对第一条 skip
      return JSON.stringify([
        { record_id: "x1", action: "store", target_ids: [] },
      ]);
    };
    const ex = new MemoryExtractor(db, memories, settings, llm);
    const res = await ex.extract(p.id, [c1, c2], llmCfg, "s");
    expect(res.stored).toBe(2);
    expect(memories.listActive(p.id)).toHaveLength(2);
  });

  it("低优先级条目被丢弃", async () => {
    const p = projects.upsertOnRequest("E:/Code/Ex2").project;
    const c1 = seedConversation(p.id, "s", "user", "今天天气不错");
    const llm: LlmCall = async () => JSON.stringify([
      { scene_name: "闲聊", memories: [{ content: "用户提到天气", type: "episodic", priority: 30, source_message_ids: [c1], metadata: {} }] },
    ]);
    const ex = new MemoryExtractor(db, memories, settings, llm);
    const res = await ex.extract(p.id, [c1], llmCfg);
    expect(res.extracted).toBe(0);
    expect(memories.listActive(p.id)).toHaveLength(0);
  });

  it("提取失败抛错（调度器保留缓冲重试）", async () => {
    const p = projects.upsertOnRequest("E:/Code/Ex3").project;
    const c1 = seedConversation(p.id, "s", "user", "hi");
    const llm: LlmCall = async () => "not json at all";
    const ex = new MemoryExtractor(db, memories, settings, llm);
    await expect(ex.extract(p.id, [c1], llmCfg)).rejects.toThrow(/提取阶段失败/);
  });
});

describe("ProfileRefiner", () => {
  it("首次全量凝练写 version=1；无变化不涨版本", async () => {
    const p = projects.upsertOnRequest("E:/Code/Pf").project;
    memories.insert(p.id, { kind: "fact", content: "项目是本地记忆网关", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });

    let out = "# 项目画像\n\n> 本地记忆网关";
    const llm: LlmCall = async () => out;
    const refiner = new ProfileRefiner(db, memories, settings, llm);

    const r1 = await refiner.refine(p.id, llmCfg, "full");
    expect(r1).toEqual({ status: "stored", version: 1 });

    out = "# 项目画像\n\n> 本地记忆网关"; // 相同内容 → unchanged
    const r2 = await refiner.refine(p.id, llmCfg, "full");
    expect(r2.status).toBe("unchanged");

    out = "```markdown\n# 项目画像\n\n> 更新版\n```"; // 带围栏
    const r3 = await refiner.refine(p.id, llmCfg, "full");
    expect(r3.status).toBe("stored");
    expect(db.prepare("SELECT content FROM profiles WHERE project_id = ?").get(p.id)).toBeTruthy();
  });

  it("增量模式无新记忆时跳过（零 LLM 成本）", async () => {
    const p = projects.upsertOnRequest("E:/Code/Pf2").project;
    const t0 = Date.now();
    memories.insert(p.id, { kind: "fact", content: "旧记忆", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: t0 });
    let called = false;
    const llm: LlmCall = async () => { called = true; return "# x"; };
    const refiner = new ProfileRefiner(db, memories, settings, llm);
    // 先建画像，水位设为现在
    await refiner.refine(p.id, llmCfg, "full");
    called = false;
    const res = await refiner.refine(p.id, llmCfg, "incremental", Date.now() + 60_000);
    expect(res.status).toBe("skipped");
    expect(called).toBe(false);
  });

  it("collectRemovedTopics 识别移除线索", () => {
    const topics = collectRemovedTopics(["已移除 CodeGraph 功能", "端口保持 8790 不变", "X 改为 Y 方案"]);
    expect(topics.some((t) => t.includes("CodeGraph"))).toBe(true);
    expect(topics.some((t) => t.includes("改为"))).toBe(true);
    expect(topics.some((t) => t.includes("端口"))).toBe(false);
  });
});

describe("ExtractionScheduler", () => {
  function seedPipeline(projectId: string, ids: string[], userCount: number): void {
    db.prepare("INSERT INTO pipeline_states (id, project_id, session_key, user_msg_count, buffered_message_ids) VALUES (?,?,?,?,?)")
      .run(newId("ps"), projectId, "s", userCount, JSON.stringify(ids));
  }

  it("阈值未达不触发；达标触发提取并清理缓冲", async () => {
    const p = projects.upsertOnRequest("E:/Code/Sc").project;
    const c1 = seedConversation(p.id, "s", "user", "用 Hono");
    seedPipeline(p.id, [c1], 1);

    const llm: LlmCall = async (_c, msgs) =>
      msgs[1]!.content.includes("待提取的新消息")
        ? JSON.stringify([{ scene_name: "开发", memories: [{ content: "网关用 Hono", type: "fact", priority: 90, source_message_ids: [c1], metadata: {} }] }])
        : JSON.stringify([]);
    const ex = new MemoryExtractor(db, memories, settings, llm);
    const refiner = new ProfileRefiner(db, memories, settings, llm);
    const sched = new ExtractionScheduler(db, settings, ex, refiner);

    // 阈值默认 3，1 条不触发
    expect(await sched.tick()).toBe(0);

    // 补到阈值
    db.prepare("UPDATE pipeline_states SET user_msg_count = 3 WHERE project_id = ?").run(p.id);
    expect(await sched.tick()).toBe(1);
    // 等串行链完成
    await sched.stop();
    expect(memories.listActive(p.id)).toHaveLength(1);
    const ps = db.prepare("SELECT buffered_message_ids, user_msg_count FROM pipeline_states WHERE project_id = ?").get(p.id) as { buffered_message_ids: string; user_msg_count: number };
    expect(ps.buffered_message_ids).toBe("[]");
    expect(ps.user_msg_count).toBe(0);
  });

  it("提取失败时缓冲保留（下轮重试）", async () => {
    const p = projects.upsertOnRequest("E:/Code/Sc2").project;
    const c1 = seedConversation(p.id, "s", "user", "hi");
    seedPipeline(p.id, [c1], 3);

    let fail = true;
    const llm: LlmCall = async () => {
      if (fail) return "garbage";
      return JSON.stringify([{ scene_name: "n", memories: [{ content: "恢复后的记忆", type: "fact", priority: 90, source_message_ids: [c1], metadata: {} }] }]);
    };
    const ex = new MemoryExtractor(db, memories, settings, llm);
    const refiner = new ProfileRefiner(db, memories, settings, llm);
    const sched = new ExtractionScheduler(db, settings, ex, refiner);

    await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    let ps = db.prepare("SELECT buffered_message_ids FROM pipeline_states WHERE project_id = ?").get(p.id) as { buffered_message_ids: string };
    expect(JSON.parse(ps.buffered_message_ids)).toEqual([c1]); // 缓冲保留

    fail = false;
    await sched.tick();
    await sched.stop();
    expect(memories.listActive(p.id).map((m) => m.content)).toContain("恢复后的记忆");
  });

  it("stop 时 flush 未达阈值的缓冲", async () => {
    const p = projects.upsertOnRequest("E:/Code/Sc3").project;
    const c1 = seedConversation(p.id, "s", "user", "shutdown flush");
    seedPipeline(p.id, [c1], 1);
    const llm: LlmCall = async (_c, msgs) =>
      msgs[1]!.content.includes("待提取的新消息")
        ? JSON.stringify([{ scene_name: "n", memories: [{ content: "flush 记忆", type: "fact", priority: 90, source_message_ids: [c1], metadata: {} }] }])
        : JSON.stringify([]);
    const sched = new ExtractionScheduler(db, settings, new MemoryExtractor(db, memories, settings, llm), new ProfileRefiner(db, memories, settings, llm));
    await sched.stop();
    expect(memories.listActive(p.id).map((m) => m.content)).toContain("flush 记忆");
  });
});

describe("画像更新门控", () => {
  function seedPipelineRow(projectId: string): void {
    db.prepare("INSERT INTO pipeline_states (id, project_id, session_key, user_msg_count, buffered_message_ids) VALUES (?,?,?,?,?)")
      .run(newId("ps"), projectId, "s", 0, "[]");
  }

  /** 门控/凝练分流 mock：按 system 提示词区分两类调用，记录各自次数。 */
  function makeGateLlm(gateLabel: string) {
    const calls = { gate: 0, refine: 0 };
    const llm: LlmCall = async (_c, msgs) => {
      const sys = msgs[0]!.content;
      if (sys.includes("画像更新门控分类器")) { calls.gate++; return gateLabel; }
      if (sys.includes("项目画像架构师")) { calls.refine++; return "# 画像 v2"; }
      return JSON.stringify([]);
    };
    return { llm, calls };
  }

  /** 造「已有画像 + 新记忆 + 冷却期满」的触发态。 */
  async function primeProfileTrigger(projectPath: string) {
    const p = projects.upsertOnRequest(projectPath).project;
    memories.insert(p.id, { kind: "fact", content: "网关端口改为 8791", priority: 90, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });
    const refiner0 = new ProfileRefiner(db, memories, settings, async () => "# 初始画像");
    await refiner0.refine(p.id, llmCfg, "full"); // 先建画像，门控才有对比基准
    // pipeline 行后置创建：水位设为过去 + 零冷却 → tick 即触发画像评估
    seedPipelineRow(p.id);
    db.prepare("UPDATE pipeline_states SET last_profile_at = ? WHERE project_id = ?").run(Date.now() - 10_000, p.id);
    settings.set("profile_delay_seconds", "0");
    return p;
  }

  it("门控判定 reinforcement → 跳过凝练；同批记忆不重复调门控", async () => {
    const p = await primeProfileTrigger("E:/Code/Gt1");
    const { llm, calls } = makeGateLlm("reinforcement");
    const sched = new ExtractionScheduler(db, settings, new MemoryExtractor(db, memories, settings, llm), new ProfileRefiner(db, memories, settings, llm));

    await sched.tick();
    expect(calls.gate).toBe(1);
    expect(calls.refine).toBe(0);
    const gs = db.prepare("SELECT skip_streak, gated_memory_ts FROM profile_gate_states WHERE project_id = ?").get(p.id) as { skip_streak: number; gated_memory_ts: number };
    expect(gs.skip_streak).toBe(1);
    expect(gs.gated_memory_ts).toBeGreaterThan(0);

    // 再 tick：同批（无新记忆）不应重复调门控
    await sched.tick();
    expect(calls.gate).toBe(1);
    expect(calls.refine).toBe(0);
  });

  it("门控判定 conflict → 立即凝练并清零计数", async () => {
    const p = await primeProfileTrigger("E:/Code/Gt2");
    const { llm, calls } = makeGateLlm("conflict");
    const sched = new ExtractionScheduler(db, settings, new MemoryExtractor(db, memories, settings, llm), new ProfileRefiner(db, memories, settings, llm));

    await sched.tick();
    await new Promise((r) => setTimeout(r, 50)); // 等串行链完成
    expect(calls.gate).toBe(1);
    expect(calls.refine).toBe(1);
    const gs = db.prepare("SELECT skip_streak FROM profile_gate_states WHERE project_id = ?").get(p.id) as { skip_streak: number };
    expect(gs.skip_streak).toBe(0);
  });

  it("连续跳过达上限 → 兜底强制凝练（不再调门控）", async () => {
    const p = await primeProfileTrigger("E:/Code/Gt3");
    settings.set("profile_gate_max_skip_streak", "2");
    db.prepare("INSERT INTO profile_gate_states (project_id, skip_streak, gated_memory_ts, updated_at) VALUES (?,2,?,?)")
      .run(p.id, Date.now(), Date.now());
    const { llm, calls } = makeGateLlm("none");
    const sched = new ExtractionScheduler(db, settings, new MemoryExtractor(db, memories, settings, llm), new ProfileRefiner(db, memories, settings, llm));

    await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.gate).toBe(0); // 达上限直接放行，省门控成本
    expect(calls.refine).toBe(1);
  });

  it("门控关闭 → 行为同旧版（不分类直接凝练）", async () => {
    await primeProfileTrigger("E:/Code/Gt4");
    settings.set("profile_gate_enabled", "false");
    const { llm, calls } = makeGateLlm("none");
    const sched = new ExtractionScheduler(db, settings, new MemoryExtractor(db, memories, settings, llm), new ProfileRefiner(db, memories, settings, llm));

    await sched.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.gate).toBe(0);
    expect(calls.refine).toBe(1);
  });

  it("refiner.gate：无画像直接放行；非法标签保守放行", async () => {
    const p = projects.upsertOnRequest("E:/Code/Gt5").project;
    memories.insert(p.id, { kind: "fact", content: "x", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });
    const refiner = new ProfileRefiner(db, memories, settings, async () => "nonsense");
    const g1 = await refiner.gate(p.id, llmCfg, 0);
    expect(g1).toEqual({ immediate: true, label: "first" }); // 无画像不调 LLM

    await refiner.refine(p.id, llmCfg, "full"); // 建画像（llm 返回 nonsense 也是画像文本）
    const g2 = await refiner.gate(p.id, llmCfg, 0);
    expect(g2.immediate).toBe(true);
    expect(g2.label).toBe("invalid"); // 非法标签保守放行

    const g3 = await refiner.gate(p.id, llmCfg, Date.now() + 60_000); // 无新记忆
    expect(g3).toEqual({ immediate: false, label: "none" });
  });
});

describe("EmbeddingBackfiller + 混合检索", () => {
  it("vec 不可用时 backfill no-op；searchHybrid 退化 BM25", async () => {
    const p = projects.upsertOnRequest("E:/Code/Ve").project;
    memories.insert(p.id, { kind: "fact", content: "SQLite WAL 模式", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });
    const backfiller = new EmbeddingBackfiller(memories, settings, async () => { throw new Error("should not call"); });
    expect(await backfiller.backfillProject(p.id)).toBe(0);

    const recaller = new MemoryRecaller(memories, settings, async () => new Float32Array(1024));
    const hits = await recaller.search(p.id, "WAL", 5);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("ConversationRecorder", () => {
  it("final 轮记录 user+assistant 并推进游标；非 final 跳过", () => {
    const p = projects.upsertOnRequest("E:/Code/Re").project;
    const sessions = new SessionRepo(db);
    sessions.create("k1", p.id, "header", Date.now());
    const recorder = new ConversationRecorder(db);

    const ids = recorder.recordTurn({
      projectId: p.id,
      sessionKey: "k1",
      requestMessages: [{ role: "system", content: "sys" }, { role: "user", content: "问题一" }],
      aggregate: { text: "回答一", toolCallCount: 0, final: true },
      allRules: [],
    });
    expect(ids).toHaveLength(2);

    // 第二轮：全量重发 + 新 user —— 只新增尾部
    const ids2 = recorder.recordTurn({
      projectId: p.id,
      sessionKey: "k1",
      requestMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "问题一" },
        { role: "assistant", content: "回答一" },
        { role: "user", content: "问题二" },
      ],
      aggregate: { text: "", toolCallCount: 1, final: false },
      allRules: [],
    });
    expect(ids2).toHaveLength(0); // 非 final 不落库

    const rows = db.prepare("SELECT role, content FROM conversations WHERE project_id = ? ORDER BY turn_seq").all(p.id) as { role: string; content: string }[];
    expect(rows.map((r) => r.content)).toEqual(["问题一", "回答一"]);
  });

  it("管线状态累积 user 计数", () => {
    const p = projects.upsertOnRequest("E:/Code/Re2").project;
    const sessions = new SessionRepo(db);
    sessions.create("k", p.id, "header", Date.now());
    const recorder = new ConversationRecorder(db);
    recorder.recordTurn({
      projectId: p.id, sessionKey: "k",
      requestMessages: [{ role: "user", content: "q1" }],
      aggregate: { text: "a1", toolCallCount: 0, final: true },
      allRules: [],
    });
    const ps = db.prepare("SELECT user_msg_count FROM pipeline_states WHERE project_id = ?").get(p.id) as { user_msg_count: number };
    expect(ps.user_msg_count).toBe(1);
  });
});
