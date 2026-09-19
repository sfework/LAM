/**
 * 设置项注册表（DESIGN §2.10）。
 *
 * 每个参数项声明：类型、默认值、可选校验、用途说明。
 * - 前端后期按本表渲染；
 * - 后端读取时按类型把 settings 表的字符串值解析为强类型；
 * - 模型绑定项（type=modelRef）的值为 models 表中的模型 id，读取时校验存在性与分类。
 */

export type SettingType = "int" | "float" | "bool" | "string" | "modelRef";

export interface SettingDef {
  key: string;
  type: SettingType;
  /** 模型绑定期望的分类（type=modelRef 时必填）。 */
  modelCategory?: "llm" | "embedding";
  defaultValue: string;
  description: string;
  /** 可选范围校验（int/float 生效）。 */
  min?: number;
  max?: number;
}

/** 解析后的强类型值。 */
export type SettingValue = number | boolean | string;

const MODEL_REF = "modelRef" as const;

export const SETTING_DEFS: readonly SettingDef[] = [
  // ── 模型绑定 ──
  { key: "gateway_llm", type: MODEL_REF, modelCategory: "llm", defaultValue: "", description: "网关转发主 LLM（模型 id）" },
  { key: "memory_llm", type: MODEL_REF, modelCategory: "llm", defaultValue: "", description: "记忆维护（L1/L2 提取归纳）用 LLM" },
  { key: "embedding_model", type: MODEL_REF, modelCategory: "embedding", defaultValue: "", description: "向量化模型（维度固定 1024）" },

  // ── 注入预算（按类型独立，超限按 sort_order 取 top）──
  { key: "inject_knowledge_max_items", type: "int", defaultValue: "20", min: 0, max: 500, description: "知识清单注入条数上限" },
  { key: "inject_knowledge_max_chars", type: "int", defaultValue: "2000", min: 0, max: 20000, description: "知识清单注入字符上限" },
  { key: "inject_agents_max_items", type: "int", defaultValue: "20", min: 0, max: 500, description: "Agents 清单条数上限" },
  { key: "inject_agents_max_chars", type: "int", defaultValue: "2000", min: 0, max: 20000, description: "Agents 清单字符上限" },
  { key: "inject_skills_max_items", type: "int", defaultValue: "20", min: 0, max: 500, description: "技能清单条数上限" },
  { key: "inject_skills_max_chars", type: "int", defaultValue: "2000", min: 0, max: 20000, description: "技能清单字符上限" },
  { key: "inject_memory_max_chars", type: "int", defaultValue: "2000", min: 0, max: 20000, description: "L2 项目画像全文注入字符上限" },

  // ── L1 条目与召回 ──
  { key: "l1_max_chars", type: "int", defaultValue: "200", min: 20, max: 2000, description: "单条 L1 字符上限，提取时强制拆分" },
  { key: "l1_recall_enabled", type: "bool", defaultValue: "true", description: "每轮 L1 动态召回开关" },
  { key: "l1_recall_top_k", type: "int", defaultValue: "5", min: 1, max: 50, description: "每轮召回条数上限" },
  { key: "l1_recall_max_chars", type: "int", defaultValue: "1500", min: 0, max: 20000, description: "召回块字符上限" },
  { key: "l1_recall_max_chars_per_item", type: "int", defaultValue: "200", min: 0, max: 2000, description: "单条召回行字符上限，超长截断保留头部（0=不限制）" },
  { key: "recall_timeout_ms", type: "int", defaultValue: "5000", min: 500, max: 30000, description: "召回超时，超时降级空召回不阻塞转发" },
  { key: "l1_recall_similarity_min", type: "float", defaultValue: "0.3", min: 0, max: 1, description: "向量命中的余弦相似度下限（1-distance），低于此丢弃；与文档集大小无关，可靠过滤噪音召回" },

  // ── 提取调度 ──
  { key: "l1_trigger_conversations", type: "int", defaultValue: "5", min: 1, max: 100, description: "触发 L1 提取的累积轮数" },
  { key: "l1_warmup_enabled", type: "bool", defaultValue: "true", description: "warm-up 模式（阈值 1→2→4→8→上限）" },
  { key: "l1_idle_seconds", type: "int", defaultValue: "60", min: 5, max: 3600, description: "会话空闲兜底提取" },
  { key: "extract_max_new_messages", type: "int", defaultValue: "10", min: 1, max: 100, description: "单次提取新消息上限" },
  { key: "extract_max_bg_messages", type: "int", defaultValue: "5", min: 0, max: 50, description: "单次提取背景消息上限" },
  { key: "extract_min_priority", type: "int", defaultValue: "60", min: 0, max: 100, description: "低于此优先级的提取结果丢弃" },
  { key: "conflict_recall_top_k", type: "int", defaultValue: "5", min: 1, max: 50, description: "冲突检测候选召回条数" },
  { key: "extract_max_attempts", type: "int", defaultValue: "3", min: 1, max: 10, description: "提取任务最大重试次数" },
  { key: "l2_delay_seconds", type: "int", defaultValue: "120", min: 0, max: 3600, description: "L1 完成后延迟触发 L2 凝练" },
  { key: "l2_max_interval_hours", type: "int", defaultValue: "24", min: 1, max: 720, description: "L2 画像凝练最大间隔" },
  { key: "l2_max_chars", type: "int", defaultValue: "2000", min: 200, max: 20000, description: "项目画像字符上限" },

  // ── 技能自动抽取（DESIGN 决策 68，默认关，成本可控）──
  { key: "skill_extract_enabled", type: "bool", defaultValue: "false", description: "技能自动抽取总闸（关掉则 L1 后不抽技能）" },
  { key: "skill_extract_min_confidence", type: "int", defaultValue: "70", min: 0, max: 100, description: "低于此置信度的抽取技能丢弃" },
  { key: "skill_extract_max_messages", type: "int", defaultValue: "12", min: 1, max: 100, description: "单次技能抽取读取的最近 L0 消息上限" },
  { key: "skill_extract_max_items", type: "int", defaultValue: "3", min: 1, max: 20, description: "单批技能抽取落库条数上限" },

  // ── 其他 ──
  { key: "extraction_enabled", type: "bool", defaultValue: "true", description: "写侧提取总闸（关掉只停提取不停注入召回）" },
  { key: "memory_extract_max_items", type: "int", defaultValue: "10", min: 1, max: 100, description: "单批 L1 提取条数上限" },
  { key: "memory_similarity_threshold", type: "float", defaultValue: "0.82", min: 0, max: 1, description: "冲突检测候选召回的相关度下限" },
  { key: "codegraph_max_concurrent", type: "int", defaultValue: "2", min: 1, max: 16, description: "CodeGraph 并发索引项目数上限" },
  { key: "codegraph_enabled", type: "bool", defaultValue: "true", description: "CodeGraph 索引总闸（关掉停首建/对话增量/查询返回未启用提示）" },
  { key: "codegraph_reindex_every_conversations", type: "int", defaultValue: "5", min: 0, max: 1000, description: "每累积 N 轮对话增量索引一次（0=关闭对话触发，仅手动重建）" },
  { key: "session_ttl_minutes", type: "int", defaultValue: "120", min: 1, max: 10080, description: "会话快照 TTL，超时同 key 重建" },

  // ── SQL 查询工具（MCP sql_query_*，只读）──
  { key: "sql_query_max_rows", type: "int", defaultValue: "200", min: 1, max: 5000, description: "SQL 工具单次返回行数上限，超出截断并提示（防撑爆模型上下文）" },
];

const DEF_MAP = new Map(SETTING_DEFS.map((d) => [d.key, d]));

export function getSettingDef(key: string): SettingDef | undefined {
  return DEF_MAP.get(key);
}

/** 校验字符串值是否符合定义；返回错误信息或 null。 */
export function validateSettingValue(def: SettingDef, raw: string): string | null {
  switch (def.type) {
    case "int": {
      const n = Number(raw);
      if (!Number.isInteger(n)) return `${def.key} 需为整数`;
      if (def.min !== undefined && n < def.min) return `${def.key} 不能小于 ${def.min}`;
      if (def.max !== undefined && n > def.max) return `${def.key} 不能大于 ${def.max}`;
      return null;
    }
    case "float": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return `${def.key} 需为数字`;
      if (def.min !== undefined && n < def.min) return `${def.key} 不能小于 ${def.min}`;
      if (def.max !== undefined && n > def.max) return `${def.key} 不能大于 ${def.max}`;
      return null;
    }
    case "bool": {
      if (raw !== "true" && raw !== "false") return `${def.key} 需为 true/false`;
      return null;
    }
    case "string":
    case "modelRef":
      return null;
    default:
      return null;
  }
}

/** 按类型把字符串解析为强类型值。 */
export function parseSettingValue(def: SettingDef, raw: string): SettingValue {
  switch (def.type) {
    case "int":
      return Math.trunc(Number(raw));
    case "float":
      return Number(raw);
    case "bool":
      return raw === "true";
    default:
      return raw;
  }
}
