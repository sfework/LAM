import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createLogger } from "./infra/logger.js";
import { localDateTimeStr } from "./infra/localtime.js";
import { dataDir, listenHost, listenPort } from "./infra/paths.js";
import { createGatewayRouter, createBackgroundTasks, type GatewayDeps } from "./gateway/index.js";
import { createApiRouter, type ApiDeps } from "./api/index.js";
import { createInternalRouter, type InternalDeps } from "./api/internal.js";
import { createMcpRouter, type InternalCaller, type InternalResp } from "./mcp/server.js";
import { createSpaRouter } from "./web/spa.js";
import { openDb, type DbHandle } from "./db/client.js";
import { ModelRepo } from "./models/repo.js";
import { SettingsService } from "./settings/service.js";
import { ProjectRepo } from "./projects/repo.js";
import { DenoiseRepo } from "./denoise/repo.js";
import { AssetsRepo } from "./assets/repo.js";
import { SessionRepo } from "./gateway/sessions.js";
import { SnapshotBuilder } from "./gateway/snapshot.js";
import { L0Recorder } from "./memory/l0-recorder.js";
import { L1Store } from "./memory/l1-store.js";
import { L1Extractor } from "./memory/l1-extractor.js";
import { L2Refiner } from "./memory/l2-refiner.js";
import { ExtractionScheduler } from "./memory/scheduler.js";
import { MemoryRecaller } from "./memory/recall.js";
import { EmbeddingBackfiller } from "./memory/embed-backfill.js";
import { SkillExtractor } from "./memory/skill-extractor.js";
import { CodeGraphService } from "./codegraph/service.js";
import { SqlService } from "./sql/service.js";

/**
 * 主服务入口。
 *
 * 组成：/health + /v1/chat/completions 网关主链路 + /api/* 管理 + /mcp 工具面 + 前端 SPA 托管。
 * 业务配置全 DB；本文件只读取 PORT / DATA_DIR 两个环境变量。
 */

const log = createLogger("server");

export interface AppDeps {
  api: ApiDeps;
  gateway: GatewayDeps;
  internal: InternalDeps;
  healthExtra?: Record<string, unknown>;
  /** 前端构建产物目录（默认 frontend/dist，DESIGN 决策 46）。测试可注入。 */
  spaDistDir?: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: "local-agent-memory-gateway",
      stage: "P10-complete",
      time: localDateTimeStr(),
      ...deps.healthExtra,
    }),
  );

  app.route("/", createGatewayRouter(deps.gateway));
  app.route("/api", createApiRouter(deps.api));
  // 内部只读 API（供 /mcp 工具面调用，DESIGN §3）
  app.route("/internal", createInternalRouter(deps.internal));

  // MCP（Streamable HTTP，无状态）：与网关/管理 API 同端口，后缀 /mcp。
  // 工具调用直接走本 app 的 /internal 路由（进程内 fetch，免回环 HTTP）。
  const caller: InternalCaller = async (endpoint, params) => {
    const url = new URL(endpoint, "http://internal.local");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await app.fetch(new Request(url.toString(), { signal: AbortSignal.timeout(30_000) }));
    const json = (await res.json().catch(() => null)) as InternalResp | null;
    if (!json) return { ok: false, error: { code: "bad_gateway", message: `内部 API 无响应 (${endpoint})` } };
    return json;
  };
  app.route("/mcp", createMcpRouter(caller));

  // 前端 SPA：同域同端口托管，必须挂在所有后端路由之后（DESIGN 决策 46）。
  // 只接管 GET/HEAD 且非后端前缀的请求，未命中的客户端路由回退 index.html。
  app.route("/", createSpaRouter(deps.spaDistDir));

  return app;
}

/** 组装运行时依赖：打开 DB、初始化各仓储与服务。 */
export function bootstrap(): {
  app: Hono;
  handle: DbHandle;
  settings: SettingsService;
  projects: ProjectRepo;
  scheduler: ExtractionScheduler;
  codegraph: CodeGraphService;
} {
  mkdirSync(dataDir(), { recursive: true });

  const handle = openDb();
  const models = new ModelRepo(handle.raw);
  const settings = new SettingsService(handle.raw, models);
  settings.init();
  const projects = new ProjectRepo(handle.raw);
  const denoise = new DenoiseRepo(handle.raw);
  const assets = new AssetsRepo(handle.raw);
  const sessions = new SessionRepo(handle.raw);
  const snapshot = new SnapshotBuilder(assets, settings);
  const l0 = new L0Recorder(handle.raw, handle.fts5Available);
  const l1Store = new L1Store(handle.raw, handle.fts5Available, handle.vecAvailable);
  const l1Extractor = new L1Extractor(handle.raw, l1Store, settings);
  const l2 = new L2Refiner(handle.raw, l1Store, settings);
  // 日志用：把 projectId 解析成磁盘路径（提取/凝练日志输出项目路径）。
  l1Extractor.pathOf = (id) => projects.findById(id)?.path;
  l2.pathOf = (id) => projects.findById(id)?.path;
  const recaller = new MemoryRecaller(l1Store, settings);
  const backfiller = new EmbeddingBackfiller(l1Store, settings);
  const skillExtractor = new SkillExtractor(handle.raw, assets, settings);
  const scheduler = new ExtractionScheduler(handle.raw, settings, l1Extractor, l2, backfiller, skillExtractor);
  const codegraph = new CodeGraphService(handle.raw, settings, projects);
  const sql = new SqlService({ maxRows: () => settings.getInt("sql_query_max_rows") });

  const gatewayDeps: GatewayDeps = { projects, denoise, assets, settings, sessions, snapshot, l0, l2, recaller, codegraph };
  const internalDeps: InternalDeps = { projects, assets, l1: l1Store, l0, l2, recaller, settings, codegraph, sql };

  const app = createApp({
    api: { models, settings, projects, denoise, assets, codegraph, l0, l1: l1Store, l2, raw: handle.raw },
    gateway: gatewayDeps,
    internal: internalDeps,
    healthExtra: { fts5: handle.fts5Available, vec: handle.vecAvailable },
  });
  return { app, handle, settings, projects, scheduler, codegraph };
}

async function main(): Promise<void> {
  const { app, handle, scheduler, codegraph } = bootstrap();
  const background = createBackgroundTasks(scheduler, codegraph);
  await background.start();

  const port = listenPort();
  const host = listenHost();
  const server = serve({ fetch: app.fetch, port, hostname: host });

  log.info(
    { host, port, dataDir: dataDir(), node: process.version },
    `服务已启动: http://${host}:${port} (health: /health)`,
  );

  // 优雅关停：flush 后台任务 → 关 HTTP → 关 DB。
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "收到关停信号，开始优雅退出…");
    server.close(async (err) => {
      if (err) log.error({ err: String(err) }, "HTTP server 关闭异常");
      await background.stop();
      handle.close();
      log.info("已退出。");
      process.exit(0);
    });
    // 兜底：5s 内未关完强制退出
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// 仅在作为脚本直接运行时启动（便于测试导入 createApp/bootstrap）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, "启动失败");
    process.exit(1);
  });
}
