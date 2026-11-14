import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { colJson, colNum, colNumOrNull, colStr, colStrOrNull, getRow, getRows, type SqlRow } from "../db/rows.js";
import { buildFtsQuery, tokenizeForFts } from "./tokenize.js";
import { vecToBlob } from "./embedding.js";
import { rrfMerge } from "./rrf.js";
import type { MemoryKind } from "./prompts.js";

export type { MemoryKind };
export { MEMORY_KINDS, isMemoryKind } from "./prompts.js";

/** 记忆条目：从对话提取的原子事实/偏好/方法等。 */
export interface MemoryRow {
  id: string;
  projectId: string;
  kind: MemoryKind;
  content: string;
  priority: number;
  sceneName: string | null;
  sourceConversationIds: string[];
  /** 提取侧 metadata（JSON 字符串）：如 activity_start_time 等。 */
  metadata: string;
  batchId: string | null;
  /** 归档批次号（memory_archive 写入；restore 按批撤销）。 */
  archiveBatch: string | null;
  createdAt: number;
  updatedAt: number;
  supersededBy: string | null;
  deletedAt: number | null;
}

export interface NewMemory {
  kind: MemoryKind;
  content: string;
  priority: number;
  sceneName: string | null;
  sourceConversationIds: string[];
  metadata?: string;
  batchId: string | null;
  createdAt: number;
}

function mapMemory(r: SqlRow): MemoryRow {
  return {
    id: colStr(r, "id"),
    projectId: colStr(r, "project_id"),
    kind: colStr(r, "kind") as MemoryKind,
    content: colStr(r, "content"),
    priority: colNum(r, "priority"),
    sceneName: colStrOrNull(r, "scene_name"),
    sourceConversationIds: colJson<string[]>(r, "source_conversation_ids", []),
    metadata: colStrOrNull(r, "metadata") ?? "{}",
    batchId: colStrOrNull(r, "batch_id"),
    archiveBatch: colStrOrNull(r, "archive_batch"),
    createdAt: colNum(r, "created_at"),
    updatedAt: colNum(r, "updated_at"),
    supersededBy: colStrOrNull(r, "superseded_by"),
    deletedAt: colNumOrNull(r, "deleted_at"),
  };
}

/**
 * 记忆存储：写入 + FTS 索引同步 + 向量索引 + supersede（软替换）+ BM25/向量/RRF 检索。
 *
 * ftsAvailable=false 时降级：不建 FTS 索引、BM25 检索返回空，
 * 冲突检测因此退化为"全部 store"。
 * vecAvailable=false 时：不写/不查向量，混合检索退化为纯 BM25。
 */
export class MemoryRepo {
  private readonly db: DatabaseSync;
  private readonly ftsAvailable: boolean;
  private readonly vecAvailable: boolean;

  constructor(db: DatabaseSync, ftsAvailable: boolean, vecAvailable = false) {
    this.db = db;
    this.ftsAvailable = ftsAvailable;
    this.vecAvailable = vecAvailable;
  }

  /** 向量能力是否可用（供召回侧判断是否走混合检索）。 */
  get vecEnabled(): boolean {
    return this.vecAvailable;
  }

  /** 写入一条记忆并同步 FTS。返回 id。 */
  insert(projectId: string, rec: NewMemory): string {
    const id = newId("mem");
    this.db
      .prepare(
        `INSERT INTO memory_items (id, project_id, kind, content, priority, scene_name, source_conversation_ids, metadata, batch_id, created_at, updated_at, superseded_by, deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(
        id, projectId, rec.kind, rec.content, rec.priority, rec.sceneName,
        JSON.stringify(rec.sourceConversationIds), rec.metadata ?? "{}", rec.batchId, rec.createdAt, rec.createdAt,
      );
    if (this.ftsAvailable) this.indexFts(id, projectId, rec.content);
    return id;
  }

  private indexFts(id: string, projectId: string, content: string): void {
    this.db
      .prepare("INSERT INTO memory_items_fts (content, memory_id, project_id) VALUES (?,?,?)")
      .run(tokenizeForFts(content), id, projectId);
  }

  findById(id: string): MemoryRow | undefined {
    const r = getRow(this.db, "SELECT * FROM memory_items WHERE id = ?", id);
    return r ? mapMemory(r) : undefined;
  }

  /** 读记忆 + 其溯源对话原文（管理端单条详情用）。 */
  readWithSources(id: string): { record: MemoryRow; sources: { role: string; content: string; createdAt: number }[] } | undefined {
    const rec = this.findById(id);
    if (!rec) return undefined;
    let sources: { role: string; content: string; createdAt: number }[] = [];
    if (rec.sourceConversationIds.length) {
      const ph = rec.sourceConversationIds.map(() => "?").join(",");
      sources = getRows(
        this.db,
        `SELECT role, content, created_at FROM conversations WHERE id IN (${ph}) AND deleted_at IS NULL ORDER BY turn_seq`,
        ...rec.sourceConversationIds,
      ).map((r) => ({ role: colStr(r, "role"), content: colStr(r, "content"), createdAt: colNum(r, "created_at") }));
    }
    return { record: rec, sources };
  }

  /** 批量按 id 读取（id → record；不存在的不含键）。向量命中回表用，避免 N+1。 */
  getMany(ids: readonly string[]): Map<string, MemoryRow> {
    const out = new Map<string, MemoryRow>();
    if (!ids.length) return out;
    const ph = ids.map(() => "?").join(",");
    for (const r of getRows(this.db, `SELECT * FROM memory_items WHERE id IN (${ph})`, ...ids)) {
      const rec = mapMemory(r);
      out.set(rec.id, rec);
    }
    return out;
  }

  /** 项目当前活跃记忆（未软删、未被替换），按生成时间倒序取最近 N 条（每轮注入用）。 */
  listActiveByRecency(projectId: string, limit: number, excludeKinds: MemoryKind[] = []): MemoryRow[] {
    if (limit <= 0) return [];
    const marks = excludeKinds.map(() => "?").join(",");
    const sql =
      `SELECT * FROM memory_items WHERE project_id = ? AND deleted_at IS NULL AND superseded_by IS NULL` +
      (excludeKinds.length ? ` AND kind NOT IN (${marks})` : "") +
      ` ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    const params = excludeKinds.length ? [projectId, ...excludeKinds, limit] : [projectId, limit];
    return getRows(this.db, sql, ...params).map(mapMemory);
  }

  /** 项目全部活跃记忆（画像凝练用，created_at 升序）。 */
  listActive(projectId: string): MemoryRow[] {
    return getRows(
      this.db,
      "SELECT * FROM memory_items WHERE project_id = ? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY created_at",
      projectId,
    ).map(mapMemory);
  }

  /** 比 watermark 更新的活跃记忆（画像增量凝练用）。 */
  listActiveAfter(projectId: string, watermarkMs: number): MemoryRow[] {
    return getRows(
      this.db,
      "SELECT * FROM memory_items WHERE project_id = ? AND created_at > ? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY created_at ASC",
      projectId, watermarkMs,
    ).map(mapMemory);
  }

  /** 活跃记忆的最新生成时刻（召回缓存版本位：新记忆入库即让缓存失效）。无活跃记忆返回 0。 */
  latestActiveCreatedAt(projectId: string): number {
    const r = getRow(
      this.db,
      "SELECT COALESCE(MAX(created_at), 0) AS m FROM memory_items WHERE project_id = ? AND deleted_at IS NULL AND superseded_by IS NULL",
      projectId,
    );
    return r ? colNum(r, "m") : 0;
  }

  /** BM25 关键词检索（冲突检测候选 + 混合检索 FTS 通道）。排除 superseded 与软删；FTS 不可用返回空。 */
  searchBm25(projectId: string, query: string, limit: number): { record: MemoryRow; score: number }[] {
    if (!this.ftsAvailable) return [];
    const match = buildFtsQuery(query);
    if (!match) return [];
    const rows = getRows(
      this.db,
      `SELECT m.*, bm25(memory_items_fts) AS rank
       FROM memory_items_fts f
       JOIN memory_items m ON m.id = f.memory_id
       WHERE memory_items_fts MATCH ? AND f.project_id = ?
         AND m.deleted_at IS NULL AND m.superseded_by IS NULL
       ORDER BY rank LIMIT ?`,
      match, projectId, limit,
    );
    // bm25() 越小越相关，转成越大越相关的 score（取负）
    return rows.map((r) => ({ record: mapMemory(r), score: -colNum(r, "rank") }));
  }

  /**
   * RRF 混合检索（FTS BM25 + 向量，k=60）。
   * queryVec 为空或未启用向量时退化为纯 BM25。
   * 向量命中按余弦相似度 1-distance 阈值 simMin 过滤（仅召回路径）。
   * 返回附 source（bm25/vec/both）供审计与召回侧重排。
   */
  searchHybrid(
    projectId: string,
    query: string,
    queryVec: Float32Array | null,
    limit: number,
    simMin = 0,
  ): { record: MemoryRow; score: number; source: "bm25" | "vec" | "both" }[] {
    const fetch = Math.max(limit * 2, 10);
    const ftsHits = this.searchBm25(projectId, query, fetch);
    if (!queryVec || !this.vecAvailable) {
      return ftsHits.slice(0, limit).map((h) => ({ record: h.record, score: h.score, source: "bm25" as const }));
    }

    const vecHits = this.searchVector(projectId, queryVec, fetch);
    const vecRows = this.getMany(vecHits.map((h) => h.id));
    const vecRecords: MemoryRow[] = [];
    const vecIds = new Set<string>();
    for (const h of vecHits) {
      if (1 - h.distance < simMin) continue;
      const rec = vecRows.get(h.id);
      if (rec && rec.supersededBy === null && rec.deletedAt === null) {
        vecRecords.push(rec);
        vecIds.add(rec.id);
      }
    }

    const ftsIds = new Set(ftsHits.map((h) => h.record.id));
    return rrfMerge(
      [ftsHits.map((h) => h.record), vecRecords],
      (r) => r.id,
    )
      .slice(0, limit)
      .map((x) => ({
        record: x.item,
        score: x.rrfScore,
        source: ftsIds.has(x.item.id) && vecIds.has(x.item.id) ? ("both" as const) : vecIds.has(x.item.id) ? ("vec" as const) : ("bm25" as const),
      }));
  }

  /**
   * 编辑记忆内容/优先级（管理端修正用）。
   * 内容变化时同步重建 FTS，并失效向量（删 vec 行，由补嵌入器下个 tick 重建）。
   */
  update(id: string, patch: { content?: string; priority?: number }): MemoryRow | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;
    const content = patch.content ?? existing.content;
    const priority = patch.priority ?? existing.priority;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE memory_items SET content = ?, priority = ?, updated_at = ? WHERE id = ?")
        .run(content, priority, Date.now(), id);
      if (content !== existing.content) {
        if (this.ftsAvailable) {
          this.db.prepare("DELETE FROM memory_items_fts WHERE memory_id = ?").run(id);
          this.indexFts(id, existing.projectId, content);
        }
        if (this.vecAvailable) this.db.prepare("DELETE FROM memory_items_vec WHERE memory_id = ?").run(id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.findById(id);
  }

  /**
   * 冲突决策落库：
   *  - store：直接 insert；
   *  - update/merge：insert 新条目 + 把 target_ids 置 superseded_by=新 id；
   *  - skip：不落库。
   * 返回新条目 id（skip 时 null）。
   */
  applyDecision(
    projectId: string,
    decision: { action: "store" | "update" | "skip" | "merge"; targetIds: string[] },
    rec: NewMemory,
  ): string | null {
    if (decision.action === "skip") return null;
    const id = this.insert(projectId, rec);
    if (decision.action === "update" || decision.action === "merge") {
      const sup = this.db.prepare("UPDATE memory_items SET superseded_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL");
      const now = Date.now();
      for (const t of decision.targetIds) {
        if (t && t !== id) sup.run(id, now, t);
      }
    }
    return id;
  }

  /** 软删（管理端删除 / 整理归档）。 */
  softDelete(id: string): boolean {
    const r = this.db.prepare("UPDATE memory_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), id);
    return r.changes > 0;
  }

  // ── 记忆整理（归档 / 恢复 / 分页枚举）──

  /**
   * 批量归档（软删 + 批次号）：置 deleted_at 与 archive_batch，行/FTS/向量全部保留。
   * 只处理该项目下未归档的活跃行；返回 { batchId, archived }（archived=0 时不落批次）。
   */
  archiveBatchOf(projectId: string, ids: readonly string[], reason?: string): { batchId: string; archived: number } {
    if (!ids.length) return { batchId: "", archived: 0 };
    const batchId = newId("bat");
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const ph = ids.map(() => "?").join(",");
      const r = this.db
        .prepare(
          `UPDATE memory_items SET deleted_at = ?, archive_batch = ?, updated_at = ?
           WHERE project_id = ? AND deleted_at IS NULL AND id IN (${ph})`,
        )
        .run(now, batchId, now, projectId, ...ids);
      const archived = Number(r.changes);
      if (archived === 0) {
        this.db.exec("ROLLBACK");
        return { batchId: "", archived: 0 };
      }
      // reason 记入每条 metadata（浅合并，不破坏提取侧字段）——审计与回滚依据。
      if (reason) this.stampReason(batchId, reason, ids);
      this.db.exec("COMMIT");
      return { batchId, archived };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }


  /**
   * 撤销归档：按批次号或按 id 列表清除 deleted_at / archive_batch。
   * 行、FTS、向量原地保留 → 复活零成本。返回恢复条数。
   */
  restore(projectId: string, target: { batchId?: string; ids?: readonly string[] }): number {
    const now = Date.now();
    if (target.batchId) {
      const r = this.db
        .prepare("UPDATE memory_items SET deleted_at = NULL, archive_batch = NULL, updated_at = ? WHERE project_id = ? AND archive_batch = ?")
        .run(now, projectId, target.batchId);
      return Number(r.changes);
    }
    if (target.ids?.length) {
      const ph = target.ids.map(() => "?").join(",");
      const r = this.db
        .prepare(`UPDATE memory_items SET deleted_at = NULL, archive_batch = NULL, updated_at = ? WHERE project_id = ? AND deleted_at IS NOT NULL AND id IN (${ph})`)
        .run(now, projectId, ...target.ids);
      return Number(r.changes);
    }
    return 0;
  }

  /** 分页枚举（含筛选）：active=活跃；archived=已归档（整理报告/复查用）。 */
  listPaged(
    projectId: string,
    opts: { page: number; pageSize: number; kind?: MemoryKind; keyword?: string; scope: "active" | "archived" },
  ): { rows: MemoryRow[]; totalCount: number } {
    const conds = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (opts.scope === "active") conds.push("deleted_at IS NULL", "superseded_by IS NULL");
    else conds.push("deleted_at IS NOT NULL", "archive_batch IS NOT NULL");
    if (opts.kind) { conds.push("kind = ?"); params.push(opts.kind); }
    const where = conds.join(" AND ");

    const cnt = getRow(this.db, `SELECT COUNT(*) AS c FROM memory_items WHERE ${where}`, ...params);
    const total = cnt ? colNum(cnt, "c") : 0;

    // keyword 内存过滤会破坏 SQL 分页的总数口径——数据量级小，直接全量取后切片。
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      const all = getRows(this.db, `SELECT * FROM memory_items WHERE ${where} ORDER BY created_at DESC`, ...params)
        .map(mapMemory)
        .filter((m) => m.content.toLowerCase().includes(kw));
      const start = (opts.page - 1) * opts.pageSize;
      return { rows: all.slice(start, start + opts.pageSize), totalCount: all.length };
    }
    const rows = getRows(
      this.db,
      `SELECT * FROM memory_items WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params, opts.pageSize, (opts.page - 1) * opts.pageSize,
    ).map(mapMemory);
    return { rows, totalCount: total };
  }

  /** 批次号 → 归档原因写入 metadata（浅合并；本事务内刚打上 batch 的行）。 */
  private stampReason(batchId: string, reason: string, ids: readonly string[]): void {
    const sel = this.db.prepare("SELECT id, metadata FROM memory_items WHERE archive_batch = ? AND id IN (" + ids.map(() => "?").join(",") + ")");
    const upd = this.db.prepare("UPDATE memory_items SET metadata = ? WHERE id = ?");
    for (const r of sel.all(batchId, ...ids) as { id: string; metadata: string | null }[]) {
      let obj: Record<string, unknown> = {};
      try { obj = JSON.parse(r.metadata || "{}") as Record<string, unknown>; } catch { /* 损坏则重建 */ }
      obj.archive_reason = reason;
      upd.run(JSON.stringify(obj), r.id);
    }
  }

  /** 管理端物理删除：删行 + 移出 FTS + 移出向量表。 */
  remove(id: string): boolean {
    if (!this.findById(id)) return false;
    if (this.ftsAvailable) this.db.prepare("DELETE FROM memory_items_fts WHERE memory_id = ?").run(id);
    if (this.vecAvailable) this.db.prepare("DELETE FROM memory_items_vec WHERE memory_id = ?").run(id);
    return this.db.prepare("DELETE FROM memory_items WHERE id = ?").run(id).changes > 0;
  }

  // ── 向量索引（sqlite-vec，dim=1024，cosine）──

  /** 写入/更新某条记忆的向量。vecAvailable=false 时 no-op。 */
  upsertVector(memoryId: string, projectId: string, vec: Float32Array): void {
    if (!this.vecAvailable) return;
    this.db
      .prepare("INSERT OR REPLACE INTO memory_items_vec (memory_id, embedding, project_id) VALUES (?,?,?)")
      .run(memoryId, vecToBlob(vec), projectId);
  }

  /** 全量失效向量（embedding 模型变更后）：清空 vec 表，补嵌入器下个 tick 全量重建。返回删除行数。 */
  invalidateAllVectors(): number {
    if (!this.vecAvailable) return 0;
    return Number(this.db.prepare("DELETE FROM memory_items_vec").run().changes);
  }

  /** 向量 kNN 检索（按项目分区），返回 id + cosine distance（越小越近）。 */
  searchVector(projectId: string, queryVec: Float32Array, limit: number): { id: string; distance: number }[] {
    if (!this.vecAvailable) return [];
    const rows = getRows(
      this.db,
      `SELECT memory_id, distance FROM memory_items_vec
       WHERE embedding MATCH ? AND k = ? AND project_id = ?
       ORDER BY distance`,
      vecToBlob(queryVec), limit, projectId,
    );
    return rows.map((r) => ({ id: colStr(r, "memory_id"), distance: colNum(r, "distance") }));
  }

  /** 活跃但未建向量的记忆（补嵌入任务消费）。 */
  listActiveMissingEmbedding(projectId: string, limit: number): MemoryRow[] {
    if (!this.vecAvailable) return [];
    return getRows(
      this.db,
      `SELECT m.* FROM memory_items m
       LEFT JOIN memory_items_vec v ON v.memory_id = m.id
       WHERE m.project_id = ? AND m.deleted_at IS NULL AND m.superseded_by IS NULL AND v.memory_id IS NULL
       ORDER BY m.created_at LIMIT ?`,
      projectId, limit,
    ).map(mapMemory);
  }
}
