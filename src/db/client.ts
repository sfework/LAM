import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { dbFilePath } from "../infra/paths.js";
import { createLogger } from "../infra/logger.js";
import { runMigrations } from "./migrate.js";
import { ensureFtsTables } from "./fts.js";
import { ensureVecTable } from "./vec.js";

const log = createLogger("db");
const requireCjs = createRequire(import.meta.url);

export interface DbHandle {
  raw: DatabaseSync;
  fts5Available: boolean;
  vecAvailable: boolean;
  close(): void;
}

function detectFts5(raw: DatabaseSync): boolean {
  try {
    raw.exec("CREATE VIRTUAL TABLE __fts_probe USING fts5(a, b)");
    raw.exec("DROP TABLE __fts_probe");
    return true;
  } catch (err) {
    log.warn({ err: String(err) }, "FTS5 不可用，关键词召回将降级为 LIKE");
    return false;
  }
}

function tryLoadVec(raw: DatabaseSync): boolean {
  try {
    const vec = requireCjs("sqlite-vec");
    const loadablePath: string | undefined =
      typeof vec?.getLoadablePath === "function" ? vec.getLoadablePath() : undefined;
    if (!loadablePath) {
      log.warn("sqlite-vec 未提供可加载路径，向量能力关闭");
      return false;
    }
    raw.loadExtension(loadablePath);
    log.info({ loadablePath }, "sqlite-vec 已加载");
    return true;
  } catch (err) {
    log.warn({ err: String(err) }, "sqlite-vec 加载失败，向量能力关闭（降级 FTS/BM25）");
    return false;
  }
}

/** 打开数据库、配置 pragma、探测扩展、应用迁移。 */
export function openDb(): DbHandle {
  const file = dbFilePath();
  mkdirSync(path.dirname(file), { recursive: true });

  const raw = new DatabaseSync(file, { allowExtension: true });
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");

  const fts5Available = detectFts5(raw);
  const vecAvailable = tryLoadVec(raw);

  runMigrations(raw);
  if (fts5Available) ensureFtsTables(raw);
  if (vecAvailable) ensureVecTable(raw);

  log.info({ file, fts5Available, vecAvailable }, "数据库已连接");
  return {
    raw,
    fts5Available,
    vecAvailable,
    close() {
      try {
        raw.close();
      } catch (err) {
        log.warn({ err: String(err) }, "关闭数据库异常");
      }
    },
  };
}
