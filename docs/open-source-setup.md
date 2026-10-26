# 公开环境与可选集成

CodyBotHub 的基础开发、类型检查和单元测试可以在公开环境运行。接入真实消息或执行 Agent Turn 时，需要另外配置对应服务；仓库不会提供登录态、服务凭据或内部网络访问。

| 能力 | 公开环境所需条件 | 基础开发/CI 是否需要 |
| --- | --- | --- |
| 管理端、HTTP API、SQLite、单元测试 | Node.js 22.16+、pnpm 11.7.0 | 是 |
| Codex Agent Turn | 已安装并登录的 Codex CLI | 否 |
| 飞书 Bot 消息与审批 | 自己的飞书应用及所需权限 | 否 |
| TraeX Agent Turn | 可合法获取且已登录的 TraeX CLI | 否 |
| Bits RPC 工具 | 可访问的 `gdpa-cli` 与目标服务权限 | 否 |
| Linux systemd 用户服务 | Linux、systemd 用户实例、已构建代码 | 否 |

测试或贡献无需访问 ByteDance 内部安装源。没有某种 Agent CLI 时，不要为测试而切换现有 Bot 的运行引擎。请只使用自己有权访问的账号、服务与数据。

## 配置和部署边界

- 本地开发：`corepack enable && pnpm install --frozen-lockfile && pnpm dev`；默认只监听本机。示例配置见 [.env.example](../.env.example)，应用不会自动读取该文件。
- Linux 新装：先 `pnpm build`，再运行 `./skills/codybothub-setup/scripts/install-service.sh --dry-run` 检查将生成的 unit，确认后按需加 `--port`、`--host` 安装。安装器会从当前机器解析路径；不要直接复制仓库内的示例 unit。
- 已运行服务的升级：`scripts/deploy.sh` 是面向维护者的原地升级脚本，会拉取 `origin/main`、排空任务并重启服务；它不是贡献者开发命令，也不是自动发布流水线。运行前先确认目标提交、数据库备份和 CI 状态。
- 生产密钥：由运行环境或受权限保护的配置文件注入。不要把 `.env`、Token、飞书 App Secret、真实主机名或个人路径加入提交。

当前仓库没有稳定版本发布线或自动生产部署。CI 只验证变更，不会部署或接触生产凭据。
