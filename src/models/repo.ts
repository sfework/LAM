import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";

export type ModelCategory = "llm" | "embedding";
/** 模型录入模式：auto=自动获取（清单为 /models 全量）；manual=手工输入（清单仅一个手输模型）。 */
export type ModelMode = "auto" | "manual";

export interface ModelRow {
  id: string;
  category: ModelCategory;
  name: string;
  url: string;
  key: string;
  model: string;
  /** 提供商可用模型清单（models_json 解析；空数组=未配置）。 */
  models: string[];
  /** 模型录入模式（决定弹窗页签与保存语义）。 */
  modelMode: ModelMode;
  createdAt: number;
  updatedAt: number;
}

export interface ModelInput {
  category: ModelCategory;
  name: string;
  url: string;
  key?: string;
  /** 默认模型（清单首项）；留空表示提供商尚未配置模型。 */
  model?: string;
  /** 提供商模型清单（/models 拉取结果或手输，不支持 /models 时通常只有手输的一个）。 */
  models?: string[];
  /** 录入模式（缺省 auto）。 */
  modelMode?: ModelMode;
}

/** models_json 解析（非法/旧行回退空数组）。 */
function parseModelsJson(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 清单归一：去空、trim、保序去重。 */
export function normalizeModels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

function rowToModel(r: Record<string, unknown>): ModelRow {
  return {
    id: r.id as string,
    category: r.category as ModelCategory,
    name: r.name as string,
    url: r.url as string,
    key: r.key as string,
    model: r.model as string,
    models: parseModelsJson(r.models_json),
    modelMode: (r.model_mode === "manual" ? "manual" : "auto") as ModelMode,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

/** 模型库仓储（DESIGN §2.9）。 */
export class ModelRepo {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  /**
   * 列表：可选分类过滤 + keyword（名称/模型名模糊，大小写不敏感）。
   * 排序：LLM 靠前（category='llm' → 0，其余 → 1），同分类内按名称 ASC（不区分大小写）。
   */
  list(category?: ModelCategory, keyword?: string): ModelRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (category) {
      where.push("category = ?");
      args.push(category);
    }
    if (keyword?.trim()) {
      where.push("(lower(name) LIKE ? OR lower(model) LIKE ? OR lower(models_json) LIKE ?)");
      const like = `%${keyword.trim().toLowerCase()}%`;
      args.push(like, like, like);
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const orderSql = " ORDER BY CASE category WHEN 'llm' THEN 0 ELSE 1 END, name COLLATE NOCASE ASC";
    const rows = this.raw.prepare(`SELECT * FROM models${whereSql}${orderSql}`).all(...args) as Record<string, unknown>[];
    return rows.map(rowToModel);
  }

  get(id: string): ModelRow | undefined {
    const r = this.raw.prepare("SELECT * FROM models WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToModel(r) : undefined;
  }

  create(input: ModelInput): ModelRow {
    const now = Date.now();
    const id = newId("mdl");
    this.raw
      .prepare(
        "INSERT INTO models (id, category, name, url, key, model, models_json, model_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, input.category, input.name, input.url, input.key ?? "", input.model?.trim() ?? "", JSON.stringify(normalizeModels(input.models)), input.modelMode === "manual" ? "manual" : "auto", now, now);
    return this.get(id)!;
  }

  update(id: string, input: Partial<ModelInput>): ModelRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...input };
    this.raw
      .prepare(
        "UPDATE models SET category=?, name=?, url=?, key=?, model=?, models_json=?, model_mode=?, updated_at=? WHERE id=?",
      )
      .run(merged.category, merged.name, merged.url, merged.key, merged.model?.trim() ?? "", JSON.stringify(normalizeModels(merged.models)), merged.modelMode === "manual" ? "manual" : "auto", Date.now(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.raw.prepare("DELETE FROM models WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }
}
