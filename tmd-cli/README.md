# tmd-cli

`tmd-cli` is the command-line interface for working with Tanu Markdown (`.tmd` / `.tmdp`) documents. It creates new documents, converts formats, validates embedded database metadata, exports Markdown to HTML, and manages the embedded SQLite database.

## Build & Run

```bash
cargo run -p tmd-cli -- --help
```

If you prefer a release build:

```bash
cargo build --release -p tmd-cli
```

## Commands

### Create a New Document

```bash
cargo run -p tmd-cli -- new ./notes.tmd --title "Project Notes"
```

Creates a `.tmdp` or `.tmd` document (based on the extension) with a ready-to-use embedded SQLite database.

### Convert Between `.tmdp` and `.tmd`

```bash
cargo run -p tmd-cli -- convert ./notes.tmd ./notes.tmdp
```

### Validate a Document

```bash
cargo run -p tmd-cli -- validate ./notes.tmd
```

Validation checks the embedded database schema version in `manifest.db_schema_version` against `PRAGMA user_version`.

### Export HTML

```bash
cargo run -p tmd-cli -- export-html ./notes.tmd ./notes.html
```

To inline attachments as base64 data URIs:

```bash
cargo run -p tmd-cli -- export-html ./notes.tmd ./notes.html --self-contained
```

### Embedded Database Commands

#### Initialize / Reset the DB Schema

```bash
cargo run -p tmd-cli -- db init ./notes.tmd --schema ./schema.sql --version 1
```

#### Execute SQL

```bash
cargo run -p tmd-cli -- db exec ./notes.tmd --sql "SELECT name FROM sqlite_master"
```

#### Import / Export the Database

```bash
cargo run -p tmd-cli -- db import ./notes.tmd ./db.sqlite
cargo run -p tmd-cli -- db export ./notes.tmd ./db.sqlite
```

## Notes

- The output format is inferred from the file extension (`.tmdp` or `.tmd`).
- When the embedded database is updated, the document manifest `modified_utc` timestamp is refreshed automatically.
