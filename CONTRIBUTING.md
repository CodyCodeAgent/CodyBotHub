# 参与 CodyBotHub

感谢参与。小范围修正可以直接提交 PR；较大的功能或行为变更，请先开 Issue 讨论目标、兼容性和归属边界。参与讨论和评审时请遵守 [社区行为准则](CODE_OF_CONDUCT.md)。安全漏洞不要提交公开 Issue，请按 [SECURITY.md](SECURITY.md) 私密报告。

## 开发环境

- Node.js 22.16 或更新版本、Git、Corepack；仓库通过 `packageManager` 固定 pnpm 11.7.0。
- 克隆仓库后运行 `corepack enable`、`pnpm install --frozen-lockfile`、`pnpm dev`。
- 默认管理端为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:4310`。不接入真实飞书 Bot，也可以开发管理界面和运行单元测试。
- 可选环境变量见 [.env.example](.env.example) 和 [README](README.md#开发)。该示例仅用于说明，应用不会自动加载 `.env` 文件；请由 shell 或运行环境注入变量。
- Codex、TraeX、飞书和 Bits RPC 分别需要自己的 CLI、账号或服务权限。TraeX 和 Bits RPC 不是运行基础测试的前提；不要将内部安装源或凭据加入公开仓库。

## 提交前

运行 `pnpm check`（类型检查、测试、构建）。修改工作区 Git 同步逻辑时，再运行 `CODY_FULL_GIT_TESTS=1 pnpm --filter @cody-bot-hub/server exec vitest run tests/workspace-sync.spec.ts`；这组测试会创建多个临时仓库，耗时较长。提交 PR 时说明验证结果、涉及的数据迁移和兼容性风险；UI 变更请附截图。CI 会在 PR 上自动运行 `pnpm check`。

产品实体与规则放在 CodyBotHub；可复用的协议、Agent 会话和通道原语归 [CodyWebCore](https://github.com/CodyCodeAgent/CodyWebCore)。更多边界见 [架构文档](docs/architecture.md) 和 [AGENTS.md](AGENTS.md)。不要提交真实 Token、飞书 App Secret、用户信息或生产日志。

维护者会通过 PR 评审合并变更。当前项目尚未建立稳定版本发布线；如果变更依赖特定运行时版本，请在 PR 中写明。

维护者的手动版本发布流程见 [docs/releasing.md](docs/releasing.md)。
