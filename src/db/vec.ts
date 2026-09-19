import type { DatabaseSync } from "node:sqlite";
import { EMBEDDING_DIM } from "../memory/embedding.js";

/**
 * sqlite-vec vec0 虚拟表（仅 L1 建向量索引；L2 画像全文注入无需检索）。
 * project_id 作 partition key，检索天然按项目隔离。
 * 仅在扩展加载成功时创建（DbHandle.vecAvailable）。
 */
export function ensureVecTable(raw: DatabaseSync): void {
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS mem_l1_vec USING vec0(
       l1_id TEXT PRIMARY KEY,
       embedding FLOAT[${EMBEDDING_DIM}] distance_metric=cosine,
       project_id TEXT partition key
     )`,
  );
}
