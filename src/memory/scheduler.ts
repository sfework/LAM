import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "../infra/logger.js";
import type { SettingsService } from "../settings/service.js";
import type { LlmCallConfig } from "../llm/client.js";
import type { MemoryExtractor } from "./extractor.js";
import type { ProfileRefiner } from "./profile-refiner.js";
import type { EmbeddingBackfiller } from "./embed-backfill.js";

const log = createLogger("memory:pipeline");

interface PipelineRow {
  id: string;
  project_id: string;
  session_key: string;
  user_msg_count: number;
  last_profile_at: number | null;
  buffered_message_ids: string;
}

/**
 * 提取调度器。
 *
 * - 阈值触发：user_msg_count >= memory_trigger_user_messages（唯一触发路径）；
 *   计数口径为**未提炼的对话中 user 消息条数**（不是轮数），纯 assistant 轮不推进；
 * - 同项目串行（Promise 链，并发=1）；
 * - 记忆新入库后按 profile_delay_seconds 冷却触发画像凝练；
 * - 崩溃恢复：缓冲持久化在 pipeline_states，重启后 tick 自动续跑；
 * - 关停 flush：stop 时同步处理所有待提取缓冲；
 * - 写侧提取常驻开启（无总闸；关掉想停提取只能不绑 memory_llm，对话始终由网关写入）。
 *
 * 说明：存量整理与对话内自维护均不在调度器职责内（由「记忆整理Agent」经 MCP 工具面承担），
 * 调度器只负责写入侧；存量错旧条目由管理台改删。
 */
export class ExtractionScheduler {
  private readonly db: DatabaseSync;
  private readonly settings: SettingsService;
  private readonly extractor: MemoryExtractor;
  private readonly refiner: ProfileRefiner;
  private readonly backfiller: EmbeddingBackfiller | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly projectChains = new Map<string, Promise<void>>();
  // 在途批次（pipeline_states.id）：处理期间 DB 缓冲不再提前清空（防进程被 kill 丢批），
  // 靠此内存集合防止 tick 重复入队同一行。
  private readonly inFlight = new Set<string>();
  // 画像在途项目集：refine 入队后在水位推进前，后续 tick 仍会判定"有新记忆"，
  // 无此集合会重复入队同一项目的凝练（LLM 成本翻倍）。
  private readonly profileInFlight = new Set<string>();
  // tick 重入闸门：tick 内含 backfill 等 IO（embedBatch 超时上限远超 5s 间隔），
  // 上一轮未结束时跳过本轮，防同一批缺失向量被并发多次向量化。
  private ticking = false;

  constructor(
    db: DatabaseSync,
    settings: SettingsService,
    extractor: MemoryExtractor,
    refiner: ProfileRefiner,
    backfiller: EmbeddingBackfiller | null = null,
  ) {
    this.db = db;
    this.settings = settings;
    this.extractor = extractor;
    this.refiner = refiner;
    this.backfiller = backfiller;
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  /** 关停：停止 tick 并 flush 全部缓冲。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushAll();
    // 等在途任务收尾
    await Promise.allSettled([...this.projectChains.values()]);
  }

  private memoryLlm(): LlmCallConfig | null {
    return this.settings.getResolvedLlmConfig("memory_llm");
  }

  /** 对所有有活跃记忆的项目补嵌入（幂等，增量）。 */
  private async runBackfill(): Promise<void> {
    if (!this.backfiller) return;
    const projects = this.db
      .prepare("SELECT DISTINCT project_id FROM memory_items WHERE deleted_at IS NULL AND superseded_by IS NULL")
      .all() as { project_id: string }[];
    for (const p of projects) {
      try {
        await this.backfiller.backfillProject(p.project_id);
      } catch (err) {
        log.warn({ projectId: p.project_id, err: String(err) }, "补嵌入异常");
      }
    }
  }

  /** 单次调度扫描（写侧提取常驻开启，无总闸；memory_llm 未绑定时自然停摆）。返回本轮入队的提取批次数（便于测试断言）。 */
  async tick(): Promise<number> {
    // 重入保护：backfill 含网络 IO（可达数十秒），上一轮未结束时跳过本轮，
    // 防同一批缺失向量被并发重复向量化（LLM/embedding 成本翻倍）。
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<number> {
    // 补嵌入（用 embedding_model，独立于 memory_llm）
    await this.runBackfill();

    const llm = this.memoryLlm();
    if (!llm) return 0; // memory_llm 未配置，静默等待

    const cap = this.settings.getInt("memory_trigger_user_messages");

    const rows = this.db
      .prepare(`SELECT * FROM pipeline_states WHERE buffered_message_ids != '[]'`)
      .all() as unknown as PipelineRow[];

    let enqueued = 0;
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue; // 该行上一批仍在途，等其完成再评估
      const buffered = parseIds(row.buffered_message_ids);
      if (!buffered.length) continue;

      const thresholdHit = row.user_msg_count >= cap;
      if (!thresholdHit) continue;

      // 不提前清空 DB 缓冲：标记在途后入队，提取成功后按差集清理已处理 id，
      // 失败/进程被 kill 时缓冲原样保留（含处理期间新到消息），下轮/重启自动续跑。
      this.inFlight.add(row.id);
      enqueued++;
      this.enqueueProject(row.project_id, async () => {
        try {
          await this.runExtract(row, buffered, llm);
        } finally {
          this.inFlight.delete(row.id);
        }
      });
    }

    // 画像触发检查（按项目）
    await this.tickProfile(llm);
    return enqueued;
  }

  private async runExtract(row: PipelineRow, buffered: string[], llm: LlmCallConfig): Promise<void> {
    try {
      await this.extractor.extract(row.project_id, buffered, llm, row.session_key);
      // 成功：从 DB 当前缓冲里按差集移除本批已处理 id（保留处理期间新到的），据此重算计数。
      const cur = this.db.prepare("SELECT buffered_message_ids, user_msg_count FROM pipeline_states WHERE id = ?").get(row.id) as
        | { buffered_message_ids: string; user_msg_count: number }
        | undefined;
      const processed = new Set(buffered);
      const remaining = cur ? parseIds(cur.buffered_message_ids).filter((id) => !processed.has(id)) : [];
      // 扣减量 = 本批缓冲里的 user 条数（不是批次数）；余量按剩余缓冲里的 user 条数重算，
      // 以缓冲实况为准，避开与处理期间新到消息的计数竞态。
      const remainingCount = remaining.length ? this.countUserConversations(remaining) : 0;
      this.db
        .prepare("UPDATE pipeline_states SET buffered_message_ids = ?, user_msg_count = ? WHERE id = ?")
        .run(JSON.stringify(remaining), remainingCount, row.id);
    } catch (err) {
      // 失败：DB 缓冲从未被提前清空，本批消息（含处理期间新到的）原样留在 buffered_message_ids，
      // 下轮 tick（或重启后）自动重试，无需回填。
      log.warn({ projectId: row.project_id, err: String(err) }, "提取批次失败，缓冲保留待下轮重试");
    }
  }

  /**
   * 统计一批对话 id 中 role='user' 的条数（提取成功后重算触发计数用）。
   * 分片查询防 IN 参数上限（缓冲异常大时也不会报错）。
   */
  private countUserConversations(ids: string[]): number {
    let n = 0;
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const r = this.db
        .prepare(`SELECT COUNT(*) AS c FROM conversations WHERE role = 'user' AND id IN (${part.map(() => "?").join(",")})`)
        .get(...part) as { c: number };
      n += Number(r.c);
    }
    return n;
  }

  /** 画像：新记忆入库后延迟 profile_delay_seconds 触发凝练（唯一路径）；门控开启时先分类，仅 immediate 或连续跳过达上限才凝练。 */
  private async tickProfile(llm: LlmCallConfig): Promise<void> {
    const delayMs = this.settings.getInt("profile_delay_seconds") * 1000;
    const gateOn = this.settings.getBool("profile_gate_enabled");
    const maxStreak = this.settings.getInt("profile_gate_max_skip_streak");
    const now = Date.now();

    // "有无新记忆"以真实入库时间为准（memory_items 活跃行的最大 created_at）：
    // 批次执行时间无法区分 0 产出批次，曾导致画像空转刷版本。
    const projects = this.db
      .prepare(
        `SELECT p.project_id,
                (SELECT MAX(m.created_at) FROM memory_items m
                 WHERE m.project_id = p.project_id AND m.deleted_at IS NULL AND m.superseded_by IS NULL) AS last_memory,
                MAX(p.last_profile_at) AS last_profile
         FROM pipeline_states p GROUP BY p.project_id HAVING last_memory IS NOT NULL`,
      )
      .all() as { project_id: string; last_memory: number | null; last_profile: number | null }[];

    for (const p of projects) {
      const lastMemory = p.last_memory ?? 0;
      const lastProfile = p.last_profile ?? 0;
      const hasNewSinceProfile = lastMemory > lastProfile;
      if (!(hasNewSinceProfile && now - lastMemory >= delayMs)) continue;
      if (this.profileInFlight.has(p.project_id)) continue; // 该项目凝练仍在途，防重复入队刷 LLM

      // 门控：分类为 reinforcement/none 时跳过本轮并累计跳过数；连续达上限兜底强制凝练。
      // 跳过判定记录水位（gated_memory_ts）：该批记忆内不再重复调门控（tick 每 5s 一轮，
      // 防同批反复花门控 LLM 成本）；有新记忆入库（last_memory 超过水位）才重新判定。
      if (gateOn) {
        const gs = this.getGateState(p.project_id);
        if (gs.skip_streak >= maxStreak) {
          log.info({ projectId: p.project_id, streak: gs.skip_streak }, "画像门控连续跳过达上限，兜底强制凝练");
        } else if (gs.gated_memory_ts >= lastMemory) {
          // 该批记忆已判定过跳过且无新增：静默等下一批，不重复调门控
          continue;
        } else {
          const g = await this.refiner.gate(p.project_id, llm, lastProfile);
          if (!g.immediate) {
            this.setGateState(p.project_id, gs.skip_streak + 1, lastMemory);
            log.info({ projectId: p.project_id, label: g.label, streak: gs.skip_streak + 1 }, "画像门控判定无需凝练，本轮跳过");
            continue;
          }
          // 放行：清零计数与水位（凝练成功后由 finally 段再清一次，防本批在途时重复触发）
          this.setGateState(p.project_id, 0, 0);
        }
      }

      this.profileInFlight.add(p.project_id);
      this.enqueueProject(p.project_id, async () => {
        try {
          // 增量水位 = 上次画像凝练时刻（手动保存画像不影响水位）
          const res = await this.refiner.refine(p.project_id, llm, "incremental", lastProfile);
          // failed 不推进水位（下轮 tick 重试）；其余状态均推进，防同批记忆反复触发凝练。
          if (res.status !== "failed") {
            this.db
              .prepare("UPDATE pipeline_states SET last_profile_at = ? WHERE project_id = ?")
              .run(Date.now(), p.project_id);
            this.setGateState(p.project_id, 0, 0);
          }
        } catch (err) {
          log.warn({ projectId: p.project_id, err: String(err) }, "画像凝练失败");
        } finally {
          this.profileInFlight.delete(p.project_id);
        }
      });
    }
  }

  /** 读门控状态（连续跳过计数 + 已判定水位；无行返回零值）。 */
  private getGateState(projectId: string): { skip_streak: number; gated_memory_ts: number } {
    const r = this.db
      .prepare("SELECT skip_streak, gated_memory_ts FROM profile_gate_states WHERE project_id = ?")
      .get(projectId) as { skip_streak: number; gated_memory_ts: number } | undefined;
    return r ?? { skip_streak: 0, gated_memory_ts: 0 };
  }

  /** 写门控状态（upsert）。 */
  private setGateState(projectId: string, streak: number, gatedMemoryTs: number): void {
    this.db
      .prepare(
        `INSERT INTO profile_gate_states (project_id, skip_streak, gated_memory_ts, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET skip_streak = excluded.skip_streak, gated_memory_ts = excluded.gated_memory_ts, updated_at = excluded.updated_at`,
      )
      .run(projectId, streak, gatedMemoryTs, Date.now());
  }

  /** 关停 flush：忽略阈值，立即处理所有缓冲。 */
  async flushAll(): Promise<void> {
    const llm = this.memoryLlm();
    if (!llm) return;
    const rows = this.db
      .prepare("SELECT * FROM pipeline_states WHERE buffered_message_ids != '[]'")
      .all() as unknown as PipelineRow[];
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue; // 该行仍被 tick 队列处理中，避免重复消费同一批
      const buffered = parseIds(row.buffered_message_ids);
      if (!buffered.length) continue;
      // runExtract 成功才按差集清理缓冲；失败保留（flushAll 同步等待，进程正常退出时缓冲已处理）。
      await this.runExtract(row, buffered, llm);
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
