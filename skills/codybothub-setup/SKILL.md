---
name: codybothub-setup
description: Install, authenticate, configure, deploy, upgrade, and diagnose CodyBotHub with Codex or TraeX. Use when setting up this repository for local development or a Linux systemd service, or when its Agent runtime is unavailable.
---

# CodyBotHub Setup

Bring CodyBotHub to a working, verified state. Reuse the repository scripts and preserve existing SQLite data, Bot credentials, and running Agent tasks.

## Start with evidence

Run the read-only environment check from the repository root:

```bash
./skills/codybothub-setup/scripts/doctor.sh
```

Use its output to decide what is missing. Do not confuse a Trae IDE Remote Server process with the `traex` CLI: CodyBotHub requires an executable CLI that supports `traex app-server`.

## Install only what is missing

- Require Node.js 22.16 or newer.
- Use the repository-pinned pnpm version through Corepack when `pnpm` is absent:

  ```bash
  mkdir -p "$HOME/.local/bin"
  corepack enable --install-directory "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$PATH"
  ```

- Install the Codex CLI when the selected Bot runtime is Codex and `codex` is absent, normally with `npm install --global @openai/codex`. Verify authentication with `codex login status`; when login is required, run `codex login`, present the browser/device flow to the user, and wait for completion.
- Install the TraeX CLI when the selected Bot runtime is TraeX and `traex` is absent. In the ByteDance environment, the repository-tested installer is:

  ```bash
  curl -fsSL https://code.byted.org/api/tos-proxy/download/traex_install.sh -o /tmp/traex_install.sh
  TRAEX_INSTALL_ASSUME_YES=1 TRAEX_INSTALL_CHANNEL=alpha bash /tmp/traex_install.sh
  ```

  Read the downloaded script before execution when the source or environment differs. Verify authentication with `traex login status`; when login is required, run `traex login --sso-device`, give the authorization URL to the user, and wait until the CLI reports success.

Authentication must use the same operating-system account that runs CodyBotHub. Never copy tokens between users or print credentials.

## Build and validate

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm check
```

For local development, start `pnpm dev` and verify `http://127.0.0.1:4310/api/health`. The management UI is normally at `http://127.0.0.1:5173`.

For a Linux user service, build first and install the generated systemd unit:

```bash
pnpm build
./skills/codybothub-setup/scripts/install-service.sh --port 3003
```

The installer resolves the current repository, Node, Codex, and TraeX paths instead of copying the machine-specific example in `deploy/codybothub.service`. If only one Agent CLI is installed, the other runtime remains unavailable without affecting Bots using the installed runtime.

On first launch, open `/auth` and let the user create the protected administrator account. Do not invent or retain their password. Then configure workspaces, Bot credentials, runtime, model, scenes, and skill packages in the management UI.

## Upgrade safely

Use the draining deployment script for an existing service:

```bash
./scripts/deploy.sh
```

Use `./scripts/deploy.sh --web-only` when only `apps/web` changed. Do not replace this with a direct `systemctl restart`: active turns must drain, while new messages remain safely queued in SQLite.

## Verify the real runtime

After installation or upgrade, verify all applicable layers:

```bash
systemctl --user is-active codybothub.service
curl --noproxy '*' --fail http://127.0.0.1:3003/api/health
codex login status       # when Codex is enabled
traex login status       # when TraeX is enabled
```

Open the Bot editor and confirm that selecting the intended runtime loads its live model catalog. For a deeper smoke test, create a temporary Agent thread and request a fixed one-line reply; do not switch or save an existing production Bot merely to test the runtime.

When verification fails, inspect `journalctl --user -u codybothub.service -n 200 --no-pager`, the Runtime section on the overview page, and the doctor output. Report the exact failed layer: CLI installation, authentication, App Server initialization, model discovery, thread creation, turn execution, Feishu connection, or HTTP health.

## Operational invariants

- Preserve `.data` during installs and upgrades; it contains SQLite state and encrypted secrets.
- Keep `@codycodeagent/cody-web-core` pinned to the repository lockfile.
- Never place Feishu App Secrets, login tokens, or administrator passwords in Git, command output, or documentation.
- Existing Bot runtime choices are production configuration. Change them only when the user asks.
- A successful setup report includes command paths, login status, health result, model discovery result, and one real turn result when that runtime was explicitly requested for verification.

Read [../../docs/architecture.md](../../docs/architecture.md) only when the task requires routing, queue, Thread Channel, or storage details.
