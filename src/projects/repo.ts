import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colNum, colNumOrNull, colStr, colStrOrNull, getRow, getRows, type SqlRow } from "../db/rows.js";
import { deriveProjectName, normalizeProjectPath } from "./normalize.js";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastActiveAt: number;
  deletedAt: number | null;
}

function mapProject(r: SqlRow): ProjectRow {
  return {
    id: colStr(r, "id"),
    name: colStr(r, "name"),
    path: colStr(r, "path"),
    createdAt: colNum(r, "created_at"),
    lastActiveAt: colNum(r, "last_active_at"),
    deletedAt: colNumOrNull(r, "deleted_at"),
  };
}

/**
 * 项目仓储。
 * - 纯自动登记：规范化 path 为唯一键。
 * - 软删级联：projects / conversations / memory_items / profiles / knowledges(project scope) 一起打 deleted_at。
 * - 恢复：命中软删项目再次请求时，级联取消软删。
 */
export class ProjectRepo {
  private readonly db: DatabaseSync;
  /**
   * last_active_at 落库节流：网关每请求 upsertOnRequest，该字段仅用于管理端排序，
   * 无逻辑依赖其精度 → 60s 内跳过 UPDATE，消除高频循环下的重复写（WAL 写锁串行）。
   */
  private readonly lastActiveWriteAt = new Map<string, number>();
  private static readonly ACTIVE_WRITE_THROTTLE_MS = 60_000;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  findByPath(normalizedPath: string): ProjectRow | undefined {
    const r = getRow(this.db, "SELECT * FROM projects WHERE path = ?", normalizedPath);
    return r ? mapProject(r) : undefined;
  }

  findById(id: string): ProjectRow | undefined {
    const r = getRow(this.db, "SELECT * FROM projects WHERE id = ?", id);
    return r ? mapProject(r) : undefined;
  }

  /** 列出未删除项目。 */
  list(): ProjectRow[] {
    return getRows(
      this.db,
      "SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY name ASC, last_active_at DESC",
    ).map(mapProject);
  }

  /**
   * 登记或激活项目（网关入口调用）。
   * - 不存在 → 创建；存在且软删 → 级联恢复；存在且正常 → 刷新 last_active_at（节流）。
   * 返回项目行 + 是否发生了恢复。
   */
  upsertOnRequest(rawPath: string): { project: ProjectRow; revived: boolean } {
    const path = normalizeProjectPath(rawPath);
    if (!path) throw new Error("无效的项目路径");
    const now = Date.now();
    const existing = this.findByPath(path);

    if (!existing) {
      const id = newId("prj");
      const name = deriveProjectName(path);
      this.db
        .prepare("INSERT INTO projects (id, name, path, created_at, last_active_at, deleted_at) VALUES (?,?,?,?,?,NULL)")
        .run(id, name, path, now, now);
      return { project: this.findById(id)!, revived: false };
    }

    if (existing.deletedAt !== null) {
      this.restoreCascade(existing.id, now);
      return { project: this.findById(existing.id)!, revived: true };
    }

    const lastWrite = this.lastActiveWriteAt.get(existing.id) ?? 0;
    if (now - lastWrite >= ProjectRepo.ACTIVE_WRITE_THROTTLE_MS) {
      this.db.prepare("UPDATE projects SET last_active_at = ? WHERE id = ?").run(now, existing.id);
      this.lastActiveWriteAt.set(existing.id, now);
    }
    return { project: { ...existing, lastActiveAt: now }, revived: false };
  }

  /** 软删项目 + 级联软删其对话/记忆/画像/project 知识。 */
  softDelete(id: string): boolean {
    const p = this.findById(id);
    if (!p) return false;
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").run(now, id);
      this.cascade(id, now);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 手动恢复（API 用）。 */
  restore(id: string): boolean {
    const p = this.findById(id);
    if (!p) return false;
    this.restoreCascade(id, Date.now());
    return true;
  }

  /**
   * 更新项目：改名（name）与/或换目录（path，内部规范化）。
   * 换目录校验唯一键不与其它项目冲突；记忆数据按 project_id 关联不受影响。
   */
  update(id: string, patch: { name?: string; path?: string }): ProjectRow | undefined {
    const p = this.findById(id);
    if (!p) return undefined;
    const name = patch.name?.trim();
    const path = patch.path !== undefined ? normalizeProjectPath(patch.path) : undefined;
    if (patch.path !== undefined && !path) throw new Error("无效的项目路径");
    if (!name && !path) throw new Error("无可更新字段：name 或 path 至少一项");
    if (path && path !== p.path) {
      const clash = this.findByPath(path);
      if (clash && clash.id !== id) throw new Error(`路径已被其他项目占用：${path}`);
    }
    this.db.exec("BEGIN");
    try {
      if (name) this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      if (path && path !== p.path) this.db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(path, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.findById(id);
  }

  private restoreCascade(id: string, now: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE projects SET deleted_at = NULL, last_active_at = ? WHERE id = ?").run(now, id);
      this.cascade(id, null);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 级联软删/恢复。deleted=软删时间戳；null=恢复。
   * 仅对带 deleted_at 列的表操作；knowledges 只动 project scope 的条目。
   */
  private cascade(projectId: string, deleted: number | null): void {
    const restore = deleted === null;
    const run = (table: string, extra: string) => {
      const sql = restore
        ? `UPDATE ${table} SET deleted_at = NULL WHERE project_id = ?${extra}`
        : `UPDATE ${table} SET deleted_at = ? WHERE project_id = ?${extra} AND deleted_at IS NULL`;
      const stmt = this.db.prepare(sql);
      if (restore) stmt.run(projectId);
      else stmt.run(deleted as number, projectId);
    };
    run("conversations", "");
    run("memory_items", "");
    run("profiles", "");
    run("knowledges", " AND scope = 'project'");
  }
}

// ── 项目数据库连接（新功能 1）──

export type DbType = "sqlite" | "mysql" | "postgresql" | "sqlserver";

export interface DbConnRow {
  id: string;
  projectId: string;
  name: string;
  dbType: DbType;
  connectionString: string;
  createdAt: number;
  updatedAt: number;
}

const DB_TYPES: readonly DbType[] = ["sqlite", "mysql", "postgresql", "sqlserver"];

export function isValidDbType(v: string): v is DbType {
  return (DB_TYPES as readonly string[]).includes(v);
}

function mapConn(r: SqlRow): DbConnRow {
  return {
    id: colStr(r, "id"),
    projectId: colStr(r, "project_id"),
    name: colStr(r, "name"),
    dbType: colStr(r, "db_type") as DbType,
    connectionString: colStr(r, "connection_string"),
    createdAt: colNum(r, "created_at"),
    updatedAt: colNum(r, "updated_at"),
  };
}

/**
 * 项目数据库连接仓储（新功能 1）。
 * 每项目多条连接平等可用（不再有启停状态），调用方按连接名选择；连接名在项目内唯一。
 */
export class DbConnRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(projectId: string): DbConnRow[] {
    return getRows(
      this.db,
      "SELECT * FROM project_db_connections WHERE project_id = ? ORDER BY name COLLATE NOCASE ASC",
      projectId,
    ).map(mapConn);
  }

  findById(id: string): DbConnRow | undefined {
    const r = getRow(this.db, "SELECT * FROM project_db_connections WHERE id = ?", id);
    return r ? mapConn(r) : undefined;
  }

  /** 按连接名解析单条连接（连接名项目内唯一，供 sql_query 按名选连接）。 */
  findByName(projectId: string, name: string): DbConnRow | undefined {
    const r = getRow(
      this.db,
      "SELECT * FROM project_db_connections WHERE project_id = ? AND name = ? LIMIT 1",
      projectId, name,
    );
    return r ? mapConn(r) : undefined;
  }

  /**
   * 新增或编辑连接。id 为空 → 新增；非空 → 编辑（不存在抛错）。
   * 连接名项目内唯一（UNIQUE(project_id, name) 兜底）。
   */
  save(input: {
    id?: string;
    projectId: string;
    name: string;
    dbType: DbType;
    connectionString: string;
  }): DbConnRow {
    if (!isValidDbType(input.dbType)) throw new Error(`非法数据库类型: ${input.dbType}`);
    const name = input.name.trim();
    if (!name) throw new Error("连接名不能为空");
    const now = Date.now();

    this.db.exec("BEGIN");
    let id = input.id;
    try {
      if (id) {
        const existing = this.findById(id);
        if (!existing) throw new Error(`连接不存在: ${id}`);
        const clash = getRow(
          this.db,
          "SELECT id FROM project_db_connections WHERE project_id = ? AND name = ? AND id != ?",
          input.projectId, name, id,
        );
        if (clash) throw new Error(`连接名已存在: ${name}`);
        this.db
          .prepare("UPDATE project_db_connections SET name=?, db_type=?, connection_string=?, updated_at=? WHERE id=?")
          .run(name, input.dbType, input.connectionString, now, id);
      } else {
        id = newId("conn");
        const clash = getRow(
          this.db,
          "SELECT id FROM project_db_connections WHERE project_id = ? AND name = ?",
          input.projectId, name,
        );
        if (clash) throw new Error(`连接名已存在: ${name}`);
        this.db
          .prepare(
            "INSERT INTO project_db_connections (id, project_id, name, db_type, connection_string, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
          )
          .run(id, input.projectId, name, input.dbType, input.connectionString, now, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.findById(id!)!;
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM project_db_connections WHERE id = ?").run(id);
    return r.changes > 0;
  }
}
