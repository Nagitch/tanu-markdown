# Tanu Markdown sample

`sample.tmd` is the reference ZIP representation for the managed Formula-table
editing experience. Open it with the VS Code extension and select the **Table**
tab to try the following sources:

- `orders` is an editable managed Formula table. It combines column constraints,
  a Number override on otherwise-Any `quantity` cells, and calculated `total`
  cells.
- `contacts` is a literal-only, all-Any table whose repeated `city` and `country`
  values produce a normalization candidate. The editor outlines that range in
  blue and can split it into a related managed table. After applying the
  suggestion, `city` and `country` keep displaying their original values
  through generated direct `REF` formulas. The extracted table exposes its
  stable `ID`; the linked range shows a lock outline and uses a referenced-row
  picker. Releasing the group keeps the REF formulas for free-form editing.
- `order-report` is a read-only Rhai result over `orders`. The editable script is
  [`views/category-summary.rhai`](views/category-summary.rhai), and identical
  bytes are stored as an attachment in `sample.tmd`.

All three are selected by `tmd-view:table` blocks in the document Markdown.
The Formula sources remain editable in Safe Preview as well as the Table tab;
the Rhai result deliberately remains read-only because its script owns the
complete output. The container also retains attachment and SQLite fixtures used
by lower-level format tests, but this sample does not expose raw SQLite as a
table source.

Inspect and evaluate the sample with:

```bash
tmd inspect tmd-sample/sample.tmd --json
tmd attachment list tmd-sample/sample.tmd
printf '%s' '{"schema_version":1,"source":"orders"}' \
  | tmd data-source tmd-sample/sample.tmd --json-stdin
printf '%s' '{"schema_version":1,"source":"contacts"}' \
  | tmd data-source tmd-sample/sample.tmd --json-stdin
printf '%s' '{"schema_version":1,"source":"order-report"}' \
  | tmd data-source tmd-sample/sample.tmd --json-stdin
tmd export-html tmd-sample/sample.tmd sample.html --self-contained
```

The repository `samples` check validates the container and evaluates every
declared source. The extension's sample normalization E2E also applies the
`contacts` suggestion in memory and verifies the real CLI returns the same
columns and cells after the editor-host message boundary. Schema and rendering
details are documented in
[`docs/dynamic-data-views.md`](../docs/dynamic-data-views.md) and
[`docs/format-overview.md`](../docs/format-overview.md).
