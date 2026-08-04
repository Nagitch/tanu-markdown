#!/usr/bin/env bash
set -euo pipefail

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_dir}"

rustup show active-toolchain
cargo --version
node --version
npm --version

npm ci --prefix tmd-vscode
bash .devcontainer/prepare-vscode-dev.sh
