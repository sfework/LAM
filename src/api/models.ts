import type { ModelRepo, ModelInput, ModelCategory } from "../models/repo.js";
import { normalizeModels } from "../models/repo.js";
import type { SettingsService } from "../settings/service.js";
import type { L1Store } from "../memory/l1-store.js";
import { postRoutes, requireStr, optStr, badRequest, notFound, listRoute, ApiError } from "./rest.js";

/**
 * /api/models —— 模型库 CRUD（DESIGN §2.9、决策 45 + 47 + 49 + 77）。
 * POST /list { category?, keyword?, page?, pageSize? }   分页；keyword 模糊匹配名称/模型名；
 *        排序 LLM 靠前再按名称 ASC；每行附 inUse（是否被设置引用）与 usedBy（引用它的设置键）。
 *      /get { id } | /create { category,name,url,model,key }（model 可空：条目即“提供商”，
 *        绑定时可在设置里指定模型名；key 必填）
 *      /fetch-list { id } 或 { url, key }：调提供商 GET {url}/models 读可用模型列表
 *        （OpenAI 兼容；10s 超时；失败/不支持时前端回退手输模型名）
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
    },
    "/fetch-list": async (b) => {
      // id 优先（读库中 url/key）；也支持未保存条目的 { url, key } 直传（编辑弹窗试拉）。
      const id = optStr(b, "id");
      let url = optStr(b, "url") ?? "";
      let key = optStr(b, "key") ?? "";
      if (id) {
        const m = repo.get(id) ?? notFound("模型不存在");
        url = m.url;
        key = m.key;
      }
      if (!url) badRequest("需要 id 或 url");
      return fetchProviderModels(url, key);
    },    "/create": (b) => {
      const err = validateInput(b as unknown as Partial<ModelInput>, true);
      if (err) badRequest(err);
      const input = b as unknown as ModelInput;
      const models = normalizeModels(input.models);
      // 默认模型：显式填了用填写值，否则取清单首项（两者皆空=纯提供商，绑定时再指定）。
      const model = input.model?.trim() || models[0] || "";
      return repo.create({ ...input, model, models, modelMode: input.modelMode === "manual" ? "manual" : "auto" });
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
      const input = b as unknown as Partial<ModelInput>;
      const nextModels = input.models !== undefined ? normalizeModels(input.models) : undefined;
      // 默认模型：显式传 model 用之（允许空=取消默认）；清单变了取首项；否则保持原值。
      const nextModel = input.model !== undefined
        ? input.model.trim()
        : nextModels !== undefined
          ? (nextModels.includes(before.model) ? before.model : (nextModels[0] ?? ""))
          : before.model;
      // 守卫：把 model 清空会让引用它的"纯 id 绑定"（无覆盖模型名）失去模型名，
      // 等价于静默停摆——拒绝，提示先在设置里补齐绑定或改为覆盖名。
      if (before.model && !nextModel) {
        const broken = settings
          .modelBindingDetails(id)
          .filter((d) => !d.modelName)
          .map((d) => d.key);
        if (broken.length) {
          badRequest(`该模型被设置以纯 id 方式引用（${broken.join("、")}），清空模型名会使其失效；请先在设置中改绑为「提供商+模型名」`);
        }
      }
      const updated = repo.update(id, {
        ...(b as unknown as Partial<ModelInput>),
        model: nextModel,
        models: nextModels ?? before.models,
        modelMode: input.modelMode === "manual" ? "manual" : input.modelMode === "auto" ? "auto" : before.modelMode,
      }) ?? notFound("模型不存在");
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
    if (!b.key?.trim()) return "key 必填";
  } else {
    if (b.category && b.category !== "llm" && b.category !== "embedding") return "category 需为 llm 或 embedding";
    if (b.name !== undefined && !b.name.trim()) return "name 不能为空";
    if (b.url !== undefined && !b.url.trim()) return "url 不能为空";
    // model 允许传空串（清空 → 条目退化为纯提供商，绑定名由设置覆盖）；仅拒非字符串。
    if (b.model !== undefined && typeof b.model !== "string") return "model 需为字符串";
    if (b.key !== undefined && !b.key.trim()) return "key 不能为空";
  }
  return null;
}

/**
 * 调提供商 GET {url}/models（OpenAI 兼容口径：url 末尾自动补 /v1 已由调用方保证，
 * 此处只做 {url}/models 拼接与 { data: [{ id }] } 解析）。
 * 失败/超时/非标准响应抛可读文案（前端提示“该提供商不支持列表，请手输”）。
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ models: string[]; count: number }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ApiError(502, "fetch_failed", `请求提供商模型列表失败：${String(err)}`);
  }
  if (!res.ok) throw new ApiError(502, "fetch_failed", `提供商返回 ${res.status}，可能不支持 /models 端点`);
  const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const list = Array.isArray(body?.data) ? body!.data! : null;
  if (!list) throw new ApiError(502, "bad_format", "提供商返回体不符合 OpenAI /models 格式，请手输模型名");
  const models = [...new Set(list.map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean))].sort();
  return { models, count: models.length };
}
