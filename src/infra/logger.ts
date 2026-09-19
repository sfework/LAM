import { Writable } from "node:stream";
import path from "node:path";
import pino, { type Logger } from "pino";
import { HourlyRotatingWriter } from "./hourly-rotating.js";
import { localLogStamp } from "./localtime.js";

/**
 * 日志工厂（DESIGN.md §5 日志方案）。
 *
 * - pino 结构化日志，级别默认 info（LOG_LEVEL 可临时调 debug）。
 * - 落盘：{dataRoot}/Logs/{yyyy}/{MM}/{dd}/{HH}.txt，每小时一个文件。
 * - 行格式：`时间戳 [LEVEL] [模块] 消息 {结构化字段}`。
 *
 * 说明：主服务与 MCP 薄壳各自调用 createLogger，写入同一 Logs 目录下的
 * 小时文件（追加模式，无冲突）。
 */

/** 允许被日志记录的环境变量仅这两个（其余配置全 DB）。 */
function resolveLogRoot(): string {
  const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
  return path.join(dataDir, "Logs");
}

const LEVEL = process.env.LOG_LEVEL || "info";

/** 把 HourlyRotatingWriter 包装成 Node Writable，供 pino 作为目标流。 */
function buildSinkStream(root: string): Writable {
  const writer = new HourlyRotatingWriter(root);
  return new Writable({
    write(chunk, _enc, cb) {
      writer.writeLine(chunk.toString());
      cb();
    },
  });
}

let sharedRoot: string | null = null;
function logRoot(): string {
  if (!sharedRoot) sharedRoot = resolveLogRoot();
  return sharedRoot;
}

/**
 * 创建带模块名的 logger。
 * @param module 模块标识，如 "gateway" / "memory" / "codegraph"
 */
export function createLogger(module: string): Logger {
  const sink = buildSinkStream(logRoot());

  return pino(
    {
      level: LEVEL,
      base: undefined, // 去掉 hostname/pid 等默认字段
      timestamp: () => `,"ts":"${localLogStamp()}"`,
      formatters: {
        level: (label) => ({ level: label }),
      },
      // 用 prettifier 之外的方式：直接自定义 transport 不可行（无 worker），
      // 因此这里用 mixin 注入 module，并在下面通过自定义 stream 前做格式化。
      mixin: () => ({ module }),
    },
    // 自定义格式化流：把 pino 输出的 JSON 行转成人读行
    new Writable({
      write(chunk, _enc, cb) {
        const line = chunk.toString();
        sink.write(formatLine(line));
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
