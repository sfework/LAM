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

/**
 * skills：技能资产，带版本链与来源标记（DESIGN §2.5、决策 68）。
 * - version/status/superseded_by：版本化——正文实质变化时旧行置 superseded、插入 version+1 新行，
 *   镜像 mem_l1.superseded_by 的软替换语义（旧版不物理删，保留溯源）。
 * - source：manual（手工维护）| auto（对话自动抽取，默认 enabled=false 待人工审核）。
 * - project_id：null=全局；非空=项目隔离技能（自动抽取绑定来源项目）。
 */
export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    body: text("body").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order", { mode: "number" }).notNull().default(0),
    version: integer("version", { mode: "number" }).notNull().default(1),
    status: text("status").$type<"active" | "superseded">().notNull().default("active"),
    source: text("source").$type<"manual" | "auto">().notNull().default("manual"),
    supersededBy: text("superseded_by"),
    projectId: text("project_id"),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("ix_skills_project").on(t.projectId), index("ix_skills_status").on(t.status)],
);

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

/** models：模型库（llm|embedding），供 settings 按 id 绑定 */
export const models = sqliteTable(
  "models",
  {
    id: text("id").primaryKey(),
    category: text("category").$type<"llm" | "embedding">().notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    key: text("key").notNull().default(""),
    model: text("model").notNull(),
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
  (t) => [index("ix_l1_project").on(t.projectId, t.deletedAt), index("ix_l1_batch").on(t.batchId)],
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

/** extract_queue：崩溃恢复重入队；attempts 达上限置 failed */
export const extractQueue = sqliteTable(
  "extract_queue",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sessionKey: text("session_key").notNull(),
    type: text("type").$type<"l1" | "l2">().notNull(),
    status: text("status").$type<"pending" | "processing" | "done" | "failed">().notNull().default("pending"),
    payload: text("payload").notNull().default("{}"),
    attempts: integer("attempts", { mode: "number" }).notNull().default(0),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("ix_queue_status").on(t.status)],
);

/** pipeline_state：提取调度器状态（warm-up 阈值、缓冲、上批情境、L0 游标） */
export const pipelineState = sqliteTable(
  "pipeline_state",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sessionKey: text("session_key").notNull(),
    conversationCount: integer("conversation_count", { mode: "number" }).notNull().default(0),
    warmupThreshold: integer("warmup_threshold", { mode: "number" }).notNull().default(0),
    lastSceneName: text("last_scene_name"),
    lastL1At: integer("last_l1_at", { mode: "number" }),
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

/**
 * cg_status：每项目的 CodeGraph 索引状态（DESIGN 决策 67：图数据本体已外置到
 * {DATA_DIR}/codegraph/<项目哈希>/codegraph.db——vendored @colbymchenry/codegraph
 * 的独立索引库，由 CODEGRAPH_STORE_ROOT 重定向；gateway.db 只留状态与计数）。
 * - status：pending（未建/待建）/ indexing / ready / failed；
 * - turnsSinceIndex：距上次索引累积的对话轮数（final answer 计 1），达到
 *   codegraph_reindex_every_conversations 即触发 sync；
 * - totalFiles/indexedFiles：最近一次索引的文件进度快照（索引中供前端展示）。
 */
export const cgStatus = sqliteTable("cg_status", {
  projectId: text("project_id").primaryKey(),
  status: text("status").notNull().default("pending"),
  totalFiles: integer("total_files", { mode: "number" }).notNull().default(0),
  indexedFiles: integer("indexed_files", { mode: "number" }).notNull().default(0),
  turnsSinceIndex: integer("turns_since_index", { mode: "number" }).notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  lastIndexedAt: integer("last_indexed_at", { mode: "number" }),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});
