# 本地 Agent 记忆网关（Local Agent Memory Gateway）

个人本地部署的 Agent 记忆服务：**透明的 OpenAI Chat Completions 代理** + **分层记忆后端** + **MCP 工具面** + **同端口管理台**。

把客户端（IDE Agent / CLI / 任意 OpenAI 兼容客户端）的 Base URL 指向它，对话即自动获得记忆能力，客户端侧零改造：

| 能力 | 说明 |
|---|---|
| **项目级记忆闭环** | 对话回流（L0）→ 结构化提取（L1 原子事实/偏好/决策）→ 项目画像（L2），每轮自动召回相关记忆注入 |
| **记忆自维护** | 冲突检测做语义过期（store/skip/update/merge）；每轮召回块尾部提示，授权 Agent 任务后改/删本轮错旧条目（新增仍走提取） |
| **资产注入** | 提示词 / Agents / 知识库清单注入系统提示，正文经 MCP 工具按 id 按需读取，渐进披露省 token |
| **SQL 只读查询** | 对接外部业务库（SQLite / PostgreSQL / MySQL / SQL Server），仅放行单条 SELECT/WITH，供 Agent 探查表与数据 |
| **消息除噪** | 按规则剥离注入块 / 环境噪音，转发与记忆两条通道各自干净 |

前端（React）与后端**同域同端口**：`http://localhost:8790` 既是网关，也是管理台。

> ⚠️ 仅本机部署、**无鉴权**——请勿直接暴露公网。

## 目录

- [工作原理](#工作原理)
- [功能详解](#功能详解)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [首次配置](#首次配置)
- [接入客户端](#接入客户端)
- [项目路径识别](#项目路径识别)
- [数据与运维](#数据与运维)
- [注册为 Windows 服务](#注册为-windows-服务)
- [开发指南](#开发指南)
- [参考与致谢](#参考与致谢)
- [许可](#许可)

## 工作原理

```mermaid
graph LR
    C[客户端 Agent] -->|OpenAI + x-project-path| G[主服务 :8790]
    C -->|MCP /mcp| G
    G -->|注入快照 + 每轮召回| U[上游 LLM]
    G -->|final answer 回流| L0[(L0 原始对话)]
    L0 --> S[后台调度器]
    S -->|批量提取 + 冲突检测| L1[(L1 原子记忆)]
    L1 -->|定期凝练| L2[(L2 项目画像)]
    L1 -->|每轮混合检索| G
    L2 -->|快照注入| G
    S -->|显式触发整理| L1
```

一次请求的**读侧**路径：项目识别 → 除噪 → 会话判定 → 注入快照（缓存复用）→ 动态召回 → 转发上游；
响应结束后的**写侧**路径（fire-and-forget，不阻塞响应）：final answer 判定 → L0 落库 → 调度器按阈值批量提取 L1 → 凝练 L2。对话内还有轻量自维护：召回块尾部提示授权 Agent 任务后修正/删除本轮召回的错旧条目（禁止新增）。

## 功能详解

### 透明网关：记忆自动进出

客户端把 Base URL 指向它即可，无需改任何代码：

- **注入（读侧）**：会话首轮生成一份注入快照（生效提示词正文 + 知识库/Agents 清单 + L2 项目画像 + 项目路径，共 5 节，空节省略），追加到 system 消息末尾且**跨轮字节级一致**——命中上游 KV 缓存；另按当轮用户问题动态召回相关 L1 记忆，以 `<recalled>` 块拼在最后一条 user 消息之前（与会话级快照分离，不进 system）；
- **回流（写侧）**：本轮回答无 tool_calls（final answer）时，新增对话增量写入 L0；后台调度器按阈值（攒够 l1_trigger_conversations 轮）批量触发 L1 提取（JSON mode + 两阶段冲突检测：store/skip/update/merge，小颗粒一条一事）与 L2 项目画像凝练（首次全量、后续增量）；
- **消息除噪**：按规则（起始/结束标记，正则非贪婪）剥离客户端环境块等噪音，转发与记忆两条通道可各自独立生效。

### 三层记忆（按项目隔离）

| 层 | 内容 | 用法 |
|---|---|---|
| L0 | 原始对话切片（只落 user/assistant 纯文本） | 供提取管线回看与溯源（L1 source_l0_ids）；管理台可检索浏览 |
| L1 | 小颗粒原子记忆（persona/episodic/instruction/fact/method/artifact 六类，带优先级与 L0 溯源） | 每轮动态召回注入 + `memory_search` 兜底 |
| L2 | 项目画像（每项目单份 Markdown，LLM 从 L1 定期凝练） | 快照全文注入 |

检索为 FTS5/BM25 起步，配置 embedding 模型后自动升级为**向量 + RRF 混合召回**（sqlite-vec，维度 1024）。

**两条过期路径**：

1. **语义过期**（冲突检测，自动）：新记忆推翻旧事实时，旧行置 `superseded_by` 即刻退出检索，行保留作溯源；
2. **对话内修正**（召回提示授权）：每轮 `<recalled>` 块尾部固定提示行授权 Agent 任务后用 `memory_batch_update`/`memory_batch_delete` 改/删**本轮召回的错旧条目**（须先反证，禁止新增）；全库性清理可让 Agent 用 `memory_batch_read` 分页盘点后按同样工具执行。

### 资产管理

提示词（互斥生效）、Agents（子智能体定义）、知识库（全局/项目两 scope）三类资产统一「清单注入 + 正文按需读取」：系统提示只占一行目录（`id：标题：描述`），正文经 MCP 工具按 id 拉取，省 token 且渐进披露。

### SQL 只读查询

让接入的 Agent 直接探查外部业务库（SQLite / PostgreSQL / MySQL / SQL Server 四方言 × 查询/列表/看表结构共 12 工具）：仅放行单条 SELECT/WITH，注释剥离 + 词边界黑名单防绕过，SQLite 只读打开，行数上限截断，失败原因以正常结果返回供模型自我修正。连接串由调用参数直传，本服务不登记任何外部库凭据。

### 无配置文件

18 项运行参数（模型绑定、提取调度、召回阈值等）全存 SQLite，管理台按注册表自动渲染控件，**改完即热生效、无需重启**。仅 `PORT` / `DATA_DIR` / `FRONTEND_DIST` / `LOG_LEVEL` / `MCP_SEARCH_WINDOW_MS` 五个环境变量在进程启动层面读取（见 [`.env.example`](.env.example)）。

## 环境要求

- **Node.js ≥ 24**（使用内置 `node:sqlite`，零原生编译，无需 Visual Studio 等构建工具链）
- **pnpm**（锁文件为 pnpm 12）
- 一个 OpenAI 兼容的上游 LLM（转发用）；可选 embedding 模型（向量召回用，不配则退化为 BM25 检索）

## 快速开始

```bash
# 1. 安装依赖（根目录一次性装齐后端 + 前端 workspace）
pnpm install

# 2. 构建前端管理台（一次性；之后升级前端时重跑）
pnpm run build:web

# 3. 启动（默认 http://localhost:8790）
pnpm start
```

开发模式（后端热重载）：`pnpm dev`；前端单独开发：`cd frontend && pnpm dev`。

健康检查：

```bash
curl http://localhost:8790/health
# {"ok":true,"name":"local-agent-memory-gateway","stage":"P10-complete","fts5":true,"vec":true}
```

打开 `http://localhost:8790/` 即是管理台。首次启动自动建库并写入默认设置。

## 首次配置（必做，否则无法转发）

在管理台完成，也可用 `POST /api/*` 接口（一律 JSON body）：

1. **「模型」页**：每个条目是一个 **LLM 提供商**（分类 llm / embedding，填名称 / Base URL / 密钥）。「模型」区有两种输入页签（**模式随条目持久化，保存只落当前模式的数据**）：**自动获取**——点「读取模型」调 `GET {url}/models` 拉取该提供商可用模型，读到的全部模型直接记入清单（无需勾选，只读输入框仅显示已获取数量，可重读覆盖）；**手工输入**——提供商不支持 /models 端点时，手输它唯一支持的模型名（清单即这一个）。最终存储为「提供商 → 可用模型清单」（清单首项为默认模型），可留空，绑定时再指定；
2. **「设置」页**：三项模型绑定为可搜索下拉，**每个可用模型一个选项，文案 `提供商/可用模型`**（默认模型存纯 id；其余存 `id:模型名` 覆盖格式，旧绑定完全兼容）——
   - `gateway_llm`：网关转发的主模型（客户端请求里的 `model` 字段会被忽略，一律以此为准）；
   - `memory_llm`：记忆提取/画像凝练用模型；
   - `embedding_model`：向量化模型（可留空不绑定，留空则召回只用 BM25）。

保存即热生效。

## 接入客户端

### 1. OpenAI 网关

把客户端的 Base URL 指向 `http://localhost:8790/`（标准 Chat Completions 协议，含流式 SSE 透传）。
其余参数（temperature / tools / stream 等）原样透传上游。建议携带两个请求头：

| Header | 作用 |
|---|---|
| `x-project-path` | 当前项目绝对路径——记忆按项目隔离的键 |
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

开放 **18 个工具**（检索/读取为主，记忆与资产类含维护写操作）：

| 分组 | 工具 | 用途 |
|------|------|------|
| 知识库 | `knowledge_read` / `knowledge_create` / `knowledge_update` / `knowledge_delete` | 按 id 读正文（清单已注入系统提示 `<knowledge>` 段）/ 建条目（缺省挂本项目，可 global）/ 部分更新内容字段 / 物理删除 |
| Agents | `agent_read` / `agent_create` / `agent_update` / `agent_delete` | 按 id 读正文（清单已注入系统提示 `<agents>` 段）/ 新建定义 / 部分更新 / 删除 |
| 记忆 | `memory_search` / `memory_batch_read` / `memory_batch_update` / `memory_batch_delete` / `memory_profile_read` / `memory_profile_update` | 检索 L1 / 分页读全部活跃记忆（从早到晚）/ 批量改写正文（单批 ≤20）/ 批量物理删除（数量不限）/ 读 L2 画像 / 整篇保存 L2 画像 |
| SQL | `sql_query_<方言>` | 外部业务库只读查询（方言：sqlite / postgresql / mysql / sqlserver；表结构可按需 SELECT 系统表获取） |

注意四点：

- **写类工具使用红线**：记忆与资产的增/删/改工具描述均标注「除非用户明确要求，否则禁止自行调用」——写操作须经用户授权；`enabled`/排序等管理属性只归管理台；例外：每轮召回块（`<recalled>`）尾部固定注入提示行，授权 Agent 任务后对**本轮召回条目**改/删（须先反证），禁止新增——新增由后台提取管线负责；
- **L2 画像仅开放 read/update**：无 create/delete 工具——新建由凝练管线自动完成，删除/重置归管理台；
- `memory_search` 约 30 秒窗口内最多 3 次（防检索死循环），超限返回提示文本；
- SQL 工具查的是**外部业务库**，连接串由调用参数直传（如 `postgres://user:pass@host:5432/db`），只允许单条 SELECT/WITH，行数有上限，失败原因以正常文本返回供模型自我修正。

### 3. 管理台

浏览器打开 `http://localhost:8790/`：**项目、提示词、Agents、知识库、记忆、模型、设置、除噪规则、日志、工具库** 共 10 个页面。日常操作（配置模型、维护资产、查看记忆）都在此处完成，无需记 API。

## 项目路径识别

记忆、知识库(project scope) 全部**按项目隔离**，"项目"由请求中的路径识别。这是唯一需要了解的内部机制：

**解析优先级**：`x-project-path` header > 消息正文兜底解析。

- **兜底解析**：面向无法携带自定义 header 的客户端（BYOK 模式的 VS Code 系、pi 等 CLI），网关按以下优先级扫描请求体：
  1. `<workspace_info>...</workspace_info>` 段内行首盘符路径（VS Code Copilot 自动注入，`- d:\Work\Proj` 形式，以闭合标签收口，不会越界扫到正文）；
  2. `<cwd>` 段（pi v1.x 系统提示固定渲染，如 `<cwd>E:/Code/LAM</cwd>`，反斜杠已转正斜杠）；
  3. `Current working directory: <path>` 行（pi 旧版文案与 SSH/Gondolin 扩展格式）；
  4. 指令消息内行首 `- <盘符路径>` 兜底。
  其中 2–4 仅扫 **system 消息**（含其别名 `developer`——网关协议层已统一归一为 system，pi 的 reasoning 模型即以 developer 角色发送指令）。**不扫 user / tool 消息**——其内容常含目录列表等 `- C:\...` 文本，纳入扫描会误登记垃圾项目。
- **已验证接入方式**：VS Code Copilot BYOK（零配置，靠 `<workspace_info>` 自动识别）；pi（`models.json` 配 `baseUrl` 指向网关即可，靠 `<cwd>` 段识别；注意模型 `reasoning: true` 时 pi 以 developer 角色发送，网关已兼容）。
- **规范化**：路径统一转小写、分隔符归一为 `/`、去除结尾多余斜杠后比对——`D:\Work\Demo`、`d:\work\demo\`、`d:/work/demo` 视为同一项目（Windows 大小写不敏感）。
- **MCP 工具的 `project_path` 参数**：网关注入块末尾带有 `<project> path: ...` 段，模型调用按项目隔离的工具时原样回传即可；同一规范化实现保证与网关注册的项目一致。
- 首次出现的合法路径会自动登记为项目；项目软删后再次收到其请求会自动恢复（连同其记忆）。

## 数据与运维

- 全部数据集中在 `data/` 目录：主库 `data/gateway.db`（WAL 模式）、日志 `Logs/`（或 `data/Logs/`，按 `yyyy/MM/dd/HH.txt` 小时滚动）。
- **备份 / 迁移 = 停服后拷走这些目录**；在线一致性快照可手工执行 `VACUUM INTO`。恢复：停服 → 用备份覆盖 `gateway.db`（删同名 `-wal` / `-shm`）→ 重启。
- **崩溃恢复无需人工干预**：提取游标与缓冲全部持久化在 `pipeline_state`，重启后后台任务自动续跑；进程被强杀也不丢在途批次（缓冲在批次成功后才按差集清理）。
- 清空业务数据（保留模型库与设置）：停服后 `node scripts/wipe-data.mjs --yes`。

## 注册为 Windows 服务

```
Install-Service.bat             双击运行，自动 UAC 提权；首次会下载 NSSM 到 tools\
Install-Service.bat uninstall   卸载
```

服务名 `LocalAgentMemory`，异常退出 5 秒自动重启，进程 stdout/stderr 落在 `Logs/service/`。

## 开发指南

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 后端热重载开发 |
| `pnpm run build:web` | 构建前端管理台产物 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` / `pnpm test:watch` | vitest 单测（记忆整理、召回、提取、迁移、MCP 等 14 个测试文件） |
| `pnpm bench:recall` | 召回质量基准（Recall@k / MRR，BM25 vs hybrid 对比） |
| `pnpm sim` | 真实环境端到端仿真（需服务运行，真实 LLM + 真实节律） |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit 生成迁移 / 应用迁移 |

**代码结构**（关键目录）：

```
src/
  gateway/    透明网关：协议解析、除噪、注入快照、会话、转发
  memory/     记忆管线：L0 回流、L1 提取与冲突检测、L2 凝练、召回、补嵌入、调度器
  assets/     资产仓储（提示词 / Agents / 知识库）
  api/        /api/* 管理接口（一律 POST + JSON body）
  mcp/        MCP 工具面（Streamable HTTP，经 /internal 进程内取数）
  db/         node:sqlite 客户端、schema、FTS、向量、迁移应用器
  settings/   设置注册表与热更新服务
  sql/        外部业务库只读查询（四方言 + 只读守卫）
drizzle/      离线生成的迁移 SQL 与快照（运行时按 _journal.json 顺序应用）
frontend/     React + Semi UI 管理台（pnpm workspace 成员，同端口托管）
scripts/      基准、仿真、数据清理等运维脚本
```

**约定**：业务配置全 DB（不用配置文件）；`/api/*` 统一 `POST /api/<资源>/<action>` + JSON body，响应包络 `{success,code,message,data}`；`/internal/*` 为 MCP 工具面的只读取数端点（`{ok,data,error}`）；时间一律本地时区。

设计决策与实施路线详见 [`docs/DESIGN.md`](docs/DESIGN.md) 与 [`docs/PLAN.md`](docs/PLAN.md)。

## 参考与致谢

本项目是在以下开源项目基础上学习、简化与重新实现的个人本地化版本，在此致谢：

- **[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)** —— 主要参考项目。本项目的记忆分层（L0/L1/L2）、提取调度（阈值/串行队列）、两阶段冲突检测、会话注入快照、MCP 工具面等均源自其工程实践，并针对“单用户、本机部署、无团队/鉴权”场景做了大幅简化重组（去掉多租户、team/agent/task 身份体系与多客户端适配器；warm-up 渐进阈值与会话空闲兜底也已取消，固定轮数阈值触发）。
- **[ccrisan/nssm](https://nssm.cc/)** —— Non-Sucking Service Manager，`Install-Service.bat` 用它将本服务注册为 Windows 服务。

内部实现直接依赖的主要开源组件：[Hono](https://hono.dev/)（HTTP 框架）、[drizzle-orm](https://orm.drizzle.team/)（schema/迁移）、[node:sqlite](https://nodejs.org/api/sqlite.html) + [sqlite-vec](https://github.com/asg017/sqlite-vec)（存储与向量检索）、[Model Context Protocol SDK](https://modelcontextprotocol.io/)（MCP）、[React](https://react.dev/) + [Semi Design](https://semi.design/)（管理台）、[pino](https://getpino.io/)（日志）。

## 许可

[MIT](LICENSE)。
