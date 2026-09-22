import { Hono } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import { createLogger } from "../infra/logger.js";
import { TOOL_DEFS, SEARCH_FAMILY_LIMIT } from "./tools.js";

const log = createLogger("mcp");

/**
 * MCP Server（Streamable HTTP，DESIGN §3、决策 44）。
 *
 * 挂在主服务 /mcp 路径上，与网关（/v1/*）、管理 API（/api/*）共用同一端口。
 * 无状态模式：每个 HTTP 请求新建一对 Server + Transport 处理完即弃
 * （SDK 要求 stateless transport 不可复用；本地单用户无需跨请求会话）。
 * enableJsonResponse=true：以普通 JSON 回应，不维持 SSE 长连接。
 *
 * 工具处理不直连 SQLite：通过 InternalCaller 调 /internal/* 只读端点。
 * 主服务挂载时注入进程内 app.fetch（免回环 HTTP）；也可注入自定义实现（测试用）。
 */

const WINDOW_MS = Number(process.env.MCP_SEARCH_WINDOW_MS || 30_000);

/** 滚动窗口限流：key → 最近调用时间戳数组。 */
class RollingLimiter {
  private hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  /** 记录一次并返回是否超限。 */
  take(key: string): { allowed: boolean; used: number } {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    return { allowed: arr.length <= this.limit, used: arr.length };
  }
}

/** 整个 MCP 面共用一个限流器（跨请求生效，防检索死循环的本意不变）。 */
const limiter = new RollingLimiter(SEARCH_FAMILY_LIMIT, WINDOW_MS);

export interface InternalResp {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/** 内部端点调用器：由挂载方注入（进程内 fetch 或回环 HTTP）。 */
export type InternalCaller = (endpoint: string, params: Record<string, unknown>) => Promise<InternalResp>;

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** 构建一个 MCP Server 实例（无状态：每请求一个）。 */
export function buildMcpServer(call: InternalCaller): Server {
  const server = new Server(
    { name: "local-agent-memory-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const start = Date.now();
    // 审计日志：每次 callTool 记一条（工具名 / 项目路径 / 入参 / 结果 / 耗时）。
    // 按用户要求原样记录入参（含 SQL 工具连接串），日志文件即含敏感口令，仅本地使用。
    const audit = (status: "ok" | "error" | "denied" | "unknown" | "limited", extra?: Record<string, unknown>) =>
      log.info({ tool: name, projectPath: args.project_path ?? null, args, status, ms: Date.now() - start, ...extra }, "MCP callTool");

    const def = TOOL_DEFS.find((t) => t.name === name);
    if (!def) {
      audit("unknown");
      return { ...textContent(`未知工具: ${name}`), isError: true };
    }

    // 检索族限流（按 project_path 分组，滚动时间窗）
    if (def.searchFamily) {
      const key = String(args.project_path ?? "_");
      const { allowed, used } = limiter.take(key);
      if (!allowed) {
        audit("limited", { used });
        return textContent(
          `已达本轮检索上限（${SEARCH_FAMILY_LIMIT} 次，当前第 ${used} 次）。该信息可能不在记忆中，请停止继续检索，基于已有信息作答。`,
        );
      }
    }

    let resp: InternalResp;
    try {
      resp = await call(def.endpoint, args);
    } catch (err) {
      audit("error", { err: String(err) });
      return { ...textContent(`调用内部 API 失败：${String(err)}`), isError: true };
    }

    if (!resp.ok) {
      audit("error", { message: resp.error?.message ?? "unknown" });
      return { ...textContent(`错误：${resp.error?.message ?? "unknown"}`), isError: true };
    }
    // SQL 工具把校验/查询失败作为 { error } 数据返回（ok:true），审计里标 denied 便于统计被拒查询。
    const sqlError = typeof resp.data === "object" && resp.data !== null && "error" in resp.data;
    audit(sqlError ? "denied" : "ok");
    return textContent(formatData(resp.data));
  });

  return server;
}

function formatData(data: unknown): string {
  if (data == null) return "（无结果）";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

/**
 * 创建 /mcp 路由（Streamable HTTP，无状态）。
 * @param caller 内部端点调用器（主服务传进程内 fetch 适配器）
 */
export function createMcpRouter(caller: InternalCaller): Hono {
  const mcp = new Hono();

  const handle = async (c: Context): Promise<Response> => {
    const server = buildMcpServer(caller);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态
      enableJsonResponse: true, // 纯 JSON 应答，不起 SSE 流
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      log.error({ err: String(err) }, "MCP 请求处理异常");
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    } finally {
      // 无状态：响应产出后异步释放本请求的 server/transport
      setTimeout(() => void server.close().catch(() => undefined), 0);
    }
  };

  mcp.post("/", handle);
  mcp.get("/", handle);
  mcp.delete("/", handle);

  return mcp;
}
