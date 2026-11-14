import type { ProjectRepo, DbConnRepo, DbType } from "../projects/repo.js";
import { isValidDbType } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import { postRoutes, requireStr, optStr, notFound, badRequest, listRoute } from "./rest.js";

/**
 * /api/projects —— 项目列表/查询/软删/恢复 + 数据库连接管理（新功能 1）。
 * 一律 POST + JSON body，响应 { success, code, message, data }。
 * POST /list { page?, pageSize?, keyword? }   分页（按 last_active_at desc）
 * POST /get { id } | /get-by-path { path }
 * POST /update { id, name?, path? } / /delete { id }（软删级联） / /restore { id }
 * 连接子资源：
 * POST /conn-list   { project_id }
 * POST /conn-save   { id?, project_id, name, db_type, connection_string }（id 空=新增）
 * POST /conn-delete { id }
 */
export function createProjectsRouter(repo: ProjectRepo, conns: DbConnRepo) {
  return postRoutes({
    "/list": listRoute((b) => {
      const kw = optStr(b, "keyword")?.toLowerCase();
      const rows = repo.list();
      return kw ? rows.filter((p) => p.name.toLowerCase().includes(kw) || p.path.toLowerCase().includes(kw)) : rows;
    }),
    "/get": (b) => repo.findById(requireStr(b, "id")) ?? notFound("项目不存在"),
    "/get-by-path": (b) => repo.findByPath(normalizeProjectPath(requireStr(b, "path"))) ?? notFound("项目不存在"),
    "/update": (b) => {
      const id = requireStr(b, "id");
      const before = repo.findById(id) ?? notFound("项目不存在");
      const name = optStr(b, "name");
      const path = optStr(b, "path");
      if (!name && !path) badRequest("name 或 path 至少提供一项");
      void before;
      try {
        return repo.update(id, { name, path }) ?? notFound("项目不存在");
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : String(err));
      }
    },
    "/delete": (b) => {
      const id = requireStr(b, "id");
      if (!repo.softDelete(id)) notFound("项目不存在");
      return { deleted: true };
    },
    "/restore": (b) => {
      const id = requireStr(b, "id");
      if (!repo.restore(id)) notFound("项目不存在");
      return repo.findById(id);
    },

    // ── 数据库连接（新功能 1）──
    "/conn-list": (b) => conns.list(requireStr(b, "project_id")),
    "/conn-save": (b) => {
      const projectId = requireStr(b, "project_id");
      const dbType = requireStr(b, "db_type");
      if (!isValidDbType(dbType)) badRequest(`非法数据库类型: ${dbType}`);
      const id = optStr(b, "id");
      const connectionString = requireStr(b, "connection_string");
      try {
        return conns.save({ id, projectId, name: requireStr(b, "name"), dbType: dbType as DbType, connectionString });
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : String(err));
      }
    },
    "/conn-delete": (b) => {
      if (!conns.delete(requireStr(b, "id"))) notFound("连接不存在");
      return { deleted: true };
    },
  });
}
