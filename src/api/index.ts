import { Hono } from "hono";
import type { ModelRepo } from "../models/repo.js";
import type { SettingsService } from "../settings/service.js";
import type { ProjectRepo } from "../projects/repo.js";
import type { DenoiseRepo } from "../denoise/repo.js";
import type { AssetsRepo } from "../assets/repo.js";
import { createModelsRouter } from "./models.js";
import { createSettingsRouter } from "./settings.js";
import { createProjectsRouter } from "./projects.js";
import { createDenoiseRulesRouter } from "./denoise-rules.js";
import { createAssetsRouters } from "./assets.js";
import { createCodegraphRouter } from "./codegraph.js";
import type { CodeGraphService } from "../codegraph/service.js";
import { createDbRouter } from "./db.js";
import { createLogsRouter } from "./logs.js";
import { createMemoriesRouter } from "./memories.js";
import { createToolsRouter } from "./tools.js";
import type { DatabaseSync } from "node:sqlite";
import type { L1Store } from "../memory/l1-store.js";
import type { L2Refiner } from "../memory/l2-refiner.js";
import type { L0Recorder } from "../memory/l0-recorder.js";
import { errBody } from "./rest.js";

export interface ApiDeps {
  models: ModelRepo;
  settings: SettingsService;
  projects: ProjectRepo;
  denoise: DenoiseRepo;
  assets: AssetsRepo;
  codegraph: CodeGraphService;
  l0: L0Recorder;
  l1: L1Store;
  l2: L2Refiner;
  raw: DatabaseSync;
}

/**
 * /api/* 管理路由聚合（DESIGN 决策 45 + 47：全部 POST + JSON body，
 * 响应统一 { success, code, message, data }，列表返回 PaginationModel）。
 * 未匹配的路径/方法一律返回 501（同包络）。
 */
export function createApiRouter(deps: ApiDeps): Hono {
  const api = new Hono();

  api.route("/models", createModelsRouter(deps.models, deps.settings));
  api.route("/settings", createSettingsRouter(deps.settings));
  api.route("/projects", createProjectsRouter(deps.projects, deps.codegraph));
  api.route("/denoise-rules", createDenoiseRulesRouter(deps.denoise));

  const assets = createAssetsRouters(deps.assets);
  api.route("/prompts", assets.prompts);
  api.route("/agents", assets.agents);
  api.route("/skills", assets.skills);
  api.route("/knowledge", assets.knowledge);
  api.route("/codegraph", createCodegraphRouter(deps.codegraph, deps.projects));
  api.route("/memories", createMemoriesRouter({ l0: deps.l0, l1: deps.l1, l2: deps.l2, settings: deps.settings, projects: deps.projects }));
  api.route("/db", createDbRouter(deps.raw));
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
