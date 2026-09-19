/**
 * 从请求正文解析工作区路径（DESIGN §2.1 预留扩展落地，移植自 C# 版实现）。
 *
 * VS Code 类客户端会把 <workspace_info> 段（形如 "- d:\Work\MyProject"）放进
 * 提示词，BYOK 等无法传自定义头的客户端即靠它定位项目。
 *
 * 收紧口径：只认 <workspace_info> 段内的路径；段缺失时仅在 system 消息内兜底。
 * 用户消息与工具返回常含目录列表等 "- C:\..." 文本，纳入扫描会被登记成垃圾项目。
 */

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/** 从 OpenAI chat body 解析工作区路径；解析不到返回 null，任何异常都吞掉。 */
export function parseWorkspacePath(body: unknown): string | null {
  try {
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) return null;

    // all：全部消息文本，用于定位 <workspace_info> 段（该段可能落在任意角色上）
    // system：仅 system 消息文本，作为段缺失时的兜底扫描范围
    const all: string[] = [];
    const system: string[] = [];
    for (const item of messages) {
      if (!item || typeof item !== "object") continue;
      const msg = item as MessageLike;
      collectText(msg.content, all);
      if (msg.role === "system") collectText(msg.content, system);
    }

    const allText = all.join("\n");
    const tag = allText.indexOf("<workspace_info>");
    if (tag >= 0) {
      // 以 </workspace_info> 收口，避免越界扫到后续对话正文
      const close = allText.indexOf("</workspace_info>", tag);
      const region = close >= 0 ? allText.slice(tag, close) : allText.slice(tag);
      const hit = matchPath(region);
      if (hit) return hit;
    }
    return matchPath(system.join("\n"));
  } catch {
    return null;
  }
}

/** content 可能是字符串，或 [{type:"text",text:"..."}] 块数组。 */
function collectText(content: unknown, out: string[]): void {
  if (typeof content === "string") {
    if (content) out.push(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        out.push((block as { text: string }).text);
      }
    }
  }
}

/** 匹配形如 "- d:\Work\MyProject"（或裸 Windows 盘符路径）的行。 */
export function matchPath(text: string): string | null {
  if (!text) return null;
  const re = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?([a-zA-Z]:[\\/][^\r\n]*)/;
  const m = re.exec(text);
  if (!m) return null;
  const p = (m[1] ?? "").trim();
  return p || null;
}
