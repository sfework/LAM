import { Hono, type Context } from "hono";
import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import type { AssetsRepo } from "../assets/repo.js";
import type { L1Store } from "../memory/l1-store.js";
import type { L2Refiner } from "../memory/l2-refiner.js";
import type { MemoryRecaller } from "../memory/recall.js";
import type { SettingsService } from "../settings/service.js";
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
  l2: L2Refiner;
  recaller: MemoryRecaller;
  settings: SettingsService;
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
  // 项目隔离（决策 82）：knowledge/agent/memory 全部工具端点强制校验 project_path；
  // knowledge 的 project 级条目只能由归属项目读写，global 不限；agent 无项目归属，
  // 仅要求 project_path 可解析（审计与口径统一）。
  app.get("/knowledge/read", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const id = c.req.query("id");
    if (!id) return bad(c, "id 必填");
    const k = deps.assets.getKnowledge(id);
    if (!k) return notFound(c, "knowledge", id);
    if (k.scope === "project" && k.projectId !== projectId) return notFound(c, "knowledge", id);
    return ok(c, { id: k.id, title: k.title, description: k.description, body: k.body, scope: k.scope });
  });
  /**
   * 更新知识条目（MCP knowledge_update 用，决策 81）：只开放内容字段
   * title/description/body（部分更新，至少一个非空）；enabled/sortOrder/scope 归管理台。
   * 跨项目护栏：project scope 条目仅当 project_path 解析出的项目匹配才可改；global 不限。
   */
  app.post("/knowledge/update", async (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const id = typeof b?.id === "string" ? b.id : "";
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getKnowledge(id);
    if (!existing) return notFound(c, "knowledge", id);
    if (existing.scope === "project" && existing.projectId !== projectId) {
      return bad(c, "该知识条目属于其他项目，拒绝更新");
    }
    const input: Partial<{ title: string; description: string; body: string }> = {};
    for (const key of ["title", "description", "body"] as const) {
      const v = typeof b?.[key] === "string" ? (b[key] as string).trim() : "";
      if (v) input[key] = v;
    }
    if (!Object.keys(input).length) return bad(c, "title/description/body 至少传一个非空值");
    const updated = deps.assets.updateKnowledge(id, input);
    if (!updated) return notFound(c, "knowledge", id);
    log.info({ id, fields: Object.keys(input) }, "MCP 更新知识条目");
    return ok(c, { id: updated.id, title: updated.title, description: updated.description, scope: updated.scope });
  });
  /**
   * 创建知识条目（MCP knowledge_create 用，决策 83）：project_path 必填；
   * scope 缺省 project（挂到解析出的项目），可显式 global（挂全局）；
   * enabled 恒 true（生效开关归管理台），sortOrder 缺省 0。
   */
  app.post("/knowledge/create", async (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const title = typeof b?.title === "string" ? b.title.trim() : "";
    const body = typeof b?.body === "string" ? b.body.trim() : "";
    const description = typeof b?.description === "string" ? b.description.trim() : "";
    if (!title || !body) return bad(c, "title 与 body 必填");
    const scope = b?.scope === "global" ? "global" : "project";
    const k = deps.assets.createKnowledge({
      title,
      description,
      body,
      scope,
      projectId: scope === "project" ? projectId : null,
      enabled: true,
    });
    log.info({ id: k.id, scope, projectId }, "MCP 创建知识条目");
    return ok(c, { id: k.id, title: k.title, description: k.description, scope: k.scope });
  });
  /**
   * 删除知识条目（MCP knowledge_delete 用，决策 83）：物理删除（与管理台决策 56 同语义）。
   * 跨项目护栏：project 级条目仅归属项目可删；global 条目不限，但删除记 WARN 强化审计。
   */
  app.post("/knowledge/delete", async (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const id = typeof b?.id === "string" ? b.id : "";
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
  app.get("/agents/list", (c) => ok(c, deps.assets.listAgents().filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, description: a.description }))));
  app.get("/agents/read", (c) => {
    if (!resolveProjectId(deps, c)) return bad(c, "无法解析 project_path");
    const id = c.req.query("id");
    if (!id) return bad(c, "id 必填");
    const a = deps.assets.getAgent(id);
    if (!a) return notFound(c, "agent", id);
    return ok(c, { id: a.id, name: a.name, description: a.description, body: a.body });
  });
  /**
   * 更新 Agent 定义（MCP agent_update 用，决策 81）：只开放内容字段
   * name/description/body（部分更新，至少一个非空）；enabled/sortOrder 归管理台。
   * Agent 无项目归属概念，不需 project_path 护栏。
   */
  app.post("/agents/update", async (c) => {
    if (!resolveProjectId(deps, c)) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const id = typeof b?.id === "string" ? b.id : "";
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getAgent(id);
    if (!existing) return notFound(c, "agent", id);
    const input: Partial<{ name: string; description: string; body: string }> = {};
    for (const key of ["name", "description", "body"] as const) {
      const v = typeof b?.[key] === "string" ? (b[key] as string).trim() : "";
      if (v) input[key] = v;
    }
    if (!Object.keys(input).length) return bad(c, "name/description/body 至少传一个非空值");
    const updated = deps.assets.updateAgent(id, input);
    if (!updated) return notFound(c, "agent", id);
    log.info({ id, fields: Object.keys(input) }, "MCP 更新 Agent 定义");
    return ok(c, { id: updated.id, name: updated.name, description: updated.description });
  });
  /**
   * 创建 Agent 定义（MCP agent_create 用，决策 83）：project_path 必填（统一校验口径）；
   * enabled 恒 true（生效开关归管理台），sortOrder 缺省 0；Agent 表无项目归属。
   */
  app.post("/agents/create", async (c) => {
    if (!resolveProjectId(deps, c)) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof b?.name === "string" ? b.name.trim() : "";
    const body = typeof b?.body === "string" ? b.body.trim() : "";
    const description = typeof b?.description === "string" ? b.description.trim() : "";
    if (!name || !body) return bad(c, "name 与 body 必填");
    const a = deps.assets.createAgent({ name, description, body, enabled: true });
    log.info({ id: a.id, name }, "MCP 创建 Agent 定义");
    return ok(c, { id: a.id, name: a.name, description: a.description });
  });
  /** 删除 Agent 定义（MCP agent_delete 用，决策 83）：物理删除；Agent 为全局资产，删除记 WARN 强化审计。 */
  app.post("/agents/delete", async (c) => {
    if (!resolveProjectId(deps, c)) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const id = typeof b?.id === "string" ? b.id : "";
    if (!id) return bad(c, "id 必填");
    const existing = deps.assets.getAgent(id);
    if (!existing) return notFound(c, "agent", id);
    log.warn({ id, name: existing.name }, "MCP 删除 Agent 定义（全局资产）");
    deps.assets.deleteAgent(id);
    return ok(c, { deleted: true, id });
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
  // 分页读取项目全部活跃记忆（MCP memory_batch_read 用；决策 79 替代按 id 逐条读的 memory_read 工具面）
  app.get("/memory/batch-read", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const page = Math.max(1, intQuery(c, "page", 1));
    const pageSize = Math.min(100, Math.max(1, intQuery(c, "page_size", 20)));
    const { items, total } = deps.l1.listActivePaged(projectId, (page - 1) * pageSize, pageSize);
    return ok(c, {
      list: items.map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        priority: r.priority,
        sceneName: r.sceneName,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
      page,
      pageSize,
    });
  });
  /**
   * 批量改写记忆正文（MCP memory_batch_update 用，决策 79）：items 逐条处理，
   * 复用 updateContent 的 FTS 重建 + 向量失效补嵌入链路。删除归 /memory/batch-delete。
   * 部分成功语义：单条失败不影响其余，成功与失败均逐条返回。
   */
  app.post("/memory/batch-update", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const rawItems = b?.items;
    if (!Array.isArray(rawItems) || !rawItems.length) return bad(c, "items 需为非空数组");
    if (rawItems.length > 20) return bad(c, "单批最多 20 条");
    const results: Record<string, unknown>[] = [];
    for (const it of rawItems) {
      const item = (it ?? {}) as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : "";
      const guard = guardActionableMemory(deps, id, projectId);
      if (guard) {
        results.push({ id, ok: false, error: guard });
        continue;
      }
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) {
        results.push({ id, ok: false, error: "content 需为非空字符串" });
        continue;
      }
      if (content.length > 2000) {
        results.push({ id, ok: false, error: "content 超 2000 字符上限，请拆分" });
        continue;
      }
      try {
        const { changed } = deps.l1.updateContent(id, content);
        results.push({ id, ok: true, changed });
      } catch (err) {
        results.push({ id, ok: false, error: String(err) });
      }
    }
    const applied = results.filter((r) => r.ok).length;
    log.info({ projectId, batch: results.length, applied }, "MCP 批量改写记忆");
    return ok(c, { results, applied, skipped: results.length - applied });
  });
  /**
   * 批量物理删除记忆（MCP memory_batch_delete 用）：ids 数量不设上限（删除是收敛动作，
   * 不该被分片折腾），逐条校验有效性与项目归属，物理删除与管理台决策 56 一致。
   * 为免撑爆模型上下文：成功只计数（applied），失败才逐条返回原因。
   */
  app.post("/memory/batch-delete", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const rawIds = b?.ids;
    if (!Array.isArray(rawIds) || !rawIds.length) return bad(c, "ids 需为非空数组");
    const failures: Record<string, unknown>[] = [];
    let applied = 0;
    for (const rid of rawIds) {
      const id = typeof rid === "string" ? rid : "";
      const guard = guardActionableMemory(deps, id, projectId);
      if (guard) {
        failures.push({ id, ok: false, error: guard });
        continue;
      }
      try {
        if (deps.l1.remove(id)) applied++;
        else failures.push({ id, ok: false, error: "删除失败（行不存在）" });
      } catch (err) {
        failures.push({ id, ok: false, error: String(err) });
      }
    }
    log.info({ projectId, batch: rawIds.length, applied, failed: failures.length }, "MCP 批量删除记忆");
    return ok(c, { results: failures, applied, skipped: rawIds.length - applied });
  });
  app.get("/memory/profile", (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const { content, version, updatedAt } = deps.l2.readMeta(projectId);
    return ok(c, { content, version, updatedAt });
  });
  /**
   * 保存 L2 画像（MCP memory_profile_update 用，决策 80）：整篇覆盖，
   * 复用 L2Refiner.save 的"内容变化才写库、version 自增"语义（与管理台 save-profile 一致，
   * 不做 l2_max_chars 截断——长度约束由凝练管线负责）。
   */
  app.post("/memory/save-profile", async (c) => {
    const projectId = resolveProjectId(deps, c);
    if (!projectId) return bad(c, "无法解析 project_path");
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const content = typeof b?.content === "string" ? b.content.trim() : "";
    if (!content) return bad(c, "content 需为非空字符串");
    const { changed, version } = deps.l2.save(projectId, content);
    log.info({ projectId, version, changed }, "MCP 保存 L2 画像");
    return ok(c, { changed, version });
  });

  // ── SQL 只读查询（外部业务库；连接串由调用方直传，不在本库登记）──
  // 四方言共用端点，方言走路径段：/sql/<dialect>/query（表结构元数据工具已移除，模型按需 SELECT 系统表）
  app.get("/sql/:dialect/query", async (c) => {
    const dialect = c.req.param("dialect");
    if (!isDialect(dialect)) return bad(c, `不支持的数据库类型: ${dialect}`);
    const connectionString = c.req.query("connection_string") ?? "";
    const statement = c.req.query("sql") ?? "";
    if (!connectionString.trim()) return bad(c, "connection_string 必填");
    if (!statement.trim()) return bad(c, "sql 必填");
    return sqlResult(c, () => deps.sql.query(dialect, connectionString, statement));
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

/** 批量改/删的前置校验：返回失败原因，通过则 null。 */
function guardActionableMemory(deps: InternalDeps, id: string, projectId: string): string | null {
  if (!id) return "id 必填";
  const existing = deps.l1.get(id);
  if (!existing || existing.deletedAt !== null || existing.supersededBy !== null) {
    return "记忆不存在或已失效";
  }
  if (existing.projectId !== projectId) return "记忆不属于该项目";
  return null;
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
