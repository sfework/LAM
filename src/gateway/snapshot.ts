import type { AssetsRepo } from "../assets/repo.js";
import { clipList } from "../assets/repo.js";
import type { SettingsService } from "../settings/service.js";

/**
 * 注入快照生成器（DESIGN §2.6）。
 *
 * 六节，顺序固定，空节省略：
 *   <prompts> 生效提示词正文
 *   <knowledge> 知识清单（全局 + 本项目，id + 标题 + 描述）
 *   <agents> Agents 生效清单
 *   <skills> 技能生效清单
 *   <memory> L2 项目画像（阶段 6 接入，本阶段无则省略）
 *   <project> 规范化项目路径（供 MCP 工具回传 project_path）
 *
 * 会话首轮生成一次并缓存到 sessions.inject_snapshot，之后每轮复用（字节级一致，
 * 保上游 KV cache 前缀稳定）。
 */

export interface SnapshotInput {
  projectId: string | null;
  projectPath: string;
  /** L2 项目画像全文（阶段 6 前传空）。 */
  memoryProfile?: string;
}

export class SnapshotBuilder {
  private readonly assets: AssetsRepo;
  private readonly settings: SettingsService;

  constructor(assets: AssetsRepo, settings: SettingsService) {
    this.assets = assets;
    this.settings = settings;
  }

  build(input: SnapshotInput): string {
    const sections: string[] = [];

    // <prompts>
    const prompt = this.assets.getActivePrompt();
    if (prompt && prompt.content.trim()) {
      sections.push(`<prompts>\n${prompt.content.trim()}\n</prompts>`);
    }

    // 资产清单
    const lists = this.assets.enabledAssetLists(input.projectId);
    const kn = clipList(
      lists.knowledge,
      this.settings.getInt("inject_knowledge_max_items"),
      this.settings.getInt("inject_knowledge_max_chars"),
    );
    if (kn.length) sections.push(`<knowledge>\n${renderList(kn)}\n</knowledge>`);

    const ag = clipList(
      lists.agents,
      this.settings.getInt("inject_agents_max_items"),
      this.settings.getInt("inject_agents_max_chars"),
    );
    if (ag.length) sections.push(`<agents>\n${renderList(ag)}\n</agents>`);

    const sk = clipList(
      lists.skills,
      this.settings.getInt("inject_skills_max_items"),
      this.settings.getInt("inject_skills_max_chars"),
    );
    if (sk.length) sections.push(`<skills>\n${renderList(sk)}\n</skills>`);

    // <memory>
    const mem = input.memoryProfile?.trim();
    if (mem) {
      const cap = this.settings.getInt("inject_memory_max_chars");
      sections.push(`<memory>\n${mem.length > cap ? mem.slice(0, cap) : mem}\n</memory>`);
    }

    // <project>
    sections.push(`<project>\npath: ${input.projectPath}\n</project>`);

    return sections.join("\n\n");
  }
}

function renderList(items: { id: string; title: string; description: string }[]): string {
  return items
    .map((i) => `- ${i.id}${i.title ? `：${i.title}` : ""}${i.description ? `：${i.description}` : ""}`)
    .join("\n");
}

/**
 * 把快照注入到消息队列（DESIGN 方案 A）：
 * 追加到已有 system 消息末尾；无 system 时新建一条置顶。
 * 返回新数组，不修改入参。
 */
export function injectSnapshot<T extends { role: string; content?: unknown }>(
  messages: readonly T[],
  snapshot: string,
): T[] {
  if (!snapshot.trim()) return messages.slice();
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx >= 0) {
    const sys = messages[idx]!;
    const merged = appendToContent(sys.content, snapshot);
    return messages.map((m, i) => (i === idx ? { ...m, content: merged } : m));
  }
  const injected = { role: "system", content: snapshot } as unknown as T;
  return [injected, ...messages.map((m) => ({ ...m }))];
}

/** 追加文本到 content（string 直接拼；块数组在末尾补一个 text 块）。 */
function appendToContent(content: unknown, text: string): unknown {
  if (content === undefined || content === null || content === "") return text;
  if (typeof content === "string") return `${content}\n\n${text}`;
  if (Array.isArray(content)) return [...content, { type: "text", text }];
  return content;
}
