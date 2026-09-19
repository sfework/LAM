/**
 * LLM JSON 输出容错解析（参考 sanitizeJsonForParse）。
 * 处理：```json 代码块包裹、前后解释文本、尾逗号等常见格式瑕疵。
 */

/** 从 LLM 文本中提取并解析 JSON（数组或对象）。解析失败返回 null。 */
export function parseLlmJson<T>(raw: string): T | null {
  if (!raw) return null;
  let text = raw.trim();

  // 剥离 markdown 代码块修饰符
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = fence.exec(text);
  if (m) text = (m[1] ?? "").trim();

  // 截取首个 [ ... ] 或 { ... } 平衡段
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  const jsonText = text.slice(start, end);

  for (const candidate of [jsonText, removeTrailingCommas(jsonText)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

function removeTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}
