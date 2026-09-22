/**
 * 手动模拟 L1 提取：直连指定模型，读取本项目真实 L0 对话，跑一次提取 prompt 并原样打印返回。
 *
 * 用途：排查 memory_llm 候选模型到底返回什么（空 content / 对象包裹 / markdown 包裹 / 正常数组），
 * 与调度器管线解耦——只调用不写库，不影响 pipeline_state 缓冲。
 *
 * 用法：
 *   pnpm test:extract -- --url https://api.xxx.com/v1 --key sk-xxx --model some-model
 *   可选参数：
 *     --project e:/code/lam   按项目 path 或 name 匹配（默认 e:/code/lam）
 *     --limit 10              取最近 N 条 L0 消息（默认 10，即约 5 轮）
 *     --session <key>         限定会话 key（默认跨会话取最近）
 *     --timeout 120000        单次调用超时毫秒（默认 120s，与管线一致）
 *     --no-json               不带 response_format=json_object（对比模型是否受该参数影响）
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { chatComplete } from "../src/llm/client.js";
import { getExtractSystemPrompt, formatExtractionPrompt } from "../src/memory/prompts.js";
import { parseLlmJsonArray } from "../src/utils/json.js";

// ── CLI 参数 ──────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
}
const URL_ = flag("url", "https://api.agnes-ai.cn/v1");
const KEY = flag("key", "sk-n3HC09WsgCCS2fXGgcpYKXAwJPrfqiUydFiZzWR2MM4IQPDW");
const MODEL = flag("model", "agnes-3.0-flash");
const PROJECT = flag("project", "e:/code/lam");
const LIMIT = Number.parseInt(flag("limit", "10"), 10);
const SESSION = flag("session", "");
const TIMEOUT = Number.parseInt(flag("timeout", "120000"), 10);
const NO_JSON = argv.includes("--no-json");

if (!URL_ || !KEY || !MODEL) {
  console.error("缺少必填参数：--url --key --model\n示例：pnpm test:extract -- --url https://api.deepseek.com --key sk-xxx --model deepseek-chat");
  process.exit(1);
}

// ── 读取 L0（只读打开，不干扰运行中的服务）──────────────────
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const dbPath = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "gateway.db") : path.join(here, "../data/gateway.db");
const raw = new DatabaseSync(dbPath, { readOnly: true });

const proj = raw
  .prepare("SELECT id, name, path FROM projects WHERE (path = ? OR name = ?) AND deleted_at IS NULL LIMIT 1")
  .get(PROJECT, PROJECT);
if (!proj) {
  console.error(`项目不存在：${PROJECT}（按 path/name 匹配）`);
  const all = raw.prepare("SELECT name, path FROM projects WHERE deleted_at IS NULL").all();
  console.error("现有项目：", all.map((p) => p.name).join(", "));
  process.exit(1);
}

const rows = (
  SESSION
    ? raw
        .prepare(
          `SELECT id, role, content, created_at, turn_seq FROM mem_l0
           WHERE project_id = ? AND session_key = ? AND deleted_at IS NULL
           ORDER BY turn_seq DESC LIMIT ?`,
        )
        .all(proj.id, SESSION, LIMIT)
    : raw
        .prepare(
          `SELECT id, role, content, created_at, turn_seq FROM mem_l0
           WHERE project_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, turn_seq DESC LIMIT ?`,
        )
        .all(proj.id, LIMIT)
).reverse(); // 取最近 N 条后恢复时间正序

if (!rows.length) {
  console.error(`项目 ${proj.name} 没有可用 L0 数据`);
  process.exit(1);
}

console.log(`项目：${proj.name} (${proj.path})  L0 条数：${rows.length}`);
console.log(`模型：${MODEL} @ ${URL_}  response_format=${NO_JSON ? "off" : "json_object"}`);
console.log("─".repeat(60));

// ── 构造与管线一致的提取请求（全部消息作为 newMessages，无背景）──
const messages = rows.map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.created_at }));
const llmMessages = [
  { role: "system", content: getExtractSystemPrompt(200) },
  { role: "user", content: formatExtractionPrompt({ newMessages: messages, backgroundMessages: [] }) },
];

const t0 = Date.now();
let out;
try {
  out = await chatComplete(
    { baseUrl: URL_, apiKey: KEY, model: MODEL },
    llmMessages,
    { json: !NO_JSON, temperature: 0.2, timeoutMs: TIMEOUT },
  );
} catch (err) {
  console.error(`调用失败（${Date.now() - t0}ms）：${err?.cause?.name ?? err.name}: ${err.message}`);
  process.exit(2);
}

// ── 原样输出模型返回 + 管线视角的解析结论 ──
console.log(`调用成功，耗时 ${Date.now() - t0}ms，返回长度 ${out.length}\n`);
console.log("━━━━━━ 模型原始返回 ━━━━━━");
console.log(out || "(空字符串)");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━");

const parsed = parseLlmJsonArray(out);
console.log(`\n管线解析结论：${!out ? "content 为空 → 提取必失败" : parsed ? `✅ 可解析（${parsed.length} 个情境段，单对象已归一化）` : "❌ 无法解析为 JSON"}`);
if (parsed) {
  for (const seg of parsed) {
    console.log(`  情境「${seg.scene_name ?? "?"}」→ ${(seg.memories ?? []).length} 条记忆`);
  }
}
