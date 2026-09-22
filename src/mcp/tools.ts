/**
 * MCP 薄壳的工具定义（DESIGN §3、决策 9：工具自描述，无额外注入文案）。
 * 每个工具映射到主服务 /internal/* 的一个只读端点；project_path 作为参数由模型回传
 * （注入块里已带项目路径，见 DESIGN §2.6）。
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
 * 注意：knowledge/agent/skill 的 list 工具已移除（决策 70）——清单已注入系统提示，模型按 id 直接 read 即可；
 * internal 的 knowledge/agents/skills list 端点保留（供管理台与 simulate-usage 脚本使用）。 */
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
    description: "按 id 读取知识库条目的完整正文。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "知识条目 id（来自系统提示 <knowledge> 段的 id）" } }, required: ["id"], additionalProperties: false },
    endpoint: "/internal/knowledge/read",
  },
  {
    name: "agent_read",
    description: "按 id 读取 Agent 的完整正文（子智能体定义）。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Agent id（来自系统提示 <agents> 段的 id）" } }, required: ["id"], additionalProperties: false },
    endpoint: "/internal/agents/read",
  },
  {
    name: "skill_read",
    description: "按 id 读取技能的完整正文。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "技能 id（来自系统提示 <skills> 段的 id）" } }, required: ["id"], additionalProperties: false },
    endpoint: "/internal/skills/read",
  },
  {
    name: "memory_search",
    description: "检索项目结构化记忆（L1，原子事实/偏好/决策/方法）。返回 id 与内容摘要，配合 memory_read 取原文溯源。与 conversation_search 每轮合计最多调用 3 次。",
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
    name: "memory_read",
    description: "按 id 读取一条记忆及其溯源的原始对话片段。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "记忆 id（来自 memory_search）" } }, required: ["id"], additionalProperties: false },
    endpoint: "/internal/memory/read",
  },
  {
    name: "memory_read_profile",
    description: "读取当前项目的画像全文（技术栈/约定/偏好/经验）。",
    inputSchema: { type: "object", properties: { project_path: PROJECT_PATH_PROP }, required: ["project_path"], additionalProperties: false },
    endpoint: "/internal/memory/profile",
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

  // ── CodeGraph（DESIGN §2.8，8 工具；均只读、不计入检索限流）──
  {
    name: "codegraph_search",
    description:
      "在项目代码符号索引中搜索（FTS 前缀 + camelCase 段词 + 子串兜底，大小写不敏感）。支持 kind:/lang:/path:/name: 字段过滤（如 \"kind:class path:controller auth\"）。返回符号 id/名称/类型/所在文件/行号。用于定位某个函数、类、方法等的具体位置。索引构建中会返回进度提示，可稍后重试。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        query: { type: "string", description: "符号名关键词，可带字段过滤前缀 kind:/lang:/path:/name:。" },
        limit: { type: "number", description: "返回条数上限（可选，默认 30）。" },
      },
      required: ["project_path", "query"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/search",
  },
  {
    name: "codegraph_node",
    description:
      "查看单个代码符号的详情（文件、行范围）及其直接调用方/被调方。用 id（来自 codegraph_search）精确定位，或用 name（需唯一）。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "符号 id（优先）。" },
        name: { type: "string", description: "符号名（无 id 时用，需唯一，多匹配会返回候选）。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/node",
  },
  {
    name: "codegraph_callers",
    description: "列出调用指定符号的其他符号（直接调用方）。用 id 或唯一 name 定位符号。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "符号 id（优先）。" },
        name: { type: "string", description: "符号名（需唯一）。" },
        limit: { type: "number", description: "返回条数上限（可选）。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/callers",
  },
  {
    name: "codegraph_callees",
    description: "列出指定符号调用的其他符号（被调方）。用 id 或唯一 name 定位符号。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "符号 id（优先）。" },
        name: { type: "string", description: "符号名（需唯一）。" },
        limit: { type: "number", description: "返回条数上限（可选）。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/callees",
  },
  {
    name: "codegraph_impact",
    description:
      "分析修改某符号的影响面：沿依赖边（调用/引用/继承/实现/实例化/类型引用）反向 BFS 若干层，列出受影响的符号集合。改签名/删函数前评估波及范围用。用 id 或唯一 name 定位符号，depth 控制层数（默认 2，上限 5）。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "符号 id（优先）。" },
        name: { type: "string", description: "符号名（需唯一）。" },
        depth: { type: "number", description: "反向遍历层数（默认 2，上限 5）。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/impact",
  },
  {
    name: "codegraph_explore",
    description:
      "综合探索：给定符号（id/name）返回其详情、调用方、被调方与同文件兄弟符号；给定 file 路径则返回该文件内的全部符号概览。适合快速了解某处代码的上下文。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        id: { type: "string", description: "符号 id。" },
        name: { type: "string", description: "符号名（需唯一）。" },
        file: { type: "string", description: "或按文件相对路径探索（返回文件内符号）。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/explore",
  },
  {
    name: "codegraph_files",
    description:
      "列出项目已索引的文件（可按路径子串过滤），或对单文件返回其符号清单（with_symbols=true）。用于了解项目结构与文件内容。",
    inputSchema: {
      type: "object",
      properties: {
        project_path: PROJECT_PATH_PROP,
        path: { type: "string", description: "可选，按路径子串过滤。" },
        with_symbols: { type: "boolean", description: "为 true 时附带每个文件的符号清单。" },
      },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/files",
  },
  {
    name: "codegraph_status",
    description: "查询项目代码索引状态（pending/indexing/ready/failed）与进度（已索引文件/总文件、符号数）。其他 codegraph 工具返回进度提示时，用它判断何时可查。",
    inputSchema: {
      type: "object",
      properties: { project_path: PROJECT_PATH_PROP },
      required: ["project_path"],
      additionalProperties: false,
    },
    endpoint: "/internal/codegraph/status",
  },

  // ── SQL 只读查询（四方言 × query / list_tables / describe_table；不依赖 project_path，不计入检索限流）──
  ...sqlToolDefs(),
];

export const SEARCH_FAMILY_LIMIT = 3;
