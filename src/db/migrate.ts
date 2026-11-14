import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "../infra/logger.js";

const log = createLogger("db:migrate");

/**
 * 运行时迁移应用器（无 drizzle，手写 SQL 为唯一事实源）。
 *
 * 迁移文件放在仓库根 `migrations/`，命名 `NNNN_name.sql`，按文件名升序应用；
 * 文件内 `--> statement-breakpoint` 为语句分隔符；已应用版本记录在 __migrations。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** 源码（src/db）与打包后（dist）都回溯到项目根的 migrations 目录。 */
function migrationsDir(): string {
  for (const up of ["../..", "../../.."]) {
    const dir = path.resolve(here, up, "migrations");
    if (existsSync(dir)) return dir;
  }
  return path.resolve(here, "../..", "migrations");
}

function listMigrationFiles(dir: string): { name: string; file: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ name: f.replace(/\.sql$/, ""), file: path.join(dir, f) }));
}

export function runMigrations(raw: DatabaseSync): void {
  raw.exec(
    "CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (raw.prepare("SELECT name FROM __migrations").all() as { name: string }[]).map((r) => r.name),
  );

  const dir = migrationsDir();
  if (!existsSync(dir)) {
    log.warn({ dir }, "未找到迁移目录，跳过");
    return;
  }

  const ins = raw.prepare("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)");
  for (const { name, file } of listMigrationFiles(dir)) {
    if (applied.has(name)) continue;
    const sql = readFileSync(file, "utf8");
    const statements = sql
      .split(/--> statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);

    raw.exec("BEGIN");
    try {
      for (const stmt of statements) raw.exec(stmt);
      ins.run(name, Date.now());
      raw.exec("COMMIT");
      log.info({ migration: name }, "迁移已应用");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw new Error(`迁移 ${name} 失败: ${String(err)}`);
    }
  }
}
