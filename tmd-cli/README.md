# tmd CLI

`tmd-cli` installs the `tmd` command for complete Tanu Markdown (`.tmd` /
`.tmdp`) document workflows. It is also the schema-versioned JSON boundary used
by the VS Code editor.

## Build and install

```bash
cargo run -p tmd-cli --bin tmd -- --help
cargo install --path tmd-cli
```

## Document lifecycle

```bash
tmd new notes.tmd --title "Project Notes"
tmd inspect notes.tmd --json
tmd validate notes.tmd
tmd convert notes.tmd notes.tmdp
```

Validation checks container structure and hashes while loading, then reports
TMD version support, `attach:` references, cover-image identity, and embedded
database schema consistency. Add `--json` for machine-readable output.

### Schema-versioned updates

```bash
printf '%s' '{"schema_version":1,"title":"Renamed","markdown":"# Renamed"}' \
  | tmd update notes.tmd --json-stdin
```

`update` preserves attachments, database content, manifest identity, and
creation time. It writes atomically.

### Attachments

```bash
tmd attachment add notes.tmd diagram.png --path images/diagram.png
tmd attachment list notes.tmd --json
tmd attachment rename notes.tmd --from images/diagram.png --to images/final.png
tmd attachment extract notes.tmd --path images/final.png final.png
tmd attachment remove notes.tmd --path images/final.png
```

Logical paths are normalized and checked against traversal, reserved-name, and
duplicate-path rules.

### HTML

```bash
tmd export-html notes.tmd notes.html
tmd export-html notes.tmd standalone.html --self-contained
```

Without `--self-contained`, attachments are extracted into a safe sibling
asset directory and actual `attach:` links/images are rewritten. With the flag,
the URLs become data URIs. Raw HTML in Markdown is emitted as text, external
destinations are limited to relative URLs plus `http`, `https`, `mailto`, and
`tel`, and executable data-URI MIME types are exported as
`application/octet-stream`. Linked exports use collision-free UUID-based asset
names, render Markdown attachment links as downloads, and permit only passive
attachment types as inline image sources. Export refuses an output path that
resolves to the source document.

## Embedded database

Initialize a schema:

```bash
tmd db init notes.tmd --schema schema.sql --version 1
```

Execute mutations and query with machine-readable rows:

```bash
tmd db exec notes.tmd --sql "INSERT INTO notes(body) VALUES ('hello')"
tmd db query notes.tmd --sql "SELECT * FROM notes" --json
```

`db query` accepts exactly one read-only SQLite statement. Mutations use
`db exec`.

Migrate and update both `PRAGMA user_version` and the manifest:

```bash
tmd db migrate notes.tmd --from 1 --to 2 \
  --sql "ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"
```

Import or export a standalone SQLite database:

```bash
tmd db import notes.tmd database.sqlite3
tmd db export notes.tmd database.sqlite3
```

## Contracts

- Input/output format is inferred from `.tmd` or `.tmdp`.
- Mutating commands refresh `modified_utc` and replace containers atomically.
- JSON bridge payloads currently use `schema_version: 1`.
- Format semantics and validation live in `tmd-core`, not this crate.
