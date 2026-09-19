import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "../infra/logger.js";
import type { SettingsService } from "../settings/service.js";
import type { LlmCallConfig } from "../llm/client.js";
import type { L1Extractor } from "./l1-extractor.js";
import type { L2Refiner } from "./l2-refiner.js";
import type { EmbeddingBackfiller } from "./embed-backfill.js";
import type { SkillExtractor } from "./skill-extractor.js";

const log = createLogger("memory:pipeline");

interface PipelineRow {
  id: string;
  project_id: string;
  session_key: string;
  conversation_count: number;
  warmup_threshold: number;
  last_l1_at: number | null;
  last_l2_at: number | null;
  buffered_message_ids: string;
  last_seen_at: number | null;
}

/**
 * 提取调度器（DESIGN §2.7，参考 pipeline-manager）。
 *
 * - 阈值触发：conversation_count >= 有效阈值（warm-up 1→2→4→8→上限）；
 * - idle 兜底：会话空闲 l1_idle_seconds 且有缓冲 → 立即提取；
 * - 同项目串行（Promise 链，并发=1）；
 * - L1 成功后按 l2_delay_seconds / l2_max_interval_hours 触发 L2 凝练；
 * - 崩溃恢复：缓冲持久化在 pipeline_state，重启后 tick 自动续跑；
 * - 关停 flush：stop 时同步处理所有待提取缓冲；
 * - extraction_enabled=false 时整体停摆（L0 仍由网关写入）。
 */
export class ExtractionScheduler {
  private readonly raw: DatabaseSync;
  private readonly settings: SettingsService;
  private readonly l1: L1Extractor;
  private readonly l2: L2Refiner;
  private readonly backfiller: EmbeddingBackfiller | null;
  private readonly skill: SkillExtractor | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly projectChains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    raw: DatabaseSync,
    settings: SettingsService,
    l1: L1Extractor,
    l2: L2Refiner,
    backfiller: EmbeddingBackfiller | null = null,
    skill: SkillExtractor | null = null,
  ) {
    this.raw = raw;
    this.settings = settings;
    this.l1 = l1;
    this.l2 = l2;
    this.backfiller = backfiller;
    this.skill = skill;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    log.info({ intervalMs }, "提取调度器已启动");
  }

  /** 关停：停止 tick 并 flush 全部缓冲。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushAll();
    // 等在途任务收尾
    await Promise.allSettled([...this.projectChains.values()]);
    log.info("提取调度器已停止（缓冲已 flush）");
  }

  private memoryLlm(): LlmCallConfig | null {
    const m = this.settings.getResolvedModel("memory_llm");
    return m ? { baseUrl: m.url, apiKey: m.key, model: m.model } : null;
  }

  /** 对所有有活跃 L1 的项目补嵌入（幂等，增量）。 */
  private async runBackfill(): Promise<void> {
    if (!this.backfiller) return;
    const projects = this.raw
      .prepare("SELECT DISTINCT project_id FROM mem_l1 WHERE deleted_at IS NULL AND superseded_by IS NULL")
      .all() as { project_id: string }[];
    for (const p of projects) {
      try {
        await this.backfiller.backfillProject(p.project_id);
      } catch (err) {
        log.warn({ projectId: p.project_id, err: String(err) }, "补嵌入异常");
      }
    }
  }

  /** 单次调度扫描。返回本轮入队的提取批次数（便于测试断言）。 */
  async tick(): Promise<number> {
    if (!this.settings.getBool("extraction_enabled")) return 0;

    // 补嵌入（用 embedding_model，独立于 memory_llm）
    await this.runBackfill();

    const llm = this.memoryLlm();
    if (!llm) return 0; // memory_llm 未配置，静默等待

    const cap = this.settings.getInt("l1_trigger_conversations");
    const warmup = this.settings.getBool("l1_warmup_enabled");
    const idleMs = this.settings.getInt("l1_idle_seconds") * 1000;
    const now = Date.now();

    const rows = this.raw
      .prepare(
        `SELECT p.*, s.last_seen_at FROM pipeline_state p
         LEFT JOIN sessions s ON s.session_key = p.session_key
         WHERE p.buffered_message_ids != '[]'`,
      )
      .all() as unknown as PipelineRow[];

    let enqueued = 0;
    for (const row of rows) {
      const buffered = parseIds(row.buffered_message_ids);
      if (!buffered.length) continue;

      const effThreshold = warmup ? (row.warmup_threshold > 0 ? row.warmup_threshold : 1) : cap;
      const idleHit = row.last_seen_at !== null && now - row.last_seen_at >= idleMs;
      const thresholdHit = row.conversation_count >= effThreshold;
      if (!thresholdHit && !idleHit) continue;

      // 先摘走缓冲（防并发重复处理），失败时回填
      this.raw
        .prepare("UPDATE pipeline_state SET buffered_message_ids = '[]', conversation_count = 0 WHERE id = ?")
        .run(row.id);
      enqueued++;
      this.enqueueProject(row.project_id, async () => {
        await this.runL1(row, buffered, effThreshold, llm);
      });
    }

    // L2 触发检查（按项目）
    await this.tickL2(llm);
    return enqueued;
  }

  private async runL1(row: PipelineRow, buffered: string[], effThreshold: number, llm: LlmCallConfig): Promise<void> {
    try {
      const res = await this.l1.extract(row.project_id, buffered, llm);
      const now = Date.now();
      // warm-up 阈值翻倍（成功才进）
      const cap = this.settings.getInt("l1_trigger_conversations");
      const next = Math.min(cap, Math.max(1, effThreshold) * 2);
      this.raw
        .prepare("UPDATE pipeline_state SET warmup_threshold = ?, last_l1_at = ? WHERE id = ?")
        .run(next, now, row.id);
      log.info({ projectId: row.project_id, ...res, nextThreshold: next }, "L1 批次完成");
      // L1 成功后按需抽技能（复用本批缓冲消息；受 skill_extract_enabled 总闸控制，失败不影响 L1 结果）
      if (this.skill?.enabled) {
        try {
          await this.skill.extract(row.project_id, buffered, llm);
        } catch (err) {
          log.warn({ projectId: row.project_id, err: String(err) }, "技能抽取异常（忽略，不影响记忆）");
        }
      }
    } catch (err) {
      log.warn({ projectId: row.project_id, err: String(err) }, "L1 批次失败，缓冲回填待重试");
      // 回填缓冲与计数
      const cur = this.raw.prepare("SELECT buffered_message_ids, conversation_count FROM pipeline_state WHERE id = ?").get(row.id) as
        | { buffered_message_ids: string; conversation_count: number }
        | undefined;
      if (cur) {
        const merged = [...parseIds(cur.buffered_message_ids), ...buffered];
        this.raw
          .prepare("UPDATE pipeline_state SET buffered_message_ids = ?, conversation_count = ? WHERE id = ?")
          .run(JSON.stringify(merged), (cur.conversation_count || 0) + row.conversation_count, row.id);
      }
    }
  }

  /** L2：L1 完成后延迟 l2_delay_seconds，或距上次 l2 超过 l2_max_interval_hours。 */
  private async tickL2(llm: LlmCallConfig): Promise<void> {
    const delayMs = this.settings.getInt("l2_delay_seconds") * 1000;
    const maxIntervalMs = this.settings.getInt("l2_max_interval_hours") * 3_600_000;
    const now = Date.now();

    const projects = this.raw
      .prepare(
        `SELECT project_id, MAX(last_l1_at) AS last_l1, MAX(last_l2_at) AS last_l2
         FROM pipeline_state GROUP BY project_id HAVING last_l1 IS NOT NULL`,
      )
      .all() as { project_id: string; last_l1: number | null; last_l2: number | null }[];

    for (const p of projects) {
      const lastL1 = p.last_l1 ?? 0;
      const lastL2 = p.last_l2 ?? 0;
      const hasNewSinceL2 = lastL1 > lastL2;
      const delayHit = hasNewSinceL2 && now - lastL1 >= delayMs;
      const intervalHit = lastL2 === 0 ? hasNewSinceL2 : now - lastL2 >= maxIntervalMs && hasNewSinceL2;
      if (!delayHit && !intervalHit) continue;

      this.enqueueProject(p.project_id, async () => {
        try {
          const version = await this.l2.refine(p.project_id, llm);
          if (version > 0) {
            this.raw
              .prepare("UPDATE pipeline_state SET last_l2_at = ? WHERE project_id = ?")
              .run(Date.now(), p.project_id);
          }
        } catch (err) {
          log.warn({ projectId: p.project_id, err: String(err) }, "L2 凝练失败");
        }
      });
    }
  }

  /** 关停 flush：忽略阈值/idle，立即处理所有缓冲。 */
  async flushAll(): Promise<void> {
    const llm = this.memoryLlm();
    if (!llm) return;
    const rows = this.raw
      .prepare("SELECT * FROM pipeline_state WHERE buffered_message_ids != '[]'")
      .all() as unknown as PipelineRow[];
    for (const row of rows) {
      const buffered = parseIds(row.buffered_message_ids);
      if (!buffered.length) continue;
      this.raw.prepare("UPDATE pipeline_state SET buffered_message_ids = '[]', conversation_count = 0 WHERE id = ?").run(row.id);
      await this.runL1(row, buffered, this.settings.getInt("l1_trigger_conversations"), llm);
    }
  }

  /** 同项目串行队列。 */
  private enqueueProject(projectId: string, task: () => Promise<void>): void {
    const prev = this.projectChains.get(projectId) ?? Promise.resolve();
    const next = prev.then(task).catch(() => undefined);
    this.projectChains.set(projectId, next);
    void next.finally(() => {
      if (this.projectChains.get(projectId) === next) this.projectChains.delete(projectId);
    });
  }
}

function parseIds(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}
