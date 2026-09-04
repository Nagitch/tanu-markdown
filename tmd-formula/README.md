# tmd-formula

`tmd-formula` is the bounded spreadsheet-style Formula language engine used by
Tanu Markdown. It owns parsing, cell and range references, dependency-aware
evaluation, host functions, limits, and structured diagnostics. Standard scalar
and aggregate function semantics are delegated to the pinned
`openformula-kernel` revision so Tanu, TSQ1, and Kitu share numeric, rounding,
coercion, and error behavior.

The crate operates only on `tmd-data` tables. It has no dependency on `.tmd`
containers, manifests, SQLite, rendering, the CLI, or editor code. `tmd-core`
owns those integration concerns and supplies its table-size policy when it
evaluates a Formula data source. Callers may also provide a bounded reference
resolver for direct `REF("source", identity, "target_column")` lookups and the
legacy `REF([@reference_column], "target_column")` form; the Formula engine does
not know about registries or choose target tables itself.

This is an internal, pre-1.0 workspace crate and is not currently publishable.
Tanu intentionally selects the kernel's `Strict` coercion policy: Formula
aggregates continue to ignore `NULL` but reject text and logical values. Parser
spans and cell targets remain attached when a typed kernel error is mapped back
to a `FormulaError`.
