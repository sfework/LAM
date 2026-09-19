import type { CodeGraphService } from "../codegraph/service.js";
import type { ProjectRepo } from "../projects/repo.js";
import { postRoutes, requireStr, notFound, listRoute } from "./rest.js";

/**
 * /api/codegraph —— 索引状态概览 / 手动重建 / 代码关系图（DESIGN §3、决策 45 + 47 + 54）。
 * POST /list { page?, pageSize? }   各项目索引概览（分页 PaginationModel：status/files/symbols）
 * POST /get   { id }                单项目状态详情
 * POST /rebuild { id }              强制全量重建
 * POST /graph { id, maxNodes? }     代码关系图（符号节点 + calls 边，按度数取 top）
 */
export function createCodegraphRouter(cg: CodeGraphService, projects: ProjectRepo) {
  return postRoutes({
    "/list": listRoute(() => cg.overview()),
    "/graph": (b) => {
      const id = requireStr(b, "id");
      if (!projects.findById(id)) notFound("项目不存在");
      const maxNodes = typeof b.maxNodes === "number" ? b.maxNodes : undefined;
      return cg.graph(id, maxNodes);
    },
    "/get": (b) => {
      const id = requireStr(b, "id");
      if (!projects.findById(id)) notFound("项目不存在");
      const r = cg.statusOf(id);
      return r.data ?? r;
    },
    "/rebuild": (b) => {
      const id = requireStr(b, "id");
      if (!cg.rebuild(id)) notFound("项目不存在");
      return { message: "重建已排队" };
    },
  });
}
