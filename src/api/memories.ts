import type { MemoryRepo } from "../memory/memory-repo.js";
import type { ProfileRefiner } from "../memory/profile-refiner.js";
import type { ConversationRecorder } from "../memory/conversation-recorder.js";
import type { SettingsService } from "../settings/service.js";
import type { ProjectRepo } from "../projects/repo.js";
import { normalizeProjectPath } from "../projects/normalize.js";
import { sha256 } from "../infra/hash.js";
import { postRoutes, requireStr, optStr, badRequest, notFound, listRoute } from "./rest.js";

/**
 * /api/memories —— 记忆库管理（对话 / 记忆 / 画像三层）。
 * POST /list                 { project_id|project_path, keyword?, page?, pageSize? }  活跃记忆（生成时间倒序，带 sha256）
 * POST /get                  { id }                                                    单条记忆（含溯源对话）
 * POST /update               { id, content, sha256? }                                  编辑记忆正文；sha 未变则跳过
 * POST /delete               { id }                                                    物理删单条记忆（移出 FTS/向量）
 * POST /conversation-list    { project_id|project_path, keyword?, role?, page?, pageSize? }  对话消息（时间倒序）
 * POST /conversation-delete  { id }                                                    物理删单条对话
 * POST /profile              { project_id|project_path }                               画像全文（带 sha256）
 * POST /save-profile         { project_id|project_path, content, sha256? }             保存画像；sha 未变则跳过
 * POST /rebuild-profile      { project_id|project_path }                               手动重建画像（用 memory_llm，全量）
 */
export function createMemoriesRouter(deps: {
  conversations: ConversationRecorder;
  memories: MemoryRepo;
  profiles: ProfileRefiner;
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
      const rows = deps.memories
        .listActive(projectId)
        .map((m) => ({
          id: m.id, kind: m.kind, content: m.content, priority: m.priority,
          sceneName: m.sceneName, metadata: m.metadata, createdAt: m.createdAt, sha256: sha256(m.content),
        }))
        .sort((a, z) => z.createdAt - a.createdAt);
      return kw ? rows.filter((r) => r.content.toLowerCase().includes(kw)) : rows;
    }),
    "/profile": (b) => {
      const projectId = resolveProject(b);
      const { content, version, updatedAt } = deps.profiles.readMeta(projectId);
      return { projectId, content, version, updatedAt, sha256: sha256(content) };
    },
    "/get": (b) => {
      const r = deps.memories.readWithSources(requireStr(b, "id"));
      if (!r || r.record.deletedAt !== null) notFound("记忆不存在");
      return {
        id: r.record.id, projectId: r.record.projectId, kind: r.record.kind,
        content: r.record.content, priority: r.record.priority, sceneName: r.record.sceneName,
        metadata: r.record.metadata, createdAt: r.record.createdAt, sha256: sha256(r.record.content),
        sources: r.sources,
      };
    },
    "/update": (b) => {
      const id = requireStr(b, "id");
      const content = requireStr(b, "content");
      const clientSha = optStr(b, "sha256");
      const existing = deps.memories.findById(id);
      if (!existing || existing.deletedAt !== null) notFound("记忆不存在");
      // 前端回传 sha 与库中当前 sha 不一致 → 内容已被他处改动，拒绝（乐观并发）。
      if (clientSha && clientSha !== sha256(existing.content)) badRequest("内容已变更，请刷新后重试");
      deps.memories.update(id, { content });
      return { id, changed: existing.content !== content, sha256: sha256(content) };
    },
    "/delete": (b) => {
      const id = requireStr(b, "id");
      if (!deps.memories.remove(id)) notFound("记忆不存在");
      return { deleted: true };
    },
    "/conversation-list": listRoute((b) => {
      const projectId = resolveProject(b);
      const keyword = optStr(b, "keyword");
      const roleRaw = optStr(b, "role");
      const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
      return deps.conversations.listForAdmin(projectId, { keyword, role });
    }),
    "/conversation-delete": (b) => {
      const id = requireStr(b, "id");
      if (!deps.conversations.remove(id)) notFound("消息不存在");
      return { deleted: true };
    },
    "/save-profile": (b) => {
      const projectId = resolveProject(b);
      const content = typeof b.content === "string" ? b.content : requireStr(b, "content");
      const clientSha = optStr(b, "sha256");
      const current = deps.profiles.read(projectId);
      if (clientSha && clientSha !== sha256(current)) badRequest("画像已变更，请刷新后重试");
      const { changed, version } = deps.profiles.save(projectId, content);
      return { projectId, changed, version, sha256: sha256(content) };
    },
    "/rebuild-profile": async (b) => {
      const projectId = resolveProject(b);
      const llm = deps.settings.getResolvedLlmConfig("memory_llm");
      if (!llm) badRequest("memory_llm 未配置，无法重建画像");
      // 手动重建 = 全量重凝练（忽略增量水位）
      const { version } = await deps.profiles.refine(projectId, llm, "full");
      const content = deps.profiles.read(projectId);
      return { projectId, version, content, sha256: sha256(content) };
    },
  });
}
