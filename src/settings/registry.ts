/**
 * 设置项注册表。
 *
 * 每个参数项声明：类型、默认值、可选校验、用途说明。
 * - 前端按本表渲染；
 * - 后端读取时按类型把 settings 表的字符串值解析为强类型；
 * - 模型绑定项（type=modelRef）的值为 models 表中的模型 id，读取时校验存在性与分类。
 *
 * 术语（新功能 4）：对话 / 记忆 / 画像。
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
  { key: "memory_llm", type: MODEL_REF, modelCategory: "llm", defaultValue: "", description: "记忆维护（提取/凝练）用 LLM" },
  { key: "embedding_model", type: MODEL_REF, modelCategory: "embedding", defaultValue: "", description: "向量化模型（维度固定 1024）" },

  // ── 记忆条目与召回 ──
  { key: "memory_recall_top_k", type: "int", defaultValue: "5", min: 1, max: 50, description: "每轮召回注入条数上限（按生成时间倒序取最近 N 条）" },
  { key: "memory_similarity_min", type: "float", defaultValue: "0.3", min: 0, max: 1, description: "向量命中的余弦相似度下限（1-distance），低于此丢弃" },

  // ── 提取调度 ──
  { key: "memory_trigger_user_messages", type: "int", defaultValue: "3", min: 1, max: 100, description: "触发记忆提取的累积 user 消息条数（唯一触发路径）" },
  { key: "extract_min_priority", type: "int", defaultValue: "60", min: 0, max: 100, description: "低于此优先级的提取结果丢弃" },
  { key: "conflict_recall_top_k", type: "int", defaultValue: "5", min: 1, max: 50, description: "冲突检测候选召回条数" },
  { key: "profile_delay_seconds", type: "int", defaultValue: "120", min: 0, max: 3600, description: "记忆完成后延迟触发画像凝练" },
  { key: "profile_gate_enabled", type: "bool", defaultValue: "true", description: "画像凝练前用 memory_llm 做一次变更分类门控（reinforcement/none 跳过整次重写，省 LLM 成本）" },
  { key: "profile_gate_max_skip_streak", type: "int", defaultValue: "5", min: 1, max: 50, description: "门控连续跳过兜底：达此次数强制凝练一次（防分类误判累积导致画像滞后）" },
  { key: "profile_max_chars", type: "int", defaultValue: "2000", min: 100, max: 20000, description: "画像凝练提示词中的字数上限（仅约束模型输出，落库与注入不截断）" },

  // ── 其他 ──
  { key: "session_ttl_minutes", type: "int", defaultValue: "120", min: 1, max: 10080, description: "会话快照 TTL，超时同 key 重建" },
  { key: "gateway_forward_timeout_minutes", type: "int", defaultValue: "60", min: 0, max: 1440, description: "网关上游等待超时（分钟，响应头与流式块间静默共用），0=不限。推理模型深度思考需宽超时" },
  { key: "gateway_stream_idle_warn_seconds", type: "int", defaultValue: "60", min: 0, max: 3600, description: "流式转发上游静默告警阈值（秒），0=不告警；仅记日志不断流" },

  // ── SQL 查询工具（MCP sql_query，只读）──
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
