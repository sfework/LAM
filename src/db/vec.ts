import type { DatabaseSync } from "node:sqlite";

/** 向量维度：embedding 模型固定输出 1024 维。 */
export const EMBEDDING_DIM = 1024;

/**
 * sqlite-vec vec0 虚拟表（仅记忆建向量索引；画像全文注入无需检索）。
 * project_id 作 partition key，检索天然按项目隔离。
 * 仅在扩展加载成功时创建（DbHandle.vecAvailable）。
 */
export function ensureVecTable(raw: DatabaseSync): void {
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_vec USING vec0(
       memory_id TEXT PRIMARY KEY,
       embedding FLOAT[${EMBEDDING_DIM}] distance_metric=cosine,
       project_id TEXT partition key
     )`,
  );
}
