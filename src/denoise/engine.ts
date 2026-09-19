/**
 * 消息除噪引擎（DESIGN §2.3）。纯函数，无 IO，便于单测与网关复用。
 *
 * 规则语义：
 *  - 删除「开头文本」到「结束文本」之间的内容，**含两端标记本身**；
 *  - 字面量转义后拼 `start[\s\S]*?end` 非贪婪正则——开头与结尾必须同时出现才算命中，
 *    只有开头没找到结尾 → 不删；多处命中 → 全删；
 *  - start == end 时退化为删除该字面量的所有出现；
 *  - 多条规则按 createdAt 升序依次叠加应用；
 *  - 作用范围：仅 user / assistant 的文本内容（tool 消息、tool_calls 不处理）；
 *  - 双通道：forward（转发生效）与 memory（记忆生效）各自独立筛选规则。
 */

export interface DenoiseRuleData {
  id: string;
  startText: string;
  endText: string;
  applyForward: boolean;
  applyMemory: boolean;
  enabled: boolean;
  createdAt: number;
}

export type DenoiseChannel = "forward" | "memory";

/** 消息的最小结构约定（OpenAI chat messages 元素）。 */
export interface ChatMessageLike {
  role?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 对单段文本应用一条规则的删除。 */
export function applyRuleToText(text: string, rule: Pick<DenoiseRuleData, "startText" | "endText">): string {
  if (!text) return text;
  const { startText, endText } = rule;
  if (!startText || !endText) return text;

  if (startText === endText) {
    // 退化：删除该字面量的所有出现
    return text.split(startText).join("");
  }

  const re = new RegExp(`${escapeRegExp(startText)}[\\s\\S]*?${escapeRegExp(endText)}`, "g");
  return text.replace(re, "");
}

/** 按顺序对文本叠加应用多条规则。 */
export function applyRulesToText(text: string, rules: readonly DenoiseRuleData[]): string {
  let out = text;
  for (const rule of rules) out = applyRuleToText(out, rule);
  return out;
}

/** 按通道筛选生效规则（enabled + 通道开关，createdAt 升序）。 */
export function selectRules(rules: readonly DenoiseRuleData[], channel: DenoiseChannel): DenoiseRuleData[] {
  return rules
    .filter((r) => r.enabled && (channel === "forward" ? r.applyForward : r.applyMemory))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 除噪单条消息的文本内容（仅 user/assistant；返回新对象，不修改入参）。 */
export function denoiseMessage<T extends ChatMessageLike>(msg: T, rules: readonly DenoiseRuleData[]): T {
  if (msg.role !== "user" && msg.role !== "assistant") return msg;
  if (rules.length === 0) return msg;

  const content = msg.content;
  if (typeof content === "string") {
    return { ...msg, content: applyRulesToText(content, rules) };
  }
  if (Array.isArray(content)) {
    // 块数组：只处理 {type:"text", text:string} 块，其余块原样保留
    let changed = false;
    const blocks = (content as unknown[]).map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const b = block as { type: string; text: string };
        const next = applyRulesToText(b.text, rules);
        if (next !== b.text) {
          changed = true;
          return { ...b, text: next };
        }
      }
      return block;
    });
    return changed ? { ...msg, content: blocks } : msg;
  }
  return msg;
}

/**
 * 除噪整个消息队列（返回新数组；无命中时元素保持原引用）。
 * rules 传入全量规则即可，内部按通道筛选。
 */
export function denoiseMessages<T extends ChatMessageLike>(
  messages: readonly T[],
  rules: readonly DenoiseRuleData[],
  channel: DenoiseChannel,
): T[] {
  const selected = selectRules(rules, channel);
  return messages.map((m) => denoiseMessage(m, selected));
}
