#!/usr/bin/env node
/**
 * 数据清空脚本：物理删除除「模型库(models)」与「设置(settings)」之外的所有业务数据。
 *
 * 保留：models、settings、__migrations（迁移记录，删了会重跑迁移）。
 * 清空：项目/会话/管线状态/提取队列、L0/L1/L2（含 FTS 与 vec0 索引）、
 *       提示词/agents/技能/知识库/除噪规则、CodeGraph 全部产物。
 *
 * 前置：**必须先停服**（WAL 下有写入会复活数据）。
 * 用法：node scripts/wipe-data.mjs [--yes]
 */
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "gateway.db") : path.join(ROOT, "data", "gateway.db");

const KEEP = new Set(["models", "settings", "__migrations"]);
// 顺序：先普通表，虚拟表（fts/vec）放后面统一清。
const WIPE = [
  "pipeline_state", "extract_queue", "sessions", "projects",
  "mem_l0", "mem_l1", "mem_l2",
  "prompts", "agents", "skills", "knowledge", "denoise_rules",
  "cg_calls", "cg_edges", "cg_symbols", "cg_files", "cg_status",
  "mem_l0_fts", "mem_l1_fts", "mem_l1_vec",
];

const yes = process.argv.includes("--yes");
if (!yes) {
  console.error(`将物理清空 ${DB} 中 ${WIPE.length} 张表（保留 models/settings/__migrations）。\n确认后加 --yes 重跑。`);
  process.exit(1);
}

const db = new DatabaseSync(DB, { allowExtension: true });
// mem_l1_vec 是 vec0 虚拟表：需与主服务同样加载 sqlite-vec 扩展才能 DELETE。
try {
  const vec = requireCjs("sqlite-vec");
  const loadablePath = typeof vec?.getLoadablePath === "function" ? vec.getLoadablePath() : undefined;
  if (loadablePath) db.loadExtension(loadablePath);
  else console.warn("⚠ sqlite-vec 无 loadablePath，mem_l1_vec 清理可能失败");
} catch (err) {
  console.warn("⚠ sqlite-vec 加载失败：", String(err));
}
db.exec("PRAGMA foreign_keys = OFF;");

console.log(`\n清空 ${DB}\n`);
const report = [];
db.exec("BEGIN");
try {
  for (const t of WIPE) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?").get(t);
    if (!exists) {
      report.push({ table: t, before: "-", note: "表不存在，跳过" });
      continue;
    }
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get()).n;
    db.exec(`DELETE FROM "${t}"`);
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get()).n;
    report.push({ table: t, before, after });
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("清空失败，已回滚：", err);
  process.exit(1);
}

for (const r of report) {
  console.log(`  ${String(r.table).padEnd(16)} ${String(r.before).padStart(6)} → ${r.after ?? r.note}`);
}

// 清理自增序列残留 + 合并 WAL，让文件收紧。
db.exec("DELETE FROM sqlite_sequence WHERE name NOT IN ('models','settings')");
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.exec("VACUUM;");

console.log("\n保留项现状：");
for (const t of KEEP) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);
  const n = exists ? db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n : "-";
  console.log(`  ${t.padEnd(14)} ${n} 行`);
}
const size = (db.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get()).b;
console.log(`\n完成。DB 体积 ${(Number(size) / 1024 / 1024).toFixed(2)} MB。`);
db.close();
