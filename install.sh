#!/usr/bin/env bash
#
# devrt installer
#
#   curl -fsSL https://raw.githubusercontent.com/EdwinjJ1/devrt/main/install.sh | bash
#
# Installs the devrt CLI globally via npm from the GitHub repository.

set -euo pipefail

REPO="github:EdwinjJ1/devrt"
MIN_NODE_MAJOR=20

info()  { printf '\033[1;34m[devrt]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[devrt]\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "Node.js is required (>= ${MIN_NODE_MAJOR}). Install it from https://nodejs.org and re-run."
command -v npm  >/dev/null 2>&1 || error "npm is required. It ships with Node.js — install Node.js >= ${MIN_NODE_MAJOR} and re-run."
command -v git  >/dev/null 2>&1 || error "git is required to install from GitHub."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]; then
  error "Node.js >= ${MIN_NODE_MAJOR} is required (found $(node -v))."
fi

info "Installing devrt from ${REPO} ..."
npm install -g "${REPO}"

info "Installed: $(command -v devrt)"
info "Try it out:"
printf '\n'
printf '  cd your-project\n'
printf '  devrt init --agent   # set up .devrt/ + agent entrypoints (AGENTS.md, CLAUDE.md)\n'
printf '  devrt help           # list all commands\n'
printf '\n'
