import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createLogger } from "./infra/logger.js";
import { localDateTimeStr } from "./infra/localtime.js";
import { dataDir, listenHost, listenPort } from "./infra/paths.js";
import { openDb, type DbHandle } from "./db/client.js";
import { createGatewayRouter, createBackgroundTasks, type GatewayDeps } from "./gateway/index.js";
import { createApiRouter, type ApiDeps } from "./api/index.js";
import { createInternalRouter, type InternalDeps } from "./api/internal.js";
import { createMcpRouter, type InternalCaller, type InternalResp } from "./mcp/server.js";
import { ProjectRepo, DbConnRepo } from "./projects/repo.js";
import { AssetsRepo } from "./assets/repo.js";
import { ensureSystemAgents } from "./assets/system-agents.js";
import { MemoryRepo } from "./memory/memory-repo.js";
import { MemoryRecaller } from "./memory/recall.js";
import { ConversationRecorder } from "./memory/conversation-recorder.js";
import { ProfileRepo } from "./memory/profile-repo.js";
import { ProfileRefiner } from "./memory/profile-refiner.js";
import { MemoryExtractor } from "./memory/extractor.js";
import { ExtractionScheduler } from "./memory/scheduler.js";
import { EmbeddingBackfiller } from "./memory/embed-backfill.js";
import { SnapshotBuilder } from "./gateway/snapshot.js";
import { SessionRepo } from "./gateway/sessions.js";
import { DenoiseRepo } from "./denoise/repo.js";
import { ModelRepo } from "./models/repo.js";
import { SettingsService } from "./settings/service.js";
import { SqlService } from "./sqlquery/service.js";
import { createSpaRouter } from "./web/spa.js";

/**
 * 主服务入口。
 *
 * 组成：/health + /v1/chat/completions 网关主链路 + /api/* 管理 + /internal MCP 后端 + /mcp 工具面 + 前端 SPA 托管。
 * 业务配置全 DB；本文件只读取 PORT / DATA_DIR 等进程级环境变量。
 */

const log = createLogger("server");

export interface AppDeps {
  api?: ApiDeps;
  gateway?: GatewayDeps;
  internal: InternalDeps;
  healthExtra?: Record<string, unknown>;
  /** 前端构建产物目录（默认 frontend/dist，测试可注入）。 */
  spaDistDir?: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: "nlam",
      version: "2.0.0",
      time: localDateTimeStr(),
      ...deps.healthExtra,
    }),
  );

  if (deps.gateway) app.route("/", createGatewayRouter(deps.gateway));
  if (deps.api) app.route("/api", createApiRouter(deps.api));

  app.route("/internal", createInternalRouter(deps.internal));

  // MCP（Streamable HTTP，无状态）：与网关/管理 API 同端口，后缀 /mcp。
  // 工具调用直接走本 app 的 /internal 路由（进程内 fetch，免回环 HTTP）。
  // 参数约定统一：全部 JSON body，无 query 特殊分支。
  const caller: InternalCaller = async (endpoint, params) => {
    const res = await app.fetch(
      new Request(`http://internal.local${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    const json = (await res.json().catch(() => null)) as InternalResp | null;
    if (!json) return { ok: false, error: { code: "bad_gateway", message: `内部 API 无响应 (${endpoint})` } };
    return json;
  };
  app.route("/mcp", createMcpRouter(caller));

  // 前端 SPA：同域同端口托管，必须挂在所有后端路由之后。
  // 只接管 GET/HEAD 且非后端前缀的请求，未命中的客户端路由回退 index.html。
  app.route("/", createSpaRouter(deps.spaDistDir));

  return app;
}

/** 组装运行时依赖：打开 DB、初始化各仓储与服务。 */
export function bootstrap(): {
  app: Hono;
  handle: DbHandle;
  scheduler: ExtractionScheduler;
} {
  mkdirSync(dataDir(), { recursive: true });

  const handle = openDb();
  const projects = new ProjectRepo(handle.raw);
  const conns = new DbConnRepo(handle.raw);
  const assets = new AssetsRepo(handle.raw);
  const models = new ModelRepo(handle.raw);
  const settings = new SettingsService(handle.raw, models);
  settings.init();
  // 系统级预置资产：「记忆整理Agent」缺失时自动创建；已存在绝不覆盖 body（重启幂等）。
  ensureSystemAgents(handle.raw);
  const denoise = new DenoiseRepo(handle.raw);
  const sessions = new SessionRepo(handle.raw);
  const memories = new MemoryRepo(handle.raw, handle.fts5Available, handle.vecAvailable);
  const profiles = new ProfileRepo(handle.raw);
  const recorder = new ConversationRecorder(handle.raw);
  const recaller = new MemoryRecaller(memories, settings);
  const snapshot = new SnapshotBuilder(assets);
  const sql = new SqlService({ projects, conns, maxRows: () => settings.getInt("sql_query_max_rows") });

  // 记忆管线：提取 → 画像凝练 → 补嵌入 → 调度器
  const extractor = new MemoryExtractor(handle.raw, memories, settings);
  const refiner = new ProfileRefiner(handle.raw, memories, settings);
  // 日志用：把 projectId 解析成磁盘路径（提取/凝练日志输出项目路径）。
  extractor.pathOf = (id) => projects.findById(id)?.path;
  refiner.pathOf = (id) => projects.findById(id)?.path;
  const backfiller = new EmbeddingBackfiller(memories, settings);
  const scheduler = new ExtractionScheduler(handle.raw, settings, extractor, refiner, backfiller);

  const app = createApp({
    api: { models, settings, projects, conns, denoise, assets, conversations: recorder, memories, profiles: refiner },
    gateway: { projects, denoise, settings, sessions, snapshot, recorder, profiles, recaller },
    internal: { projects, assets, memories, profiles: refiner, recaller, settings, sql },
    healthExtra: { fts5: handle.fts5Available, vec: handle.vecAvailable },
  });
  return { app, handle, scheduler };
}

async function main(): Promise<void> {
  const { app, handle, scheduler } = bootstrap();
  const background = createBackgroundTasks(scheduler);
  await background.start();

  const port = listenPort();
  const host = listenHost();
  const server = serve({ fetch: app.fetch, port, hostname: host });
  log.info({ url: `http://${host}:${port}` }, "NLAM 已启动");

  // 优雅关停：flush 后台任务 → 关 HTTP → 关 DB。
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async (err) => {
      if (err) log.error({ err: String(err) }, "HTTP server 关闭异常");
      await background.stop();
      handle.close();
      process.exit(0);
    });
    // 兜底：5s 内未关完强制退出
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 仅在作为脚本直接运行时启动（便于测试导入 createApp/bootstrap）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, "启动失败");
    process.exit(1);
  });
}
