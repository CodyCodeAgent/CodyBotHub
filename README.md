# CodyBotHub

CodyBotHub 是一个独立的飞书 Bot 管理平台。它以工作区为运行边界，统一管理 Bot、场景、技能包、路由和 Codex 会话。

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
- 使用 CodyWebCore 的 Feishu Provider 与原生 Codex Session Manager 处理消息
- 通过 Thread Channel 将多个相似群或话题绑定到同一个 Codex Thread；同一 Channel 使用 SQLite 持久队列串行执行，并可在管理端查看绑定、队列和路由依据
- 飞书消息去重、审计记录和队列任务以单个 SQLite 事务落库；队列由常驻调度器自动恢复，避免进程切换窗口造成消息卡住
- 运行总览直接展示 SQLite 完整性、队列积压、飞书连接、服务运行时长和画像任务状态
- 模型与推理强度按“场景 → Bot → 平台 → Codex 账号默认值”逐字段继承，选项实时读取当前 Codex 账号，并在消息记录中保存实际值和来源
- 回复使用飞书 Markdown 卡片，并附带工作区、场景、技能包和实际权限信息
- 支持文本、富文本、图片、文件、音频、视频和交互卡片的统一场景匹配
- 工作区通过本机目录选择器配置，技能包支持 `$` 搜索当前 Codex Skill 目录

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

## Core 依赖

`@codycodeagent/cody-web-core` 固定到经过验证的 Git 提交，确保不同机器安装到相同的 Feishu 与 Codex 会话底座。升级 Core 时同步更新两个应用包中的提交引用并重新生成锁文件。
