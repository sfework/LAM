/**
 * SQL 工具的方言驱动层（移植自参考实现的 SqlTools.cs 四库支持）。
 *
 * 每个方言暴露三个操作：query / listTables / describeTable，返回行对象数组。
 * 驱动全部**懒加载**（dynamic import）：mssql/tedious 体积大，只在真正调用对应工具时才加载。
 *
 * 连接串口径与 C#/ADO.NET 客户端一致，便于复用既有连接串：
 * - sqlite：文件路径，或 `Data Source=...;` / `file:` URI；
 * - postgresql：pg 原生口径（URI 或 keyword=value），原样透传；
 * - mysql：`mysql://...` URI 或 `Server=...;Database=...;Uid=...;Pwd=...;`；
 * - sqlserver：`Server=...;Database=...;User Id=...;Password=...;TrustServerCertificate=True;`。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { config as MssqlConfig } from "mssql";
import { localDateTimeStr } from "../infra/localtime.js";
import { SqlGuardError, assertSafeIdentifier } from "./guard.js";

export type SqlDialect = "sqlite" | "postgresql" | "mysql" | "sqlserver";

/** 行集：列名 → 归一化后的 JSON 安全值。 */
export type SqlRows = Record<string, unknown>[];

export interface TableInfo {
  name: string;
  /** 表/视图（有的方言附带 schema）。 */
  type: string;
  schema?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: unknown;
  /** 主键（能取到时给出）。 */
  primaryKey?: boolean;
  comment?: string;
}

/** 安全整数范围外的大整数转字符串，避免 JSON 精度丢失。 */
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = BigInt(Number.MIN_SAFE_INTEGER);

function isBinary(v: unknown): v is ArrayBufferView {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/** 各驱动返回类型不一（Date/BigInt/Buffer），统一转成 JSON 可序列化且可读的值。 */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return localDateTimeStr(v);
  if (typeof v === "bigint") {
    if (v > MAX_SAFE_BIG || v < MIN_SAFE_BIG) return v.toString();
    return Number(v);
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (isBinary(v)) return Buffer.from(v as Uint8Array).toString("base64");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (typeof v === "object") {
    // pg 的 json/jsonb 已解析为对象；其余驱动偶发返回对象包装，统一序列化一次
    const record: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) record[k] = normalizeValue(val);
    return record;
  }
  return v;
}

function normalizeRows(rows: Record<string, unknown>[]): SqlRows {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
    return out;
  });
}

/** 驱动错误 → 面向模型的文案（与 C# 版 QueryFailed 同口径：作为结果文本返回而非抛出异常包装）。 */
export function describeDriverError(err: unknown): string {
  const e = err as { message?: string; code?: string; sqlMessage?: string };
  const msg = e?.sqlMessage || e?.message || String(err);
  return e?.code ? `${msg}（${e.code}）` : msg;
}

// ─────────── 连接串解析 ───────────

/**
 * 解析 `key=value;key2=value2` 形式（ADO.NET 口径）：
 * 键大小写不敏感；值可含空格；值用双/单引号包裹时段内的分号不算分隔符（如 `Pwd="a;b"`）。
 */
export function parseKeyValue(connectionString: string): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  while (i < connectionString.length) {
    const eq = connectionString.indexOf("=", i);
    if (eq < 0) break;
    const key = connectionString.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    // 跳过值前空白
    while (j < connectionString.length && connectionString[j] === " ") j++;
    const quote = connectionString[j];
    let value: string;
    let next: number;
    if (quote === '"' || quote === "'") {
      const end = connectionString.indexOf(quote, j + 1);
      value = end < 0 ? connectionString.slice(j + 1) : connectionString.slice(j + 1, end);
      next = end < 0 ? connectionString.length : end + 1;
      const semi = connectionString.indexOf(";", next);
      next = semi < 0 ? connectionString.length : semi + 1;
    } else {
      const semi = connectionString.indexOf(";", j);
      value = semi < 0 ? connectionString.slice(j) : connectionString.slice(j, semi);
      next = semi < 0 ? connectionString.length : semi + 1;
      value = value.trim();
    }
    if (key) map.set(key, value);
    i = next;
  }
  return map;
}

function pick(map: Map<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map.get(k);
    if (v) return v;
  }
  return undefined;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return /^(true|yes|1)$/i.test(v.trim());
}

/** SQLite：从连接串取出数据库文件路径。 */
export function resolveSqliteLocation(connectionString: string): string {
  const raw = connectionString.trim();
  if (!raw) throw new SqlGuardError("连接字符串不能为空");
  if (raw === ":memory:") return raw;
  if (raw.startsWith("file:")) return raw;
  if (raw.includes("=")) {
    const ds = pick(parseKeyValue(raw), "data source", "datasource", "filename", "database");
    if (!ds) throw new SqlGuardError("SQLite 连接串缺少 Data Source（数据库文件路径）");
    return ds.trim();
  }
  return raw;
}

/** 主机串 `host,port` / `host:port` / `host\instance` → { host, port? }。 */
function splitHostPort(value: string): { host: string; port?: number } {
  const v = value.trim();
  const comma = v.lastIndexOf(",");
  if (comma > 0) {
    const port = Number.parseInt(v.slice(comma + 1), 10);
    if (Number.isFinite(port)) return { host: v.slice(0, comma), port };
  }
  const colon = v.lastIndexOf(":");
  if (colon > 0 && !v.includes("]")) {
    const port = Number.parseInt(v.slice(colon + 1), 10);
    if (Number.isFinite(port)) return { host: v.slice(0, colon), port };
  }
  return { host: v.replace(/\\/g, "/") };
}

// ─────────── SQLite ───────────

function openSqliteReadonly(connectionString: string): DatabaseSync {
  const location = resolveSqliteLocation(connectionString);
  // 只读模式下 SQLite 不会创建文件，缺失即报错——提前给出可读文案（否则只有笼统的 unable to open）
  if (location !== ":memory:" && !location.startsWith("file:") && !existsSync(location)) {
    throw new SqlGuardError(`SQLite 数据库文件不存在: ${location}`);
  }
  let db: DatabaseSync;
  try {
    // readOnly：即使校验被绕过也无法写入（第二层防护）
    db = new DatabaseSync(location, { readOnly: true });
  } catch (err) {
    // 部分位置（如 :memory: 的某些形态）不支持只读打开，降级为普通打开（写侧仍由 guard 拦截）
    const e = err as { message?: string };
    if (!/readonly|read-only/i.test(e?.message ?? "")) throw err;
    db = new DatabaseSync(location);
  }
  try {
    db.exec("PRAGMA query_only = ON;");
  } catch {
    /* 某些构建不支持该 pragma，忽略 */
  }
  return db;
}

function sqliteAll(db: DatabaseSync, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  const rows = stmt.all(...(params as never[]));
  return rows as Record<string, unknown>[];
}

async function sqliteQuery(connectionString: string, sql: string): Promise<SqlRows> {
  const db = openSqliteReadonly(connectionString);
  try {
    return normalizeRows(sqliteAll(db, sql));
  } finally {
    db.close();
  }
}

async function sqliteListTables(connectionString: string, keyword?: string): Promise<TableInfo[]> {
  const db = openSqliteReadonly(connectionString);
  try {
    const like = `%${keyword ?? ""}%`;
    const rows = sqliteAll(
      db,
      `SELECT name, type FROM sqlite_master
        WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND lower(name) LIKE lower(?)
        ORDER BY type, name`,
      [like],
    );
    return rows.map((r) => ({ name: String(r.name), type: String(r.type) }));
  } finally {
    db.close();
  }
}

async function sqliteDescribe(connectionString: string, table: string): Promise<ColumnInfo[]> {
  const name = assertSafeIdentifier(table, "表名");
  const bare = name.split(".").pop()!;
  const db = openSqliteReadonly(connectionString);
  try {
    const cols = sqliteAll(db, `PRAGMA table_info(${JSON.stringify(bare)})`);
    const pk = new Set(cols.filter((c) => Number(c.pk) > 0).map((c) => String(c.name)));
    return cols.map((c) => ({
      name: String(c.name),
      type: String(c.type ?? ""),
      nullable: Number(c.notnull) === 0,
      defaultValue: c.dflt_value ?? null,
      primaryKey: pk.has(String(c.name)),
    }));
  } finally {
    db.close();
  }
}

// ─────────── PostgreSQL ───────────

async function pgClient(connectionString: string, sql: string, params: unknown[] = []) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, statement_timeout: 30_000 });
  await client.connect();
  try {
    const res = await client.query(sql, params as unknown[]);
    return res.rows as Record<string, unknown>[];
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function pgQuery(connectionString: string, sql: string): Promise<SqlRows> {
  return normalizeRows(await pgClient(connectionString, sql));
}

async function pgListTables(connectionString: string, keyword?: string): Promise<TableInfo[]> {
  const like = `%${keyword ?? ""}%`;
  const rows = await pgClient(
    connectionString,
    `SELECT table_schema AS schema, table_name AS name, table_type AS type
       FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema') AND lower(table_name) LIKE lower($1)
      ORDER BY table_schema, table_name`,
    [like],
  );
  return rows.map((r) => ({ name: String(r.name), type: String(r.type), schema: String(r.schema) }));
}

async function pgDescribe(connectionString: string, table: string): Promise<ColumnInfo[]> {
  const name = assertSafeIdentifier(table, "表名");
  const [schema, bare] = name.includes(".") ? [name.split(".")[0]!, name.split(".").pop()!] : ["public", name];
  const rows = await pgClient(
    connectionString,
    `SELECT c.column_name AS name, c.data_type AS type, c.is_nullable AS nullable, c.column_default AS "defaultValue",
            c.ordinal_position AS pos,
            (SELECT count(*) FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage k
                 ON k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
              WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name
                AND tc.constraint_type = 'PRIMARY KEY' AND k.column_name = c.column_name) AS is_pk
       FROM information_schema.columns c
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position`,
    [schema, bare],
  );
  return rows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    nullable: r.nullable === "YES",
    defaultValue: r.defaultValue ?? null,
    primaryKey: Number(r.is_pk) > 0,
  }));
}

// ─────────── MySQL ───────────

function mysqlOptions(connectionString: string): string | Record<string, unknown> {
  const raw = connectionString.trim();
  if (raw.startsWith("mysql://") || raw.startsWith("mysql+srv://")) return raw;
  const kv = parseKeyValue(raw);
  const host = pick(kv, "server", "host", "data source") ?? "localhost";
  const { host: h, port } = splitHostPort(host);
  const opts: Record<string, unknown> = {
    host: h,
    database: pick(kv, "database", "initial catalog"),
    user: pick(kv, "uid", "user id", "user", "username"),
    password: pick(kv, "pwd", "password"),
    // 与 C# 驱动一致：DATETIME 直接给字符串，避免时区偏移
    dateStrings: true,
  };
  const p = port ?? (pick(kv, "port") ? Number.parseInt(pick(kv, "port")!, 10) : undefined);
  if (Number.isFinite(p)) opts.port = p;
  if (truthy(pick(kv, "ssl mode", "sslmode", "ssl"))) opts.ssl = { rejectUnauthorized: false };
  return opts;
}

async function mysqlQuery(connectionString: string, sql: string): Promise<SqlRows> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(mysqlOptions(connectionString) as never);
  try {
    const [rows] = await conn.query({ sql, timeout: 30_000 }, []);
    return normalizeRows(Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function mysqlListTables(connectionString: string, keyword?: string): Promise<TableInfo[]> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(mysqlOptions(connectionString) as never);
  try {
    const [rows] = await conn.query(
      `SELECT table_schema AS \`schema\`, table_name AS name, table_type AS type
         FROM information_schema.tables
        WHERE table_schema = DATABASE() AND lower(table_name) LIKE lower(?)
        ORDER BY table_name`,
      [`%${keyword ?? ""}%`],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: String(r.name),
      type: String(r.type),
      schema: String(r.schema),
    }));
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function mysqlDescribe(connectionString: string, table: string): Promise<ColumnInfo[]> {
  const mysql = await import("mysql2/promise");
  const name = assertSafeIdentifier(table, "表名");
  const [schema, bare] = name.includes(".") ? [name.split(".")[0]!, name.split(".").pop()!] : [undefined, name];
  const conn = await mysql.createConnection(mysqlOptions(connectionString) as never);
  try {
    const where = schema ? "TABLE_SCHEMA = ? AND TABLE_NAME = ?" : "TABLE_NAME = ?";
    const params = schema ? [schema, bare] : [bare];
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS \`defaultValue\`, COLUMN_KEY AS keyFlag, COLUMN_COMMENT AS comment,
              ORDINAL_POSITION AS pos
         FROM information_schema.COLUMNS
        WHERE ${where}
        ORDER BY ORDINAL_POSITION`,
      params,
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: r.nullable === "YES",
      defaultValue: r.defaultValue ?? null,
      primaryKey: String(r.keyFlag ?? "") === "PRI",
      comment: r.comment ? String(r.comment) : undefined,
    }));
  } finally {
    await conn.end().catch(() => undefined);
  }
}

// ─────────── SQL Server ───────────

async function mssqlPool(connectionString: string) {
  const sql = await import("mssql");
  const kv = parseKeyValue(connectionString);
  const hostRaw = pick(kv, "server", "data source", "host") ?? "localhost";
  const { host, port } = splitHostPort(hostRaw);
  const config: MssqlConfig = {
    server: host,
    database: pick(kv, "database", "initial catalog"),
    user: pick(kv, "user id", "uid", "user"),
    password: pick(kv, "password", "pwd"),
    options: {
      // 与 ADO.NET 口径一致：未显式写 Encrypt=False 即加密（本地实例通常配 TrustServerCertificate=True）
      encrypt: !/^(false|no|0)$/i.test(pick(kv, "encrypt")?.trim() ?? ""),
      trustServerCertificate: truthy(pick(kv, "trustservercertificate", "trust server certificate")),
      enableArithAbort: true,
    },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
  };
  if (Number.isFinite(port)) config.port = port;
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  return { sql, pool };
}

async function mssqlQuery(connectionString: string, sqlText: string): Promise<SqlRows> {
  const { pool } = await mssqlPool(connectionString);
  try {
    const res = await pool.request().query(sqlText);
    return normalizeRows((res.recordset ?? []) as Record<string, unknown>[]);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

async function mssqlListTables(connectionString: string, keyword?: string): Promise<TableInfo[]> {
  const { sql, pool } = await mssqlPool(connectionString);
  try {
    const res = await pool
      .request()
      .input("like", sql.NVarChar, `%${keyword ?? ""}%`)
      .query(
        `SELECT s.name AS [schema], t.name AS [name], t.type_desc AS [type]
           FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
          WHERE LOWER(t.name) LIKE LOWER(@like)
          UNION ALL
          SELECT s.name, v.name, 'VIEW'
            FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id
           WHERE LOWER(v.name) LIKE LOWER(@like)
          ORDER BY 1, 2`,
      );
    return (res.recordset ?? []).map((r) => ({
      name: String(r.name),
      type: String(r.type).toLowerCase().includes("view") ? "VIEW" : "BASE TABLE",
      schema: String(r.schema),
    }));
  } finally {
    await pool.close().catch(() => undefined);
  }
}

async function mssqlDescribe(connectionString: string, table: string): Promise<ColumnInfo[]> {
  const { sql, pool } = await mssqlPool(connectionString);
  const name = assertSafeIdentifier(table, "表名");
  const [schema, bare] = name.includes(".") ? [name.split(".")[0]!, name.split(".").pop()!] : ["dbo", name];
  try {
    const res = await pool
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, bare)
      .query(
        `SELECT c.name AS [name], TYPE_NAME(c.user_type_id) AS [type],
                c.is_nullable AS [nullable], ObjectDefinition(c.default_object_id) AS [defaultValue],
                c.column_id AS [pos],
                CASE WHEN EXISTS (
                  SELECT 1 FROM sys.index_columns ic
                    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                   WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND i.is_primary_key = 1
                ) THEN 1 ELSE 0 END AS [isPk]
           FROM sys.columns c
          WHERE c.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@table))
          ORDER BY c.column_id`,
      );
    return (res.recordset ?? []).map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: Number(r.nullable) === 1,
      defaultValue: r.defaultValue ?? null,
      primaryKey: Number(r.isPk) === 1,
    }));
  } finally {
    await pool.close().catch(() => undefined);
  }
}

// ─────────── 对外统一入口 ───────────

export const Dialects = {
  sqlite: { query: sqliteQuery, listTables: sqliteListTables, describe: sqliteDescribe },
  postgresql: { query: pgQuery, listTables: pgListTables, describe: pgDescribe },
  mysql: { query: mysqlQuery, listTables: mysqlListTables, describe: mysqlDescribe },
  sqlserver: { query: mssqlQuery, listTables: mssqlListTables, describe: mssqlDescribe },
} satisfies Record<SqlDialect, {
  query: (cs: string, sql: string) => Promise<SqlRows>;
  listTables: (cs: string, keyword?: string) => Promise<TableInfo[]>;
  describe: (cs: string, table: string) => Promise<ColumnInfo[]>;
}>;
