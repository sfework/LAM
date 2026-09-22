import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { createLogger } from "../infra/logger.js";
import { frontendDistDir } from "../infra/paths.js";

/**
 * 前端 SPA 托管（DESIGN 决策 46）。
 *
 * 目标：前端 build 产物与后端 API 同域同端口（http://localhost:8790），彻底避免跨域。
 * 对齐 ASP.NET Core 的 UseSpaStaticFiles + MapSpaFallback 语义：
 *   1) 真实静态文件（js/css/图片…）按路径命中直接返回；
 *   2) 未命中的 GET 导航请求（React Router 的 /projects、/memories 等客户端路由，含刷新/直链）
 *      回退到 index.html，交给前端路由接管；
 *   3) 后端自有前缀（/api /internal /mcp /v1 /health）绝不回退成 HTML ——
 *      否则接口 404 会变成 200 + HTML，前端 fetch 极难排查。
 *
 * 不用 @hono/node-server 的 serveStatic：其 root 只接受相对 cwd 的路径，
 * 而这里需要一个与启动目录无关的绝对路径（frontend/dist）。
 */

const log = createLogger("web:spa");

/** 后端保留前缀：这些路径永远不走 SPA 回退。 */
const RESERVED_PREFIXES = ["/api", "/internal", "/mcp", "/v1", "/health"];

/** 常见静态资源 MIME（够用即可，避免引入依赖）。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** 解析请求路径到 dist 内的真实文件；越界（..）或不存在返回 null。 */
function resolveFile(root: string, urlPath: string): string | null {
  const target = path.resolve(root, "." + path.posix.normalize("/" + urlPath));
  if (target !== root && !target.startsWith(root + path.sep)) return null; // 防目录穿越
  try {
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

function isReserved(urlPath: string): boolean {
  return RESERVED_PREFIXES.some((p) => urlPath === p || urlPath.startsWith(p + "/"));
}

/**
 * SPA 路由：挂在 app 的最后，只处理 GET/HEAD。
 * dist 缺失时返回一个"什么都不接管"的路由，服务照常以纯后端模式运行。
 */
export function createSpaRouter(distDir: string = frontendDistDir()): Hono {
  const spa = new Hono();
  const indexFile = path.join(distDir, "index.html");
  const enabled = existsSync(indexFile);

  if (!enabled) {
    log.debug({ distDir }, "未找到前端构建产物，跳过 SPA 托管（纯后端模式）");
    // 仅根路径给一句提示，其余一律 next()，让上层 404 逻辑保持原样。
    spa.get("/", (c) =>
      c.text(
        [
          "local-agent-memory-gateway 已启动（未托管前端）。",
          `前端产物目录：${distDir}`,
          "构建前端：pnpm --filter frontend build；或开发模式运行 Vite 并代理 /api /internal /mcp /health。",
          "接口：GET /health · POST /api/<资源>/<action> · POST /v1/chat/completions · /mcp",
        ].join("\n"),
        200,
      ),
    );
    return spa;
  }

  log.debug({ distDir }, "已启用前端 SPA 托管");

  const handler = (c: Context) => {
    const urlPath = safeDecode(new URL(c.req.url).pathname);
    if (isReserved(urlPath)) return c.json({ ok: false, error: { code: "not_found", message: "资源不存在" } }, 404);

    const file = resolveFile(distDir, urlPath) ?? resolveFile(distDir, path.posix.join(urlPath, "index.html"));
    if (!file) {
      // 客户端路由回退：任何带扩展名的请求（如漏打的 /assets/xxx-<hash>.js）不该返回 HTML
      if (path.posix.extname(urlPath)) {
        return c.json({ ok: false, error: { code: "not_found", message: `静态资源不存在：${urlPath}` } }, 404);
      }
      const html = readFileSync(indexFile, "utf8");
      c.header("Content-Type", mimeOf(indexFile));
      c.header("Cache-Control", "no-store");
      return c.body(html, 200);
    }

    const st = statSync(file);
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);

    const hashed = /-[0-9A-Za-z_-]{6,}\.\w+$/.test(path.basename(file)); // Vite 内容哈希产物
    c.header("Content-Type", mimeOf(file));
    c.header("ETag", etag);
    c.header("Cache-Control", file === indexFile ? "no-store" : hashed ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
    c.header("Last-Modified", st.mtime.toUTCString());
    return c.body(readFileSync(file));
  };

  spa.on(["GET", "HEAD"], "/*", handler);
  return spa;
}

/** URI 解码容错：非法转义序列（如裸 %）不应让请求 500。 */
function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
