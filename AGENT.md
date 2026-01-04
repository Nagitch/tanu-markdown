# AGENT.md — Tanu Markdown Project

## Project Overview

Tanu Markdown (TMD) is a self-contained Markdown format that embeds images, databases, and structured data inside a single file. A `.tmd` document pairs human-readable Markdown with an internal ZIP section that holds `manifest.json` and binary attachments.

Project goal:

> Deliver a file-based, versionable format that matches the expressiveness of tools like Notion or Excel.

---

## Repository Structure

| Directory | Purpose |
|-----------|---------|
| `tmd-core/` | Rust library for `.tmd` parsing, manifest handling, and serialization |
| `tmd-cli/` | Rust command-line tool built on `tmd-core` |
| `tmd-vscode/` | VSCode extension for creating and previewing `.tmd` documents |
| `tmd-sample/` | Reference examples (`.tmd`, `.tmdz`) and structure documentation |
| `README.md` | Project overview (English) |
| `README_JP.md` | Project overview (Japanese) |

---

## Agent’s Role

The agent serves as a technical collaborator and documentation maintainer. It may also assist with code generation, continuous integration validation, and format testing.

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
   - Verify `.tmd` files can be read and written consistently using test fixtures.

4. **Conversation awareness**
   - Maintain understanding of `.tmd` file structure and the polyglot format.
   - Respond to contributor prompts with code, examples, or documentation changes.

5. **Future goals**
   - Design `.tmd` → `.html` / `.pdf` exporters.
   - Draft API bindings (FFI/WASM) for multi-language integrations.

---

## Guidelines

### Code Style
- Rust: `cargo fmt --all` and `clippy::pedantic` compliance.
- TypeScript: `eslint --fix`; avoid implicit `any`.
- Use explicit types for manifest structures.

### Documentation
- Use `///` doc comments in Rust.
- Each crate and module must include an introductory `//!` comment.
- Generate Markdown-based specifications under `docs/`.

### Versioning
- Follow Semantic Versioning (`0.x` for MVP, `1.0` after the `.tmd` spec stabilizes).
- `.tmd` files must include a `schemaVersion` string (`YYYY.MM`).

---

## Tests and Validation

Target coverage:

| Type | Example |
|------|---------|
| Unit | Markdown/ZIP boundary detection |
| Integration | CLI round-trip: `.tmd` → `.tmdz` → `.tmd` |
| Editor | Validate VSCode extension behavior with `.tmd` mock data |
| Specification | Ensure `manifest.json` adheres to schema |

Automated tests can be added under:

```
tmd-core/tests/
tmd-cli/tests/
```

---

## Communication

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

## Example Prompts for the Agent

> Generate Rust code to parse the EOCD comment in `.tmd` files.  
> Add a new VSCode command to export `.tmd` as HTML.  
> Draft the v1 specification for the TMD manifest schema.  
> Explain how to use `tmd-cli` to validate a document.

---

## License

MIT License  
(c) 2025 Tanu Markdown Project  
All contributions should follow the [Contributor Covenant](https://www.contributor-covenant.org/).

---

This agent helps Tanu Markdown evolve into a reproducible document format that remains file-based and versionable.
