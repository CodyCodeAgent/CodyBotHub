#!/usr/bin/env bash
set -uo pipefail

REPOSITORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${CODY_BOT_HUB_PORT:-3003}"
export PATH="${HOME}/.local/bin:${PATH}"

status_line() {
  local name="$1" status="$2" detail="$3"
  printf '%-18s %-10s %s\n' "${name}" "${status}" "${detail}"
}

command_check() {
  local name="$1" command_name="$2"
  local command_path
  command_path="$(command -v "${command_name}" 2>/dev/null || true)"
  if [[ -n "${command_path}" ]]; then
    status_line "${name}" "OK" "${command_path}"
  else
    status_line "${name}" "MISSING" "${command_name} is not on PATH"
  fi
}

echo "CodyBotHub environment doctor"
status_line "repository" "OK" "${REPOSITORY_DIR}"
status_line "platform" "INFO" "$(uname -srm)"

node_path="$(command -v node 2>/dev/null || true)"
if [[ -n "${node_path}" ]]; then
  node_version="$(node --version 2>/dev/null || true)"
  node_numbers="${node_version#v}"
  node_major="${node_numbers%%.*}"
  node_rest="${node_numbers#*.}"
  node_minor="${node_rest%%.*}"
  if [[ "${node_major}" =~ ^[0-9]+$ && "${node_minor}" =~ ^[0-9]+$ ]] && (( node_major > 22 || (node_major == 22 && node_minor >= 16) )); then
    status_line "node" "OK" "${node_path} ${node_version}"
  else
    status_line "node" "UPGRADE" "${node_path} ${node_version:-unknown}; require >=22.16"
  fi
else
  status_line "node" "MISSING" "require >=22.16"
fi

command_check "pnpm" "pnpm"
command_check "git" "git"
command_check "curl" "curl"
command_check "codex" "codex"
command_check "traex" "traex"

if command -v codex >/dev/null 2>&1; then
  codex_status="$(codex login status 2>&1 || true)"
  status_line "codex auth" "$([[ "${codex_status}" =~ [Ll]ogged ]] && echo OK || echo LOGIN)" "${codex_status//$'\n'/ }"
fi

if command -v traex >/dev/null 2>&1; then
  traex_status="$(traex login status 2>&1 || true)"
  status_line "traex auth" "$([[ "${traex_status}" =~ [Ll]ogged ]] && echo OK || echo LOGIN)" "${traex_status//$'\n'/ }"
fi

if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1; then
  service_state="$(systemctl --user is-active codybothub.service 2>/dev/null || true)"
  status_line "systemd service" "$([[ "${service_state}" == active ]] && echo OK || echo INFO)" "${service_state:-not-installed}"
else
  status_line "systemd service" "SKIP" "Linux user systemd only"
fi

health_url="http://127.0.0.1:${PORT}/api/health"
health="$(curl --noproxy '*' --max-time 2 --fail --silent "${health_url}" 2>/dev/null || true)"
if [[ -n "${health}" ]]; then
  status_line "HTTP health" "OK" "${health_url} ${health}"
else
  status_line "HTTP health" "INFO" "not reachable at ${health_url}"
fi
