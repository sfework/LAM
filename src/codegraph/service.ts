import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "../infra/logger.js";
import type { SettingsService } from "../settings/service.js";
import type { ProjectRepo, ProjectRow } from "../projects/repo.js";
import { codegraphLib, libIsInitialized, type CodeGraphInstance } from "./lib.js";
import { CgStatusRepo } from "./status-repo.js";
import { GraphReaders, removeProjectIndex } from "./reader.js";
import { CodeGraphQuery, type CgResult } from "./query.js";

const log = createLogger("codegraph");

/**
 * CodeGraph 门面（DESIGN §2.8、决策 67）：驱动 vendored @colbymchenry/codegraph 库，
 * 索引落 {DATA_DIR}/codegraph/<项目哈希>/codegraph.db（与被扫描项目隔离），gateway.db 仅存状态。
 *
 * 触发时机（不使用 watcher，规避 Windows EBUSY）：
 * - 项目首次激活 → 全量首建；
 * - 每轮对话（final answer）累积计数，达 codegraph_reindex_every_conversations → 增量 sync；
 * - 手动"重建" → 强制全量重建（recreate + indexAll）。
 * 构建经并发上限队列串行化（同项目同时只跑一个）。
 */

interface BuildJob {
  projectId: string;
  root: string;
  force: boolean;
}

export class CodeGraphService {
  readonly status: CgStatusRepo;
  readonly readers: GraphReaders;
  readonly query: CodeGraphQuery;
  private readonly settings: SettingsService;
  private readonly projects: ProjectRepo;
  /** 已激活（已排队首建/已建）项目，避免每请求重复触发。 */
  private readonly activated = new Set<string>();
  /** 待建/在建队列 + 在途项目集。 */
  private readonly queue: BuildJob[] = [];
  private readonly building = new Set<string>();
  private active = 0;
  private stopped = false;

  constructor(raw: DatabaseSync, settings: SettingsService, projects: ProjectRepo) {
    this.settings = settings;
    this.projects = projects;
    this.status = new CgStatusRepo(raw);
    this.readers = new GraphReaders(settings.getInt("codegraph_max_concurrent"));
    this.query = new CodeGraphQuery(this.readers, this.status, (id) => this.projects.findById(id)?.path);
  }

  /** 网关每请求调用：确保项目已激活（首建）。幂等，热路径仅一次 Set 判断。 */
  activate(projectId: string, path: string): void {
    if (!this.settings.getBool("codegraph_enabled")) return;
    if (this.activated.has(projectId)) return;
    this.activated.add(projectId);
    this.status.ensure(projectId);
    this.enqueue({ projectId, root: path, force: false });
    log.debug({ projectId, path }, "CodeGraph 项目已激活（排队首建）");
  }

  /**
   * 网关每轮 final answer 调用：累积对话计数，达阈值触发增量 sync。
   * 阈值 <=0 表示关闭对话触发。fire-and-forget，不阻塞响应。
   */
  onTurn(projectId: string, path: string): void {
    if (!this.settings.getBool("codegraph_enabled")) return;
    const every = this.settings.getInt("codegraph_reindex_every_conversations");
    if (every <= 0) return;
    if (!this.status.bumpTurn(projectId, every)) return;
    this.activated.add(projectId);
    this.enqueue({ projectId, root: path, force: false });
    log.debug({ projectId, every }, "CodeGraph 达对话阈值，排队增量索引");
  }

  /** 软删/停用：移出激活集、失效缓存（外置库文件由 removeProject 清理）。 */
  deactivate(projectId: string): void {
    this.activated.delete(projectId);
    this.readers.invalidate(projectId);
    this.dropQueued(projectId);
  }

  /** 项目物理删除：清理其外置索引库目录 + 状态行。 */
  removeProject(projectId: string, path: string): void {
    this.deactivate(projectId);
    this.status.remove(projectId);
    removeProjectIndex(path);
    log.debug({ projectId, path }, "CodeGraph 外置索引已清理");
  }

  /**
   * 换目录：旧根的相对路径全部失效 → 删旧外置库、清状态、在新根重排全量重建。
   */
  relocate(projectId: string, oldPath: string, newPath: string): void {
    if (!this.activated.has(projectId) && !this.status.get(projectId)) {
      // 从未激活过：网关下次请求会按新路径自然激活，无需处理。
      return;
    }
    this.dropQueued(projectId);
    this.readers.invalidate(projectId);
    this.status.remove(projectId);
    removeProjectIndex(oldPath);
    this.activated.delete(projectId);
    if (this.settings.getBool("codegraph_enabled")) {
      this.activated.add(projectId);
      this.enqueue({ projectId, root: newPath, force: true });
      log.debug({ projectId, newPath }, "CodeGraph 已随项目换目录重建");
    }
  }

  /** 服务启动：为所有活跃项目续跑（崩溃/重启恢复：未初始化或过期的补建）。 */
  start(): void {
    if (!this.settings.getBool("codegraph_enabled")) {
      log.debug("codegraph_enabled=false，CodeGraph 未启动");
      return;
    }
    this.stopped = false;
    const active = this.projects.list();
    for (const p of active) {
      this.activated.add(p.id);
      this.status.ensure(p.id);
      // 启动即排队一次：未建 → 首建；已建 → sync（幂等，按内容 hash 跳过未变文件）。
      this.enqueue({ projectId: p.id, root: p.path, force: false });
    }
    log.debug({ projects: active.length }, "CodeGraph 已启动（续跑活跃项目）");
  }

  /** 手动全量重建（/api/codegraph/rebuild）。清状态后强制排队。 */
  rebuild(projectId: string): boolean {
    const p = this.projects.findById(projectId);
    if (!p) return false;
    this.status.setStatus(projectId, { status: "pending", indexedFiles: 0, lastError: "" });
    this.activated.add(projectId);
    this.enqueue({ projectId, root: p.path, force: true });
    log.debug({ projectId }, "CodeGraph 手动重建已触发");
    return true;
  }

  /** 关停：停止排队，等待在途排空。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    // 等待在途构建结束（最多 ~10s）。
    for (let i = 0; i < 100 && this.active > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    log.debug("CodeGraph 已停止");
  }

  statusOf(projectId: string): CgResult {
    return this.query.status(projectId);
  }

  /** 供 /api/codegraph/list 列出各项目索引概览。 */
  overview(): { project: ProjectRow; status: string; files: number; symbols: number }[] {
    return this.projects.list().map((p) => {
      const st = this.status.get(p.id);
      const s = this.readers.stats(p.id, p.path);
      return {
        project: p,
        status: s ? st?.status ?? "ready" : st?.status ?? "absent",
        files: s?.files ?? 0,
        symbols: s?.symbols ?? 0,
      };
    });
  }

  /**
   * 代码关系图（管理台可视化）：节点=符号、边=calls。
   * 大图按节点度数取 top maxNodes（防渲染爆炸），边只保留两端都在所选节点集内的。
   */
  graph(projectId: string, maxNodes = 150): {
    status: string;
    progress?: { indexed: number; total: number };
    message?: string;
    nodes: { id: string; name: string; qualifiedName: string; kind: string; file: string }[];
    edges: { from: string; to: string }[];
    stats: { totalSymbols: number; totalEdges: number; shownNodes: number; shownEdges: number };
  } {
    const p = this.projects.findById(projectId);
    const root = p?.path ?? "";
    const st = this.status.get(projectId);
    const hasIdx = this.readers.has(projectId, root);
    const status = hasIdx ? st?.status ?? "ready" : "absent";
    const { nodes: allSymbols, edges: allEdges } = this.readers.graphAll(projectId, root);
    const stats = { totalSymbols: allSymbols.length, totalEdges: allEdges.length, shownNodes: 0, shownEdges: 0 };
    if (status !== "ready") {
      return {
        status,
        progress: st ? { indexed: st.indexedFiles, total: st.totalFiles } : undefined,
        message: status === "absent" ? "该项目尚未建立代码索引" : `索引${status === "failed" ? "失败" : "构建中"}`,
        nodes: [],
        edges: [],
        stats,
      };
    }
    const degree = new Map<string, number>();
    for (const e of allEdges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const cap = Math.max(10, Math.min(500, Math.trunc(maxNodes)));
    const picked = allSymbols
      .slice()
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, cap);
    const inSet = new Set(picked.map((s) => s.id));
    const nodes = picked.map((s) => ({ id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, file: s.filePath }));
    const edges = allEdges.filter((e) => inSet.has(e.from) && inSet.has(e.to));
    return { status, nodes, edges, stats: { ...stats, shownNodes: nodes.length, shownEdges: edges.length } };
  }

  // ── 内部：并发受限构建队列 ──

  private dropQueued(projectId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.projectId === projectId) this.queue.splice(i, 1);
    }
  }

  private enqueue(job: BuildJob): void {
    if (this.stopped) return;
    // 同项目去重：队列里已有该项目任务则更新 force 标志，不重复排。
    const existing = this.queue.find((q) => q.projectId === job.projectId);
    if (existing) {
      existing.force = existing.force || job.force;
      existing.root = job.root;
      return;
    }
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    const cap = Math.max(1, this.settings.getInt("codegraph_max_concurrent"));
    while (this.active < cap && this.queue.length) {
      // 跳过在途项目
      const idx = this.queue.findIndex((q) => !this.building.has(q.projectId));
      if (idx < 0) break;
      const job = this.queue.splice(idx, 1)[0]!;
      this.active++;
      this.building.add(job.projectId);
      void this.run(job).finally(() => {
        this.active--;
        this.building.delete(job.projectId);
        this.pump();
      });
    }
  }

  private async run(job: BuildJob): Promise<void> {
    const { projectId, root, force } = job;
    try {
      this.status.setStatus(projectId, { status: "indexing", lastError: "" });
      log.info({ projectId, path: root, force: force ? "全量重建" : "首建/增量" }, "CodeGraph 开始构建索引");
      const lib = codegraphLib();
      let instance: CodeGraphInstance;
      let kind: "full" | "sync";
      if (force || !libIsInitialized(root)) {
        if (force && libIsInitialized(root)) {
          instance = await lib.default.recreate(root);
        } else {
          instance = await lib.default.init(root, { index: false });
        }
        kind = "full";
      } else {
        instance = await lib.default.open(root, { readOnly: false });
        kind = "sync";
      }
      try {
        const result = kind === "full" ? await instance.indexAll() : await instance.sync();
        const stats = instance.getStats();
        this.readers.invalidate(projectId);
        this.status.setStatus(projectId, {
          status: "ready",
          totalFiles: stats.fileCount,
          indexedFiles: stats.fileCount,
          lastIndexedAt: Date.now(),
          lastError: "",
        });
        log.info(
          { projectId, path: root, kind, files: stats.fileCount, nodes: stats.nodeCount, edges: stats.edgeCount },
          "CodeGraph 索引构建完成",
        );
      } finally {
        try {
          instance.close();
        } catch {
          /* 关闭失败不影响结果 */
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status.setStatus(projectId, { status: "failed", lastError: msg.slice(0, 500) });
      log.warn({ err: msg, projectId }, "CodeGraph 索引失败");
    }
  }
}
