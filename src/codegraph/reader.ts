import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../infra/logger.js";
import { libDatabasePath } from "./lib.js";

const log = createLogger("codegraph:reader");

/**
 * 只读消费 vendored 库为每个项目生成的独立索引库（{DATA_DIR}/codegraph/<hash>/codegraph.db）。
 * 表结构（库内）：nodes / edges / files / nodes_fts / name_segment_vocab。本模块把某项目的
 * nodes + calls 边（及依赖类反向边）载入内存邻接表，搜索直接走库的 FTS/段词表 SQL；
 * 支撑 search/node/callers/callees/impact/explore/files/graph——对外形状与旧自研实现一致。
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
  depIn: Map<string, Set<string>>; // 依赖边（calls+references+extends 等）：to → from，impact 反向 BFS 用
  files: CgFileRow[];
  totalEdges: number;
}

/**
 * 影响面分析纳入的边类型：除 calls 外的静态依赖关系（谁引用/继承/实例化了本符号）。
 * 不含 contains/imports/exports 等文件级结构边（会把整个文件的符号全部波及，噪音过大）。
 */
const IMPACT_EDGE_KINDS = "('calls','references','extends','implements','overrides','instantiates','type_of','returns')";

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
    const depIn = new Map<string, Set<string>>();
    let totalEdges = 0;
    const edgeRows = raw
      .prepare(`SELECT source, target, kind FROM edges WHERE kind = 'calls' OR kind IN ${IMPACT_EDGE_KINDS}`)
      .all() as { source: string; target: string; kind: string }[];
    for (const e of edgeRows) {
      if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) continue;
      if (e.kind === "calls") {
        if (!out.has(e.source)) out.set(e.source, new Set());
        out.get(e.source)!.add(e.target);
        if (!in_.has(e.target)) in_.set(e.target, new Set());
        in_.get(e.target)!.add(e.source);
        totalEdges++;
      }
      // calls 也在依赖集内（impact = 调用方 + 引用方 + 继承方…）
      if (!depIn.has(e.target)) depIn.set(e.target, new Set());
      depIn.get(e.target)!.add(e.source);
    }
    const files: CgFileRow[] = (raw.prepare("SELECT path, language, size FROM files ORDER BY path").all() as Record<string, unknown>[]).map(
      (f) => ({ path: f.path as string, lang: f.language as string, size: f.size as number }),
    );
    return { nodes, out, in: in_, depIn, files, totalEdges };
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

  /**
   * 符号搜索：优先走索引库的原生检索栈（FTS5 BM25 前缀 + camelCase 段词共现 + LIKE 子串兜底），
   * 库/表不可用（旧索引缺 nodes_fts 等）时回退内存子串扫描。对外形状不变。
   */
  search(projectId: string, projectRoot: string, query: string, limit = 50): CgSymbolRow[] {
    const cap = Math.min(limit, 200);
    return this.searchSql(projectRoot, query, cap) ?? this.searchScan(projectId, projectRoot, query, cap);
  }

  /** 内存子串扫描兜底（原实现，保持旧行为一致）。 */
  private searchScan(projectId: string, projectRoot: string, query: string, limit: number): CgSymbolRow[] {
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
    return hits.slice(0, limit).map((h) => h.s);
  }

  /**
   * SQL 检索通道（对齐 vendored 库 searchNodesFTS 的口径）：
   * 1. nodes_fts MATCH 前缀 + bm25 列权重 (0,20,5,1,2)——名称命中权重最高；
   * 2. name_segment_vocab 段词共现——"state machine" 之类散文词能命中 OrderStateMachine；
   * 3. LIKE 子串兜底——保留原有连续子串能力（含中文等非 ASCII）。
   * 支持 kind:/lang:/path:/name: 字段过滤（解析同库 query-parser，未知前缀按普通词处理）。
   * 任一环节抛错（表缺失、FTS 损坏）返回 null 交给调用方回退。
   */
  private searchSql(projectRoot: string, raw: string, limit: number): CgSymbolRow[] | null {
    const dbFile = libDatabasePath(projectRoot);
    if (!existsSync(dbFile)) return null;
    const pq = parseCgQuery(raw);
    if (!pq.text && !pq.kinds.length && !pq.langs.length && !pq.pathFilters.length && !pq.nameFilters.length) return null;
    const rawDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const found = new Map<string, CgSymbolRow>();
      const addAll = (rows: Record<string, unknown>[]) => {
        for (const r of rows) {
          const s = mapNodeRow(r);
          if (!found.has(s.id)) found.set(s.id, s);
        }
      };
      // 默认排除非代码符号节点（与旧扫描一致）；显式 kind: 过滤时尊重用户意图。
      const kindGate = pq.kinds.length
        ? ` AND kind IN (${pq.kinds.map(() => "?").join(",")})`
        : " AND kind NOT IN ('file','import','namespace')";
      const langGate = pq.langs.length ? ` AND language IN (${pq.langs.map(() => "?").join(",")})` : "";
      // FTS 分支两表 join，列需带表前缀避免歧义。
      const nGate = (kindGate + langGate).replace(/\bkind\b/g, "nodes.kind").replace(/\blanguage\b/g, "nodes.language");
      const kindParams = pq.kinds.length ? pq.kinds : [];
      const langParams = pq.langs.length ? pq.langs : [];

      // 1) FTS5 前缀检索（FTS 表不支持别名，MATCH 左操作数须为表名）
      const fts = toFtsQuery(pq.text);
      if (fts) {
        const rows = rawDb
          .prepare(
            `SELECT nodes.id, nodes.name, nodes.qualified_name, nodes.kind, nodes.start_line, nodes.end_line, nodes.file_path,
                    bm25(nodes_fts, 0, 20, 5, 1, 2) AS score
             FROM nodes_fts JOIN nodes ON nodes.id = nodes_fts.id
             WHERE nodes_fts MATCH ?${nGate}
             ORDER BY score LIMIT ?`,
          )
          .all(fts, ...kindParams, ...langParams, Math.max(limit * 3, 60)) as Record<string, unknown>[];
        addAll(rows);
      }

      // 2) 段词共现（按覆盖词数降序；单词语也保留，稀有度交给排序）
      const words = segmentWordVariants(pq.text.toLowerCase().split(/\s+/).filter((w) => w.length >= 2));
      if (words.length && found.size < limit) {
        const names = rawDb
          .prepare(
            `SELECT name FROM name_segment_vocab WHERE segment IN (${words.map(() => "?").join(",")})
             GROUP BY name ORDER BY COUNT(DISTINCT segment) DESC, length(name) ASC LIMIT ?`,
          )
          .all(...words, Math.max(limit * 2, 40)) as { name: string }[];
        if (names.length) {
          const sel = rawDb
            .prepare(
              `SELECT id, name, qualified_name, kind, start_line, end_line, file_path FROM nodes
               WHERE name IN (${names.map(() => "?").join(",")})${kindGate}${langGate}
               ORDER BY length(name) LIMIT ?`,
            )
            .all(...names.map((n) => n.name), ...kindParams, ...langParams, limit * 2) as Record<string, unknown>[];
          addAll(sel);
        }
      }

      // 3) LIKE 子串兜底（补齐 FTS 分词不覆盖的连续子串，如中文、词中片段）
      if (pq.text) {        const like = `%${pq.text.toLowerCase().replace(/[%_]/g, "")}%`;
        const rows = rawDb
          .prepare(
            `SELECT id, name, qualified_name, kind, start_line, end_line, file_path FROM nodes
             WHERE (lower(name) LIKE ? OR lower(qualified_name) LIKE ?)${kindGate}${langGate}
             ORDER BY CASE WHEN lower(name) = ? THEN 0 WHEN lower(name) LIKE ? THEN 1 ELSE 2 END, length(name)
             LIMIT ?`,
          )
          .all(like, like, ...kindParams, ...langParams, pq.text.toLowerCase(), `${pq.text.toLowerCase()}%`, limit * 2) as Record<string, unknown>[];
        addAll(rows);
      }

      // 仅有字段过滤（无自由文本）：按名称序直接取过滤集。
      if (!pq.text && (pq.kinds.length || pq.langs.length)) {
        const rows = rawDb
          .prepare(
            `SELECT id, name, qualified_name, kind, start_line, end_line, file_path FROM nodes
             WHERE 1=1${kindGate}${langGate} ORDER BY name LIMIT ?`,
          )
          .all(...kindParams, ...langParams, limit) as Record<string, unknown>[];
        addAll(rows);
      }

      let out = [...found.values()];
      if (pq.pathFilters.length) {
        out = out.filter((s) => pq.pathFilters.some((p) => s.filePath.toLowerCase().includes(p)));
      }
      if (pq.nameFilters.length) {
        out = out.filter((s) => pq.nameFilters.some((n) => s.name.toLowerCase().includes(n)));
      }
      return out.slice(0, limit);
    } catch (err) {
      log.debug({ err: String(err) }, "SQL 检索通道失败，回退内存扫描");
      return null;
    } finally {
      try {
        rawDb.close();
      } catch {
        /* 只读连接关闭失败可忽略 */
      }
    }
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

  /** 影响面：沿依赖边（calls/references/extends/instantiates…）反向 BFS，谁直接或间接依赖本符号。 */
  impact(projectId: string, projectRoot: string, id: string, depth: number): CgSymbolRow[] {
    const g = this.graph(projectId, projectRoot);
    if (!g) return [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    const result: CgSymbolRow[] = [];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const caller of g.depIn.get(cur) ?? []) {
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

/** 字段化查询解析（对齐库 query-parser）：kind:/lang:/path:/name: 提取为过滤器，其余为自由文本。 */
interface ParsedCgQuery {
  text: string;
  kinds: string[];
  langs: string[];
  pathFilters: string[];
  nameFilters: string[];
}

const CG_FIELD_KINDS = new Set([
  "function", "method", "class", "interface", "struct", "enum", "type", "variable", "constant", "field", "property", "route", "component", "module", "trait", "impl", "constructor", "record", "union", "namespace", "file", "import",
]);

function parseCgQuery(raw: string): ParsedCgQuery {
  const out: ParsedCgQuery = { text: "", kinds: [], langs: [], pathFilters: [], nameFilters: [] };
  const rest: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    const m = /^(kind|lang|language|path|name):(.*)$/i.exec(tok);
    if (!m) {
      rest.push(tok);
      continue;
    }
    const field = m[1]!.toLowerCase();
    const value = m[2]!.replace(/"/g, "").toLowerCase();
    if (!value) continue;
    if (field === "kind" && CG_FIELD_KINDS.has(value)) out.kinds.push(value);
    else if (field === "lang" || field === "language") out.langs.push(value);
    else if (field === "path") out.pathFilters.push(value);
    else if (field === "name") out.nameFilters.push(value);
    else rest.push(tok); // 未知前缀按普通词处理（如 "TODO:"）
  }
  out.text = rest.join(" ").trim();
  return out;
}

/** 自由文本 → FTS5 前缀查询（对齐库 searchNodesFTS 的清洗与转义）。 */
function toFtsQuery(text: string): string {
  return text
    .replace(/::/g, " ")
    .replace(/['"*():^]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !/^(AND|OR|NOT|NEAR)$/i.test(t))
    .map((t) => `"${t}"*`)
    .join(" OR ");
}

/** 段词检索的词干变体：复数去尾 s，提高 "users"→segment "user" 的命中率。 */
function segmentWordVariants(words: string[]): string[] {
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    if (w.length > 3 && w.endsWith("s")) out.add(w.slice(0, -1));
  }
  return [...out];
}

function mapNodeRow(r: Record<string, unknown>): CgSymbolRow {
  return {
    id: r.id as string,
    name: r.name as string,
    qualifiedName: r.qualified_name as string,
    kind: r.kind as string,
    line: r.start_line as number,
    endLine: r.end_line as number,
    filePath: r.file_path as string,
  };
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
