#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT=3003
HOST='::'
DRY_RUN=false
export PATH="${HOME}/.local/bin:${PATH}"

usage() {
  echo "Usage: $0 [--port PORT] [--host HOST] [--dry-run]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?--port requires a value}"; shift 2 ;;
    --host) HOST="${2:?--host requires a value}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ ! "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: ${PORT}" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" && "${DRY_RUN}" != true ]]; then
  echo "This installer targets Linux user systemd. Use --dry-run to preview elsewhere." >&2
  exit 1
fi

if [[ "${REPOSITORY_DIR}" =~ [[:space:]] ]]; then
  echo "The Linux systemd installer requires a repository path without whitespace: ${REPOSITORY_DIR}" >&2
  exit 1
fi

NODE_COMMAND="$(command -v node 2>/dev/null || true)"
CODEX_COMMAND="$(command -v codex 2>/dev/null || true)"
TRAEX_COMMAND="$(command -v traex 2>/dev/null || true)"
[[ -n "${NODE_COMMAND}" ]] || { echo "node is required" >&2; exit 1; }
[[ -f "${REPOSITORY_DIR}/apps/server/dist/main.js" ]] || { echo "Build first with: pnpm build" >&2; exit 1; }

escape_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

LOCAL_BIN="${HOME}/.local/bin"
PATH_VALUE="${LOCAL_BIN}:$(dirname "${NODE_COMMAND}"):/usr/local/bin:/usr/bin:/bin"
UNIT_CONTENT="[Unit]
Description=CodyBotHub Feishu Bot Management Platform
Wants=network-online.target
After=network-online.target

[Service]
EnvironmentFile=-$(escape_value "${HOME}/.config/codybothub/proxy.env")
Type=simple
WorkingDirectory=$(escape_value "${REPOSITORY_DIR}")
Environment=\"NODE_ENV=production\"
Environment=\"CODY_BOT_HUB_HOST=$(escape_value "${HOST}")\"
Environment=\"CODY_BOT_HUB_PORT=${PORT}\"
Environment=\"CODY_BOT_HUB_DATA_DIR=$(escape_value "${REPOSITORY_DIR}/.data")\"
Environment=\"CODY_BOT_HUB_WEB_DIST=$(escape_value "${REPOSITORY_DIR}/apps/web/dist")\"
Environment=\"CODY_BOT_HUB_CODEX_COMMAND=$(escape_value "${CODEX_COMMAND:-codex}")\"
Environment=\"CODY_BOT_HUB_TRAEX_COMMAND=$(escape_value "${TRAEX_COMMAND:-traex}")\"
Environment=\"PATH=$(escape_value "${PATH_VALUE}")\"
ExecStart=\"$(escape_value "${NODE_COMMAND}")\" \"$(escape_value "${REPOSITORY_DIR}/apps/server/dist/main.js")\"
KillSignal=SIGTERM
TimeoutStopSec=20min
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target"

if [[ "${DRY_RUN}" == true ]]; then
  printf '%s\n' "${UNIT_CONTENT}"
  exit 0
fi

UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="${UNIT_DIR}/codybothub.service"
mkdir -p "${UNIT_DIR}" "${HOME}/.config/codybothub"
printf '%s\n' "${UNIT_CONTENT}" > "${UNIT_PATH}"
systemctl --user daemon-reload
systemctl --user enable --now codybothub.service
echo "Installed ${UNIT_PATH}"
echo "Health: http://127.0.0.1:${PORT}/api/health"
