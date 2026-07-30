# Common repository checks. Run `just check-all` before opening a pull request.

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all --check

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

test:
    cargo test --workspace --all-features

samples:
    cargo run --locked -p tmd-cli -- validate tmd-sample/sample.tmd
    cargo run --locked -p tmd-cli -- validate tmd-sample/sample.tmdp

doc:
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps

extension:
    npm ci --prefix tmd-vscode
    npm run check --prefix tmd-vscode
    npm test --prefix tmd-vscode
    npm run pack --prefix tmd-vscode

check-all: fmt-check lint test samples doc extension
