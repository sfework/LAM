import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";

/**
 * 资产仓储（DESIGN §2.4 / §2.5）：prompts / agents / skills / knowledge。
 * 四类同构：enabled 开关 + sort_order（清单取 top）；提示词互斥（最多 1 条生效）。
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
  updatedAt: number;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  version: number;
  status: "active" | "superseded";
  source: "manual" | "auto";
  supersededBy: string | null;
  projectId: string | null;
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

function toPrompt(r: Record<string, unknown>): PromptRow {
  return { id: r.id as string, name: r.name as string, content: r.content as string, enabled: Boolean(r.enabled), updatedAt: r.updated_at as number };
}
function toAgent(r: Record<string, unknown>): AgentRow {
  return { id: r.id as string, name: r.name as string, description: r.description as string, body: r.body as string, enabled: Boolean(r.enabled), sortOrder: r.sort_order as number, updatedAt: r.updated_at as number };
}
function toSkill(r: Record<string, unknown>): SkillRow {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    body: r.body as string,
    enabled: Boolean(r.enabled),
    sortOrder: r.sort_order as number,
    version: r.version as number,
    status: r.status as SkillRow["status"],
    source: r.source as SkillRow["source"],
    supersededBy: (r.superseded_by as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    updatedAt: r.updated_at as number,
  };
}
function toKnowledge(r: Record<string, unknown>): KnowledgeRow {
  return { id: r.id as string, title: r.title as string, description: r.description as string, body: r.body as string, scope: r.scope as KnowledgeRow["scope"], projectId: (r.project_id as string | null) ?? null, enabled: Boolean(r.enabled), sortOrder: r.sort_order as number, updatedAt: r.updated_at as number, deletedAt: (r.deleted_at as number | null) ?? null };
}

/** 清单截断：按 maxItems 条数 + maxChars 累计字符（超限即止）。 */
export function clipList(items: AssetListItem[], maxItems: number, maxChars: number): AssetListItem[] {
  const out: AssetListItem[] = [];
  let used = 0;
  for (const it of items) {
    if (out.length >= maxItems) break;
    const cost = it.id.length + it.title.length + it.description.length + 6; // "- " + 两个"：" + 换行
    if (out.length > 0 && used + cost > maxChars) break;
    out.push(it);
    used += cost;
  }
  return out;
}

export class AssetsRepo {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  // ── prompts ──
  listPrompts(): PromptRow[] {
    return (this.raw.prepare("SELECT * FROM prompts ORDER BY name COLLATE NOCASE ASC").all() as Record<string, unknown>[]).map(toPrompt);
  }
  getPrompt(id: string): PromptRow | undefined {
    const r = this.raw.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toPrompt(r) : undefined;
  }
  /** 当前生效提示词（互斥保证最多 1 条）。 */
  getActivePrompt(): PromptRow | undefined {
    const r = this.raw.prepare("SELECT * FROM prompts WHERE enabled = 1 LIMIT 1").get() as Record<string, unknown> | undefined;
    return r ? toPrompt(r) : undefined;
  }
  createPrompt(input: { name: string; content: string; enabled?: boolean }): PromptRow {
    const id = newId("prm");
    const now = Date.now();
    this.raw.exec("BEGIN");
    try {
      if (input.enabled) this.raw.prepare("UPDATE prompts SET enabled = 0").run();
      this.raw.prepare("INSERT INTO prompts (id, name, content, enabled, updated_at) VALUES (?,?,?,?,?)")
        .run(id, input.name, input.content, input.enabled ? 1 : 0, now);
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
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
    this.raw.exec("BEGIN");
    try {
      if (merged.enabled && !existing.enabled) this.raw.prepare("UPDATE prompts SET enabled = 0").run();
      this.raw.prepare("UPDATE prompts SET name=?, content=?, enabled=?, updated_at=? WHERE id=?")
        .run(merged.name, merged.content, merged.enabled ? 1 : 0, Date.now(), id);
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
    return this.getPrompt(id);
  }
  deletePrompt(id: string): boolean {
    return Number(this.raw.prepare("DELETE FROM prompts WHERE id = ?").run(id).changes) > 0;
  }

  // ── agents ──
  listAgents(): AgentRow[] {
    return (this.raw.prepare("SELECT * FROM agents ORDER BY sort_order ASC, rowid ASC").all() as Record<string, unknown>[]).map(toAgent);
  }
  getAgent(id: string): AgentRow | undefined {
    const r = this.raw.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toAgent(r) : undefined;
  }
  createAgent(input: { name: string; description?: string; body?: string; enabled?: boolean; sortOrder?: number }): AgentRow {
    const id = newId("agt");
    this.raw.prepare("INSERT INTO agents (id, name, description, body, enabled, sort_order, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.name, input.description ?? "", input.body ?? "", input.enabled ? 1 : 0, input.sortOrder ?? 0, Date.now());
    return this.getAgent(id)!;
  }
  updateAgent(id: string, input: Partial<{ name: string; description: string; body: string; enabled: boolean; sortOrder: number }>): AgentRow | undefined {
    const e = this.getAgent(id);
    if (!e) return undefined;
    const m = { name: input.name ?? e.name, description: input.description ?? e.description, body: input.body ?? e.body, enabled: input.enabled ?? e.enabled, sortOrder: input.sortOrder ?? e.sortOrder };
    this.raw.prepare("UPDATE agents SET name=?, description=?, body=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
      .run(m.name, m.description, m.body, m.enabled ? 1 : 0, m.sortOrder, Date.now(), id);
    return this.getAgent(id);
  }
  deleteAgent(id: string): boolean {
    return Number(this.raw.prepare("DELETE FROM agents WHERE id = ?").run(id).changes) > 0;
  }

  // ── skills ──
  /** 列表：默认仅 active（含全局与各项目）；superseded 历史版经 listSkillVersions 查看。 */
  listSkills(): SkillRow[] {
    return (this.raw
      .prepare("SELECT * FROM skills WHERE status = 'active' ORDER BY sort_order ASC, rowid ASC")
      .all() as Record<string, unknown>[]).map(toSkill);
  }
  getSkill(id: string): SkillRow | undefined {
    const r = this.raw.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toSkill(r) : undefined;
  }
  /** 版本链：给定某版 id，回溯其 active 版并返回全部版本（version 升序）。 */
  listSkillVersions(id: string): SkillRow[] {
    const cur = this.getSkill(id);
    if (!cur) return [];
    // 沿 superseded_by 上溯到链尾的 active 版（头）
    let head = cur;
    const seen = new Set<string>([cur.id]);
    while (head.status === "superseded" && head.supersededBy && !seen.has(head.supersededBy)) {
      const next = this.getSkill(head.supersededBy);
      if (!next) break;
      seen.add(next.id);
      head = next;
    }
    // 从头顶反向收集整条链：每行 superseded_by 指向其后继（更新版），故按 superseded_by = 当前 id 找前驱（旧版）
    const chain: SkillRow[] = [head];
    const collected = new Set<string>([head.id]);
    let node = head;
    for (;;) {
      const r = this.raw.prepare("SELECT * FROM skills WHERE superseded_by = ? LIMIT 1").get(node.id) as
        | Record<string, unknown>
        | undefined;
      if (!r) break;
      const prev = toSkill(r);
      if (collected.has(prev.id)) break;
      collected.add(prev.id);
      chain.push(prev);
      node = prev;
    }
    return chain.sort((a, b) => a.version - b.version);
  }
  createSkill(input: {
    name: string;
    description?: string;
    body?: string;
    enabled?: boolean;
    sortOrder?: number;
    source?: "manual" | "auto";
    projectId?: string | null;
  }): SkillRow {
    const id = newId("skl");
    this.raw
      .prepare(
        "INSERT INTO skills (id, name, description, body, enabled, sort_order, version, status, source, superseded_by, project_id, updated_at) VALUES (?,?,?,?,?,?,1,'active',?,NULL,?,?)",
      )
      .run(
        id,
        input.name,
        input.description ?? "",
        input.body ?? "",
        input.enabled ? 1 : 0,
        input.sortOrder ?? 0,
        input.source ?? "manual",
        input.projectId ?? null,
        Date.now(),
      );
    return this.getSkill(id)!;
  }
  /**
   * 编辑技能：正文/名称/描述任一实质变化 → 生成新版本（旧行置 superseded 指向新行，
   * 新行 version+1、继承 enabled/sortOrder/source/projectId）；仅无实质变化时原地更新元数据。
   * 返回 { row, versioned }。
   */
  updateSkill(
    id: string,
    input: Partial<{ name: string; description: string; body: string; enabled: boolean; sortOrder: number; projectId: string | null }>,
  ): { row: SkillRow; versioned: boolean } | undefined {
    const e = this.getSkill(id);
    if (!e) return undefined;
    const m = {
      name: input.name ?? e.name,
      description: input.description ?? e.description,
      body: input.body ?? e.body,
      enabled: input.enabled ?? e.enabled,
      sortOrder: input.sortOrder ?? e.sortOrder,
      projectId: input.projectId !== undefined ? input.projectId : e.projectId,
    };
    const contentChanged = m.name !== e.name || m.description !== e.description || m.body !== e.body;
    const now = Date.now();

    // 仅元数据（enabled/sortOrder/projectId）变化：原地更新，不产生新版本
    if (!contentChanged) {
      this.raw
        .prepare("UPDATE skills SET enabled = ?, sort_order = ?, project_id = ?, updated_at = ? WHERE id = ?")
        .run(m.enabled ? 1 : 0, m.sortOrder, m.projectId, now, id);
      return { row: this.getSkill(id)!, versioned: false };
    }

    // 内容变化：插入新版本行，旧 active 行置 superseded 指向它
    const newId2 = newId("skl");
    this.raw
      .prepare(
        "INSERT INTO skills (id, name, description, body, enabled, sort_order, version, status, source, superseded_by, project_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        newId2,
        m.name,
        m.description,
        m.body,
        m.enabled ? 1 : 0,
        m.sortOrder,
        e.version + 1,
        "active",
        e.source,
        null,
        m.projectId,
        now,
      );
    this.raw
      .prepare("UPDATE skills SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(newId2, now, id);
    return { row: this.getSkill(newId2)!, versioned: true };
  }
  deleteSkill(id: string): boolean {
    return Number(this.raw.prepare("DELETE FROM skills WHERE id = ?").run(id).changes) > 0;
  }

  // ── knowledge ──
  // 加载口径（DESIGN 决策 56）：project scope 知识仅当其所属项目未软删才加载（JOIN projects）；
  // global 知识恒可加载。项目恢复后 JOIN 自然命中，无需额外处理。
  listKnowledge(): KnowledgeRow[] {
    return (this.raw
      .prepare(
        `SELECT k.* FROM knowledge k LEFT JOIN projects p ON p.id = k.project_id
         WHERE k.deleted_at IS NULL AND (k.scope = 'global' OR p.deleted_at IS NULL)
         ORDER BY k.sort_order ASC, k.rowid ASC`,
      )
      .all() as Record<string, unknown>[]).map(toKnowledge);
  }
  getKnowledge(id: string): KnowledgeRow | undefined {
    const r = this.raw
      .prepare(
        `SELECT k.* FROM knowledge k LEFT JOIN projects p ON p.id = k.project_id
         WHERE k.id = ? AND k.deleted_at IS NULL AND (k.scope = 'global' OR p.deleted_at IS NULL)`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return r ? toKnowledge(r) : undefined;
  }
  createKnowledge(input: { title: string; description?: string; body?: string; scope?: "global" | "project"; projectId?: string | null; enabled?: boolean; sortOrder?: number }): KnowledgeRow {
    const id = newId("kno");
    this.raw.prepare("INSERT INTO knowledge (id, title, description, body, scope, project_id, enabled, sort_order, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)")
      .run(id, input.title, input.description ?? "", input.body ?? "", input.scope ?? "global", input.projectId ?? null, input.enabled ? 1 : 0, input.sortOrder ?? 0, Date.now());
    return this.getKnowledge(id)!;
  }
  updateKnowledge(id: string, input: Partial<{ title: string; description: string; body: string; scope: "global" | "project"; projectId: string | null; enabled: boolean; sortOrder: number }>): KnowledgeRow | undefined {
    const e = this.getKnowledge(id);
    if (!e) return undefined;
    const m = { title: input.title ?? e.title, description: input.description ?? e.description, body: input.body ?? e.body, scope: input.scope ?? e.scope, projectId: input.projectId !== undefined ? input.projectId : e.projectId, enabled: input.enabled ?? e.enabled, sortOrder: input.sortOrder ?? e.sortOrder };
    this.raw.prepare("UPDATE knowledge SET title=?, description=?, body=?, scope=?, project_id=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
      .run(m.title, m.description, m.body, m.scope, m.projectId, m.enabled ? 1 : 0, m.sortOrder, Date.now(), id);
    return this.getKnowledge(id);
  }
  deleteKnowledge(id: string): boolean {
    return Number(this.raw.prepare("DELETE FROM knowledge WHERE id = ?").run(id).changes) > 0;
  }

  // ── 注入读取侧（清单：id + 标题 + 描述，生效且按 sort_order）──
  /** 生效清单（按 sort_order 升序），供快照生成器取 top。给 id/标题/描述，正文按 id 经 MCP 工具读取。 */
  enabledAssetLists(projectId: string | null): {
    knowledge: AssetListItem[];
    agents: AssetListItem[];
    skills: AssetListItem[];
  } {
    const knowledge = (
      this.raw
        .prepare(
          `SELECT k.id, k.title, k.description FROM knowledge k
           LEFT JOIN projects p ON p.id = k.project_id
           WHERE k.enabled = 1 AND k.deleted_at IS NULL
             AND (k.scope = 'global' OR (k.scope = 'project' AND p.deleted_at IS NULL AND (? IS NOT NULL AND k.project_id = ?)))
           ORDER BY k.sort_order ASC, k.rowid ASC`,
        )
        .all(projectId, projectId) as Record<string, unknown>[]
    ).map((r) => ({ id: r.id as string, title: r.title as string, description: r.description as string }));
    const agents = (
      this.raw.prepare("SELECT id, name, description FROM agents WHERE enabled = 1 ORDER BY sort_order ASC, rowid ASC").all() as Record<string, unknown>[]
    ).map((r) => ({ id: r.id as string, title: r.name as string, description: r.description as string }));
    const skills = (
      this.raw.prepare("SELECT id, name, description FROM skills WHERE enabled = 1 AND status = 'active' ORDER BY sort_order ASC, rowid ASC").all() as Record<string, unknown>[]
    ).map((r) => ({ id: r.id as string, title: r.name as string, description: r.description as string }));
    return { knowledge, agents, skills };
  }
}
