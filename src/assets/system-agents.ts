import type { DatabaseSync } from "node:sqlite";
import { newId } from "../infra/id.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("assets:system");

/**
 * 系统级预置 Agent。
 *
 * 启动时 ensureSystemAgents() 保证「记忆整理Agent」存在：
 *  - 不存在 → 创建（system=1、enabled=1）；
 *  - 已存在 → **只补 system 标志，绝不覆盖 body**——用户可能已按项目习惯
 *    改写过流程，重启不得回滚人工编辑；重建 body 走管理台编辑或
 *    `pnpm seed:consolidation-agent --rebuild`。
 */

export const CONSOLIDATION_AGENT_NAME = "记忆整理Agent";

const CONSOLIDATION_AGENT_DESCRIPTION =
  "对照项目实际代码核对并整理过期记忆与画像。仅当用户明确要求整理/清理记忆、重建画像，或召回明显充斥过时内容时委派使用。";

/** 整理 Agent 定义全文（body 模板）。 */
export function buildConsolidationAgentBody(): string {
  return `# 角色
你是"项目记忆整理专员"。目标：让本项目的记忆库与画像只反映**当前代码的现实**，
清除长周期迭代积累的过时、矛盾、无增量内容。

# 前置纪律
- 仅在用户明确要求整理时启动；禁止主动发起。

# 流程
## 1. 盘点
- memory_list 分页拉全活跃记忆（建议 pageSize=100），按 kind/scene 分组。
- 通读当前画像（系统提示 <memory> 段；子代理上下文缺失时用 profile_read 读取）。

## 2. 逐组核对（核心步骤，禁止跳过）
- fact / method / artifact：逐条用文件工具在目标项目里验证——
  提到的模块/文件/配置项/流程还存在吗？表述与现状一致吗？
  验证依据必须落到具体文件路径。
- persona / instruction：不查代码，只查与画像及其他记忆的矛盾。
- episodic：仅保留仍有长期价值的事件（重大决策），其余按规则 3 处理。

## 3. 判定与执行
- keep：与现状一致 → 不动。
- update：方向正确但表述过时 → memory_update 改写为现状陈述（一条一事，
  不掺过程叙述）。
- archive：与现状冲突/功能已移除/无增量价值 → memory_archive 批量归档
  （reason 写一句判定依据，同一组判定放同一批）。
- 宁删勿滥：拿不准是否过时的，以代码现状为准；代码里找不到痕迹即归档。

## 4. 画像重建
- 基于保留+更新后的记忆集重写画像：只写最终形态，禁止版本号/计数/
  过程性描述/已移除功能的残留段落。
- profile_save 回写。

## 5. 报告
输出：keep/update/archive 条数、归档批次号 batch_id（回滚方式：
memory_restore batch_id）、画像新旧版本号、抽样列出 3 条典型归档理由。

# 红线
- 禁止物理删除；归档必须走 memory_archive（可恢复）。
- 禁止跨项目操作：project_path 一律用系统提示 <project> 段原样回传。
- 单批 archive 不超过 200 条；超过则分批并分别报告 batch_id。`;
}

export interface EnsureResult {
  created: boolean;
}

/**
 * 幂等保证系统级 Agent 就位（每次启动调用，重复执行无副作用）。
 */
export function ensureSystemAgents(db: DatabaseSync): EnsureResult {
  const existing = db
    .prepare("SELECT id, system FROM agents WHERE name = ?")
    .get(CONSOLIDATION_AGENT_NAME) as { id: string; system: number } | undefined;

  if (existing) {
    // 已存在：仅补系统级标志，body 保持现状（重启绝不覆盖人工编辑）。
    if (!existing.system) {
      db.prepare("UPDATE agents SET system = 1, updated_at = ? WHERE id = ?").run(Date.now(), existing.id);
      log.info({ id: existing.id }, "记忆整理Agent 已补系统级标志");
    }
    return { created: false };
  }

  const id = newId("agt");
  db.prepare(
    "INSERT INTO agents (id, name, description, body, enabled, sort_order, system, updated_at) VALUES (?,?,?,?,1,0,1,?)",
  ).run(id, CONSOLIDATION_AGENT_NAME, CONSOLIDATION_AGENT_DESCRIPTION, buildConsolidationAgentBody(), Date.now());
  log.info({ id }, "已自动创建系统级「记忆整理Agent」");
  return { created: true };
}
