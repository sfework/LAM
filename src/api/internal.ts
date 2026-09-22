import { Hono, type Context } from "hono";
import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import type { AssetsRepo } from "../assets/repo.js";
import type { L1Store } from "../memory/l1-store.js";
import type { L0Recorder } from "../memory/l0-recorder.js";
import type { L2Refiner } from "../memory/l2-refiner.js";
import type { MemoryRecaller } from "../memory/recall.js";
import type { SettingsService } from "../settings/service.js";
import type { CodeGraphService } from "../codegraph/service.js";
import { SqlError, type SqlService } from "../sql/service.js";
import type { SqlDialect } from "../sql/drivers.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("internal");

/**
 * 内部只读 API（/internal/*）——供 MCP 薄壳经 HTTP 调用（DESIGN §3、决策：MCP 薄壳不直连 DB）。
 * 无鉴权（本地），只读，字段裁剪到工具所需。
 *
 * 工具类端点统一接收 project_path（规范化），内部解析为 projectId。
 */
export interface InternalDeps {
  projects: ProjectRepo;
  assets: AssetsRepo;
  l1: L1Store;
  l0: L0Recorder;
  l2: L2Refiner;
  recaller: MemoryRecaller;
  settings: SettingsService;
  codegraph: CodeGraphService;
  sql: SqlService;
}

export function createInternalRouter(deps: InternalDeps): Hono {
  const app = new Hono();

  // ── knowledge ──
  app.get("/knowledge/list", (c) => {
    const projectId = resolveProjectId(deps, c);
    const rows = deps.assets
      .listKnowledge()
      .filter((k) => k.enabled && (k.scope === "global" || (projectId && k.projectId === projectId)));
    return ok(c, rows.map((k) => ({ id: k.id, title: k.title, description: k.description, scope: k.scope })));
  });
  app.get("/knowledge/read", (c) => {
    const id = c.req.query("id");
    if (!id) return bad(c, "id 必填");
    const k = deps.assets.getKnowledge(id);
    if (!k) return notFound(c, "knowledge", id);
    return ok(c, { id: k.id, title: k.title, description: k.description, body: k.body, scope: k.scope });
  });

  // ── agents ──
  app.get("/agents/list", (c) => ok(c, deps.assets.listAgents().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, description: a.description }))));
  app.get("/agents/read", (c) => {
    const id = c.req.query("id");
    if (!id) return bad(c, "id 必填");
    const a = deps.assets.getAgent(id);
    if (!a) return notFound(c, "agent", id);
    return ok(c, { id: a.id, name: a.name, description: a.description, body: a.body });
  });

  // ── skills ──
  app.get("/skills/list", (c) => ok(c, deps.assets.listSkills().filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name, description: s.description }))));
  app.get("/skills/read", (c) => {
    const id = c.req.query("id");
    if (!id) return bad(c, "id 必填");
    const s = deps.assets.getSkill(id);
    if (!s) return notFound(c, "skill", id);
    return ok(c, { id: s.id, name: s.name, description: s.description, body: s.body });
  });

  // ── memory ──
  app.get("/memory/search", async (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const query = c.req.query("query") ?? "";
    const topK = intQuery(c, "top_k", deps.settings.getInt("l1_recall_top_k"));
    const hits = await deps.recaller.search(projectId, query, topK);
    return ok(c, hits);
  });
  app.get("/memory/read", (c) => {
    const id = c.req.query("id");
    if (!id) return bad(c, "id 必填");
    const r = deps.l1.readWithSources(id);
    if (!r) return notFound(c, "memory", id);
    return ok(c, {
      id: r.record.id,
      kind: r.record.kind,
      content: r.record.content,
      priority: r.record.priority,
      sceneName: r.record.sceneName,
      metadata: r.record.metadata,
      sources: r.sources,
    });
  });
  app.get("/memory/profile", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return ok(c, { content: deps.l2.read(projectId) });
  });

  // ── conversation (L0) ──
  app.get("/conversation/search", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const query = c.req.query("query") ?? "";
    const limit = intQuery(c, "limit", 10);
    const hits = deps.l0.search(projectId, query, limit);
    return ok(c, hits.map((h) => ({ id: h.row.id, role: h.row.role, content: h.row.content, createdAt: h.row.createdAt, score: Number(h.score.toFixed(4)) })));
  });

  // ── codegraph（DESIGN §2.8，8 查询工具；未 ready 返回进度提示）──
  app.get("/codegraph/search", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.search(projectId, c.req.query("query") ?? "", intQuery(c, "limit", 30)));
  });
  app.get("/codegraph/explore", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.explore(projectId, cgRef(c)));
  });
  app.get("/codegraph/callers", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.callers(projectId, cgRef(c), intQuery(c, "limit", 30)));
  });
  app.get("/codegraph/callees", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.callees(projectId, cgRef(c), intQuery(c, "limit", 30)));
  });
  app.get("/codegraph/impact", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.impact(projectId, cgRef(c), intQuery(c, "depth", 2)));
  });
  app.get("/codegraph/node", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.node(projectId, cgRef(c)));
  });
  app.get("/codegraph/status", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    return cg(c, deps.codegraph.query.status(projectId));
  });
  app.get("/codegraph/files", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const pathQ = c.req.query("path");
    const withSymbols = c.req.query("with_symbols") === "true" || c.req.query("with_symbols") === "1";
    return cg(c, deps.codegraph.query.files(projectId, { path: pathQ ?? undefined, withSymbols }));
  });

  // ── SQL 只读查询（外部业务库；连接串由调用方直传，不在本库登记）──
  // 四方言共用端点，方言走路径段：/sql/<dialect>/query|tables|describe
  app.get("/sql/:dialect/query", async (c) => {
    const dialect = c.req.param("dialect");
    if (!isDialect(dialect)) return bad(c, `不支持的数据库类型: ${dialect}`);
    const connectionString = c.req.query("connection_string") ?? "";
    const statement = c.req.query("sql") ?? "";
    if (!connectionString.trim()) return bad(c, "connection_string 必填");
    if (!statement.trim()) return bad(c, "sql 必填");
    return sqlResult(c, () => deps.sql.query(dialect, connectionString, statement));
  });
  app.get("/sql/:dialect/tables", async (c) => {
    const dialect = c.req.param("dialect");
    if (!isDialect(dialect)) return bad(c, `不支持的数据库类型: ${dialect}`);
    const connectionString = c.req.query("connection_string") ?? "";
    if (!connectionString.trim()) return bad(c, "connection_string 必填");
    return sqlResult(c, () => deps.sql.listTables(dialect, connectionString, c.req.query("keyword")));
  });
  app.get("/sql/:dialect/describe", async (c) => {
    const dialect = c.req.param("dialect");
    if (!isDialect(dialect)) return bad(c, `不支持的数据库类型: ${dialect}`);
    const connectionString = c.req.query("connection_string") ?? "";
    const table = c.req.query("table") ?? "";
    if (!connectionString.trim()) return bad(c, "connection_string 必填");
    if (!table.trim()) return bad(c, "table 必填");
    return sqlResult(c, () => deps.sql.describeTable(dialect, connectionString, table));
  });

  return app;
}

const SQL_DIALECTS: readonly SqlDialect[] = ["sqlite", "postgresql", "mysql", "sqlserver"];

function isDialect(d: string): d is SqlDialect {
  return (SQL_DIALECTS as readonly string[]).includes(d);
}

/**
 * SQL 端点统一响应：校验/查询失败以 `{ error }` 作为**数据**返回（ok:true），
 * 让模型看到具体原因并自我修正（改 SQL / 检查连接串），而不是被 MCP 客户端包成
 * 笼统的 tool 调用失败（同 C# 版 QueryFailed 的设计意图）。
 */
async function sqlResult(c: Context, run: () => Promise<unknown>) {
  try {
    return ok(c, await run());
  } catch (err) {
    if (err instanceof SqlError) return ok(c, { error: err.message });
    log.error({ err: String(err) }, "SQL 端点异常");
    return ok(c, { error: `查询失败：${String(err)}` });
  }
}

/** codegraph 结果 → 统一响应体（含 status/进度提示/data）。 */
function cg(c: Context, result: { status: string; progress?: unknown; message?: string; data?: unknown }) {
  return ok(c, result);
}

/** 从 query 取符号引用（id 优先，其次 name）。 */
function cgRef(c: Context): { id?: string; name?: string } {
  const id = c.req.query("id");
  const name = c.req.query("name");
  return { id: id || undefined, name: name || undefined };
}

/** project_path（query）→ projectId（规范化后查库）。 */
function resolveProjectId(deps: InternalDeps, c: Context): string | null {
  const rawPath = c.req.query("project_path");
  if (!rawPath) return null;
  const norm = normalizeProjectPath(rawPath);
  const p = deps.projects.findByPath(norm);
  if (!p) {
    log.debug({ rawPath, norm }, "内部 API：project_path 未匹配到项目");
    return null;
  }
  return p.id;
}

function intQuery(c: Context, key: string, dflt: number): number {
  const v = c.req.query(key);
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function ok(c: Context, data: unknown) {
  return c.json({ ok: true, data });
}
function bad(c: Context, message: string) {
  return c.json({ ok: false, error: { code: "bad_request", message } }, 400);
}
function notFound(c: Context, kind: string, id: string) {
  return c.json({ ok: false, error: { code: "not_found", message: `${kind} 不存在: ${id}` } }, 404);
}
