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

`.tmd` is the primary ZIP representation. The implemented archive contains:

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

## `.tmdp`

`.tmdp` is a polyglot representation:

```text
+-----------------------------+
| UTF-8 Markdown              |
+-----------------------------+
| ZIP archive                 |
| (same entries as .tmd)      |
+-----------------------------+
| ZIP EOCD comment            |
| "TMD1\0" + markdown length  |
+-----------------------------+
```

The Markdown length is an unsigned 64-bit little-endian value immediately
following the five-byte `TMD1\0` prefix. The EOCD comment must contain exactly
those 13 bytes.

The ZIP archive still contains `index.md`. When reading `.tmdp`, the leading
Markdown is authoritative for `TmdDoc.markdown`.

## Detection and validation

The current sniffer treats input beginning with the ZIP local-file signature
`PK\x03\x04` as `.tmd`; non-empty input is otherwise considered `.tmdp`.

Default reads:

- parse required JSON and SQLite entries;
- require `db/main.sqlite3` to have a SQLite 3 header;
- reject unsafe or duplicate ZIP entry names;
- reject malformed `.tmdp` comments and invalid UTF-8 Markdown;
- verify attachment byte lengths and SHA-256 digests when present.

Structured document validation additionally checks TMD major-version support,
cover-image IDs, `attach:` Markdown references, and manifest/database schema
versions. Path-based writes use same-directory temporary files and atomic
replacement.

File extensions select output format in the CLI. Callers of `tmd-core` can pass
an explicit `Format`.

## Compatibility

The manifest schema, archive entry set, and EOCD comment now have a versioned
implemented draft, but not a stable compatibility promise. Changes require:

- a dedicated GitHub Issue;
- compatibility analysis;
- updated round-trip and malformed-input fixtures;
- updates to this document and component documentation.
