/**
 * 从请求正文解析工作区路径（DESIGN §2.1 预留扩展落地，移植自 C# 版实现）。
 *
 * VS Code 类客户端会把 <workspace_info> 段（形如 "- d:\Work\MyProject"）放进
 * 提示词，BYOK 等无法传自定义头的客户端即靠它定位项目。
 *
 * pi / Claude Code 等 CLI 类客户端无 <workspace_info> 段，但在 system 提示中
 * 固定注入工作目录：
 *   - pi v1.x：`<cwd>\nE:/Code/LAM\n</cwd>` 段（反斜杠已转正斜杠）；
 *   - pi 旧版/扩展、Claude Code（<env> 块）：`Working directory: <path>` 行
 *     （含 Primary/Current 前缀变体，大小写不敏感）。
 * 均为 Windows/Unix 绝对路径，段缺失时按此顺序解析。
 *
 * 收紧口径：只认 <workspace_info> 段内的路径；段缺失时仅在指令消息
 * （system 或其别名 developer）内兜底（先认 cwd 段/标注行，再扫行首盘符路径）。
 * 用户消息与工具返回常含目录列表等 "- C:\..." 文本，纳入扫描会被登记成垃圾项目。
 */

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/** 指令角色：system 或其别名 developer（pi 等 reasoning 客户端发 developer）。 */
function isInstructionRole(role: unknown): boolean {
  return role === "system" || role === "developer";
}

/** 从 OpenAI chat body 解析工作区路径；解析不到返回 null，任何异常都吞掉。 */
export function parseWorkspacePath(body: unknown): string | null {
  try {
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) return null;

    // all：全部消息文本，用于定位 <workspace_info> 段（该段可能落在任意角色上）
    // system：仅 system/developer 消息文本，作为段缺失时的兜底扫描范围
    const all: string[] = [];
    const system: string[] = [];
    for (const item of messages) {
      if (!item || typeof item !== "object") continue;
      const msg = item as MessageLike;
      collectText(msg.content, all);
      if (isInstructionRole(msg.role)) collectText(msg.content, system);
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
    const sysText = system.join("\n");
    // pi 类 CLI：<cwd> 段 > cwd 标注行 > 行首盘符兜底
    return matchCwdSection(sysText) ?? matchCwdLine(sysText) ?? matchPath(sysText);
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

/**
 * 匹配 system 内的 <cwd> 段（pi v1.x 系统提示固定渲染为
 * `<cwd>\nE:/Code/LAM\n</cwd>`）。取段内首行，仅当值为绝对路径时采用，
 * 否则返回 null 交回其他兜底规则。
 */
export function matchCwdSection(text: string): string | null {
  if (!text) return null;
  const m = /<cwd>[ \t]*\r?\n?[ \t]*([^\r\n<]*)/.exec(text);
  if (!m) return null;
  const p = (m[1] ?? "").trim();
  return isAbsolutePath(p) ? p : null;
}

/**
 * 匹配 cwd 标注行：pi（"Current working directory: ..."，含 SSH/Gondolin 扩展的
 * 行尾括号注释）、Claude Code（<env> 块内 "Working directory: ..."、
 * "Primary working directory: ..."）与 VS Code 智能体（同文案但带 "- " / "* "
 * bullet 前缀）。支持 Windows 盘符、Unix 绝对路径与 UNC；值不是绝对路径时返回
 * null，交回其他兜底规则。
 */
export function matchCwdLine(text: string): string | null {
  if (!text) return null;
  const re = /^[ \t]*(?:[-*][ \t]*)?(?:(?:primary|current) )?working directory:[ \t]*(.+?)[ \t]*$/im;
  const m = re.exec(text);
  if (!m) return null;
  const p = (m[1] ?? "").replace(/\s*\([^)]*\)[ \t]*$/, "").trim();
  if (!isAbsolutePath(p)) return null;
  return p || null;
}

/** 绝对路径判定：Windows 盘符 / UNC / Unix 根起头。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}
