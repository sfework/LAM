import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 运行时路径与端口解析。
 *
 * 约定：本项目不使用配置文件，业务配置全存 DB；
 * 仅 PORT / DATA_DIR / FRONTEND_DIST 等进程启动层面最小必要项允许通过环境变量指定。
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** 数据根目录，日志写到 {DATA_DIR}/Logs。 */
export function dataDir(): string {
  return process.env.DATA_DIR || path.resolve(process.cwd(), "data");
}

/** 主服务监听端口，默认 8790。 */
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
  return path.join(dataDir(), "nlam.db");
}

/** 日志根目录（{DATA_DIR}/Logs，其下按 yyyy/MM/dd/HH.txt 分小时存放）。 */
export function logsDir(): string {
  return path.join(dataDir(), "Logs");
}

/**
 * 前端构建产物目录：SPA 与后端同域同端口，由本服务直接托管。
 *
 * 默认按代码位置回溯到仓库根的 `frontend/dist`，与进程启动目录（cwd）无关；
 * 源码运行与打包运行层级不同，逐个探测。环境变量 FRONTEND_DIST 可显式指定。
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
