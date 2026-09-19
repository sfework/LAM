/**
 * SQL 只读校验（移植自参考实现的 SqlTools.cs）。
 *
 * 规则：按分号拆分逐条校验，每条必须以 SELECT / WITH 开头，且不得含写操作关键字。
 * 校验前先规范化，使判定不受书写形式影响：
 * - 字符串字面量与引用标识符整体替换为空格——其中的关键字只是数据，不应触发拦截；
 * - 注释替换为空格（不可整体删除，否则用块注释切断关键字会粘连成一个新 token 而逃过检测）；
 * - 关键字按词边界匹配，不依赖两侧空格，故 `INSERT(`、换行分隔等写法同样被识别。
 *
 * 这是「防误用 + 防注入」的第一层；第二层是驱动侧只读连接（SQLite query_only pragma、
 * 各库的 statement timeout），见 service.ts。
 */

/** 允许作为语句开头的关键字：SELECT 查询，或 WITH 开头的 CTE 查询。 */
const ALLOWED_START_RE = /^\s*\(*\s*(?:SELECT|WITH)\b/i;

/**
 * 禁止出现的关键字。
 * `INTO` 同时堵住 `SELECT … INTO new_table`、`SELECT … INTO OUTFILE` 与 MySQL 的 `REPLACE INTO`；
 * 故 `REPLACE` 不单列（它是各库的标量函数，会误伤 `SELECT REPLACE(col,'a','b')`）。
 * `EXEC` 与 `EXECUTE` 需并列：词边界下前者不匹配后者。
 */
const BLOCKED_KEYWORD_RE =
  /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|CALL|VACUUM|ATTACH|DETACH|PRAGMA|INTO)\b/i;

/** 校验失败：消息即面向模型的最终文案。 */
export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

/**
 * 生成用于关键字校验的规范化文本（见文件头注释）。
 * 其余字符原样保留，供首关键字白名单与关键字黑名单匹配。
 */export function normalizeForValidation(sql: string): string {
  const out: string[] = [];
  let i = 0;
  const push = (s: string) => out.push(s);

  const skipQuoted = (open: string, close: string, doubled: boolean): void => {
    i++; // 跳过开引号
    while (i < sql.length) {
      if (sql[i] === close) {
        if (doubled && sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i++;
        break;
      }
      i++;
    }
  };

  while (i < sql.length) {
    const c = sql[i]!;
    // 行注释：-- 到行尾
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      push(" ");
      continue;
    }
    // 块注释：/* ... */
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, sql.length);
      push(" ");
      continue;
    }
    // 字符串字面量 '...'（'' 转义）
    if (c === "'") {
      skipQuoted("'", "'", true);
      push(" ");
      continue;
    }
    // 双引号标识符 "..."（"" 转义）
    if (c === '"') {
      skipQuoted('"', '"', true);
      push(" ");
      continue;
    }
    // 方括号 [...] 与反引号 `...` 标识符
    if (c === "[" || c === "`") {
      skipQuoted(c, c === "[" ? "]" : "`", false);
      push(" ");
      continue;
    }
    push(c);
    i++;
  }
  return out.join("");
}

/**
 * 按分号拆分为多条语句。拆分时保留字符串/标识符/注释原样，
 * 保证分号判定只作用于真实语法结构（字面量内的分号不误拆）。
 */
export function splitStatements(sql: string): string[] {
  const result: string[] = [];
  let current = "";
  let i = 0;

  const takeUntil = (pred: (ch: string) => boolean): void => {
    while (i < sql.length && !pred(sql[i]!)) {
      current += sql[i]!;
      i++;
    }
  };

  while (i < sql.length) {
    const c = sql[i]!;
    // 行注释
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        current += sql[i]!;
        i++;
      }
      continue;
    }
    // 块注释
    if (c === "/" && sql[i + 1] === "*") {
      current += sql[i]! + sql[i + 1]!;
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        current += sql[i]!;
        i++;
      }
      if (i < sql.length) {
        current += sql[i]! + sql[i + 1]!;
        i += 2;
      }
      continue;
    }
    // 字符串 / 双引号标识符（ doubled 转义）
    if (c === "'" || c === '"') {
      current += c;
      i++;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            current += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // 方括号 / 反引号标识符
    if (c === "[" || c === "`") {
      const close = c === "[" ? "]" : "`";
      current += c;
      i++;
      takeUntil((ch) => ch === close);
      if (i < sql.length) {
        current += sql[i]!;
        i++;
      }
      continue;
    }
    // 语句边界
    if (c === ";") {
      if (current.length > 0) result.push(current);
      current = "";
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (current.length > 0) result.push(current);
  return result.filter((s) => s.trim().length > 0);
}

/**
 * 只读校验：不通过则抛 {@link SqlGuardError}。
 * 允许单条 SELECT/WITH，或带结尾分号的单条语句；批处理（多条非空语句）拒绝。
 */
export function assertReadOnlySql(sqlQuery: string): void {
  if (!sqlQuery || !sqlQuery.trim()) throw new SqlGuardError("SQL 查询语句不能为空");

  const statements = splitStatements(sqlQuery);
  if (statements.length === 0) throw new SqlGuardError("未解析到有效的 SQL 语句");
  if (statements.length > 1) throw new SqlGuardError("不支持一次执行多条 SQL 语句");

  const normalized = normalizeForValidation(statements[0]!);
  if (!ALLOWED_START_RE.test(normalized)) {
    throw new SqlGuardError("只支持 SELECT 查询语句，不允许执行 INSERT、UPDATE、DELETE、DROP 等修改操作");
  }
  const blocked = BLOCKED_KEYWORD_RE.exec(normalized);
  if (blocked) throw new SqlGuardError(`SQL 语句中包含不允许的关键字: ${blocked[0]!.toUpperCase()}`);
}

/** 表名合法性校验（用于无法参数化的元数据查询，如 SQLite PRAGMA）。 */
export function assertSafeIdentifier(name: string, label = "表名"): string {
  const v = name.trim();
  // 允许 schema.table / db.schema.table 形式（各库元数据查询通用），段内限字母数字下划线与 $
  if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/.test(v)) {
    throw new SqlGuardError(`非法${label}: ${name}`);
  }
  return v;
}
