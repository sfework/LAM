import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "../infra/logger.js";

const log = createLogger("db:migrate");

/**
 * 运行时迁移应用器。
 *
 * drizzle-kit 离线生成 `drizzle/*.sql`（含 meta/_journal.json 顺序），
 * 本模块用 node:sqlite 按序执行未应用的迁移，并在 __migrations 记录版本。
 * 迁移文件内的 `--> statement-breakpoint` 为语句分隔符。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** 打包后 dist/ 与源码 src/ 都回退到项目根的 drizzle 目录。 */
function migrationsDir(): string {
  let dir = path.resolve(here, "../../drizzle");
  if (!existsSync(dir)) dir = path.resolve(here, "../../../drizzle");
  return dir;
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function loadJournal(dir: string): JournalEntry[] {
  const file = path.join(dir, "meta", "_journal.json");
  const json = JSON.parse(readFileSync(file, "utf8")) as { entries: JournalEntry[] };
  return json.entries.sort((a, b) => a.idx - b.idx);
}

export function runMigrations(raw: DatabaseSync): void {
  raw.exec(
    "CREATE TABLE IF NOT EXISTS __migrations (idx INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (raw.prepare("SELECT idx FROM __migrations").all() as { idx: number }[]).map((r) => r.idx),
  );

  const dir = migrationsDir();
  if (!existsSync(dir)) {
    log.warn({ dir }, "未找到迁移目录，跳过（首次 drizzle-kit generate 前）");
    return;
  }

  const journal = loadJournal(dir);
  let count = 0;
  const ins = raw.prepare("INSERT INTO __migrations (idx, name, applied_at) VALUES (?, ?, ?)");

  for (const entry of journal) {
    if (applied.has(entry.idx)) continue;
    const sqlFile = path.join(dir, `${entry.tag}.sql`);
    if (!existsSync(sqlFile)) {
      throw new Error(`迁移文件缺失: ${sqlFile} (idx=${entry.idx})`);
    }
    const sql = readFileSync(sqlFile, "utf8");
    const statements = sql
      .split(/--> statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);

    raw.exec("BEGIN");
    try {
      for (const stmt of statements) raw.exec(stmt);
      ins.run(entry.idx, entry.tag, Date.now());
      raw.exec("COMMIT");
      count++;
      log.info({ tag: entry.tag }, "迁移已应用");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw new Error(`迁移 ${entry.tag} 失败: ${String(err)}`);
    }
  }

  if (count === 0) log.info("数据库结构已是最新");
}
