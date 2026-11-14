import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { HourlyRotatingWriter } from "./hourly-rotating.js";
import { localLogStamp } from "./localtime.js";
import { logsDir } from "./paths.js";

/**
 * 日志工厂。
 *
 * - pino 结构化日志，级别默认 info（LOG_LEVEL 可临时调 debug）。
 * - 落盘：{DATA_DIR}/Logs/{yyyy}/{MM}/{dd}/{HH}.txt，每小时一个文件（全项目唯一日志出口）。
 * - LOG_FORMAT=text（默认）：人读行；LOG_FORMAT=json：pino 原始 JSON 行。
 */

const LEVEL = process.env.LOG_LEVEL || "info";
const AS_TEXT = (process.env.LOG_FORMAT ?? "text") !== "json";

let sharedWriter: HourlyRotatingWriter | null = null;
function writer(): HourlyRotatingWriter {
  if (!sharedWriter) sharedWriter = new HourlyRotatingWriter(logsDir());
  return sharedWriter;
}

/** 创建带模块名的 logger。@param module 模块标识，如 "gateway" / "memory" / "db" */
export function createLogger(module: string): Logger {
  return pino(
    {
      level: LEVEL,
      base: undefined, // 去掉 hostname/pid 等默认字段
      timestamp: () => `,"ts":"${localLogStamp()}"`,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ module }),
    },
    // 自定义格式化流：把 pino 输出的 JSON 行转成人读行再落盘（LOG_FORMAT=json 时原样输出）
    new Writable({
      write(chunk, _enc, cb) {
        const line = chunk.toString();
        writer().writeLine(AS_TEXT ? formatLine(line) : line);
        cb();
      },
    }),
  );
}

/** 将 pino 的 JSON 行转为 `时间戳 [LEVEL] [模块] 消息 {字段}`。 */
export function formatLine(jsonLine: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonLine);
  } catch {
    return jsonLine; // 非 JSON 原样输出
  }
  const ts = (obj.ts as string) ?? localLogStamp();
  const level = String(obj.level ?? "info").toUpperCase();
  const module = (obj.module as string) ?? "-";
  const msg = (obj.msg as string) ?? "";
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "ts" || k === "level" || k === "module" || k === "msg") continue;
    rest[k] = v;
  }
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${ts} [${level}] [${module}] ${msg}${extra}`;
}
