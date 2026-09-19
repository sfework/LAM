import { describe, it, expect } from "vitest";
import { chatCompletionsAdapter, firstUserText, messageText } from "../src/gateway/protocol.js";
import { deriveSessionKey } from "../src/gateway/sessions.js";
import { injectSnapshot } from "../src/gateway/snapshot.js";
import { clipList } from "../src/assets/repo.js";

describe("chatCompletionsAdapter", () => {
  it("parse 分离 model/messages/stream/extra", () => {
    const req = chatCompletionsAdapter.parse({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.7,
      tools: [{ type: "function" }],
    });
    expect(req.model).toBe("gpt-4");
    expect(req.stream).toBe(true);
    expect(req.messages).toHaveLength(1);
    expect(req.extra.temperature).toBe(0.7);
    expect(req.extra.tools).toHaveLength(1);
  });

  it("serialize 重写 model 且透传 extra（round-trip）", () => {
    const req = chatCompletionsAdapter.parse({ model: "a", messages: [{ role: "user", content: "x" }], stream: true, max_tokens: 100 });
    req.model = "b"; // 模拟网关重写
    const out = chatCompletionsAdapter.serialize(req);
    expect(out.model).toBe("b");
    expect(out.max_tokens).toBe(100);
    expect(out.stream).toBe(true);
  });

  it("非流式不带 stream 字段", () => {
    const req = chatCompletionsAdapter.parse({ model: "a", messages: [] });
    expect(chatCompletionsAdapter.serialize(req).stream).toBeUndefined();
  });
});

describe("messageText / firstUserText", () => {
  it("字符串与块数组", () => {
    expect(messageText("abc")).toBe("abc");
    expect(messageText([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }])).toBe("a\nb");
  });
  it("取首条 user", () => {
    expect(firstUserText([{ role: "system", content: "s" }, { role: "user", content: "u1" }, { role: "user", content: "u2" }])).toBe("u1");
  });
});

describe("deriveSessionKey", () => {
  it("同项目同首条消息 → 稳定", () => {
    const a = deriveSessionKey("prj1", "hello world");
    const b = deriveSessionKey("prj1", "  hello world \n");
    expect(a).toBe(b);
  });
  it("项目或消息不同 → 不同", () => {
    expect(deriveSessionKey("prj1", "x")).not.toBe(deriveSessionKey("prj2", "x"));
    expect(deriveSessionKey("prj1", "x")).not.toBe(deriveSessionKey("prj1", "y"));
  });
});

describe("injectSnapshot", () => {
  it("有 system：追加到其末尾", () => {
    const msgs = [{ role: "system", content: "base" }, { role: "user", content: "hi" }];
    const out = injectSnapshot(msgs, "SNAP");
    expect(out[0]!.content).toBe("base\n\nSNAP");
    expect(out[1]!.content).toBe("hi");
    expect(out).toHaveLength(2);
  });
  it("无 system：新建置顶", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const out = injectSnapshot(msgs, "SNAP");
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content).toBe("SNAP");
    expect(out).toHaveLength(2);
  });
  it("system content 为块数组：追加 text 块", () => {
    const msgs = [{ role: "system", content: [{ type: "text", text: "base" }] }];
    const out = injectSnapshot(msgs, "SNAP");
    const content = out[0]!.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "text", text: "SNAP" });
  });
  it("空快照原样返回", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(injectSnapshot(msgs, "  ")).toEqual(msgs);
  });
  it("不修改入参", () => {
    const msgs = [{ role: "system", content: "base" }];
    injectSnapshot(msgs, "SNAP");
    expect(msgs[0]!.content).toBe("base");
  });
});

describe("clipList", () => {
  const items = [
    { id: "kno_aaaaaaaaaa", title: "bbbbbbbbbb", description: "cccccccccc" },
    { id: "kno_cccccccccc", title: "dddddddddd", description: "eeeeeeeeee" },
  ];
  it("按条数截断", () => {
    expect(clipList(items, 1, 9999)).toHaveLength(1);
  });
  it("按字符截断（首条始终保留）", () => {
    // 每条 cost = 12+10+10+6 = 38；maxChars=40 → 只能放 1 条（第 2 条 38+38>40）
    expect(clipList(items, 99, 40)).toHaveLength(1);
  });
  it("首条超预算也保留（至少 1 条）", () => {
    expect(clipList(items, 99, 1)).toHaveLength(1);
  });
});
