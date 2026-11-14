import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { runMigrations } from "../src/db/migrate.js";
import { ensureFtsTable } from "../src/db/fts.js";
import { ProjectRepo } from "../src/projects/repo.js";
import { AssetsRepo } from "../src/assets/repo.js";
import { MemoryRepo } from "../src/memory/memory-repo.js";
import { ProfileRepo } from "../src/memory/profile-repo.js";
import { ConversationRecorder } from "../src/memory/conversation-recorder.js";
import { ConversationRepo } from "../src/memory/conversation-repo.js";
import { MemoryRecaller } from "../src/memory/recall.js";
import { ModelRepo } from "../src/models/repo.js";
import { DenoiseRepo } from "../src/denoise/repo.js";
import { SettingsService } from "../src/settings/service.js";
import { SessionRepo } from "../src/gateway/sessions.js";
import { SnapshotBuilder, injectSnapshot } from "../src/gateway/snapshot.js";
import { createGatewayRouter, type GatewayDeps } from "../src/gateway/index.js";
import { forwardChat } from "../src/gateway/forwarder.js";
import { denoiseMessages } from "../src/denoise/engine.js";
import { chatCompletionsAdapter, firstUserText } from "../src/gateway/protocol.js";
import { shouldCaptureConversation, stripInjectionTags } from "../src/memory/sanitize.js";

let dir: string;
let db: DatabaseSync;
let deps: GatewayDeps;
let settings: SettingsService;
let models: ModelRepo;
let assets: AssetsRepo;
let memories: MemoryRepo;
let profiles: ProfileRepo;
let denoise: DenoiseRepo;
let sessions: SessionRepo;
let recorder: ConversationRecorder;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nlam-gw-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  ensureFtsTable(db);

  const projects = new ProjectRepo(db);
  assets = new AssetsRepo(db);
  memories = new MemoryRepo(db, true);
  profiles = new ProfileRepo(db);
  denoise = new DenoiseRepo(db);
  models = new ModelRepo(db);
  settings = new SettingsService(db, models);
  settings.init();
  sessions = new SessionRepo(db);
  recorder = new ConversationRecorder(db);
  const recaller = new MemoryRecaller(memories, settings);
  const snapshot = new SnapshotBuilder(assets);

  deps = { projects, denoise, settings, sessions, snapshot, recorder, profiles, recaller, fetchFn: mockFetchFn };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function bindUpstream(handler: (req: Request) => Response | Promise<Response>): void {
  const m = models.create({ category: "llm", name: "Mock", url: "https://mock.local/v1", key: "k", model: "mock-1" });
  settings.set("gateway_llm", m.id);
  upstreamHandler = handler;
}

let upstreamHandler: ((req: Request) => Response | Promise<Response>) | null = null;

// 网关上游 fetch 注入 mock（forwarder 走 undici 自带 fetch，不再经 globalThis.fetch）
async function mockFetchFn(url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<Response> {
  if (!url.includes("mock.local")) throw new Error(`unexpected upstream url: ${url}`);
  if (!upstreamHandler) throw new Error("no mock handler");
  return upstreamHandler(new Request(url, init));
}

function jsonReply(text: string): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content: text } }] });
}

function app(gateway: Hono): Hono {
  const a = new Hono();
  a.route("/", gateway);
  return a;
}

async function chat(h: Hono, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.fetch(new Request("http://gw.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

describe("gateway 主链路", () => {
  it("header 项目登记 + 快照注入 + 透传 + 对话回流", async () => {
    bindUpstream(() => jsonReply("你好，世界"));
    const gw = app(createGatewayRouter(deps));

    const res = await chat(gw, {
      model: "whatever",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "hi" },
      ],
    }, { "x-project-path": "E:/Code/GwTest", "x-session-id": "sess-1" });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect((json.choices as { message: { content: string } }[])[0]!.message.content).toBe("你好，世界");

    // 上游收到的请求：model 被重写、system 含快照、project 已登记
    const prj = deps.projects.findByPath("e:/code/gwtest");
    expect(prj).toBeDefined();

    // 对话已回流（user + assistant 各一条）
    const conv = new ConversationRepo(db).listByProject(prj!.id, 10, 0);
    expect(conv.map((c) => c.role).sort()).toEqual(["assistant", "user"]);

    // 管线状态累积 user 计数
    const ps = db.prepare("SELECT user_msg_count FROM pipeline_states WHERE project_id = ?").get(prj!.id) as { user_msg_count: number };
    expect(ps.user_msg_count).toBe(1);
  });

  it("tool_calls 中间轮不回流对话", async () => {
    bindUpstream(() => Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] } }] }));
    const gw = app(createGatewayRouter(deps));
    await chat(gw, { messages: [{ role: "user", content: "call a tool" }] }, { "x-project-path": "E:/Code/GwTest", "x-session-id": "sess-tc" });

    const prj = deps.projects.findByPath("e:/code/gwtest")!;
    expect(new ConversationRepo(db).listByProject(prj.id, 10, 0)).toHaveLength(0);
  });

  it("无法识别项目 → 降级透传（不 400、不回流）", async () => {
    bindUpstream(() => jsonReply("ok"));
    const gw = app(createGatewayRouter(deps));
    const res = await chat(gw, { messages: [{ role: "user", content: "/compact" }] });
    expect(res.status).toBe(200);
    expect(deps.projects.list()).toHaveLength(0);
  });

  it("正文兜底解析工作区路径（VS Code workspace_info 段）", async () => {
    bindUpstream(() => jsonReply("ok"));
    const gw = app(createGatewayRouter(deps));
    await chat(gw, {
      messages: [
        { role: "system", content: "工作区信息：\n<workspace_info>\n- e:\\Code\\Parsed\n</workspace_info>" },
        { role: "user", content: "hello" },
      ],
    });
    expect(deps.projects.findByPath("e:/code/parsed")).toBeDefined();
  });

  it("未配置 LLM → 400 llm_not_configured", async () => {
    const gw = app(createGatewayRouter(deps));
    const res = await chat(gw, { messages: [{ role: "user", content: "hi" }] }, { "x-project-path": "E:/Code/GwTest" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("llm_not_configured");
  });

  it("其他 /v1 端点 404", async () => {
    const gw = app(createGatewayRouter(deps));
    const res = await gw.fetch(new Request("http://gw.local/v1/embeddings", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("快照每轮复用（字节稳定）", async () => {
    let seenSystem: string | null = null;
    bindUpstream(async (req) => {
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      seenSystem = body.messages.find((m) => m.role === "system")?.content ?? null;
      return jsonReply("ok");
    });
    const gw = app(createGatewayRouter(deps));
    const msgs = (n: number) => [
      { role: "system", content: "sys" },
      { role: "user", content: "first question" },
      ...Array.from({ length: n }, (_, i) => ({ role: "user" as const, content: `follow-up ${i}` })),
    ];
    await chat(gw, { messages: msgs(0) }, { "x-project-path": "E:/Code/GwTest", "x-session-id": "sess-st" });
    const snap1 = seenSystem;
    await chat(gw, { messages: msgs(2) }, { "x-project-path": "E:/Code/GwTest", "x-session-id": "sess-st" });
    // 第二轮 system = 原 sys + 同一快照（无新增注入变化）
    expect(seenSystem).toBe(snap1);
  });

  it("记忆召回块注入在最后一条 user 前", async () => {
    const prj = deps.projects.upsertOnRequest("E:/Code/GwTest").project;
    memories.insert(prj.id, { kind: "fact", content: "网关端口是 8790", priority: 80, sceneName: null, sourceConversationIds: [], batchId: null, createdAt: Date.now() });

    let lastUser: string | null = null;
    bindUpstream(async (req) => {
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      lastUser = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? null;
      return jsonReply("ok");
    });
    const gw = app(createGatewayRouter(deps));
    await chat(gw, { messages: [{ role: "user", content: "端口多少" }] }, { "x-project-path": "E:/Code/GwTest", "x-session-id": "sess-r" });
    expect(lastUser).toContain("<recalled>");
    expect(lastUser).toContain("网关端口是 8790");
  });
});

describe("denoise engine", () => {
  it("删除模式整段删除含标记；提取模式仅剥壳", () => {
    // 基线相对断言：迁移可能预置规则（如 0004 的 Copilot 包装噪声），不假设表初始为空
    const before = denoise.list().length;
    denoise.create({ startText: "<internal>", endText: "</internal>", enabled: true });
    denoise.create({ startText: "<ctx>", endText: "</ctx>", extract: true, enabled: true });
    const all = denoise.list();
    expect(all).toHaveLength(before + 2);
    const out = denoiseMessages(
      [{ role: "user", content: "keep<internal>drop</internal>tail <ctx>inner</ctx>" }],
      all,
      "forward",
    );
    expect((out[0] as { content: string }).content).toBe("keeptail inner");
  });

  it("空文本消息删除，tool_calls assistant 保留", () => {
    const out = denoiseMessages(
      [
        { role: "user", content: "   " },
        { role: "assistant", content: "", tool_calls: [{ id: "t" }] },
        { role: "tool", content: "", tool_call_id: "t" },
      ],
      [],
      "forward",
    );
    expect(out).toHaveLength(2); // 空 user 被删
  });
});

describe("forwarder 超时策略", () => {
  // 真实本地 HTTP 服务：验证 undici Agent 的 headers/body 超时与静默流不掐断
  let base = "";
  const server = createServer((req, res) => {
    // forwardChat 固定追加 /chat/completions，故以路径前缀区分场景（baseUrl 传 base+"/slow" 等）
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/slow")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "late" } }] }));
      }, 2500);
      return;
    }
    if (url.pathname.startsWith("/silent-sse")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      }, 900);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("timeoutMs 掐断慢响应头；0=不限则通过", async () => {
    await expect(forwardChat({ baseUrl: `${base}/slow`, apiKey: "" }, {}, { timeoutMs: 200 }))
      .rejects.toThrow();
    const res = await forwardChat({ baseUrl: `${base}/slow`, apiKey: "" }, {}, { timeoutMs: 0 });
    expect(res.status).toBe(200);
    expect((await res.aggregate).text).toBe("late");
  });

  it("静默 SSE 在宽超时下不断流，聚合完整", async () => {
    const res = await forwardChat({ baseUrl: `${base}/silent-sse`, apiKey: "" }, { stream: true }, { timeoutMs: 0, idleWarnMs: 100 });
    // 消费透传流（旁路聚合共享 tee 源）
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    const agg = await res.aggregate;
    expect(agg.text).toBe("ab");
    expect(agg.final).toBe(true);
  });
});

describe("sanitize", () => {
  it("剥离注入标签（含未闭合残留）", () => {
    const text = "真问题\n\n<recalled>\n以下是...\n1. [type:fact] xx\n</recalled>\n<project>\npath: e:/a\n</project>";
    expect(stripInjectionTags(text)).toBe("真问题");
    // 未闭合残留
    expect(stripInjectionTags("正文\n<knowledge>\n- kn_x：y")).toBe("正文");
    // 行内提及不误伤
    expect(stripInjectionTags("使用 <knowledge> 标签可以注入知识清单")).toContain("<knowledge>");
  });

  it("shouldCaptureConversation 拒收斜杠命令与噪音", () => {
    expect(shouldCaptureConversation("/compact").ok).toBe(false);
    expect(shouldCaptureConversation("").ok).toBe(false);
    expect(shouldCaptureConversation("I'm working in a workspace").ok).toBe(false);
    expect(shouldCaptureConversation("正常问题").ok).toBe(true);
  });
});

describe("protocol", () => {
  it("developer 角色归一为 system；extra 透传", () => {
    const parsed = chatCompletionsAdapter.parse({
      model: "m", stream: true, messages: [{ role: "developer", content: "d" }], temperature: 0.5,
    });
    expect(parsed.messages[0]!.role).toBe("system");
    expect(parsed.extra.temperature).toBe(0.5);
    const serialized = chatCompletionsAdapter.serialize(parsed);
    expect(serialized.temperature).toBe(0.5);
    expect(serialized.stream).toBe(true);
  });

  it("firstUserText 支持块数组", () => {
    expect(firstUserText([{ role: "user", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }])).toBe("A\nB");
  });
});

describe("snapshot", () => {
  it("五节顺序与空节省略", () => {
    assets.createPrompt({ name: "p", content: "PROMPT", enabled: true });
    assets.createKnowledge({ title: "K", body: "kb", scope: "global", enabled: true });
    const snap = new SnapshotBuilder(assets).build({ projectId: null, projectPath: "e:/code/x", memoryProfile: "" });
    expect(snap).toContain("<prompts>\nPROMPT\n</prompts>");
    expect(snap).toContain("<knowledge>");
    expect(snap).not.toContain("<memory>");
    expect(snap).toContain("<project>\npath: e:/code/x\n</project>");
    expect(snap.indexOf("<prompts>")).toBeLessThan(snap.indexOf("<knowledge>"));
  });

  it("injectSnapshot 追加到已有 system 末尾", () => {
    const out = injectSnapshot([{ role: "system", content: "base" }, { role: "user", content: "q" }], "SNAP");
    expect((out[0] as { content: string }).content).toBe("base\n\nSNAP");
  });
});
