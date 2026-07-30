---
name: Work item
about: Define one scoped unit of implementation, documentation, verification, or design work.
title: ""
labels: ""
assignees: ""
---

## Summary

<!-- What should change, in one or two sentences? -->

## Why

<!-- Link related specifications, documentation, failures, or observed gaps. -->

## Scope

- <!-- Included item -->

## Out of Scope

- <!-- Excluded item -->

## Definition of Done

- [ ] The requested behavior, documentation, or decision is complete.
- [ ] Tests or verification evidence cover the change when applicable.
- [ ] Public API changes include Rust documentation and examples when applicable.
- [ ] Architecture, format, README, or component documentation is current.
- [ ] No known contradiction remains between implementation and documentation.

## Verification

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- [ ] `cargo test --workspace --all-features`
- [ ] `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps`
- [ ] `npm ci --prefix tmd-vscode && npm run check --prefix tmd-vscode`

## Expected Files or Areas

- <!-- File or area -->

## Notes for Codex

- Prefer a focused PR that closes this issue.
- Preserve existing file-format and CLI behavior unless this issue explicitly changes it.
- English documentation is the source of truth.
