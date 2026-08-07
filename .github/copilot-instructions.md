# Tanu Markdown repository instructions

Follow [`AGENT.md`](../AGENT.md) and
[`docs/dev-workflow.md`](../docs/dev-workflow.md).

Key constraints:

- `.tmd` is the ZIP representation.
- `tmd-data` owns shared scalar/table values, `tmd-formula` owns Formula
  language semantics, and `tmd-core` owns format and data-source integration;
  do not duplicate these implementations in the CLI or editor.
- Preserve file-format and CLI behavior unless a linked issue explicitly
  changes it.
- Use the root Cargo workspace and lockfile.
- Run `just check-all` in the Dev Container before submitting changes.
- Keep planned work in GitHub Issues, not repository TODO files.
- Publishing crates, extensions, releases, or tags requires explicit
  authorization.
