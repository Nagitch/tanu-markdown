# tmd-core API Guide

`tmd-core` is a Rust library for reading and writing Tanu Markdown (`.tmd` / `.tmdz`) documents. A single `TmdDoc` struct holds the Markdown body, manifest, attachments, and an embedded SQLite database. This guide summarizes the public API surface and how to use it.

## Dependencies
Add the following to your `Cargo.toml`:

```toml
[dependencies]
tmd-core = { path = "../tmd-core" }
mime = "0.3"
```

## Key Types and Aliases

- `TmdDoc` — Document container that holds Markdown, `Manifest`, `AttachmentStore`, and `DbHandle`.【F:tmd-core/src/lib.rs†L38-L113】
- `Manifest` — Document metadata (version, authors, tags, links, schema version). Uses `Semver` for the TMD version.【F:tmd-core/src/lib.rs†L212-L261】
- `AttachmentStore` — Manages attachment metadata and bytes; enumerable via `AttachmentStoreIter`.【F:tmd-core/src/lib.rs†L214-L235】【F:tmd-core/src/lib.rs†L273-L361】
- `AttachmentDataMut` — Smart pointer that provides mutable access to attachment data and recomputes length/SHA-256 on drop.【F:tmd-core/src/lib.rs†L520-L548】
- `DbHandle` — Holds the SQLite connection and executes SQL via `with_conn`/`with_conn_mut`.【F:tmd-core/src/lib.rs†L5-L9】【F:tmd-core/src/lib.rs†L575-L624】
- `DbOptions` — Applies PRAGMAs such as `page_size`, `journal_mode`, and `synchronous` during `ensure_initialized`.【F:tmd-core/src/lib.rs†L551-L595】
- `Format` — Identifies `Tmd` (plain) vs `Tmdz` (ZIP-embedded).【F:tmd-core/src/lib.rs†L702-L743】
- `ReadMode` / `WriteMode` — Read/write options for validation and ZIP creation.【F:tmd-core/src/lib.rs†L343-L431】
- `AttachmentId` / `LogicalPath` — Aliases for attachment UUID and logical path.【F:tmd-core/src/lib.rs†L17-L20】
- `TmdResult<T>` / `TmdError` — Result/error types used across the library.【F:tmd-core/src/lib.rs†L21-L53】

## Creating and Saving Documents

### Create a New Document

```rust
use mime::IMAGE_PNG;
use tmd_core::{write_to_path, AttachmentId, Format, TmdDoc};

fn main() -> tmd_core::TmdResult<()> {
    // Create an empty document from Markdown text
    let mut doc = TmdDoc::new("# Hello TMD".to_string())?;

    // Add an attachment (SHA-256 auto-computed; duplicate paths error)
    let _logo: AttachmentId = doc.add_attachment("images/logo.png", IMAGE_PNG, b"...bytes...")?;

    // Save as TMDZ
    write_to_path("hello.tmdz", &doc, Format::Tmdz)?;
    Ok(())
}
```

- `TmdDoc::new` initializes a default manifest and empty SQLite database.【F:tmd-core/src/lib.rs†L36-L101】
- `write_to_path` emits `.tmd` or `.tmdz` based on `Format`.【F:tmd-core/src/lib.rs†L702-L726】
- `add_attachment` returns `TmdError::Attachment` on logical path collisions.【F:tmd-core/src/lib.rs†L272-L332】

### Load an Existing Document

```rust
use tmd_core::{read_from_path, Format, ReadMode};

fn main() -> tmd_core::TmdResult<()> {
    // Auto-detect format from extension (or header)
    let doc = read_from_path("hello.tmdz", None)?;
    println!("Title: {:?}, tags: {:?}", doc.manifest.title, doc.manifest.tags);

    // Control verification and lazy loading
    use std::fs::File;
    use std::io::{BufReader, Seek};
    use tmd_core::{Reader, TmdDoc};

    let file = File::open("hello.tmdz")?;
    let mut reader = Reader::new(BufReader::new(file), Some(Format::Tmdz), ReadMode {
        verify_hashes: true,
        lazy_attachments: false,
    })?;
    let doc: TmdDoc = reader.read_doc()?;
    Ok(())
}
```

- `sniff_format` inspects the header to auto-detect the format.【F:tmd-core/src/lib.rs†L433-L452】
- `sniff_format` reads the ZIP EOCD comment and does not rely solely on the extension.【F:tmd-core/src/lib.rs†L702-L743】
- `ReadMode::verify_hashes = true` checks attachment lengths and SHA-256 values.【F:tmd-core/src/lib.rs†L343-L387】
- `ReadMode::lazy_attachments = true` defers attachment loading (default: `false`).【F:tmd-core/src/lib.rs†L343-L387】

## Attachment Operations

- Add: `add_attachment` (buffer) or `add_attachment_stream` (streaming). The streaming variant reads on a background thread and returns `TmdError::Attachment` on failure.【F:tmd-core/src/lib.rs†L65-L116】
- Remove: `remove_attachment(id)`.【F:tmd-core/src/lib.rs†L136-L145】
- Rename: `rename_attachment(id, new_path)` with path normalization.【F:tmd-core/src/lib.rs†L145-L158】【F:tmd-core/src/lib.rs†L416-L434】
- Fetch metadata: `attachment_meta(id)` / `attachment_meta_by_path(path)`.【F:tmd-core/src/lib.rs†L149-L158】
- List: `list_attachments()` returns `AttachmentStoreIter`.【F:tmd-core/src/lib.rs†L158-L168】
- Access data: `attachments.data(id)` yields `&[u8]`; `attachments.iter_with_data()` enumerates metadata and bytes.【F:tmd-core/src/lib.rs†L443-L484】
- Mutate data: `attachments.data_mut(id)` returns `AttachmentDataMut`; dropping it updates `length` and `sha256`.【F:tmd-core/src/lib.rs†L447-L548】
- Verified insert: `attachments.insert_entry(meta, data, verify_hashes)` checks length/SHA-256 while inserting metadata and bytes together.【F:tmd-core/src/lib.rs†L469-L520】

## Editing the Manifest

Edit `TmdDoc.manifest` directly or replace it with `with_manifest`.

```rust
use tmd_core::{Manifest, Semver, TmdDoc};
use uuid::Uuid;

let manifest = Manifest {
    tmd_version: Semver { major: 1, minor: 0, patch: 0 },
    doc_id: Uuid::new_v4(),
    title: Some("Notebook".into()),
    authors: vec!["Alice".into()],
    created_utc: tmd_core::now_utc(),
    modified_utc: tmd_core::now_utc(),
    tags: vec!["demo".into()],
    cover_image: None,
    links: vec![],
    db_schema_version: None,
    extras: serde_json::json!({ "category": "sample" }),
};
let doc = TmdDoc::new("# Document".into())?.with_manifest(manifest);
```

Calling `touch()` updates only `modified_utc` to the current time.【F:tmd-core/src/lib.rs†L151-L158】

## Embedded Database

- Read-only: `db_with_conn(|conn| { /* SELECT ... */ })` on `TmdDoc`.【F:tmd-core/src/lib.rs†L164-L171】
- Write: `db_with_conn_mut(|conn| { /* INSERT/UPDATE */ })`; converts `rusqlite::Error` into `TmdError::Db`.【F:tmd-core/src/lib.rs†L171-L174】【F:tmd-core/src/lib.rs†L24-L53】
- Free functions: `with_conn(doc, f)` / `with_conn_mut(doc, f)` are shortcuts that take a `TmdDoc`.【F:tmd-core/src/lib.rs†L641-L652】
- Export/import: `export_db(doc, path)` writes the temp DB to disk; `import_db(doc, path)` replaces it. `reset_db(doc, schema_sql, version)` applies SQL and updates `PRAGMA user_version`.【F:tmd-core/src/lib.rs†L652-L677】
- Migration: `migrate(doc, up_sql, from, to)` asserts the current `user_version` matches `from`, applies `up_sql`, then moves to `to`.【F:tmd-core/src/lib.rs†L677-L700】
- Initialization options: pass `DbOptions` to `DbHandle::ensure_initialized` to pre-apply PRAGMAs like `page_size` or `journal_mode`.【F:tmd-core/src/lib.rs†L551-L614】

## Read/Write Options

- `ReadMode` — `verify_hashes` (attachment hash validation), `lazy_attachments` (deferred loading).【F:tmd-core/src/lib.rs†L343-L387】
- `WriteMode` — `compute_hashes` (emit SHA-256), `solid_zip` (store ZIP as a single stream), `dedup_by_hash` (deduplicate attachments).【F:tmd-core/src/lib.rs†L387-L431】
- `Reader::new(reader, assumed, mode)` detects/validates the format and reads via `Reader::read_doc()`.【F:tmd-core/src/lib.rs†L744-L806】
- `Writer::new(writer, format, mode)` builds a write context; `Writer::write_doc(&doc)` outputs data and `finish()` releases resources.【F:tmd-core/src/lib.rs†L806-L844】
- Low-level I/O: `read_tmd` / `read_tmdz` / `write_tmd` / `write_tmdz` operate directly on `Read`/`Write` streams.【F:tmd-core/src/lib.rs†L965-L1095】
- Path helpers: `read_from_path(path, assumed)` chooses `Format` from extension or header; `write_to_path(path, doc, format)` dispatches per `Format`.【F:tmd-core/src/lib.rs†L1085-L1107】

## Error Handling

All functions return `TmdResult<T>` and yield `TmdError` on failure.

- I/O: `TmdError::Io`
- JSON: `TmdError::Json`
- ZIP: `TmdError::Zip`
- Attachments: `TmdError::Attachment` (duplicates, hash mismatch, path validation errors, etc.)
- Format: `TmdError::InvalidFormat` (bad EOCD signature, invalid comment length, etc.)
- DB: `TmdError::Db` (stringified `rusqlite` errors).【F:tmd-core/src/lib.rs†L21-L53】【F:tmd-core/src/lib.rs†L598-L679】

## Typical Workflow

1. Create with `TmdDoc::new` or load with `read_from_path`.
2. Edit Markdown, update the manifest, add/remove attachments.
3. Update the DB with `db_with_conn_mut` and advance schemas with `migrate` as needed.
4. Save as `.tmd` or `.tmdz` via `write_to_path` / `Writer`.

When using `write_tmdz` / `write_tmd` directly, control hash computation and ZIP options through `WriteMode`.【F:tmd-core/src/lib.rs†L598-L679】

## Utilities

- `now_utc()` — Wrapper around `chrono::Utc::now()`.【F:tmd-core/src/lib.rs†L189-L194】
- `normalize_logical_path(input)` — Normalizes attachment paths to POSIX form and rejects empty, absolute, or `..` paths.【F:tmd-core/src/lib.rs†L194-L214】

## FFI (Optional)

Enabling the `ffi` feature exposes C-compatible functions for reading/writing documents and retrieving errors. Key entry points include the following.【F:tmd-core/src/lib.rs†L1109-L1458】

- Document management: `tmd_doc_new` / `tmd_doc_free` / `tmd_doc_markdown` / `tmd_doc_set_markdown`
- Path I/O: `tmd_read_from_path` / `tmd_write_to_path`
- Metadata: `tmd_doc_title` / `tmd_doc_tags` / `tmd_doc_attachments`
- Error surface: `tmd_last_error_message`
- Attachments: `tmd_doc_add_attachment` / `tmd_doc_get_attachment`

The FFI layer performs NULL checks and UTF-8 conversions, keeping dedicated error messages for misuse.
