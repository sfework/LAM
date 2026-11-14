import { assertReadOnlySql, SqlGuardError } from "./guard.js";
import { Dialects, describeDriverError } from "./drivers.js";
import type { SqlDialect, SqlRows } from "./drivers.js";
import type { DbConnRepo, DbType } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import type { ProjectRepo } from "../projects/repo.js";

/**
 * SQL 查询服务（新功能 2：按项目 + 连接名解析连接）。
 *
 * 调用方传 project_path + conn（连接名），服务端按名查找该项目的连接并按其 db_type 路由方言驱动。
 * 连接不再有启停状态，多条连接平等可用；先调 list_db_connections 可获知可用连接名与类型。
 * 项目未配置对应连接名 → 返回"未找到数据库连接"（区别于连接失败）。
 */

export interface SqlQueryResult {
  ok: boolean;
  /** 成功时的行集。 */
  rows?: SqlRows;
  /** 截断提示（行数超上限时）。 */
  truncated?: boolean;
  /** 失败时的面向模型文案。 */
  error?: string;
}

export class SqlService {
  private readonly projects: ProjectRepo;
  private readonly conns: DbConnRepo;
  private readonly maxRows: () => number;

  constructor(deps: { projects: ProjectRepo; conns: DbConnRepo; maxRows: () => number }) {
    this.projects = deps.projects;
    this.conns = deps.conns;
    this.maxRows = deps.maxRows;
  }

  /** 按项目路径 + 连接名解析连接（找不到返回 null，供上层组装文案）。 */
  resolveConnection(projectPath: string, connName: string): { dbType: DbType; connectionString: string; connName: string } | null {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) return null;
    const project = this.projects.findByPath(normalized);
    if (!project || project.deletedAt !== null) return null;
    const conn = this.conns.findByName(project.id, connName.trim());
    if (!conn) return null;
    return { dbType: conn.dbType, connectionString: conn.connectionString, connName: conn.name };
  }

  /** 列出项目的可用数据库连接（只返回名称与类型，不回显连接串）。 */
  listConnections(projectPath: string): { name: string; dbType: DbType }[] | null {
    const normalized = normalizeProjectPath(projectPath);
    if (!normalized) return null;
    const project = this.projects.findByPath(normalized);
    if (!project || project.deletedAt !== null) return null;
    return this.conns.list(project.id).map((c) => ({ name: c.name, dbType: c.dbType }));
  }

  /** 执行只读查询：守卫 → 按名解析连接 → 方言路由 → 行数截断。 */
  async queryByProject(projectPath: string, connName: string, sqlQuery: string): Promise<SqlQueryResult> {
    // 1. 只读守卫（先于连接解析：非法 SQL 的报错优先于"未配置"）
    try {
      assertReadOnlySql(sqlQuery);
    } catch (err) {
      if (err instanceof SqlGuardError) return { ok: false, error: err.message };
      throw err;
    }

    // 2. 按项目 + 连接名解析（未找到 → 明确文案，并提示可用连接名供自我修正）
    const resolved = this.resolveConnection(projectPath, connName);
    if (!resolved) {
      const available = this.listConnections(projectPath) ?? [];
      const hint = available.length
        ? `可用连接：${available.map((c) => `${c.name}(${c.dbType})`).join("、")}`
        : "该项目未配置任何数据库连接";
      return {
        ok: false,
        error: `未找到数据库连接：项目 ${projectPath} 没有名为「${connName}」的连接（${hint}）`,
      };
    }

    // 3. 方言路由 + 执行
    const dialect = resolved.dbType as SqlDialect;
    try {
      const rows = await Dialects[dialect].query(resolved.connectionString, sqlQuery);
      const cap = this.maxRows();
      if (rows.length > cap) {
        return { ok: true, rows: rows.slice(0, cap), truncated: true };
      }
      return { ok: true, rows };
    } catch (err) {
      return { ok: false, error: `查询失败（连接 ${resolved.connName}）: ${describeDriverError(err)}` };
    }
  }
}
