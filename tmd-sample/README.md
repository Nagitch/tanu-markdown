# Tanu Markdown samples

`sample.tmd` is the reference ZIP representation. It demonstrates:

- a value from the populated `sample_notes` SQLite table presented inline in
  prose;
- the same stored rows presented as a Markdown table;
- an attached PNG rendered from an `attach:` image reference; and
- an attached text file rendered as a download link.

The database values in the Markdown are a static snapshot. The sample does not
execute SQL while rendering; a future scripted view layer can replace the
manual presentation without changing the embedded database. The proposed
source and rendering syntax is documented in
[`docs/dynamic-data-views.md`](../docs/dynamic-data-views.md) and tracked by
[issue #35](https://github.com/Nagitch/tanu-markdown/issues/35).

```bash
tmd inspect tmd-sample/sample.tmd --json
tmd attachment list tmd-sample/sample.tmd
tmd db query tmd-sample/sample.tmd \
  --sql "SELECT id, body FROM sample_notes ORDER BY id" --json
tmd export-html tmd-sample/sample.tmd sample.html --self-contained
```

CI validates the file, while round-trip and malformed-container behavior is
covered by Rust unit and CLI lifecycle tests.

See [`docs/format-overview.md`](../docs/format-overview.md) for the implemented
container layout.
