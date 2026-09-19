import { describe, it, expect } from "vitest";
import { parseWorkspacePath, matchPath } from "../src/projects/parse-workspace.js";

describe("matchPath", () => {
  it("匹配带 bullet 的 Windows 路径", () => {
    expect(matchPath("- d:\\Work\\MyProject")).toBe("d:\\Work\\MyProject");
    expect(matchPath("  - d:/Work/MyProject")).toBe("d:/Work/MyProject");
  });
  it("匹配裸盘符路径行", () => {
    expect(matchPath("d:\\Work\\DEMO")).toBe("d:\\Work\\DEMO");
  });
  it("只取首个命中行", () => {
    expect(matchPath("- e:\\A\n- e:\\B")).toBe("e:\\A");
  });
  it("行中出现的路径不匹配（须行首）", () => {
    expect(matchPath("see d:\\Work\\foo")).toBeNull();
  });
  it("无路径返回 null", () => {
    expect(matchPath("no path here")).toBeNull();
    expect(matchPath("")).toBeNull();
  });
});

describe("parseWorkspacePath", () => {
  const sysMsg = (text: string) => ({ role: "system", content: text });
  const userMsg = (text: string) => ({ role: "user", content: text });

  it("从 <workspace_info> 段提取", () => {
    const body = {
      messages: [
        sysMsg(
          "prefix\n<workspace_info>\nI am working in a workspace:\n- d:\\Work\\MyProject\n</workspace_info>\nsuffix",
        ),
      ],
    };
    expect(parseWorkspacePath(body)).toBe("d:\\Work\\MyProject");
  });

  it("段收口：不越界扫到正文里的路径", () => {
    const body = {
      messages: [
        sysMsg("<workspace_info>\n- e:\\Real\\Proj\n</workspace_info>\nlater - c:\\Other\\Noise"),
      ],
    };
    expect(parseWorkspacePath(body)).toBe("e:\\Real\\Proj");
  });

  it("段可落在任意角色消息上", () => {
    const body = {
      messages: [
        sysMsg("no info here"),
        userMsg("<workspace_info>\n- d:\\Work\\App\n</workspace_info>"),
      ],
    };
    expect(parseWorkspacePath(body)).toBe("d:\\Work\\App");
  });

  it("段缺失时仅在 system 兜底（行首路径）", () => {
    const body = {
      messages: [sysMsg("workspace root:\ne:\\Sys\\Fallback"), userMsg("list - c:\\Users\\Bob")],
    };
    expect(parseWorkspacePath(body)).toBe("e:\\Sys\\Fallback");
  });

  it("兜底不扫 user 消息（防目录列表误判）", () => {
    const body = {
      messages: [sysMsg("nothing"), userMsg("- c:\\some\\dir\\list")],
    };
    expect(parseWorkspacePath(body)).toBeNull();
  });

  it("content 为块数组也能解析", () => {
    const body = {
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "<workspace_info>\n- e:\\Blocks\\Proj\n</workspace_info>" }],
        },
      ],
    };
    expect(parseWorkspacePath(body)).toBe("e:\\Blocks\\Proj");
  });

  it("无 messages / 非法输入返回 null", () => {
    expect(parseWorkspacePath({})).toBeNull();
    expect(parseWorkspacePath(null)).toBeNull();
    expect(parseWorkspacePath({ messages: "bad" })).toBeNull();
  });
});
