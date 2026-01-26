# tmd-core-ffi

`tmd-core-ffi` is a small cdylib wrapper around `tmd-core` that preserves the exported C ABI symbols. It enables non-Rust consumers to read/write Tanu Markdown documents via the `tmd-core` FFI surface.

## Build

```bash
cargo build --release --manifest-path tmd-core-ffi/Cargo.toml
```

The compiled library will be placed in `tmd-core-ffi/target/release/`:

- Linux: `libtmd_core_ffi.so`
- macOS: `libtmd_core_ffi.dylib`
- Windows: `tmd_core_ffi.dll`

## Exported Symbols

The wrapper keeps the core FFI functions alive so the linker does not drop them. The exported API is defined in `tmd-core` under the `ffi` module. Common entry points include:

- `tmd_doc_new` / `tmd_doc_free`
- `tmd_doc_read_from_path` / `tmd_doc_write_to_path`
- `tmd_doc_get_markdown` / `tmd_doc_set_markdown`
- `tmd_doc_add_attachment` / `tmd_doc_get_attachment`
- `tmd_last_error_message`

Refer to `tmd-core` for the full FFI contract and error semantics.

## Notes

- This crate only exposes a stable C ABI; it does not generate headers.
- If you need C headers, generate them from the `tmd-core` FFI definitions using a tool like `cbindgen`.
