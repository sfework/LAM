import { createHash } from "node:crypto";

/** 内容 sha256（管理端乐观并发比对：编辑回传 sha 与库中当前 sha 一致才允许写）。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
