import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { logsDir } from "../infra/paths.js";
import { postRoutes, requireStr, badRequest, notFound } from "./rest.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("api:logs");

/**
 * /api/logs —— 运行日志查看（DESIGN §5 日志方案、决策 53）。
 * 日志按 {DATA_DIR}/Logs/{yyyy}/{MM}/{dd}/{HH}.txt 每小时一个文件（HourlyRotatingWriter）。
 * POST /list    {date:"yyyy-MM-dd"} → 该日期下的小时日志文件（按小时升序，含大小/修改时间）。
 * POST /get     {date,name} → 读取日志文件文本内容（只读查看）。
 * POST /delete  {date,name} → 删除对应日志文件（纯 IO 删除，不落库）。
 * 安全：date 必须是 yyyy-MM-dd、name 必须是 HH.txt 纯文件名，路径解析后须仍在 Logs 目录内（防穿越）。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^\d{2}\.txt$/;

interface LogFile {
  name: string;
  hour: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** 校验并解析日志文件绝对路径；非法或越界抛 400。 */
function resolveLogFile(date: string, name: string): string {
  if (!DATE_RE.test(date)) badRequest("date 须为 yyyy-MM-dd");
  if (!NAME_RE.test(name) || name !== path.basename(name)) badRequest("非法日志文件名");
  const [yyyy, MM, dd] = date.split("-") as [string, string, string];
  const full = path.join(logsDir(), yyyy, MM, dd, name);
  // 防穿越：解析后必须仍位于 Logs 目录内。
  const root = path.resolve(logsDir());
  if (!path.resolve(full).startsWith(root + path.sep)) badRequest("非法日志路径");
  return full;
}

/** 读取日期目录下的 .txt 日志，按小时升序，附文件大小/修改时间。 */
function readDayFiles(date: string): LogFile[] {
  if (!DATE_RE.test(date)) badRequest("date 须为 yyyy-MM-dd");
  const [yyyy, MM, dd] = date.split("-") as [string, string, string];
  const dir = path.join(logsDir(), yyyy, MM, dd);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt"));
  } catch {
    return []; // 目录不存在 → 空
  }
  return names
    .map((n) => {
      const full = path.join(dir, n);
      try {
        const st = statSync(full);
        return { name: n, hour: n.replace(/\.txt$/, ""), path: full, sizeBytes: st.size, modifiedAt: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is LogFile => !!x)
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

export function createLogsRouter() {
  return postRoutes({
    "/list": (b) => {
      const date = requireStr(b, "date");
      return { date, files: readDayFiles(date) };
    },
    "/get": (b) => {
      const date = requireStr(b, "date");
      const name = requireStr(b, "name");
      const full = resolveLogFile(date, name);
      if (!existsSync(full)) notFound("日志文件不存在");
      const content = readFileSync(full, "utf8");
      return { date, name, content, sizeBytes: Buffer.byteLength(content, "utf8") };
    },
    "/delete": (b) => {
      const date = requireStr(b, "date");
      const name = requireStr(b, "name");
      const full = resolveLogFile(date, name);
      if (!existsSync(full)) notFound("日志文件不存在");
      try {
        rmSync(full);
      } catch (err) {
        log.error({ err: String(err), full }, "日志删除失败");
        badRequest(`删除失败: ${String(err)}`);
      }
      log.info({ full }, "日志文件已删除");
      return { deleted: true };
    },
  });
}
