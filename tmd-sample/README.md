# Tanu Markdown samples

`sample.tmd` is the reference ZIP representation. It demonstrates:

- a value from the populated `sample_notes` SQLite table presented inline in
  prose;
- the stored rows presented as a dynamic table;
- a `sample_sales` SQLite source transformed and grouped by a sandboxed Rhai
  attachment into a second dynamic table;
- the same ordered sales rows extended by an inline Formula program with a
  calculated column and a `SUM` total, plus an explicit primary-keyed SQLite
  edit contract used by the Formula table editor;
- an attached PNG rendered from an `attach:` image reference; and
- an attached text file rendered as a download link.

The Markdown selects named data sources declared in
`manifest.extras.tmd_data_sources`. The Rhai source declares `sales` as its
SQLite input and `category`, `order_count`, and `total_cents` as its ordered
output columns. Its editable source copy is
[`views/category-summary.rhai`](views/category-summary.rhai); identical bytes
are stored in `sample.tmd` as the `views/category-summary.rhai` attachment.
The `sales-formula` source keeps its Formula program inline in the manifest and
declares the input columns followed by `double_cents` and `all_sales_cents`.
The input begins with the stable `id` key. In the VS Code Table tab,
`category` and `amount_cents` can be edited directly, while input beginning
with `=` becomes a Formula assignment.
TMD-aware HTML and VS Code preview evaluate direct, Rhai-transformed, and
Formula-transformed tables.
Non-aware Markdown viewers retain readable placeholders and fenced blocks. The
source and rendering syntax is documented in
[`docs/dynamic-data-views.md`](../docs/dynamic-data-views.md).

```bash
tmd inspect tmd-sample/sample.tmd --json
tmd attachment list tmd-sample/sample.tmd
tmd db query tmd-sample/sample.tmd \
  --sql "SELECT id, body FROM sample_notes ORDER BY id" --json
tmd db query tmd-sample/sample.tmd \
  --sql "SELECT id, category, amount_cents FROM sample_sales ORDER BY id" --json
tmd preview tmd-sample/sample.tmd --json-stdin <<'JSON'
{"schema_version":1,"markdown":"```tmd-view:table\nsource = \"sales-formula\"\n```\n"}
JSON
tmd export-html tmd-sample/sample.tmd sample.html --self-contained
```

CI validates the file, while round-trip and malformed-container behavior is
covered by Rust unit and CLI lifecycle tests.

See [`docs/format-overview.md`](../docs/format-overview.md) for the implemented
container layout.
