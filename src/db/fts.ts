import type { DatabaseSync } from "node:sqlite";

/**
 * FTS5 虚拟表（幂等创建）。
 *
 * 采用「独立表 + 预切分 token」而非 external-content：
 * 索引前由 tokenizeForFts 做 CJK 二元组切分，绕开 unicode61 不切中文的问题。
 * rowid 与 mem_l1.rowid 对齐，便于增删同步。
 *
 * 仅 L1 建索引：L0 全文检索（conversation_search）已随独立搜索机制移除，
 * mem_l0_fts 沦为只写不读的死索引（每轮回流白建索引 + 占库），故不再创建；
 * 对历史库幂等 DROP 回收空间（含 fts5 shadow 表）。
 */
export function ensureFtsTables(raw: DatabaseSync): void {
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS mem_l1_fts USING fts5(
       content,
       l1_id UNINDEXED,
       project_id UNINDEXED,
       tokenize = 'unicode61 remove_diacritics 2'
     )`,
  );
  raw.exec("DROP TABLE IF EXISTS mem_l0_fts");
}
