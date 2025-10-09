# 🦝 Tanu Markdown (TMD)

**this is very AI generated bare scaffolding. make sure this is not guaranteed to work normally.**

**Tanu Markdown (TMD)** is a *self-contained Markdown format* that lets you embed **images, databases, and binary data** directly into Markdown.

Each `.tmd` file combines **Markdown text + embedded assets + metadata (manifest)** into a single portable document.

---

## 📦 Repository Structure

| Directory | Description |
|------------|-------------|
| `tmd-sample/` | `.tmd` / `.tmdz` samples and format reference |
| `tmd-vscode/` | VSCode extension (TypeScript) |
| `tmd-core/` | Rust library core (data structures, manifest handling) |
| `tmd-cli/` | Rust CLI tool for TMD document operations |

---

## 🧩 File Format Overview

### `.tmd` — Polyglot Format (Markdown + ZIP)

```
+------------------------+
| Markdown (UTF-8 text)  |
+------------------------+
| ZIP archive (manifest, |
| images/, data/, etc.)  |
+------------------------+
| EOCD comment           |
|  TMD1\0<md_len_le64>   |
+------------------------+
```

### `.tmdz` — ZIP format

- Same as `.tmd` but stored as a regular ZIP file  
- Contains `index.md`, `manifest.json`, `images/`, and `data/`

---

## 🧰 Components

### `tmd-vscode/`
A **VSCode extension (MVP)** implemented in TypeScript providing:
- New `.tmd` creation
- Insert `attach:` links
- Validate & Convert to `.tmdz` (stub)

### `tmd-core/`
Rust library defining the TMD document model:
- `TmdDoc` structure for Markdown, manifest, and attachments
- `to_bytes()` / `open_bytes()` (stubs for polyglot serialization)

### `tmd-cli/`
Rust CLI utility for working with `.tmd` files.
```bash
cargo run -- new mydoc.tmd --title "My Document"
cargo run -- validate mydoc.tmd
cargo run -- export-html mydoc.tmd out.html --self-contained
```

---

## 🧱 Roadmap

- [ ] Implement `.tmd` read/write logic (EOCD parsing, ZIP build)
- [ ] Attachment management UI in VSCode extension
- [ ] `.tmd` → HTML / PDF export
- [ ] SQLite embedding and SQL evaluation
- [ ] Draft formal file specification

---

## 📜 License

MIT License  
(c) 2025 Tanu Markdown Project

---

🧡 *Tanu Markdown — Markdown that packs everything inside.*
