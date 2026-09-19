/**
 * 协议适配器（DESIGN §2.1、决策 35）。
 *
 * 本期只实现 ChatCompletionsAdapter；Responses API 留作扩展位（新增实现即可，
 * 除噪/注入/召回/回流等管线只认中间表示 ParsedChatRequest，不感知协议细节）。
 */

export interface ChatMessage {
  role: string;
  content?: unknown;
  [k: string]: unknown;
}

/** 协议无关中间表示。 */
export interface ParsedChatRequest {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  /** 除 model/messages/stream 外的其余字段，转发时原样透传（DESIGN 决策 17）。 */
  extra: Record<string, unknown>;
}

export interface ProtocolAdapter {
  readonly id: "chat-completions";
  parse(body: Record<string, unknown>): ParsedChatRequest;
  serialize(req: ParsedChatRequest): Record<string, unknown>;
}

/** 提取消息文本：string 或 [{type:"text",text:"..."}] 块数组。 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** 首条 user 消息文本（session_key 推导用，取除噪前原文，稳定）。 */
export function firstUserText(messages: readonly ChatMessage[]): string {
  for (const m of messages) {
    if (m.role === "user") return messageText(m.content);
  }
  return "";
}

export const chatCompletionsAdapter: ProtocolAdapter = {
  id: "chat-completions",
  parse(body) {
    const { model, messages, stream, ...extra } = body;
    return {
      messages: (Array.isArray(messages) ? messages : []) as ChatMessage[],
      model: typeof model === "string" ? model : "",
      stream: stream === true,
      extra,
    };
  },
  serialize(req) {
    const out: Record<string, unknown> = {
      ...req.extra,
      model: req.model,
      messages: req.messages,
    };
    if (req.stream) out.stream = true;
    return out;
  },
};
