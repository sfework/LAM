/**
 * 本地时区时间格式化（DESIGN 决策 56：全项目固定本地时区，含入库与显示）。
 *
 * 背景：`toISOString()` 输出 UTC（带 Z），与本机（+08:00）相差 8 小时，
 * 会让日志文件名/目录、备份文件名、提示词里的时间戳按 UTC 归档，与用户直觉不符。
 * 统一改用本模块的本地格式化。
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

/** 本地文件名安全时间戳 `yyyy-MM-dd_HH-mm-ss`（备份文件名，不含 : 与 .）。 */
export function localStampForFile(d: Date = new Date()): string {
  return `${localDateStr(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 日志行时间戳 `yyyy-MM-dd HH:mm:ss.SSS`（本地，无 Z 后缀——入库/落盘统一本地时区）。 */
export function localLogStamp(d: Date = new Date()): string {
  return `${localDateTimeStr(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
