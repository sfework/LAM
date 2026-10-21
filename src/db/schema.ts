import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 全量 schema（DESIGN.md §4）。阶段 1 一次建全，后续阶段只做查询/写入不改结构。
 * 约定：
 * - 时间戳一律 integer epoch ms；布尔 integer mode boolean；JSON 列 text。
 * - 软删统一 deleted_at（NULL=正常），恢复=置 NULL。
 * - FTS5 / vec0 虚拟表不在 drizzle 内定义，由 db/fts.ts、db/vec.ts 以原生 SQL 幂等创建。
 */

/** projects：path 为规范化后小写无尾斜杠的唯一键 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastActiveAt: integer("last_active_at", { mode: "number" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "number" }),
  },
  (t) => [uniqueIndex("uq_projects_path").on(t.path), index("ix_projects_deleted").on(t.deletedAt)],
);

/** prompts：enabled 互斥（最多 1 条生效）由服务层保证 */
export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  content: text("content").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/** agents：子智能体定义（正文），全局，清单注入（id+标题+描述），sort_order 取 top */
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  body: text("body").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order", { mode: "number" }).notNull().default(0),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/** knowledge：scope global|project（唯一带项目维度的资产），清单注入 + MCP 读正文 */
export const knowledge = sqliteTable(
  "knowledge",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    body: text("body").notNull().default(""),
    scope: text("scope").$type<"global" | "project">().notNull().default("global"),
    projectId: text("project_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order", { mode: "number" }).notNull().default(0),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "number" }),
  },
  (t) => [index("ix_knowledge_project").on(t.projectId)],
);

/** denoise_rules：转发/记忆双通道独立；多条按 createdAt 顺序叠加；extract=提取（去标记留内容） */
export const denoiseRules = sqliteTable("denoise_rules", {
  id: text("id").primaryKey(),
  startText: text("start_text").notNull(),
  endText: text("end_text").notNull(),
  extract: integer("extract", { mode: "boolean" }).notNull().default(false),
  applyForward: integer("apply_forward", { mode: "boolean" }).notNull().default(true),
  applyMemory: integer("apply_memory", { mode: "boolean" }).notNull().default(true),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/** models：模型库（llm|embedding），条目=LLM 提供商；models_json 为提供商下可用模型清单快照
 *  （/models 拉取或手输，不支持 /models 时通常只有手输的一个）；model 为默认模型（清单首项），
 *  供 settings 纯 id 绑定回退；绑定值 id:model 可指定清单内其他模型。 */
export const models = sqliteTable(
  "models",
  {
    id: text("id").primaryKey(),
    category: text("category").$type<"llm" | "embedding">().notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    key: text("key").notNull().default(""),
    model: text("model").notNull(),
    modelsJson: text("models_json").notNull().default("[]"),
    /** 模型录入模式：auto=自动获取（清单为 /models 全量）；manual=手工输入（清单仅一个手输模型）。 */
    modelMode: text("model_mode").$type<"auto" | "manual">().notNull().default("auto"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("ix_models_category").on(t.category)],
);

/** settings：键值设置，值以字符串存，类型解析按注册表；热更新 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

/** mem_l0：只存 user/assistant 纯文本；唯一索引兜底防重复回流 */
export const memL0 = sqliteTable(
  "mem_l0",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sessionKey: text("session_key").notNull(),
    turnSeq: integer("turn_seq", { mode: "number" }).notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("uq_l0_turn").on(t.projectId, t.sessionKey, t.turnSeq, t.role),
    index("ix_l0_project").on(t.projectId, t.deletedAt),
  ],
);

/** mem_l1：小颗粒原子条目（L1+L2 合并层），superseded_by 软替换 */
export const memL1 = sqliteTable(
  "mem_l1",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    priority: integer("priority", { mode: "number" }).notNull().default(60),
    sceneName: text("scene_name"),
    sourceL0Ids: text("source_l0_ids").notNull().default("[]"),
    /** 提取侧 metadata（JSON）：episodic 的 activity_start_time/activity_end_time 等 */
    metadata: text("metadata").notNull().default("{}"),
    batchId: text("batch_id"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    supersededBy: text("superseded_by"),
    deletedAt: integer("deleted_at", { mode: "number" }),
  },
  (t) => [index("ix_l1_project").on(t.projectId, t.deletedAt)],
);

/** mem_l2：项目画像，每项目单份，凝练替换更新（version 自增） */
export const memL2 = sqliteTable(
  "mem_l2",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    content: text("content").notNull().default(""),
    version: integer("version", { mode: "number" }).notNull().default(0),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "number" }),
  },
  (t) => [uniqueIndex("uq_l2_project").on(t.projectId)],
);

/** pipeline_state：提取调度器状态（缓冲、上批情境） */
export const pipelineState = sqliteTable(
  "pipeline_state",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sessionKey: text("session_key").notNull(),
    conversationCount: integer("conversation_count", { mode: "number" }).notNull().default(0),
    lastSceneName: text("last_scene_name"),
    lastL2At: integer("last_l2_at", { mode: "number" }),
    bufferedMessageIds: text("buffered_message_ids").notNull().default("[]"),
  },
  (t) => [uniqueIndex("uq_pipeline_session").on(t.projectId, t.sessionKey)],
);

/** sessions：会话快照锚点（inject_snapshot 每轮复用保 KV cache） */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    sessionKey: text("session_key").notNull(),
    projectId: text("project_id").notNull(),
    source: text("source").$type<"derived" | "header">().notNull().default("derived"),
    injectSnapshot: text("inject_snapshot").notNull().default(""),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "number" }).notNull(),
    handledCount: integer("handled_count", { mode: "number" }).notNull().default(0),
  },
  (t) => [uniqueIndex("uq_sessions_key").on(t.sessionKey), index("ix_sessions_project").on(t.projectId)],
);

// （CodeGraph 已移除：原 cg_status 表随迁移 0012 删除。）
