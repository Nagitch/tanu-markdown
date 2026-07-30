# Tanu Markdown Editor

This directory contains the VS Code extension scaffold for Tanu Markdown.

The extension currently registers commands for document creation, attachment
links, validation, HTML export, `.tmdp` conversion, and a welcome message.
Document creation and attachment-link insertion have basic implementations;
validation, export, and conversion remain placeholders.

## Development

From the repository root:

```bash
npm ci --prefix tmd-vscode
npm run check --prefix tmd-vscode
npm run compile --prefix tmd-vscode
```

The extension targets VS Code `^1.90.0` and uses strict TypeScript settings.
Generated `dist/`, `node_modules/`, and `.vsix` files are not committed.

Format parsing should remain in `tmd-core`. A future issue must define whether
the extension integrates through the CLI, a native binding, or WebAssembly.

The extension is not currently approved for marketplace publication.
