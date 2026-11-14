import type { AssetsRepo } from "../assets/repo.js";
import { postRoutes, requireStr, optStr, optBool, optNum, badRequest, notFound, listRoute } from "./rest.js";

/**
 * 资产 CRUD 路由（prompts / agents / knowledges）。
 * 一律 POST + JSON body：/list（分页）/get /create /update /delete（+ prompts /active）。
 */
export function createAssetsRouters(repo: AssetsRepo) {
  // ── prompts（生效互斥；列表按名称正序）──
  const prompts = postRoutes({
    "/list": listRoute((b) => {
      const kw = optStr(b, "keyword")?.toLowerCase();
      const enabled = optBool(b, "enabled");
      let rows = repo.listPrompts();
      if (enabled !== undefined) rows = rows.filter((p) => p.enabled === enabled);
      if (kw) rows = rows.filter((p) => p.name.toLowerCase().includes(kw) || p.content.toLowerCase().includes(kw));
      return rows;
    }),
    "/active": () => repo.getActivePrompt(),
    "/get": (b) => repo.getPrompt(requireStr(b, "id")) ?? notFound("提示词不存在"),
    "/create": (b) => {
      const name = requireStr(b, "name");
      if (b.content == null) badRequest("content 必填");
      return repo.createPrompt({ name, content: String(b.content), enabled: optBool(b, "enabled") ?? false });
    },
    "/update": (b) => {
      const id = requireStr(b, "id");
      const updated = repo.updatePrompt(id, {
        name: optStr(b, "name"),
        content: b.content != null ? String(b.content) : undefined,
        enabled: optBool(b, "enabled"),
      });
      return updated ?? notFound("提示词不存在");
    },
    "/delete": (b) => {
      if (!repo.deletePrompt(requireStr(b, "id"))) notFound("提示词不存在");
      return { deleted: true };
    },
  });

  // ── agents ──
  const agents = postRoutes({
    "/list": listRoute((b) => filterRows(repo.listAgents(), b, ["name", "description"])),
    "/get": (b) => repo.getAgent(requireStr(b, "id")) ?? notFound("Agent 不存在"),
    "/create": (b) =>
      repo.createAgent({ ...agentInput(b), name: requireStr(b, "name"), body: requireStr(b, "body") }),
    "/update": (b) => repo.updateAgent(requireStr(b, "id"), agentInput(b)) ?? notFound("Agent 不存在"),
    "/delete": (b) => {
      const id = requireStr(b, "id");
      const existing = repo.getAgent(id);
      if (!existing) notFound("Agent 不存在");
      if (existing.system) badRequest(`系统级 Agent 不可删除：${existing.name}`);
      if (!repo.deleteAgent(id)) notFound("Agent 不存在");
      return { deleted: true };
    },
  });

  // ── knowledges ──
  const knowledge = postRoutes({
    "/list": listRoute((b) => filterRows(repo.listKnowledge(), b, ["title", "description"])),
    "/get": (b) => repo.getKnowledge(requireStr(b, "id")) ?? notFound("知识条目不存在"),
    "/create": (b) => {
      if (b.scope === "project" && !b.projectId) badRequest("project scope 需 projectId");
      return repo.createKnowledge({
        ...knowInput(b),
        title: requireStr(b, "title"),
        body: requireStr(b, "body"),
      });
    },
    "/update": (b) => repo.updateKnowledge(requireStr(b, "id"), knowInput(b)) ?? notFound("知识条目不存在"),
    "/delete": (b) => {
      if (!repo.deleteKnowledge(requireStr(b, "id"))) notFound("知识条目不存在");
      return { deleted: true };
    },
  });

  return { prompts, agents, knowledge };
}

/** 列表筛选：keyword 对给定文本键做大小写不敏感模糊匹配；enabled 布尔筛启用状态。 */
function filterRows<T extends object>(rows: T[], b: Record<string, unknown>, textKeys: string[]): T[] {
  const kw = optStr(b, "keyword")?.toLowerCase();
  const enabled = optBool(b, "enabled");
  let out = rows;
  if (enabled !== undefined) out = out.filter((r) => Boolean((r as Record<string, unknown>).enabled) === enabled);
  if (kw) {
    out = out.filter((r) => {
      const rr = r as Record<string, unknown>;
      return textKeys.some((k) => String(rr[k] ?? "").toLowerCase().includes(kw));
    });
  }
  return out;
}

function agentInput(b: Record<string, unknown>) {
  return {
    name: optStr(b, "name"),
    description: optStr(b, "description"),
    body: b.body != null ? String(b.body) : undefined,
    enabled: optBool(b, "enabled"),
    sortOrder: optNum(b, "sortOrder"),
  };
}

function knowInput(b: Record<string, unknown>) {
  return {
    title: optStr(b, "title"),
    description: optStr(b, "description"),
    body: b.body != null ? String(b.body) : undefined,
    scope: optStr(b, "scope") as "global" | "project" | undefined,
    projectId: b.projectId !== undefined ? (b.projectId == null ? null : String(b.projectId)) : undefined,
    enabled: optBool(b, "enabled"),
    sortOrder: optNum(b, "sortOrder"),
  };
}
