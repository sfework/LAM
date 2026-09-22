import type { SettingsService } from "../settings/service.js";
import type { L1Store } from "./l1-store.js";
import { embedBatch as embedBatch0, type EmbeddingConfig } from "./embedding.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("memory:embed");

export type EmbedBatchFn = (cfg: EmbeddingConfig, texts: string[]) => Promise<Float32Array[]>;

/**
 * 补嵌入：把活跃但尚无向量的 L1 批量向量化写入 mem_l1_vec。
 * 仅在 vec 可用且 embedding_model 已配置时工作；否则 no-op。
 * 由调度器 tick 周期调用（增量、幂等：已有向量的会被 LEFT JOIN 过滤跳过）。
 */
export class EmbeddingBackfiller {
  private readonly store: L1Store;
  private readonly settings: SettingsService;
  private readonly embedBatch: EmbedBatchFn;

  constructor(store: L1Store, settings: SettingsService, embedBatch: EmbedBatchFn = embedBatch0) {
    this.store = store;
    this.settings = settings;
    this.embedBatch = embedBatch;
  }

  private config(): EmbeddingConfig | null {
    if (!this.store.vecEnabled) return null;
    const m = this.settings.getResolvedModel("embedding_model");
    return m ? { baseUrl: m.url, apiKey: m.key, model: m.model } : null;
  }

  /** 处理一批缺失嵌入的 L1。返回处理条数。 */
  async backfillProject(projectId: string, batch = 32): Promise<number> {
    const cfg = this.config();
    if (!cfg) return 0;
    const missing = this.store.listActiveMissingEmbedding(projectId, batch);
    if (!missing.length) return 0;
    try {
      const vecs = await this.embedBatch(cfg, missing.map((m) => m.content));
      for (let i = 0; i < missing.length; i++) {
        const v = vecs[i];
        if (v) this.store.upsertVector(missing[i]!.id, projectId, v);
      }
      log.debug({ projectId, count: missing.length }, "补嵌入完成");
      return missing.length;
    } catch (err) {
      log.warn({ projectId, err: String(err) }, "补嵌入失败（下轮重试）");
      return 0;
    }
  }
}
