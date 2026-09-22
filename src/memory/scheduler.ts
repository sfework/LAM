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
  // 在途批次（pipeline_state.id）：处理期间 DB 缓冲不再提前清空（防进程被 kill 丢批），
  // 靠此内存集合防止 tick 重复入队同一行（决策 72）。
  private readonly inFlight = new Set<string>();
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
    log.debug({ intervalMs }, "提取调度器已启动");
  }

  /** 关停：停止 tick 并 flush 全部缓冲。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushAll();
    // 等在途任务收尾
    await Promise.allSettled([...this.projectChains.values()]);
    log.debug("提取调度器已停止（缓冲已 flush）");
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
      if (this.inFlight.has(row.id)) continue; // 该行上一批仍在途，等其完成再评估
      const buffered = parseIds(row.buffered_message_ids);
      if (!buffered.length) continue;

      const effThreshold = warmup ? (row.warmup_threshold > 0 ? row.warmup_threshold : 1) : cap;
      const idleHit = row.last_seen_at !== null && now - row.last_seen_at >= idleMs;
      const thresholdHit = row.conversation_count >= effThreshold;
      if (!thresholdHit && !idleHit) continue;

      // 不提前清空 DB 缓冲：标记在途后入队，runL1 成功后按差集清理已处理 id，
      // 失败/进程被 kill 时缓冲原样保留（含处理期间新到消息），下轮/重启自动续跑。
      this.inFlight.add(row.id);
      enqueued++;
      this.enqueueProject(row.project_id, async () => {
        try {
          await this.runL1(row, buffered, effThreshold, llm);
        } finally {
          this.inFlight.delete(row.id);
        }
      });
    }

    // L2 触发检查（按项目）
    await this.tickL2(llm);
    return enqueued;
  }

  private async runL1(row: PipelineRow, buffered: string[], effThreshold: number, llm: LlmCallConfig): Promise<void> {
    try {
      const res = await this.l1.extract(row.project_id, buffered, llm, row.session_key);
      const now = Date.now();
      // 成功：从 DB 当前缓冲里按差集移除本批已处理 id（保留处理期间新到的），据此重算计数。
      const cur = this.raw.prepare("SELECT buffered_message_ids, conversation_count FROM pipeline_state WHERE id = ?").get(row.id) as
        | { buffered_message_ids: string; conversation_count: number }
        | undefined;
      const processed = new Set(buffered);
      const remaining = cur ? parseIds(cur.buffered_message_ids).filter((id) => !processed.has(id)) : [];
      const remainingCount = cur ? Math.max(0, (cur.conversation_count || 0) - row.conversation_count) : 0;
      // warm-up 阈值翻倍（批次执行成功即进，与是否产出记忆无关）。
      // last_l1_at 仅在本批真正产出新记忆（stored>0）时推进：0 产出批次（提取器判无新价值/
      // 全部冲突 skip）不刷新水位，避免下游 L2 把"空批次"误当成"有新料"反复触发凝练（决策 71）。
      const cap = this.settings.getInt("l1_trigger_conversations");
      const next = Math.min(cap, Math.max(1, effThreshold) * 2);
      this.raw
        .prepare("UPDATE pipeline_state SET warmup_threshold = ?, last_l1_at = COALESCE(?, last_l1_at), buffered_message_ids = ?, conversation_count = ? WHERE id = ?")
        .run(next, res.stored > 0 ? now : null, JSON.stringify(remaining), remainingCount, row.id);
      log.debug({ projectId: row.project_id, ...res, nextThreshold: next }, "L1 批次完成");
      // L1 成功后按需抽技能（复用本批缓冲消息；受 skill_extract_enabled 总闸控制，失败不影响 L1 结果）
      if (this.skill?.enabled) {
        try {
          await this.skill.extract(row.project_id, buffered, llm);
        } catch (err) {
          log.warn({ projectId: row.project_id, err: String(err) }, "技能抽取异常（忽略，不影响记忆）");
        }
      }
    } catch (err) {
      // 失败：DB 缓冲从未被提前清空，本批消息（含处理期间新到的）原样留在 buffered_message_ids，
      // 下轮 tick（或重启后）自动重试，无需回填（决策 72）。仅不动 warm-up 阈值。
      log.warn({ projectId: row.project_id, err: String(err) }, "L1 批次失败，缓冲保留待下轮重试");
    }
  }

  /** L2：L1 完成后延迟 l2_delay_seconds，或距上次 l2 超过 l2_max_interval_hours。 */
  private async tickL2(llm: LlmCallConfig): Promise<void> {
    const delayMs = this.settings.getInt("l2_delay_seconds") * 1000;
    const maxIntervalMs = this.settings.getInt("l2_max_interval_hours") * 3_600_000;
    const now = Date.now();

    // "有无新 L1" 以真实入库时间为准（mem_l1 活跃行的最大 created_at），而非 pipeline_state.last_l1_at：
    // 后者是批次执行时间，0 产出批次曾会污染它导致 L2 空转刷版本（决策 71）。
    const projects = this.raw
      .prepare(
        `SELECT p.project_id,
                (SELECT MAX(m.created_at) FROM mem_l1 m
                 WHERE m.project_id = p.project_id AND m.deleted_at IS NULL AND m.superseded_by IS NULL) AS last_l1,
                MAX(p.last_l2_at) AS last_l2
         FROM pipeline_state p GROUP BY p.project_id HAVING last_l1 IS NOT NULL`,
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
          // 增量水位 = 上次 L2 凝练时刻（手动保存画像不影响水位）
          const res = await this.l2.refine(p.project_id, llm, "incremental", lastL2);
          // failed 不推进水位（下轮 tick 重试）；其余状态均推进，防同批 L1 反复触发凝练。
          if (res.status !== "failed") {
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
      if (this.inFlight.has(row.id)) continue; // 该行仍被 tick 队列处理中，避免重复消费同一批
      const buffered = parseIds(row.buffered_message_ids);
      if (!buffered.length) continue;
      // runL1 成功才按差集清理缓冲；失败保留（flushAll 同步等待，进程正常退出时缓冲已处理）。
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
