import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { normalizeProjectPath, deriveProjectName } from "./normalize.js";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastActiveAt: number;
  deletedAt: number | null;
}

function toProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    createdAt: r.created_at as number,
    lastActiveAt: r.last_active_at as number,
    deletedAt: (r.deleted_at as number | null) ?? null,
  };
}

/**
 * 项目仓储（DESIGN §2.2）。
 * - 纯自动登记：规范化 path 为唯一键。
 * - 软删级联：projects / mem_l0 / mem_l1 / mem_l2 / knowledge(project scope) / cg_* 一起打 deleted_at。
 * - 恢复：命中软删项目再次请求时，级联取消软删（deleted_at 置 NULL）。
 */
export class ProjectRepo {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  /** 按规范化路径查项目（含软删）。 */
  findByPath(normalizedPath: string): ProjectRow | undefined {
    const r = this.raw.prepare("SELECT * FROM projects WHERE path = ?").get(normalizedPath) as
      | Record<string, unknown>
      | undefined;
    return r ? toProject(r) : undefined;
  }

  findById(id: string): ProjectRow | undefined {
    const r = this.raw.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toProject(r) : undefined;
  }

  /** 列出未删除项目。 */
  list(): ProjectRow[] {
    const rows = this.raw
      .prepare("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY name ASC, last_active_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map(toProject);
  }

  /**
   * 登记或激活项目（网关入口调用）。
   * - 不存在 → 创建；
   * - 存在且软删 → 级联恢复；
   * - 存在且正常 → 仅刷新 last_active_at。
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
      this.raw
        .prepare(
          "INSERT INTO projects (id, name, path, created_at, last_active_at, deleted_at) VALUES (?,?,?,?,?,NULL)",
        )
        .run(id, name, path, now, now);
      return { project: this.findById(id)!, revived: false };
    }

    if (existing.deletedAt !== null) {
      this.restoreCascade(existing.id, now);
      return { project: this.findById(existing.id)!, revived: true };
    }

    this.raw.prepare("UPDATE projects SET last_active_at = ? WHERE id = ?").run(now, existing.id);
    return { project: this.findById(existing.id)!, revived: false };
  }

  /** 软删项目 + 级联软删其记忆、project 知识、CodeGraph 数据。 */
  softDelete(id: string): boolean {
    const p = this.findById(id);
    if (!p) return false;
    const now = Date.now();
    this.raw.exec("BEGIN");
    try {
      this.raw.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").run(now, id);
      this.cascadeSoftDelete(id, now);
      this.raw.exec("COMMIT");
      return true;
    } catch (err) {
      this.raw.exec("ROLLBACK");
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
   * - 换目录：规范化后校验唯一键不与其他项目冲突（含软删项，避免恢复时撞车）；
   * - 记忆/CodeGraph 数据按 project_id 关联，换目录不动这些数据；
   *   但 watcher 监听的是绝对根路径，CodeGraph 索引 path 是相对根路径——
   *   换目录后由调用方（API 层）触发 CodeGraphService.relocate 停旧监听并重建。
   * 无任何可更新字段时抛错；项目不存在返回 undefined。
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
    this.raw.exec("BEGIN");
    try {
      if (name) this.raw.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      if (path && path !== p.path) this.raw.prepare("UPDATE projects SET path = ? WHERE id = ?").run(path, id);
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
    return this.findById(id);
  }

  private restoreCascade(id: string, now: number): void {
    this.raw.exec("BEGIN");
    try {
      this.raw
        .prepare("UPDATE projects SET deleted_at = NULL, last_active_at = ? WHERE id = ?")
        .run(now, id);
      this.cascadeSoftDelete(id, null);
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 级联软删/恢复。deleted=软删时间戳；null=恢复。
   * 仅对带 deleted_at 列的表操作；knowledge 只动 project scope 的条目。
   */
  private cascadeSoftDelete(projectId: string, deleted: number | null): void {
    // 恢复：deleted_at = NULL（不加 IS NULL 过滤，直接清）；软删：SET = ts WHERE IS NULL
    const restore = deleted === null;
    const sql = (table: string, extra: string) =>
      restore
        ? `UPDATE ${table} SET deleted_at = NULL WHERE project_id = ?${extra}`
        : `UPDATE ${table} SET deleted_at = ? WHERE project_id = ?${extra} AND deleted_at IS NULL`;
    const run = (table: string, extra: string) => {
      const stmt = this.raw.prepare(sql(table, extra));
      if (restore) stmt.run(projectId);
      else stmt.run(deleted as number, projectId);
    };

    run("mem_l0", "");
    run("mem_l1", "");
    run("mem_l2", "");
    run("knowledge", " AND scope = 'project'");
    // CodeGraph（决策 67）：图数据外置于 {DATA_DIR}/codegraph/，gateway.db 不再有 cg_* 级联表；
    // 软删仅停激活（CodeGraphService.deactivate），恢复时重新激活，索引库原地保留。
  }
}
