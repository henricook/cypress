#!/usr/bin/env bash
# Install Node (from .node-version) and Yarn 1.22.x into ~/.cypress-ci/ on Windows CI.
# Paths live outside ~/cypress so a later `checkout` step does not delete them.

set -euo pipefail

NODE_VER="$(tr -d '[:space:]' < "${CIRCLE_WORKING_DIRECTORY:-$PWD}/.node-version")"
CI_ROOT="${CYPRESS_CI_TOOLCHAIN:-$HOME/.cypress-ci}"
NODE_DIR="${CI_ROOT}/node"
YARN_PREFIX="${CI_ROOT}/yarn"

mkdir -p "${CI_ROOT}"
rm -rf "${NODE_DIR}" "${YARN_PREFIX}"
mkdir -p "${NODE_DIR}"

ZIP="node-v${NODE_VER}-win-x64.zip"
URL="https://nodejs.org/dist/v${NODE_VER}/${ZIP}"
TMP="/tmp/${ZIP}"

echo "Downloading Node ${NODE_VER} for Windows x64..."
curl -fsSL "${URL}" -o "${TMP}"
unzip -q "${TMP}" -d "${NODE_DIR}"
rm -f "${TMP}"

NESTED="${NODE_DIR}/node-v${NODE_VER}-win-x64"
if [[ -d "${NESTED}" ]]; then
  mv "${NESTED}"/* "${NODE_DIR}/"
  rmdir "${NESTED}" 2>/dev/null || rm -rf "${NESTED}"
fi

export PATH="${NODE_DIR}:${PATH}"

echo "Installing Yarn 1.22.22 under ${YARN_PREFIX}..."
mkdir -p "${YARN_PREFIX}"
npm install yarn@1.22.22 --prefix "${YARN_PREFIX}" --no-fund --no-audit

echo "Node: $(command -v node) ($(node --version))"
echo "Yarn: $(command -v yarn) ($(yarn --version))"
