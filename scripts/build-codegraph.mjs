// 构建 vendored codegraph 库：tsc 编译 + 复制运行时资产（schema.sql / *.wasm）。
// 等价于在 codegraph/ 目录执行 `npx tsc && node scripts/copy-assets.cjs`（原库的 copy-assets 内联脚本在 Windows 下转义易碎，这里自持一份）。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, "..", "codegraph");
const dist = path.join(libDir, "dist");

console.log("[build:cg] tsc ...");
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc"], { cwd: libDir, stdio: "inherit" });

mkdirSync(path.join(dist, "db"), { recursive: true });
copyFileSync(path.join(libDir, "src", "db", "schema.sql"), path.join(dist, "db", "schema.sql"));
const wasmOut = path.join(dist, "extraction", "wasm");
mkdirSync(wasmOut, { recursive: true });
let n = 0;
for (const f of readdirSync(path.join(libDir, "src", "extraction", "wasm"))) {
  if (f.endsWith(".wasm")) {
    copyFileSync(path.join(libDir, "src", "extraction", "wasm", f), path.join(wasmOut, f));
    n++;
  }
}
console.log(`[build:cg] done. dist=${dist} wasm=${n}`);
