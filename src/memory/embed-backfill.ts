import type { SettingsService } from "../settings/service.js";
import type { MemoryRepo } from "./memory-repo.js";
import { embedBatch as embedBatch0, type EmbeddingConfig } from "./embedding.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("memory:embed");

export type EmbedBatchFn = (cfg: EmbeddingConfig, texts: string[]) => Promise<Float32Array[]>;

/**
 * 补嵌入：把活跃但尚无向量的记忆批量向量化写入 memory_items_vec。
 * 仅在 vec 可用且 embedding_model 已配置时工作；否则 no-op。
 * 由调度器 tick 周期调用（增量、幂等：已有向量的会被 LEFT JOIN 过滤跳过）。
 */
export class EmbeddingBackfiller {
  private readonly memories: MemoryRepo;
  private readonly settings: SettingsService;
  private readonly embedBatch: EmbedBatchFn;

  constructor(memories: MemoryRepo, settings: SettingsService, embedBatch: EmbedBatchFn = embedBatch0) {
    this.memories = memories;
    this.settings = settings;
    this.embedBatch = embedBatch;
  }

  private config(): EmbeddingConfig | null {
    if (!this.memories.vecEnabled) return null;
    return this.settings.getResolvedLlmConfig("embedding_model");
  }

  /** 处理一批缺失嵌入的记忆。返回处理条数。
   *  batch 上限 20：阿里云 DashScope 等 embedding 上游单请求 input 不超过 20 条，
   *  超则确定性 400（batch size is invalid）导致该项目每 tick 重试刷屏。 */
  async backfillProject(projectId: string, batch = 20): Promise<number> {
    const cfg = this.config();
    if (!cfg) return 0;
    const missing = this.memories.listActiveMissingEmbedding(projectId, batch);
    if (!missing.length) return 0;
    try {
      const vecs = await this.embedBatch(cfg, missing.map((m) => m.content));
      for (let i = 0; i < missing.length; i++) {
        const v = vecs[i];
        if (v) this.memories.upsertVector(missing[i]!.id, projectId, v);
      }
      return missing.length;
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "补嵌入失败（下轮重试）");
      return 0;
    }
  }
}
