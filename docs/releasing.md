# 版本发布（维护者）

仓库当前没有已发布的稳定版本或自动生产部署。GitHub Actions 只执行验证；合并 PR、打 Tag 和部署应由维护者分别确认。

首次发布前，请确定版本号与兼容性约定，并同步根目录及各 workspace package 的 `version` 字段。之后的发布按以下顺序进行：

1. 从待发布提交创建 PR，说明用户可见变化、配置或数据迁移、已知风险与回滚办法。
2. 确认 PR 的 `Check` 通过；涉及 Git 同步时运行完整 Git 回归。合并后确认 `main` 的 `Full Git tests` 通过。
3. 在 GitHub 创建对应的版本 Tag 和 Release Notes。Release Notes 至少列出主要变更、破坏性变化和升级步骤。
4. 如需升级实际服务，先核对目标提交、备份 SQLite 数据和密钥，再由有权限的维护者在目标机器运行 [部署脚本](../scripts/deploy.sh)。CI 不持有生产密钥，也不自动部署。

不要在未验证的 PR 提交上运行生产部署脚本；不要把服务器地址、账号或密钥写进 Release Notes。
