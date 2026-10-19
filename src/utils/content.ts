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
