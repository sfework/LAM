import { Hono, type Context } from "hono";
import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import type { AssetsRepo } from "../assets/repo.js";
import type { MemoryRepo, MemoryKind } from "../memory/memory-repo.js";
import { isMemoryKind } from "../memory/memory-repo.js";
import type { ProfileRefiner } from "../memory/profile-refiner.js";
import type { MemoryRecaller } from "../memory/recall.js";
import type { SettingsService } from "../settings/service.js";
import type { SqlService } from "../sqlquery/service.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("internal");

/**
 * 内部 API（/internal/*）——仅供 MCP 薄壳调用（MCP 不直连 DB）。
 * 无鉴权（本地单用户），参数约定统一：全部 POST + JSON body（含 project_path），
 * 不再有"query 传 project_path、复杂值 JSON 串进 query"的特殊分支。
 * 只保留有 MCP 工具对应的端点，无工具的死端点不建。
 */
export interface InternalDeps {
  projects: ProjectRepo;
  assets: AssetsRepo;
  memories: MemoryRepo;
  profiles: ProfileRefiner;
  recaller: MemoryRecaller;
  settings: SettingsService;
  sql: SqlService;
}

/** 请求体（全部端点统一从 JSON body 取参）。 */
async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  return ((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
}

function str(b: Record<string, unknown>, key: string): string {
  return typeof b[key] === "string" ? (b[key] as string).trim() : "";
}

export function createInternalRouter(deps: InternalDeps): Hono {
  const app = new Hono();

  /** project_path（body）→ projectId（规范化后查库）。 */
  const resolveProjectId = (b: Record<string, unknown>): string | null => {
    const rawPath = str(b, "project_path");
    if (!rawPath) return null;
    const p = deps.projects.findByPath(normalizeProjectPath(rawPath));
    return p ? p.id : null;
  };

  // ── knowledge ──
  // 项目隔离：project 级条目只能由归属项目读写，global 不限；
  // agent/memory/sql 端点同样强制 project_path 可解析（审计与口径统一）。
  app.post("/knowledge/read", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const k = deps.assets.getKnowledge(id);
    if (!k) return notFound(c, "knowledge", id);
    if (k.scope === "project" && k.projectId !== projectId) return notFound(c, "knowledge", id);
    return ok(c, { id: k.id, title: k.title, description: k.description, body: k.body, scope: k.scope });
  });

  /** 更新知识条目：只开放内容字段 title/description/body（部分更新，至少一个非空）；enabled/sortOrder/scope 归管理台。 */
  app.post("/knowledge/update", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getKnowledge(id);
    if (!existing) return notFound(c, "knowledge", id);
    if (existing.scope === "project" && existing.projectId !== projectId) {
      return bad(c, "该知识条目属于其他项目，拒绝更新");
    }
    const input: Partial<{ title: string; description: string; body: string }> = {};
    for (const key of ["title", "description", "body"] as const) {
      const v = str(b, key);
      if (v) input[key] = v;
    }
    if (!Object.keys(input).length) return bad(c, "title/description/body 至少传一个非空值");
    const updated = deps.assets.updateKnowledge(id, input);
    if (!updated) return notFound(c, "knowledge", id);
    return ok(c, { id: updated.id, title: updated.title, description: updated.description, scope: updated.scope });
  });

  /** 创建知识条目：scope 缺省 project（挂解析出的项目），可显式 global；enabled 恒 true（启停归管理台）。 */
  app.post("/knowledge/create", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const title = str(b, "title");
    const body = str(b, "body");
    const description = str(b, "description");
    if (!title || !body) return bad(c, "title 与 body 必填");
    const scope = str(b, "scope") === "global" ? "global" : "project";
    const k = deps.assets.createKnowledge({
      title, description, body, scope,
      projectId: scope === "project" ? projectId : null,
      enabled: true,
    });
    return ok(c, { id: k.id, title: k.title, description: k.description, scope: k.scope });
  });

  /** 删除知识条目：物理删除；project 级仅归属项目可删；global 不限但记 WARN 审计。 */
  app.post("/knowledge/delete", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getKnowledge(id);
    if (!existing) return notFound(c, "knowledge", id);
    if (existing.scope === "project" && existing.projectId !== projectId) {
      return bad(c, "该知识条目属于其他项目，拒绝删除");
    }
    if (existing.scope === "global") {
      log.warn({ id, title: existing.title, viaProject: projectId }, "MCP 删除全局知识条目");
    }
    deps.assets.deleteKnowledge(id);
    return ok(c, { deleted: true, id });
  });

  // ── agents ──
  app.post("/agents/read", async (c) => {
    const b = await bodyOf(c);
    if (!resolveProjectId(b)) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const a = deps.assets.getAgent(id);
    if (!a) return notFound(c, "agent", id);
    return ok(c, { id: a.id, name: a.name, description: a.description, body: a.body });
  });

  /** 更新 Agent：只开放 name/description/body（部分更新，至少一个非空）；enabled/sortOrder 归管理台。 */
  app.post("/agents/update", async (c) => {
    const b = await bodyOf(c);
    if (!resolveProjectId(b)) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getAgent(id);
    if (!existing) return notFound(c, "agent", id);
    const input: Partial<{ name: string; description: string; body: string }> = {};
    for (const key of ["name", "description", "body"] as const) {
      const v = str(b, key);
      if (v) input[key] = v;
    }
    if (!Object.keys(input).length) return bad(c, "name/description/body 至少传一个非空值");
    const updated = deps.assets.updateAgent(id, input);
    if (!updated) return notFound(c, "agent", id);
    return ok(c, { id: updated.id, name: updated.name, description: updated.description });
  });

  /** 创建 Agent：enabled 恒 true（启停归管理台）；Agent 表无项目归属。 */
  app.post("/agents/create", async (c) => {
    const b = await bodyOf(c);
    if (!resolveProjectId(b)) return bad(c, "无法解析 project_path");
    const name = str(b, "name");
    const body = str(b, "body");
    const description = str(b, "description");
    if (!name || !body) return bad(c, "name 与 body 必填");
    const a = deps.assets.createAgent({ name, description, body, enabled: true });
    return ok(c, { id: a.id, name: a.name, description: a.description });
  });

  /** 删除 Agent 定义（MCP agent_delete 用）：物理删除；Agent 为全局资产，删除记 WARN 强化审计；系统级 Agent 拒绝。 */
  app.post("/agents/delete", async (c) => {
    const b = await bodyOf(c);
    if (!resolveProjectId(b)) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getAgent(id);
    if (!existing) return notFound(c, "agent", id);
    if (existing.system) return bad(c, `系统级 Agent 不可删除：${existing.name}`);
    log.warn({ id, name: existing.name }, "MCP 删除 Agent 定义（全局资产）");
    deps.assets.deleteAgent(id);
    return ok(c, { deleted: true, id });
  });

  // ── memory ──
  app.post("/memory/search", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const query = str(b, "query");
    if (!query) return bad(c, "query 必填");
    const topKRaw = typeof b.top_k === "number" && b.top_k > 0 ? Math.trunc(b.top_k) : deps.settings.getInt("memory_recall_top_k");
    const hits = await deps.recaller.search(projectId, query, topKRaw);
    return ok(c, hits);
  });

  // ── 记忆整理工具面 ──
  // 写类 4 工具靠红线文案（仅限记忆整理Agent）+ WARN 审计约束，不设口令闸。

  app.post("/memory/list", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const page = typeof b.page === "number" && b.page > 0 ? Math.trunc(b.page) : 1;
    const pageSize = Math.min(200, typeof b.pageSize === "number" && b.pageSize > 0 ? Math.trunc(b.pageSize) : 50);
    const kindRaw = str(b, "kind");
    if (kindRaw && !isMemoryKind(kindRaw)) return bad(c, `非法 kind: ${kindRaw}`);
    const scope = str(b, "scope") === "archived" ? "archived" as const : "active" as const;
    const { rows, totalCount } = deps.memories.listPaged(projectId, {
      page, pageSize,
      kind: kindRaw ? (kindRaw as MemoryKind) : undefined,
      keyword: str(b, "keyword") || undefined,
      scope,
    });
    return ok(c, {
      page, pageSize, totalCount,
      list: rows.map((m) => ({
        id: m.id, kind: m.kind, content: m.content, priority: m.priority,
        sceneName: m.sceneName, createdAt: m.createdAt,
        ...(scope === "archived" ? { archiveBatch: m.archiveBatch } : {}),
      })),
    });
  });

  app.post("/profile/read", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const { content, version, updatedAt } = deps.profiles.readMeta(projectId);
    return ok(c, { content, version, updatedAt });
  });

  app.post("/memory/archive", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return bad(c, "ids 必填（非空数组）");
    if (ids.length > 200) return bad(c, "单批归档不超过 200 条，请分批");
    const reason = str(b, "reason") || undefined;
    const { batchId, archived } = deps.memories.archiveBatchOf(projectId, ids, reason);
    log.warn({ projectId, batchId, archived, ids: ids.slice(0, 50), via: "mcp" }, "记忆整理：批量归档");
    return ok(c, { batchId, archived });
  });

  app.post("/memory/restore", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const batchId = str(b, "batch_id");
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
    if (!batchId && !ids.length) return bad(c, "batch_id 与 ids 至少提供一项");
    const restored = deps.memories.restore(projectId, batchId ? { batchId } : { ids });
    log.warn({ projectId, batchId: batchId || null, idCount: ids.length, restored, via: "mcp" }, "记忆整理：撤销归档");
    return ok(c, { restored });
  });

  app.post("/memory/update", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const id = str(b, "id");
    if (!id) return bad(c, "id 必填");
    const existing = deps.memories.findById(id);
    if (!existing || existing.projectId !== projectId || existing.deletedAt !== null) return notFound(c, "memory", id);
    const content = str(b, "content");
    const priority = typeof b.priority === "number" && Number.isFinite(b.priority) ? Math.trunc(b.priority) : undefined;
    if (!content && priority === undefined) return bad(c, "content 与 priority 至少提供一项");
    const updated = deps.memories.update(id, { content: content || undefined, priority });
    if (!updated) return notFound(c, "memory", id);
    log.warn({ projectId, id, via: "mcp" }, "记忆整理：改写记忆");
    return ok(c, { id: updated.id, content: updated.content, priority: updated.priority });
  });

  app.post("/profile/save", async (c) => {
    const b = await bodyOf(c);
    const projectId = resolveProjectId(b);
    if (!projectId) return bad(c, "无法解析 project_path");
    const content = typeof b.content === "string" ? b.content : "";
    if (!content.trim()) return bad(c, "content 必填");
    const { changed, version } = deps.profiles.save(projectId, content);
    log.warn({ projectId, changed, version, via: "mcp" }, "记忆整理：回写画像");
    return ok(c, { changed, version });
  });

  // ── SQL 只读查询（新功能 2：按项目 + 连接名解析连接）──
  /** 列出项目可用数据库连接（名称 + 类型，不回显连接串）。 */
  app.post("/sql/conns", async (c) => {
    const b = await bodyOf(c);
    const projectPath = str(b, "project_path");
    if (!projectPath) return bad(c, "project_path 必填");
    const conns = deps.sql.listConnections(projectPath);
    if (conns === null) return ok(c, { error: `无法解析项目：${projectPath}（未登记或已删除）` });
    return ok(c, { connections: conns });
  });

  app.post("/sql/query", async (c) => {
    const b = await bodyOf(c);
    const projectPath = str(b, "project_path");
    const conn = str(b, "conn");
    const sql = str(b, "sql");
    if (!projectPath) return bad(c, "project_path 必填");
    if (!conn) return bad(c, "conn 必填（连接名，可先用 list_db_connections 查询）");
    if (!sql) return bad(c, "sql 必填");
    // 查询失败/未配置连接以 { error } 作为**数据**返回（ok:true），
    // 让模型看到具体原因并自我修正，而不是被 MCP 客户端包成笼统的 tool 调用失败。
    const result = await deps.sql.queryByProject(projectPath, conn, sql);
    if (!result.ok) return ok(c, { error: result.error });
    const notice = result.truncated
      ? `（结果超过 ${deps.settings.getInt("sql_query_max_rows")} 行已截断，请加 LIMIT 或收窄条件）`
      : undefined;
    return ok(c, { rows: result.rows, ...(notice ? { notice } : {}) });
  });

  return app;
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
