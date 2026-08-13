# Tanu Markdown Container Specification 1.0 (Draft)

Status: implemented draft<br>
Version: 1.0.0-draft.5<br>
Last reviewed: 2026-08-11

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
    "schema_version": 8,
    "sources": {
      "sheet": {
        "type": "formula",
        "columns": [
          { "id": "c1", "name": "label", "constraint": "text" },
          { "id": "c2", "name": "value", "constraint": "any" }
        ],
        "rows": [
          {
            "id": "r1",
            "cells": [
              { "content": { "kind": "literal", "value": { "type": "string", "value": "Total" } } },
              { "content": { "kind": "formula", "expression": "1 + 2" }, "constraint": "number" }
            ]
          }
        ]
      }
    }
  }
}
```

Registry schema version 8 exposes only `type = "formula"` and `type = "rhai"`.
A Formula definition containing `columns` and `rows` is a managed Formula table.
Columns and rows MUST have unique stable identifiers using the source-name
character set. Column names MUST be unique. Every row MUST contain exactly one
cell per ordered column. A column MUST declare `constraint` as `any`, `text`,
`number`, or `boolean`; a cell MAY declare an override using the same values.
The effective constraint is the cell override when present and the column
constraint otherwise. Null satisfies every constraint; other literal and
evaluated values MUST match it.

A managed cell `content` is exactly one of a tagged `literal` with a typed
`value`, or a tagged `formula` with a non-empty, single-line right-hand-side
`expression` that has no leading `=`. Typed literals are null, boolean, real,
string, or integer; integer JSON values MUST be canonical decimal strings in
the signed 64-bit range. Formulas are evaluated together over the ordered grid
using the schema-version-3 language and A1 coordinates. The table and complete
lowered Formula program are bounded. A Formula result is validated against its
effective constraint after evaluation.

Schema version 8 adds the optional boolean `identity` field to managed columns.
A table MUST contain at most one identity column. Its evaluated values MUST be
non-null and unique. Identity columns are visible in the table value exposed to
Markdown, Rhai, the CLI, and the editor. The editor assigns a new visible text
identity when a row is inserted or duplicated in an identity-bearing table.

A Formula MAY perform an explicit bounded lookup with
`REF("source", identity, "target_column")`. The first and third arguments MUST
be text literals. The second argument is evaluated as a scalar identity. The
source MUST resolve to a managed Formula table with exactly one identity
column, and a non-null identity MUST match exactly one row. Missing or duplicate
identities, missing columns, and evaluation cycles produce Formula diagnostics.
Direct REF is an ordinary expression and MAY be combined with other operators
and functions.

Schema version 8 also adds optional `reference_groups`. A group declares a
stable id, a managed target source, covered local row ids, and mappings from
local column ids to target column ids. For each covered row, mapped cells MUST
all be null or direct three-argument REF expressions with one shared source and
identity and the mapped target column. A reference group is an editor
constraint, not a separate Formula mode: releasing it leaves the formulas
unchanged.

Schema version 7 hidden columns, column `reference` metadata, and
`REF([@reference_column], "target_column")` remain readable for compatibility.
Current editors MUST NOT create them and emit schema version 8 after a supported
migration. A lossless compatibility round trip MAY retain schema version 7 when
legacy hidden-column metadata has not been migrated.

A Formula definition containing `query` and optional `edit` is the legacy
query Formula mode:
an identity Formula table that applies no cell program. The query MUST contain
one non-empty, read-only statement. Query output is normalized to an ordered
table of column labels and scalar cells. A `scalar` view requires exactly one
row and one column; a `table` view preserves query column and row order.
Authors MUST use `ORDER BY` when stable row order is required.

Legacy registry schema version 1 used `type = "sqlite"` for the same query
shape. Versions 1 through 4 remain readable; readers normalize those legacy
definitions to query Formula sources in memory. Writers serialize current
registries as schema version 8 and MUST NOT emit `type = "sqlite"`.

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
value MUST resolve to a compatible Formula table in the same registry. In
schema versions 6 and 7 this means a managed Formula table or a query Formula; Rhai
and computed Formula inputs remain invalid. Input rows become arrays of maps
keyed by unique result-column labels.

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
append derived columns. Formula assignments MAY overlay the input rectangle,
populate appended columns, and extend the row count; unassigned derived cells
are null.

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

Registry schema version 4 retains all earlier source types and adds an optional
SQLite `edit` contract. It declares a target table, a query-result key mapped
to its table key column, and the exact query-result-to-table column mappings
that may be written. Identifiers are bounded and restricted. The key MUST be
non-null and unique in the evaluated query result, and an update MUST match
exactly one table row. Implementations MUST apply a staged edit batch in one
transaction and MUST NOT infer write-back identity from a displayed row index
or arbitrary SELECT shape.

Registry schema version 5 replaces the source-level `sqlite` tag with the
query Formula shape shown above. Computed Formula definitions retain their
schema-version-3 `input`, `program`, and `output` fields. A computed Formula
`input` and every Rhai `inputs` value MUST resolve directly to a query Formula,
not to another computed Formula or a Rhai source. This preserves the existing
acyclic evaluation graph while reducing the current public source tags to
Formula and Rhai.

Registry schema version 6 adds SQLite-independent managed Formula tables with
stable row and column identities, typed literals, progressive column/cell
constraints, per-cell formulas, and optional declarative column references.
Rhai inputs may resolve to managed or query Formula tables. Query and computed
Formula definitions remain readable for compatibility, while current authoring
tools create managed Formula and Rhai definitions.

Registry schema version 7 adds trailing hidden managed columns and explicit
bounded cross-table `REF` evaluation. Current authoring tools use these fields
only when reading legacy documents.

Registry schema version 8 replaces newly authored hidden relationships with a
visible target identity column, self-contained three-argument `REF`, and
unlockable reference-group editing constraints. Normalization no longer adds a
source-side key column.

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
Draft 6 adds registry schema version 4, explicit primary-keyed SQLite
write-back contracts, and Formula assignments over input cells while retaining
schema version 1 through 3 reads.
Draft 7 adds registry schema version 5, represents read-only database queries
as identity Formula sources, emits only Formula and Rhai source tags, and
retains schema version 1 through 4 reads by normalizing legacy SQLite sources.
Draft 8 adds registry schema version 6, document-native managed Formula tables,
progressive constraints, per-cell formulas, stable relationship metadata, and
managed-Formula-to-Rhai inputs while retaining schema version 1 through 5 reads.
Draft 9 adds registry schema version 7, trailing hidden relationship storage,
and bounded `REF` evaluation while retaining schema version 1 through 6 reads.
Draft 10 adds registry schema version 8, visible identities, direct REF,
reference-group editing constraints, and string concatenation with `+` while
retaining schema version 1 through 7 reads.
