import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colJson, colNum, colStr, getRow, getRows, type SqlRow } from "../db/rows.js";

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
  /** 提供商模型清单（/models 拉取结果或手输）。 */
  models?: string[];
  modelMode?: ModelMode;
}

/** 清单归一：去空、trim、保序去重。 */
export function normalizeModels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
}

function mapModel(r: SqlRow): ModelRow {
  return {
    id: colStr(r, "id"),
    category: colStr(r, "category") as ModelCategory,
    name: colStr(r, "name"),
    url: colStr(r, "url"),
    key: colStrOrNullStr(r, "key"),
    model: colStrOrNullStr(r, "model"),
    models: colJson<string[]>(r, "models_json", []).filter(Boolean),
    modelMode: colStr(r, "model_mode") === "manual" ? "manual" : "auto",
    createdAt: colNum(r, "created_at"),
    updatedAt: colNum(r, "updated_at"),
  };
}

/** key/model 列允许 NULL，统一归一为空串。 */
function colStrOrNullStr(r: SqlRow, col: string): string {
  const v = r[col];
  return v === null || v === undefined ? "" : String(v);
}

/** 模型库仓储：LLM / embedding 提供商条目。 */
export class ModelRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 列表：可选分类过滤 + keyword（名称/模型名模糊，大小写不敏感）。
   * 排序：LLM 靠前，同分类内按名称 ASC。
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
    return getRows(this.db, `SELECT * FROM models${whereSql}${orderSql}`, ...args).map(mapModel);
  }

  get(id: string): ModelRow | undefined {
    const r = getRow(this.db, "SELECT * FROM models WHERE id = ?", id);
    return r ? mapModel(r) : undefined;
  }

  create(input: ModelInput): ModelRow {
    const now = Date.now();
    const id = newId("mdl");
    this.db
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
    this.db
      .prepare(
        "UPDATE models SET category=?, name=?, url=?, key=?, model=?, models_json=?, model_mode=?, updated_at=? WHERE id=?",
      )
      .run(merged.category, merged.name, merged.url, merged.key, merged.model?.trim() ?? "", JSON.stringify(normalizeModels(merged.models)), merged.modelMode === "manual" ? "manual" : "auto", Date.now(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM models WHERE id = ?").run(id).changes > 0;
  }
}
