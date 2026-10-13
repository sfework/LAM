import type { ModelRepo, ModelInput, ModelCategory } from "../models/repo.js";
import type { SettingsService } from "../settings/service.js";
import type { L1Store } from "../memory/l1-store.js";
import { postRoutes, requireStr, optStr, badRequest, notFound, listRoute } from "./rest.js";

/**
 * /api/models —— 模型库 CRUD（DESIGN §2.9、决策 45 + 47 + 49 + 77）。
 * POST /list { category?, keyword?, page?, pageSize? }   分页；keyword 模糊匹配名称/模型名；
 *        排序 LLM 靠前再按名称 ASC；每行附 inUse（是否被设置引用）与 usedBy（引用它的设置键）。
 *      /get { id } | /create { category,name,url,model,key }（key 必填）
 *      /update { id, ... }（决策 77：**可编辑** url/key/model/name，下一调用即生效；
 *        分类恒禁改动——改类等于换模型，会造成 modelCategory 校验静默失效，应走"新建 + 重绑"；
 *        被引用的 embedding 模型改 url/model 触发全量向量失效，由补嵌入下个 tick 按新模型重建）
 *      /delete { id }（被引用则禁止，防悬挂引用）
 */
export function createModelsRouter(repo: ModelRepo, settings: SettingsService, l1?: L1Store) {
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
      const before = repo.get(id) ?? notFound("模型不存在");
      const usedBy = settings.modelUsage(id);
      // 决策 77：被引用可编辑（引用按 id 现查，下一调用即生效）；分类一律禁改——
      // 改类会让 getResolvedModel 的 modelCategory 校验静默失效（如嵌入模型改成 llm → 向量化停摆），
      // 且 llm/embedding 的 url/model 语义本就不同源，改类等于换模型，应走"新建 + 重绑"。
      if (b.category !== undefined && b.category !== before.category) {
        badRequest("编辑不可修改分类（如需换分类请新建模型并重绑设置）");
      }
      const updated = repo.update(id, b as unknown as Partial<ModelInput>) ?? notFound("模型不存在");
      // 被引用的 embedding 模型 url/model 实质变化 → 新旧向量语义空间不同，
      // 全量失效 mem_l1_vec，由补嵌入下个 tick 用新模型重建（DESIGN 决策 77）。
      if (
        l1 &&
        updated.category === "embedding" &&
        usedBy.length &&
        (updated.url !== before.url || updated.model !== before.model)
      ) {
        const n = l1.invalidateAllVectors();
        return { ...updated, vectorsInvalidated: n };
      }
      return updated;
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
