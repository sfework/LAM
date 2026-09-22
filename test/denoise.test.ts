import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  applyRuleToText,
  applyRulesToText,
  selectRules,
  denoiseMessages,
  type DenoiseRuleData,
} from "../src/denoise/engine.js";
import { DenoiseRepo } from "../src/denoise/repo.js";
import { runMigrations } from "../src/db/migrate.js";

function rule(partial: Partial<DenoiseRuleData> & { startText: string; endText: string }): DenoiseRuleData {
  return {
    id: partial.id ?? "r",
    extract: false,
    applyForward: true,
    applyMemory: true,
    enabled: true,
    createdAt: 0,
    ...partial,
  };
}

describe("applyRuleToText", () => {
  const r = rule({ startText: "<sys>", endText: "</sys>" });

  it("删除区间含两端标记", () => {
    expect(applyRuleToText("a<sys>noise</sys>b", r)).toBe("ab");
  });
  it("未闭合（只有开头）不删", () => {
    expect(applyRuleToText("a<sys>noise", r)).toBe("a<sys>noise");
  });
  it("孤立结尾标记不删", () => {
    expect(applyRuleToText("a</sys>b", r)).toBe("a</sys>b");
  });
  it("多处命中全删", () => {
    expect(applyRuleToText("x<sys>1</sys>y<sys>2</sys>z", r)).toBe("xyz");
  });
  it("非贪婪：跨两段不误删中间内容", () => {
    expect(applyRuleToText("<sys>a</sys> keep <sys>b</sys>", r)).toBe(" keep ");
  });
  it("跨行匹配", () => {
    expect(applyRuleToText("line1<sys>\nmulti\nline</sys>line2", r)).toBe("line1line2");
  });
  it("特殊字符按字面量转义", () => {
    const rr = rule({ startText: "(a.+b)?[x]", endText: "$end*" });
    expect(applyRuleToText("keep(a.+b)?[x]DROP$end*keep2", rr)).toBe("keepkeep2");
  });
  it("start==end 退化为删除所有出现", () => {
    const rr = rule({ startText: "[NOISE]", endText: "[NOISE]" });
    expect(applyRuleToText("a[NOISE]b[NOISE]c", rr)).toBe("abc");
  });
  it("空文本/空标记原样返回", () => {
    expect(applyRuleToText("", r)).toBe("");
    expect(applyRuleToText("abc", rule({ startText: "", endText: "x" }))).toBe("abc");
  });
});

describe("applyRuleToText 提取模式", () => {
  const ex = rule({ startText: "<ctx>", endText: "</ctx>", extract: true });

  it("保留中间内容，剥掉两端标记", () => {
    expect(applyRuleToText("a<ctx>keep</ctx>b", ex)).toBe("akeepb");
  });
  it("多处命中全提取", () => {
    expect(applyRuleToText("<ctx>1</ctx> x <ctx>2</ctx>", ex)).toBe("1 x 2");
  });
  it("未闭合不处理", () => {
    expect(applyRuleToText("a<ctx>open", ex)).toBe("a<ctx>open");
  });
  it("保留内容含 $ 特殊序列不被转义", () => {
    expect(applyRuleToText("<ctx>$& $1 $'</ctx>", ex)).toBe("$& $1 $'");
  });
  it("start==end 时提取退化为删除", () => {
    const rr = rule({ startText: "[SEP]", endText: "[SEP]", extract: true });
    expect(applyRuleToText("a[SEP]b", rr)).toBe("ab");
  });
  it("与删除规则叠加：各自生效", () => {
    const del = rule({ startText: "<del>", endText: "</del>", createdAt: 1 });
    ex.createdAt = 0;
    expect(applyRulesToText("1<ctx>c</ctx>2<del>d</del>3", [ex, del])).toBe("1c23");
  });
});

describe("applyRulesToText", () => {
  it("多规则叠加", () => {
    const r1 = rule({ startText: "<a>", endText: "</a>" });
    const r2 = rule({ startText: "<b>", endText: "</b>" });
    expect(applyRulesToText("1<a>x</a>2<b>y</b>3", [r1, r2])).toBe("123");
  });
});

describe("selectRules", () => {
  const fwd = rule({ id: "f", startText: "s", endText: "e", applyForward: true, applyMemory: false, createdAt: 2 });
  const mem = rule({ id: "m", startText: "s2", endText: "e2", applyForward: false, applyMemory: true, createdAt: 1 });
  const off = rule({ id: "o", startText: "s3", endText: "e3", enabled: false, createdAt: 0 });

  it("按通道筛选", () => {
    expect(selectRules([fwd, mem, off], "forward").map((r) => r.id)).toEqual(["f"]);
    expect(selectRules([fwd, mem, off], "memory").map((r) => r.id)).toEqual(["m"]);
  });
  it("按 createdAt 升序（应用顺序）", () => {
    const a = rule({ id: "a", startText: "x", endText: "y", createdAt: 10 });
    const b = rule({ id: "b", startText: "x", endText: "y", createdAt: 5 });
    expect(selectRules([a, b], "forward").map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("denoiseMessages", () => {
  const r = rule({ startText: "<noise>", endText: "</noise>" });

  it("仅处理 user/assistant，tool 不动", () => {
    const msgs = [
      { role: "system", content: "keep<noise>x</noise>" },
      { role: "user", content: "hi<noise>y</noise>" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "<noise>a</noise>", tool_call_id: "t1" },
    ];
    const out = denoiseMessages(msgs, [r], "forward");
    expect(out[0]!.content).toBe("keep<noise>x</noise>"); // system 不处理（由注入管线另行处理）
    expect(out[1]!.content).toBe("hi"); // "hi<noise>y</noise>" 删除区间含标记 → "hi"
    expect(out[3]!.content).toBe("<noise>a</noise>"); // tool 不处理
  });
  it("块数组只处理 text 块", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "a<noise>b</noise>c" },
          { type: "image_url", image_url: { url: "u<noise>v</noise>w" } },
        ],
      },
    ];
    const out = denoiseMessages(msgs, [r], "forward");
    const content = out[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]!.text).toBe("ac");
    expect((content[1]!.image_url as { url: string }).url).toBe("u<noise>v</noise>w");
  });
  it("双通道独立：forward 用规则集 A，memory 用规则集 B", () => {
    const ra = rule({ id: "ra", startText: "[A]", endText: "[/A]", applyForward: true, applyMemory: false });
    const rb = rule({ id: "rb", startText: "[B]", endText: "[/B]", applyForward: false, applyMemory: true });
    const msgs = [{ role: "user", content: "1[A]x[/A]2[B]y[/B]3" }];
    expect((denoiseMessages(msgs, [ra, rb], "forward")[0]!.content as string)).toBe("12[B]y[/B]3");
    expect((denoiseMessages(msgs, [ra, rb], "memory")[0]!.content as string)).toBe("1[A]x[/A]23");
  });
  it("不修改入参", () => {
    const msgs = [{ role: "user", content: "a<noise>b</noise>" }];
    const out = denoiseMessages(msgs, [r], "forward");
    expect(msgs[0]!.content).toBe("a<noise>b</noise>");
    expect(out[0]!.content).toBe("a"); // 删除 <noise>b</noise>（含标记）→ "a"
  });

  it("后处理：降噪后 trim 首尾空白（含空行）", () => {
    const msgs = [{ role: "user", content: "\n\n  hi<noise>x</noise>  \n" }];
    expect(denoiseMessages(msgs, [r], "forward")[0]!.content).toBe("hi");
  });
  it("后处理：零规则也 trim（与是否命中无关）", () => {
    const msgs = [{ role: "assistant", content: "  hello \n\n" }];
    expect(denoiseMessages(msgs, [], "forward")[0]!.content).toBe("hello");
  });
  it("后处理：trim 后为空的消息整条删除", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "  \n " }, // 纯空白 → 删
      { role: "assistant", content: "<noise>a</noise>" }, // 命中后剩空 → 删
      { role: "user", content: "keep" },
    ];
    const out = denoiseMessages(msgs, [r], "forward");
    expect(out.map((m) => m.content)).toEqual(["sys", "keep"]);
  });
  it("后处理：带 tool_calls 的 assistant 空 content 不删", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "t1" },
    ];
    const out = denoiseMessages(msgs, [r], "forward");
    expect(out).toHaveLength(2);
  });
  it("后处理：块数组 text 块 trim，全空文本块且无非文本块则删除", () => {
    const empty = [{ role: "user", content: [{ type: "text", text: "  <noise>x</noise> " }] }];
    expect(denoiseMessages(empty, [r], "forward")).toHaveLength(0);
    const withImage = [
      { role: "user", content: [{ type: "text", text: "  " }, { type: "image_url", image_url: { url: "u" } }] },
    ];
    const out = denoiseMessages(withImage, [r], "forward");
    expect(out).toHaveLength(1); // 有非文本块，保留
  });
});

describe("DenoiseRepo", () => {
  let raw: DatabaseSync;
  let repo: DenoiseRepo;
  beforeEach(() => {
    raw = new DatabaseSync(":memory:");
    runMigrations(raw);
    repo = new DenoiseRepo(raw);
  });

  it("增删改查", () => {
    const c = repo.create({ startText: "<a>", endText: "</a>" });
    expect(c.id).toMatch(/^dr_/);
    expect(c.enabled).toBe(false); // 默认关闭
    expect(c.extract).toBe(false); // 默认删除模式
    expect(c.applyForward).toBe(true);
    expect(c.applyMemory).toBe(true);
    const u = repo.update(c.id, { enabled: true, extract: true });
    expect(u?.enabled).toBe(true);
    expect(u?.extract).toBe(true);
    expect(repo.list()).toHaveLength(1);
    expect(repo.delete(c.id)).toBe(true);
    expect(repo.list()).toHaveLength(0);
  });

  it("list 按 createdAt 升序", () => {
    repo.create({ startText: "s1", endText: "e1" });
    repo.create({ startText: "s2", endText: "e2" });
    const ids = repo.list().map((r) => r.startText);
    expect(ids).toEqual(["s1", "s2"]);
  });
});
