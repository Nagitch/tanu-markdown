# tmd-formula

`tmd-formula` is the bounded spreadsheet-style Formula language engine used by
Tanu Markdown. It owns parsing, cell and range references, dependency-aware
evaluation, built-in functions, limits, and structured diagnostics.

The crate operates only on `tmd-data` tables. It has no dependency on `.tmd`
containers, manifests, SQLite, rendering, the CLI, or editor code. `tmd-core`
owns those integration concerns and supplies its table-size policy when it
evaluates a Formula data source.

This is an internal, pre-1.0 workspace crate and is not currently publishable.
