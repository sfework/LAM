import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTables } from "../src/db/fts.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { SessionRepo } from "../src/gateway/sessions.js";
import { L0Recorder } from "../src/memory/l0-recorder.js";
import { L1Store } from "../src/memory/l1-store.js";
import { L1Extractor } from "../src/memory/l1-extractor.js";
import { L2Refiner } from "../src/memory/l2-refiner.js";
import { ExtractionScheduler } from "../src/memory/scheduler.js";
import { SkillExtractor } from "../src/memory/skill-extractor.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { tokenizeForFts, buildFtsQuery } from "../src/memory/tokenize.js";
import { parseLlmJson } from "../src/utils/json.js";
import { joinChatUrl } from "../src/llm/client.js";
import type { LlmCallConfig } from "../src/llm/client.js";

const FAKE_LLM: LlmCallConfig = { baseUrl: "http://fake", apiKey: "k", model: "m" };

function fresh() {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  ensureFtsTables(raw);
  const models = new ModelRepo(raw);
  const settings = new SettingsService(raw, models);
  settings.init();
  const projects = new ProjectRepo(raw);
  const sessions = new SessionRepo(raw);
  const l0 = new L0Recorder(raw);
  const store = new L1Store(raw);
  const assets = new AssetsRepo(raw);
  const { project } = projects.upsertOnRequest("d:/work/p");
  return { raw, settings, projects, sessions, l0, store, assets, projectId: project.id };
}

// ── tokenize ──

describe("tokenizeForFts", () => {
  it("CJK 二元组", () => {
    expect(tokenizeForFts("使用框架")).toBe("使用 用框 框架");
  });
  it("拉丁词小写", () => {
    expect(tokenizeForFts("React Hooks")).toBe("react hooks");
  });
  it("中英混合", () => {
    const t = tokenizeForFts("用 React 开发");
    expect(t).toContain("react");
    expect(t).toContain("开发");
  });
  it("buildFtsQuery OR 组合且去重", () => {
    const q = buildFtsQuery("使用框架");
    expect(q).toBe('"使用" OR "用框" OR "框架"');
    expect(buildFtsQuery("")).toBe("");
  });
});

// ── parseLlmJson ──

describe("parseLlmJson", () => {
  it("裸 JSON 数组", () => {
    expect(parseLlmJson("[1,2]")).toEqual([1, 2]);
  });
  it("```json 包裹", () => {
    expect(parseLlmJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it("前后解释文本", () => {
    expect(parseLlmJson('结果如下：\n[{"a":1}]\n以上。')).toEqual([{ a: 1 }]);
  });
  it("尾逗号容错", () => {
    expect(parseLlmJson('[{"a":1,},{"b":2,}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("字符串内含括号不误判", () => {
    expect(parseLlmJson('[{"t":"a ] b"}]')).toEqual([{ t: "a ] b" }]);
  });
  it("非法返回 null", () => {
    expect(parseLlmJson("no json here")).toBeNull();
    expect(parseLlmJson("")).toBeNull();
  });
});

// ── joinChatUrl ──

describe("joinChatUrl", () => {
  it("带/不带 /v1", () => {
    expect(joinChatUrl("https://api.x.com/v1")).toBe("https://api.x.com/v1/chat/completions");
    expect(joinChatUrl("https://api.x.com")).toBe("https://api.x.com/v1/chat/completions");
    expect(joinChatUrl("https://api.x.com/v1/")).toBe("https://api.x.com/v1/chat/completions");
    expect(joinChatUrl("https://api.x.com/chat/completions")).toBe("https://api.x.com/chat/completions");
  });
});

// ── L1Store ──

describe("L1Store", () => {
  let ctx: ReturnType<typeof fresh>;
  beforeEach(() => {
    ctx = fresh();
  });

  const mk = (content: string, kind = "fact", priority = 80) => ({
    kind: kind as "fact",
    content,
    priority,
    sceneName: "s",
    sourceL0Ids: [],
    batchId: null,
    createdAt: Date.now(),
  });

  it("insert + 中文 BM25 检索命中", () => {
    ctx.store.insert(ctx.projectId, mk("项目使用 React 框架开发前端"));
    ctx.store.insert(ctx.projectId, mk("数据库选型为 PostgreSQL"));
    const hits = ctx.store.search(ctx.projectId, "React 前端", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.content).toContain("React");
  });

  it("项目隔离：检索不跨项目", () => {
    ctx.store.insert(ctx.projectId, mk("项目A的记忆内容"));
    const hits = ctx.store.search("other-project", "项目A", 5);
    expect(hits).toHaveLength(0);
  });

  it("applyDecision：update 置 superseded_by，旧条目退出检索", () => {
    const oldId = ctx.store.insert(ctx.projectId, mk("旧事实描述"));
    const newId = ctx.store.applyDecision(
      ctx.projectId,
      { action: "update", targetIds: [oldId] },
      mk("新事实描述更准确"),
    );
    expect(newId).toBeTruthy();
    expect(ctx.store.get(oldId)!.supersededBy).toBe(newId);
    const hits = ctx.store.search(ctx.projectId, "事实描述", 5);
    expect(hits.map((h) => h.record.id)).toEqual([newId]);
  });

  it("skip 不落库", () => {
    const id = ctx.store.applyDecision(ctx.projectId, { action: "skip", targetIds: [] }, mk("x y z"));
    expect(id).toBeNull();
  });
});

// ── L1Extractor（fake LLM）──

function seedL0(ctx: ReturnType<typeof fresh>, turns: [string, string][]) {
  const ids: string[] = [];
  if (!ctx.sessions.get("s1")) ctx.sessions.create("s1", ctx.projectId, "header", Date.now());
  for (const [q, a] of turns) {
    ctx.l0.recordTurn({
      projectId: ctx.projectId,
      sessionKey: "s1",
      requestMessages: [{ role: "user", content: q }],
      aggregate: { text: a, toolCallCount: 0, final: true },
      allRules: [],
    });
  }
  const rows = ctx.raw.prepare("SELECT id FROM mem_l0 WHERE project_id = ? ORDER BY turn_seq").all(ctx.projectId) as { id: string }[];
  ids.push(...rows.map((r) => r.id));
  return ids;
}

describe("L1Extractor", () => {
  it("阶段一产出 → store 落库（无候选时跳过冲突检测）", async () => {
    const ctx = fresh();
    const l0Ids = seedL0(ctx, [["用户喜欢用 pnpm", "收到"]]);
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async () =>
      JSON.stringify([
        {
          scene_name: "配置前端工具链",
          message_ids: l0Ids,
          memories: [
            { content: "用户偏好使用 pnpm 管理依赖", type: "persona", priority: 85, source_message_ids: [l0Ids[0]], metadata: {} },
          ],
        },
      ]),
    );
    const res = await extractor.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.stored).toBe(1);
    const active = ctx.store.listActive(ctx.projectId);
    expect(active[0]!.kind).toBe("persona");
    expect(active[0]!.content).toContain("pnpm");
    expect(active[0]!.sourceL0Ids).toEqual([l0Ids[0]]);
  });

  it("低优先级被过滤（extract_min_priority）", async () => {
    const ctx = fresh();
    const l0Ids = seedL0(ctx, [["闲聊", "嗯"]]);
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async () =>
      JSON.stringify([
        { scene_name: "x", message_ids: [], memories: [{ content: "琐碎信息", type: "episodic", priority: 30, source_message_ids: [], metadata: {} }] },
      ]),
    );
    const res = await extractor.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.stored).toBe(0);
  });

  it("阶段二冲突检测：skip 决策丢弃新记忆", async () => {
    const ctx = fresh();
    ctx.store.insert(ctx.projectId, { kind: "fact", content: "项目使用 Vite 构建", priority: 80, sceneName: "构建", sourceL0Ids: [], batchId: null, createdAt: Date.now() - 1000 });
    const l0Ids = seedL0(ctx, [["项目用 Vite 构建吗", "是的"]]);
    let conflictCalled = false;
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async (_cfg, msgs) => {
      if (msgs[0]!.content.includes("冲突检测器")) {
        conflictCalled = true;
        return JSON.stringify([{ record_id: "will-be-remapped", action: "skip" }]);
      }
      return JSON.stringify([
        { scene_name: "构建", message_ids: [], memories: [{ content: "项目使用 Vite 构建", type: "fact", priority: 80, source_message_ids: [], metadata: {} }] },
      ]);
    });
    // skip 决策按 record_id 匹配，fake 返回固定 id 匹配不上 → 等价 store；
    // 用真实 record id 需从提取输出拿，这里改为捕获：先跑一次提取拿到 pending 再断言。
    // 简化：让 fake 从 prompt 里解析 record_id。
    const extractor2 = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async (_cfg, msgs) => {
      if (msgs[0]!.content.includes("冲突检测器")) {
        conflictCalled = true;
        const m = /record_id: (l1c_\w+)/.exec(msgs[1]!.content);
        return JSON.stringify([{ record_id: m?.[1] ?? "", action: "skip" }]);
      }
      return JSON.stringify([
        { scene_name: "构建", message_ids: [], memories: [{ content: "项目使用 Vite 构建", type: "fact", priority: 80, source_message_ids: [], metadata: {} }] },
      ]);
    });
    const before = ctx.store.listActive(ctx.projectId).length;
    const res = await extractor2.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(conflictCalled).toBe(true);
    expect(res.skipped).toBe(1);
    expect(ctx.store.listActive(ctx.projectId).length).toBe(before);
  });

  it("merge 决策：合并内容落库 + 旧条目 supersede", async () => {
    const ctx = fresh();
    const oldId = ctx.store.insert(ctx.projectId, { kind: "fact", content: "部署脚本在 deploy.sh", priority: 70, sceneName: "部署", sourceL0Ids: [], batchId: null, createdAt: Date.now() - 1000 });
    const l0Ids = seedL0(ctx, [["deploy.sh 已经废弃改用 Makefile", "了解"]]);
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async (_cfg, msgs) => {
      if (msgs[0]!.content.includes("冲突检测器")) {
        const m = /record_id: (l1c_\w+)/.exec(msgs[1]!.content);
        return JSON.stringify([
          {
            record_id: m?.[1] ?? "",
            action: "merge",
            target_ids: [oldId],
            merged_content: "部署脚本 deploy.sh 已废弃，改用 Makefile",
            merged_type: "fact",
            merged_priority: 85,
          },
        ]);
      }
      return JSON.stringify([
        { scene_name: "部署", message_ids: [], memories: [{ content: "deploy.sh 已废弃改用 Makefile", type: "fact", priority: 75, source_message_ids: [], metadata: {} }] },
      ]);
    });
    const res = await extractor.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.stored).toBe(1);
    const active = ctx.store.listActive(ctx.projectId);
    expect(active).toHaveLength(1);
    expect(active[0]!.content).toContain("Makefile");
    expect(active[0]!.priority).toBe(85);
    expect(ctx.store.get(oldId)!.supersededBy).toBe(active[0]!.id);
  });

  it("LLM 返回坏 JSON → 全部丢弃不崩", async () => {
    const ctx = fresh();
    const l0Ids = seedL0(ctx, [["q", "a"]]);
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async () => "not json at all");
    const res = await extractor.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.extracted).toBe(0);
  });
});

// ── SkillExtractor ──

describe("SkillExtractor", () => {
  it("总闸关闭时不抽取", async () => {
    const ctx = fresh();
    // 默认 skill_extract_enabled=false
    const l0Ids = seedL0(ctx, [["发布流程是什么", "先跑测试再打包"]]);
    const ex = new SkillExtractor(ctx.raw, ctx.assets, ctx.settings, async () =>
      JSON.stringify([{ name: "发布", description: "d", body: "步骤", confidence: 90, action: "store", target_id: null }]),
    );
    const res = await ex.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.extracted).toBe(0);
    expect(ctx.assets.listSkills()).toHaveLength(0);
  });

  it("开启后 store 落待审技能（enabled=false / source=auto / 绑定项目）", async () => {
    const ctx = fresh();
    ctx.settings.set("skill_extract_enabled", "true");
    const l0Ids = seedL0(ctx, [["发布流程是什么", "先跑测试再打包"]]);
    const ex = new SkillExtractor(ctx.raw, ctx.assets, ctx.settings, async () =>
      JSON.stringify([{ name: "发布检查清单", description: "发布前用", body: "## 步骤\n1. 测试\n2. 打包", confidence: 90, action: "store", target_id: null }]),
    );
    const res = await ex.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.stored).toBe(1);
    const sk = ctx.assets.listSkills()[0]!;
    expect(sk.name).toBe("发布检查清单");
    expect(sk.enabled).toBe(false);
    expect(sk.source).toBe("auto");
    expect(sk.projectId).toBe(ctx.projectId);
    expect(sk.version).toBe(1);
  });

  it("低于置信度阈值丢弃", async () => {
    const ctx = fresh();
    ctx.settings.set("skill_extract_enabled", "true");
    ctx.settings.set("skill_extract_min_confidence", "80");
    const l0Ids = seedL0(ctx, [["随便聊聊", "嗯"]]);
    const ex = new SkillExtractor(ctx.raw, ctx.assets, ctx.settings, async () =>
      JSON.stringify([{ name: "弱技能", description: "d", body: "b", confidence: 50, action: "store", target_id: null }]),
    );
    const res = await ex.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.skipped).toBe(1);
    expect(res.stored).toBe(0);
  });

  it("update 决策走版本化：生成新版本，旧版 superseded", async () => {
    const ctx = fresh();
    ctx.settings.set("skill_extract_enabled", "true");
    const existing = ctx.assets.createSkill({ name: "发布检查清单", description: "旧", body: "旧步骤", enabled: true });
    const l0Ids = seedL0(ctx, [["发布流程要加一步灰度", "好的"]]);
    const ex = new SkillExtractor(ctx.raw, ctx.assets, ctx.settings, async () =>
      JSON.stringify([{ name: "发布检查清单", description: "新", body: "## 步骤\n1. 测试\n2. 灰度\n3. 打包", confidence: 95, action: "update", target_id: existing.id }]),
    );
    const res = await ex.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.updated).toBe(1);
    const old = ctx.assets.getSkill(existing.id)!;
    expect(old.status).toBe("superseded");
    const active = ctx.assets.listSkills().find((s) => s.name === "发布检查清单")!;
    expect(active.version).toBe(2);
    expect(active.body).toContain("灰度");
  });

  it("LLM 返回坏 JSON → 不崩不落库", async () => {
    const ctx = fresh();
    ctx.settings.set("skill_extract_enabled", "true");
    const l0Ids = seedL0(ctx, [["q", "a"]]);
    const ex = new SkillExtractor(ctx.raw, ctx.assets, ctx.settings, async () => "not json");
    const res = await ex.extract(ctx.projectId, l0Ids, FAKE_LLM);
    expect(res.extracted).toBe(0);
    expect(ctx.assets.listSkills()).toHaveLength(0);
  });
});

// ── L2Refiner ──

describe("L2Refiner", () => {
  it("首次全量生成 version=1", async () => {
    const ctx = fresh();
    ctx.store.insert(ctx.projectId, { kind: "fact", content: "项目是 TS Node 服务", priority: 80, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() });
    const refiner = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "# 项目画像\n\n技术栈：TypeScript + Node。");
    const v = await refiner.refine(ctx.projectId, FAKE_LLM);
    expect(v).toBe(1);
    expect(ctx.raw.prepare("SELECT version FROM mem_l2 WHERE project_id = ?").get(ctx.projectId)).toMatchObject({ version: 1 });
  });

  it("增量更新 version 自增；markdown 围栏剥离", async () => {
    const ctx = fresh();
    ctx.store.insert(ctx.projectId, { kind: "fact", content: "记忆一", priority: 80, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() });
    const r1 = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "画像v1");
    await r1.refine(ctx.projectId, FAKE_LLM);
    const r2 = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "```markdown\n画像v2\n```");
    const v = await r2.refine(ctx.projectId, FAKE_LLM);
    expect(v).toBe(2);
    expect(r1.read(ctx.projectId)).toBe("画像v2");
  });

  it("无活跃 L1 时跳过", async () => {
    const ctx = fresh();
    const refiner = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "不该被调用");
    expect(await refiner.refine(ctx.projectId, FAKE_LLM)).toBe(0);
  });

  it("LLM 空返回不覆写", async () => {
    const ctx = fresh();
    ctx.store.insert(ctx.projectId, { kind: "fact", content: "x y", priority: 80, sceneName: "s", sourceL0Ids: [], batchId: null, createdAt: Date.now() });
    const r1 = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "好画像");
    await r1.refine(ctx.projectId, FAKE_LLM);
    const r2 = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "   ");
    expect(await r2.refine(ctx.projectId, FAKE_LLM)).toBe(0);
    expect(r2.read(ctx.projectId)).toBe("好画像");
  });
});

// ── Scheduler ──

describe("ExtractionScheduler", () => {
  function setup() {
    const ctx = fresh();
    ctx.settings.set("l1_trigger_conversations", "3");
    ctx.settings.set("l1_warmup_enabled", "false");
    ctx.settings.set("l1_idle_seconds", "5");
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async (_c, msgs) => {
      if (msgs[0]!.content.includes("冲突检测器")) return "[]";
      return JSON.stringify([{ scene_name: "批", message_ids: [], memories: [{ content: `提取结果 ${Date.now()}`, type: "fact", priority: 90, source_message_ids: [], metadata: {} }] }]);
    });
    const refiner = new L2Refiner(ctx.raw, ctx.store, ctx.settings, async () => "# 画像");
    const sched = new ExtractionScheduler(ctx.raw, ctx.settings, extractor, refiner);
    // 配 memory_llm
    const models = new ModelRepo(ctx.raw);
    const m = models.create({ category: "llm", name: "mem", url: "http://fake", key: "", model: "m" });
    ctx.settings.set("memory_llm", m.id);
    return { ctx, sched };
  }

  function feedTurns(ctx: ReturnType<typeof fresh>, n: number, session = "s1") {
    if (!ctx.sessions.get(session)) ctx.sessions.create(session, ctx.projectId, "header", Date.now());
    for (let i = 0; i < n; i++) {
      ctx.l0.recordTurn({
        projectId: ctx.projectId,
        sessionKey: session,
        requestMessages: [{ role: "user", content: `问题 ${i}` }],
        aggregate: { text: `回答 ${i}`, toolCallCount: 0, final: true },
        allRules: [],
      });
    }
  }

  it("未达阈值不提取；达到阈值提取并清缓冲", async () => {
    const { ctx, sched } = setup();
    feedTurns(ctx, 2);
    expect(await sched.tick()).toBe(0);
    feedTurns(ctx, 1);
    expect(await sched.tick()).toBe(1);
    await new Promise((r) => setTimeout(r, 50)); // 等串行队列
    expect(ctx.store.listActive(ctx.projectId).length).toBe(1);
    const ps = ctx.raw.prepare("SELECT conversation_count, buffered_message_ids FROM pipeline_state WHERE project_id = ?").get(ctx.projectId) as { conversation_count: number; buffered_message_ids: string };
    expect(ps.conversation_count).toBe(0);
    expect(ps.buffered_message_ids).toBe("[]");
  });

  it("warm-up：阈值 1 → 成功后翻倍为 2", async () => {
    const { ctx, sched } = setup();
    ctx.settings.set("l1_warmup_enabled", "true");
    feedTurns(ctx, 1);
    expect(await sched.tick()).toBe(1); // 阈值 1 立即触发
    await new Promise((r) => setTimeout(r, 50));
    const ps = ctx.raw.prepare("SELECT warmup_threshold FROM pipeline_state WHERE project_id = ?").get(ctx.projectId) as { warmup_threshold: number };
    expect(ps.warmup_threshold).toBe(2);
    // 第二轮：1 条不再触发（阈值 2）
    feedTurns(ctx, 1);
    expect(await sched.tick()).toBe(0);
    feedTurns(ctx, 1);
    expect(await sched.tick()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    const ps2 = ctx.raw.prepare("SELECT warmup_threshold FROM pipeline_state WHERE project_id = ?").get(ctx.projectId) as { warmup_threshold: number };
    expect(ps2.warmup_threshold).toBe(3); // min(3 上限, 4) → cap=3
  });

  it("idle 兜底：缓冲不足阈值但空闲超时也提取", async () => {
    const { ctx, sched } = setup();
    feedTurns(ctx, 1);
    // 把 last_seen_at 推过去（超过 l1_idle_seconds=5s）
    ctx.raw.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_key = 's1'").run(Date.now() - 10_000);
    expect(await sched.tick()).toBe(1);
  });

  it("extraction_enabled=false 时调度停摆", async () => {
    const { ctx, sched } = setup();
    ctx.settings.set("extraction_enabled", "false");
    feedTurns(ctx, 5);
    expect(await sched.tick()).toBe(0);
    expect(ctx.store.listActive(ctx.projectId)).toHaveLength(0);
  });

  it("memory_llm 未配置时静默跳过", async () => {
    const ctx = fresh();
    const extractor = new L1Extractor(ctx.raw, ctx.store, ctx.settings, async () => "[]");
    const sched = new ExtractionScheduler(ctx.raw, ctx.settings, extractor, new L2Refiner(ctx.raw, ctx.store, ctx.settings));
    feedTurns(ctx, 5);
    expect(await sched.tick()).toBe(0);
  });

  it("flushAll 忽略阈值立即处理", async () => {
    const { ctx, sched } = setup();
    feedTurns(ctx, 1);
    await sched.flushAll();
    expect(ctx.store.listActive(ctx.projectId).length).toBe(1);
  });

  it("L1 完成后按 l2_delay 触发 L2 凝练", async () => {
    const { ctx, sched } = setup();
    ctx.settings.set("l2_delay_seconds", "0");
    feedTurns(ctx, 3);
    await sched.tick();
    await new Promise((r) => setTimeout(r, 80)); // L1 + L2 串行完成
    await sched.tick(); // 第二次 tick 触发 L2（delay=0）
    await new Promise((r) => setTimeout(r, 80));
    const l2 = ctx.raw.prepare("SELECT content, version FROM mem_l2 WHERE project_id = ?").get(ctx.projectId) as { content: string; version: number } | undefined;
    expect(l2?.content).toBe("# 画像");
  });

  it("崩溃恢复：缓冲留在 pipeline_state，重启后新调度器可继续", async () => {
    const { ctx, sched } = setup();
    feedTurns(ctx, 2);
    await sched.tick(); // 不触发（阈值3）
    // 新调度器（模拟重启）
    const sched2 = new ExtractionScheduler(
      ctx.raw,
      ctx.settings,
      new L1Extractor(ctx.raw, ctx.store, ctx.settings, async (_c, msgs) =>
        msgs[0]!.content.includes("冲突检测器") ? "[]" : JSON.stringify([{ scene_name: "s", message_ids: [], memories: [{ content: "恢复后提取", type: "fact", priority: 90, source_message_ids: [], metadata: {} }] }]),
      ),
      new L2Refiner(ctx.raw, ctx.store, ctx.settings),
    );
    feedTurns(ctx, 1); // 补到阈值
    expect(await sched2.tick()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.store.listActive(ctx.projectId).some((r) => r.content.includes("恢复后提取"))).toBe(true);
  });
});
