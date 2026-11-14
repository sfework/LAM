/**
 * MCP 工具定义（工具自描述，单一事实源）。
 * 每个工具映射到主服务 /internal/* 的端点；project_path 作为参数由模型回传
 * （注入快照里已带项目路径）。
 *
 * 与旧版差异：
 *  - 4 个方言 sql_query 工具合并为单个 sql_query（新功能 2：按项目 + 连接名解析连接，方言自动路由）。
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 转发目标：内部 API 路径。 */
  endpoint: string;
  /** 是否计入"每轮检索 3 次"限流（memory_search）。 */
  searchFamily?: boolean;
}

const PROJECT_PATH_PROP = {
  type: "string",
  description: "当前项目的工作区绝对路径（从系统提示 <project> 段的 path 字段原样复制，用于按项目隔离检索）。",
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "knowledge_read",
    description: "按 id 读取知识库条目的完整正文。project 级条目只能读本项目的，global 不限。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "知识条目 id（来自系统提示 <knowledge> 段的 id）" }, project_path: PROJECT_PATH_PROP }, required: ["id", "project_path"], additionalProperties: false },
    endpoint: "/internal/knowledge/read",
  },
  {
    name: "agent_read",
    description: "按 id 读取 Agent 的完整正文（子智能体定义）。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Agent id（来自系统提示 <agents> 段的 id）" }, project_path: PROJECT_PATH_PROP }, required: ["id", "project_path"], additionalProperties: false },
    endpoint: "/internal/agents/read",
  },
  {
    name: "knowledge_update",
    description:
      "按 id 部分更新知识库条目（title/description/body 至少传一个非空；正文建议先 knowledge_read 取原文再编辑）。生效开关/排序/归属范围仅管理台可改。project 级条目只能改本项目的，global 条目不限。不计入检索限流。【使用红线】写操作：除非用户明确要求修改知识库，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "知识条目 id（来自系统提示 <knowledge> 段的 id）。" },
        title: { type: "string", description: "新标题（可选，非空才生效）。" },
        description: { type: "string", description: "新描述（可选，非空才生效）。" },
        body: { type: "string", description: "新正文全文（可选，非空才生效；覆盖原正文）。" },
        project_path: PROJECT_PATH_PROP,
      },
      required: ["id", "project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/knowledge/update",
  },
  {
    name: "knowledge_create",
    description:
      "创建知识库条目（title/body 必填，description 可选；scope 缺省 project 挂当前项目，可显式 global；enabled 恒为生效，启停归管理台）。不计入检索限流。【使用红线】写操作：除非用户明确要求新增知识库条目，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        title: { type: "string", description: "条目标题。" },
        description: { type: "string", description: "一句话描述（注入清单时展示，建议 ≤120 字符）。" },
        body: { type: "string", description: "条目正文全文。" },
        scope: { type: "string", enum: ["project", "global"], description: "缺省 project（挂当前项目）；global 挂全局，所有项目可见。" },
      },
      required: ["project_path", "title", "body"],
      additionalProperties: false,
    },
    endpoint: "/internal/knowledge/create",
  },
  {
    name: "knowledge_delete",
    description:
      "按 id 物理删除知识库条目（不可恢复）。project 级条目只能删本项目的；global 条目可删但会记 WARN 审计日志。不计入检索限流。【使用红线】写操作：除非用户明确要求删除知识库条目，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "知识条目 id（来自系统提示 <knowledge> 段的 id）。" },
      },
      required: ["project_path", "id"],
      additionalProperties: false,
    },
    endpoint: "/internal/knowledge/delete",
  },
  {
    name: "agent_update",
    description:
      "按 id 部分更新 Agent 定义（name/description/body 至少传一个非空；正文建议先 agent_read 取原文再编辑）。生效开关/排序仅管理台可改。不计入检索限流。【使用红线】写操作：除非用户明确要求修改 Agent 定义，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent id（来自系统提示 <agents> 段的 id）。" },
        name: { type: "string", description: "新名称（可选，非空才生效）。" },
        description: { type: "string", description: "新描述（可选，非空才生效）。" },
        body: { type: "string", description: "新定义全文（可选，非空才生效；覆盖原正文）。" },
        project_path: PROJECT_PATH_PROP,
      },
      required: ["id", "project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/agents/update",
  },
  {
    name: "agent_create",
    description:
      "创建 Agent 定义（name/body 必填，description 可选；enabled 恒为生效，启停/排序归管理台）。不计入检索限流。【使用红线】写操作：除非用户明确要求新增 Agent，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        name: { type: "string", description: "Agent 名称。" },
        description: { type: "string", description: "一句话职责描述（注入清单时展示）。" },
        body: { type: "string", description: "Agent 定义全文（角色/工具/流程/红线，自包含可独立执行）。" },
      },
      required: ["project_path", "name", "body"],
      additionalProperties: false,
    },
    endpoint: "/internal/agents/create",
  },
  {
    name: "agent_delete",
    description:
      "按 id 物理删除 Agent 定义（不可恢复；Agent 为全局资产，删除会记 WARN 审计日志；系统级 Agent 不可删除）。不计入检索限流。【使用红线】写操作：除非用户明确要求删除 Agent，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "Agent id（来自系统提示 <agents> 段的 id）。" },
      },
      required: ["project_path", "id"],
      additionalProperties: false,
    },
    endpoint: "/internal/agents/delete",
  },
  {
    name: "memory_search",
    description: "检索项目结构化记忆（原子事实/偏好/决策/方法）。返回 id 与内容摘要。每轮最多调用 3 次（防检索死循环）。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        query: { type: "string", description: "检索关键词或问题。" },
        top_k: { type: "number", description: "返回条数上限（可选，默认取系统设置）。" },
      },
      required: ["project_path", "query"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/search",
    searchFamily: true,
  },
  // ── 记忆整理工具面：2 只读 + 4 写类（红线文案约束，不设口令闸）──
  {
    name: "memory_list",
    description:
      "分页枚举项目记忆（id/类型/优先级/情境/正文/生成时间）。scope=active（默认，活跃记忆）或 archived（已归档，附批次号，供复查）。只读工具，不计检索限流。【使用红线】读操作：大结果集请分页取，勿一次拉全量塞上下文。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        page: { type: "number", description: "页码（缺省 1）。" },
        pageSize: { type: "number", description: "每页条数（缺省 50，上限 200）。" },
        kind: { type: "string", enum: ["persona", "episodic", "instruction", "fact", "method", "artifact"], description: "按类型筛选（可选）。" },
        keyword: { type: "string", description: "正文模糊筛选（可选）。" },
        scope: { type: "string", enum: ["active", "archived"], description: "缺省 active；archived 查看已归档记忆。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/list",
  },
  {
    name: "profile_read",
    description: "读取项目画像全文与版本号。只读；子代理上下文缺 <memory> 段或核对画像残留段落时使用。",
    inputSchema: {
      type: "object",
      properties: { project_path: PROJECT_PATH_PROP },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/profile/read",
  },
  {
    name: "memory_archive",
    description:
      "批量归档记忆（软删，可恢复）：置 deleted_at + 批次号，行/索引/向量原地保留；返回 batch_id 供 memory_restore 回滚。单批不超过 200 条。不计检索限流。【使用红线】仅限「记忆整理Agent」调用；其他任何角色（含主助手）禁止调用——用户要求修改记忆时应委派记忆整理Agent。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        ids: { type: "array", items: { type: "string" }, description: "待归档记忆 id 数组（≤200）。" },
        reason: { type: "string", description: "一句判定依据（写入各条 metadata.archive_reason）。" },
      },
      required: ["project_path", "ids"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/archive",
  },
  {
    name: "memory_restore",
    description:
      "撤销归档：按 batch_id 整批恢复，或按 ids 逐条恢复（清除 deleted_at/批次号）。不计检索限流。【使用红线】仅限「记忆整理Agent」调用；其他任何角色禁止调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        batch_id: { type: "string", description: "归档批次号（memory_archive 返回值）。" },
        ids: { type: "array", items: { type: "string" }, description: "或按 id 列表恢复。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/restore",
  },
  {
    name: "memory_update",
    description:
      "改写单条记忆正文/优先级（整理判定 update 的执行入口；内容变化自动重建 FTS、失效向量待补嵌入）。不计检索限流。【使用红线】仅限「记忆整理Agent」调用；其他任何角色（含主助手）禁止调用——用户要求修改记忆时应委派记忆整理Agent。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "记忆 id（须属于本项目且活跃）。" },
        content: { type: "string", description: "新正文（现状陈述，一条一事）。" },
        priority: { type: "number", description: "新优先级（0-100，可选）。" },
      },
      required: ["project_path", "id"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/update",
  },
  {
    name: "profile_save",
    description:
      "回写项目画像（整理收尾：基于保留记忆重写全文；version 自增，内容未变则跳过）。不计检索限流。【使用红线】仅限「记忆整理Agent」调用；其他任何角色（含主助手）禁止调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        content: { type: "string", description: "画像全文（Markdown，只写最终形态）。" },
      },
      required: ["project_path", "content"],
      additionalProperties: false,
    },
    endpoint: "/internal/profile/save",
  },
  {
    name: "list_db_connections",
    description:
      "列出项目配置的数据库连接（返回连接名 name 与类型 db_type，不返回连接串）。" +
      "调用 sql_query 前先用本工具获知该项目可用的连接名。",
    inputSchema: {
      type: "object",
      properties: { project_path: PROJECT_PATH_PROP },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/sql/conns",
  },
  {
    name: "sql_query",
    description:
      "对项目配置的数据库连接执行只读查询，结果为 JSON 行数组。" +
      "需传入项目目录 project_path 与连接名 conn（连接名由 list_db_connections 获取，类型随连接确定无需另传），方言自动路由，无需传连接串。" +
      "连接名不存在时返回错误并提示该项目可用连接列表。" +
      "仅允许单条 SELECT/WITH 语句；含 INSERT、UPDATE、DELETE、DROP 等写操作关键字或一次多条语句会被拒绝。结果超行数上限会截断并提示。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        conn: { type: "string", description: "连接名（来自 list_db_connections 的 name）。" },
        sql: { type: "string", description: "要执行的 SELECT 查询语句（单条）。" },
      },
      required: ["project_path", "conn", "sql"],
      additionalProperties: false,
    },
    endpoint: "/internal/sql/query",
  },
];

export const SEARCH_FAMILY_LIMIT = 3;
