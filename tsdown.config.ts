import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/server.ts",
  },
  format: "esm",
  target: "node24",
  platform: "node",
  clean: true,
  dts: false,
  // 二进制/外部依赖不打包，运行时加载
  external: [
    "sqlite-vec",
    "web-tree-sitter",
    "@modelcontextprotocol/sdk",
  ],
});
