# tmd-cli

`tmd-cli` is the command-line interface for working with Tanu Markdown (`.tmd` / `.tmdz`) documents. It creates new documents, converts formats, validates embedded database metadata, exports Markdown to HTML, and manages the embedded SQLite database.

## Build & Run

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- --help
```

If you prefer a release build:

```bash
cargo build --release --manifest-path tmd-cli/Cargo.toml
```

## Commands

### Create a New Document

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- new ./notes.tmd --title "Project Notes"
```

Creates a `.tmd` or `.tmdz` document (based on the extension) with a ready-to-use embedded SQLite database.

### Convert Between `.tmd` and `.tmdz`

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- convert ./notes.tmd ./notes.tmdz
```

### Validate a Document

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- validate ./notes.tmdz
```

Validation checks the embedded database schema version in `manifest.db_schema_version` against `PRAGMA user_version`.

### Export HTML

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- export-html ./notes.tmdz ./notes.html
```

To inline attachments as base64 data URIs:

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- export-html ./notes.tmdz ./notes.html --self-contained
```

### Embedded Database Commands

#### Initialize / Reset the DB Schema

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- db init ./notes.tmdz --schema ./schema.sql --version 1
```

#### Execute SQL

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- db exec ./notes.tmdz --sql "SELECT name FROM sqlite_master"
```

#### Import / Export the Database

```bash
cargo run --manifest-path tmd-cli/Cargo.toml -- db import ./notes.tmdz ./db.sqlite
cargo run --manifest-path tmd-cli/Cargo.toml -- db export ./notes.tmdz ./db.sqlite
```

## Notes

- The output format is inferred from the file extension (`.tmd` or `.tmdz`).
- When the embedded database is updated, the document manifest `modified_utc` timestamp is refreshed automatically.
