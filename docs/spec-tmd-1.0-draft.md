# Tanu Markdown Container Specification 1.0 (Draft)

Status: implemented draft<br>
Version: 1.0.0-draft.2<br>
Last reviewed: 2026-08-02

This document defines the container contract implemented by `tmd-core`
`0.0.1`. It is versioned so implementation and interoperability tests can
target a precise contract, but it is not a stability promise. Normative terms
such as MUST and SHOULD follow RFC 2119 usage.

## 1. Logical document

A Tanu Markdown document contains:

- UTF-8 Markdown;
- a JSON manifest;
- zero or more attachments with JSON metadata;
- one SQLite 3 database.

A logical document is represented as a `.tmd` ZIP archive.

## 2. Required ZIP entries

Every container MUST contain exactly one of each required entry:

```text
manifest.json
index.md
attachments.json
db/main.sqlite3
```

Each attachment declared by `attachments.json` MUST have exactly one ZIP entry
whose name equals its `logical_path`. ZIP entry names MUST be enclosed relative
paths. Duplicate, unsafe, or undeclared entry names are invalid. Readers
implementing this draft MUST reject entries other than the four required
entries and declared attachments.

ZIP compression method and entry ordering are not part of the contract.
Current writers use stored entries.

## 3. `manifest.json`

`manifest.json` is UTF-8 JSON with this implemented shape:

```json
{
  "tmd_version": { "major": 1, "minor": 0, "patch": 0 },
  "doc_id": "UUID",
  "title": "Optional title",
  "authors": [],
  "created_utc": "RFC 3339 timestamp",
  "modified_utc": "RFC 3339 timestamp",
  "tags": [],
  "cover_image": null,
  "links": [],
  "db_schema_version": null,
  "extras": null
}
```

`title`, `cover_image`, and `db_schema_version` may be `null`.
`cover_image`, when present, is `{ "id": "attachment UUID" }` and MUST resolve
to declared attachment metadata. `db_schema_version`, when present, MUST equal
SQLite `PRAGMA user_version`. Readers implementing this draft MUST reject or
report unsupported `tmd_version.major` values; this implementation supports
major version 1. This implementation refuses to rewrite documents with an
unsupported major version because unknown manifest fields cannot be preserved.

`extras` is reserved for application data that can be represented by any JSON
value. Unknown top-level manifest fields are not currently preserved.

## 4. Markdown

`index.md` MUST be valid UTF-8.

`index.md` is the document Markdown.

Links and images may reference an attachment using:

```markdown
[download](attach:files/report.pdf)
![diagram](attach:images/diagram.png)
```

The substring after `attach:` is an exact logical-path reference. It MUST be a
canonical attachment logical path and MUST resolve to one declared attachment.

## 5. `attachments.json`

The file is UTF-8 JSON:

```json
{
  "attachments": [
    {
      "id": "UUID",
      "logical_path": "attachments/example.txt",
      "mime": "text/plain",
      "length": 12,
      "sha256": "64 lowercase or uppercase hexadecimal digits",
      "title": null,
      "alt": null,
      "extras": null
    }
  ]
}
```

Attachment IDs and logical paths MUST be unique. `length` MUST equal the ZIP
entry's uncompressed byte length. If `sha256` is present, it MUST equal the
SHA-256 digest of the bytes. Writers SHOULD emit SHA-256 values; the default
writer always recomputes them.

A persisted logical path is canonical when all of these conditions hold:

- it is non-empty and relative;
- it uses `/`, never `\`, as its separator;
- it has no empty, `.` or `..` component;
- it has no control character or `:` in any component;
- it is not one of the four reserved entry names in section 2.

The core creation API accepts some non-canonical input such as repeated
separators and normalizes it before persistence. Container readers require the
persisted value itself to be canonical.

## 6. Embedded database

`db/main.sqlite3` MUST begin with the 16-byte SQLite 3 header
`SQLite format 3\0` and MUST be openable by SQLite. The database is
application-defined. TMD uses SQLite `PRAGMA user_version` as its unsigned
schema-version value and compares it with `manifest.db_schema_version` when
that manifest field is present.

## 7. Validation and mutation

Default reads validate structural JSON/ZIP/SQLite requirements, canonical and
unique attachment identity, byte lengths, and present SHA-256 digests.
`validate_document` additionally reports:

- unsupported TMD major versions;
- manifest/database schema-version mismatch;
- missing cover-image IDs;
- unresolved or invalid Markdown `attach:` references;
- missing attachment hashes as warnings.

Path-based writes create a temporary file in the destination directory, flush
and synchronize it, then replace the destination. A failure before replacement
MUST preserve an existing destination.

## 8. Compatibility policy

This draft describes `tmd_version` 1.0.0, but repository packages remain
pre-1.0. Any incompatible change requires a dedicated issue, updated tests and
documentation, and an explicit migration/compatibility decision. Consumers
must not infer long-term compatibility until this document is marked stable.
Draft 2 intentionally narrows the container contract to the single `.tmd` ZIP
representation and removes alternate-format APIs and tooling.
