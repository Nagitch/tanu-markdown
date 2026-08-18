# 0006: Publish documents atomically with revision checks

- Status: Accepted
- Decision date: 2026-07-31

## Context

Saving a self-contained archive is a read-modify-write operation. VS Code
commands, attachment changes, previews, validation, external file writes, and
multiple editor messages can overlap. A direct overwrite can lose newer bytes,
publish an invalid partial archive, or apply a result to an editor revision
that is no longer current.

## Decision

Stage a complete candidate document, validate it, and publish its exact bytes
with the checked atomic-publication boundary used by `tmd publish`. The caller
supplies the expected destination state (a content digest or absence). Before
replacement, the CLI checks that state while holding an advisory lock on the
current destination; a mismatch at that check fails as a conflict. Path writes
then use same-directory temporary files and atomic replacement while preserving
supported metadata and rejecting unsafe symlink or hard-link cases.

This is not an unconditional filesystem compare-and-swap operation. The lock
coordinates cooperating publishers, but a non-cooperating process can modify or
rename the destination after the check and before replacement. Such a change can
still be overwritten.

Within the editor, `LocalTmdSession` owns retained container bytes and monotonic
draft/persisted revisions. Serialize all document I/O and mutations through a
per-document queue. Apply asynchronous preview or validation results only when
their originating revision is still relevant, and mark validation stale after
any edit.

## Consequences

- Atomic replacement exposes one complete validated container instead of a
  partially written container.
- External changes observed at the revision check, including racing saves from
  cooperating publishers, become explicit conflicts.
- Non-cooperating filesystem writers remain a race and can be overwritten after
  the revision check.
- Save, backup, revert, attachment, export, and validation workflows share a
  revision model.
- Full staging and hashing add I/O, memory, and state-management cost.
- Filesystem metadata that cannot be preserved safely must cause a refusal
  rather than a best-effort overwrite.

## Alternatives considered

- **Write directly to the destination**: simpler and faster, but exposes partial
  files and silent overwrite races.
- **Use last-writer-wins atomic rename only**: prevents partial files but still
  overwrites external changes.
- **Use long-lived filesystem locks**: coordinates cooperating processes but
  has portability and recovery problems and does not identify stale UI results.

## References

- [Format overview](../format-overview.md)
- [`tmd publish`](../../tmd-cli/README.md#atomic-publication)
- [Tanu Markdown Editor concurrency contract](../../tmd-vscode/README.md)
- Pull request [#30](https://github.com/Nagitch/tanu-markdown/pull/30)
