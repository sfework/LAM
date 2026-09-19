import { messageText } from "../gateway/protocol.js";

/**
 * L0 入库前清洗（DESIGN §2.7，对齐参考项目 sanitize.ts / shouldCaptureL0）。
 * - 剥离注入标签段（防反馈回路：客户端把注入内容原样带回时不重复入库）；
 * - 噪音过滤：空文本、斜杠命令、框架噪音拒收。
 */

/** 网关注入的所有标签节（快照 + 召回块），入库前整段剥离。 */
const INJECTION_TAGS = ["prompts", "knowledge", "agents", "skills", "memory", "project", "recalled"] as const;

export function stripInjectionTags(text: string): string {
  let out = text;
  for (const tag of INJECTION_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
    // 未闭合的注入残留也剥掉（从开标签到结尾）。
    // 仅当开标签「独占一行」时才认定是残留——注入快照里每个标签都单独成行；
    // 这样可避免误伤正文里行内提及标签名的正常内容（如 ` ` <knowledge>` / ` `）。
    out = out.replace(new RegExp(`(?:^|\\n)<${tag}>[ \\t]*(?:\\n[\\s\\S]*)?$`, "g"), "");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** 框架噪音特征（客户端模板噪声，可按需扩充）。 */
const FRAMEWORK_NOISE: RegExp[] = [
  /^I (am|'m) working in a workspace/i, // VS Code Copilot 环境段残留
  /^<environment_info>/i,
  /^\[context\]/i,
];

/**
 * L0 捕获判定（参考 shouldCaptureL0 简化）：
 * 空文本、纯注入残留、斜杠命令、框架噪音 → 拒收。
 */
export function shouldCaptureL0(rawContent: unknown): { ok: boolean; text: string } {
  let text = messageText(rawContent);
  text = stripInjectionTags(text);
  if (!text.trim()) return { ok: false, text: "" };
  if (text.startsWith("/")) return { ok: false, text }; // 斜杠命令
  for (const re of FRAMEWORK_NOISE) {
    if (re.test(text)) return { ok: false, text };
  }
  return { ok: true, text };
}
