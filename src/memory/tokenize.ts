/**
 * FTS5 分词预处理（DESIGN §2.7 / PLAN 风险项）。
 *
 * node:sqlite 的 unicode61 分词器不切中文：整段 CJK 会成为一个 token，命中率暴跌。
 * 方案：索引与查询两侧统一做「CJK 二元组 + 拉丁词」预切分，用空格连接后交给 FTS5。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN = /[a-zA-Z0-9_]+/g;

/**
 * 中文停用词（token 级精确匹配，参考 tdai ZH_STOP_WORDS）。
 *
 * 仅收录纯语法字与寒暄/填充 bigram，用于查询侧过滤低信息量输入
 * （"好的""是啊"等），避免这类语句产生噪音召回。
 * 采用「整 token 精确命中」而非「逐字符皆停用」，防止误删"好看""执行"等实义组合。
 * 只作用于查询侧 buildFtsQuery，写入侧 tokenizeForFts 不过滤（保索引完整）。
 */
export const ZH_STOP_TOKENS = new Set([
  // 高频语法单字
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "都", "一", "上", "也",
  "很", "到", "说", "要", "去", "你", "会", "着", "看", "好", "这", "那", "他",
  "她", "它", "们", "吗", "吧", "呢", "啊", "呀", "哦", "嗯", "把", "被", "让",
  "给", "对", "与", "或", "但", "而", "于", "其", "之",
  // 寒暄/填充/指代 bigram
  "好的", "是的", "对吧", "好啊", "好吧", "嗯嗯", "哦哦", "哎呀", "这个", "那个",
  "这样", "那样", "就是", "然后", "但是", "因为", "所以", "如果", "我们", "你们",
  "他们", "可以", "没有", "什么", "怎么", "如何",
]);

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

/** 构造 MATCH 查询：token 间 OR，加引号防特殊字符；过滤停用词；限前 64 个 token。 */
export function buildFtsQuery(text: string): string {
  const toks = tokenizeForFts(text)
    .split(" ")
    .filter((t) => t && !ZH_STOP_TOKENS.has(t))
    .slice(0, 64);
  if (!toks.length) return "";
  // 去重
  const uniq = [...new Set(toks)];
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * 判断文本经停用词过滤后是否仍有有效检索 token。
 * 用于召回侧短路：纯寒暄/语法字（"好的"）返回 false，跳过检索避免噪音。
 */
export function hasMeaningfulQuery(text: string): boolean {
  return buildFtsQuery(text) !== "";
}

export function containsCjk(text: string): boolean {
  return CJK.test(text);
}
