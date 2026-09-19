import type { ModelRepo, ModelInput, ModelCategory } from "../models/repo.js";
import type { SettingsService } from "../settings/service.js";
import { postRoutes, requireStr, optStr, badRequest, notFound, listRoute } from "./rest.js";

/**
 * /api/models —— 模型库 CRUD（DESIGN §2.9、决策 45 + 47 + 49）。
 * POST /list { category?, keyword?, page?, pageSize? }   分页；keyword 模糊匹配名称/模型名；
 *        排序 LLM 靠前再按名称 ASC；每行附 inUse（是否被设置引用）与 usedBy（引用它的设置键）。
 *      /get { id } | /create { category,name,url,model,key }（key 必填）
 *      /update { id, ... }（可改分类；被设置引用则禁止）| /delete { id }（被引用则禁止）
 */
export function createModelsRouter(repo: ModelRepo, settings: SettingsService) {
  const decorate = <T extends { id: string }>(row: T) => {
    const usedBy = settings.modelUsage(row.id);
    return { ...row, usedBy, inUse: usedBy.length > 0 };
  };

  return postRoutes({
    "/list": listRoute((b) => {
      const cat = optStr(b, "category") as ModelCategory | undefined;
      if (cat && cat !== "llm" && cat !== "embedding") badRequest("category 需为 llm 或 embedding");
      const keyword = optStr(b, "keyword");
      return repo.list(cat, keyword).map(decorate);
    }),
    "/get": (b) => {
      const m = repo.get(requireStr(b, "id"));
      return m ? decorate(m) : notFound("模型不存在");
    },    "/create": (b) => {
      const err = validateInput(b as unknown as Partial<ModelInput>, true);
      if (err) badRequest(err);
      return repo.create(b as unknown as ModelInput);
    },
    "/update": (b) => {
      const err = validateInput(b as unknown as Partial<ModelInput>, false);
      if (err) badRequest(err);
      const id = requireStr(b, "id");
      if (!repo.get(id)) notFound("模型不存在");
      const usedBy = settings.modelUsage(id);
      if (usedBy.length) badRequest(`该模型正被设置引用（${usedBy.join("、")}），不可编辑`);
      return repo.update(id, b as unknown as Partial<ModelInput>) ?? notFound("模型不存在");
    },
    "/delete": (b) => {
      const id = requireStr(b, "id");
      const usedBy = settings.modelUsage(id);
      if (usedBy.length) badRequest(`该模型正被设置引用（${usedBy.join("、")}），不可删除`);
      if (!repo.delete(id)) notFound("模型不存在");
      return { deleted: true };
    },
  });
}

function validateInput(b: Partial<ModelInput>, isCreate: boolean): string | null {
  if (isCreate) {
    if (b.category !== "llm" && b.category !== "embedding") return "category 需为 llm 或 embedding";
    if (!b.name?.trim()) return "name 必填";
    if (!b.url?.trim()) return "url 必填";
    if (!b.model?.trim()) return "model 必填";
    if (!b.key?.trim()) return "key 必填";
  } else {
    if (b.category && b.category !== "llm" && b.category !== "embedding") return "category 需为 llm 或 embedding";
    if (b.name !== undefined && !b.name.trim()) return "name 不能为空";
    if (b.url !== undefined && !b.url.trim()) return "url 不能为空";
    if (b.model !== undefined && !b.model.trim()) return "model 不能为空";
    if (b.key !== undefined && !b.key.trim()) return "key 不能为空";
  }
  return null;
}
