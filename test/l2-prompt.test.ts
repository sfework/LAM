import { describe, it, expect } from "vitest";
import { formatPersonaPrompt, PERSONA_SYSTEM_PROMPT } from "../src/memory/prompts.js";
import { collectRemovedTopics } from "../src/memory/l2-refiner.js";

/**
 * L2 画像凝练的防污染约束（决策 87）：
 *  - 提示词禁止写入版本号/计数/对话过程/临时参数；
 *  - 功能移除时必须删除画像中旧机制段落；
 *  - collectRemovedTopics 从新增记忆提取"已移除/改为"类句子喂给模型定位。
 */

describe("PERSONA_SYSTEM_PROMPT 防污染约束", () => {
  const prompt = PERSONA_SYSTEM_PROMPT(5000);

  it("禁止记录版本号与计数", () => {
    expect(prompt).toContain("禁止记录版本号与计数");
    expect(prompt).toContain("画像版本 476");
  });

  it("禁止记录对话过程与本次改动", () => {
    expect(prompt).toContain("禁止记录对话过程与本次改动");
  });

  it("禁止描述任务状态与临时参数", () => {
    expect(prompt).toContain("禁止用\"重构中/待改进/痛点\"描述当前任务状态");
    expect(prompt).toContain("禁止记录临时参数或试错路径");
  });

  it("功能移除后必须删除旧机制段落", () => {
    expect(prompt).toContain("功能移除后必须删除对应段落");
    expect(prompt).toContain("以新增记忆为准");
  });

  it("字符上限仍被注入", () => {
    expect(prompt).toContain("总长度不超过 5000 字符");
    expect(prompt).not.toContain("${");
  });
});

describe("collectRemovedTopics", () => {
  it("命中移除/替换措辞的句子被提取", () => {
    const topics = collectRemovedTopics([
      "项目已移除过期清扫（runExpiry）及相关配置项。存量整理改为 memory_maintain。",
    ]);
    expect(topics.length).toBe(2);
    expect(topics[0]).toContain("已移除过期清扫");
    expect(topics[1]).toContain("改为 memory_maintain");
  });

  it("普通事实描述不产生条目", () => {
    expect(collectRemovedTopics(["项目使用 pnpm 管理依赖，前端为 React 19。"])).toEqual([]);
  });

  it("过短句子与重复句子被过滤", () => {
    const topics = collectRemovedTopics(["已移除 A。", "已移除 A。", "已移除同一段落里的机制 X。"]);
    expect(topics).toHaveLength(2);
  });

  it("超长句子被截断，limit 生效", () => {
    const long = `已移除${"很长".repeat(100)}。`;
    const topics = collectRemovedTopics([long, "已删除 B 项。", "已删除 C 项。"], 2);
    expect(topics).toHaveLength(2);
    expect(topics[0]!.length).toBeLessThanOrEqual(121);
  });

  it("按句读切分，一条记忆可产出多个线索", () => {
    const topics = collectRemovedTopics(["已移除 X；已下线 Y；", ]);
    expect(topics).toEqual(["已移除 X；", "已下线 Y；"]);
  });
});

describe("formatPersonaPrompt", () => {
  it("增量模式带出 removedTopics 段落", () => {
    const text = formatPersonaPrompt({
      mode: "incremental",
      existingProfile: "# 画像\n旧内容",
      changedMemories: [{ kind: "fact", content: "已移除过期清扫。", createdAt: 1 }],
      removedTopics: ["已移除过期清扫。"],
    });
    expect(text).toContain("本次涉及移除/替换的机制");
    expect(text).toContain("已移除过期清扫。");
    expect(text).toContain("请基于当前画像做最小必要的更新");
  });

  it("无 removedTopics 时不追加该段落", () => {
    const text = formatPersonaPrompt({
      mode: "incremental",
      existingProfile: "旧",
      changedMemories: [{ kind: "fact", content: "普通事实。", createdAt: 1 }],
    });
    expect(text).not.toContain("本次涉及移除/替换的机制");
  });

  it("首次生成模式不涉及 removedTopics", () => {
    const text = formatPersonaPrompt({
      mode: "first",
      changedMemories: [{ kind: "fact", content: "已移除 X。", createdAt: 1 }],
      removedTopics: ["已移除 X。"],
    });
    expect(text).toContain("【首次生成】");
    expect(text).not.toContain("本次涉及移除/替换的机制");
  });
});