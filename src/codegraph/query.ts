import type { CgStatusRepo, CgStatusValue } from "./status-repo.js";
import type { GraphReaders, CgSymbolRow } from "./reader.js";

/**
 * CodeGraph 查询层：8 个工具（DESIGN §2.8、决策 34 + 67）。
 *
 * 数据源已外置：vendored 库为每项目生成独立 codegraph.db，本层经 GraphReaders 只读消费，
 * 状态经 CgStatusRepo（gateway.db 的 cg_status）。未 ready/无库时返回进度提示（不静默返回空）。
 * projectId → 项目根路径由注入的 rootOf 解析（reader 需按根定位外置库）。对外返回形状与旧实现一致。
 */

export interface CgResult {
  status: CgStatusValue | "absent";
  progress?: { indexed: number; total: number };
  message?: string;
  data?: unknown;
}

const IMPACT_DEPTH_MAX = 5;
const DEFAULT_LIMIT = 30;

export class CodeGraphQuery {
  private readonly readers: GraphReaders;
  private readonly statusRepo: CgStatusRepo;
  private readonly rootOf: (projectId: string) => string | undefined;

  constructor(readers: GraphReaders, status: CgStatusRepo, rootOf: (projectId: string) => string | undefined) {
    this.readers = readers;
    this.statusRepo = status;
    this.rootOf = rootOf;
  }

  /** 读状态并给出未 ready 的提示；ready 返回 null 表示可继续查询。 */
  private guard(projectId: string, root: string): CgResult | null {
    const st = this.statusRepo.get(projectId);
    if (!this.readers.has(projectId, root)) {
      return { status: "absent", message: "该项目尚未建立代码索引。索引会在项目首次请求后自动启动，请稍后重试。" };
    }
    if (!st || st.status === "ready") return null;
    const progress = { indexed: st.indexedFiles, total: st.totalFiles };
    const label = st.status === "failed" ? "索引失败（将自动重试）" : "索引构建中";
    return {
      status: st.status,
      progress,
      message: `${label}：进度 ${progress.indexed}/${progress.total}。请稍后重试本查询。${st.lastError ? `（原因：${st.lastError}）` : ""}`,
    };
  }

  /** 7) 索引状态。 */
  status(projectId: string): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const st = this.statusRepo.get(projectId);
    const s = this.readers.stats(projectId, root);
    const status: CgStatusValue | "absent" = this.readers.has(projectId, root) ? st?.status ?? "ready" : "absent";
    return {
      status,
      data: {
        status,
        totalFiles: st?.totalFiles ?? s?.files ?? 0,
        indexedFiles: st?.indexedFiles ?? s?.files ?? 0,
        files: s?.files ?? 0,
        symbols: s?.symbols ?? 0,
        edges: s?.edges ?? 0,
        lastIndexedAt: st?.lastIndexedAt ?? null,
        lastError: st?.lastError ?? "",
      },
    };
  }

  /** 1) 符号搜索。 */
  search(projectId: string, query: string, limit = DEFAULT_LIMIT): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const blocked = this.guard(projectId, root);
    if (blocked) return blocked;
    if (!query.trim()) return { status: "ready", message: "请提供搜索关键词。" };
    const hits = this.readers.search(projectId, root, query.trim(), Math.min(limit, 200));
    if (!hits.length) return { status: "ready", message: `未找到匹配 "${query}" 的符号。`, data: [] };
    return { status: "ready", data: hits.map(brief) };
  }

  /** 6) 单符号详情（含直接调用关系）。 */
  node(projectId: string, ref: { id?: string; name?: string }): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const blocked = this.guard(projectId, root);
    if (blocked) return blocked;
    const resolved = this.resolveOne(projectId, root, ref);
    if ("result" in resolved) return resolved.result;
    const sym = resolved.symbol;
    return {
      status: "ready",
      data: {
        ...detail(sym),
        callers: this.readers.callers(projectId, root, sym.id).map(brief),
        callees: this.readers.callees(projectId, root, sym.id).map(brief),
      },
    };
  }

  /** 3) 调用方。 */
  callers(projectId: string, ref: { id?: string; name?: string }, limit = DEFAULT_LIMIT): CgResult {
    return this.relation(projectId, ref, "callers", limit);
  }

  /** 4) 被调方。 */
  callees(projectId: string, ref: { id?: string; name?: string }, limit = DEFAULT_LIMIT): CgResult {
    return this.relation(projectId, ref, "callees", limit);
  }

  private relation(projectId: string, ref: { id?: string; name?: string }, dir: "callers" | "callees", limit: number): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const blocked = this.guard(projectId, root);
    if (blocked) return blocked;
    const resolved = this.resolveOne(projectId, root, ref);
    if ("result" in resolved) return resolved.result;
    const sym = resolved.symbol;
    const list = (dir === "callers" ? this.readers.callers(projectId, root, sym.id) : this.readers.callees(projectId, root, sym.id)).slice(0, Math.min(limit, 200));
    const verb = dir === "callers" ? "调用" : "被调用";
    if (!list.length) {
      return { status: "ready", message: `${sym.name} 没有${dir === "callers" ? "调用方" : "被调方"}。`, data: [] };
    }
      return { status: "ready", data: { symbol: brief(sym), [dir]: list.map(brief), note: `${verb}关系为直接一跳（calls 边）。` } };
  }

  /** 5) 变更影响面（反向 BFS）。 */
  impact(projectId: string, ref: { id?: string; name?: string }, depth = 2): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const blocked = this.guard(projectId, root);
    if (blocked) return blocked;
    const resolved = this.resolveOne(projectId, root, ref);
    if ("result" in resolved) return resolved.result;
    const sym = resolved.symbol;
    const d = Math.max(1, Math.min(IMPACT_DEPTH_MAX, Math.floor(depth)));
    const affected = this.readers.impact(projectId, root, sym.id, d);
    if (!affected.length) {
      return { status: "ready", message: `${sym.name} 在 ${d} 层内没有受影响的符号（可能是入口且未被引用）。`, data: [] };
    }
    return { status: "ready", data: { symbol: brief(sym), depth: d, affectedCount: affected.length, affected: affected.slice(0, 100).map(brief), note: "依赖口径：调用/引用/继承/实现/实例化/类型引用。" } };
  }

  /** 2) 综合探索：符号 + 关系 + 同文件兄弟符号。 */
  explore(projectId: string, ref: { id?: string; name?: string; file?: string }): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const blocked = this.guard(projectId, root);
    if (blocked) return blocked;

    if (ref.file && !ref.name && !ref.id) {
      const f = this.readers.listFiles(projectId, root).find((x) => x.path === ref.file || x.path.endsWith(ref.file ?? ""));
      if (!f) return { status: "ready", message: `未找到文件：${ref.file}。可用 codegraph_files 查看已索引文件列表。` };
      const syms = this.readers.fileSymbols(projectId, root, f.path);
      return { status: "ready", data: { file: { path: f.path, lang: f.lang, size: f.size }, symbols: syms.map(brief) } };
    }

    const resolved = this.resolveOne(projectId, root, ref);
    if ("result" in resolved) return resolved.result;
    const sym = resolved.symbol;
    const file = this.readers.listFiles(projectId, root).find((x) => x.path === sym.filePath);
    const siblings = file ? this.readers.fileSymbols(projectId, root, file.path).filter((s) => s.id !== sym.id).map(brief).slice(0, 20) : [];
    return {
      status: "ready",
      data: {
        symbol: detail(sym),
        file: file ? { path: file.path, lang: file.lang, size: file.size } : null,
        callers: this.readers.callers(projectId, root, sym.id).map(brief),
        callees: this.readers.callees(projectId, root, sym.id).map(brief),
        siblings,
      },
    };
  }

  /** 8) 文件树 / 文件内符号。 */
  files(projectId: string, opts: { path?: string; withSymbols?: boolean } = {}): CgResult {
    const root = this.rootOf(projectId) ?? "";
    const blocked = this.guard(projectId, root);
    if (blocked) return blocked;
    const all = this.readers.listFiles(projectId, root);
    const filtered = opts.path ? all.filter((f) => f.path.includes(opts.path!)) : all;
    if (!filtered.length) {
      return { status: "ready", message: opts.path ? `没有路径包含 "${opts.path}" 的已索引文件。` : "尚无已索引文件。", data: [] };
    }
    if (opts.withSymbols) {
      return {
        status: "ready",
        data: filtered.slice(0, 50).map((f) => ({ path: f.path, lang: f.lang, symbols: this.readers.fileSymbols(projectId, root, f.path).map(brief) })),
      };
    }
    return { status: "ready", data: { total: filtered.length, files: filtered.slice(0, 300).map((f) => ({ path: f.path, lang: f.lang, size: f.size })) } };
  }

  private resolveOne(
    projectId: string,
    root: string,
    ref: { id?: string; name?: string },
  ): { symbol: CgSymbolRow } | { result: CgResult } {
    if (ref.id) {
      const s = this.readers.byId(projectId, root, ref.id);
      if (s) return { symbol: s };
      return { result: { status: "ready", message: `未找到符号 id：${ref.id}。可先用 codegraph_search 定位。` } };
    }
    if (ref.name) {
      const cands = this.readers.byName(projectId, root, ref.name);
      if (!cands.length) {
        const fuzzy = this.readers.search(projectId, root, ref.name, 10);
        return { result: { status: "ready", message: `未找到名为 "${ref.name}" 的符号。${fuzzy.length ? "相近的有：" : ""}`, data: fuzzy.map(brief) } };
      }
      if (cands.length > 1) {
        return { result: { status: "ready", message: `"${ref.name}" 匹配到 ${cands.length} 个符号，请用 id 精确指定（传 name 参数时要求唯一）。`, data: cands.map(brief) } };
      }
      return { symbol: cands[0]! };
    }
    return { result: { status: "ready", message: "需提供 id 或 name 之一。" } };
  }
}

function brief(s: CgSymbolRow) {
  return { id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, file: s.filePath, line: s.line };
}

function detail(s: CgSymbolRow) {
  return { id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, file: s.filePath, line: s.line, endLine: s.endLine };
}
