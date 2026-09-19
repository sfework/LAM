import type { L1Store } from "../memory/l1-store.js";
import type { L2Refiner } from "../memory/l2-refiner.js";
import type { L0Recorder } from "../memory/l0-recorder.js";
import type { SettingsService } from "../settings/service.js";
import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import type { LlmCallConfig } from "../llm/client.js";
import { sha256 } from "../infra/hash.js";
import { postRoutes, requireStr, optStr, badRequest, notFound, listRoute } from "./rest.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("api:memories");

/**
 * /api/memories —— 记忆库管理（DESIGN §3、决策 45 + 47 + 55）。
 * 三层：L0 对话原文 / L1 结构化记忆 / L2 项目画像。
 * POST /list { project_id|project_path, keyword?, page?, pageSize? }        活跃 L1（内容检索，生成时间倒序，带 sha256）
 * POST /get { id }                                                          单条 L1（含溯源 L0）
 * POST /update { id, content, sha256? }                                     编辑 L1 正文；sha 未变则跳过（不重新向量化）
 * POST /delete { id }                                                       物理删单条 L1（同步移出 FTS/向量）
 * POST /l0-list { project_id|project_path, keyword?, role?, page?, pageSize? }  L0 消息（内容/角色检索，时间倒序）
 * POST /l0-delete { id }                                                    物理删单条 L0（移出 FTS）
 * POST /profile { project_id|project_path }                                 L2 画像全文（带 sha256）
 * POST /save-profile { project_id|project_path, content, sha256? }          保存 L2；sha 未变则跳过写库（L2 不参与检索，无需向量化）
 * POST /rebuild-profile { project_id|project_path }                         手动重建 L2（用 memory_llm）
 */
export function createMemoriesRouter(deps: {
  l0: L0Recorder;
  l1: L1Store;
  l2: L2Refiner;
  settings: SettingsService;
  projects: ProjectRepo;
}) {
  const resolveProject = (b: Record<string, unknown>): string => {
    const pid = optStr(b, "project_id");
    if (pid) {
      const p = deps.projects.findById(pid);
      if (p) return p.id;
    }
    const rawPath = optStr(b, "project_path");
    if (rawPath) {
      const p = deps.projects.findByPath(normalizeProjectPath(rawPath));
      if (p) return p.id;
    }
    return badRequest("project_path 或 project_id 无法解析到项目");
  };

  return postRoutes({
    "/list": listRoute((b) => {
      const projectId = resolveProject(b);
      const kw = optStr(b, "keyword")?.toLowerCase();
      const rows = deps.l1
        .listActive(projectId)
        .map((m) => ({
          id: m.id,
          kind: m.kind,
          content: m.content,
          priority: m.priority,
          sceneName: m.sceneName,
          createdAt: m.createdAt,
          sha256: sha256(m.content),
        }))
        // 生成时间倒序（新记忆靠前）
        .sort((a, z) => z.createdAt - a.createdAt);
      return kw ? rows.filter((r) => r.content.toLowerCase().includes(kw)) : rows;
    }),
    "/profile": (b) => {
      const projectId = resolveProject(b);
      const { content, version, updatedAt } = deps.l2.readMeta(projectId);
      return { projectId, content, version, updatedAt, sha256: sha256(content) };
    },
    "/get": (b) => {
      const r = deps.l1.readWithSources(requireStr(b, "id"));
      if (!r || r.record.deletedAt !== null) notFound("记忆不存在");
      return {
        id: r.record.id,
        projectId: r.record.projectId,
        kind: r.record.kind,
        content: r.record.content,
        priority: r.record.priority,
        sceneName: r.record.sceneName,
        createdAt: r.record.createdAt,
        sha256: sha256(r.record.content),
        sources: r.sources,
      };
    },
    "/update": (b) => {
      const id = requireStr(b, "id");
      const content = requireStr(b, "content");
      const clientSha = optStr(b, "sha256");
      const existing = deps.l1.get(id);
      if (!existing || existing.deletedAt !== null) notFound("记忆不存在");
      // 前端回传 sha 与库中当前 sha 不一致 → 内容已被他处改动，拒绝（乐观并发）。
      if (clientSha && clientSha !== sha256(existing.content)) badRequest("内容已变更，请刷新后重试");
      const { changed } = deps.l1.updateContent(id, content);
      if (changed) log.info({ id }, "L1 记忆正文已更新（FTS 重建 + 向量待补嵌入）");
      return { id, changed, sha256: sha256(content) };
    },
    "/delete": (b) => {
      const id = requireStr(b, "id");
      if (!deps.l1.remove(id)) notFound("记忆不存在");
      log.info({ id }, "L1 记忆已物理删除（管理端）");
      return { deleted: true };
    },
    "/l0-list": listRoute((b) => {
      const projectId = resolveProject(b);
      const keyword = optStr(b, "keyword");
      const roleRaw = optStr(b, "role");
      const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
      return deps.l0.listForAdmin(projectId, { keyword, role });
    }),
    "/l0-delete": (b) => {
      const id = requireStr(b, "id");
      if (!deps.l0.remove(id)) notFound("消息不存在");
      log.info({ id }, "L0 消息已物理删除（管理端）");
      return { deleted: true };
    },
    "/save-profile": (b) => {
      const projectId = resolveProject(b);
      const content = typeof b.content === "string" ? b.content : requireStr(b, "content");
      const clientSha = optStr(b, "sha256");
      const current = deps.l2.read(projectId);
      if (clientSha && clientSha !== sha256(current)) badRequest("画像已变更，请刷新后重试");
      const { changed, version } = deps.l2.save(projectId, content);
      if (changed) log.info({ projectId, version }, "L2 画像已保存（管理端）");
      return { projectId, changed, version, sha256: sha256(content) };
    },
    "/rebuild-profile": async (b) => {
      const projectId = resolveProject(b);
      const m = deps.settings.getResolvedModel("memory_llm");
      if (!m) badRequest("memory_llm 未配置，无法重建画像");
      const llm: LlmCallConfig = { baseUrl: m.url, apiKey: m.key, model: m.model };
      const version = await deps.l2.refine(projectId, llm);
      const content = deps.l2.read(projectId);
      return { projectId, version, content, sha256: sha256(content) };
    },
  });
}
