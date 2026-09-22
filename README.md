# 本地 Agent 记忆网关（Local Agent Memory Gateway）

个人本地部署的 Agent 记忆网关：一个**透明的 OpenAI Chat Completions 代理** + **记忆/知识/代码图管理后端** + **MCP 工具面**。
把客户端（IDE Agent / CLI / 任意 OpenAI 兼容客户端）指向它，即可在对话中自动获得：

- **项目级记忆闭环**：对话回流（L0）→ 结构化提取（L1，小颗粒原子事实/偏好/决策）→ 项目画像（L2），每轮自动召回相关记忆注入；
- **资产注入**：提示词 / Agents / 技能 / 知识库清单注入系统提示，正文经 MCP 工具按需读取；
- **代码图（CodeGraph）**：tree-sitter 索引项目符号与调用关系，8 个查询工具支撑"改这个函数会影响谁"这类问题；
- **SQL 只读查询**：对接外部业务库（SQLite / PostgreSQL / MySQL / SQL Server），仅放行单条 SELECT/WITH，供 Agent 探查表结构与数据；
- **消息除噪**：按规则剥离注入块/环境噪音，保证转发与记忆两条通道各自干净。

前端（React）与后端**同域同端口**：`http://localhost:8790` 既是网关，也是管理台。
仅本机部署、**无鉴权**——请勿直接暴露公网。

## 功能介绍

### 透明网关：记忆自动进出

客户端把 Base URL 指向它即可，无需改任何代码：

- **注入（读侧）**：会话首轮生成一份注入快照（生效提示词正文 + 知识库/Agents/技能清单 + L2 项目画像 + 项目路径），每轮追加到 system 消息末尾且跨轮字节级一致——命中上游 KV 缓存；另按当轮用户问题动态召回相关 L1 记忆，拼在最后一条 user 消息前；
- **回流（写侧）**：本轮回答无 tool_calls（final answer）时，新增对话增量写入 L0 原始库；后台调度器按阈值/warm-up/idle 批量触发 L1 提取（JSON mode + 两阶段冲突检测：store/skip/update/merge，小颗粒一条一事）与 L2 项目画像凝练（首次全量、后续增量）；
- **消息除噪**：按规则（起始/结束标记，正则非贪婪）剥离客户端环境块等噪音，转发与记忆两条通道可各自独立生效。

### 三层记忆（按项目隔离）

| 层 | 内容 | 用法 |
|---|---|---|
| L0 | 原始对话切片（只落 user/assistant 纯文本） | `conversation_search` 检索溯源 |
| L1 | 小颗粒原子记忆（事实/偏好/决策/方法，带优先级与 L0 溯源） | 每轮动态召回注入 + `memory_search` 兜底 |
| L2 | 项目画像（每项目单份 Markdown，LLM 从 L1 定期凝练） | 快照全文注入 |

检索为 FTS5/BM25 起步，配置 embedding 模型后自动升级为向量 + RRF 混合召回（sqlite-vec，维度 1024）。

### 资产管理

提示词（互斥生效）、Agents（子智能体定义）、技能（带版本链，支持对话自动抽取待审）、知识库（全局/项目两 scope）四类资产统一「清单注入 + 正文按需读取」：系统提示只占一行目录，正文经 MCP 工具按 id 拉取，省 token 且渐进披露。

### CodeGraph 代码图

以 vendored 的 [codegraph](https://github.com/colbymchenry/codegraph) 解析引擎为库，把项目源码索引成符号 + 调用关系图（索引统一存 `data/codegraph/`，目标仓库零污染）。每轮对话后按计数增量 sync；8 个 MCP 查询工具（search / explore / callers / callees / impact / node / status / files）支撑「改这个函数会波及谁」类问题；管理台内力导向关系图可视化。

![CodeGraph 关系图（管理台）](assets/codegraph-view.png)

### SQL 只读查询

让接入的 Agent 直接探查外部业务库（SQLite / PostgreSQL / MySQL / SQL Server 四方言 × 查询/列表/看表结构共 12 工具）：仅放行单条 SELECT/WITH，注释剥离 + 词边界黑名单防绕过，SQLite 只读打开，行数上限截断，失败原因以正常结果返回供模型自我修正。

### 其它

- **无配置文件**：38 项运行参数全存 DB、热更新，管理台按注册表自动渲染控件；
- **崩溃恢复**：提取游标/缓冲/索引状态全部持久化，重启自动续跑；
- **备份**：`VACUUM INTO` 一致性快照，管理台一键备份/下载。

## 环境要求

- **Node.js ≥ 24**（使用内置 `node:sqlite`，零原生编译，无需 Visual Studio 等构建工具链）
- pnpm（锁文件为 pnpm 12）
- 一个 OpenAI 兼容的上游 LLM（转发用），可选：embedding 模型（向量召回用，不配则退化为 BM25 检索）

## 安装与启动

```bash
# 1. 安装依赖（根目录一次性装齐后端 + 前端 workspace）
pnpm install

# 2. 构建前端管理台（一次性；之后升级前端时重跑）
pnpm --filter frontend build

# 3. 启动（默认 http://localhost:8790）
pnpm start
```

健康检查：

```bash
curl http://localhost:8790/health
# {"ok":true,"name":"local-agent-memory-gateway","fts5":true,"vec":true}
```

打开 `http://localhost:8790/` 即是管理台。首次启动自动建库并写入默认设置。

> **没有配置文件**：所有业务配置（模型绑定、注入预算、提取调度等 38 项）都存在 SQLite 里，
> 在管理台「设置」页热更新，改完即生效、无需重启。
> 仅 `PORT` / `DATA_DIR` / `FRONTEND_DIST` 三个环境变量在进程启动层面被读取（见 [`.env.example`](.env.example)）。

### 注册为 Windows 服务（可选，开机自启）

```
Install-Service.bat            （双击运行，自动 UAC 提权；首次会下载 NSSM 到 tools\）
Install-Service.bat uninstall  （卸载）
```

服务名 `LocalAgentMemory`，异常退出 5 秒自动重启，进程 stdout/stderr 落在 `Logs/service/`。

## 首次配置（必做，否则无法转发）

在管理台完成，也可用 `POST /api/*` 接口（一律 JSON body）：

1. **「模型」页**：注册一个 LLM（分类 llm，填 url / key / model）与一个 embedding 模型（分类 embedding）；
2. **「设置」页**：把三项模型绑定填上——
   - `gateway_llm`：网关转发的主模型（客户端请求里的 `model` 字段会被忽略，一律以此为准）；
   - `memory_llm`：记忆提取/画像凝练用模型；
   - `embedding_model`：向量化模型（可留空，留空则召回只用 BM25）。

保存即热生效。

## 接入客户端

### 1. OpenAI 网关

把客户端的 Base URL 指向 `http://localhost:8790/`（标准 Chat Completions 协议，含流式 SSE 透传）。
其余参数（temperature / tools / stream 等）原样透传上游。建议携带两个请求头：

| Header | 作用 |
|---|---|
| `x-project-path` | 当前项目绝对路径——记忆与代码图按项目隔离的键 |
| `x-session-id` | 可选；带上则同一会话复用同一注入快照（利于上游 KV 缓存） |

```bash
curl -X POST http://localhost:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-project-path: D:/Work/MyApp" \
  -H "x-session-id: my-session-1" \
  -d '{"model":"ignored","messages":[{"role":"user","content":"你好"}]}'
```

不带 `x-session-id` 时，网关按"项目 + 首条用户消息"自动推导会话，同样能复用快照。

### 2. MCP 工具面

MCP Server 挂在同一端口：**`http://localhost:8790/mcp`**（Streamable HTTP，无状态）。
任何支持该传输的客户端（Claude Desktop / Cline / Cursor / VS Code 等）直接配 URL：

```json
{
  "mcpServers": {
    "local-agent-memory": {
      "type": "http",
      "url": "http://localhost:8790/mcp"
    }
  }
}
```

开放 27 个只读工具：

| 分组 | 工具 | 用途 |
|------|------|------|
| 知识库 | `knowledge_read` | 按 id 读正文（清单已注入系统提示 `<knowledge>` 段） |
| Agents | `agent_read` | 按 id 读正文（清单已注入系统提示 `<agents>` 段） |
| 技能 | `skill_read` | 按 id 读正文（清单已注入系统提示 `<skills>` 段） |
| 记忆 | `memory_search` / `memory_read` / `memory_read_profile` | 检索 L1 / 读带溯源原文 / 读 L2 画像 |
| 对话 | `conversation_search` | 检索 L0 原文 |
| 代码图 | `codegraph_search` / `explore` / `callers` / `callees` / `impact` / `node` / `status` / `files` | 符号搜索 / 探索 / 调用方 / 被调方 / 影响面 / 单符号 / 索引状态 / 文件 |
| SQL | `sql_query_<方言>` / `sql_list_tables_<方言>` / `sql_describe_table_<方言>` | 外部业务库只读查询（方言：sqlite / postgresql / mysql / sqlserver） |

注意两点：

- `memory_search` 与 `conversation_search` 合计约 30 秒窗口内最多 3 次（防检索死循环），超限返回提示文本；
- SQL 工具查的是**外部业务库**，连接串由调用参数直传（如 `postgres://user:pass@host:5432/db`），只允许单条 SELECT/WITH，行数有上限，失败原因以正常文本返回供模型自我修正。

### 3. 管理台

浏览器打开 `http://localhost:8790/`：项目、模型、设置、除噪规则、提示词、Agents、技能、知识库、DB 备份、日志、CodeGraph（力导向关系图）、记忆（L0 对话 / L1 记忆 / L2 画像三页签）、工具库 共 13 个页面。日常操作（配置模型、维护资产、查看记忆、备份）都在此处完成，无需记 API。

## 项目路径识别（开发向说明）

记忆、知识库(project scope)、CodeGraph 全部**按项目隔离**，"项目"由请求中的路径识别。这是唯一需要了解的内部机制：

**解析优先级**：`x-project-path` header > 消息正文兜底解析。

- **兜底解析**：面向无法携带自定义 header 的客户端（如 BYOK 模式的 VS Code 系），网关会扫描请求体：
  1. 优先在 `<workspace_info>...</workspace_info>` 段内找行首盘符路径（`- d:\Work\Proj` 形式，以闭合标签收口，不会越界扫到正文）；
  2. 该段缺失时，仅在 **system 消息**内按行首 `- <盘符路径>` 兜底；
  3. **不扫 user / tool 消息**——其内容常含目录列表等 `- C:\...` 文本，纳入扫描会误登记垃圾项目。
- **规范化**：路径统一转小写、分隔符归一为 `/`、去除结尾多余斜杠后比对——`D:\Work\Demo`、`d:\work\demo\`、`d:/work/demo` 视为同一项目（Windows 大小写不敏感）。
- **MCP 工具的 `project_path` 参数**：网关注入块末尾带有 `<project> path: ...` 段，模型调用按项目隔离的工具时原样回传即可；同一规范化实现保证与网关注册的项目一致。
- 首次出现的合法路径会自动登记为项目；项目软删后再次收到其请求会自动恢复（连同其记忆/索引）。

## 数据与备份

- 全部数据集中在 `data/` 目录：主库 `data/gateway.db`（WAL）、CodeGraph 索引 `data/codegraph/<项目>/`、日志 `Logs/`（或 `data/Logs/`）。**备份/迁移 = 拷走这些目录即可**。
- 管理台「DB 备份」页：立即备份（`VACUUM INTO` 一致性快照到 `data/backups/`）、查看、删除。
- 恢复：停服 → 用备份覆盖 `gateway.db`（删同名 `-wal`/`-shm`）→ 重启。
- 崩溃恢复无需人工干预：提取游标、缓冲、CodeGraph 索引状态全部持久化在库中，重启后后台任务自动续跑。

## 参考与致谢

本项目是在以下开源项目基础上学习、简化与重新实现的个人本地化版本，在此致谢：

- **[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)** —— 主要参考项目。本项目的记忆分层（L0/L1/L2）、提取调度（warm-up/idle/串行队列）、两阶段冲突检测、会话注入快照、MCP 工具面等均源自其工程实践，并针对“单用户、本机部署、无团队/鉴权”场景做了大幅简化重组（去掉多租户、team/agent/task 身份体系与多客户端适配器）。
- **[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)** —— 成熟的多语言代码知识图引擎，本项目的 CodeGraph 模块以其为 vendored 库使用（改了索引存储位置，统一外移到 `data/codegraph/`，目标仓库零污染）。
- **[ccrisan/nssm](https://nssm.cc/)** —— Non-Sucking Service Manager，`Install-Service.bat` 用它将本服务注册为 Windows 服务。

内部实现直接依赖的主要开源组件：[Hono](https://hono.dev/)（HTTP 框架）、[drizzle-orm](https://orm.drizzle.team/)（schema/迁移）、[node:sqlite](https://nodejs.org/api/sqlite.html) + [sqlite-vec](https://github.com/asg017/sqlite-vec)（存储与向量检索）、[web-tree-sitter](https://tree-sitter.github.io/)（代码解析）、[Model Context Protocol SDK](https://modelcontextprotocol.io/)（MCP）、[React](https://react.dev/) + [Semi Design](https://semi.design/)（管理台）、[pino](https://getpino.io/)（日志）、[chokidar](https://github.com/paulmillr/chokidar)（文件监听）。

## 许可

[MIT](LICENSE)。
