/**
 * 向量化服务（DESIGN §2.7）：OpenAI-compatible /embeddings，维度固定 1024。
 * 未配置 embedding_model 时 hasEmbedding=false，召回降级为纯 BM25。
 */

export const EMBEDDING_DIM = 1024;

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function joinEmbedUrl(base: string): string {
  const b = base.replace(/\/+$/, "");
  if (/\/embeddings$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/embeddings`;
  return `${b}/v1/embeddings`;
}

/** 单条文本向量化；维度不符抛错（配置错误应尽早暴露）。 */
export async function embedText(cfg: EmbeddingConfig, text: string, timeoutMs = 30_000): Promise<Float32Array> {
  const [v] = await embedBatch(cfg, [text], timeoutMs);
  if (!v) throw new Error("Embedding 返回空结果");
  return v;
}

export async function embedBatch(cfg: EmbeddingConfig, texts: string[], timeoutMs = 60_000): Promise<Float32Array[]> {
  const res = await fetch(joinEmbedUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Embedding 上游 ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  const list = json?.data ?? [];
  return list.map((d) => {
    const emb = d.embedding;
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
      throw new Error(`Embedding 维度不符：期望 ${EMBEDDING_DIM}，实际 ${emb?.length ?? 0}（请检查 embedding_model 配置）`);
    }
    return new Float32Array(emb);
  });
}

/** Float32Array → sqlite-vec 接受的 BLOB（实测 Buffer 绑定最稳）。 */
export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
