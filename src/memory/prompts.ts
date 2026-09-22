/**
 * 记忆提取提示词（移植自参考项目 MemoryCore/src/core/prompts 的 chat 模式，
 * 按本项目改造：个人本地场景、kind 体系合并原 L1+L2 语义；
 * 归纳合并 / 情境命名 / metadata 时间字段与参考项目保持一致）。
 */

import { localDateTimeStr } from "../infra/localtime.js";

export interface ExtractMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

/** L1 条目类型（kind）。 */
export const L1_KINDS = ["persona", "episodic", "instruction", "fact", "method", "artifact"] as const;
export type L1Kind = (typeof L1_KINDS)[number];

export const EXTRACT_SYSTEM_PROMPT = `你是"情境切分与记忆提取专家"。分析对话，判断情境切换，并提取结构化核心记忆。

**输出语言**：scene_name 与 memory content 使用用户消息的主导语言；JSON 字段名、枚举值、时间戳保持英文。

## 任务一：情境切分
分析【待提取的新消息】，结合【上一个情境】，判断情境：
- 无明显切换则沿用上一个情境；话题转变或提出独立新目标则切换；一段对话可有多个情境。
- 命名："我（AI）在和xxx（用户身份）做xxx（目标活动）"，约 30-50 字符，单句，全局唯一。

## 任务二：记忆提取（仅从【待提取的新消息】提取）

【通用原则】
1. 宁缺毋滥：过滤寒暄、一次性工具请求、临时指令。
2. 独立完整：跳出当前对话依然成立，无上下文也能看懂；主体用"用户"或项目名。
3. 归纳合并：强关联或因果关系的多条消息，必须合并为一条完整记忆，不可碎片化。
4. 时间：尽量基于消息 timestamp 推算绝对时间。

【类型（type，六选一）】
- persona：用户稳定属性/偏好/技能/习惯（"用户喜欢/习惯…"）。priority 80-100 核心，50-70 一般，<50 丢弃。
- episodic：客观发生的事件/决定/计划（"用户于[时间]做了[事]"）。80-100 重要，<60 琐碎丢弃。
- instruction：用户对 AI 的长期行为规则/格式偏好/语气控制（"用户要求 AI 以后…"）。-1 死命令，90-100 核心，<70 临时丢弃。
- fact：项目事实/技术栈/架构决策/约束/状态（"项目使用 X 框架""模块 A 依赖 B"）。
- method：经验方法/SOP/禁忌/踩坑教训/判断标准（"排查 X 类问题应先查 Y""禁止直接改 Z"）。
- artifact：文档/PR/Issue/链接/脚本等可复用资产（"部署流程记录在 docs/deploy.md"）。

【不应提取】寒暄闲聊；一次性操作指令；重复内容；AI 自身行为输出；纯主观无客观信息的情绪表达。

## 任务三：输出格式（严格 JSON 数组，无其他内容、无 markdown 修饰符）
[
  {
    "scene_name": "情境名",
    "message_ids": ["属于该情境的消息ID"],
    "memories": [
      {
        "content": "完整、独立的记忆陈述",
        "type": "persona|episodic|instruction|fact|method|artifact",
        "priority": 80,
        "source_message_ids": ["消息ID"],
        "metadata": {}
      }
    ]
  }
]

metadata 字段说明：
- episodic 类型：如能确定活动时间，填入 {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}。
- 其他类型或无法确定时间：输出空对象 {}。

无有意义记忆时也输出情境分割结果，memories 为空数组。`;

export function getExtractSystemPrompt(_l1MaxChars?: number): string {
  return EXTRACT_SYSTEM_PROMPT;
}

export function formatExtractionPrompt(params: {
  newMessages: ExtractMessage[];
  backgroundMessages?: ExtractMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "无" } = params;
  const fmt = (m: ExtractMessage) =>
    `[${m.id}] [${m.role}] [${localDateTimeStr(new Date(m.timestamp))}]: ${m.content}`;
  return `**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 scene_name 和 memory content。

【上一个情境】：${previousSceneName}

【背景对话】（仅供理解上下文，严禁从中提取记忆）：
${backgroundMessages.length ? backgroundMessages.map(fmt).join("\n\n") : "无"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（只从这里提取！）：
${newMessages.map(fmt).join("\n\n")}`;
}

// ── 冲突检测（批量）──

export const CONFLICT_SYSTEM_PROMPT = `你是记忆冲突检测器。批量比较【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。
**输出语言**：merged_content 与候选池已有记忆同语言；JSON 字段名、枚举值、record_id、时间戳保持英文。

## 核心规则
- **跨 type 合并**：不同 type 但语义描述同一事实/事件可合并，并重新判定 merged_type。
- **多对多合并**：一条新记忆可通过 target_ids 数组替换/合并多条旧记忆。

## 判断逻辑
1. 是否同一事实/事件：主体相同、主题一致、时间接近、scene 相似。仅同项目但对象不同，不强行合并。
2. 动作：
   - store：新信息，直接新增。
   - skip：已有更好、无增量或更模糊，丢弃新记忆。
   - update：同一事实，新记忆更具体/更晚/纠错 → 覆盖旧的，保留旧中仍正确的细节。
   - merge：同一事实互补不矛盾 → 合并为一条更完整记忆，信息不冗余。
3. 倾向：同一偏好/事实的多条 → merge；无增量 → skip；明确演化/纠错 → update。
4. merged_timestamps：merge/update 时取所有相关记忆时间戳的并集（去重排序）。

## 输出格式（严格 JSON 数组，每条新记忆一个决策，无其他内容）
[
  {
    "record_id": "新记忆 id",
    "action": "store|update|skip|merge",
    "target_ids": ["被替换/合并的旧记忆 id，可多个；store/skip 时为空"],
    "merged_content": "合并/更新后的内容（merge/update 必填）",
    "merged_type": "合并后的最佳 type（merge/update 必填）",
    "merged_priority": 85,
    "merged_timestamps": ["时间戳并集（merge/update 必填）"]
  }
]
merged_priority：合并后信息更完整应酌情提升（80-100 核心，60-79 一般，<60 次要）。`;

export function getConflictSystemPrompt(): string {
  return CONFLICT_SYSTEM_PROMPT;
}

export interface ConflictCandidate {
  id: string;
  content: string;
  kind: string;
  priority: number;
  sceneName: string | null;
  createdAt: number;
}

export interface ConflictNewMemory {
  recordId: string;
  content: string;
  type: L1Kind;
  priority: number;
  sceneName: string;
}

export interface ConflictMatch {
  newMemory: ConflictNewMemory;
  candidates: ConflictCandidate[];
}

export function formatBatchConflictPrompt(matches: ConflictMatch[]): string {
  const pool = new Map<string, ConflictCandidate>();
  const idsPerNew = new Map<string, string[]>();
  for (const m of matches) {
    const ids: string[] = [];
    for (const c of m.candidates) {
      if (!pool.has(c.id)) pool.set(c.id, c);
      ids.push(c.id);
    }
    idsPerNew.set(m.newMemory.recordId, ids);
  }

  const poolList = Array.from(pool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.kind,
    priority: c.priority,
    scene_name: c.sceneName,
    timestamps: [localDateTimeStr(new Date(c.createdAt))],
  }));

  const poolSection = poolList.length
    ? `## 统一候选记忆池（共 ${poolList.length} 条已有记忆）\n\n${JSON.stringify(poolList, null, 2)}`
    : "## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）";

  const memoryParts = matches.map((m, idx) => {
    const relatedIds = idsPerNew.get(m.newMemory.recordId) ?? [];
    return `### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.recordId})
${JSON.stringify(
      {
        record_id: m.newMemory.recordId,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.sceneName,
      },
      null,
      2,
    )}

【关联候选 ID】${relatedIds.length ? JSON.stringify(relatedIds) : "[]（无相似候选，直接 store）"}`;
  });

  return `**输出语言**：merged_content 与候选池已有记忆同语言。

${poolSection}

${"═".repeat(50)}

## 待判断的新记忆（共 ${matches.length} 条）

${memoryParts.join("\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n")}

请逐条判断并输出决策 JSON 数组。候选列表为空的新记忆直接输出 action=store。`;
}

// ── L2 项目画像凝练 ──

export const PERSONA_SYSTEM_PROMPT = (maxChars: number) => `# 项目画像架构师 — 增量演化协议

**输出语言**：画像正文自然语言内容与记忆条目同语言；Markdown 语法保留。

结合已有的【当前画像】和【新增/变化的记忆】，深度分析后输出更新后的项目画像（纯 Markdown 文本，不要输出思考过程）。

## 核心逻辑
寻找贯穿线，连接与综合，禁止罗列堆砌。四层扫描：
1. 基础锚点：项目是什么、目标、技术栈、当前状态（确凿事实）。
2. 约定图谱：编码规范、架构决策、禁忌、稳定工作流。
3. 交互协议：用户对 AI 的行为要求、格式/语气偏好、雷区。
4. 经验内核：可复用的方法、踩过的坑、重要决策及原因。

## ⛔ 严格禁止
- **总长度不超过 ${"MAX"} 字符**，及时总结、删除不重要信息。
- **禁止过度推测**：没提到的信息不要臆想；冷启动阶段保持克制，可缺省章节。
- **内容只能来自提供的记忆条目**，不得从路径/目录结构等元数据推断。
- 不要输出 JSON、不要包裹代码块，只输出 Markdown 画像正文。

## 输出模板（信息不足可删减章节）
# 项目画像

> **概述**：一句话定义项目与目标。

## 技术栈与约定
## 当前状态与关键决策
## 用户偏好（对 AI 的要求）
## 经验与踩坑
`;

export function getPersonaSystemPrompt(maxChars: number): string {
  return PERSONA_SYSTEM_PROMPT(maxChars).replace("MAX", String(maxChars));
}

export function formatPersonaPrompt(params: {
  mode: "first" | "incremental";
  existingProfile?: string;
  changedMemories: { kind: string; content: string; createdAt: number }[];
}): string {
  const memText = params.changedMemories
    .map((m) => `- [${m.kind}] ${m.content}`)
    .join("\n");
  if (params.mode === "first") {
    return `【首次生成】以下是该项目的全部记忆，请凝练为项目画像：\n\n${memText}`;
  }
  return `【增量更新】当前画像：\n\n${params.existingProfile ?? "（空）"}\n\n新增/变化的记忆：\n\n${memText}\n\n请基于当前画像做最小必要的更新。`;
}

// ── 技能自动抽取（DESIGN 决策 68）──

/** 待审技能候选（LLM 抽取输出，落库前置 enabled=false）。 */
export interface SkillCandidate {
  name: string;
  description: string;
  body: string;
  confidence: number;
  /** 与已有技能冲突判定：store 新增 / update 迭代（生成新版本）/ skip 丢弃。 */
  action: "store" | "update" | "skip";
  /** update 时指向被迭代的已有技能 id。 */
  target_id?: string | null;
}

export const SKILL_EXTRACT_SYSTEM_PROMPT = `你是"可复用经验萃取专家"。分析对话，抽取**可跨任务复用**的操作流程/排查方法/工作规范（Skill），并与【已有技能】去重。

**输出语言**：name/description/body 用用户消息主导语言；JSON 字段名、枚举值保持英文。

## 什么算 Skill（必须满足）
1. **可复用**：下次遇到同类任务能直接照做，而非一次性操作。
2. **有步骤**：包含明确的执行流程 / 触发边界 / 校验要点，不只是结论。
3. **成体系**：如"排查 X 类问题的标准流程""发布前检查清单""代码评审规范"。

## 什么不算 Skill（严禁抽取）
- 单纯的事实/偏好/决策（那些属于记忆，不是技能）；
- 一次性指令、临时操作、寒暄；
- 没有可执行步骤的模糊经验描述；
- AI 自身的对话行为。

## 与已有技能的关系（action 判定）
- **store**：全新技能，已有技能里没有对应项。
- **update**：与某已有技能是同一流程的改进/补全/纠错 → 输出更完整的 body，target_id 指向该已有技能 id（系统会生成新版本）。
- **skip**：已有技能已覆盖、无实质增量 → 丢弃。

## 输出格式（严格 JSON 数组，无其他内容、无 markdown 修饰符）
[
  {
    "name": "简短技能名（动宾，≤20字）",
    "description": "一句话：什么时候用这个技能（≤80字，将注入清单供模型判断是否读取正文）",
    "body": "Markdown 正文：## 适用场景 / ## 执行步骤（有序列表） / ## 校验与禁忌",
    "confidence": 0-100 整数,
    "action": "store|update|skip",
    "target_id": "update 时为已有技能 id，否则 null"
  }
]
宁缺毋滥：没有值得沉淀的可复用流程时输出空数组 []。confidence 低于阈值的不要输出。`;

export function getSkillExtractSystemPrompt(): string {
  return SKILL_EXTRACT_SYSTEM_PROMPT;
}

export interface ExistingSkillBrief {
  id: string;
  name: string;
  description: string;
}

export function formatSkillExtractPrompt(params: {
  newMessages: ExtractMessage[];
  existingSkills: ExistingSkillBrief[];
}): string {
  const fmt = (m: ExtractMessage) => `[${m.id}] [${m.role}]: ${m.content}`;
  const pool = params.existingSkills.length
    ? params.existingSkills.map((s) => `- id=${s.id} | ${s.name}：${s.description}`).join("\n")
    : "（无已有技能，新技能一律 action=store）";
  return `【已有技能清单】（用于去重判定）：\n${pool}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【本轮对话】（从中萃取可复用技能）：\n${params.newMessages.map(fmt).join("\n\n")}`;
}
