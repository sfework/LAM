import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

/**
 * 小时滚动日志写入器。
 *
 * 路径规则（DESIGN.md §5 日志方案）：{root}/{yyyy}/{MM}/{dd}/{HH}.txt
 * 每小时自动切换到新文件；跨小时边界由写入侧惰性判断。
 */

/** 计算给定时间对应的日志文件路径（不创建目录）。 */
export function hourlyFilePath(root: string, d: Date): string {
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  return path.join(root, yyyy, MM, dd, `${HH}.txt`);
}

/** 小时粒度 key，如 "2026-09-17T14"。 */
function hourKey(d: Date): string {
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd}T${HH}`;
}

export class HourlyRotatingWriter {
  private stream: WriteStream | null = null;
  private currentKey = "";
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** 追加一行（自动补换行符），按需切换小时文件。 */
  writeLine(line: string): void {
    const now = new Date();
    const key = hourKey(now);
    if (key !== this.currentKey || this.stream === null) {
      this.stream?.end();
      const file = hourlyFilePath(this.root, now);
      mkdirSync(path.dirname(file), { recursive: true });
      this.stream = createWriteStream(file, { flags: "a" });
      this.currentKey = key;
    }
    this.stream.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
    this.currentKey = "";
  }
}
