#!/usr/bin/env node
/**
 * 「记忆整理Agent」手动维护工具。
 *
 * 服务启动时 ensureSystemAgents() 已自动创建该 Agent，本脚本仅用于：
 *   --rebuild  用标准模板重建 body（覆盖人工编辑，模板更新后用）
 *   （无参数）报告现状
 *
 * 用法：node scripts/seed-consolidation-agent.mjs [--db <nlam.db>] [--rebuild]
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const DB = argOf("--db") || path.join(root, "data", "nlam.db");
const REBUILD = args.includes("--rebuild");

if (!existsSync(DB)) {
  console.error(`目标库不存在：${DB}（先启动一次 NLAM 或跑迁移脚本建库）`);
  process.exit(1);
}

const { ensureSystemAgents, buildConsolidationAgentBody, CONSOLIDATION_AGENT_NAME } =
  await import("../src/assets/system-agents.ts");
const { runMigrations } = await import("../src/db/migrate.ts");

const db = new DatabaseSync(DB);
db.exec("PRAGMA foreign_keys = ON;");
runMigrations(db); // 含 system 列迁移；幂等

const result = ensureSystemAgents(db);
const row = db.prepare("SELECT id FROM agents WHERE name = ?").get(CONSOLIDATION_AGENT_NAME);

if (REBUILD) {
  db.prepare("UPDATE agents SET body = ?, updated_at = ? WHERE id = ?")
    .run(buildConsolidationAgentBody(), Date.now(), row.id);
  console.log(`body 已按标准模板重建：id=${row.id}`);
} else {
  console.log(result.created
    ? `已创建 ${CONSOLIDATION_AGENT_NAME}：id=${row.id}（系统级，不可删除）`
    : `已存在 ${CONSOLIDATION_AGENT_NAME}：id=${row.id}，body 未改动。重建请加 --rebuild`);
}

db.close();
