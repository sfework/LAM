import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMigrations } from "../src/db/migrate.js";
import { ModelRepo } from "../src/models/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { CodeGraphService } from "../src/codegraph/service.js";

/**
 * CodeGraph（决策 67）：vendored 库 + 外置存储 + 对话触发 + 只读消费。
 * 用临时 fixture 项目跑真实管线：init→indexAll→reader/query/graph。
 */

const tmp = path.join(os.tmpdir(), `lam-cg-test-${Date.now()}`);
const dataDir = path.join(tmp, "data");
const projDir = path.join(tmp, "proj");

beforeAll(() => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(projDir, "src"), { recursive: true });
  process.env.DATA_DIR = dataDir;
  // C# 注入模式：Controller 主构造函数参数调 Service（vendored 库应连上跨文件调用边）
  writeFileSync(
    path.join(projDir, "src", "Services.cs"),
    `namespace S {\n  public class CustomerServices {\n    public string List(string q) { return q; }\n  }\n}\n`,
  );
  writeFileSync(
    path.join(projDir, "src", "Controller.cs"),
    `namespace S {\n  public class CustomerController(CustomerServices customerServices) {\n    public string Get(string q) { return customerServices.List(q); }\n  }\n}\n`,
  );
  writeFileSync(
    path.join(projDir, "src", "util.ts"),
    `export function helper(): number { return 42; }\nexport function main(): number { return helper() + 1; }\n`,
  );
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

function fresh() {
  const raw = new DatabaseSync(":memory:");
  runMigrations(raw);
  const models = new ModelRepo(raw);
  const settings = new SettingsService(raw, models);
  settings.init();
  const projects = new ProjectRepo(raw);
  const { project } = projects.upsertOnRequest(projDir);
  const cg = new CodeGraphService(raw, settings, projects);
  return { raw, settings, projects, cg, projectId: project.id };
}

async function waitReady(cg: CodeGraphService, projectId: string, timeoutMs = 60_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = cg.status.get(projectId);
    if (st && (st.status === "ready" || st.status === "failed")) return st.status;
    await new Promise((r) => setTimeout(r, 250));
  }
  return "timeout";
}

describe("codegraph (vendored)", () => {
  it("激活 → 全量首建 ready；索引落外置库且不污染项目目录", async () => {
    const { cg, projectId } = fresh();
    cg.activate(projectId, projDir);
    const status = await waitReady(cg, projectId);
    expect(status, cg.status.get(projectId)?.lastError).toBe("ready");

    // 外置库存在
    const storeDir = path.join(dataDir, "codegraph");
    const dirs = readdirSync(storeDir);
    expect(dirs.length).toBeGreaterThan(0);
    expect(existsSync(path.join(storeDir, dirs[0]!, "codegraph.db"))).toBe(true);
    // 项目目录零污染：不出现 .codegraph
    expect(existsSync(path.join(projDir, ".codegraph"))).toBe(false);
    await cg.stop();
  }, 90_000);

  it("query：search/node/callers/callees 形状与 C# 注入跨文件边", async () => {
    const { cg, projectId } = fresh();
    cg.activate(projectId, projDir);
    expect(await waitReady(cg, projectId)).toBe("ready");

    const hits = cg.query.search(projectId, "List");
    expect(hits.status).toBe("ready");
    const list = (hits.data as { id: string; qualifiedName: string }[]).find((h) => h.qualifiedName.endsWith("::List"));
    expect(list).toBeTruthy();

    const node = cg.query.node(projectId, { id: list!.id });
    expect(node.status).toBe("ready");
    const detail = node.data as { callers: { qualifiedName: string }[]; callees: unknown[] };
    // 关键回归：Controller::Get → Services::List 跨文件注入边（自研版曾丢失的模式）
    expect(detail.callers.some((c) => c.qualifiedName.includes("CustomerController::Get"))).toBe(true);

    const callees = cg.query.callees(projectId, { name: "Get" });
    expect(callees.status).toBe("ready");
    const data = callees.data as { callees: { qualifiedName: string }[] };
    expect(data.callees.some((c) => c.qualifiedName.includes("CustomerServices::List"))).toBe(true);
    await cg.stop();
  }, 90_000);

  it("graph：节点+calls 边可渲染；TS helper 边存在", async () => {
    const { cg, projectId } = fresh();
    cg.activate(projectId, projDir);
    expect(await waitReady(cg, projectId)).toBe("ready");
    const g = cg.graph(projectId);
    expect(g.status).toBe("ready");
    expect(g.nodes.length).toBeGreaterThan(3);
    expect(g.edges.length).toBeGreaterThan(1);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const mainEdge = g.edges.find((e) => byId.get(e.from)?.qualifiedName.endsWith("main") && byId.get(e.to)?.qualifiedName.endsWith("helper"));
    expect(mainEdge).toBeTruthy();
    await cg.stop();
  }, 90_000);

  it("onTurn：达阈值触发增量 sync（ready 后仍可再跑）", async () => {
    const { cg, settings, projectId } = fresh();
    settings.set("codegraph_reindex_every_conversations", "1");
    cg.activate(projectId, projDir);
    expect(await waitReady(cg, projectId)).toBe("ready");
    // 追加新文件 → 一轮对话应触发 sync 收录
    writeFileSync(path.join(projDir, "src", "extra.ts"), `export function extraSymbol() { return 1; }\n`);
    cg.onTurn(projectId, projDir);
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const r = cg.query.search(projectId, "extraSymbol");
      if (r.status === "ready" && (r.data as unknown[]).length > 0) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const found = cg.query.search(projectId, "extraSymbol");
    expect((found.data as { name: string }[]).some((s) => s.name === "extraSymbol")).toBe(true);
    await cg.stop();
  }, 120_000);

  it("rebuild：强制全量重建仍回到 ready", async () => {
    const { cg, projectId } = fresh();
    cg.activate(projectId, projDir);
    expect(await waitReady(cg, projectId)).toBe("ready");
    expect(cg.rebuild(projectId)).toBe(true);
    expect(await waitReady(cg, projectId)).toBe("ready");
    await cg.stop();
  }, 120_000);

  it("enabled=false：activate/onTurn 均不触发", async () => {
    const { cg, settings, projectId } = fresh();
    settings.set("codegraph_enabled", "false");
    cg.activate(projectId, projDir);
    cg.onTurn(projectId, projDir);
    await new Promise((r) => setTimeout(r, 300));
    expect(cg.status.get(projectId)).toBeUndefined();
    await cg.stop();
  });
});
