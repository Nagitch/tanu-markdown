# 🤖 AGENT.md — Tanu Markdown Project

## 🦝 Project Overview

**Tanu Markdown (TMD)** is a *self-contained Markdown format* that allows embedding of **images, databases, and structured data** directly within a Markdown file.  
It combines a human-readable `.tmd` document with an internal ZIP section containing a `manifest.json` and binary attachments.

Goal:  
> Make Markdown as expressive as Notion or Excel, while staying file-based, versionable, and hackable.

---

## 🧩 Repository Structure

| Directory | Purpose |
|------------|----------|
| `tmd-core/` | Rust library defining `.tmd` parsing, manifest handling, and serialization logic |
| `tmd-cli/` | Rust command-line tool using `tmd-core` |
| `tmd-vscode/` | VSCode extension for authoring and previewing `.tmd` documents |
| `tmd-sample/` | Reference examples (`.tmd`, `.tmdz`) and structure docs |
| `README.md` | Project overview (Japanese) |
| `README_EN.md` | Project overview (English) |

---

## 🧭 Agent’s Role

The agent acts as a **technical collaborator** and **documentation maintainer**.  
It may also assist in code generation, CI validation, and format testing.

### Primary Responsibilities

1. **Documentation support**
   - Keep `README.md` and `README_EN.md` synchronized.
   - Generate or update developer documentation and examples.
   - Maintain format specification drafts (`docs/spec_tmd_v1.md`).

2. **Code scaffolding**
   - Generate or update boilerplate code for Rust (`tmd-core`, `tmd-cli`) or TypeScript (`tmd-vscode`).
   - Suggest consistent module structures and naming conventions.

3. **Build and validation**
   - Run or simulate `cargo test`, `cargo fmt`, and `npm run compile` checks.
   - Verify `.tmd` files can be read/written consistently using test fixtures.

4. **Conversation awareness**
   - Maintain understanding of `.tmd` file structure and polyglot format.
   - Respond to contributor prompts with code, examples, or documentation changes.

5. **Future goals**
   - Help design `.tmd` → `.html` / `.pdf` exporters.
   - Draft API bindings (FFI/WASM) for multi-language integrations.

---

## 🛠️ Guidelines

### Code Style
- Rust: `cargo fmt --all` and `clippy::pedantic` compliance.
- TypeScript: `eslint --fix`, no implicit `any`.
- Use explicit types for manifest structures.

### Documentation
- Use `///` doc comments in Rust.
- Each crate and module must have an introductory `//!` comment.
- Generate Markdown-based specs under `docs/`.

### Versioning
- Semantic Versioning (`0.x` for MVP, `1.0` once `.tmd` spec is stable).
- `.tmd` files include a `schemaVersion` string (`YYYY.MM`).

---

## 🧪 Tests and Validation

Test coverage should include:

| Type | Example |
|------|----------|
| Unit | Markdown/ZIP boundary detection |
| Integration | CLI round-trip: `.tmd` → `.tmdz` → `.tmd` |
| Editor | Validate VSCode extension behavior with `.tmd` mock data |
| Spec | Ensure `manifest.json` adheres to schema |

Automated tests can be added under:

```

tmd-core/tests/
tmd-cli/tests/

```

---

## 🌐 Communication

Preferred commit message format:

```

[tmd-core] Implement manifest writer
[tmd-cli] Add --validate command
[tmd-vscode] Add attach: link inserter
[docs] Update format diagram

```

Preferred PR description format:

```

### Summary

Explain the motivation and scope.

### Changes

* Added/Updated files
* Implementation notes

### Validation

* [ ] Built successfully
* [ ] Tested with sample.tmd

```

---

## 💬 Example Prompts for the Agent

> “Generate Rust code to parse the EOCD comment in `.tmd` files.”  
> “Add a new VSCode command to export `.tmd` as HTML.”  
> “Draft the v1 specification for the TMD manifest schema.”  
> “Explain how to use `tmd-cli` to validate a document.”  

---

## ⚖️ License

MIT License  
(c) 2025 Tanu Markdown Project  
All contributions should follow the [Contributor Covenant](https://www.contributor-covenant.org/).

---

🧡 *This agent helps Tanu Markdown evolve — reproducible documents for everyone.*

