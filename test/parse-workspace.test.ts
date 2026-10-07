import { describe, it, expect } from "vitest";
import { parseWorkspacePath, matchPath, matchCwdLine, matchCwdSection } from "../src/projects/parse-workspace.js";

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

  it("pi v1.x：<cwd> 段（Windows 转正斜杠）", () => {
    const body = {
      messages: [sysMsg("preamble\n<cwd>\nE:/Code/LAM\n</cwd>\n<tools>\n- read\n</tools>")],
    };
    expect(parseWorkspacePath(body)).toBe("E:/Code/LAM");
  });

  it("pi v1.x：<cwd> 段优先于 cwd 标注行", () => {
    const body = {
      messages: [sysMsg("<cwd>\n/home/user/proj\n</cwd>\nCurrent working directory: d:\\Noise")],
    };
    expect(parseWorkspacePath(body)).toBe("/home/user/proj");
  });

  it("pi v1.x：<cwd> 段内非绝对路径时回退其他兜底", () => {
    const body = {
      messages: [sysMsg("<cwd>\nrelative\\path\n</cwd>\nworkspace root:\ne:\\Sys\\Fallback")],
    };
    expect(parseWorkspacePath(body)).toBe("e:\\Sys\\Fallback");
  });

  it("pi 格式：system 内 Current working directory 行（Windows）", () => {
    const body = {
      messages: [sysMsg("You are a coding agent.\n\nCurrent working directory: e:\\code\\lam\n\nOther text")],
    };
    expect(parseWorkspacePath(body)).toBe("e:\\code\\lam");
  });

  it("pi 格式：Unix 绝对路径", () => {
    const body = {
      messages: [sysMsg("Current working directory: /home/user/projects/app")],
    };
    expect(parseWorkspacePath(body)).toBe("/home/user/projects/app");
  });

  it("pi 格式：优先于行首盘符兜底", () => {
    const body = {
      messages: [sysMsg("workspace root:\nd:\\Sys\\Noise\nCurrent working directory: e:\\Real\\Proj")],
    };
    expect(parseWorkspacePath(body)).toBe("e:\\Real\\Proj");
  });

  it("pi 格式：user 消息里的 cwd 行不扫（防工具输出误判）", () => {
    const body = {
      messages: [sysMsg("nothing"), userMsg("Current working directory: d:\\Fake\\From\\Transcript")],
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

describe("matchCwdSection", () => {
  it("取段内首行", () => {
    expect(matchCwdSection("<cwd>\nE:/Code/LAM\n</cwd>")).toBe("E:/Code/LAM");
    expect(matchCwdSection("<cwd>\r\n/home/u/p\r\n</cwd>")).toBe("/home/u/p");
  });
  it("同行写法", () => {
    expect(matchCwdSection("<cwd>d:\\Work\\P</cwd>")).toBe("d:\\Work\\P");
  });
  it("空段/非绝对路径/无段返回 null", () => {
    expect(matchCwdSection("<cwd>\n</cwd>")).toBeNull();
    expect(matchCwdSection("<cwd>\n.\n</cwd>")).toBeNull();
    expect(matchCwdSection("no cwd section")).toBeNull();
    expect(matchCwdSection("")).toBeNull();
  });
});

describe("matchCwdLine", () => {
  it("VS Code 智能体：带 bullet 前缀", () => {
    expect(matchCwdLine("* Current working directory: e:\\Code\\LAM")).toBe("e:\\Code\\LAM");
    expect(matchCwdLine("- Current working directory: E:/Code/LAM")).toBe("E:/Code/LAM");
  });
  it("Claude Code 风格：Working directory / Primary working directory", () => {
    expect(matchCwdLine("Primary working directory: e:\\Code\\Demo")).toBe("e:\\Code\\Demo");
    expect(matchCwdLine("Working directory: /home/u/proj")).toBe("/home/u/proj");
    expect(matchCwdLine("  primary working directory: d:/a/b")).toBe("d:/a/b");
  });
  it("去掉行尾括号注释（SSH 扩展后缀）", () => {
    expect(matchCwdLine("Current working directory: /vm/workspace (Gondolin VM; host workspace mounted from /host)")).toBe(
      "/vm/workspace",
    );
  });
  it("UNC 路径", () => {
    expect(matchCwdLine("Current working directory: \\\\server\\share\\proj")).toBe("\\\\server\\share\\proj");
  });
  it("值非绝对路径返回 null", () => {
    expect(matchCwdLine("Current working directory: ./relative")).toBeNull();
    expect(matchCwdLine("Current working directory: some text")).toBeNull();
  });
  it("无该行为 null", () => {
    expect(matchCwdLine("no cwd here")).toBeNull();
    expect(matchCwdLine("")).toBeNull();
  });
});
