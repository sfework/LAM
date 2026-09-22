import { Hono } from "hono";
import type { Context } from "hono";
import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import { parseWorkspacePath } from "../projects/parse-workspace.js";
import type { DenoiseRepo } from "../denoise/repo.js";
import { denoiseMessages } from "../denoise/engine.js";
import type { AssetsRepo } from "../assets/repo.js";
import type { SettingsService } from "../settings/service.js";
import { SessionRepo, deriveSessionKey } from "./sessions.js";
import { SnapshotBuilder } from "./snapshot.js";
import { injectSnapshot } from "./snapshot.js";
import { chatCompletionsAdapter, firstUserText, type ChatMessage } from "./protocol.js";
import { forwardChat } from "./forwarder.js";
import type { L0Recorder } from "../memory/l0-recorder.js";
import type { L2Refiner } from "../memory/l2-refiner.js";
import type { MemoryRecaller } from "../memory/recall.js";
import { prependRecall } from "../memory/recall.js";
import type { CodeGraphService } from "../codegraph/service.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("gateway");

export interface GatewayDeps {
  projects: ProjectRepo;
  denoise: DenoiseRepo;
  assets: AssetsRepo;
  settings: SettingsService;
  sessions: SessionRepo;
  snapshot: SnapshotBuilder;
  l0: L0Recorder;
  l2: L2Refiner;
  recaller: MemoryRecaller;
  codegraph: CodeGraphService;
}

/** 统一 OpenAI 错误格式（DESIGN 决策 22：友好提示，不抛裸异常）。 */
function openaiError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message, type: "server_error" } }, status as 400);
}

export function createGatewayRouter(deps: GatewayDeps): Hono {
  const gw = new Hono();

  gw.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.messages)) {
      return openaiError(c, 400, "invalid_request", "请求体需含 messages 数组");
    }

    // 1. 项目登记（header 优先，正文兜底）
    const project = resolveProject(deps, c, body);
    if (project.error) return openaiError(c, 400, "invalid_request", project.error);

    // 1.5 CodeGraph 激活（幂等、非阻塞：首次排队全量首建 + 挂载 watcher）
    if (project.projectId) {
      try {
        deps.codegraph.activate(project.projectId, project.path);
      } catch (err) {
        log.warn({ err: String(err), projectId: project.projectId }, "CodeGraph 激活失败（不影响请求）");
      }
    }

    // 2. 解析协议
    const parsed = chatCompletionsAdapter.parse(body);

    // 3. 除噪（转发通道）
    const denoised = denoiseMessages(parsed.messages, deps.denoise.list(), "forward") as ChatMessage[];

    // 4. 会话判定 + 快照（服务端存储，每轮复用）
    const { snapshot, sessionKey } = resolveSnapshot(deps, project.projectId, project.path, denoised, c.req.header("x-session-id"));

    // 5. 注入快照到 system（方案 A）
    const withSnapshot = injectSnapshot(denoised, snapshot);

    // 5.5 每轮 L1 动态召回 → 拼到最后一条 user 之前（超时/失败降级空召回，不阻塞）
    // 检索词 = 最近 N 条 user 消息（N 热更可调，assistant 不参与防复述污染），提升短追问的召回准确率。
    const userMsgs = denoised.filter((m) => m.role === "user");
    const recallTurns = deps.settings.getInt("l1_recall_query_turns");
    const recentUsers = userMsgs.slice(-Math.max(1, recallTurns));
    const lastUser = userMsgs[userMsgs.length - 1];
    let finalMessages = withSnapshot;
    if (project.projectId && lastUser && recentUsers.length) {
      const { block, items } = await deps.recaller.recall(project.projectId, recentUsers.map((m) => m.content));
      if (block) finalMessages = prependRecall(withSnapshot, block);
      if (items.length) {
        log.info(
          { projectId: project.projectId, path: project.path, userMessage: lastUser.content, recalled: items },
          "L1 召回：注入命中记忆",
        );
      }
    }

    // 6. 上游配置（以设置为准，忽略客户端 model）
    const llm = deps.settings.getResolvedModel("gateway_llm");
    if (!llm) {
      return openaiError(c, 400, "llm_not_configured", "LLM 未配置，请在设置中绑定 gateway_llm");
    }

    // 7. 组装转发 body（重写 model，其余透传）
    const outReq = { ...parsed, messages: finalMessages, model: llm.model };
    const forwardBody = chatCompletionsAdapter.serialize(outReq);

    // 8. 转发 + 透传
    let result;
    try {
      result = await forwardChat({ baseUrl: llm.url, apiKey: llm.key }, forwardBody, {
        signal: c.req.raw.signal,
      });
    } catch (err) {
      log.error({ err: String(err), projectId: project.projectId }, "上游转发失败");
      return openaiError(c, 502, "upstream_error", "上游 LLM 不可达，请检查 gateway_llm 配置与网络");
    }

    // 9. 旁路聚合 → final answer 时 L0 回流（fire-and-forget，不阻塞响应）
    result.aggregate
      .then((agg) => {
        log.debug(
          { projectId: project.projectId, textLen: agg.text.length, toolCalls: agg.toolCallCount, final: agg.final },
          "本轮聚合完成",
        );
        // final answer → L0 回流（始终写 L0 + 累积调度器状态；
        // extraction_enabled 在阶段 6 调度器决定是否真正提取）
        if (agg.final) {
          // 用原始请求消息（未除噪）：recorder 内部按 memory 通道除噪 + 游标对齐
          deps.l0.recordTurn({
            projectId: project.projectId!,
            sessionKey,
            requestMessages: parsed.messages,
            aggregate: agg,
            allRules: deps.denoise.list(),
          });
          // CodeGraph：累积对话计数，达阈值增量索引（DESIGN 决策 67，fire-and-forget）
          try {
            deps.codegraph.onTurn(project.projectId!, project.path);
          } catch (err) {
            log.warn({ err: String(err), projectId: project.projectId }, "CodeGraph 对话触发失败（不影响请求）");
          }
        }
      })
      .catch((err) => log.warn({ err: String(err) }, "旁路聚合/回流异常（不影响已透传响应）"));

    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  });

  // 不开放其他 OpenAI 端点（DESIGN 决策 22）
  gw.all("/v1/*", (c) =>
    openaiError(c, 404, "endpoint_not_supported", "本网关仅支持 /v1/chat/completions"),
  );

  return gw;
}

function resolveProject(
  deps: GatewayDeps,
  c: Context,
  body: Record<string, unknown>,
): { projectId: string | null; path: string; error?: string } {
  let rawPath = c.req.header("x-project-path") ?? null;
  if (!rawPath || !normalizeProjectPath(rawPath)) rawPath = parseWorkspacePath(body);
  if (!rawPath || !normalizeProjectPath(rawPath)) {
    return { projectId: null, path: "", error: "无法确定项目路径（缺 x-project-path 且正文无法解析）" };
  }
  try {
    const { project, revived } = deps.projects.upsertOnRequest(rawPath);
    if (revived) log.debug({ projectId: project.id, path: project.path }, "已删除项目被再次请求，级联恢复");
    return { projectId: project.id, path: project.path };
  } catch (err) {
    return { projectId: null, path: "", error: `项目登记失败: ${String(err)}` };
  }
}

function resolveSnapshot(
  deps: GatewayDeps,
  projectId: string | null,
  projectPath: string,
  messages: readonly ChatMessage[],
  headerSessionId: string | undefined,
): { snapshot: string; sessionKey: string } {
  const now = Date.now();
  const ttl = deps.settings.getInt("session_ttl_minutes");

  const headerSid = headerSessionId?.trim();
  const sessionKey = headerSid
    ? headerSid
    : deriveSessionKey(projectId ?? "", firstUserText([...messages]));
  const source: "header" | "derived" = headerSid ? "header" : "derived";

  const existing = deps.sessions.get(sessionKey);
  if (existing && !SessionRepo.isExpired(existing, ttl, now)) {
    deps.sessions.touch(sessionKey, now);
    return { snapshot: existing.injectSnapshot, sessionKey }; // 复用（字节级一致）
  }

  const snap = deps.snapshot.build({ projectId, projectPath, memoryProfile: projectId ? deps.l2.read(projectId) : "" });
  // 新会话（或过期重建）：记录项目路径与注入内容全文，便于回放模型所见。
  log.info({ projectId, path: projectPath, sessionKey, snapshot: snap }, "新会话开启：注入快照");
  if (existing) {
    deps.sessions.setSnapshot(sessionKey, snap);
    deps.sessions.touch(sessionKey, now);
    return { snapshot: snap, sessionKey };
  }
  deps.sessions.create(sessionKey, projectId ?? "", source, now);
  deps.sessions.setSnapshot(sessionKey, snap);
  return { snapshot: snap, sessionKey };
}

/**
 * 后台任务：提取调度器（阶段 6）。CodeGraph watcher 阶段 9 接入。
 */
export interface GatewayBackground {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createBackgroundTasks(
  scheduler?: { start(): void; stop(): Promise<void> },
  codegraph?: { start(): void; stop(): Promise<void> },
): GatewayBackground {
  return {
    async start() {
      scheduler?.start();
      try {
        codegraph?.start();
      } catch (err) {
        log.warn({ err: String(err) }, "CodeGraph 启动失败（不影响网关）");
      }
    },
    async stop() {
      await scheduler?.stop();
      await codegraph?.stop();
    },
  };
}
