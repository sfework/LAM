import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { codegraphStoreDir } from "../infra/paths.js";

/**
 * vendored @colbymchenry/codegraph（fork 于 ./codegraph，LAM 补丁：CODEGRAPH_STORE_ROOT
 * 把每项目索引外置到 {DATA_DIR}/codegraph/<name>-<hash8>/，DESIGN 决策 67）。
 *
 * 该库是 CJS（tsc 产物 dist/index.js），本服务是 ESM——经 createRequire 同步加载；
 * 产物路径按代码位置回溯探测（源码 src/codegraph 与打包 dist 层级不同），与 frontendDistDir 同款策略。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);

/** 库入口候选定位（tsup/tsc 产物：codegraph/dist/index.js）。 */
function libEntry(): string {
  for (const up of ["..", "../..", "../../..", "../../../.."]) {
    const p = path.resolve(here, up, "codegraph", "dist", "index.js");
    if (existsSync(p)) return p;
  }
  throw new Error("未找到 vendored codegraph 构建产物（codegraph/dist/index.js），请先在 codegraph/ 目录执行 npm run build:lib");
}

// ── 库类型（仅声明本项目消费面，避免深引 d.ts）──

export interface LibNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
}

export interface LibStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
}

export interface LibIndexResult {
  filesIndexed?: number;
  nodesCreated?: number;
  edgesCreated?: number;
  durationMs?: number;
}

export interface LibSyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
}

/** vendored CodeGraph 实例（消费面子集）。 */
export interface CodeGraphInstance {
  indexAll(): Promise<LibIndexResult>;
  sync(): Promise<LibSyncResult>;
  close(): void;
  getStats(): LibStats;
  getProjectRoot(): string;
  isIndexing(): boolean;
}

interface CodeGraphClass {
  init(projectRoot: string, options?: { index?: boolean }): Promise<CodeGraphInstance>;
  open(projectRoot: string, options?: { sync?: boolean; readOnly?: boolean }): Promise<CodeGraphInstance>;
  /** 删除旧库并重建空库（全量重建入口，等价 CLI `codegraph index`）。 */
  recreate(projectRoot: string): Promise<CodeGraphInstance>;
  isInitialized(projectRoot: string): boolean;
}

interface CodeGraphModule {
  default: CodeGraphClass;
  /** 项目索引库文件路径（受 CODEGRAPH_STORE_ROOT 重定向）。 */
  getDatabasePath(projectRoot: string): string;
}

let cached: CodeGraphModule | null = null;

/** 加载 vendored 库（首次调用时设环境变量并 require，幂等）。 */
export function codegraphLib(): CodeGraphModule {
  if (cached) return cached;
  const storeRoot = codegraphStoreDir();
  mkdirSync(storeRoot, { recursive: true });
  // 外置存储根：库内 getCodeGraphDir(projectRoot) → {STORE_ROOT}/{name}-{hash8}
  process.env.CODEGRAPH_STORE_ROOT = storeRoot;
  // 本地个人项目，遥测一律关闭（库默认开启）
  if (!process.env.CODEGRAPH_TELEMETRY) process.env.CODEGRAPH_TELEMETRY = "0";
  cached = requireCjs(libEntry()) as CodeGraphModule;
  return cached;
}

/** 某项目根对应的索引库文件路径（不存在 = 未初始化）。 */
export function libDatabasePath(projectRoot: string): string {
  return codegraphLib().getDatabasePath(projectRoot);
}

/** 某项目是否已有索引库。 */
export function libIsInitialized(projectRoot: string): boolean {
  return codegraphLib().default.isInitialized(projectRoot);
}
