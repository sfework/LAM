import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colBool, colNum, colNumOrNull, colStr, colStrOrNull, getRow, getRows, type SqlRow } from "../db/rows.js";

/**
 * 资产仓储：prompts / agents / knowledges。
 * 三类同构：enabled 开关 + sort_order（清单取生效项按序）；提示词互斥（最多 1 条生效）。
 * 知识库额外有 scope(global|project)。
 */

export interface PromptRow {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  updatedAt: number;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  /** 系统级资产：不可删除（Admin/MCP 均拒绝），仅可修改。 */
  system: boolean;
  updatedAt: number;
}

export interface KnowledgeRow {
  id: string;
  title: string;
  description: string;
  body: string;
  scope: "global" | "project";
  projectId: string | null;
  enabled: boolean;
  sortOrder: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** 清单注入条目（id + 标题 + 描述，不含正文——正文按 id 经 MCP 读取工具定位）。 */
export interface AssetListItem {
  id: string;
  title: string;
  description: string;
}

function mapPrompt(r: SqlRow): PromptRow {
  return { id: colStr(r, "id"), name: colStr(r, "name"), content: colStr(r, "content"), enabled: colBool(r, "enabled"), updatedAt: colNum(r, "updated_at") };
}
function mapAgent(r: SqlRow): AgentRow {
  return { id: colStr(r, "id"), name: colStr(r, "name"), description: colStrOrNull(r, "description") ?? "", body: colStr(r, "body"), enabled: colBool(r, "enabled"), sortOrder: colNum(r, "sort_order"), system: colBool(r, "system"), updatedAt: colNum(r, "updated_at") };
}
function mapKnowledge(r: SqlRow): KnowledgeRow {
  return { id: colStr(r, "id"), title: colStr(r, "title"), description: colStrOrNull(r, "description") ?? "", body: colStr(r, "body"), scope: colStr(r, "scope") as KnowledgeRow["scope"], projectId: colStrOrNull(r, "project_id"), enabled: colBool(r, "enabled"), sortOrder: colNum(r, "sort_order"), updatedAt: colNum(r, "updated_at"), deletedAt: colNumOrNull(r, "deleted_at") };
}

export class AssetsRepo {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ── prompts ──
  listPrompts(): PromptRow[] {
    return getRows(this.db, "SELECT * FROM prompts ORDER BY name COLLATE NOCASE ASC").map(mapPrompt);
  }
  getPrompt(id: string): PromptRow | undefined {
    const r = getRow(this.db, "SELECT * FROM prompts WHERE id = ?", id);
    return r ? mapPrompt(r) : undefined;
  }
  /** 当前生效提示词（互斥保证最多 1 条）。 */
  getActivePrompt(): PromptRow | undefined {
    const r = getRow(this.db, "SELECT * FROM prompts WHERE enabled = 1 LIMIT 1");
    return r ? mapPrompt(r) : undefined;
  }
  createPrompt(input: { name: string; content: string; enabled?: boolean }): PromptRow {
    const id = newId("prm");
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      if (input.enabled) this.db.prepare("UPDATE prompts SET enabled = 0").run();
      this.db.prepare("INSERT INTO prompts (id, name, content, enabled, updated_at) VALUES (?,?,?,?,?)")
        .run(id, input.name, input.content, input.enabled ? 1 : 0, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getPrompt(id)!;
  }
  updatePrompt(id: string, input: { name?: string; content?: string; enabled?: boolean }): PromptRow | undefined {
    const existing = this.getPrompt(id);
    if (!existing) return undefined;
    const merged = {
      name: input.name ?? existing.name,
      content: input.content ?? existing.content,
      enabled: input.enabled ?? existing.enabled,
    };
    this.db.exec("BEGIN");
    try {
      if (merged.enabled && !existing.enabled) this.db.prepare("UPDATE prompts SET enabled = 0").run();
      this.db.prepare("UPDATE prompts SET name=?, content=?, enabled=?, updated_at=? WHERE id=?")
        .run(merged.name, merged.content, merged.enabled ? 1 : 0, Date.now(), id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getPrompt(id);
  }
  deletePrompt(id: string): boolean {
    return this.db.prepare("DELETE FROM prompts WHERE id = ?").run(id).changes > 0;
  }

  // ── agents ──
  listAgents(): AgentRow[] {
    return getRows(this.db, "SELECT * FROM agents ORDER BY sort_order ASC, rowid ASC").map(mapAgent);
  }
  getAgent(id: string): AgentRow | undefined {
    const r = getRow(this.db, "SELECT * FROM agents WHERE id = ?", id);
    return r ? mapAgent(r) : undefined;
  }
  createAgent(input: { name: string; description?: string; body?: string; enabled?: boolean; sortOrder?: number }): AgentRow {
    const id = newId("agt");
    this.db.prepare("INSERT INTO agents (id, name, description, body, enabled, sort_order, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.name, input.description ?? "", input.body ?? "", input.enabled ? 1 : 0, input.sortOrder ?? 0, Date.now());
    return this.getAgent(id)!;
  }
  updateAgent(id: string, input: Partial<{ name: string; description: string; body: string; enabled: boolean; sortOrder: number }>): AgentRow | undefined {
    const e = this.getAgent(id);
    if (!e) return undefined;
    const m = { name: input.name ?? e.name, description: input.description ?? e.description, body: input.body ?? e.body, enabled: input.enabled ?? e.enabled, sortOrder: input.sortOrder ?? e.sortOrder };
    this.db.prepare("UPDATE agents SET name=?, description=?, body=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
      .run(m.name, m.description, m.body, m.enabled ? 1 : 0, m.sortOrder, Date.now(), id);
    return this.getAgent(id);
  }
  deleteAgent(id: string): boolean {
    // 系统级 Agent 不可删除（仅可修改）；调用方应先判 system 标志，这里兜底拒绝。
    const e = this.getAgent(id);
    if (e?.system) throw new Error(`系统级 Agent 不可删除：${e.name}`);
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
  }

  // ── knowledge ──
  // 加载口径：project scope 知识仅当其所属项目未软删才加载（JOIN projects）；
  // global 知识恒可加载。项目恢复后 JOIN 自然命中。
  listKnowledge(): KnowledgeRow[] {
    return getRows(
      this.db,
      `SELECT k.* FROM knowledges k LEFT JOIN projects p ON p.id = k.project_id
       WHERE k.deleted_at IS NULL AND (k.scope = 'global' OR p.deleted_at IS NULL)
       ORDER BY k.sort_order ASC, k.rowid ASC`,
    ).map(mapKnowledge);
  }
  getKnowledge(id: string): KnowledgeRow | undefined {
    const r = getRow(
      this.db,
      `SELECT k.* FROM knowledges k LEFT JOIN projects p ON p.id = k.project_id
       WHERE k.id = ? AND k.deleted_at IS NULL AND (k.scope = 'global' OR p.deleted_at IS NULL)`,
      id,
    );
    return r ? mapKnowledge(r) : undefined;
  }
  createKnowledge(input: { title: string; description?: string; body?: string; scope?: "global" | "project"; projectId?: string | null; enabled?: boolean; sortOrder?: number }): KnowledgeRow {
    const id = newId("kno");
    this.db.prepare("INSERT INTO knowledges (id, title, description, body, scope, project_id, enabled, sort_order, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)")
      .run(id, input.title, input.description ?? "", input.body ?? "", input.scope ?? "global", input.projectId ?? null, input.enabled ? 1 : 0, input.sortOrder ?? 0, Date.now());
    return this.getKnowledge(id)!;
  }
  updateKnowledge(id: string, input: Partial<{ title: string; description: string; body: string; scope: "global" | "project"; projectId: string | null; enabled: boolean; sortOrder: number }>): KnowledgeRow | undefined {
    const e = this.getKnowledge(id);
    if (!e) return undefined;
    const m = { title: input.title ?? e.title, description: input.description ?? e.description, body: input.body ?? e.body, scope: input.scope ?? e.scope, projectId: input.projectId !== undefined ? input.projectId : e.projectId, enabled: input.enabled ?? e.enabled, sortOrder: input.sortOrder ?? e.sortOrder };
    this.db.prepare("UPDATE knowledges SET title=?, description=?, body=?, scope=?, project_id=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
      .run(m.title, m.description, m.body, m.scope, m.projectId, m.enabled ? 1 : 0, m.sortOrder, Date.now(), id);
    return this.getKnowledge(id);
  }
  deleteKnowledge(id: string): boolean {
    return this.db.prepare("DELETE FROM knowledges WHERE id = ?").run(id).changes > 0;
  }

  // ── 注入读取侧（清单：id + 标题 + 描述，生效且按 sort_order）──
  /** 生效清单（按 sort_order 升序），供快照生成器取 top。正文按 id 经 MCP 工具读取。 */
  enabledAssetLists(projectId: string | null): { knowledge: AssetListItem[]; agents: AssetListItem[] } {
    const knowledge = getRows(
      this.db,
      `SELECT k.id, k.title, k.description FROM knowledges k
       LEFT JOIN projects p ON p.id = k.project_id
       WHERE k.enabled = 1 AND k.deleted_at IS NULL
         AND (k.scope = 'global' OR (k.scope = 'project' AND p.deleted_at IS NULL AND (? IS NOT NULL AND k.project_id = ?)))
       ORDER BY k.sort_order ASC, k.rowid ASC`,
      projectId, projectId,
    ).map((r) => ({ id: colStr(r, "id"), title: colStr(r, "title"), description: colStrOrNull(r, "description") ?? "" }));
    const agents = getRows(
      this.db,
      "SELECT id, name, description FROM agents WHERE enabled = 1 ORDER BY sort_order ASC, rowid ASC",
    ).map((r) => ({ id: colStr(r, "id"), title: colStr(r, "name"), description: colStrOrNull(r, "description") ?? "" }));
    return { knowledge, agents };
  }
}
