/**
 * 项目路径规范化（DESIGN §2.2）。
 *
 * 规则：
 *  - 全转小写（Windows 大小写不敏感）；
 *  - 分隔符统一为 `/`；
 *  - 去除结尾多余斜杠；盘符根（`e:/`）与 UNC 根（`//server/` 的宿主部分）保留必要斜杠；
 *  - 在网关注入、项目登记、MCP 工具入参三个入口共用。
 *
 * 空/非法输入返回 ""（调用方据此拒绝登记）。
 */
export function normalizeProjectPath(input: string | undefined | null): string {
  if (!input) return "";
  let p = input.trim();
  if (!p) return "";

  // 统一分隔符
  p = p.replace(/\\/g, "/");
  // 折叠重复斜杠（保留开头的 UNC `//` 与盘符 `x:/` 语义，稍后单独处理）
  p = p.replace(/\/{2,}/g, "/");

  // 处理 UNC：\\server\share → //server/share（开头双斜杠有意义，需保留）
  const isUnc = input.trimStart().startsWith("\\\\");

  // 转小写
  p = p.toLowerCase();

  // 去结尾斜杠，但至少保留一个字符（UNC 根 / 盘符根在内部单独保护）
  p = stripTrailingSlashes(p, isUnc);

  return p;
}

function stripTrailingSlashes(p: string, isUnc: boolean): string {
  // 盘符根：如 "e:/" → 保留 "e:/"
  if (/^[a-z]:\/$/.test(p)) return p;
  // 普通路径去尾斜杠
  let out = p.replace(/\/+$/, "");
  if (isUnc) {
    // UNC 根 "//" 规范化为 "//"（保留宿主定位）
    if (out === "" || out === "/") return "//";
    // 折叠后前导可能只剩一个 /，统一补成 //
    if (out.startsWith("//")) return out;
    if (out.startsWith("/")) out = "/" + out;
    return out;
  }
  // 非 UNC：极端情况（输入仅斜杠）归一为 "/"
  if (out === "") return "/";
  return out;
}

/**
 * 从规范化路径推断项目名（末段目录名）。
 * 盘符根 / 根路径无末段时回退为驱动器标签或 "root"。
 */
export function deriveProjectName(normalizedPath: string): string {
  if (!normalizedPath) return "";
  const parts = normalizedPath.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last) {
    // 盘符根末段形如 "e:"，去掉冒号作为项目名
    return last.replace(/:$/, "");
  }
  // 形如 "e:/" → "e"
  const drive = normalizedPath.match(/^([a-z]):\/?$/);
  if (drive) return drive[1] as string;
  return "root";
}
