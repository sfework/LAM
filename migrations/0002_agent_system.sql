-- 系统级 Agent：system=1 的资产不可删除（Admin API / MCP agent_delete 均拒绝），仅可修改。
-- 「记忆整理Agent」为系统级。
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE agents SET system = 1 WHERE name = '记忆整理Agent';
