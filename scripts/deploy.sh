#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${CODY_BOT_HUB_SERVICE_NAME:-codybothub.service}"
SERVICE_PORT="${CODY_BOT_HUB_PORT:-3003}"
STATUS_URL="${CODY_BOT_HUB_DEPLOY_STATUS_URL:-http://[::1]:${SERVICE_PORT}/api/deployment-status}"
HEALTH_URL="${CODY_BOT_HUB_DEPLOY_HEALTH_URL:-http://[::1]:${SERVICE_PORT}/api/health}"
DRAIN_TIMEOUT_SECONDS="${CODY_BOT_HUB_DEPLOY_DRAIN_TIMEOUT_SECONDS:-1200}"
WEB_ONLY=false
WEB_DIRECTORY="${REPOSITORY_DIR}/apps/web"
WEB_STAGE="${WEB_DIRECTORY}/dist.next"
WEB_DIST="${WEB_DIRECTORY}/dist"
drain_requested=false
restart_started=false

if [[ "${1:-}" == "--web-only" ]]; then WEB_ONLY=true; fi
if [[ $# -gt 0 && "${1:-}" != "--web-only" ]]; then
  echo "Usage: $0 [--web-only]" >&2
  exit 2
fi

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  rm -rf "${WEB_STAGE}"
  if [[ "${drain_requested}" == true && "${restart_started}" == false ]]; then
    echo "Deployment stopped; resuming queued work."
    systemctl --user kill --signal=SIGUSR1 "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "${HOME}/.local/bin"
  corepack enable --install-directory "${HOME}/.local/bin"
  export PATH="${HOME}/.local/bin:${PATH}"
fi

build_web() {
  rm -rf "${WEB_STAGE}"
  pnpm --filter @cody-bot-hub/web exec vue-tsc --noEmit
  pnpm --filter @cody-bot-hub/web exec vite build --outDir dist.next --emptyOutDir
}

activate_web() {
  mkdir -p "${WEB_DIST}/assets"
  cp -a "${WEB_STAGE}/assets/." "${WEB_DIST}/assets/"
  while IFS= read -r -d '' file; do cp -a "${file}" "${WEB_DIST}/"; done < <(find "${WEB_STAGE}" -mindepth 1 -maxdepth 1 -type f ! -name 'index.html' -print0)
  cp "${WEB_STAGE}/index.html" "${WEB_DIST}/index.html.next"
  mv -f "${WEB_DIST}/index.html.next" "${WEB_DIST}/index.html"
  rm -rf "${WEB_STAGE}"
}

cd "${REPOSITORY_DIR}"
git pull --ff-only origin main
pnpm install --frozen-lockfile
build_web

if [[ "${WEB_ONLY}" == true ]]; then
  activate_web
  echo "Web assets published without restarting ${SERVICE_NAME}."
  exit 0
fi

pnpm --filter @cody-bot-hub/server build
systemctl --user kill --signal=SIGUSR2 "${SERVICE_NAME}"
drain_requested=true
deadline=$((SECONDS + DRAIN_TIMEOUT_SECONDS))

while true; do
  status_json="$(curl --noproxy '*' --fail --silent --show-error "${STATUS_URL}")"
  read -r draining active_jobs pending_receipts queued_jobs < <(node -e 'const value = JSON.parse(process.argv[1]); console.log(Boolean(value.draining), Number(value.activeJobs || 0), Number(value.pendingReceipts || 0), Number(value.queuedJobs || 0))' "${status_json}")
  echo "Drain status: active=${active_jobs} receipts=${pending_receipts} queued=${queued_jobs}"
  if [[ "${draining}" == true && "${active_jobs}" == 0 && "${pending_receipts}" == 0 ]]; then break; fi
  if (( SECONDS >= deadline )); then
    echo "Drain timed out after ${DRAIN_TIMEOUT_SECONDS}s; deployment cancelled." >&2
    exit 1
  fi
  sleep 2
done

activate_web
restart_started=true
systemctl --user restart "${SERVICE_NAME}"

for _ in {1..30}; do
  if curl --noproxy '*' --fail --silent "${HEALTH_URL}" >/dev/null; then
    drain_requested=false
    echo "Deployment complete; ${SERVICE_NAME} is healthy."
    exit 0
  fi
  sleep 2
done

echo "Service did not become healthy after restart." >&2
exit 1
