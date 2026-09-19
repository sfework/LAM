/**
 * RRF（Reciprocal Rank Fusion）——与参考项目 search-utils 同款算法。
 * score = Σ 1/(k + rank + 1)，k=60。
 */
export const RRF_K = 60;

export function rrfMerge<T>(
  lists: T[][],
  getId: (item: T) => string,
  k: number = RRF_K,
): { item: T; rrfScore: number }[] {
  const map = new Map<string, { item: T; rrfScore: number }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      const id = getId(item);
      const score = 1 / (k + rank + 1);
      const existing = map.get(id);
      if (existing) existing.rrfScore += score;
      else map.set(id, { item, rrfScore: score });
    }
  }
  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}
