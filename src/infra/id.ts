import { randomUUID } from "node:crypto";

/** 生成带前缀的短 ID，便于日志与调试识别。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
