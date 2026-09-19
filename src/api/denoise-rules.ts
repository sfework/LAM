import type { DenoiseRepo, DenoiseRuleInput } from "../denoise/repo.js";
import { postRoutes, requireStr, optStr, badRequest, notFound, listRoute } from "./rest.js";

/**
 * /api/denoise-rules —— 除噪规则 CRUD + 开关（DESIGN §2.3、§3、决策 45 + 47）。
 * POST /list { page?, pageSize?, keyword? }（keyword 模糊匹配开头/结束文本）| /get { id }
 *      /create { startText,endText,... } | /update { id,... } | /delete { id } | /toggle { id }
 */
export function createDenoiseRulesRouter(repo: DenoiseRepo) {
  return postRoutes({
    "/list": listRoute((b) => {
      const kw = optStr(b, "keyword")?.toLowerCase();
      // 展示按创建时间倒序（新增靠前）；引擎的应用顺序由 selectRules 内部按 createdAt ASC 另算，互不影响。
      const rows = repo.list().slice().reverse();
      return kw
        ? rows.filter((r) => r.startText.toLowerCase().includes(kw) || r.endText.toLowerCase().includes(kw))
        : rows;
    }),
    "/get": (b) => repo.get(requireStr(b, "id")) ?? notFound("规则不存在"),
    "/create": (b) => {
      const err = validate(b as unknown as Partial<DenoiseRuleInput>, true);
      if (err) badRequest(err);
      return repo.create(b as unknown as DenoiseRuleInput);
    },
    "/update": (b) => {
      const err = validate(b as unknown as Partial<DenoiseRuleInput>, false);
      if (err) badRequest(err);
      return repo.update(requireStr(b, "id"), b as unknown as Partial<DenoiseRuleInput>) ?? notFound("规则不存在");
    },
    "/delete": (b) => {
      if (!repo.delete(requireStr(b, "id"))) notFound("规则不存在");
      return { deleted: true };
    },
    "/toggle": (b) => {
      const existing = repo.get(requireStr(b, "id"));
      if (!existing) notFound("规则不存在");
      return repo.update(existing.id, { enabled: !existing.enabled });
    },
  });
}

function validate(b: Partial<DenoiseRuleInput> | null, isCreate: boolean): string | null {
  if (!b) return "body 必填";
  if (isCreate) {
    if (!b.startText?.trim()) return "start_text 必填";
    if (!b.endText?.trim()) return "end_text 必填";
  } else {
    if (b.startText !== undefined && !b.startText.trim()) return "start_text 不能为空";
    if (b.endText !== undefined && !b.endText.trim()) return "end_text 不能为空";
  }
  return null;
}
