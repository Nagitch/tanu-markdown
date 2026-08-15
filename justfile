# Common repository checks. Run `just check-all` before opening a pull request.

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all --check

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

test:
    cargo test --workspace --all-features

samples-build:
    cargo run --locked -p tmd-core --example generate_business_samples
    cargo run --locked -p tmd-core --example generate_rpg_samples

samples:
    for sample in tmd-sample/*.tmd; do cargo run --locked -p tmd-cli -- validate "$sample"; done

doc:
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps

extension:
    npm ci --prefix tmd-vscode
    npm run check --prefix tmd-vscode
    npm test --prefix tmd-vscode
    TMD_E2E_CLI="../target/debug/tmd" npm run test:e2e --prefix tmd-vscode
    npm run pack --prefix tmd-vscode

check-all: fmt-check lint test samples doc extension
