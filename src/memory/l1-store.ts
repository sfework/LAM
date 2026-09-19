import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { tokenizeForFts, buildFtsQuery } from "./tokenize.js";
import { vecToBlob } from "./embedding.js";
import { rrfMerge } from "./rrf.js";
import type { L1Kind } from "./prompts.js";

export interface L1Record {
  id: string;
  projectId: string;
  kind: L1Kind;
  content: string;
  priority: number;
  sceneName: string | null;
  sourceL0Ids: string[];
  batchId: string | null;
  createdAt: number;
  updatedAt: number;
  supersededBy: string | null;
  deletedAt: number | null;
}

export interface NewL1 {
  kind: L1Kind;
  content: string;
  priority: number;
  sceneName: string | null;
  sourceL0Ids: string[];
  batchId: string | null;
  createdAt: number;
}

function toRecord(r: Record<string, unknown>): L1Record {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as L1Kind,
    content: r.content as string,
    priority: r.priority as number,
    sceneName: (r.scene_name as string | null) ?? null,
    sourceL0Ids: JSON.parse((r.source_l0_ids as string) || "[]"),
    batchId: (r.batch_id as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    supersededBy: (r.superseded_by as string | null) ?? null,
    deletedAt: (r.deleted_at as number | null) ?? null,
  };
}

/**
 * L1 存储：写入 + FTS 索引同步 + 向量索引 + supersede（软替换）+ BM25/向量/RRF 检索。
 * 检索/候选召回统一走这里（阶段 7 召回也复用）。
 *
 * ftsAvailable=false 时降级：不建 FTS 索引、BM25 检索返回空，
 * 冲突检测因此退化为"全部 store"（DESIGN §2.7 降级路径）。
 * vecAvailable=false 时：不写/不查向量，混合检索退化为纯 BM25。
 */
export class L1Store {
  private readonly raw: DatabaseSync;
  private readonly ftsAvailable: boolean;
  private readonly vecAvailable: boolean;

  constructor(raw: DatabaseSync, ftsAvailable = true, vecAvailable = false) {
    this.raw = raw;
    this.ftsAvailable = ftsAvailable;
    this.vecAvailable = vecAvailable;
  }

  /** 向量能力是否可用（供召回侧判断是否走混合检索）。 */
  get vecEnabled(): boolean {
    return this.vecAvailable;
  }

  /** 写入一条 L1 并同步 FTS。返回 id。 */
  insert(projectId: string, rec: NewL1): string {
    const id = newId("l1");
    this.raw
      .prepare(
        `INSERT INTO mem_l1 (id, project_id, kind, content, priority, scene_name, source_l0_ids, batch_id, created_at, updated_at, superseded_by, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        id,
        projectId,
        rec.kind,
        rec.content,
        rec.priority,
        rec.sceneName,
        JSON.stringify(rec.sourceL0Ids),
        rec.batchId,
        rec.createdAt,
        rec.createdAt,
      );
    if (this.ftsAvailable) this.indexFts(id, projectId, rec.content);
    return id;
  }

  private indexFts(id: string, projectId: string, content: string): void {
    // rowid 用 mem_l1 的同名 rowid 不便跨表对齐，这里以 l1_id 独立管理
    this.raw
      .prepare("INSERT INTO mem_l1_fts (content, l1_id, project_id) VALUES (?,?,?)")
      .run(tokenizeForFts(content), id, projectId);
  }

  /** BM25 检索（阶段 7 召回 + 冲突检测候选）。排除 superseded 与软删。FTS 不可用时返回空。 */
  search(projectId: string, query: string, limit: number): { record: L1Record; score: number }[] {
    if (!this.ftsAvailable) return [];
    const match = buildFtsQuery(query);
    if (!match) return [];
    const rows = this.raw
      .prepare(
        `SELECT m.*, bm25(mem_l1_fts) AS rank
         FROM mem_l1_fts f
         JOIN mem_l1 m ON m.id = f.l1_id
         WHERE mem_l1_fts MATCH ? AND f.project_id = ?
           AND m.deleted_at IS NULL AND m.superseded_by IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, projectId, limit) as Record<string, unknown>[];
    // bm25() 越小越相关，转成越大越相关的 score（取负并平移）
    return rows.map((r) => ({ record: toRecord(r), score: -Number(r.rank) }));
  }

  get(id: string): L1Record | undefined {
    const r = this.raw.prepare("SELECT * FROM mem_l1 WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toRecord(r) : undefined;
  }

  /** 读 L1 + 其溯源 L0 原文（memory_read 工具用）。 */
  readWithSources(id: string): { record: L1Record; sources: { role: string; content: string; createdAt: number }[] } | undefined {
    const rec = this.get(id);
    if (!rec) return undefined;
    let sources: { role: string; content: string; createdAt: number }[] = [];
    if (rec.sourceL0Ids.length) {
      const ph = rec.sourceL0Ids.map(() => "?").join(",");
      const rows = this.raw
        .prepare(`SELECT role, content, created_at FROM mem_l0 WHERE id IN (${ph}) AND deleted_at IS NULL ORDER BY turn_seq`)
        .all(...rec.sourceL0Ids) as Record<string, unknown>[];
      sources = rows.map((r) => ({ role: r.role as string, content: r.content as string, createdAt: r.created_at as number }));
    }
    return { record: rec, sources };
  }

  /** 未生效替换、未软删的活跃记忆（画像凝练用）。 */
  listActive(projectId: string): L1Record[] {
    const rows = this.raw
      .prepare("SELECT * FROM mem_l1 WHERE project_id = ? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY created_at")
      .all(projectId) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * 管理端单条删除 = 物理删除（DESIGN 决策 56）：删 mem_l1 行 + 移出 FTS + 移出向量表。
   * （项目级联软删走 ProjectRepo，另行处理，与此不同。）
   */
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    if (this.ftsAvailable) this.raw.prepare("DELETE FROM mem_l1_fts WHERE l1_id = ?").run(id);
    if (this.vecAvailable) this.raw.prepare("DELETE FROM mem_l1_vec WHERE l1_id = ?").run(id);
    const res = this.raw.prepare("DELETE FROM mem_l1 WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  /**
   * 管理端编辑正文：内容变化才写库，并同步重建 FTS、失效向量（删除 vec 行，
   * 由调度器的补嵌入在下个 tick 用新内容重新向量化——复用既有 backfill 机制，避免在 API 里阻塞调 embedding）。
   * 内容未变返回 changed=false（不动 FTS/向量）。
   */
  updateContent(id: string, content: string): { changed: boolean; projectId?: string } {
    const rec = this.get(id);
    if (!rec || rec.deletedAt !== null) return { changed: false };
    if (rec.content === content) return { changed: false, projectId: rec.projectId };
    const now = Date.now();
    this.raw.prepare("UPDATE mem_l1 SET content = ?, updated_at = ? WHERE id = ?").run(content, now, id);
    if (this.ftsAvailable) {
      this.raw.prepare("DELETE FROM mem_l1_fts WHERE l1_id = ?").run(id);
      this.indexFts(id, rec.projectId, content);
    }
    if (this.vecAvailable) {
      this.raw.prepare("DELETE FROM mem_l1_vec WHERE l1_id = ?").run(id);
    }
    return { changed: true, projectId: rec.projectId };
  }

  /**
   * 冲突决策落库：
   *  - store：直接 insert；
   *  - update/merge：insert 新条目 + 把 target_ids 置 superseded_by=新 id；
   *  - skip：不落库。
   * 返回新条目 id（skip 时 null）。
   */
  applyDecision(projectId: string, decision: { action: "store" | "update" | "skip" | "merge"; targetIds: string[] }, rec: NewL1): string | null {
    if (decision.action === "skip") return null;
    const id = this.insert(projectId, rec);
    if (decision.action === "update" || decision.action === "merge") {
      const sup = this.raw.prepare("UPDATE mem_l1 SET superseded_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL");
      const now = Date.now();
      for (const t of decision.targetIds) {
        if (t && t !== id) sup.run(id, now, t);
      }
    }
    return id;
  }

  // ── 向量索引（sqlite-vec，dim=1024，cosine）──

  /** 写入/更新某条 L1 的向量。vecAvailable=false 时 no-op。 */
  upsertVector(l1Id: string, projectId: string, vec: Float32Array): void {
    if (!this.vecAvailable) return;
    this.raw
      .prepare("INSERT OR REPLACE INTO mem_l1_vec (l1_id, embedding, project_id) VALUES (?,?,?)")
      .run(l1Id, vecToBlob(vec), projectId);
  }

  /** 向量 kNN 检索（按项目分区），返回 id + cosine distance（越小越近）。 */
  searchVector(projectId: string, queryVec: Float32Array, limit: number): { id: string; distance: number }[] {
    if (!this.vecAvailable) return [];
    const rows = this.raw
      .prepare(
        `SELECT l1_id, distance FROM mem_l1_vec
         WHERE embedding MATCH ? AND k = ? AND project_id = ?
         ORDER BY distance`,
      )
      .all(vecToBlob(queryVec), limit, projectId) as { l1_id: string; distance: number }[];
    return rows.map((r) => ({ id: r.l1_id, distance: r.distance }));
  }

  /** 活跃但未建向量的 L1（补嵌入任务消费）。 */
  listActiveMissingEmbedding(projectId: string, limit: number): L1Record[] {
    if (!this.vecAvailable) return [];
    const rows = this.raw
      .prepare(
        `SELECT m.* FROM mem_l1 m
         LEFT JOIN mem_l1_vec v ON v.l1_id = m.id
         WHERE m.project_id = ? AND m.deleted_at IS NULL AND m.superseded_by IS NULL AND v.l1_id IS NULL
         ORDER BY m.created_at LIMIT ?`,
      )
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * RRF 混合检索（FTS BM25 + 向量，k=60）。
   * queryVec 为空或未启用向量时退化为纯 BM25。
   */
  searchHybrid(
    projectId: string,
    query: string,
    queryVec: Float32Array | null,
    limit: number,
  ): { record: L1Record; score: number }[] {
    const fetch = Math.max(limit * 2, 10);
    const ftsHits = this.search(projectId, query, fetch);
    if (!queryVec || !this.vecAvailable) return ftsHits.slice(0, limit);

    const vecHits = this.searchVector(projectId, queryVec, fetch);
    // 向量命中的 id → record（get 过滤软删/superseded）
    const vecRecords: { record: L1Record; rank: number }[] = [];
    for (const h of vecHits) {
      const rec = this.get(h.id);
      if (rec && rec.supersededBy === null && rec.deletedAt === null) vecRecords.push({ record: rec, rank: vecRecords.length });
    }

    return rrfMerge(
      [ftsHits.map((h) => h.record), vecRecords.map((v) => v.record)],
      (r) => r.id,
    )
      .slice(0, limit)
      .map((x) => ({ record: x.item, score: x.rrfScore }));
  }
}
