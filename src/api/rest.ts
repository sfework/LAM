import { Hono, type Context } from "hono";

/**
 * /api/* 统一调用约定（DESIGN 决策 45 + 47）。
 *
 * 对齐前端 `@sfework/common` 的 NetBase 约定（配套 C# 后端的
 * ServiceResult / PaginationModel），管理接口契约：
 *
 * 1. **一律 POST + JSON body**（决策 45）：路径 `/api/<资源>/<action>`（全小写连字符），
 *    参数全进 body。前端用 `Net.api.projects.list(...)`、`Net.api["denoise-rules"]["get-by-path"](...)`
 *    生成正好对应的小写路径（area='api'），无需后端做大小写归一。
 * 2. **响应包络**（决策 47，对齐 C# `ServiceResult`）：
 *    成功 `{ success: true, code: 0, message: null, data }`；
 *    失败 `{ success: false, code: <HTTP 状态>, message, data: null }`。
 *    前端 NetBase 只读 success/code/message/data，code 同时承载 HTTP 状态。
 * 3. **列表分页**（决策 47）：`/list` 吃 `PaginationRequest`（`{ page, pageSize, ...筛选 }`）、
 *    返回 `PaginationModel`（`{ list, totalCount, page, pageSize, totalPage, hasNextPage, hasPreviousPage }`），
 *    与前端 `DataTable` / `GetPaginationModel` 直接对接（内存分页，个人本地数据量小）。
 *
 * 动作词表：list / get / create / update / delete + 资源专属动作（toggle/restore/rebuild/set…）。
 */

/** 业务错误：带 HTTP 状态与错误码，由 handler 包装器统一转包络。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string): never {
  throw new ApiError(400, "bad_request", message);
}
export function notFound(message: string): never {
  throw new ApiError(404, "not_found", message);
}

/** 解析 JSON body（容忍空体 → {}）。 */
export async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

/** 取必填字符串字段（trim 后非空），否则 400。 */
export function requireStr(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v !== "string" || !v.trim()) badRequest(`缺少参数: ${key}`);
  return (v as string).trim();
}
export function optStr(b: Record<string, unknown>, key: string): string | undefined {
  const v = b[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}
export function optBool(b: Record<string, unknown>, key: string): boolean | undefined {
  return typeof b[key] === "boolean" ? (b[key] as boolean) : undefined;
}
export function optNum(b: Record<string, unknown>, key: string): number | undefined {
  const v = b[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 处理器：从 body 取参、返回 data；未找到时调用 notFound() 抛错。返回 undefined/null 视为正常空结果。 */
export type Handler = (body: Record<string, unknown>) => unknown | Promise<unknown>;

/** 成功包络（对齐 C# ServiceResult：code=0 即成功，message 为空）。 */
export function okBody(data: unknown): { success: true; code: 0; message: null; data: unknown } {
  return { success: true, code: 0, message: null, data: data ?? null };
}

/** 失败包络：code 复用 HTTP 状态，便于前端 callBack 按状态分流。 */
export function errBody(code: number, message: string): { success: false; code: number; message: string; data: null } {
  return { success: false, code, message, data: null };
}

/** 把一个 Handler 包成 Hono 路由（统一 try/catch → 包络体）。 */
export function h(fn: Handler): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      const data = await fn(await bodyOf(c));
      return c.json(okBody(data));
    } catch (err) {
      if (err instanceof ApiError) return c.json(errBody(err.status, err.message), err.status as 400);
      throw err;
    }
  };
}

/** 便捷：路由表 { 动作路径: Handler } → 全部注册为 POST。 */
export function postRoutes(routes: Record<string, Handler>): Hono {
  const app = new Hono();
  for (const [path, fn] of Object.entries(routes)) app.post(path, h(fn));
  return app;
}

/* ───────────────────────────── 分页（决策 47） ───────────────────────────── */

/** 前端 DataTable 期望的分页模型（对齐 @sfework/common 的 GetPaginationModel）。 */
export interface PageModel<T> {
  list: T[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPage: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

/** 列表默认页大小（与参考项目 GetPaginationRequest 的 30 一致）。 */
export const DEFAULT_PAGE_SIZE = 30;

/**
 * 内存分页：从 body 读 page/pageSize（缺省 1 / DEFAULT_PAGE_SIZE），对已排序行切片。
 * 个人本地数据量小，不下推 SQL 分页；筛选参数由各路由自行从 body 取用。
 */
export function paginate<T>(rows: readonly T[], body: Record<string, unknown>, defaultPageSize = DEFAULT_PAGE_SIZE): PageModel<T> {
  const page = Math.max(1, Math.trunc(optNum(body, "page") ?? 1));
  const pageSize = Math.max(1, Math.trunc(optNum(body, "pageSize") ?? defaultPageSize));
  const totalCount = rows.length;
  const totalPage = Math.max(1, Math.ceil(totalCount / pageSize));
  const start = (page - 1) * pageSize;
  return {
    list: rows.slice(start, start + pageSize),
    totalCount,
    page,
    pageSize,
    totalPage,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPage,
  };
}

/** 列表路由：处理器只需返回全量数组，本函数负责按 page/pageSize 切片。 */
export function listRoute<T>(fetch: (body: Record<string, unknown>) => readonly T[] | Promise<readonly T[]>, defaultPageSize?: number): Handler {
  return async (body) => paginate(await fetch(body), body, defaultPageSize);
}
