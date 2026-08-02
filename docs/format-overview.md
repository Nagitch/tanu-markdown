# Tanu Markdown Format Overview

This document describes the format implemented by `tmd-core`. It is an
implementation-level overview. The normative implemented contract is the
[TMD 1.0 draft specification](spec-tmd-1.0-draft.md).

## Logical document

A Tanu Markdown document contains:

- UTF-8 Markdown;
- a JSON manifest;
- attachment metadata and bytes;
- an embedded SQLite 3 database.

## `.tmd`

`.tmd` is the ZIP representation. The implemented archive contains:

```text
manifest.json
index.md
attachments.json
db/main.sqlite3
<attachment logical paths>
```

Attachment logical paths use `/` separators. Empty/absolute paths, `.`, `..`,
control characters, `:`, reserved container names, duplicate IDs, and duplicate
paths are rejected. `attachments.json` records UUID, logical path, MIME type,
byte length, SHA-256 digest, and optional display metadata.

## Validation

Default reads:

- parse required JSON and SQLite entries;
- require `db/main.sqlite3` to have a SQLite 3 header;
- reject unsafe, duplicate, or undeclared ZIP entry names;
- reject invalid UTF-8 Markdown;
- verify attachment byte lengths and SHA-256 digests when present.

Structured document validation additionally checks TMD major-version support,
cover-image IDs, `attach:` Markdown references, and manifest/database schema
versions. Path-based writes use same-directory temporary files and atomic
replacement. Replacements preserve existing file permissions and final
symbolic links; newly created documents use ordinary creation permissions
subject to the process umask. Dangling final symbolic links are rejected.

The CLI accepts document paths with the `.tmd` extension. `tmd-core` exposes a
single-format read/write API.

## Compatibility

The manifest schema and archive entry set have a versioned implemented draft,
but not a stable compatibility promise. Changes require:

- a dedicated GitHub Issue;
- compatibility analysis;
- updated round-trip and malformed-input fixtures;
- updates to this document and component documentation.

The current draft intentionally defines only the `.tmd` ZIP representation;
alternate-format APIs and tooling are outside the implemented contract.

Dynamic SQLite and structured-attachment views are not implemented in this
draft. See the non-normative
[dynamic data views design proposal](dynamic-data-views.md) and its tracking
[issue #35](https://github.com/Nagitch/tanu-markdown/issues/35).
