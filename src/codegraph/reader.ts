import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../infra/logger.js";
import { libDatabasePath } from "./lib.js";

const log = createLogger("codegraph:reader");

/**
 * 只读消费 vendored 库为每个项目生成的独立索引库（{DATA_DIR}/codegraph/<hash>/codegraph.db）。
 * 表结构（库内）：nodes / edges / files。本模块把某项目的 nodes + calls 边载入内存邻接表，
 * 支撑 search/node/callers/callees/impact/explore/files/graph——对外形状与旧自研实现完全一致。
 */

export interface CgSymbolRow {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  line: number;
  endLine: number;
  filePath: string;
}

export interface CgFileRow {
  path: string;
  lang: string;
  size: number;
}

interface Graph {
  nodes: Map<string, CgSymbolRow>;
  out: Map<string, Set<string>>; // calls：from → to
  in: Map<string, Set<string>>; // calls：to → from
  files: CgFileRow[];
  totalEdges: number;
}

function loadGraph(dbFile: string): Graph {
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const nodes = new Map<string, CgSymbolRow>();
    const nodeRows = raw
      .prepare("SELECT id, name, qualified_name, kind, start_line, end_line, file_path FROM nodes")
      .all() as Record<string, unknown>[];
    for (const r of nodeRows) {
      nodes.set(r.id as string, {
        id: r.id as string,
        name: r.name as string,
        qualifiedName: r.qualified_name as string,
        kind: r.kind as string,
        line: r.start_line as number,
        endLine: r.end_line as number,
        filePath: r.file_path as string,
      });
    }
    const out = new Map<string, Set<string>>();
    const in_ = new Map<string, Set<string>>();
    let totalEdges = 0;
    const edgeRows = raw.prepare("SELECT source, target FROM edges WHERE kind = 'calls'").all() as {
      source: string;
      target: string;
    }[];
    for (const e of edgeRows) {
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
      if (!out.has(e.source)) out.set(e.source, new Set());
      out.get(e.source)!.add(e.target);
      if (!in_.has(e.target)) in_.set(e.target, new Set());
      in_.get(e.target)!.add(e.source);
      totalEdges++;
    }
    const files: CgFileRow[] = (raw.prepare("SELECT path, language, size FROM files ORDER BY path").all() as Record<string, unknown>[]).map(
      (f) => ({ path: f.path as string, lang: f.language as string, size: f.size as number }),
    );
    return { nodes, out, in: in_, files, totalEdges };
  } finally {
    raw.close();
  }
}

/** 每项目图实例缓存（LRU）。索引变更后 invalidate 重载。 */
export class GraphReaders {
  private readonly max: number;
  private readonly cache = new Map<string, Graph>();

  constructor(maxInstances = 8) {
    this.max = maxInstances;
  }

  private graph(projectId: string, projectRoot: string): Graph | null {
    const hit = this.cache.get(projectId);
    if (hit) {
      this.cache.delete(projectId);
      this.cache.set(projectId, hit);
      return hit;
    }
    const dbFile = libDatabasePath(projectRoot);
    if (!existsSync(dbFile)) return null;
    let g: Graph;
    try {
      g = loadGraph(dbFile);
    } catch (err) {
      log.warn({ err: String(err), projectId, dbFile }, "读取项目索引库失败");
      return null;
    }
    this.cache.set(projectId, g);
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return g;
  }

  has(projectId: string, projectRoot: string): boolean {
    return existsSync(libDatabasePath(projectRoot));
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  /** 索引库统计（files/nodes/calls 边数），无库返回 null。 */
  stats(projectId: string, projectRoot: string): { files: number; symbols: number; edges: number } | null {
    const g = this.graph(projectId, projectRoot);
    if (!g) return null;
    return { files: g.files.length, symbols: g.nodes.size, edges: g.totalEdges };
  }

  search(projectId: string, projectRoot: string, query: string, limit = 50): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    const q = query.toLowerCase();
    const hits: { s: CgSymbolRow; score: number }[] = [];
    for (const s of g.nodes.values()) {
      if (s.kind === "file" || s.kind === "import" || s.kind === "namespace") continue;
      const inName = s.name.toLowerCase().includes(q);
      const inQ = s.qualifiedName.toLowerCase().includes(q);
      if (!inName && !inQ) continue;
      // 打分：前缀 > 全名匹配 > 子串；短名优先（对齐旧 ORDER BY length,name）
      let score = 3;
      if (s.name.toLowerCase() === q) score = 0;
      else if (s.name.toLowerCase().startsWith(q)) score = 1;
      else if (inName) score = 2;
      else score = 4;
      hits.push({ s, score });
    }
    hits.sort((a, b) => a.score - b.score || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name));
    return hits.slice(0, Math.min(limit, 200)).map((h) => h.s);
  }

  byId(projectId: string, projectRoot: string, id: string): CgSymbolRow | undefined {
    return this.graph(projectId, projectRoot)?.nodes.get(id);
  }

  byName(projectId: string, projectRoot: string, name: string): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    const out: CgSymbolRow[] = [];
    for (const s of g.nodes.values()) {
      if (s.name === name && s.kind !== "file") out.push(s);
      if (out.length >= 50) break;
    }
    return out;
  }

  callers(projectId: string, projectRoot: string, id: string): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    return [...(g.in.get(id) ?? [])].map((x) => g.nodes.get(x)).filter((s): s is CgSymbolRow => !!s);
  }

  callees(projectId: string, projectRoot: string, id: string): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    return [...(g.out.get(id) ?? [])].map((x) => g.nodes.get(x)).filter((s): s is CgSymbolRow => !!s);
  }

  /** 影响面：反向 BFS（谁直接或间接依赖本符号）。 */
  impact(projectId: string, projectRoot: string, id: string, depth: number): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    const result: CgSymbolRow[] = [];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const caller of g.in.get(cur) ?? []) {
          if (seen.has(caller)) continue;
          seen.add(caller);
          next.push(caller);
          const node = g.nodes.get(caller);
          if (node) result.push(node);
        }
      }
      frontier = next;
    }
    return result;
  }

  fileSymbols(projectId: string, projectRoot: string, filePath: string): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    return [...g.nodes.values()].filter((s) => s.filePath === filePath && s.kind !== "file").sort((a, b) => a.line - b.line);
  }

  listFiles(projectId: string, projectRoot: string): CgFileRow[] {
    return this.graph(projectId, projectRoot)?.files ?? [];
  }

  /** 全量节点 + calls 边（管理台图渲染用）。 */
  graphAll(projectId: string, projectRoot: string): { nodes: CgSymbolRow[]; edges: { from: string; to: string }[] } {
    const g = this.graph(projectId, projectRoot);
    if (!g) return { nodes: [], edges: [] };
    const nodes: CgSymbolRow[] = [];
    for (const s of g.nodes.values()) {
      if (s.kind === "file" || s.kind === "import" || s.kind === "namespace") continue;
      nodes.push(s);
    }
    const edges: { from: string; to: string }[] = [];
    for (const [from, tos] of g.out) for (const to of tos) edges.push({ from, to });
    return { nodes, edges };
  }
}

/** 供删除项目时清理其外置索引库（整个项目索引目录）。 */
export function removeProjectIndex(projectRoot: string): void {
  const dbFile = libDatabasePath(projectRoot);
  if (!existsSync(dbFile)) return;
  const dir = path.dirname(dbFile);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err: String(err), projectRoot }, "清理项目索引库失败（可忽略）");
  }
}
