import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../infra/paths.js";
import { localStampForFile } from "../infra/localtime.js";
import { postRoutes, ApiError, listRoute, optStr, requireStr, badRequest, notFound } from "./rest.js";
import { createLogger } from "../infra/logger.js";

const log = createLogger("api:db");

/**
 * /api/db —— 数据库维护（DESIGN §3、决策 45 + 47 + 52）。
 * POST /backup   VACUUM INTO 产出一致性快照（不阻塞读写），落到 {DATA_DIR}/backups/。
 * POST /list     列出现有备份（按时间倒序，keyword 对文件名模糊，分页 PaginationModel）。
 * POST /delete   删除指定备份文件（仅限 backups 目录内的 *.db 文件名，防路径穿越）。
 * 恢复不做在线功能：手工停服后用备份覆盖 gateway.db 即可（决策 52）。
 */
export function createDbRouter(raw: DatabaseSync) {
  const backupDir = () => path.join(dataDir(), "backups");

  return postRoutes({
    "/backup": () => {
      const dir = backupDir();
      mkdirSync(dir, { recursive: true });
      const stamp = localStampForFile();
      const file = path.join(dir, `gateway-${stamp}.db`);
      try {
        // 先合并 WAL 保证副本含最新已提交数据；VACUUM INTO 生成独立一致性副本（目标须不存在）。
        raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}';`);
        const size = statSync(file).size;
        log.debug({ file, size }, "数据库备份完成");
        return { path: file, sizeBytes: size, createdAt: Date.now() };
      } catch (err) {
        log.error({ err: String(err) }, "数据库备份失败");
        throw new ApiError(500, "backup_failed", String(err));
      }
    },
    "/list": listRoute((b) => {
      const kw = optStr(b, "keyword")?.toLowerCase();
      let names: string[] = [];
      try {
        names = readdirSync(backupDir()).filter((n) => n.endsWith(".db"));
      } catch {
        names = []; // 目录不存在 → 空列表
      }
      return names
        .map((n) => {
          const full = path.join(backupDir(), n);
          try {
            const st = statSync(full);
            return { name: n, path: full, sizeBytes: st.size, createdAt: st.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { name: string; path: string; sizeBytes: number; createdAt: number } => !!x)
        .filter((x) => !kw || x.name.toLowerCase().includes(kw))
        .sort((a, b) => b.createdAt - a.createdAt);
    }),
    "/delete": (b) => {
      const name = requireStr(b, "name");
      // 安全：仅接受 backups 目录内的纯文件名（拒路径分隔符/相对段），且必须是 .db。
      if (name !== path.basename(name) || name.includes("..") || !name.endsWith(".db")) {
        badRequest("非法备份文件名");
      }
      const full = path.join(backupDir(), name);
      if (!existsSync(full)) notFound("备份不存在");
      try {
        rmSync(full);
      } catch (err) {
        throw new ApiError(500, "delete_failed", String(err));
      }
      log.debug({ full }, "备份已删除");
      return { deleted: true };
    },
  });
}
