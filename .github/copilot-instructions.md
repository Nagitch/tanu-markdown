# Tanu Markdown (TMD) - AI Assistant Instructions

## Project Overview
Tanu Markdown (TMD) is a **polyglot file format** that embeds images, SQLite databases, and binary attachments directly into Markdown documents. A `.tmd` file contains UTF-8 Markdown text followed by a ZIP archive with attachments and a manifest, using EOCD comments for boundary detection.

## Architecture

### Core Components
- **`tmd-core/`**: Rust library with `TmdDoc` struct, manifest handling, and serialization (currently MVP stubs)
- **`tmd-cli/`**: Command-line tool using clap for document operations (new, validate, export-html, etc.)
- **`tmd-vscode/`**: TypeScript VS Code extension for authoring `.tmd` files
- **`tmd-sample/`**: Reference implementations showing polyglot structure

### File Format Structure
```
+------------------------+
| Markdown (UTF-8 text)  |  <- YAML frontmatter + content
+------------------------+
| ZIP archive            |  <- manifest.json + attachments/
+------------------------+
| EOCD comment           |  <- "TMD1\0<md_len_le64>"
+------------------------+
```

## Development Patterns

### Rust Conventions
- Use `anyhow::Result` for error handling
- Implement `serde::{Serialize, Deserialize}` for manifest structs
- Run `cargo fmt --all` and address `clippy::pedantic` warnings
- Document with `///` for public APIs and `//!` for modules

### TypeScript/VS Code Extension
- Commands follow pattern `tmd.commandName` (see `package.json` contributes)
- Use `vscode.window.showInputBox()` for user input
- Insert snippets with `editor.insertSnippet(new vscode.SnippetString())`
- MVP stubs show informational messages before implementation

### Manifest Schema
The `manifest.json` uses this structure:
```typescript
{
  version: number,           // Format version (1)
  schemaVersion: string,     // "YYYY.MM" format
  title: string,
  attachments: {
    [path: string]: {
      mime: string,
      sha256: string,
      size: number
    }
  },
  data: {
    engine: string,          // "sqlite" 
    entry: string           // Path to main database
  }
}
```

## Key Workflows

### Build Commands
```bash
# Rust components
cd tmd-core && cargo build && cargo test
cd tmd-cli && cargo run -- --help

# VS Code extension  
cd tmd-vscode && npm install && npm run compile
# Debug with F5 in VS Code
```

### Testing Strategy
- **Unit tests**: Markdown/ZIP boundary detection in `tmd-core/tests/`
- **Integration tests**: CLI round-trip operations (`.tmd` ↔ `.tmdz`)
- **Extension tests**: VS Code command behavior with mock `.tmd` data
- Use `sample.tmd` in `tmd-sample/` for validation

### Attachment References
Use `attach:` scheme in Markdown: `![description](attach:images/file.png)`
This links to files stored in the ZIP portion's attachment directory.

## Implementation Notes

### Current MVP Status
- Core serialization (`TmdDoc::to_bytes()`, `open_bytes()`) are stubs
- CLI commands print stub messages instead of processing
- VS Code extension has working command registration but stub implementations

### Critical Areas for Development
1. **EOCD parsing**: Extract markdown length from ZIP comment to split polyglot file
2. **ZIP handling**: Build/extract ZIP archives with proper manifest and attachments
3. **Attachment management**: VS Code UI for adding/managing embedded files
4. **Export functionality**: HTML generation with self-contained assets

### Code Organization
- Keep manifest structures in `tmd-core/src/lib.rs`
- CLI subcommands map directly to `Commands` enum variants
- VS Code commands registered in `activate()` function
- Use consistent error handling with `anyhow` throughout Rust code

## Commit Style
Format: `[component] Brief description`
Examples: `[tmd-core] Implement EOCD parser`, `[tmd-vscode] Add attachment browser`