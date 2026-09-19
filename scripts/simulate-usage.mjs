#!/usr/bin/env node
/**
 * 真实环境使用仿真（DESIGN 决策 58/59）：不 mock 任何环节，对**运行中的服务**
 * （默认 http://localhost:8790，真实 gateway_llm/memory_llm + 真实 embedding +
 * 调度器真实节律）以一个有真实代码资源的项目为测试对象，模拟真实 Agent 客户端完整使用旅程。
 *
 * 与首版（一次性 usage-sim 项目）的差异（决策 59）：
 *  - 测试项目 = --project 指定（默认本仓库自身，有完整代码资源可供 CodeGraph 断言）；
 *  - **跑完不删测试数据**（管理台可回看）；仅回切原生效提示词（互斥副作用）；
 *  - 新增资产播种（提示词/agents/技能/知识库）+ 注入端到端验证；
 *  - 新增自动召回质量（命中率/多主题/精确率/溯源/项目隔离/端到端）；
 *  - 新增 L2 画像质量（结构/关键事实/长度上限/注入）；
 *  - 新增 CodeGraph 质量（状态/检索/调用边/影响面/精确率/关系图完整性）。
 *
 * 用法：
 *   node scripts/simulate-usage.mjs [--base http://localhost:8790] [--wait 420] [--project <路径>]
 *     --wait     等待 L1/L2 管线的最长秒数（真实 LLM + idle 60s + L2 延迟 120s，默认 420）
 *     --project  被测项目绝对路径（需已在网关登记且服务可访问；默认本仓库根目录）
 *
 * 归因：所有测试数据带一次性后缀 SUF（标记词「沧溟<6位>」、提示词签名、资产描述代号、
 * 知识/agents/技能清单代号），既能精确断言"是本轮仿真产生的"，又不会与既有数据混淆。
 */

import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const BASE = args.base ?? "http://localhost:8790";
const WAIT_SEC = Number(args.wait ?? 420);

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const SUF = TS.slice(-6);
const PROJECT = (args.project ?? fileURLToPath(new URL("..", import.meta.url))).replace(/\\/g, "/").replace(/\/+$/, ""); // 被测项目（默认本仓库）
const SESSION = `sim-${TS}`;
const MARK = `沧溟${SUF}`; // 记忆代号（提取/召回归因）
const SIG = `〔SIM-${SUF}〕`; // 提示词签名（<prompts> 注入验证）
const KNO = `赤霄${SUF}`; // 知识清单代号
const AGT = `蓝鲸${SUF}`; // agents 清单代号
const SKL = `银杏${SUF}`; // 技能清单代号

const results = [];

// ── 工具函数 ─────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const msg = String(err.message ?? err);
    results.push({ name, ok: false, detail: msg, ms: Date.now() - t0 });
    console.log(`  ❌ ${name} — ${msg}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, res, json };
}

async function api(path, body) {
  const { status, json } = await postJson(`/api/${path}`, body);
  assert(status === 200 && json?.success, `POST /api/${path} → HTTP ${status} ${json?.message ?? ""}`);
  return json.data;
}

async function internal(path) {
  const res = await fetch(`${BASE}/internal/${path}`);
  const body = await res.json().catch(() => null);
  assert(res.status === 200 && body?.ok, `GET /internal/${path} → HTTP ${res.status} ${JSON.stringify(body?.error ?? "")}`);
  return body.data;
}

/** 轮询直到条件满足（返回耗时文本），超时抛错。 */
async function poll(label, condFn, timeoutSec, stepMs = 4000) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if (await condFn()) return `${((Date.now() - t0) / 1000).toFixed(0)}s`;
    await sleep(stepMs);
  }
  throw new Error(`${label}：${timeoutSec}s 内未达成`);
}

/** 主线对话（累积消息、非流式），模拟真实客户端每轮全量上传。 */
let messages = [];
async function turn(content) {
  messages.push({ role: "user", content });
  const { status, json } = await postJson(
    "/v1/chat/completions",
    { model: "ignored-by-gateway", stream: false, messages },
    { "x-project-path": PROJECT, "x-session-id": SESSION },
  );
  assert(status === 200 && json?.choices?.[0]?.message, `对话请求失败 HTTP ${status}`);
  const text = json.choices[0].message.content ?? "";
  messages.push({ role: "assistant", content: text });
  return text;
}

/** 冷启动一次性提问：新 session（快照重建）+ 单条消息（与主线历史隔离）。 */
async function coldAsk(content) {
  const sid = `cold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { status, json } = await postJson(
    "/v1/chat/completions",
    { model: "x", stream: false, messages: [{ role: "user", content }] },
    { "x-project-path": PROJECT, "x-session-id": sid },
  );
  assert(status === 200 && json?.choices?.[0]?.message, `冷启动请求失败 HTTP ${status}`);
  return json.choices[0].message.content ?? "";
}

const flat = (s) => String(s).replace(/\s+/g, " ");
const head = (s, n = 50) => `"${flat(s).slice(0, n)}…"`;

// ── 仿真剧本：真实开发者会交代的事实（每条都埋可验证的具体值） ──

const TURNS = [
  `这个网关项目我起了个内部代号叫「${MARK}」，定位是个人本地 Agent 记忆中枢，监听 localhost:8790，纯本地无鉴权。`,
  `存储层定了：Node 24 内置 node:sqlite，WAL 模式；向量检索用 sqlite-vec 的 vec0 虚拟表，维度固定 1024，明确不用 Postgres 也不用 better-sqlite3。`,
  `记住我的偏好：包管理一律 pnpm，单测用 vitest，日志与入库时间固定本地时区不用 UTC，提交信息写中文。`,
  `记一个踩坑教训：Semi UI 的 TabPane 键属性是 itemKey 不是 tabKey，写错不报错但页签内容渲染为空。`,
  `删除策略决定：「${MARK}」除项目保留软删外，模型/提示词/agents/技能/知识库/L0/L1 的单条删除全部物理删除。`,
  `API 约定：/api/* 一律 POST + JSON body，列表返回 PaginationModel 分页包络，默认 pageSize 30。`,
];

// ── 主流程 ──

console.log(`\n══ 真实环境使用仿真（测试项目 = ${PROJECT}）══`);
console.log(`目标服务 : ${BASE}`);
console.log(`主线会话 : ${SESSION}`);
console.log(`归因代号 : 记忆=${MARK} 提示词签名=${SIG} 资产=${KNO}/${AGT}/${SKL}`);
console.log(`管线等待 : ≤${WAIT_SEC}s（真实 LLM + 调度器真实节律）`);
console.log(`数据策略 : 跑完保留全部测试数据（仅回切原生效提示词）\n`);

console.log("▶ 阶段 0：环境预检");
await check("health：服务在线", async () => {
  const res = await fetch(`${BASE}/health`);
  const b = await res.json();
  assert(res.status === 200 && b.ok, `HTTP ${res.status}`);
  return `fts5=${b.fts5} vec=${b.vec} time=${b.time}`;
});
await check("预检：三模型绑定 + 提取/召回开启", async () => {
  const list = (await api("settings/list", { page: 1, pageSize: 100 })).list;
  const get = (k) => list.find((x) => x.key === k)?.value;
  assert(get("gateway_llm") && get("memory_llm") && get("embedding_model"), "模型未全部绑定");
  assert(get("extraction_enabled") === "true", "extraction_enabled=false，写侧停摆");
  assert(get("l1_recall_enabled") === "true", "l1_recall_enabled=false，读侧停摆");
  return `memory_llm=${get("memory_llm")} embedding=${get("embedding_model")}`;
});
let projectId = null;
await check("被测项目登记 + CodeGraph 基线", async () => {
  projectId = (await api("projects/get-by-path", { path: PROJECT })).id;
  const st = (await internal(`codegraph/status?project_path=${encodeURIComponent(PROJECT)}`)).data;
  return `project=${projectId} cg=${st.status} files=${st.files} symbols=${st.symbols}`;
});

console.log("\n▶ 阶段 1：资产播种（提示词 / agents / 技能 / 知识库）");
let seededPromptId = null;
let originalActivePromptId = null;
await check("记录原生效提示词（跑完回切，抵消互斥副作用）", async () => {
  const active = await api("prompts/active", {});
  originalActivePromptId = active?.id ?? null;
  return originalActivePromptId ? `原生效「${active.name}」` : "原本无生效项";
});
await check("创建并启用仿真提示词（含强制签名指令）", async () => {
  const p = await api("prompts/create", {
    name: `仿真-协作规范-${SUF}`,
    content: `你是「${MARK}」（本地记忆网关）项目的开发助手。每次回答用户问题后，必须另起一行追加签名：${SIG}。签名逐字照抄，不要翻译、不要改动括号。`,
    enabled: true,
  });
  seededPromptId = p.id;
  return `id=${p.id}（启用会自动停用原提示词）`;
});
let seededAssetIds = {};
await check("创建 agents / 技能 / 知识库（描述埋验证代号）", async () => {
  const a = await api("agents/create", {
    name: `sim-reviewer-${SUF}`,
    description: `代码评审守则「${AGT}」：按 id 读取正文，评审 TS 前先跑 pnpm typecheck`,
    body: `# sim-reviewer\n评审顺序：typecheck → vitest → 代码走查。重点看 ESM 的 .js 导入后缀、drizzle 迁移与 journal 一致性。`,
    enabled: true,
  });
  const s = await api("skills/create", {
    name: `sim-release-${SUF}`,
    description: `发布流程「${SKL}」：build:web → pnpm build → 重启服务 → health 探活`,
    body: `# sim-release\n1. pnpm build:web\n2. pnpm build\n3. 停旧进程后 pnpm start\n4. 探 /health 确认 fts5/vec=true`,
    enabled: true,
  });
  const k1 = await api("knowledge/create", {
    title: `LAM 架构速查-${SUF}`,
    description: `知识代号「${KNO}」：快照六节注入顺序 prompts/knowledge/agents/skills/memory/project`,
    body: `# LAM 架构\n透明 OpenAI 网关 + L0/L1/L2 三层记忆 + CodeGraph。快照每会话生成一次并缓存复用，保上游 KV cache 前缀稳定。`,
    scope: "global",
    enabled: true,
  });
  const k2 = await api("knowledge/create", {
    title: `被测项目环境-${SUF}`,
    description: `本项目专属：数据目录 data/gateway.db，日志 data/Logs 小时滚动`,
    body: `# 环境\nnode:sqlite WAL；sqlite-vec 需 allowExtension 加载；备份走 VACUUM INTO 一致性快照。`,
    scope: "project",
    projectId,
    enabled: true,
  });
  seededAssetIds = { a: a.id, s: s.id, k1: k1.id, k2: k2.id };
  return `agt=${a.id} skl=${s.id} kno=${k1.id}/${k2.id}`;
});
await check("资产读取回路（/internal，MCP 工具同路径）", async () => {
  const kn = await internal(`knowledge/list?project_path=${encodeURIComponent(PROJECT)}`);
  const ag = await internal("agents/list");
  const sk = await internal("skills/list");
  assert(kn.some((x) => x.description.includes(KNO)), "知识清单缺新全局条目");
  assert(kn.some((x) => x.description.includes("本项目专属")), "project scope 知识未按项目返回");
  assert(ag.some((x) => x.description.includes(AGT)), "agents 清单缺新条目");
  assert(sk.some((x) => x.description.includes(SKL)), "技能清单缺新条目");
  const read = await internal(`knowledge/read?id=${kn.find((x) => x.description.includes(KNO)).id}`);
  assert(read.body.includes("KV cache"), "read 正文缺失");
  return `清单 kno=${kn.length} agt=${ag.length} skl=${sk.length}；read 正文 OK`;
});

console.log("\n▶ 阶段 2：多轮真实对话（客户端全量上传，网关真实转发 qwen）");
for (let i = 0; i < TURNS.length; i++) {
  await check(`turn ${i + 1}/${TURNS.length}`, async () => head(await turn(TURNS[i]), 28));
  await sleep(1200); // 真实节奏：人读答案/打字的间隙
}
await check("SSE 流式透传", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-project-path": PROJECT, "x-session-id": SESSION },
    body: JSON.stringify({ model: "x", stream: true, messages: [{ role: "user", content: "用一句话说你好" }] }),
  });
  assert((res.headers.get("content-type") ?? "").includes("text/event-stream"), "非 SSE 响应");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let frames = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (dec.decode(value).includes("data:")) frames++;
    if (frames > 3) { await reader.cancel(); break; }
  }
  assert(frames > 0, "未收到 data 帧");
  return `${frames}+ 帧`;
});

console.log("\n▶ 阶段 3：L0 回流（fire-and-forget）");
await check("L0 落库 + 时间倒序", async () => {
  const t = await poll("L0", async () => {
    const r = await api("memories/l0-list", { project_id: projectId, page: 1, pageSize: 200 });
    return r.list.filter((x) => x.content.includes(MARK)).length >= 2 && r.totalCount >= 12;
  }, 60);
  const r = await api("memories/l0-list", { project_id: projectId, page: 1, pageSize: 20 });
  const desc = r.list.every((x, i) => i === 0 || r.list[i - 1].createdAt >= x.createdAt);
  assert(desc, "L0 非时间倒序");
  return `共 ${r.totalCount} 条，含代号 ${r.list.filter((x) => x.content.includes(MARK)).length} 条，倒序 OK，${t}`;
});

console.log("\n▶ 阶段 4：资产注入端到端（冷启动 → 快照六节真进上游）");
await check("<prompts> 生效：回答带签名（证明 system 注入）", async () => {
  const text = await coldAsk("这个项目的向量维度是多少？一句话回答。");
  assert(text.includes(SIG), `未见签名，回答=${head(text, 60)}`);
  return `签名命中，回答=${head(text, 40)}`;
});
await check("<knowledge>/<agents>/<skills> 清单生效：三个代号可读回", async () => {
  const text = await coldAsk(
    `系统提示里注入了知识、agents、技能清单（每行是 id：描述）。请只回答三个代号，按行输出：` +
      `1) 描述里含「赤霄」开头的中文代号是什么；2) 描述里含「蓝鲸」开头的中文代号是什么；3) 描述里含「银杏」开头的中文代号是什么。`,
  );
  const hit = [KNO, AGT, SKL].filter((m) => text.includes(m));
  assert(hit.length === 3, `仅命中 ${hit.length}/3（${hit.join(",")}），回答=${head(text, 80)}`);
  return "三代号全中";
});

console.log("\n▶ 阶段 5：L1 提取 + 自动召回质量（真实 memory_llm，调度器真实节律）");
// 关键教训（首跑）：warm-up 分批提取（阈值 1→2→4 + idle 60s 兜底），首批往往只有代号类记忆，
// 主题事实要等后续批次。质量断言前必须等探针事实全部落库，否则测的是"还没提取出来的东西"。
const FACT_PROBES = [/1024/, /pnpm/i, /itemKey|TabPane/, /物理删|软删/, /PaginationModel|POST/];
await check("L1 提取稳定（等全部主题事实落库）", async () => {
  const t = await poll("L1 主题齐备", async () => {
    const r = await api("memories/list", { project_id: projectId, page: 1, pageSize: 200 });
    return FACT_PROBES.every((re) => r.list.some((x) => re.test(x.content)));
  }, WAIT_SEC);
  const r = await api("memories/list", { project_id: projectId, page: 1, pageSize: 200 });
  const kinds = [...new Set(r.list.map((x) => x.kind))].join("/");
  const withMark = r.list.filter((x) => x.content.includes(MARK)).length;
  return `${r.totalCount} 条（kind: ${kinds}，含代号 ${withMark}），${t}`;
});
await check("召回·命中率：代号查询 top-1 即含代号", async () => {
  const hits = await internal(
    `memory/search?project_path=${encodeURIComponent(PROJECT)}&query=${encodeURIComponent(`${MARK} 代号 定位`)}&top_k=5`,
  );
  assert(hits.length >= 1, "0 命中");
  assert(hits[0].content.includes(MARK), `top-1 不含代号：${head(hits[0].content, 40)}`);
  return `top-1=${head(hits[0].content, 30)}（${hits.length} 条，kind=${hits[0].kind}，score=${hits[0].score}）`;
});
await check("召回·多主题命中与排序（技术栈/偏好/踩坑）", async () => {
  const probes = [
    ["node:sqlite vec0 向量维度", /1024|sqlite/i],
    ["pnpm vitest 提交信息 偏好", /pnpm|vitest|中文/],
    ["TabPane itemKey 踩坑", /itemKey|TabPane/],
  ];
  const out = [];
  for (const [q, re] of probes) {
    const hits = await internal(`memory/search?project_path=${encodeURIComponent(PROJECT)}&query=${encodeURIComponent(q)}&top_k=5`);
    const rank = hits.findIndex((h) => re.test(h.content));
    assert(rank >= 0, `「${q}」未命中（top=${head(hits[0]?.content ?? "空", 30)}）`);
    out.push(`「${q.slice(0, 10)}…」→rank${rank + 1}`);
  }
  return out.join(" ");
});
await check("召回·精确率：无关联想词不产生伪命中", async () => {
  const junk = `紫色独角兽喷泉${SUF}`;
  const hits = await internal(`memory/search?project_path=${encodeURIComponent(PROJECT)}&query=${encodeURIComponent(junk)}&top_k=5`);
  assert(!hits.some((h) => h.content.includes(junk.slice(0, 5))), "无关词竟精确命中");
  return `返回 ${hits.length} 条（纯近邻排序，无伪命中，靠 score 低区分）`;
});
await check("召回·溯源：命中记忆可回连 L0 原文", async () => {
  const hits = await internal(`memory/search?project_path=${encodeURIComponent(PROJECT)}&query=${encodeURIComponent(MARK)}&top_k=5`);
  for (const h of hits) {
    const r = await internal(`memory/read?id=${h.id}`);
    if (r.sources?.length) {
      return `id=${h.id} 溯源 ${r.sources.length} 条 L0，首条=${head(r.sources[0].content, 24)}`;
    }
  }
  throw new Error(`前 ${hits.length} 条命中均无 source_message_ids（真实 LLM 未回填溯源）`);
});
await check("召回·项目隔离：其他项目查不到本代号", async () => {
  const other = (await api("projects/list", { page: 1, pageSize: 100 })).list.find((p) => p.id !== projectId);
  if (!other) return "无其他项目，跳过";
  const hits = await internal(`memory/search?project_path=${encodeURIComponent(other.path)}&query=${encodeURIComponent(MARK)}&top_k=5`);
  assert(!hits.some((h) => h.content.includes(MARK)), `跨项目泄漏到 ${other.path}！`);
  return `${other.path} 无泄漏`;
});
await check("召回·端到端：冷启动新会话答出记忆事实（注入真生效）", async () => {
  const text = await coldAsk(`「${MARK}」这个项目的向量维度和包管理器分别是什么？只答这两点。`);
  const okVec = /1024/.test(text);
  const okPnpm = /pnpm/i.test(text);
  assert(okVec && okPnpm, `维度=${okVec} pnpm=${okPnpm} → ${head(text, 80)}`);
  return head(text, 50);
});

console.log("\n▶ 阶段 6：L2 项目画像质量");
await check("画像凝练（version≥1）", async () => {
  const t = await poll("L2", async () => ((await api("memories/profile", { project_id: projectId })).version >= 1), WAIT_SEC);
  const r = await api("memories/profile", { project_id: projectId });
  return `v${r.version}，${r.content.length} 字，${t}`;
});
await check("画像质量：结构 / 关键事实 / 长度上限", async () => {
  const r = await api("memories/profile", { project_id: projectId });
  const max = Number((await api("settings/list", { page: 1, pageSize: 100 })).list.find((x) => x.key === "l2_max_chars")?.value ?? 2000);
  assert(r.content.length > 30, `画像过短（${r.content.length} 字）`);
  assert(r.content.length <= max, `超 l2_max_chars=${max}（实际 ${r.content.length}）`);
  assert(/^#{1,3}\s/m.test(r.content), "非 Markdown 结构（无标题层级）");
  const facts = [["sqlite", /sqlite/i], ["pnpm", /pnpm/i], ["8790", /8790/], ["代号", new RegExp(MARK)]].filter(([, re]) => re.test(r.content));
  assert(facts.length >= 2, `关键事实仅 ${facts.map((f) => f[0]).join(",") || "无"}`);
  return `${r.content.length}/${max} 字，Markdown OK，命中事实：${facts.map((f) => f[0]).join("/")}`;
});
await check("画像注入：冷启动答出项目定位与端口", async () => {
  const text = await coldAsk("用一句话概括这个网关项目的定位和监听地址。");
  assert(/8790|localhost/.test(text), `未答出定位信息：${head(text, 60)}`);
  return head(text, 50);
});

console.log("\n▶ 阶段 7：CodeGraph 质量（真实代码库）");
await check("索引状态 ready", async () => {
  const d = (await internal(`codegraph/status?project_path=${encodeURIComponent(PROJECT)}`)).data;
  assert(d.status === "ready", `status=${d.status} ${d.lastError ?? ""}`);
  return `files=${d.files} symbols=${d.symbols} lastIndexedAt=${d.lastIndexedAt ? new Date(d.lastIndexedAt).toLocaleString() : "-"}`;
});
await check("符号检索：真实类/函数可定位且文件正确", async () => {
  const probes = [["L1Store", /l1-store/], ["normalizeProjectPath", /normalize/], ["forwardChat", /forwarder/]];
  const out = [];
  for (const [name, fileRe] of probes) {
    const r = (await internal(`codegraph/search?project_path=${encodeURIComponent(PROJECT)}&query=${name}&limit=20`)).data ?? [];
    const hit = r.find((h) => h.name === name);
    assert(hit, `「${name}」未检索到（top=${r[0]?.name ?? "空"}）`);
    assert(fileRe.test(hit.file), `${name} 文件异常：${hit.file}`);
    out.push(`${name}@${hit.file.split("/").pop()}:${hit.line}`);
  }
  return out.join(" ");
});
await check("调用边：callers 命中真实调用方", async () => {
  const r = (await internal(`codegraph/callers?project_path=${encodeURIComponent(PROJECT)}&name=normalizeProjectPath&limit=30`)).data;
  const callers = r?.callers ?? [];
  assert(callers.length >= 3, `调用方仅 ${callers.length}（api/gateway/projects 多处调用，应≥3）`);
  const files = new Set(callers.map((c) => c.file));
  assert([...files].every((f) => f.startsWith("src/")), `调用方文件异常：${[...files].join(",")}`);
  return `${callers.length} 个调用方，跨 ${files.size} 文件（${[...files].slice(0, 2).join(", ")}…）`;
});
await check("被调方：callees 反向边可用", async () => {
  const r = (await internal(`codegraph/callees?project_path=${encodeURIComponent(PROJECT)}&name=upsertOnRequest&limit=20`)).data;
  const n = r?.callees?.length ?? 0;
  assert(n >= 1, `upsertOnRequest 无被调方（${JSON.stringify(r).slice(0, 80)}）`);
  return `${n} 个被调方：${r.callees.slice(0, 3).map((c) => c.name).join(", ")}`;
});
await check("影响面：impact 反向 BFS 非空", async () => {
  const r = (await internal(`codegraph/impact?project_path=${encodeURIComponent(PROJECT)}&name=normalizeProjectPath&depth=2`)).data;
  assert((r?.affectedCount ?? 0) >= 3, `影响面仅 ${r?.affectedCount ?? 0}`);
  return `depth=2 受影响 ${r.affectedCount} 个符号`;
});
await check("精确率：不存在符号返回空而非误报", async () => {
  const r = (await internal(`codegraph/search?project_path=${encodeURIComponent(PROJECT)}&query=zzzNoSuchSymbol${SUF}&limit=5`)).data ?? [];
  assert(r.length === 0, `误报：${JSON.stringify(r).slice(0, 80)}`);
  return "空结果 OK";
});
await check("文件清单：/codegraph/files 覆盖 src 与 frontend", async () => {
  const d = (await internal(`codegraph/files?project_path=${encodeURIComponent(PROJECT)}`)).data ?? {};
  const paths = (d.files ?? []).map((f) => f.path);
  assert(paths.length >= 50, `文件仅 ${paths.length}`);
  const hasSrc = paths.some((p) => p.startsWith("src/"));
  const hasFrontend = paths.some((p) => p.startsWith("frontend/"));
  assert(hasSrc && hasFrontend, `覆盖不足 src=${hasSrc} frontend=${hasFrontend}`);
  return `total=${d.total} 列出 ${paths.length}（src + frontend 均覆盖）`;
});
await check("关系图：/api/codegraph/graph 完整性（前端数据源）", async () => {
  const g = await api("codegraph/graph", { id: projectId, maxNodes: 120 });
  assert(g.status === "ready", `status=${g.status} ${g.message ?? ""}`);
  assert(g.nodes.length > 50 && g.nodes.length <= 120, `节点数 ${g.nodes.length} 不在 (50,120]`);
  const ids = new Set(g.nodes.map((n) => n.id));
  const dangling = g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).length;
  assert(dangling === 0, `${dangling} 条悬挂边（应只保留两端都在节点集内）`);
  assert(g.stats.totalSymbols >= 500, `符号总数异常：${g.stats.totalSymbols}`);
  const kinds = new Set(g.nodes.map((n) => n.kind));
  return `nodes=${g.nodes.length} edges=${g.edges.length}（全量 ${g.stats.totalSymbols} 符号/${g.stats.totalEdges} 边，kind ${kinds.size} 种）`;
});

console.log("\n▶ 阶段 8：管理端可见性 + 状态回切");
await check("管理 API：L0/L1/画像/资产/日志均可查（前端页面数据源）", async () => {
  const l1 = await api("memories/list", { project_id: projectId, page: 1, pageSize: 1 });
  const ag = await api("agents/list", { keyword: AGT, page: 1, pageSize: 10 });
  const kn = await api("knowledge/list", { page: 1, pageSize: 100 });
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const logs = await api("logs/list", { date });
  assert(l1.totalCount >= 4, `L1 仅 ${l1.totalCount}`);
  assert(ag.totalCount === 1, `仿真 agent 检索到 ${ag.totalCount} 条`);
  assert(kn.list.some((x) => x.description.includes(KNO)), "知识列表缺仿真项");
  assert(logs.files.length > 0, "今日日志为空");
  return `L1=${l1.totalCount} 资产可检索 今日日志=${logs.files.length} 个`;
});
await check("回切提示词状态（原本无生效项则显式停用仿真提示词）", async () => {
  // 首跑 bug：原无生效提示词时若只"有原值才回切"，仿真提示词会残留生效、污染后续新会话。
  if (originalActivePromptId) {
    await api("prompts/update", { id: originalActivePromptId, enabled: true });
  } else if (seededPromptId) {
    await api("prompts/update", { id: seededPromptId, enabled: false });
  }
  const active = await api("prompts/active", {});
  assert(originalActivePromptId ? active?.id === originalActivePromptId : !active?.id, `回切失败，当前生效=${active?.id ?? "无"}`);
  return originalActivePromptId ? `已恢复「${active.name}」` : "已停用仿真提示词，恢复无生效态";
});

// ── 汇总 ──

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n══ 汇总：${pass} 通过 / ${fail} 失败 / 共 ${results.length} 项 ══`);
for (const r of results) if (!r.ok) console.log(`   FAILED: ${r.name} — ${r.detail}`);
console.log(`\n数据保留（未删除）：项目 ${PROJECT}，代号后缀 ${SUF}`);
console.log(`  提示词 ${seededPromptId ?? "-"} ｜ agents ${seededAssetIds.a ?? "-"} ｜ 技能 ${seededAssetIds.s ?? "-"} ｜ 知识库 ${seededAssetIds.k1 ?? "-"} / ${seededAssetIds.k2 ?? "-"}`);
console.log(`  管理台回看：记忆页选被测项目（L0/L1/L2）、Agents/技能/知识库页、CodeGraph 页`);
process.exit(fail ? 1 : 0);
