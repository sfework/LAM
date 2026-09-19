/**
 * FTS5 分词预处理（DESIGN §2.7 / PLAN 风险项）。
 *
 * node:sqlite 的 unicode61 分词器不切中文：整段 CJK 会成为一个 token，命中率暴跌。
 * 方案：索引与查询两侧统一做「CJK 二元组 + 拉丁词」预切分，用空格连接后交给 FTS5。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN = /[a-zA-Z0-9_]+/g;

/** 文本 → FTS token 串（小写；CJK 按二元组，单字 run 保留单字）。 */
export function tokenizeForFts(text: string): string {
  if (!text) return "";
  const tokens: string[] = [];

  // 拉丁词
  for (const m of text.matchAll(LATIN)) tokens.push(m[0].toLowerCase());

  // CJK 二元组（重叠）
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens.join(" ");
}

/** 构造 MATCH 查询：token 间 OR，加引号防特殊字符；限前 64 个 token。 */
export function buildFtsQuery(text: string): string {
  const toks = tokenizeForFts(text)
    .split(" ")
    .filter(Boolean)
    .slice(0, 64);
  if (!toks.length) return "";
  // 去重
  const uniq = [...new Set(toks)];
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function containsCjk(text: string): boolean {
  return CJK.test(text);
}
