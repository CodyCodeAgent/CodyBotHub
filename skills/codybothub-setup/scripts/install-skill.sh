#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_ROOT="${SKILL_INSTALL_ROOT:-${CODEX_HOME:-${HOME}/.codex}/skills}"
DESTINATION="${SKILLS_ROOT}/codybothub-setup"
TEMP_DIR="${SKILLS_ROOT}/.codybothub-setup.$$.tmp"

mkdir -p "${SKILLS_ROOT}"
rm -rf "${TEMP_DIR}"
cp -R "${SOURCE_DIR}" "${TEMP_DIR}"
rm -rf "${DESTINATION}"
mv "${TEMP_DIR}" "${DESTINATION}"
echo "Installed codybothub-setup to ${DESTINATION}"
echo 'Restart or reload your Agent, then invoke $codybothub-setup.'
