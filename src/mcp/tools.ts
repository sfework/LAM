/**
 * MCP 薄壳的工具定义（DESIGN §3、决策 9：工具自描述）。
 * 每个工具映射到主服务 /internal/* 的一个只读端点；project_path 作为参数由模型回传
 * （注入块里已带项目路径，见 DESIGN §2.6）。
 * （CodeGraph 8 工具已随功能整体移除。）
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 转发目标：内部 API 路径。 */
  endpoint: string;
  /** 是否计入"每轮检索 3 次"限流（memory_search / conversation_search）。 */
  searchFamily?: boolean;
}

const PROJECT_PATH_PROP = {
  type: "string",
  description: "当前项目的工作区绝对路径（从系统提示 <project> 段的 path 字段原样复制，用于按项目隔离检索）。",
};

/** 方言 → 工具名后缀与连接串格式说明（写进描述，让模型知道该传什么）。 */
const SQL_DIALECTS: { key: string; label: string; conn: string }[] = [
  { key: "sqlite", label: "SQLite", conn: "数据库文件绝对路径（如 e:/data/app.db），或 Data Source=... 形式" },
  { key: "postgresql", label: "PostgreSQL", conn: "postgres://user:pass@host:5432/dbname，或 keyword=value 形式" },
  { key: "mysql", label: "MySQL", conn: "mysql://user:pass@host:3306/dbname，或 Server=...;Database=...;Uid=...;Pwd=...;" },
  { key: "sqlserver", label: "SQL Server", conn: "Server=host,1433;Database=db;User Id=sa;Password=...;TrustServerCertificate=True;" },
];

/** 生成 12 个 SQL 工具定义（每方言三个），端点按方言走路径段。
 * 注意：knowledge/agent 的 list 工具已移除（决策 70）——清单已注入系统提示，模型按 id 直接 read 即可；
 * internal 的 knowledge/agents list 端点保留（供管理台与 simulate-usage 脚本使用）。
 * （技能 skill 资产与 skill_read 工具已随功能整体移除。） */
function sqlToolDefs(): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const d of SQL_DIALECTS) {
    const connProp = { type: "string", description: `连接字符串（${d.conn}）。` };
    defs.push({
      name: `sql_query_${d.key}`,
      description:
        `${d.label} 只读查询，结果为 JSON 行数组。仅允许单条 SELECT/WITH 语句；含 INSERT、UPDATE、DELETE、DROP 等写操作关键字或一次多条语句会被拒绝。结果超行数上限会截断并提示。`,
      inputSchema: {
        type: "object",
        properties: {
          connection_string: connProp,
          sql: { type: "string", description: "要执行的 SELECT 查询语句（单条）。" },
        },
        required: ["connection_string", "sql"],
        additionalProperties: false,
      },
      endpoint: `/internal/sql/${d.key}/query`,
    });
    defs.push({
      name: `sql_list_tables_${d.key}`,
      description: `列出 ${d.label} 库中的表与视图（可按名称关键字模糊过滤）。写 SQL 前先用它了解有哪些表。`,
      inputSchema: {
        type: "object",
        properties: {
          connection_string: connProp,
          keyword: { type: "string", description: "表名模糊过滤关键字（可选）。" },
        },
        required: ["connection_string"],
        additionalProperties: false,
      },
      endpoint: `/internal/sql/${d.key}/tables`,
    });
    defs.push({
      name: `sql_describe_table_${d.key}`,
      description: `查看 ${d.label} 指定表的列结构（列名/类型/是否可空/默认值/主键）。`,
      inputSchema: {
        type: "object",
        properties: {
          connection_string: connProp,
          table: { type: "string", description: "表名（可带 schema 前缀，如 public.users）。" },
        },
        required: ["connection_string", "table"],
        additionalProperties: false,
      },
      endpoint: `/internal/sql/${d.key}/describe`,
    });
  }
  return defs;
}

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
      "按 id 物理删除 Agent 定义（不可恢复；Agent 为全局资产，删除会记 WARN 审计日志）。不计入检索限流。【使用红线】写操作：除非用户明确要求删除 Agent，否则禁止自行调用。",
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
    description: "检索项目结构化记忆（L1，原子事实/偏好/决策/方法）。返回 id 与内容摘要，配合 memory_batch_read 取原文溯源。与 conversation_search 每轮合计最多调用 3 次。",
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
  {
    name: "memory_batch_read",
    description:
      "分页读取当前项目的全部活跃结构化记忆（含 id/类型/正文/优先级/时间），用于记忆审计、清理与批量维护前的全量盘点。按创建时间从早到晚排列（越早的记忆越靠前，第 1 页为最老条目）；单条检索请用 memory_search。不计入检索限流。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        page: { type: "number", description: "页码，从 1 开始（默认 1）。" },
        page_size: { type: "number", description: "单页条数（默认 20，上限 100）。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/batch-read",
  },
  {
    name: "memory_batch_update",
    description:
      "批量维护（更新/删除）项目结构化记忆，用于 Agent 主动修正错述、合并改写或清理过时条目。items 单批最多 50 条；action 缺省 update（改 content），delete 为物理删除。逐条返回结果，单条失败不影响其余。不计入检索限流。【使用红线】写操作：除非用户明确要求整理/维护记忆，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        items: {
          type: "array",
          description: "批量操作清单。",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "记忆 id（来自 memory_search / memory_batch_read）。" },
              content: { type: "string", description: "新正文（update 必填，≤2000 字符）。" },
              action: { type: "string", enum: ["update", "delete"], description: "缺省 update。" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["project_path", "items"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/batch-update",
  },
  {
    name: "memory_profile_read",
    description:
      "读取当前项目的 L2 画像全文（技术栈/约定/偏好/经验等稳定上下文的凝练文档，快照每轮常驻注入）。返回 content、version、updatedAt。画像工具面仅开放读/整篇覆盖写，无 create/delete：新建由凝练管线自动完成，删除/重置归管理台。不计入检索限流。",
    inputSchema: {
      type: "object",
      properties: { project_path: PROJECT_PATH_PROP },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/profile",
  },
  {
    name: "memory_profile_update",
    description:
      "整篇覆盖保存当前项目的 L2 画像（先 memory_profile_read 取原文，在其基础上编辑后提交全量 content）。内容实质未变时不写库、version 不自增。画像为凝练文档，禁止追加拼接式提交；无删除工具，重置/清空归管理台。不计入检索限流。【使用红线】写操作：除非用户明确要求修改项目画像，否则禁止自行调用。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        content: { type: "string", description: "画像全文（Markdown，非空；覆盖原画像）。" },
      },
      required: ["project_path", "content"],
      additionalProperties: false,
    },
    endpoint: "/internal/memory/save-profile",
  },
  {
    name: "conversation_search",
    description: "检索项目原始对话记录（L0），用于查找具体消息原文、时间线，或校验/补全 memory_search 结果。与 memory_search 每轮合计最多调用 3 次。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        query: { type: "string" },
        limit: { type: "number", description: "返回条数上限（可选）。" },
      },
      required: ["project_path", "query"],
      additionalProperties: false,
    },
    endpoint: "/internal/conversation/search",
    searchFamily: true,
  },

  // ── SQL 只读查询（四方言 × query / list_tables / describe_table；不依赖 project_path，不计入检索限流）──
  ...sqlToolDefs(),
];

export const SEARCH_FAMILY_LIMIT = 3;
