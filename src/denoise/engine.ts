/**
 * 消息除噪引擎（DESIGN §2.3）。纯函数，无 IO，便于单测与网关复用。
 *
 * 规则语义：
 *  - 删除模式（默认）：删除「开头文本」到「结束文本」之间的内容，**含两端标记本身**；
 *  - 提取模式（extract）：保留中间内容，仅剥掉两端标记（如只去 <context>…</context> 壳子）；
 *  - 字面量转义后拼 `start[\s\S]*?end` 非贪婪正则——开头与结尾必须同时出现才算命中，
 *    只有开头没找到结尾 → 不处理；多处命中 → 全处理；
 *  - start == end 时退化为处理该字面量的所有出现（提取模式下无中间内容可留，等同删除）；
 *  - 多条规则按 createdAt 升序依次叠加应用；
 *  - 作用范围：仅 user / assistant 的文本内容（tool 消息、tool_calls 不处理）；
 *  - 双通道：forward（转发生效）与 memory（记忆生效）各自独立筛选规则。 *
 * 后处理（与是否命中规则无关，零规则时也执行）：
 *  - user / assistant 的文本内容统一 trim（去首尾空白，含空格与空行）；
 *  - trim 后文本为空的 user / assistant 消息整条删除；
 *  - 例外：带 tool_calls 的 assistant 消息不删（其 content 常为空，删除会破坏
 *    与后续 tool 消息的配对，上游报 400）。 */

export interface DenoiseRuleData {
  id: string;
  startText: string;
  endText: string;
  /** true = 提取：保留命中区间内容，只删除两端标记；false = 整段删除（含标记）。 */
  extract: boolean;
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

/** 对单段文本应用一条规则（删除或提取，见 rule.extract）。 */
export function applyRuleToText(
  text: string,
  rule: Pick<DenoiseRuleData, "startText" | "endText" | "extract">,
): string {
  if (!text) return text;
  const { startText, endText, extract } = rule;
  if (!startText || !endText) return text;

  if (startText === endText) {
    // 退化：删除该字面量的所有出现（提取模式下区间为空，无内容可留，行为一致）
    return text.split(startText).join("");
  }

  const re = new RegExp(`${escapeRegExp(startText)}([\\s\\S]*?)${escapeRegExp(endText)}`, "g");
  // 提取用回调而非 "$1"：避免保留内容里的 $& / $1 等被当作替换模式转义。
  return extract ? text.replace(re, (_m, inner: string) => inner) : text.replace(re, "");
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

  const content = msg.content;
  if (typeof content === "string") {
    // 后处理 trim 无条件执行（即使零规则）。
    return { ...msg, content: applyRulesToText(content, rules).trim() };
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
        const next = applyRulesToText(b.text, rules).trim();
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

/** 判断消息经降噪后文本内容是否为空（用于删空）。 */
function isEmptyTextContent(msg: ChatMessageLike): boolean {
  const content = msg.content;
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content)) {
    // 只要存在非文本块（如 image）就视为有内容；文本块全部为空才算空。
    let hasNonText = false;
    for (const block of content as unknown[]) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        if (((block as { text: string }).text).trim() !== "") return false;
      } else {
        hasNonText = true;
      }
    }
    return !hasNonText;
  }
  // content 为 null/undefined 等非文本形态：视为空
  return content == null;
}

/**
 * 除噪整个消息队列（返回新数组；未改动的元素保持原引用）。
 * rules 传入全量规则即可，内部按通道筛选。
 *
 * 后处理：降噪 trim 后文本为空的 user/assistant 消息整条删除；
 * 带 tool_calls 的 assistant 消息例外保留（避免破坏 tool 配对）。
 */
export function denoiseMessages<T extends ChatMessageLike>(
  messages: readonly T[],
  rules: readonly DenoiseRuleData[],
  channel: DenoiseChannel,
): T[] {
  const selected = selectRules(rules, channel);
  return messages
    .map((m) => denoiseMessage(m, selected))
    .filter((m) => {
      if (m.role !== "user" && m.role !== "assistant") return true;
      // tool_calls 的 assistant：content 常为空，删除会致上游 400，保留。
      if (Array.isArray((m as { tool_calls?: unknown }).tool_calls) &&
        ((m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0) return true;
      return !isEmptyTextContent(m);
    });
}
