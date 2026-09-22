/**
 * SQL 查询服务（DESIGN §3：MCP 工具 → /internal/* → 此服务；不直连主库，连接串由调用方提供）。
 *
 * 与参考实现 SqlTools.cs 的口径一致：
 * - 仅允许 SELECT/WITH 只读语句（guard 校验，失败即返回文案，不抛给客户端包装成笼统错误）；
 * - 结果转 JSON 安全的行对象数组，日期统一 `yyyy-MM-dd HH:mm:ss`；
 * - 错误作为**文本结果**返回（`{ error }`），避免被 MCP 客户端包成"调用失败"而丢失原因。
 *
 * 本项目额外加固：行数上限（settings `sql_query_max_rows`）与截断提示——
 * 工具输出直接进模型上下文，无上限的 SELECT * 会瞬间撑爆窗口。
 */

import { createLogger } from "../infra/logger.js";
import { Dialects, describeDriverError, normalizeValue, type SqlDialect } from "./drivers.js";
import { SqlGuardError, assertReadOnlySql } from "./guard.js";

const log = createLogger("sql");

/** 兜底行数上限（settings 不可用时；与注册表默认值一致）。 */
const DEFAULT_MAX_ROWS = 200;

export interface SqlQueryResult {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
}

export interface SqlServiceDeps {
  /** 行数上限提供者（读 settings.sql_query_max_rows，每次调用取最新值以支持热更新）。 */
  maxRows?: () => number;
}

/** 校验 + 执行，失败统一抛 {@link SqlError}（由 internal 端点转成 `{ error }` 文本）。 */
export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}

function maxRowsOf(deps: SqlServiceDeps): number {
  const n = deps.maxRows?.();
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : DEFAULT_MAX_ROWS;
}

export class SqlService {
  private readonly deps: SqlServiceDeps;

  constructor(deps: SqlServiceDeps = {}) {
    this.deps = deps;
  }

  async query(dialect: SqlDialect, connectionString: string, sqlQuery: string): Promise<SqlQueryResult> {
    const maxRows = maxRowsOf(this.deps);
    let rows: Record<string, unknown>[];
    try {
      assertReadOnlySql(sqlQuery);
      rows = await Dialects[dialect].query(connectionString, sqlQuery);
    } catch (err) {
      throw new SqlError(this.failMessage(err));
    }

    const truncated = rows.length > maxRows;
    const kept = truncated ? rows.slice(0, maxRows) : rows;
    if (truncated) log.debug({ dialect, total: rows.length, maxRows }, "SQL 查询结果被截断");
    return { rows: kept.map((r) => normalizeValue(r)), rowCount: rows.length, truncated, maxRows };
  }

  async listTables(dialect: SqlDialect, connectionString: string, keyword?: string): Promise<unknown[]> {
    try {
      return await Dialects[dialect].listTables(connectionString, keyword);
    } catch (err) {
      throw new SqlError(this.failMessage(err));
    }
  }

  async describeTable(dialect: SqlDialect, connectionString: string, table: string): Promise<unknown[]> {
    try {
      return await Dialects[dialect].describe(connectionString, table);
    } catch (err) {
      throw new SqlError(this.failMessage(err));
    }
  }

  /** 校验失败原样返回；驱动异常加"查询失败："前缀（同 C# 版 QueryFailed）。 */
  private failMessage(err: unknown): string {
    if (err instanceof SqlGuardError) return err.message;
    return `查询失败：${describeDriverError(err)}`;
  }
}
