import type { DatabaseSync } from "node:sqlite";

/**
 * FTS5 虚拟表（幂等创建）。
 *
 * 采用「独立表 + 预切分 token」而非 external-content：
 * 索引前由 tokenizeForFts 做 CJK 二元组切分，绕开 unicode61 不切中文的问题。
 * 仅记忆表建索引：对话内容不参与关键词召回。
 */
export function ensureFtsTable(raw: DatabaseSync): void {
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
       content,
       memory_id UNINDEXED,
       project_id UNINDEXED,
       tokenize = 'unicode61 remove_diacritics 2'
     )`,
  );
}
