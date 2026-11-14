-- NLAM 初始 schema：项目 / 连接 / 对话 / 记忆 / 画像 / 资产 / 会话 / 设置
--> statement-breakpoint
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE TABLE project_db_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  db_type TEXT NOT NULL CHECK (db_type IN ('sqlite', 'mysql', 'postgresql', 'sqlserver')),
  connection_string TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, name)
);
--> statement-breakpoint
-- 每项目最多一条启用的连接
CREATE UNIQUE INDEX uq_conn_enabled ON project_db_connections(project_id) WHERE enabled = 1;
--> statement-breakpoint
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_key TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (project_id, session_key, turn_seq, role)
);
--> statement-breakpoint
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('persona', 'episodic', 'instruction', 'fact', 'method', 'artifact')),
  content TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 60,
  scene_name TEXT,
  source_conversation_ids TEXT,
  metadata TEXT,
  batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  superseded_by TEXT,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX idx_mem_project_active ON memory_items(project_id, created_at DESC) WHERE deleted_at IS NULL AND superseded_by IS NULL;
--> statement-breakpoint
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE TABLE pipeline_states (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_key TEXT NOT NULL,
  user_msg_count INTEGER NOT NULL DEFAULT 0,
  last_scene_name TEXT,
  last_profile_at INTEGER,
  buffered_message_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE (project_id, session_key)
);
--> statement-breakpoint
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id),
  source TEXT NOT NULL CHECK (source IN ('derived', 'header')),
  inject_snapshot TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  handled_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE knowledges (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  body TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('global', 'project')),
  project_id TEXT REFERENCES projects(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX idx_knowledge_project ON knowledges(project_id) WHERE scope = 'project' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE denoise_rules (
  id TEXT PRIMARY KEY,
  start_text TEXT NOT NULL,
  end_text TEXT NOT NULL,
  extract INTEGER NOT NULL DEFAULT 0,
  apply_forward INTEGER NOT NULL DEFAULT 1,
  apply_memory INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('llm', 'embedding')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  key TEXT,
  model TEXT,
  models_json TEXT,
  model_mode TEXT NOT NULL DEFAULT 'auto' CHECK (model_mode IN ('auto', 'manual')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
