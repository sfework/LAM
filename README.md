# NLAM — Local Agent Memory Gateway

透明 OpenAI 兼容网关 + 对话/记忆/画像管理后端 + MCP 工具库 + 管理前端。
单用户本地部署，所有业务配置存 SQLite，零外部服务依赖。

## 功能一览

- **网关主链路** `POST /v1/chat/completions`：接收任意 OpenAI 协议客户端（VS Code Copilot、CLI 类等）的对话请求，除噪 → 会话快照注入 → 每轮记忆动态召回 → 转发上游 LLM → SSE 透传；响应旁路聚合，final answer 自动回流为对话记录。
- **记忆管线**：对话按阈值触发 LLM 提取为结构化记忆（六类：persona/episodic/instruction/fact/method/artifact），冲突检测与合并，画像（项目级总结文档）按门控分类增量凝练。
- **混合检索**：BM25（SQLite FTS5）+ 向量（sqlite-vec）RRF 融合召回，embedding 不可用自动降级纯 BM25。
- **MCP 工具面** `POST /mcp`（Streamable HTTP）：17 个工具供 Agent 调用——记忆检索/枚举/归档、画像读写、知识库、Agent 定义、项目数据库 SQL 只读查询等。
- **项目管理**：按请求自动登记项目（header 优先，正文兜底解析工作区路径），每个项目可配置多个外部数据库连接供 MCP SQL 工具使用。
- **管理前端**（React + Semi UI，Vite 构建）：同端口托管，覆盖对话、记忆、画像、模型、设置、除噪规则、日志等全部管理视图。

## 客户端接入与项目路径识别

NLAM 的对话/记忆/画像按**项目**隔离，一切的前提是网关能从请求中识别出"这个请求来自哪个项目"。
**并非所有工具都能无缝对接**——识别失败时网关不会报错，而是自动降级为纯透传代理
（不注入快照、不召回记忆、不回流对话，等同一个普通 OpenAI 反向代理），此时记忆能力整体失效。

项目识别按以下优先级进行：

1. **自定义 header**：`x-project-path: <项目绝对路径>`。只要客户端允许配置附加
   header，这是最可靠的方式（任意工具均可用）。
2. **正文兜底解析**（无法传自定义 header 的客户端，按已知提示词格式匹配）：
   - VS Code（Copilot Chat）：system 提示中的 `<workspace_info>` 段；
   - pi v1.x：system/developer 消息中的 `<cwd>` 段；
   - Claude Code / pi 旧版 / VS Code 智能体：`Working directory: <路径>` 行
     （含 `Primary`/`Current` 前缀与 bullet 前缀变体，大小写不敏感）。
3. 以上全部落空 → 降级透传。日志会输出一条 `无法确定项目` 诊断（含消息角色列表与
   正文中所有含盘符的行），照此可为新客户端适配解析规则。

对 MCP 工具面（`/mcp`）的额外要求：工具参数里的 `project_path` **必须指向已登记的项目**
（即该路径至少先经网关完成过一次对话，或已在管理台手工登记）。项目未登记时工具返回
`无法解析 project_path`——这是刻意的审计口径，防止凭空出现无对话历史的项目数据。

接入适配建议：

| 客户端类型 | 可行性 |
|---|---|
| VS Code Copilot | 开箱即用（workspace_info 自动识别） |
| Claude Code / pi 等 CLI | 开箱即用（工作目录行 / cwd 段识别） |
| 支持自定义 header 的任意 OpenAI 客户端 | 配 `x-project-path` 即可 |
| 提示词中不含任何工作区信息的工具（多数网页端/封装 App） | 只能透传，无记忆能力；除非它允许配置 header |

### 二次开发：适配新客户端

内置识别链路覆盖不了你的工具时，可以自己扩展。改动触点集中在
[src/projects/parse-workspace.ts](src/projects/parse-workspace.ts)（正文兜底解析）与
[src/gateway/index.ts](src/gateway/index.ts) 的 `resolveProject`（识别优先级编排），
按以下流程做：

1. **取证**：先用目标客户端对着网关发一轮消息，在日志（管理端"日志"页或
   `data/Logs/`）里找 `降级透传：无法确定项目` 这条诊断——它会 dump 消息角色列表、
   指令消息开头与正文中所有含盘符的行，据此确定该客户端提示词里的路径形态。
2. **新增解析函数**：在该文件内按形态加一个 `matchXxx(text)`（文件已导出的
   `matchPath` / `matchCwdSection` / `matchCwdLine` 可直接参考），并接入
   `parseWorkspacePath` 的兜底链。
3. **补单测**：解析函数是纯函数，直接对真实提示词片段断言即可。

注意事项（都是现有实现刻意收紧的口径，扩展时请保持）：

- **兜底只扫指令消息**（`system`/`developer`），不要把扫描面扩到 user 或工具返回——
  用户消息和工具输出里常含目录列表（`- C:\...`），纳入扫描会登记出一堆垃圾项目。
- **必须校验绝对路径**（Windows 盘符 / UNC / Unix 根起头），相对路径或片段一律弃用。
- **段匹配要收口**：成对标签（如 `<workspace_info>`）必须以结束标签为界，
  否则越界扫到对话正文里用户粘贴的其他路径，会把项目认错。
- **解析函数永不抛异常**：外层有全量 try/catch 兜底，任何未预见格式都应"解析失败 →
  降级透传"，而不是让网关报错打断客户端对话。
- **优先级：专用段 > 标注行 > 裸路径兜底**，越具体的信号越先采用。
- **路径归一化是同一把钥匙**：识别结果统一经 `normalizeProjectPath` 规范化
  （小写、正斜杠、去尾斜杠）后才入库。同一目录若形态不同会被登记成多个项目，
  记忆/对话随之分裂——新增形态务必确认归一后与既有键一致。
- **能配 header 就别耦合提示词**：客户端支持自定义请求头时优先引导用
  `x-project-path`，提示词格式随客户端版本漂移，正文解析是兜底不是首选。
- **改项目路径走管理端**：项目以规范化路径为唯一隔离键，用户换了工作目录后旧数据
  仍挂在旧路径下，需要时在管理端项目页改名/换目录，不要在适配层做隐式迁移。

## 快速开始

要求：Node.js ≥ 24（使用 `node:sqlite` 内置模块），pnpm。

```sh
pnpm install
pnpm build:web        # 构建管理前端到 frontend/dist
pnpm start            # 默认 http://localhost:8790
```

打开 `http://localhost:8790` 进入管理端：

1. **模型**页添加一个 OpenAI 兼容 LLM（可选加 embedding 模型，维度固定 1024）；
2. **设置**页把 `gateway_llm` 绑定为该 LLM（记忆维护另绑 `memory_llm`）；
3. 把客户端（如 VS Code Copilot）的 API 端点指向 `http://localhost:8790/v1`。

环境变量（仅进程启动层，业务配置全在管理端）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8790` | 监听端口（仅 localhost） |
| `DATA_DIR` | `<仓库根>/data` | 数据目录（SQLite 库 + 日志） |
| `FRONTEND_DIST` | `<仓库根>/frontend/dist` | 前端产物目录 |

## Windows 服务部署

`Install-Service.bat`（管理员）经 NSSM 注册为开机自启服务，日志重定向与轮转已配置；`Install-Service.bat uninstall` 卸载。首次运行会自动下载 NSSM 到 `tools/`。

## 开发

```sh
pnpm dev              # node --watch 源码直跑
pnpm test             # vitest 全量测试
pnpm typecheck        # tsc --noEmit
```

数据库迁移为手写 SQL（`migrations/NNNN_*.sql`），启动时自动应用；
`scripts/migrate-from-lam.mjs` 提供旧版 LAM 数据的一次性导入。

## 目录结构

```
src/
  gateway/    # OpenAI 网关：协议、除噪接线、快照、召回注入、转发
  memory/     # 提取、冲突、召回、画像、调度、FTS/向量
  denoise/    # 消息除噪规则与引擎
  mcp/        # MCP 工具面（薄壳，转调 /internal）
  api/        # 管理端 REST（/api/*）与内部端点（/internal/*）
  sqlquery/   # 项目级数据库只读查询（驱动 + 安全闸）
  db/         # SQLite、迁移 runner、FTS5、sqlite-vec
  infra/      # 日志、路径、ID、本地时间
frontend/     # React 管理端（Vite）
migrations/   # 手写 SQL 迁移
test/         # vitest 测试
```

## 许可证

[MIT](LICENSE)
