# Tanu Markdown samples

`sample.tmd` is the reference ZIP representation. It contains
`attachments/sample-note.txt` and a populated `sample_notes` SQLite table, so
the sample exercises attachment and data workflows rather than only empty
containers.

```bash
tmd inspect tmd-sample/sample.tmd --json
tmd attachment list tmd-sample/sample.tmd
tmd db query tmd-sample/sample.tmd \
  --sql "SELECT id, body FROM sample_notes" --json
```

CI validates the file, while round-trip and malformed-container behavior is
covered by Rust unit and CLI lifecycle tests.

See [`docs/format-overview.md`](../docs/format-overview.md) for the implemented
container layout.
