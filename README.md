# CodyBotHub

CodyBotHub 是一个独立的飞书 Bot 管理平台。它以工作区为运行边界，统一管理 Bot、场景、技能包、路由，以及 Codex/TraeX Agent 会话。

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
- 运行总览直接展示 SQLite 完整性、队列积压、飞书连接、服务运行时长和画像任务状态
- Codex 的模型与推理强度按“场景 → Bot → 平台 → Codex 账号默认值”逐字段继承；TraeX 按“场景 → Bot → TraeX 默认值”继承。选项由对应 App Server 实时返回，并在消息记录中保存实际值、来源和运行引擎
- 回复使用飞书 Markdown 卡片，并附带工作区、场景、技能包和实际权限信息
- 服务端部署支持任务排空：运行中的 Codex Turn 完成后才重启，新消息在排空期间持久化排队
- 支持文本、富文本、图片、文件、音频、视频和交互卡片的统一场景匹配
- 工作区通过本机目录选择器配置，技能包支持 `$` 搜索当前 Agent 可识别的 Skill

完整的数据流、匹配规则和线程规则见 [docs/architecture.md](docs/architecture.md)。

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

## Codex 与 TraeX

运行引擎在 Bot 上配置。一个 Bot 的所有消息使用同一引擎；场景只负责每轮 Prompt、工作区、技能包和模型选择，不改变 Thread 的引擎归属。

- Codex 启动参数：`codex app-server --stdio`
- TraeX 启动参数：`traex app-server --enable default_mode_request_user_input --listen stdio://`
- 两种引擎分别维护进程、模型目录、会话附件状态和 Thread ID
- Bot 切换引擎后，后续消息会新建对应引擎的 Thread Channel；旧 Channel、消息记录和审计数据继续保留
- 智能 Thread 复用只在同一 Bot、工作区、场景和运行引擎内检索，避免把 Codex Thread ID 交给 TraeX，或反向混用

服务器必须先安装所选 CLI，并确保服务账号能直接执行对应命令。TraeX 未安装时，现有 Codex Bot 继续正常运行；TraeX Bot 在首次读取模型或处理消息时会返回明确的 App Server 初始化错误。可以在运行总览的 Runtime 状态和服务日志中查看各引擎状态。

Linux systemd 模板默认使用 `/home/gouchao/.local/bin/traex`，并将 `~/.local/bin` 加入服务 PATH。TraeX 安装完成后，应以运行 CodyBotHub 的同一系统账号执行 `traex login status`；IDE Remote Server 的登录态不会自动等同于 TraeX CLI 登录态。

## Core 依赖

`@codycodeagent/cody-web-core` 固定到经过验证的 Git Tag，确保不同机器安装到相同的 Feishu 与 Agent 会话底座。Core 提供 Codex/TraeX Runtime Profile、App Server 生命周期、协议归一化与 Session Manager；Hub 负责 Bot 选择、持久路由、队列和管理界面。

## 部署

### 为什么不能直接重启

Codex Turn 可能运行几分钟甚至更久。直接执行 `systemctl restart codybothub.service` 会向进程发送停止信号；如果 systemd 在 Turn 结束前强制结束进程，本轮调查会失败，飞书只能收到中断错误。

生产环境统一使用 [scripts/deploy.sh](scripts/deploy.sh)。它会在切换版本前进入**排空状态**：

1. 先拉取、安装依赖并构建新版本，此时线上服务继续运行。
2. 向服务发送 `SIGUSR2`，停止启动新的 Codex Turn。
3. 排空期间仍然接收飞书消息，并把消息与任务持久化到 SQLite 队列。
4. 等待正在运行的 Turn 和飞书回执处理完毕。
5. 原子切换前端资源，重启服务并检查健康状态。
6. 新进程启动后自动继续消费排空期间积压的任务。

因此，排空不是停止接收消息，也不会丢弃消息；它只暂停从持久队列中启动新任务。

### 日常发布命令

发布脚本需要在部署服务器的仓库目录中运行：

```bash
# 登录当前生产服务器
ssh 'gouchao@fdbd:dc01:ff:31d:5830:b5a4:4263:f20b'
cd /home/gouchao/code/github/CodyBotHub

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

systemd 用户服务模板位于 [deploy/codybothub.service](deploy/codybothub.service)。首次部署或模板更新后执行：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/codybothub.service ~/.config/systemd/user/codybothub.service
systemctl --user daemon-reload
systemctl --user enable --now codybothub.service
```

模板将 `TimeoutStopSec` 设置为 20 分钟，作为误操作 `stop/restart` 时的最后保护。日常发布仍应使用部署脚本，因为脚本会在发送停止信号前完成构建、主动排空并验证健康状态。

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
