# tmd-formula

`tmd-formula` is the bounded spreadsheet-style Formula language engine used by
Tanu Markdown. It owns parsing, cell and range references, dependency-aware
evaluation, built-in functions, limits, and structured diagnostics.

The crate operates only on `tmd-data` tables. It has no dependency on `.tmd`
containers, manifests, SQLite, rendering, the CLI, or editor code. `tmd-core`
owns those integration concerns and supplies its table-size policy when it
evaluates a Formula data source. Callers may also provide a bounded reference
resolver for direct `REF("source", identity, "target_column")` lookups and the
legacy `REF([@reference_column], "target_column")` form; the Formula engine does
not know about registries or choose target tables itself.

This is an internal, pre-1.0 workspace crate and is not currently publishable.

## Built-in functions

The engine implements strict, case-insensitive spreadsheet functions:

- aggregation: `SUM`, `AVERAGE`, `MIN`, `MAX`, and `COUNT`;
- logic: `IF`, `AND`, `OR`, `NOT`, and `ISNULL`;
- numbers: `ROUND`, `CEILING`, `FLOOR`, `POWER`, and `ABS`;
- text: `CONCAT` and `LEN`; and
- references: `HEADER` and caller-resolved `REF`.

`CEILING(number[, significance])` rounds toward positive infinity and
`FLOOR(number[, significance])` rounds toward negative infinity. Their default
significance is `1`; an explicit significance is treated as an absolute
magnitude and must be a finite non-zero number. `POWER(base, exponent)` returns
the real-valued power. All three functions require finite numeric arguments and
reject non-finite results. A negative base requires an integer exponent, and
zero raised to a negative exponent is a division-by-zero error.
