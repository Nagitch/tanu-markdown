# Tanu Markdown samples

These checked-in documents form a progression from a compact editor reference
to realistic business and game-development workbooks. Open any document with
the VS Code extension, use the **Table** tab for source-level editing, and use
the safe preview to edit managed Formula tables in their surrounding document
context.

| Document | Scenario | Main features |
| --- | --- | --- |
| [`sample.tmd`](sample.tmd) | Compact managed-table reference | Progressive constraints, normalization, direct `REF`, and Rhai output |
| [`project-profitability.tmd`](project-profitability.tmd) | Project revenue, labor cost, expenses, and margin | Rate-card lookups, boolean billing rules, two-input Rhai aggregation |
| [`inventory-replenishment.tmd`](inventory-replenishment.tmd) | Inventory availability and purchase planning | Product lookups, nested decisions, case-pack `CEILING`, supplier summary |
| [`rpg-battle-balance.tmd`](rpg-battle-balance.tmd) | RPG jobs, skills, enemies, and elemental matchups | Composite lookup identities, damage dependencies, `CEILING`, comparison report |
| [`rpg-level-growth.tmd`](rpg-level-growth.tmd) | RPG stat and experience curves | `POWER`, cumulative row dependencies, growth checkpoints |
| [`rpg-economy.tmd`](rpg-economy.tmd) | Crafting costs and loot expectations | Multi-table item references, expected value, recipe and probability audit |

Every larger sample explains a short set of **Try it** edits in its Markdown.
They deliberately separate editable assumptions and transactions from
calculated columns and read-only Rhai reports so the ownership of each result
stays visible.

## Compact editor reference

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
Markdown-selected source in every checked-in document. The extension's sample
normalization E2E also applies the
`contacts` suggestion in memory and verifies the real CLI returns the same
columns and cells after the editor-host message boundary. Schema and rendering
details are documented in
[`docs/dynamic-data-views.md`](../docs/dynamic-data-views.md) and
[`docs/format-overview.md`](../docs/format-overview.md).

## Regenerating the scenario documents

The larger scenario documents are generated through the public `tmd-core`
document API. Their table definitions and Markdown live in
[`generate_business_samples.rs`](../tmd-core/examples/generate_business_samples.rs)
and
[`generate_rpg_samples.rs`](../tmd-core/examples/generate_rpg_samples.rs);
their Rhai sources live in [`views/`](views/). Regenerate and validate them
from the repository root with:

```bash
just samples-build
just samples
```

Generation evaluates every declared data source and validates the complete
document before replacing the corresponding `.tmd` file. Generated documents
receive fresh document IDs and timestamps, so regeneration is an intentional
fixture update rather than a byte-for-byte reproducibility check.
