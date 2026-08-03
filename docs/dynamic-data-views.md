# Dynamic Data Views

Status: SQLite sources and Rhai-to-table transformations implemented;
additional adapters and renderers proposed
Tracking issue: [#35](https://github.com/Nagitch/tanu-markdown/issues/35)

This document defines the implemented TMD extension for rendering embedded
SQLite data and sandboxed Rhai transformations inside document Markdown. It
also records planned extension points for declared JSON, YAML, and TOML
attachments. The implemented contract is summarized in the
[TMD 1.0 draft specification](spec-tmd-1.0-draft.md).

## Goals

- Keep data selection separate from presentation.
- Let Markdown select a named data source without embedding SQL or scripts in
  prose.
- Support inline scalar values and block-level table, list, scalar, and code
  rendering.
- Normalize SQLite, JSON, YAML, TOML, and Rhai results into one typed value
  model.
- Preserve a readable fallback in Markdown viewers that do not implement the
  extension.
- Keep evaluation read-only, bounded, deterministic where practical, and safe
  for HTML and editor previews.

The current implementation supports SQLite `scalar` and `table` output plus a
Rhai adapter that transforms declared SQLite table inputs into a table.
Structured attachment adapters remain proposed.

## Layered model

Dynamic views have three independent layers:

```text
Markdown reference
        |
        v
named data source (sqlite or rhai; structured attachments proposed)
        |
        v
common typed value
        |
        v
renderer (scalar, table, list, or code)
```

Named data sources own acquisition and selection. Markdown owns presentation.
Changing a source from SQLite to Rhai therefore does not require changing every
Markdown reference to that source.

## Markdown syntax

### Inline scalar

An inline reference has this form:

```markdown
The owner is **{{tmd-view:profile-name}}**.
```

Inline position implies `render = "scalar"`. The source must return a scalar
value. A table, array, or object result is a shape error rather than an implicit
string conversion.

### Block views

A block view uses a fenced-code info string with the render kind after a
colon. The fence body is a TOML key-value document.

````markdown
```tmd-view:table
source = "sample-notes"
```
````

The render kinds are:

````markdown
```tmd-view:scalar
source = "document-title"
```

```tmd-view:table
source = "sample-notes"
```

```tmd-view:list
source = "recent-items"
```

```tmd-view:code
source = "application-settings"
format = "toml"
```
````

The block grammar is:

```text
info string = "tmd-view:" render-kind
render-kind = "scalar" | "table" | "list" | "code"
body        = TOML key-value document
```

`source` is required. `format` is reserved for `code`; future render-specific
options such as column selection or presentation style belong in the fence
body instead of adding more colon-separated info-string segments. Render kinds
are lowercase and case-sensitive. Unknown kinds, missing required options, and
invalid fence bodies produce structured diagnostics. The current parser
implements a strict TOML-compatible subset of `key = "string"` entries.

## Unsupported-viewer fallback

The syntax uses ordinary Markdown constructs:

- an unsupported viewer retains an inline reference as readable placeholder
  text; and
- an unsupported viewer retains a block view as an ordinary fenced code block.

The `tmd-view:<render-kind>` info string is a TMD convention rather than a new
general Markdown rule. TMD-aware renderers replace the construct; other
renderers do not execute it.

## Data-source definitions

The design uses names so Markdown does not contain SQL, attachment selectors,
or executable code. Definitions are stored under a versioned, namespaced
`manifest.extras` value without changing the ZIP entry set:

```json
{
  "extras": {
    "tmd_data_sources": {
      "schema_version": 2,
      "sources": {
        "sales": {
          "type": "sqlite",
          "query": "SELECT category, amount_cents FROM sample_sales ORDER BY id"
        },
        "category-summary": {
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
      }
    }
  }
}
```

This location remains experimental. Stabilization must decide whether data
sources remain namespaced application data, become a first-class manifest
field, or move to a separate versioned container entry. A separate entry
changes the current compatibility contract because implemented readers reject
undeclared ZIP entries.

Source names are case-sensitive identifiers of 1 to 128 ASCII letters, digits,
`.`, `_`, and `-`. A name must resolve to exactly one definition in the current
document.

### SQLite

SQLite sources execute one read-only statement against `db/main.sqlite3`:

```json
{
  "type": "sqlite",
  "query": "SELECT id, body FROM sample_notes ORDER BY id"
}
```

A one-row, one-column result may be consumed by `scalar`. General query results
produce the table value described below. Authors are responsible for an
explicit `ORDER BY` when row order matters.

### JSON, YAML, and TOML (proposed)

Structured-data sources address a declared attachment and select part of its
normalized value:

```json
{
  "type": "json",
  "attachment": "data/profile.json",
  "selector": "/user/displayName"
}
```

JSON Pointer syntax is the proposed common selector language. YAML and TOML
values are normalized to the common typed value before applying the selector.
Arbitrary host filesystem paths are not valid sources. YAML custom tags and
external references are outside the initial contract; TOML date/time values
require an explicit normalization decision before implementation.

### Rhai table transformation

A Rhai source refers to a declared script attachment, maps script-visible
aliases to named SQLite sources, and declares its ordered table columns:

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

Registry schema version 2 adds this source type; schema version 1 SQLite
registries remain readable. Each `inputs` value must name a SQLite source in the
same registry. Rhai-to-Rhai dependencies are intentionally not supported in
this slice, which keeps evaluation acyclic and makes every database query
explicit.

The host injects one constant map named `inputs`. Each alias contains an array
of maps whose keys are the corresponding SQLite result-column names. SQLite
columns must therefore be unique when used as Rhai input. A script returns an
array of maps:

```rhai
let totals = #{};
for row in inputs.sales {
    if row.category in totals {
        totals[row.category] += row.amount_cents;
    } else {
        totals[row.category] = row.amount_cents;
    }
}

let output = [];
for category in totals.keys() {
    output.push(#{
        category: category,
        total_cents: totals[category]
    });
}
output
```

Every returned map must contain exactly the declared `output.columns`; missing
or extra keys are diagnostics. Column order comes from the declaration rather
than map iteration. Cells may be `()`, boolean, signed integer, finite
floating-point, or string. Nested maps, arrays, and other runtime values are
not valid cells. Authors should sort the returned array when stable row order
matters. See
[`tmd-sample/views/category-summary.rhai`](../tmd-sample/views/category-summary.rhai)
for a complete grouping example.

## Common typed value

The complete design allows every source to return one of these logical values:

- `null`;
- boolean;
- signed integer;
- floating-point number;
- UTF-8 string;
- array of typed values;
- object with string keys and typed values; or
- table with ordered column names and rows of scalar cells.

The SQLite adapter returns a table containing scalar `null`, signed integer,
finite floating-point, and UTF-8 string cells. The Rhai adapter accepts those
values as inputs, adds native booleans, and converts its declared array of maps
back to a table. General array and object values remain part of the common model
design for future structured-data adapters. Binary values are not part of the
render contract. SQLite BLOB values produce a diagnostic.

Typed values are passed directly to renderers. They are not interpolated as raw
Markdown or HTML.

## Render semantics

### `scalar`

`scalar` accepts `null`, boolean, integer, floating-point, or string values. An
inline source must produce exactly one scalar. For SQLite this means exactly one
row and one column; zero or multiple rows are diagnostics unless a future
fallback policy explicitly says otherwise.

A block scalar renders the same value as a standalone block. Renderers escape
the value while preserving surrounding author-written Markdown formatting.

### `table`

`table` accepts a table value. SQLite column labels and result order become the
ordered headers and rows. Rhai headers use the source's explicit
`output.columns`; returned array order becomes table row order. A future
structured-data adapter may convert an array of objects to a table when its
column-order rules are explicitly defined.

Cells are scalar typed values. They are escaped as cells rather than reparsed
as Markdown.

### `list` (reserved)

`list` accepts an array. Each scalar item becomes a list item. Object and nested
array rendering requires an explicit mapping option and is not inferred in the
initial contract.

### `code` (reserved)

`code` serializes a typed value into a passive code block. `format` selects a
supported serializer such as `json`, `yaml`, or `toml`. Serialization never
creates an executable HTML block.

## Evaluation and rendering pipeline

An aware renderer performs these steps:

1. Parse ordinary Markdown and recognize TMD inline references and fenced view
   blocks.
2. Resolve each unique named source definition.
3. Evaluate the source through a type-specific, read-only adapter.
4. Normalize the result to the common typed value.
5. Validate that the value shape is compatible with the requested renderer.
6. Insert escaped renderer events or DOM nodes, not generated raw Markdown.
7. Return visible per-view errors and structured validation diagnostics.

HTML export and VS Code preview must share the same evaluation semantics. The
TypeScript extension should continue to delegate container and database access
to the native CLI/core boundary instead of implementing a second TMD parser.

## Safety and resource limits

The implementation enforces these boundaries, and future adapters must
preserve equivalent boundaries:

- exactly one read-only SQLite statement;
- declared attachment paths only for structured data and Rhai scripts;
- no arbitrary filesystem, process, environment, or network access;
- bounded source-name and query bytes, rows, columns, cells, and string length;
- no Rhai modules, closures, custom syntax, time API, host I/O, or emitted
  print/debug output;
- bounded Rhai script bytes, inputs, operations, elapsed time, arrays, maps,
  variables, functions, call depth, expression depth, strings, and table
  output;
- safe YAML parsing without custom constructors or external resolution;
- escaped scalar, table-cell, list-item, and code output; and
- visible diagnostics for missing sources, selector failures, shape mismatch,
  resource limits, and evaluation errors.

The current SQLite limits are 64 KiB per query, 1,000 rows, 128 columns, 10,000
cells, and 1 MiB per text cell. Source evaluation rejects mutation statements,
multiple statements, BLOBs, non-finite reals, and invalid UTF-8.

The current Rhai limits include 256 KiB per script, 16 declared inputs, 200,000
operations, 250 ms elapsed time, 2,000 elements per array, 256 entries per map,
and the same 1,000-row/128-column/10,000-cell table boundary. These are safety
defaults for the experimental schema and may be tuned before stabilization.

## Compatibility and rollout

The current slice implements parsing and validation together with SQLite and
Rhai table evaluation in HTML export, the CLI preview bridge, and VS Code
preview. The VS Code source-management form still edits SQLite definitions;
Rhai definitions and script attachments currently use the persisted document
contract and CLI/core path. JSON, YAML, TOML, and additional renderers can use
the same source and typed-value boundaries in later slices.

Before the experimental feature becomes stable, the implementation must define:

- the persisted location and schema-version rules for source definitions;
- any additional behavior for missing values and empty SQLite results;
- structured-data normalization details;
- whether current resource-limit defaults become stable;
- cache and refresh behavior for editor previews; and
- the TMD version or capability signal understood by compatible readers.
