/**
 * CodeGraph 模块（DESIGN 决策 67）：vendored @colbymchenry/codegraph（fork 于仓库根 codegraph/，
 * 补丁 CODEGRAPH_STORE_ROOT 把每项目索引外置到 {DATA_DIR}/codegraph/<name>-<hash8>/codegraph.db）。
 * 不使用 watcher；触发 = 首次激活全量 + 每 N 轮对话增量 sync + 手动重建。
 * gateway.db 仅存 cg_status。对外入口是 CodeGraphService 门面。
 */
export { CodeGraphService } from "./service.js";
export { CodeGraphQuery, type CgResult } from "./query.js";
export { CgStatusRepo, type CgStatusRow, type CgStatusValue } from "./status-repo.js";
export { GraphReaders, type CgSymbolRow, type CgFileRow } from "./reader.js";
export { codegraphLib, libDatabasePath, libIsInitialized, type CodeGraphInstance } from "./lib.js";
