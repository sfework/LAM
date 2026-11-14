#!/usr/bin/env node
/**
 * LAM → NLAM 一次性数据迁移脚本。
 *
 * 读取 LAM 的 gateway.db，按新 schema 导入 NLAM（术语与表名重映射）：
 *   mem_l0 → conversations、mem_l1 → memory_items、mem_l2 → profiles、
 *   knowledge → knowledges、pipeline_state → pipeline_states（last_l2_at → last_profile_at）。
 * 设置键名同步改名（l1_* → memory_*、l2_* → profile_*）。
 * 迁移后重建记忆 FTS 索引（CJK 二元组 + 拉丁词，与运行期口径一致）；
 * 向量表按 --vectors 开关从 mem_l1_vec 原样搬运（同 1024 维 cosine）。
 *
 * LAM 无数据库连接登记（旧版连接串按调用直传），迁移后需在新版管理台手工配置项目连接。
 *
 * 用法：
 *   node --import tsx scripts/migrate-from-lam.mjs [--from <LAM gateway.db>] [--to <NLAM nlam.db>] [--vectors] [--dry-run]
 * --from 必填（LAM 旧库 gateway.db 路径），--to 缺省当前项目 data/nlam.db。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const FROM = args.from || "";
const TO = args.to || path.resolve(here, "..", "data", "nlam.db");
const WITH_VECTORS = !!args.vectors;
const DRY_RUN = !!args["dry-run"];

if (!FROM || !existsSync(FROM)) {
  console.error("请用 --from <LAM gateway.db 路径> 指定源库（文件须存在）");
  process.exit(1);
}
mkdirSync(path.dirname(TO), { recursive: true });

// 动态导入运行期迁移器与虚表创建器，保证目标库 schema 为最新（幂等）。
const { runMigrations } = await import("../src/db/migrate.ts");
const { ensureFtsTable } = await import("../src/db/fts.ts");
const { ensureVecTable } = await import("../src/db/vec.ts");
const { createRequire } = await import("node:module");
const requireCjs = createRequire(import.meta.url);

const src = new DatabaseSync(FROM, { readOnly: true, allowExtension: true });
const dst = new DatabaseSync(TO, { allowExtension: true });
dst.exec("PRAGMA foreign_keys = ON;");
runMigrations(dst);
ensureFtsTable(dst);

// 向量搬运需要 sqlite-vec 扩展（两侧都要加载：源读、目标写）。
let vecOk = false;
if (WITH_VECTORS) {
  try {
    const vec = requireCjs("sqlite-vec");
    const p = typeof vec?.getLoadablePath === "function" ? vec.getLoadablePath() : undefined;
    if (p) {
      src.loadExtension(p);
      dst.loadExtension(p);
      ensureVecTable(dst);
      vecOk = true;
    }
  } catch (err) {
    console.warn(`向量搬运跳过（sqlite-vec 不可用）: ${String(err)}`);
  }
}

function migrate() {
  const plan = [
    ["projects", copyProjects],
    ["prompts", copySimple("prompts", "prompts", ["id", "name", "content", "enabled", "updated_at"])],
    ["agents", copySimple("agents", "agents", ["id", "name", "description", "body", "enabled", "sort_order", "updated_at"])],
    ["knowledges", copySimple("knowledge", "knowledges", ["id", "title", "description", "body", "scope", "project_id", "enabled", "sort_order", "updated_at", "deleted_at"])],
    ["conversations", copyConversations],
    ["memory_items", copyMemories],
    ["profiles", copySimple("mem_l2", "profiles", ["id", "project_id", "content", "version", "updated_at", "deleted_at"])],
    ["pipeline_states", copyPipeline],
    ["sessions", copySimple("sessions", "sessions", ["id", "session_key", "project_id", "source", "inject_snapshot", "created_at", "last_seen_at", "handled_count"])],
    ["models", copySimple("models", "models", ["id", "category", "name", "url", "key", "model", "models_json", "model_mode", "created_at", "updated_at"])],
    ["denoise_rules", copySimple("denoise_rules", "denoise_rules", ["id", "start_text", "end_text", "extract", "apply_forward", "apply_memory", "enabled", "created_at", "updated_at"])],
    ["settings", copySettings],
  ];

  dst.exec("BEGIN");
  let summary;
  try {
    summary = {};
    for (const [label, fn] of plan) summary[label] = fn();
    if (WITH_VECTORS && vecOk) summary["memory_items_vec"] = copyVectors();
    dst.exec(DRY_RUN ? "ROLLBACK" : "COMMIT");
  } catch (err) {
    dst.exec("ROLLBACK");
    throw err;
  }
  console.log(DRY_RUN ? "（dry-run，未落库）迁移预览：" : "迁移完成：");
  console.table(summary);

  if (!DRY_RUN) {
    const fts = rebuildFts();
    console.log(`记忆 FTS 索引重建：${fts} 条`);
  }
  src.close();
  dst.close();
}

// ── 各表拷贝 ──

function copyProjects() {
  // 目标表若已有同 path 记录则跳过（重复迁移安全）。
  const rows = src.prepare("SELECT * FROM projects").all();
  let n = 0;
  const ins = dst.prepare(
    "INSERT OR IGNORE INTO projects (id, name, path, created_at, last_active_at, deleted_at) VALUES (?,?,?,?,?,?)",
  );
  for (const r of rows) {
    const clash = dst.prepare("SELECT id FROM projects WHERE path = ?").get(r.path);
    if (clash && clash.id !== r.id) continue; // 路径已被占，保留目标库现有
    ins.run(r.id, r.name, r.path, r.created_at, r.last_active_at, r.deleted_at ?? null);
    n++;
  }
  return n;
}

function copySimple(fromTable, toTable, cols) {
  return () => {
    const rows = src.prepare(`SELECT ${cols.join(",")} FROM ${fromTable}`).all();
    const marks = cols.map(() => "?").join(",");
    const ins = dst.prepare(`INSERT OR IGNORE INTO ${toTable} (${cols.join(",")}) VALUES (${marks})`);
    for (const r of rows) ins.run(...cols.map((c) => r[c] ?? null));
    return rows.length;
  };
}

function copyConversations() {
  const rows = src.prepare(
    "SELECT id, project_id, session_key, turn_seq, role, content, created_at, deleted_at FROM mem_l0",
  ).all();
  const ins = dst.prepare(
    "INSERT OR IGNORE INTO conversations (id, project_id, session_key, turn_seq, role, content, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const r of rows) ins.run(r.id, r.project_id, r.session_key, r.turn_seq, r.role, r.content, r.created_at, r.deleted_at ?? null);
  return rows.length;
}

function copyMemories() {
  const rows = src.prepare(
    `SELECT id, project_id, kind, content, priority, scene_name, source_l0_ids, metadata, batch_id,
            created_at, updated_at, superseded_by, deleted_at FROM mem_l1`,
  ).all();
  const ins = dst.prepare(
    `INSERT OR IGNORE INTO memory_items
     (id, project_id, kind, content, priority, scene_name, source_conversation_ids, metadata, batch_id, created_at, updated_at, superseded_by, deleted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    ins.run(r.id, r.project_id, r.kind, r.content, r.priority, r.scene_name ?? null,
      r.source_l0_ids ?? "[]", r.metadata ?? "{}", r.batch_id ?? null,
      r.created_at, r.updated_at, r.superseded_by ?? null, r.deleted_at ?? null);
  }
  return rows.length;
}

function copyPipeline() {
  const rows = src.prepare(
    "SELECT id, project_id, session_key, user_msg_count, last_scene_name, last_l2_at, buffered_message_ids FROM pipeline_state",
  ).all();
  const ins = dst.prepare(
    "INSERT OR IGNORE INTO pipeline_states (id, project_id, session_key, user_msg_count, last_scene_name, last_profile_at, buffered_message_ids) VALUES (?,?,?,?,?,?,?)",
  );
  for (const r of rows) {
    ins.run(r.id, r.project_id, r.session_key, r.user_msg_count, r.last_scene_name ?? null, r.last_l2_at ?? null, r.buffered_message_ids ?? "[]");
  }
  return rows.length;
}

/** 设置键名映射（旧术语 → 新记忆/画像术语）；未识别键原样保留。 */
const SETTINGS_KEY_MAP = {
  l1_recall_top_k: "memory_recall_top_k",
  l1_recall_similarity_min: "memory_similarity_min",
  l1_trigger_user_messages: "memory_trigger_user_messages",
  l2_delay_seconds: "profile_delay_seconds",
  l2_max_chars: "profile_max_chars",
};

function copySettings() {
  const rows = src.prepare("SELECT key, value, updated_at FROM settings").all();
  const ins = dst.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  );
  let n = 0;
  for (const r of rows) {
    const key = SETTINGS_KEY_MAP[r.key] ?? r.key;
    ins.run(key, r.value, r.updated_at);
    n++;
  }
  return n;
}

function copyVectors() {
  let rows;
  try {
    rows = src.prepare("SELECT l1_id, embedding, project_id FROM mem_l1_vec").all();
  } catch {
    return 0; // 源库无向量表
  }
  const ins = dst.prepare("INSERT OR REPLACE INTO memory_items_vec (memory_id, embedding, project_id) VALUES (?,?,?)");
  for (const r of rows) ins.run(r.l1_id, r.embedding, r.project_id);
  return rows.length;
}

/**
 * 迁移后重建记忆 FTS（独立表 + 预切分 token）。
 * 先清空，再对全部未软删/未替换记忆按运行期同规则切词写入。
 */
function rebuildFts() {
  const rows = dst.prepare(
    "SELECT id, project_id, content FROM memory_items WHERE deleted_at IS NULL AND superseded_by IS NULL",
  ).all();
  dst.exec("DELETE FROM memory_items_fts");
  const ins = dst.prepare("INSERT INTO memory_items_fts (content, memory_id, project_id) VALUES (?,?,?)");
  for (const r of rows) ins.run(tokenize(r.content), r.id, r.project_id);
  return rows.length;
}

// CJK 二元组 + 拉丁词切分（与 src/memory/tokenize.ts 口径一致）。
function tokenize(text) {
  if (!text) return "";
  const tokens = [];
  for (const m of text.matchAll(/[a-zA-Z0-9_]+/g)) tokens.push(m[0].toLowerCase());
  for (const m of text.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g)) {
    const run = m[0];
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens.join(" ");
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < list.length && !list[i + 1].startsWith("--")) { out[key] = list[++i]; }
      else out[key] = true;
    }
  }
  return out;
}

// 顶层执行放最后：const（SETTINGS_KEY_MAP 等）须先完成初始化再 migrate()。
try {
  migrate();
} catch (err) {
  console.error("迁移失败:", err);
  src.close();
  dst.close();
  process.exit(1);
}
