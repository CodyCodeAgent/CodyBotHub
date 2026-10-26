# CodyBotHub

CodyBotHub 是一个独立的飞书 Bot 管理平台。它以工作区为运行边界，统一管理 Bot、场景、技能包、路由，以及 Codex/TraeX Agent 会话。

## 快速开始

要求 Node.js 22.16+、Git 和 Corepack。无需飞书或 Agent 账号即可启动本地管理端、运行单元测试；真实消息和 Agent Turn 需要单独配置相应服务。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

管理端默认位于 `http://127.0.0.1:5173`，API 默认位于 `http://127.0.0.1:4310`。运行 `pnpm check` 完成类型检查、测试和构建。可选集成与公开环境要求见 [公开环境说明](docs/open-source-setup.md)，参与开发见 [贡献指南](CONTRIBUTING.md) 和 [社区行为准则](CODE_OF_CONDUCT.md)，使用问题见 [帮助说明](SUPPORT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。本项目按 [MIT License](LICENSE) 开源。

## 让 AI 完成安装与运维

仓库内置了 [CodyBotHub Setup Skill](skills/codybothub-setup/SKILL.md)。把下面这句话交给 Codex、TraeX 或其他能读取仓库文件的 Agent：

> 请读取 `skills/codybothub-setup/SKILL.md`，检查当前环境，安装缺少的依赖，完成所需 CLI 登录，部署 CodyBotHub，并用真实 App Server Turn 验证。

也可以把 Skill 安装到当前用户的 Codex Skill 目录：

```bash
./skills/codybothub-setup/scripts/install-skill.sh
```

重新加载 Agent 后使用 `$codybothub-setup`。Skill 会先运行只读环境诊断，只安装缺少的 Node、pnpm、Codex 或 TraeX 组件；遇到浏览器或设备授权会把登录步骤交给用户，成功后继续构建、部署和验证，不会擅自切换已有生产 Bot 的运行引擎。

## 当前能力

- 首次启动创建管理员账号；之后可管理多个“账号名 + 用户名 + 密码”的平台管理员，密码使用 Argon2id 哈希保存
- 首次创建或旧数据迁移得到的主账号受永久保护，不能删除
- 自动记录登录、账号管理以及工作区、Bot、场景、技能包和平台设置等配置操作
- SQLite 持久化，包含严格的外键和业务约束
- 管理本地工作区、飞书 Bot、可复用场景和技能包
- 支持已有飞书应用与扫码自动注册（复用 botmux 的 Device Flow 方案）
- Bot 必须关联工作区，并且始终拥有一个默认工作区
- 场景只能选择 Bot 已关联的工作区
- 技能包与场景关联时要求属于同一个工作区
- 飞书凭据使用本机 AES-256-GCM 密钥加密保存
- 使用 CodyWebCore 的 Feishu Provider 与统一 App Server Session Manager 处理消息；每个 Bot 可选择 Codex 或 TraeX
- 通过 Thread Channel 将多个相似群或话题绑定到同一个 Agent Thread；同一 Channel 使用 SQLite 持久队列串行执行，并可在管理端查看引擎、绑定、队列和路由依据
- 飞书消息去重、审计记录和队列任务以单个 SQLite 事务落库；队列由常驻调度器自动恢复，避免进程切换窗口造成消息卡住
- 运行总览直接展示 SQLite 完整性、队列积压、飞书连接、服务运行时长和画像任务状态；业务统计可临时按日期、群/单聊与 Thread 会话筛选，条件只用于当前页面并随 5 秒刷新实时重查
- Codex 的模型与推理强度按“场景 → Bot → 平台 → Codex 账号默认值”逐字段继承；TraeX 按“场景 → Bot → TraeX 默认值”继承。选项由对应 App Server 实时返回，并在消息记录中保存实际值、来源和运行引擎
- 回复使用飞书 Markdown 卡片，并附带工作区、场景、技能包和实际权限信息
- 群用户明确 @ Bot 时，回复原消息并原生 @ 回发送人；其他 Bot 可按 Bot 级策略接入，支持来源白名单、可选 @ 回和持久化协作轮次防循环
- 服务端部署支持任务排空：运行中的 Codex Turn 完成后才重启，新消息在排空期间持久化排队
- 支持文本、富文本、图片、文件、音频、视频和交互卡片的统一场景匹配
- 工作区通过本机目录选择器配置，技能包支持 `$` 搜索当前 Agent 可识别的 Skill
- 原子“工具”支持原生 Bits RPC、平台托管脚本与本地命令；执行不经过 Shell 拼接，并限制超时和输出大小
- “工具包”把预检、执行、校验等多个工具编排为固定顺序，携带独立 Prompt、确认卡片和飞书审批人名单
- 技能包可以挂载工具包。Codex 只感知当前场景实际关联的工具包，分析完成后通过 CodyWebCore 动态工具协议申请执行
- 需要人工确认时，平台发送飞书交互卡片并校验回调中的真实 Open ID；确认、拒绝、执行结果全部写入 SQLite
- 工具包按原 Thread Channel 串行执行，真实结果会自动续写原 Codex Thread，再由 Agent 输出最终说明
- 全局“平台 Copilot”复用 CodyWebCore，为每个管理员和工作区保存独立 Codex Thread，可查询平台配置、检索飞书员工 Open ID、生成托管脚本和 Bot 操作人变更草稿
- Copilot 默认运行在只读沙箱；脚本与配置修改只生成可审查草稿，管理员在页面确认后才会落库，并完整记录操作审计
- 飞书消息和 MCP 调用统一投影为持久 Task；飞书继续使用原有流式卡片展示过程，Task 状态用于幂等、恢复和跨入口查询
- 提供 Bearer 认证的 Streamable HTTP MCP 端点，可从 OpenDot 等客户端提交只读 Bot 任务并查询结果

完整的数据流、匹配规则和线程规则见 [docs/architecture.md](docs/architecture.md)。


## 群消息与 Bot 协作

普通群聊只有在明确 @ 当前 Bot 或独立命中场景规则时才会处理。用户明确 @ Bot 后，平台回复原消息并原生 @ 回该用户；同一条消息里被 @ 的其他人不会被继续 @。告警卡片等独立命中场景的消息沿用场景的群/话题回复方式，不强制 @ 任何人。

“飞书 Bot”编辑页可配置其他机器人消息策略：全部忽略、仅接收明确 @、或接收明确 @ 与独立场景命中。还可以配置来源 Bot 的 App ID/Open ID 白名单、是否 @ 回来源 Bot，以及最大协作轮次。平台把每次回复的飞书消息 ID 和协作深度写入 SQLite；默认最大深度为 1，允许另一个 Bot 接手一次，并阻止两个 Bot 在回复链上持续互相触发。当前 Bot 自己发出的消息始终忽略。

## 平台 Copilot

登录后，页面右下角的 **AI** 按钮可在任意管理页面打开平台 Copilot。它按“平台账号 + 工作区”保存独立会话，顶部会展示当前工作区和对应的 Codex Thread；切换工作区不会混用上下文。

当前可以直接询问：

- “某位同事的飞书 Open ID 是什么？”Copilot 会通过 `lark-cli contact +search-user` 实时检索，不会猜测人员 ID。同名时会列出邮箱和部门供管理员确认。
- “概览 AI Hub 下的 Bot、场景、技能包和工具包。”平台事实通过内部只读工具获取。
- “写一个接收 budgetId 并输出 JSON 的 Python 工具。”Copilot 会生成托管脚本草稿，页面展示代码、参数和超时，点击“确认创建工具”后才写入工具注册表。
- “把某位同事加为示例 Bot 的操作人。”Copilot 会先查人和 Bot，再生成配置变更卡片，点击“确认更新 Bot”后才修改 SQLite 并热重载飞书连接。

服务账号需要提前完成 `lark-cli` 用户登录，并拥有通讯录搜索权限；可用以下命令检查：

```bash
lark-cli auth status --verify
lark-cli contact +search-user --query "姓名或邮箱" --exclude-external-users --as user --format json
```

Copilot 不能直接编辑数据库、工作区文件或平台配置。查询走受控的动态工具，写操作走“生成草稿 → 页面确认 → 落库/同步 → 操作记录”链路。管理员可重置当前 Copilot 会话以创建新的 Codex Thread；其他工作区和账号的会话不受影响。

## 工具与工具包

工具是最小执行单元，建议一个工具只对应一个明确接口。平台提供三种执行方式：

- **原生 Bits RPC**：填写 PSM、方法、VRegion、环境、集群和请求 JSON 模板。平台生成 `gdpa-cli run bam-query` 请求，不需要编写包装脚本。
- **平台托管脚本**：直接编辑 Python、Shell 或 Node.js。内容保存在 SQLite 版本历史，并同步到工作区 `.codybothub/tools/<tool-id>/`；每次内容变化自动生成新版本。
- **本地命令**：填写固定可执行文件和 argv 模板，适合已有且受运维管理的 CLI。

参数模板中的 `{{field}}` 从运行参数取值，`{{json}}` 表示完整参数 JSON。原生 RPC 的整值占位符会保留数字、布尔和对象类型，例如：

```json
{
  "AccountIdentity": {
    "BudgetBindID": "{{budgetBindId}}",
    "BindIDType": "{{bindIdType}}"
  }
}
```

工具包负责把工具组成业务动作。推荐使用“预检 → 执行 → 校验”的顺序，在工具包 Prompt 中写清调用条件、证据要求、影响范围和成功标准。开启人工确认后，可逐行配置允许点击卡片的飞书 Open ID；留空则回退到 Bot 操作人，再回退到飞书应用管理员。

最后在“技能包”页面关联工具包，再把技能包关联到场景。只有经过这条显式授权链的工具包才会出现在 Codex 上下文中：

```text
场景 → 技能包 → 工具包 → 工具步骤
                 ↓
       飞书确认（可选）→ 串行执行 → 原 Thread 续跑
```

所有调用可在“工具包”的最近执行区域查看，包括执行 ID、状态、确认人、Codex Thread、结果和错误。已有的老 Thread 不包含新注册的动态工具定义；当它首次命中带工具包的场景时，平台会自动创建具备最新工具契约的新 Codex Thread，并把同一 Thread Channel 最近的已完成对话作为迁移上下文，用户无需手工清理绑定或重建话题。

## MCP 与统一 Task

服务在 `/mcp` 暴露 Streamable HTTP MCP。配置 `CODY_BOT_HUB_MCP_TOKEN` 后可使用四个工具：

- `inspect_platform`：以已完成 Task 返回可用 Bot、场景和能力边界。
- `submit_agent_task`：向指定 Bot 提交持久化只读任务；可传 `sceneId` 精确选择能力，也可省略后使用原有场景匹配；可立即返回 `task.id`，也可通过 `waitMs` 最多等待 25 秒。
- `get_task`：读取 Task 最新快照。
- `wait_task`：长轮询等待 Task 完成，单次最多 25 秒。

所有入口共用 `queued → running → completed/failed` 生命周期。飞书的卡片仍约每 450ms 更新以保持顺滑，SQLite 中的 Task 进度约每 2 秒落盘并在终态强制保存，因此流式体验不会被数据库写入频率拖慢。

MCP Agent Task 强制使用只读沙箱，并移除当前场景的 Tool Package 动态调用。MCP 会话只在相同 principal/session 内续接，不参与飞书的跨会话智能 Thread 复用，避免不同入口之间泄漏历史上下文。需要写配置、发起 RPC 或执行其他外部副作用时，Agent 会提示改走飞书的确认卡片流程；MCP 工具不会把有副作用的操作错误标记成 `readOnlyHint`。

OpenDot 配置示例：

```toml
[mcp_servers.codybothub]
url = "https://<可被数字员工访问的域名>/mcp"
bearer_token_env_var = "CODYBOTHUB_MCP_TOKEN"
```

数字员工运行环境中的 `CODYBOTHUB_MCP_TOKEN` 与服务端的 `CODY_BOT_HUB_MCP_TOKEN` 使用同一秘密值。不要把 Token 写入仓库或 TOML；远端数字员工也不能访问本机 `127.0.0.1`，必须通过受控的内网域名或代理暴露该端点。

OpenDot 本地调试时，自定义 MCP Token 应写入不会发布的 `.env`；实测 v0.18 的 Executor 不会从 `.env.dev` 透传这个自定义变量。OpenDot 发布会过滤 `.env*`，因此线上实例必须由运行平台注入同名 Secret，或在 CodyBotHub 前增加能校验实例身份的受控网关。若当前平台不支持这两种方式，不应把长期 Token 明文写入 `config.toml` 来绕过限制。

## 开发

要求 Node.js 22.16+ 与 pnpm 11.7+。

```bash
pnpm install
pnpm dev
```

管理端默认打开 `http://127.0.0.1:5173`，API 默认监听 `http://127.0.0.1:4310`。开发服务器会把 `/api` 代理到 API。

可用环境变量：

- `CODY_BOT_HUB_HOST`：API 监听地址，默认 `127.0.0.1`
- `CODY_BOT_HUB_PORT`：API 端口，默认 `4310`
- `CODY_BOT_HUB_DATA_DIR`：SQLite、密钥所在目录，默认仓库内 `.data`
- `CODY_BOT_HUB_WEB_DIST`：生产环境静态资源目录
- `CODY_BOT_HUB_CODEX_COMMAND`：Codex CLI 可执行文件；macOS 会自动尝试 ChatGPT.app 内置的 Codex
- `CODY_BOT_HUB_TRAEX_COMMAND`：TraeX CLI 可执行文件，默认 `traex`
- `CODY_BOT_HUB_MCP_TOKEN`：启用 `/mcp` 的 Bearer Token；未设置时 MCP 端点返回 503，飞书与管理端不受影响
- `CODY_BOT_HUB_MCP_PRINCIPAL`：与上述 Token 绑定的稳定调用方身份，默认 `mcp-client`；客户端请求头不能覆盖该身份

## Codex 与 TraeX

运行引擎在 Bot 上配置。一个 Bot 的所有消息使用同一引擎；场景只负责每轮 Prompt、工作区、技能包和模型选择，不改变 Thread 的引擎归属。

- Codex 启动参数：`codex app-server --stdio`
- TraeX 启动参数：`traex app-server --enable default_mode_request_user_input --listen stdio://`
- 两种引擎分别维护进程、模型目录、会话附件状态和 Thread ID
- Bot 切换引擎后，后续消息会新建对应引擎的 Thread Channel；旧 Channel、消息记录和审计数据继续保留
- 智能 Thread 复用只在同一 Bot、工作区、场景和运行引擎内检索，避免把 Codex Thread ID 交给 TraeX，或反向混用

服务器必须先安装所选 CLI，并确保服务账号能直接执行对应命令。TraeX 未安装时，现有 Codex Bot 继续正常运行；TraeX Bot 在首次读取模型或处理消息时会返回明确的 App Server 初始化错误。可以在运行总览的 Runtime 状态和服务日志中查看各引擎状态。

Linux systemd 安装器会解析当前账号的 CLI 路径，并将 `~/.local/bin` 加入服务 PATH。TraeX 安装完成后，应以运行 CodyBotHub 的同一系统账号执行 `traex login status`；IDE Remote Server 的登录态不会自动等同于 TraeX CLI 登录态。

## Core 依赖

`@codycodeagent/cody-web-core` 固定到经过验证的 Git Tag，确保不同机器安装到相同的 Feishu 与 Agent 会话底座。Core 提供 Codex/TraeX Runtime Profile、App Server 生命周期、协议归一化、Session Manager 与通用 Task 状态机；Hub 负责 Task 持久化、Bot 选择、路由、队列、权限和管理界面。

## 部署

### 为什么不能直接重启

Codex Turn 可能运行几分钟甚至更久。直接执行 `systemctl restart codybothub.service` 会向进程发送停止信号；如果 systemd 在 Turn 结束前强制结束进程，本轮调查会失败，飞书只能收到中断错误。

已有 Linux 用户服务可由维护者使用 [scripts/deploy.sh](scripts/deploy.sh) 升级。该脚本会拉取 `origin/main`，运行前应确认目标提交、数据库备份和 CI 状态；它不是自动发布流水线。脚本会在切换版本前进入**排空状态**：

1. 先拉取、安装依赖并构建新版本，此时线上服务继续运行。
2. 向服务发送 `SIGUSR2`，停止启动新的 Codex Turn。
3. 排空期间仍然接收飞书消息，并把消息与任务持久化到 SQLite 队列。
4. 等待正在运行的 Turn 和飞书回执处理完毕。
5. 原子切换前端资源，重启服务并检查健康状态。
6. 新进程启动后自动继续消费排空期间积压的任务。

因此，排空不是停止接收消息，也不会丢弃消息；它只暂停从持久队列中启动新任务。

### 日常发布命令

发布脚本需要由维护者在目标服务器的仓库目录中运行，不要在开发机或未经确认的服务上执行：

```bash
# 在已确认的目标服务器上，进入该服务实际使用的仓库目录
cd /path/to/CodyBotHub

# 服务端、依赖或数据库代码有变化：构建、排空、重启、健康检查
./scripts/deploy.sh

# 只有管理端页面变化：原子发布静态资源，不重启 Bot 服务和 Codex Turn
./scripts/deploy.sh --web-only
```

只修改 `apps/web` 时优先使用 `--web-only`。静态资源会先构建到 `dist.next`，再原子替换入口文件；浏览器刷新后加载新版本，Bot 服务的进程号和运行任务都不会变化。

### 排空状态与超时

运行总览每 5 秒刷新一次。发布期间会显示“服务正在排空”，并展示运行任务、待发送回执和排队任务数量。也可以直接查询：

```bash
curl --noproxy '*' http://127.0.0.1:3003/api/deployment-status
```

返回示例：

```json
{
  "draining": true,
  "drainStartedAt": "2026-09-20T03:44:00.846Z",
  "activeJobs": 1,
  "pendingReceipts": 0,
  "activeChannels": 1,
  "queuedJobs": 3
}
```

- `activeJobs`：正在运行的 Codex 任务数，脚本会等待它降为 `0`。
- `pendingReceipts`：正在处理的飞书接收确认数，脚本也会等待它降为 `0`。
- `queuedJobs`：已经安全写入 SQLite、将在新进程启动后继续执行的任务数；它不阻止发布。
- `activeChannels`：当前有任务运行的 Thread Channel 数。

默认最多等待 20 分钟。超过时间后，发布会取消并发送 `SIGUSR1` 退出排空，线上服务继续消费队列，不会为了发布而强制杀死长任务。可按次调整等待时间：

```bash
CODY_BOT_HUB_DEPLOY_DRAIN_TIMEOUT_SECONDS=1800 ./scripts/deploy.sh
```

如果在等待期间手动按 `Ctrl+C`，脚本同样会自动退出排空并恢复任务消费。

### 服务安装与检查

首次部署建议使用安装器生成当前机器专属的 systemd 用户服务配置，先预览，再安装：

```bash
pnpm build
./skills/codybothub-setup/scripts/install-service.sh --dry-run
./skills/codybothub-setup/scripts/install-service.sh --port 3003
```

安装器会设置 20 分钟的 `TimeoutStopSec`，作为误操作 `stop/restart` 时的最后保护。仓库内的 [示例 unit](deploy/codybothub.service) 含占位路径，不能直接复制使用。日常发布仍应使用部署脚本，因为脚本会在发送停止信号前完成构建、主动排空并验证健康状态。

常用检查命令：

```bash
systemctl --user status codybothub.service
journalctl --user -u codybothub.service -n 200 --no-pager
curl --noproxy '*' --fail http://127.0.0.1:3003/api/health
```

服务支持的运维信号：

- `SIGUSR2`：进入排空，新任务只入队、不启动。
- `SIGUSR1`：取消排空，恢复队列消费。
- `SIGTERM` / `SIGINT`：进入排空，等待活动任务结束，再关闭飞书连接、HTTP 服务、Codex Runtime 和 SQLite。

这些信号主要供部署脚本和 systemd 使用。人工发布不要跳过脚本直接发送信号或重启服务。

### 发布失败如何处理

- **构建失败**：排空尚未开始，线上版本不受影响。
- **等待超时或脚本被取消**：脚本发送 `SIGUSR1`，恢复原进程消费队列。
- **重启后健康检查失败**：运行 `systemctl --user status` 和 `journalctl` 查看启动错误；Git 工作区仍保留当前提交，可修复后重新运行脚本。
- **只需修复前端**：使用 `./scripts/deploy.sh --web-only`，避免无意义地重启 Bot 服务。

## AI 定时任务

「编排 → 定时任务」支持为 AI 配置工作区、模型、Prompt、技能/工具包和执行时间。内置资源同步、告警复盘、代码变更分析、环境检查、知识巡检与自定义模板。默认暂停，建议手动验证一次后启用。

每次执行保存独立记录、配置快照、实际模型、Thread ID 和工具结果。工具包保留飞书人工审批；投递失败可单独重发，避免重复业务操作。工作区同步协调正在执行的任务，保留本地修改和技能运行环境，并记录版本、备份与恢复结果。

计划、重启恢复、同步配置、审批、维护暂停解除与接口说明见 [AI 定时任务使用说明](docs/scheduled-tasks.md)。部署仍使用 `scripts/deploy.sh`，排空范围已包含定时任务；本功能不会自动启用任何任务或替你部署代码。
