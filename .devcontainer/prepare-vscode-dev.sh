#!/usr/bin/env bash
set -euo pipefail

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_dir}"

cargo build --locked -p tmd-cli
npm run compile --prefix tmd-vscode

install -D -m 0755 target/debug/tmd tmd-vscode/bin/tmd
cargo run --locked -p tmd-cli -- validate tmd-sample/sample.tmd

echo "VS Code development build is ready: tmd-vscode/bin/tmd"
