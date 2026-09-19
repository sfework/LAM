/**
 * 上游转发（DESIGN §2.1）。全局 fetch（Node 24 内置，Web ReadableStream）+ SSE 透传，
 * 旁路聚合 assistant 文本与 tool_calls。
 *
 * 旁路聚合结果供阶段 5 回流判定（isFinalAnswer：本轮无 tool_calls 才落 L0），
 * 本阶段先建立聚合能力，落库在阶段 5 接入。
 */

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
}

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

/** 把上游 OpenAI chat 响应（流式/非流式）透传，同时旁路聚合。 */
export async function forwardChat(
  upstream: UpstreamConfig,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<ForwardResult> {
  const url = joinUrl(upstream.baseUrl, "/chat/completions");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
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
  const aggregate = aggregateStream(toAgg);
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

/** 解析 SSE data: 行，累积 delta.content 与 delta.tool_calls 计数。 */
async function aggregateStream(stream: ReadableStream<Uint8Array>): Promise<AssistantAggregate> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let toolCallCount = 0;
  const seenToolCallIds = new Set<string>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    reader.releaseLock();
  }

  return { text, toolCallCount, final: toolCallCount === 0 };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  // base 可能已含 /v1；避免重复
  if (b.endsWith("/chat/completions")) return b;
  return `${b}${path}`;
}
