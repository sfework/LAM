import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import type { CodeGraphService } from "../codegraph/service.js";
import { postRoutes, requireStr, optStr, notFound, badRequest, listRoute } from "./rest.js";

/**
 * /api/projects —— 项目列表/查询/软删/恢复（DESIGN §2.2、§3、决策 45 + 47）。
 * 一律 POST + JSON body，响应 { success, code, message, data }。
 * POST /list { page?, pageSize?, keyword? }   分页 PaginationModel（按 last_active_at desc）
 * POST /get { id } | /get-by-path { path }
 * POST /delete { id }（软删，级联软删记忆/project 知识/CodeGraph，停 watcher）
 * POST /restore { id }（恢复 + 重启 watcher；网关再次请求也会自动恢复）
 */
export function createProjectsRouter(repo: ProjectRepo, codegraph?: CodeGraphService) {
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
      let updated: ReturnType<typeof repo.update>;
      try {
        updated = repo.update(id, { name, path });
      } catch (err) {
        badRequest(err instanceof Error ? err.message : String(err));
      }
      // 换目录：CodeGraph 删旧外置索引库、在新根重建（记忆不受影响）。
      if (updated && path && updated.path !== before.path) codegraph?.relocate(id, before.path, updated.path);
      return updated ?? notFound("项目不存在");
    },
    "/delete": (b) => {
      const id = requireStr(b, "id");
      const before = repo.findById(id);
      if (!before) notFound("项目不存在");
      if (!repo.softDelete(id)) notFound("项目不存在");
      codegraph?.deactivate(id);
      return { deleted: true };
    },
    "/restore": (b) => {
      const id = requireStr(b, "id");
      if (!repo.restore(id)) notFound("项目不存在");
      const p = repo.findById(id);
      if (p && codegraph) codegraph.activate(p.id, p.path);
      return repo.findById(id);
    },
  });
}
