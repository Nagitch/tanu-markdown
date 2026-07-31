# Publish Readiness

Publishing is disabled for every Cargo workspace member. This checklist tracks
future readiness without authorizing publication.

## Policy

- Do not run `cargo publish`, publish the VS Code extension, create releases, or
  create release tags.
- `cargo publish --dry-run` requires an explicit readiness issue.
- Keep package metadata, READMEs, documentation, tests, and dependency
  lockfiles current.
- Treat the file format and C ABI as unstable until dedicated stabilization
  work is complete.

## Packages

| Package | Future candidate | Metadata | README | Primary blocker |
| --- | --- | --- | --- | --- |
| `tmd-core` | yes | present | present | Freeze the format contract and complete public API documentation |
| `tmd-cli` | undecided | present | present | Define installation and support policy |
| `tmd-core-ffi` | undecided | present | present | Define ABI versioning, headers, and packaging |
| `tanu-markdown-editor` | undecided | present | present | Complete privacy, marketplace metadata, and release review |

## Pre-publication gates

- [x] A versioned implemented TMD draft and pre-1.0 compatibility policy exist.
- [ ] All public Rust APIs have accurate documentation and coverage.
- [ ] Package contents have been reviewed with `cargo package --list`.
- [ ] Candidate packages no longer inherit `publish = false` through an
      explicitly reviewed change.
- [ ] `cargo publish --dry-run` passes for each candidate.
- [ ] The C ABI has a documented header and versioning strategy before any FFI
      artifact is distributed.
- [ ] The VS Code extension has tests and user documentation; privacy review,
      marketplace metadata, and release approval remain.
- [ ] CI passes on the exact release commit.

## Current decision

No package is approved for publication. Repository maintenance should improve
readiness without crossing this gate.
