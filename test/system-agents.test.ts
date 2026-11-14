import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { AssetsRepo } from "../src/assets/repo.js";
import {
  ensureSystemAgents,
  buildConsolidationAgentBody,
  CONSOLIDATION_AGENT_NAME,
} from "../src/assets/system-agents.js";

let dir: string;
let db: DatabaseSync;
let assets: AssetsRepo;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-sys-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  assets = new AssetsRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureSystemAgents", () => {
  it("冷启动自动创建：system=1、enabled=1、body 为标准模板", () => {
    const r1 = ensureSystemAgents(db);
    expect(r1.created).toBe(true);

    const a = assets.listAgents().find((x) => x.name === CONSOLIDATION_AGENT_NAME)!;
    expect(a.system).toBe(true);
    expect(a.enabled).toBe(true);
    expect(a.body).toBe(buildConsolidationAgentBody());
  });

  it("重复启动幂等：已存在不重建、body 不被覆盖", () => {
    ensureSystemAgents(db);
    const a = assets.listAgents().find((x) => x.name === CONSOLIDATION_AGENT_NAME)!;

    // 模拟人工编辑 body
    assets.updateAgent(a.id, { body: "我改过的流程" });

    const r2 = ensureSystemAgents(db);
    expect(r2.created).toBe(false);
    const after = assets.getAgent(a.id)!;
    expect(after.id).toBe(a.id);
    expect(after.body).toBe("我改过的流程"); // 重启绝不覆盖人工编辑
    expect(assets.listAgents().filter((x) => x.name === CONSOLIDATION_AGENT_NAME)).toHaveLength(1);
  });

  it("旧库无 system 标志的遗留行：只补标志不动 body", () => {
    const legacy = assets.createAgent({ name: CONSOLIDATION_AGENT_NAME, description: "旧描述", body: "旧body" });
    expect(assets.getAgent(legacy.id)!.system).toBe(false);

    const r = ensureSystemAgents(db);
    expect(r.created).toBe(false);
    const after = assets.getAgent(legacy.id)!;
    expect(after.system).toBe(true);
    expect(after.body).toBe("旧body");
    expect(after.description).toBe("旧描述");
  });

  it("Agent 模板不含口令与工具白名单限制（已取消）", () => {
    const body = buildConsolidationAgentBody();
    expect(body).not.toContain("consolidation_key");
    expect(body).not.toContain("禁止调用 knowledge_");
    expect(body).toContain("仅在用户明确要求整理时启动");
  });

  it("系统级保护联动：自动创建的 Agent 删不掉", () => {
    ensureSystemAgents(db);
    const a = assets.listAgents().find((x) => x.name === CONSOLIDATION_AGENT_NAME)!;
    expect(() => assets.deleteAgent(a.id)).toThrow(/系统级/);
  });
});
