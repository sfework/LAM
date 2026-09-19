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
import { createLogger } from "../infra/logger.js";

const log = createLogger("settings");

export interface SettingEntry {
  key: string;
  value: string;
  updatedAt: number;
}

/**
 * 设置服务（DESIGN §2.10）。
 *
 * - 值以字符串存 settings 表；读取时按注册表解析为强类型。
 * - 热更新：内存缓存 + 变更订阅；写库后刷新缓存并通知订阅者，无需重启。
 * - 模型绑定项（modelRef）写入时校验模型存在且分类匹配。
 */
export class SettingsService {
  private cache = new Map<string, string>();
  private listeners = new Map<string, Set<(value: SettingValue) => void>>();
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
    log.info({ count: this.cache.size }, "设置已载入（缺失项回填默认值）");
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

  /** 解析模型绑定项，返回关联模型；未配置或无效返回 undefined。 */
  getResolvedModel(key: string) {
    const def = getSettingDef(key);
    if (!def || def.type !== "modelRef") throw new Error(`${key} 不是模型绑定项`);
    const id = this.getString(key);
    if (!id) return undefined;
    const model = this.models.get(id);
    if (!model) return undefined;
    if (def.modelCategory && model.category !== def.modelCategory) return undefined;
    return model;
  }

  /**
   * 该模型是否被设置项引用（type=modelRef 且当前值等于该 id）。
   * 返回引用它的设置键列表；空数组表示未被使用，可安全编辑/删除。
   */
  modelUsage(modelId: string): string[] {
    if (!modelId) return [];
    const keys: string[] = [];
    for (const def of SETTING_DEFS) {
      if (def.type !== "modelRef") continue;
      const value = this.cache.get(def.key) ?? def.defaultValue;
      if (value && value === modelId) keys.push(def.key);
    }
    return keys;
  }

  /** 写入（校验 + 落库 + 刷新缓存 + 通知订阅）。 */
  set(key: string, value: string): SettingEntry {
    const def = getSettingDef(key);
    if (!def) throw new Error(`未知设置项: ${key}`);

    const err = validateSettingValue(def, value);
    if (err) throw new SettingValidationError(err);

    if (def.type === "modelRef" && value) {
      const model = this.models.get(value);
      if (!model) throw new SettingValidationError(`模型不存在: ${value}`);
      if (def.modelCategory && model.category !== def.modelCategory) {
        throw new SettingValidationError(
          `模型分类不符：${key} 需要 ${def.modelCategory}，实际 ${model.category}`,
        );
      }
    }

    const now = Date.now();
    this.raw
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, value, now);
    this.cache.set(key, value);
    this.emit(key, parseSettingValue(def, value));
    log.info({ key, value }, "设置已热更新");
    return { key, value, updatedAt: now };
  }

  /** 订阅某项变更（热更新回调）。返回取消订阅函数。 */
  subscribe(key: string, cb: (value: SettingValue) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(key: string, value: SettingValue): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(value);
      } catch (err) {
        log.warn({ key, err: String(err) }, "设置订阅回调抛错");
      }
    }
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
