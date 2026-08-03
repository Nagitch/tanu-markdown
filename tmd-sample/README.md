# Tanu Markdown samples

`sample.tmd` is the reference ZIP representation. It demonstrates:

- a value from the populated `sample_notes` SQLite table presented inline in
  prose;
- the stored rows presented as a dynamic table;
- an attached PNG rendered from an `attach:` image reference; and
- an attached text file rendered as a download link.

The Markdown selects named data sources declared in
`manifest.extras.tmd_data_sources`. TMD-aware HTML and VS Code preview render
the inline one-cell query with `scalar` and all stored rows with `table`.
Non-aware Markdown viewers retain readable placeholders and fenced blocks. The
source and rendering syntax is documented in
[`docs/dynamic-data-views.md`](../docs/dynamic-data-views.md).

```bash
tmd inspect tmd-sample/sample.tmd --json
tmd attachment list tmd-sample/sample.tmd
tmd db query tmd-sample/sample.tmd \
  --sql "SELECT id, body FROM sample_notes ORDER BY id" --json
tmd preview tmd-sample/sample.tmd --json-stdin <<'JSON'
{"schema_version":1,"markdown":"{{tmd-view:first-note}}"}
JSON
tmd export-html tmd-sample/sample.tmd sample.html --self-contained
```

CI validates the file, while round-trip and malformed-container behavior is
covered by Rust unit and CLI lifecycle tests.

See [`docs/format-overview.md`](../docs/format-overview.md) for the implemented
container layout.
