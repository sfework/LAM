-- 画像更新门控（memory_llm 五类分类门控）：
-- 连续跳过计数持久化，达 profile_gate_max_skip_streak 兜底强制凝练，防分类误判累积。
-- 独立小表：pipeline_states 每项目按 session 多行，项目级计数无处安放。
--> statement-breakpoint
CREATE TABLE profile_gate_states (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  skip_streak INTEGER NOT NULL DEFAULT 0,
  -- 已判定跳过的记忆水位（该项目最新记忆 created_at）：同水位不重复调门控 LLM
  gated_memory_ts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
