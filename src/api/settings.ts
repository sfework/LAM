import { getSettingDef } from "../settings/registry.js";
import { SettingValidationError, type SettingsService } from "../settings/service.js";
import { postRoutes, requireStr, badRequest, notFound, listRoute } from "./rest.js";

/**
 * /api/settings —— 系统设置读写（热更新，DESIGN §2.10、决策 45 + 47）。
 * POST /list { page?, pageSize? }   全部设置（含元数据，供前端按注册表渲染；分页 PaginationModel）
 * POST /get   { key }               单项
 * POST /set   { key, value }        更新（value 为字符串，服务端按类型校验；modelRef 校验模型存在与分类）
 */
export function createSettingsRouter(service: SettingsService) {
  return postRoutes({
    "/list": listRoute(() => service.listAll(), 1000),
    "/get": (b) => {
      const key = requireStr(b, "key");
      if (!getSettingDef(key)) notFound(`未知设置项: ${key}`);
      return service.listAll().find((e) => e.key === key)!;
    },
    "/set": (b) => {
      const key = requireStr(b, "key");
      if (!getSettingDef(key)) notFound(`未知设置项: ${key}`);
      const value = b.value;
      if (typeof value !== "string") badRequest('body 需为 { key, value: "字符串" }');
      try {
        return service.set(key, value);
      } catch (err) {
        if (err instanceof SettingValidationError) badRequest(err.message);
        throw err;
      }
    },
  });
}
