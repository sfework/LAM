import type { DatabaseSync } from "node:sqlite";
import {
  SETTING_DEFS,
  getSettingDef,
  parseSettingValue,
  validateSettingValue,
  type SettingDef,
  type SettingValue,
} from "./registry.js";
import type { ModelRepo } from "../models/repo.js";
import type { LlmCallConfig } from "../llm/client.js";

/**
 * 解析 modelRef 绑定值：`mdl_xxx` 或 `mdl_xxx:model-name`。
 * id 生成规则不含冒号，首个冒号后整段视为模型名（名内可含冒号则取首个分段——
 * OpenAI 模型名无冒号，此约定足够）。空值返回 { modelId: "" }。
 */
export function parseModelBinding(value: string): { modelId: string; modelName: string } {
  const v = (value ?? "").trim();
  if (!v) return { modelId: "", modelName: "" };
  const i = v.indexOf(":");
  if (i < 0) return { modelId: v, modelName: "" };
  return { modelId: v.slice(0, i), modelName: v.slice(i + 1).trim() };
}

export interface SettingEntry {
  key: string;
  value: string;
  updatedAt: number;
}

/**
 * 设置服务（DESIGN §2.10）。
 *
 * - 值以字符串存 settings 表；读取时按注册表解析为强类型。
 * - 热更新：内存缓存，写库后刷新缓存，下次读取即最新值，无需重启。
 * - 模型绑定项（modelRef）写入时校验模型存在且分类匹配。
 */
export class SettingsService {
  private cache = new Map<string, string>();
  private readonly raw: DatabaseSync;
  private readonly models: ModelRepo;

  constructor(raw: DatabaseSync, models: ModelRepo) {
    this.raw = raw;
    this.models = models;
  }

  /** 启动时载入全部设置，缺失的注册表项回填默认值。 */
  init(): void {
    const rows = this.raw.prepare("SELECT key, value, updated_at FROM settings").all() as unknown as SettingEntry[];
    for (const r of rows) this.cache.set(r.key, r.value);

    const upsert = this.raw.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
    );
    for (const def of SETTING_DEFS) {
      if (!this.cache.has(def.key)) {
        upsert.run(def.key, def.defaultValue, Date.now());
        this.cache.set(def.key, def.defaultValue);
      }
    }
  }

  /** 读取强类型值（热更新：每次读缓存，缓存随写入实时更新）。 */
  get<T extends SettingValue = SettingValue>(key: string): T {
    const def = getSettingDef(key);
    if (!def) throw new Error(`未知设置项: ${key}`);
    const raw = this.cache.get(key) ?? def.defaultValue;
    return parseSettingValue(def, raw) as T;
  }

  getString(key: string): string {
    return this.get<string>(key);
  }
  getInt(key: string): number {
    return this.get<number>(key);
  }
  getBool(key: string): boolean {
    return this.get<boolean>(key);
  }
  getFloat(key: string): number {
    return this.get<number>(key);
  }

  /**
   * 解析模型绑定项，返回关联模型条目（提供商）；未配置或无效返回 undefined。
   * 绑定值格式：`mdl_xxx` 或 `mdl_xxx:model-name`（冒号后为覆盖的模型名，
   * 用于 model 留空的纯提供商条目；旧格式纯 id 完全兼容）。
   */
  getResolvedModel(key: string) {
    const def = getSettingDef(key);
    if (!def || def.type !== "modelRef") throw new Error(`${key} 不是模型绑定项`);
    const binding = parseModelBinding(this.getString(key));
    if (!binding.modelId) return undefined;
    const model = this.models.get(binding.modelId);
    if (!model) return undefined;
    if (def.modelCategory && model.category !== def.modelCategory) return undefined;
    return model;
  }

  /**
   * 解析模型绑定项并组装为调用配置（baseUrl/apiKey/model）。
   * 收口各管线（recall/backfill/scheduler/管理端）中重复的 getResolvedModel + 三字段组装；
   * 模型名优先取绑定值覆盖名，回退条目自身 model；两者皆空视为无效。
   * 未配置或无效返回 null（调用方据此降级）。
   */
  getResolvedLlmConfig(key: string): LlmCallConfig | null {
    const def = getSettingDef(key);
    if (!def || def.type !== "modelRef") throw new Error(`${key} 不是模型绑定项`);
    const binding = parseModelBinding(this.getString(key));
    if (!binding.modelId) return null;
    const m = this.getResolvedModel(key);
    if (!m) return null;
    const model = binding.modelName || m.model;
    if (!model) return null;
    return { baseUrl: m.url, apiKey: m.key, model };
  }

  /**
   * 该模型是否被设置项引用（type=modelRef 且绑定值的 id 部分等于该 id）。
   * 返回引用它的设置键列表；空数组表示未被使用，可安全编辑/删除。
   */
  modelUsage(modelId: string): string[] {
    return this.modelBindingDetails(modelId).map((d) => d.key);
  }

  /** 引用某模型的绑定明细（键 + 覆盖模型名），供清空条目 model 前的可用性守卫。 */
  modelBindingDetails(modelId: string): { key: string; modelName: string }[] {
    if (!modelId) return [];
    const out: { key: string; modelName: string }[] = [];
    for (const def of SETTING_DEFS) {
      if (def.type !== "modelRef") continue;
      const value = this.cache.get(def.key) ?? def.defaultValue;
      if (!value) continue;
      const b = parseModelBinding(value);
      if (b.modelId === modelId) out.push({ key: def.key, modelName: b.modelName });
    }
    return out;
  }

  /** 写入（校验 + 落库 + 刷新缓存 + 通知订阅）。 */
  set(key: string, value: string): SettingEntry {
    const def = getSettingDef(key);
    if (!def) throw new Error(`未知设置项: ${key}`);

    const err = validateSettingValue(def, value);
    if (err) throw new SettingValidationError(err);

    if (def.type === "modelRef" && value) {
      const binding = parseModelBinding(value);
      const model = this.models.get(binding.modelId);
      if (!model) throw new SettingValidationError(`模型不存在: ${binding.modelId}`);
      if (def.modelCategory && model.category !== def.modelCategory) {
        throw new SettingValidationError(
          `模型分类不符：${key} 需要 ${def.modelCategory}，实际 ${model.category}`,
        );
      }
      // model 留空的提供商条目必须靠绑定值覆盖模型名，否则调用时无模型可用。
      if (!binding.modelName && !model.model) {
        throw new SettingValidationError(`该模型条目未指定模型名，绑定时需选择/填写具体模型`);
      }
    }

    const now = Date.now();
    this.raw
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, value, now);
    this.cache.set(key, value);
    return { key, value, updatedAt: now };
  }

  /** 列出全部设置（含元数据），供前端渲染。 */
  listAll(): Array<SettingDef & { value: string; effective: SettingValue }> {
    return SETTING_DEFS.map((def) => {
      const value = this.cache.get(def.key) ?? def.defaultValue;
      return { ...def, value, effective: parseSettingValue(def, value) };
    });
  }
}

export class SettingValidationError extends Error {}
