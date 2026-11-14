import { Hono } from "hono";
import type { ModelRepo } from "../models/repo.js";
import type { SettingsService } from "../settings/service.js";
import type { ProjectRepo, DbConnRepo } from "../projects/repo.js";
import type { DenoiseRepo } from "../denoise/repo.js";
import type { AssetsRepo } from "../assets/repo.js";
import type { MemoryRepo } from "../memory/memory-repo.js";
import type { ProfileRefiner } from "../memory/profile-refiner.js";
import type { ConversationRecorder } from "../memory/conversation-recorder.js";
import { createModelsRouter } from "./models.js";
import { createSettingsRouter } from "./settings.js";
import { createProjectsRouter } from "./projects.js";
import { createDenoiseRulesRouter } from "./denoise-rules.js";
import { createAssetsRouters } from "./assets.js";
import { createLogsRouter } from "./logs.js";
import { createMemoriesRouter } from "./memories.js";
import { createToolsRouter } from "./tools.js";
import { errBody } from "./rest.js";

export interface ApiDeps {
  models: ModelRepo;
  settings: SettingsService;
  projects: ProjectRepo;
  conns: DbConnRepo;
  denoise: DenoiseRepo;
  assets: AssetsRepo;
  conversations: ConversationRecorder;
  memories: MemoryRepo;
  profiles: ProfileRefiner;
}

/**
 * /api/* 管理路由聚合：全部 POST + JSON body，
 * 响应统一 { success, code, message, data }，列表返回 PaginationModel。
 * 未匹配的路径/方法一律返回 501（同包络）。
 */
export function createApiRouter(deps: ApiDeps): Hono {
  const api = new Hono();

  api.route("/models", createModelsRouter(deps.models, deps.settings, deps.memories));
  api.route("/settings", createSettingsRouter(deps.settings));
  api.route("/projects", createProjectsRouter(deps.projects, deps.conns));
  api.route("/denoise-rules", createDenoiseRulesRouter(deps.denoise));

  const assets = createAssetsRouters(deps.assets);
  api.route("/prompts", assets.prompts);
  api.route("/agents", assets.agents);
  api.route("/knowledge", assets.knowledge);
  api.route("/memories", createMemoriesRouter({
    conversations: deps.conversations,
    memories: deps.memories,
    profiles: deps.profiles,
    settings: deps.settings,
    projects: deps.projects,
  }));
  api.route("/logs", createLogsRouter());
  api.route("/tools", createToolsRouter());

  api.all("/*", (c) =>
    c.json(
      {
        ...errBody(501, "该管理 API 不存在或不支持此方法（统一约定：POST /api/<资源>/<action> + JSON body）"),
        path: c.req.path,
      },
      501,
    ),
  );

  return api;
}
