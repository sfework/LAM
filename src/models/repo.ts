import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";

export type ModelCategory = "llm" | "embedding";

export interface ModelRow {
  id: string;
  category: ModelCategory;
  name: string;
  url: string;
  key: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface ModelInput {
  category: ModelCategory;
  name: string;
  url: string;
  key?: string;
  model: string;
}

function rowToModel(r: Record<string, unknown>): ModelRow {
  return {
    id: r.id as string,
    category: r.category as ModelCategory,
    name: r.name as string,
    url: r.url as string,
    key: r.key as string,
    model: r.model as string,
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
      where.push("(lower(name) LIKE ? OR lower(model) LIKE ?)");
      const like = `%${keyword.trim().toLowerCase()}%`;
      args.push(like, like);
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
        "INSERT INTO models (id, category, name, url, key, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, input.category, input.name, input.url, input.key ?? "", input.model, now, now);
    return this.get(id)!;
  }

  update(id: string, input: Partial<ModelInput>): ModelRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...input };
    this.raw
      .prepare(
        "UPDATE models SET category=?, name=?, url=?, key=?, model=?, updated_at=? WHERE id=?",
      )
      .run(merged.category, merged.name, merged.url, merged.key, merged.model, Date.now(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.raw.prepare("DELETE FROM models WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }
}
