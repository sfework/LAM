import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertReadOnlySql, normalizeForValidation, splitStatements, SqlGuardError } from "../src/sql/guard.js";
import { normalizeValue, parseKeyValue, resolveSqliteLocation } from "../src/sql/drivers.js";
import { SqlService, SqlError } from "../src/sql/service.js";

/**
 * SQL 只读工具（移植自 C# SqlTools.cs）：guard 校验规则 + 值归一化 + SQLite 端到端。
 */

describe("assertReadOnlySql", () => {
  it("放行 SELECT / WITH / 带结尾分号", () => {
    expect(() => assertReadOnlySql("SELECT 1")).not.toThrow();
    expect(() => assertReadOnlySql("select id from t where name='x';")).not.toThrow();
    expect(() => assertReadOnlySql("WITH c AS (SELECT 1 AS x) SELECT * FROM c")).not.toThrow();
    expect(() => assertReadOnlySql("  (SELECT 1)  ")).not.toThrow();
  });

  it("拒绝空语句与非查询开头", () => {
    expect(() => assertReadOnlySql("")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySql("   ")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySql("-- 只有注释")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySql("UPDATE t SET a=1")).toThrow(SqlGuardError);
    expect(() => assertReadOnlySql("EXPLAIN SELECT 1")).toThrow(SqlGuardError);
  });

  it("拒绝写操作关键字（含无空格/换行/括号形式）", () => {
    expect(() => assertReadOnlySql("SELECT 1 UNION DELETE FROM t")).toThrow(/DELETE/);
    expect(() => assertReadOnlySql("SELECT\n*\nFROM t\nDROP TABLE x")).toThrow();
    expect(() => assertReadOnlySql("SELECT drop(1)")).toThrow(/DROP/);
    expect(() => assertReadOnlySql("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toThrow(/INSERT/);
    expect(() => assertReadOnlySql("SELECT * FROM t INTO OUTFILE '/tmp/a'")).toThrow(/INTO/);
  });

  it("字符串/标识符中的关键字不误伤", () => {
    expect(() => assertReadOnlySql("SELECT 'INSERT INTO x' AS a, \"delete\" AS b FROM t")).not.toThrow();
    expect(() => assertReadOnlySql("SELECT REPLACE(name,'a','b') FROM t")).not.toThrow();
    expect(() => assertReadOnlySql("SELECT [drop], `update` FROM t")).not.toThrow();
  });

  it("注释不能切断关键字逃过检测", () => {
    // 注释替换为空格（而非删除），否则 INSERT/**/INTO 会粘成 INSERTINTO 逃过词边界匹配
    expect(() => assertReadOnlySql("INSERT/**/SELECT 1")).toThrow(/INSERT/);
    expect(() => assertReadOnlySql("SELECT/**/DROP FROM t")).toThrow(/DROP/);
    expect(() => assertReadOnlySql("SELECT a-- x\n, 1 FROM t")).not.toThrow();
  });

  it("拒绝批处理多条语句", () => {
    expect(() => assertReadOnlySql("SELECT 1; DROP TABLE t")).toThrow(/多条/);
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(/多条/);
  });

  it("字面量内的分号不误拆", () => {
    expect(() => assertReadOnlySql("SELECT 'a;b' AS x")).not.toThrow();
    expect(splitStatements("SELECT 'a;b' FROM t WHERE c='x;y'; SELECT 1")).toHaveLength(2);
  });

  it("normalizeForValidation 把注释/字面量变空格、保留结构", () => {
    const n = normalizeForValidation("SELECT a -- x\nFROM t /* y */ WHERE b='INSERT'");
    expect(n).toContain("SELECT a");
    expect(n).toContain("FROM t");
    expect(n).not.toContain("INSERT");
    expect(n).not.toContain("--");
  });
});

describe("连接串与值归一化", () => {
  it("parseKeyValue 大小写不敏感、去引号、引号内分号不算分隔符", () => {
    const m = parseKeyValue("Server=localhost; Database='my db'; Pwd=\"p;1\"; Encrypt=true");
    expect(m.get("server")).toBe("localhost");
    expect(m.get("database")).toBe("my db");
    expect(m.get("pwd")).toBe("p;1");
    expect(m.get("encrypt")).toBe("true");
  });

  it("resolveSqliteLocation 支持路径 / Data Source / file URI / :memory:", () => {
    expect(resolveSqliteLocation("e:/d/a.db")).toBe("e:/d/a.db");
    expect(resolveSqliteLocation("Data Source=e:/d/a.db;")).toBe("e:/d/a.db");
    expect(resolveSqliteLocation("file:e:/d/a.db?mode=ro")).toBe("file:e:/d/a.db?mode=ro");
    expect(resolveSqliteLocation(":memory:")).toBe(":memory:");
    expect(() => resolveSqliteLocation("Foo=bar")).toThrow(/Data Source/);
  });

  it("normalizeValue：Date→本地字符串、BigInt→安全数/字符串、二进制→base64", () => {
    expect(normalizeValue(new Date(2026, 8, 18, 9, 8, 7))).toBe("2026-09-18 09:08:07");
    expect(normalizeValue(42n)).toBe(42);
    expect(normalizeValue(9007199254740993n)).toBe("9007199254740993");
    expect(normalizeValue(Buffer.from("ab"))).toBe(Buffer.from("ab").toString("base64"));
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue({ a: new Date(2026, 0, 2, 3, 4, 5) })).toEqual({ a: "2026-01-02 03:04:05" });
  });
});

describe("SqlService（SQLite 端到端）", () => {
  let dir: string;
  let file: string;
  const svc = new SqlService({ maxRows: () => 3 });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lam-sql-"));
    file = path.join(dir, "app.db");
    const db = new DatabaseSync(file);
    db.exec(
      `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, created_at TEXT);
       CREATE VIEW v_users AS SELECT id, name FROM users;
       INSERT INTO users (id, name, score, created_at) VALUES
         (1,'alice',1.5,'2026-01-01 00:00:00'),
         (2,'bob',2.5,'2026-01-02 00:00:00'),
         (3,'carol',3.5,'2026-01-03 00:00:00'),
         (4,'dave',4.5,'2026-01-04 00:00:00');`,
    );
    db.close();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("query 返回行数组与列值", async () => {
    const r = await svc.query("sqlite", file, "SELECT id, name FROM users WHERE id <= 2 ORDER BY id");
    expect(r.rows).toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("超行数上限截断并提示", async () => {
    const r = await svc.query("sqlite", file, "SELECT name FROM users ORDER BY id");
    expect(r.rows).toHaveLength(3);
    expect(r.rowCount).toBe(4);
    expect(r.truncated).toBe(true);
    expect(r.maxRows).toBe(3);
  });

  it("写操作被 guard 拒绝（错误文案原样透出）", async () => {
    await expect(svc.query("sqlite", file, "DELETE FROM users")).rejects.toThrow(SqlError);
    await expect(svc.query("sqlite", file, "DELETE FROM users")).rejects.toThrow(/只支持 SELECT/);
    await expect(svc.query("sqlite", file, "SELECT 1; SELECT 2")).rejects.toThrow(/多条/);
  });

  it("驱动错误带「查询失败：」前缀", async () => {
    await expect(svc.query("sqlite", file, "SELECT * FROM nope")).rejects.toThrow(/查询失败：/);
  });

  it("只读连接：即使绕过 guard 也无法写入", async () => {
    // 直接以只读方式打开同一文件验证第二层防护（guard 之外的兜底）
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(() => db.exec("INSERT INTO users (name) VALUES ('x')")).toThrow();
    } finally {
      db.close();
    }
  });

  it("listTables 列表/视图，支持关键字过滤", async () => {
    const all = await svc.listTables("sqlite", file);
    expect(all.map((t) => (t as { name: string }).name)).toEqual(["users", "v_users"]);
    const filtered = await svc.listTables("sqlite", file, "v_");
    expect(filtered).toEqual([{ name: "v_users", type: "view" }]);
  });

  it("describeTable 返回列结构与主键标记", async () => {
    const cols = (await svc.describeTable("sqlite", file, "users")) as {
      name: string;
      type: string;
      nullable: boolean;
      primaryKey: boolean;
    }[];
    expect(cols.map((c) => c.name)).toEqual(["id", "name", "score", "created_at"]);
    expect(cols[0]).toMatchObject({ name: "id", type: "INTEGER", nullable: true, primaryKey: true });
    expect(cols[1]).toMatchObject({ name: "name", nullable: false, primaryKey: false });
  });

  it("非法表名被拒", async () => {
    await expect(svc.describeTable("sqlite", file, "users; DROP TABLE t")).rejects.toThrow(/非法表名/);
  });

  it("库文件不存在 → 可读错误文案，且不创建文件", async () => {
    const missing = path.join(dir, "missing.db");
    const msg = await new SqlService().query("sqlite", missing, "SELECT 1").then(
      () => null,
      (e: Error) => e.message,
    );
    expect(msg).toMatch(/不存在/);
    expect(existsSync(missing)).toBe(false);
  });
});
