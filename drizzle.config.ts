import { defineConfig } from "drizzle-kit";

/**
 * 数据目录：默认 {cwd}/data（可用环境变量 DATA_DIR 覆盖）。
 * 本项目不使用配置文件存放业务配置，仅 PORT / DATA_DIR 允许环境变量。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/gateway.db`
      : "./data/gateway.db",
  },
  verbose: true,
  strict: true,
});
