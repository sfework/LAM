/**
 * OpenAI content 块的共用判定（此前散落于 gateway/protocol 与 denoise/engine）。
 * content 既可能是 string，也可能是 [{type:"text",text:"..."} | {type:"image_url",...}] 块数组。
 */

/** 判断 content 元素是否为 {type:"text", text:string} 文本块（其余形态如 image_url 不算）。 */
export function isTextBlock(block: unknown): block is { type: string; text: string } {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * 把纯文本拼接到消息 content 上（string 直接接；块数组补一个 text 块；空值直接成文本）。
 * head=true 文本放最前（召回块注入），false 放最后（快照追加）。其余形态原样返回。
 */
export function mergeContentText(content: unknown, text: string, head: boolean): unknown {
  if (content === undefined || content === null || content === "") return text;
  if (typeof content === "string") return head ? `${text}\n\n${content}` : `${content}\n\n${text}`;
  if (Array.isArray(content)) return head ? [{ type: "text", text }, ...content] : [...content, { type: "text", text }];
  return content;
}
