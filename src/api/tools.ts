import { TOOL_DEFS } from "../mcp/tools.js";
import { postRoutes, listRoute, optStr } from "./rest.js";

/**
 * /api/tools —— 工具库（对齐参考实现的 MCP 工具目录 + Tools 控制器）。
 *
 * 参考项目用反射枚举 `[McpServerToolType]` 生成清单，保证与 MCP 端点实际暴露的一致；
 * 本项目的单一数据源是 `src/mcp/tools.ts` 的 `TOOL_DEFS`（`/mcp` 的 tools/list 与工具调用都读它），
 * 直接派生即可保证「管理台看到的 = MCP 暴露的」，无需运行时自调 tools/list。
 *
 * POST /list  {keyword?} → 全量工具（分组 + 名称 + 描述），keyword 模糊匹配名称/描述。
 */

/** endpoint（`/internal/<seg>/...`）→ 中文分组名。 */
function groupOf(endpoint: string): string {
  const seg = endpoint.split("/")[2] ?? "";
  switch (seg) {
    case "knowledge":
      return "知识库";
    case "agents":
      return "Agents";
    case "skills":
      return "技能";
    case "memory":
      return "记忆";
    case "conversation":
      return "对话";
    case "codegraph":
      return "代码图";
    case "sql":
      return "SQL";
    default:
      return "其他";
  }
}

export interface ToolListItem {
  id: string;
  name: string;
  group: string;
  description: string;
}

/** 由 TOOL_DEFS 派生清单（按分组、名称排序）。 */
function catalog(): ToolListItem[] {
  return TOOL_DEFS.map((t) => ({
    id: t.name,
    name: t.name,
    group: groupOf(t.endpoint),
    description: t.description,
  })).sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group)));
}

export function createToolsRouter() {
  return postRoutes({
    "/list": listRoute((body) => {
      const kw = optStr(body, "keyword")?.toLowerCase();
      const rows = catalog();
      return kw ? rows.filter((r) => r.name.toLowerCase().includes(kw) || r.description.toLowerCase().includes(kw)) : rows;
    }),
  });
}
