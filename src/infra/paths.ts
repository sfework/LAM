import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 运行时路径与端口解析。
 *
 * DESIGN.md 约定：本项目不使用配置文件，业务配置全存 DB；
 * 仅 PORT / DATA_DIR / FRONTEND_DIST 允许通过环境变量指定（进程启动层面的最小必要项）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** 应用运行目录（进程 cwd），日志写到 {DATA_DIR}/Logs。 */
export function dataDir(): string {
  return process.env.DATA_DIR || path.resolve(process.cwd(), "data");
}

/** 主服务监听端口，默认 8790（避开参考实现 TencentDB-Agent-Memory 的常用端口段）。 */
export function listenPort(): number {
  const raw = process.env.PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8790;
}

/** 监听地址，本地部署固定 localhost。 */
export function listenHost(): string {
  return "localhost";
}

/** SQLite 主库文件路径。 */
export function dbFilePath(): string {
  return path.join(dataDir(), "gateway.db");
}

/**
 * CodeGraph 索引存储根（vendored @colbymchenry/codegraph 的 CODEGRAPH_STORE_ROOT）。
 * 每个被索引项目的图谱落到 {DATA_DIR}/codegraph/{basename}-{hash}/codegraph.db，
 * 与被扫描项目目录彻底隔离（避免污染目标仓库 + Windows watcher EBUSY）。
 */
export function codegraphStoreDir(): string {
  return path.join(dataDir(), "codegraph");
}

/** 日志根目录（{DATA_DIR}/Logs，其下按 yyyy/MM/dd/HH.txt 分小时存放）。 */
export function logsDir(): string {
  return path.join(dataDir(), "Logs");
}

/**
 * 前端构建产物目录（DESIGN 决策 46：SPA 与后端同域同端口，由本服务直接托管）。
 *
 * 默认按代码位置回溯到仓库根的 `frontend/dist`，因此与进程启动目录（cwd）无关；
 * 源码运行（src/infra）与打包运行（dist/server.js）层级不同，逐个探测。
 * 环境变量 FRONTEND_DIST 可显式指定（如部署到别处）。
 */
export function frontendDistDir(): string {
  const override = process.env.FRONTEND_DIST;
  if (override) return path.resolve(override);
  for (const up of ["../..", "../../..", "../../../.."]) {
    const dir = path.resolve(here, up, "frontend", "dist");
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return path.resolve(here, "../..", "frontend", "dist");
}
