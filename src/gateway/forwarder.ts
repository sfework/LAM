/**
 * 上游转发：undici fetch + 自定义 Agent（超时可配）+ SSE 透传，
 * 旁路聚合 assistant 文本与 tool_calls。
 *
 * 旁路聚合结果供对话回流判定（final：本轮无 tool_calls 才落对话记录）。
 *
 * 超时策略（长回复宽超时 + 空闲仅告警）：Node 内置 fetch 走 undici 默认
 * headers/body 300s，推理模型深度思考（响应前/流中长时间无字节）会被掐断。
 * 这里改用 undici 包 fetch + Agent(headersTimeout/bodyTimeout=设置值，0=不限)。
 * 注意：Node 内置 fetch 不接受外部 undici 版本的 dispatcher（接口不兼容），
 * 必须用 undici 自带 fetch。流式空闲仅告警不断流（见 idleWarnMs）。
 */

import { Agent, fetch as undiciFetch } from "undici";
import { createLogger } from "../infra/logger.js";

const log = createLogger("gateway:forwarder");

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * 转发所需的最小请求形态（自有类型，避开 @types/node 的 undici-types 与
 * undici@8 自带类型的互不兼容问题）。
 */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  dispatcher?: unknown;
}
/** 可注入的 fetch（默认真实 undiciFetch，测试可替换）。 */
export type FetchFn = (url: string, init: FetchInit) => Promise<Response>;

export interface ForwardResult {
  status: number;
  contentType: string;
  /** 透传给客户端的响应体流（非流式时为已缓冲的字节流）。 */
  body: ReadableStream<Uint8Array>;
  /** 聚合出的完整 assistant 文本（流结束后 resolve）。 */
  aggregate: Promise<AssistantAggregate>;
}

export interface AssistantAggregate {
  text: string;
  toolCallCount: number;
  /** 是否为 final answer（无 tool_calls）。 */
  final: boolean;
}

/**
 * Agent 按超时值复用（设置几乎不变，键数量以不同取值为上界）。
 * timeoutMs=0 → undici 不限（headers/body 均不因静默掐断流）。
 */
const agentCache = new Map<number, Agent>();
function agentFor(timeoutMs: number): Agent {
  let a = agentCache.get(timeoutMs);
  if (!a) {
    a = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    agentCache.set(timeoutMs, a);
  }
  return a;
}

/** 把上游 OpenAI chat 响应（流式/非流式）透传，同时旁路聚合。 */
export async function forwardChat(
  upstream: UpstreamConfig,
  body: Record<string, unknown>,
  opts: {
    signal?: AbortSignal;
    /** 上游等待超时（响应头与流式块间静默共用），ms；0=不限。 */
    timeoutMs?: number;
    /** 流式空闲告警阈值（ms），0=不告警；只记日志不断流。 */
    idleWarnMs?: number;
    /** 注入 fetch（测试用），默认真实 undiciFetch。 */
    fetchFn?: FetchFn;
  } = {},
): Promise<ForwardResult> {
  const url = joinUrl(upstream.baseUrl, "/chat/completions");
  // undici@8 的 Response 与全局 Response 类型存在细微差异，运行时等价，收敛为全局形态。
  const doFetch = opts.fetchFn ?? ((u: string, init: FetchInit) => undiciFetch(u, init as never) as unknown as Promise<Response>);
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
    dispatcher: agentFor(opts.timeoutMs ?? 0),
  });

  const contentType = res.headers.get("content-type") ?? "application/json";
  const isStream = contentType.includes("text/event-stream");
  const source = res.body as ReadableStream<Uint8Array>;

  if (!isStream) {
    // 非流式：读全量，解析 choices[0].message，透传原始字节
    const buf = new Uint8Array(await res.arrayBuffer());
    const aggregate = Promise.resolve(aggregateNonStream(buf));
    return {
      status: res.status,
      contentType,
      body: new Blob([buf]).stream() as ReadableStream<Uint8Array>,
      aggregate,
    };
  }

  // 流式：tee 一份给旁路聚合，一份透传
  const [toClient, toAgg] = source.tee();
  const aggregate = aggregateStream(toAgg, opts.idleWarnMs ?? 0);
  return { status: res.status, contentType, body: toClient, aggregate };
}

function aggregateNonStream(buf: Uint8Array): AssistantAggregate {
  try {
    const json = JSON.parse(new TextDecoder().decode(buf));
    const msg = json?.choices?.[0]?.message ?? {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0;
    const text = typeof msg.content === "string" ? msg.content : "";
    return { text, toolCallCount: toolCalls, final: toolCalls === 0 };
  } catch {
    return { text: "", toolCallCount: 0, final: true };
  }
}

/** 解析 SSE data: 行，累积 delta.content 与 delta.tool_calls 计数。idleWarnMs>0 时空闲超阈值仅告警不断流。 */
async function aggregateStream(stream: ReadableStream<Uint8Array>, idleWarnMs: number): Promise<AssistantAggregate> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let toolCallCount = 0;
  const seenToolCallIds = new Set<string>();
  // 空闲告警计时：每次读到数据重置；超阈值只 warn 一次（直到再有数据）
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (!idleWarnMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.warn({ idleWarnMs }, "流式转发上游静默超阈值（继续等待，不断流）");
    }, idleWarnMs);
  };

  try {
    for (;;) {
      armIdle();
      const { done, value } = await reader.read();
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 按 SSE 事件分隔（\n\n）切分
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta;
            if (!delta) continue;
            if (typeof delta.content === "string") text += delta.content;
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const id = tc?.id;
                if (id && !seenToolCallIds.has(id)) {
                  seenToolCallIds.add(id);
                  toolCallCount++;
                } else if (!id && tc?.index !== undefined && !seenToolCallIds.has(`idx:${tc.index}`)) {
                  // 部分上游增量只带 index 不带 id（首帧带 id，后续帧续写 arguments）
                  seenToolCallIds.add(`idx:${tc.index}`);
                  toolCallCount++;
                }
              }
            }
          } catch {
            /* 单帧解析失败忽略，不影响透传 */
          }
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    reader.releaseLock();
  }

  return { text, toolCallCount, final: toolCallCount === 0 };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  // base 可能已含 /v1 或完整路径；避免重复拼接
  if (b.endsWith("/chat/completions")) return b;
  return `${b}${path}`;
}
