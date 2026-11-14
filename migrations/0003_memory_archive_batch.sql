-- 记忆归档批次号：memory_archive 写入、memory_restore 按批撤销。
--> statement-breakpoint
ALTER TABLE memory_items ADD COLUMN archive_batch TEXT;
--> statement-breakpoint
CREATE INDEX idx_mem_archive_batch ON memory_items(project_id, archive_batch) WHERE archive_batch IS NOT NULL;
