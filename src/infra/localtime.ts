/**
 * 本地时区时间格式化（全项目固定本地时区，含入库与显示）。
 *
 * `toISOString()` 输出 UTC，与本机直觉不符，会让日志归档目录、
 * 提示词时间戳按 UTC 切分。统一改用本模块的本地格式化。
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地 `yyyy-MM-dd`（日期选择/日志目录用）。 */
export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地 `yyyy-MM-dd HH:mm:ss`（LLM 提示词时间戳、健康检查等可读时间）。 */
export function localDateTimeStr(d: Date = new Date()): string {
  return `${localDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 日志行时间戳 `yyyy-MM-dd HH:mm:ss.SSS`（本地，无 Z 后缀——入库/落盘统一本地时区）。 */
export function localLogStamp(d: Date = new Date()): string {
  return `${localDateTimeStr(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
