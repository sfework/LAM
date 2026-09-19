import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { normalizeProjectPath, deriveProjectName } from "../src/projects/normalize.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { runMigrations } from "../src/db/migrate.js";

function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  return raw;
}

describe("normalizeProjectPath", () => {
  it("大小写统一", () => {
    expect(normalizeProjectPath("D:\\Work\\Demo")).toBe("d:/work/demo");
    expect(normalizeProjectPath("d:/work/demo")).toBe("d:/work/demo");
  });
  it("去结尾斜杠（含多种分隔符）", () => {
    expect(normalizeProjectPath("d:\\work\\demo\\")).toBe("d:/work/demo");
    expect(normalizeProjectPath("d:/work/demo/")).toBe("d:/work/demo");
    expect(normalizeProjectPath("d:/work/demo///")).toBe("d:/work/demo");
  });
  it("同一性：多种写法归一为同一路径", () => {
    const a = normalizeProjectPath("D:\\Work\\Demo\\");
    const b = normalizeProjectPath("d:/work/demo");
    const c = normalizeProjectPath("d:\\\\work\\\\demo");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  it("盘符根保留唯一斜杠", () => {
    expect(normalizeProjectPath("e:\\")).toBe("e:/");
    expect(normalizeProjectPath("e:/")).toBe("e:/");
    expect(normalizeProjectPath("E:")).toBe("e:");
  });
  it("折叠重复分隔符", () => {
    expect(normalizeProjectPath("d:\\\\work\\\\\\\\demo")).toBe("d:/work/demo");
  });
  it("空/非法输入返回空串", () => {
    expect(normalizeProjectPath("")).toBe("");
    expect(normalizeProjectPath("   ")).toBe("");
    expect(normalizeProjectPath(undefined)).toBe("");
    expect(normalizeProjectPath(null)).toBe("");
  });
  it("trim 前后空白", () => {
    expect(normalizeProjectPath("  d:/work/demo  ")).toBe("d:/work/demo");
  });
  it("POSIX 绝对路径", () => {
    expect(normalizeProjectPath("/home/user/proj/")).toBe("/home/user/proj");
    expect(normalizeProjectPath("/")).toBe("/");
  });
  it("UNC 路径保留前导双斜杠", () => {
    expect(normalizeProjectPath("\\\\server\\share\\proj")).toBe("//server/share/proj");
    expect(normalizeProjectPath("\\\\SERVER\\share\\")).toBe("//server/share");
  });
});

describe("deriveProjectName", () => {
  it("取末段目录名", () => {
    expect(deriveProjectName("d:/work/demo")).toBe("demo");
    expect(deriveProjectName("/home/user/proj")).toBe("proj");
  });
  it("盘符根回退为驱动器标签", () => {
    expect(deriveProjectName("e:/")).toBe("e");
  });
  it("空路径返回空", () => {
    expect(deriveProjectName("")).toBe("");
  });
});

describe("ProjectRepo", () => {
  let raw: DatabaseSync;
  let repo: ProjectRepo;
  beforeEach(() => {
    raw = freshDb();
    repo = new ProjectRepo(raw);
  });

  it("首次登记创建项目", () => {
    const { project, revived } = repo.upsertOnRequest("D:\\Work\\Demo\\");
    expect(revived).toBe(false);
    expect(project.path).toBe("d:/work/demo");
    expect(project.name).toBe("demo");
    expect(project.deletedAt).toBeNull();
  });

  it("不同写法命中同一项目（不重复创建）", () => {
    const a = repo.upsertOnRequest("D:\\Work\\Demo");
    const b = repo.upsertOnRequest("d:/work/demo/");
    expect(b.project.id).toBe(a.project.id);
    expect(repo.list()).toHaveLength(1);
  });

  it("正常项目再次请求仅刷新活跃时间", () => {
    const a = repo.upsertOnRequest("d:/work/demo");
    const b = repo.upsertOnRequest("d:/work/demo");
    expect(b.revived).toBe(false);
    expect(b.project.id).toBe(a.project.id);
  });

  it("软删后再次请求级联恢复", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    // 造一条该项目的记忆 + project 知识
    const now = Date.now();
    raw.prepare("INSERT INTO mem_l1 (id,project_id,kind,content,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("m1", project.id, "fact", "x", 80, now, now);
    raw.prepare("INSERT INTO knowledge (id,title,description,body,scope,project_id,enabled,sort_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("k1", "t", "", "", "project", project.id, 1, 0, now);

    expect(repo.softDelete(project.id)).toBe(true);
    expect(repo.list()).toHaveLength(0);
    expect((raw.prepare("SELECT deleted_at FROM mem_l1 WHERE id='m1'").get() as { deleted_at: number }).deleted_at).not.toBeNull();
    expect((raw.prepare("SELECT deleted_at FROM knowledge WHERE id='k1'").get() as { deleted_at: number }).deleted_at).not.toBeNull();

    // 再次请求 → 恢复
    const { revived } = repo.upsertOnRequest("d:/work/demo");
    expect(revived).toBe(true);
    expect(repo.list()).toHaveLength(1);
    expect((raw.prepare("SELECT deleted_at FROM mem_l1 WHERE id='m1'").get() as { deleted_at: number | null }).deleted_at).toBeNull();
    expect((raw.prepare("SELECT deleted_at FROM knowledge WHERE id='k1'").get() as { deleted_at: number | null }).deleted_at).toBeNull();
  });

  it("global 知识不受项目软删级联影响", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    const now = Date.now();
    raw.prepare("INSERT INTO knowledge (id,title,description,body,scope,project_id,enabled,sort_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("kg", "global", "", "", "global", null, 1, 0, now);
    repo.softDelete(project.id);
    expect((raw.prepare("SELECT deleted_at FROM knowledge WHERE id='kg'").get() as { deleted_at: number | null }).deleted_at).toBeNull();
  });

  it("无效路径抛错", () => {
    expect(() => repo.upsertOnRequest("   ")).toThrow();
  });

  it("手动 restore 生效", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    repo.softDelete(project.id);
    expect(repo.restore(project.id)).toBe(true);
    expect(repo.list()).toHaveLength(1);
  });

  it("update 改名", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    const updated = repo.update(project.id, { name: "  DEMO 网关  " });
    expect(updated?.name).toBe("DEMO 网关");
    expect(updated?.path).toBe("d:/work/demo"); // 目录不变
  });

  it("update 换目录（规范化新路径）", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    const updated = repo.update(project.id, { path: "D:\\Work\\MOVED\\" });
    expect(updated?.path).toBe("d:/work/moved");
    expect(updated?.name).toBe("demo"); // 未传 name 不改
    // 旧路径可再次登记为新项目，新路径命中本项目
    expect(repo.findByPath("d:/work/demo")).toBeUndefined();
    expect(repo.findByPath("d:/work/moved")?.id).toBe(project.id);
  });

  it("update 同时改名与换目录", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    const updated = repo.update(project.id, { name: "renamed", path: "d:/work/new" });
    expect(updated?.name).toBe("renamed");
    expect(updated?.path).toBe("d:/work/new");
  });

  it("update 换目录撞车被拒（唯一键）", () => {
    const a = repo.upsertOnRequest("d:/work/a").project;
    repo.upsertOnRequest("d:/work/b");
    expect(() => repo.update(a.id, { path: "d:/work/b" })).toThrow(/占用/);
    // 失败后 a 未被改动
    expect(repo.findById(a.id)?.path).toBe("d:/work/a");
  });

  it("update 换到自身规范化等价路径不改键（幂等）", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    const updated = repo.update(project.id, { path: "D:\\Work\\Demo\\" });
    expect(updated?.path).toBe("d:/work/demo");
  });

  it("update 无字段抛错", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    expect(() => repo.update(project.id, {})).toThrow(/至少/);
  });

  it("update 无效新路径抛错", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    expect(() => repo.update(project.id, { path: "   " })).toThrow(/无效/);
  });

  it("update 不存在的 id 返回 undefined", () => {
    expect(repo.update("nope", { name: "x" })).toBeUndefined();
  });

  it("换目录保留按 project_id 关联的记忆", () => {
    const { project } = repo.upsertOnRequest("d:/work/demo");
    const now = Date.now();
    raw.prepare("INSERT INTO mem_l1 (id,project_id,kind,content,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("m1", project.id, "fact", "偏好 pnpm", 80, now, now);
    repo.update(project.id, { path: "d:/work/moved" });
    const rows = raw.prepare("SELECT project_id, deleted_at FROM mem_l1 WHERE id='m1'").get() as
      { project_id: string; deleted_at: number | null };
    expect(rows.project_id).toBe(project.id); // 记忆仍挂在同一 project_id
    expect(rows.deleted_at).toBeNull();       // 未被误删
  });
});
