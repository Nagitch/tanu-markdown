# Tanu Markdown Container Specification 1.0 (Draft)

Status: implemented draft<br>
Version: 1.0.0-draft.3<br>
Last reviewed: 2026-08-03

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
value. When `extras` is an object, the optional `tmd_data_sources` member has
the implemented meaning described in section 4. Unknown top-level manifest
fields are not currently preserved.

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

### 4.1 Dynamic data views

Markdown may select a named data source inline or in a fenced block:

````markdown
The first note is **{{tmd-view:first-note}}**.

```tmd-view:table
source = "sample-notes"
```
````

An inline reference always requests `scalar`. A block info string requests one
of `scalar`, `table`, `list`, or `code`; this draft implements `scalar` and
`table`, while `list` and `code` are reserved and produce an unsupported-view
diagnostic. The block body accepts `source = "name"`; the reserved `code`
renderer may also accept `format = "name"`. Names are case-sensitive and MUST
contain 1 to 128 ASCII letters, digits, `.`, `_`, or `-`.

Source definitions are stored in a versioned registry inside
`manifest.extras`:

```json
{
  "tmd_data_sources": {
    "schema_version": 1,
    "sources": {
      "first-note": {
        "type": "sqlite",
        "query": "SELECT body FROM sample_notes WHERE id = 1"
      },
      "sample-notes": {
        "type": "sqlite",
        "query": "SELECT id, body FROM sample_notes ORDER BY id"
      }
    }
  }
}
```

Registry schema version 1 implements only `type = "sqlite"`. A SQLite source
MUST contain one non-empty, read-only statement. Query output is normalized to
an ordered table of column labels and scalar cells. A `scalar` view requires
exactly one row and one column; a `table` view preserves query column and row
order. Authors MUST use `ORDER BY` when stable row order is required.

SQLite `NULL`, integer, finite real, and UTF-8 text values are supported.
SQLite BLOB values, non-finite real values, invalid UTF-8 text, and incompatible
result shapes produce diagnostics. Implementations bound source names, query
size, row count, column count, cell count, and text size. Renderers MUST escape
all source-produced values and MUST NOT reparse them as Markdown or HTML.

Registry schema version 2 retains SQLite sources and adds sandboxed Rhai table
transformations. A Rhai definition has this shape:

```json
{
  "type": "rhai",
  "script": "views/category-summary.rhai",
  "inputs": {
    "sales": "sales"
  },
  "output": {
    "type": "table",
    "columns": ["category", "total_cents"]
  }
}
```

`script` MUST be the canonical logical path of a declared UTF-8 attachment.
Each `inputs` key is the alias exposed beneath the Rhai `inputs` map, and each
value MUST resolve to a SQLite source in the same registry. Rhai sources MUST
NOT directly depend on other Rhai sources in schema version 2. SQLite input
rows become arrays of maps keyed by unique result-column labels.

The Rhai result MUST be an array of maps. Every map MUST contain exactly the
declared `output.columns`; the declaration determines column order. Supported
cell values are null/unit, boolean, signed integer, finite real, and UTF-8
string. Scripts and results are bounded. The implemented host exposes no
filesystem, process, environment, network, module, or time API and suppresses
script print/debug output. Evaluation failures, resource-limit violations, and
result-shape mismatches produce diagnostics.

Registry schema version 3 retains SQLite and Rhai sources and adds bounded
Formula table transformations. A Formula definition has this shape:

```json
{
  "type": "formula",
  "input": "sales",
  "program": "C1 = SUM(B1:B3)\nC2 = C1\nC3 = [@amount_cents] * 2",
  "output": {
    "type": "table",
    "columns": ["category", "amount_cents", "total_cents"]
  }
}
```

`input` MUST resolve directly to a SQLite source in the same registry. Its
query result order defines the Formula sheet order. The declared
`output.columns` MUST begin with the input's exact ordered column labels and MAY
append derived columns. Formula assignments MUST NOT target the input
rectangle. They MAY populate appended columns and extend the row count;
unassigned derived cells are null.

`program` MUST be non-empty UTF-8 containing one `cell = expression`
assignment per non-comment line. `//` starts a comment outside string and
header references. A cell uses one-based A1 notation over data rows, so `A1`
is the first query-result cell and headers are not rows. `$A$1` is accepted as
the same coordinate without relative-copy semantics. `A1:C3` is a rectangular
range, `[header]` selects that exact output column across the original input row
extent, `[@header]` selects the target row in that output column, and
`HEADER(B)` returns an output label.

The language supports null, boolean, signed integer, finite real, and string
literals; arithmetic, comparison, and unary operators; and `SUM`, `AVERAGE`,
`MIN`, `MAX`, `COUNT`, `IF`, `AND`, `OR`, `NOT`, `ROUND`, `ABS`, `CONCAT`,
`LEN`, and `ISNULL`. Types are strict. Formula dependencies are evaluated
independent of program order; cycles produce diagnostics. Implementations MUST
parse into an internal representation rather than interpolate Formula text
into Rhai or SQL. Programs, syntax complexity, evaluation work, generated
text, and table shape are bounded. Parse and runtime diagnostics identify a
source line and column and use a stable typed error category.

These references use ordinary Markdown text and fenced blocks, so unaware
readers retain passive placeholders rather than executing a query. The source
registry is namespaced in `extras` so it does not add a ZIP entry.

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
- invalid dynamic-data registries and references;
- unresolved sources, unsupported renderers, failed source evaluation, and
  incompatible result shapes;
- missing attachment hashes as warnings.

Path-based writes create a temporary file in the destination directory, flush
and synchronize it, then replace the destination. A failure before replacement
MUST preserve an existing destination.

## 8. Compatibility policy

This draft describes `tmd_version` 1.0.0, but repository packages remain
pre-1.0. Any incompatible change requires a dedicated issue, updated tests and
documentation, and an explicit migration/compatibility decision. Consumers
must not infer long-term compatibility until this document is marked stable.
Draft 2 intentionally narrowed the container contract to the single `.tmd` ZIP
representation and removed alternate-format APIs and tooling. Draft 3 defines
the implemented, backward-readable SQLite `scalar` and `table` dynamic-view
extension under `manifest.extras.tmd_data_sources`. Draft 4 adds registry
schema version 2 and sandboxed Rhai-to-table transformations while retaining
schema version 1 reads. Draft 5 adds registry schema version 3 and bounded
Formula table transformations while retaining schema version 1 and 2 reads.
This addition is tracked in
[issue #45](https://github.com/Nagitch/tanu-markdown/issues/45).
