import type { DenoiseRepo } from "../denoise/repo.js";
import { postRoutes, requireStr, optStr, optBool, notFound, listRoute } from "./rest.js";

/**
 * /api/denoise-rules —— 去噪规则 CRUD（物理删除，无软删）。
 * POST /list { keyword?, enabled?, page?, pageSize? }
 *      /get { id } | /create { startText, endText, extract?, applyForward?, applyMemory?, enabled? }
 *      /update { id, ... } | /delete { id }
 */
export function createDenoiseRulesRouter(repo: DenoiseRepo) {
  return postRoutes({
    "/list": listRoute((b) => {
      const kw = optStr(b, "keyword")?.toLowerCase();
      const enabled = optBool(b, "enabled");
      let rows = repo.list();
      if (enabled !== undefined) rows = rows.filter((r) => r.enabled === enabled);
      if (kw) rows = rows.filter((r) => r.startText.toLowerCase().includes(kw) || r.endText.toLowerCase().includes(kw));
      return rows;
    }),
    "/get": (b) => repo.get(requireStr(b, "id")) ?? notFound("规则不存在"),
    "/create": (b) =>
      repo.create({
        startText: requireStr(b, "startText"),
        endText: requireStr(b, "endText"),
        extract: optBool(b, "extract"),
        applyForward: optBool(b, "applyForward"),
        applyMemory: optBool(b, "applyMemory"),
        enabled: optBool(b, "enabled"),
      }),
    "/update": (b) =>
      repo.update(requireStr(b, "id"), {
        startText: optStr(b, "startText"),
        endText: optStr(b, "endText"),
        extract: optBool(b, "extract"),
        applyForward: optBool(b, "applyForward"),
        applyMemory: optBool(b, "applyMemory"),
        enabled: optBool(b, "enabled"),
      }) ?? notFound("规则不存在"),
    "/delete": (b) => {
      if (!repo.delete(requireStr(b, "id"))) notFound("规则不存在");
      return { deleted: true };
    },
  });
}
