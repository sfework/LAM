-- 取消数据库连接启用逻辑：连接不再有启停状态，多条连接平等可用，调用方按连接名选择。
-- 先删依赖 enabled 列的部分唯一索引，再删列。
DROP INDEX IF EXISTS uq_conn_enabled
--> statement-breakpoint
ALTER TABLE project_db_connections DROP COLUMN enabled
