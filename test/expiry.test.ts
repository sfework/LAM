import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTables } from "../src/db/fts.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { L1Store } from "../src/memory/l1-store.js";
import { MemoryExpirer } from "../src/memory/expiry.js";
import type { LlmCallConfig } from "../src/llm/client.js";

const FAKE_LLM: LlmCallConfig = { baseUrl: "http://fake", apiKey: "k", model: "m" };
const DAY = 86_400_000;

function fresh() {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  ensureFtsTables(raw);
  const models = new ModelRepo(raw);
  const settings = new SettingsService(raw, models);
  settings.init();
  const projects = new ProjectRepo(raw);
  const store = new L1Store(raw);
  const { project } = projects.upsertOnRequest("d:/work/p");
  return { raw, settings, store, projectId: project.id };
}

/** 插一条指定年龄的活跃 L1（直接改 created_at 到过去）。 */
function seed(ctx: ReturnType<typeof fresh>, kind: string, content: string, ageDays: number): string {
  const id = ctx.store.insert(ctx.projectId, {
    kind: kind as never,
    content,
    priority: 70,
    sceneName: null,
    sourceL0Ids: [],
    batchId: null,
    createdAt: Date.now(),
  });
  ctx.raw.prepare("UPDATE mem_l1 SET created_at = ? WHERE id = ?").run(Date.now() - ageDays * DAY, id);
  return id;
}

describe("MemoryExpirer", () => {
  let ctx: ReturnType<typeof fresh>;
  beforeEach(() => {
    ctx = fresh();
    ctx.settings.set("memory_expiry_enabled", "true");
  });

  it("默认 fact 类永不过期（days_other=0），不进候选", async () => {
    seed(ctx, "fact", "项目使用 pnpm", 400);
    const ex = new MemoryExpirer(ctx.store, ctx.settings, async () => "[]");
    const res = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(res.scanned).toBe(0);
    expect(ctx.store.listActive(ctx.projectId)).toHaveLength(1);
  });

  it("episodic 超龄进候选，delete 决策物理删并移出 FTS", async () => {
    const id = seed(ctx, "episodic", "用户在周二完成了登录联调", 40);
    const seen: string[] = [];
    const ex = new MemoryExpirer(ctx.store, ctx.settings, async (_c, msgs) => {
      seen.push(String(msgs[1]!.content));
      return JSON.stringify([{ id, action: "delete" }]);
    });
    const res = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(res).toMatchObject({ scanned: 1, deleted: 1, rewritten: 0, kept: 0 });
    expect(ctx.store.get(id)).toBeUndefined();
    // FTS 已同步清除
    const fts = ctx.raw.prepare("SELECT count(*) n FROM mem_l1_fts WHERE l1_id = ?").get(id) as { n: number };
    expect(fts.n).toBe(0);
    // 评审 prompt 带上了条目 id 与年龄
    expect(seen[0]).toContain(id);
    expect(seen[0]).toContain("40 天");
  });

  it("rewrite 决策更新正文（部分过时修剪）", async () => {
    const id = seed(ctx, "episodic", "端口先用 5183，后来联调发现要改 5184", 35);
    const ex = new MemoryExpirer(ctx.store, ctx.settings, async () =>
      JSON.stringify([{ id, action: "rewrite", new_content: "端口为 5184" }]),
    );
    const res = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(res).toMatchObject({ deleted: 0, rewritten: 1 });
    expect(ctx.store.get(id)!.content).toBe("端口为 5184");
  });

  it("keep 决策写续期锚点，本轮不删且下轮不再进候选", async () => {
    const id = seed(ctx, "episodic", "一次重要发布评审决定", 31);
    const ex = new MemoryExpirer(ctx.store, ctx.settings, async () => JSON.stringify([{ id, action: "keep" }]));
    const r1 = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(r1).toMatchObject({ scanned: 1, kept: 1, deleted: 0 });
    expect(ctx.store.get(id)).toBeDefined();
    // 锚点已写入 metadata
    expect(JSON.parse(ctx.store.get(id)!.metadata).expiry_kept_at).toBeTypeOf("number");
    // 第二轮：锚点续期后未再超龄，不进候选
    const r2 = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(r2.scanned).toBe(0);
  });

  it("评审 LLM 坏输出/异常 → 整轮跳过不删（保守）", async () => {
    seed(ctx, "episodic", "旧事件A", 40);
    seed(ctx, "episodic", "旧事件B", 45);
    const bad = new MemoryExpirer(ctx.store, ctx.settings, async () => "not json");
    const r1 = await bad.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(r1).toMatchObject({ scanned: 2, deleted: 0, rewritten: 0, kept: 0 });
    expect(ctx.store.listActive(ctx.projectId)).toHaveLength(2);

    const ex = new MemoryExpirer(ctx.store, ctx.settings, async () => {
      throw new Error("upstream 500");
    });
    const r2 = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(r2.deleted).toBe(0);
    expect(ctx.store.listActive(ctx.projectId)).toHaveLength(2);
  });

  it("总闸关闭时 sweep 不执行（enabled=false）", async () => {
    ctx.settings.set("memory_expiry_enabled", "false");
    const ex = new MemoryExpirer(ctx.store, ctx.settings, async () => {
      throw new Error("不应被调用");
    });
    expect(ex.enabled).toBe(false);
  });

  it("单批上限：超量候选只评审最老的 max_items 条", async () => {
    ctx.settings.set("memory_expiry_max_items", "2");
    for (let i = 1; i <= 5; i++) seed(ctx, "episodic", `事件${i}`, 30 + i);
    let reviewed = 0;
    const ex = new MemoryExpirer(ctx.store, ctx.settings, async () => {
      reviewed++;
      return "[]";
    });
    const res = await ex.sweepOneProject(ctx.projectId, FAKE_LLM);
    expect(res.scanned).toBe(2);
    expect(reviewed).toBe(1);
  });

  it("artifact 类按独立 TTL（90 天）", async () => {
    seed(ctx, "artifact", "临时调试脚本 tmp.mjs", 80); // 未超 90
    const ex1 = new MemoryExpirer(ctx.store, ctx.settings, async () => "[]");
    expect((await ex1.sweepOneProject(ctx.projectId, FAKE_LLM)).scanned).toBe(0);
    seed(ctx, "artifact", "旧构建产物引用", 120); // 超 90
    const ex2 = new MemoryExpirer(ctx.store, ctx.settings, async () => "[]");
    expect((await ex2.sweepOneProject(ctx.projectId, FAKE_LLM)).scanned).toBe(1);
  });
});
