import { createHash } from "node:crypto";

/** 文本 sha256（hex）：管理端内容变更比对用（L1 编辑/L2 画像保存，未变则跳过向量化/写库）。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
