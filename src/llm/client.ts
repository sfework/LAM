/**
 * 极简 OpenAI-compatible LLM 客户端（内部调用，非网关转发）。
 * 用于 memory_llm（提取/冲突检测/画像凝练）。
 */

export interface LlmCallConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  json?: boolean;
  timeoutMs?: number;
  temperature?: number;
}

/** base 可能带或不带 /v1，统一拼到 /chat/completions。 */
export function joinChatUrl(base: string): string {
  const b = base.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

export async function chatComplete(
  cfg: LlmCallConfig,
  messages: LlmMessage[],
  opts: LlmCallOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = { model: cfg.model, messages };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const res = await fetch(joinChatUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`LLM 上游 ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json?.choices?.[0]?.message?.content ?? "";
}
