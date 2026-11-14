import type { DatabaseSync } from "node:sqlite";

/**
 * 类型化行映射基建。
 *
 * node:sqlite 的 `.get()/.all()` 返回 `Record<string, unknown>`（列名 → 值），
 * 直接到处 `as` 断言既不安全也噪音大。这里提供一组列读取器（col*），
 * 由仓储层的 `mapXxx(row)` 显式按列取值并转型，得到编译期可检查的强类型行对象。
 *
 * 约定：
 *  - `row` 为 prepare().get()/all() 的原始结果；
 *  - 非空列用 colStr/colNum/colBool（缺失即数据异常，抛错）；
 *  - 可空列用 colStrOrNull/colNumOrNull（NULL / undefined → null）。
 */

export type SqlRow = Record<string, unknown>;

/** 查询单行（无结果返回 undefined）。 */
export function getRow(db: DatabaseSync, sql: string, ...params: unknown[]): SqlRow | undefined {
  const r = db.prepare(sql).get(...(params as (string | number | bigint | null | Uint8Array)[]));
  return r as SqlRow | undefined;
}

/** 查询多行。 */
export function getRows(db: DatabaseSync, sql: string, ...params: unknown[]): SqlRow[] {
  const rows = db.prepare(sql).all(...(params as (string | number | bigint | null | Uint8Array)[]));
  return rows as SqlRow[];
}

/** 查询单列标量（如 COUNT），无结果返回 undefined。 */
export function getScalar<T = unknown>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  const r = getRow(db, sql, ...params);
  if (!r) return undefined;
  const first = Object.values(r)[0];
  return first as T;
}

function missing(row: SqlRow, col: string): never {
  throw new Error(`行数据缺失列: ${col}`);
}

export function colStr(row: SqlRow, col: string): string {
  const v = row[col];
  if (typeof v !== "string") missing(row, col);
  return v;
}

export function colNum(row: SqlRow, col: string): number {
  const v = row[col];
  if (typeof v !== "number") missing(row, col);
  return v;
}

export function colBool(row: SqlRow, col: string): boolean {
  const v = row[col];
  if (typeof v !== "number") missing(row, col);
  return v !== 0;
}

export function colStrOrNull(row: SqlRow, col: string): string | null {
  const v = row[col];
  return v === null || v === undefined ? null : String(v);
}

export function colNumOrNull(row: SqlRow, col: string): number | null {
  const v = row[col];
  return v === null || v === undefined ? null : Number(v);
}

/** JSON 文本列解析为指定类型（NULL / 空 → fallback）。 */
export function colJson<T>(row: SqlRow, col: string, fallback: T): T {
  const v = colStrOrNull(row, col);
  if (v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
