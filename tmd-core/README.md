# tmd-core

`tmd-core` is the Rust implementation of the Tanu Markdown document model and
container I/O.

It provides:

- `.tmd` ZIP and `.tmdp` polyglot reading and writing;
- manifests, attachment metadata, path validation, and SHA-256 checks;
- an embedded SQLite handle with import, export, reset, and migration helpers;
- optional C ABI entry points behind the `ffi` feature.

It does not provide terminal or editor user interfaces. Those belong to
`tmd-cli` and `tmd-vscode`.

## Example

```rust
use mime::TEXT_PLAIN;
use tmd_core::{read_from_path, write_to_path, Format, TmdDoc};

fn main() -> tmd_core::TmdResult<()> {
    let mut document = TmdDoc::new("# Project notes\n".to_owned())?;
    document.add_attachment(
        "attachments/notes.txt",
        TEXT_PLAIN,
        b"Supporting material".to_vec(),
    )?;

    write_to_path("notes.tmd", &document, Format::Tmd)?;
    let loaded = read_from_path("notes.tmd", None)?;
    assert_eq!(loaded.markdown, document.markdown);
    Ok(())
}
```

## Main API areas

- `TmdDoc` and `Manifest` model the document.
- `AttachmentStore` owns attachment metadata and bytes.
- `Reader`, `Writer`, `ReadMode`, and `WriteMode` control container I/O.
- `DbHandle`, `import_db`, `export_db`, `reset_db`, and `migrate` manage the
  embedded database.
- `read_from_path` and `write_to_path` provide the common path-based API.

See the
[repository format overview](https://github.com/Nagitch/tanu-markdown/blob/main/docs/format-overview.md)
and generated Rust documentation for details.

## Validation

From the repository root:

```bash
cargo test -p tmd-core --all-features
cargo clippy -p tmd-core --all-targets --all-features -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc -p tmd-core --all-features --no-deps
```

This crate is pre-1.0 and is not currently publishable.
