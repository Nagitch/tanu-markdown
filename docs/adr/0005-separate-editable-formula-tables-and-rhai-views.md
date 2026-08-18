# 0005: Separate editable Formula tables and Rhai views

- Status: Accepted
- Decision date: 2026-08-13

## Context

TMD must support spreadsheet-like authoring of normalized and derived data
without embedding SQL or executable scripts in prose. Authors need direct table
editing with gradually applied types, while transformations need a more
expressive language. Treating every output as editable would make derived data
ambiguous; treating every table as a script or database query would make basic
authoring unnecessarily indirect.

## Decision

Use named data sources and a common typed table model, with distinct authority:

- a managed `formula` source stores stable row and column identities, typed
  literals, constraints, and bounded cell formulas in the versioned document
  registry and is directly editable;
- a `rhai` source reads declared sources, executes a sandboxed and bounded
  attachment script, and publishes a strictly declared read-only result; and
- Markdown references a source by name and separately selects a renderer, so
  acquisition, transformation, and presentation remain independent.

The current editor creates Formula and Rhai sources only. Legacy SQLite-backed
query and computed Formula definitions remain readable for schema
compatibility, but they are not the model for new authoring. Formula semantics
remain in `tmd-formula`; document registry and cross-source integration remain
in `tmd-core`.

## Consequences

- Users can begin with an unconstrained grid and progressively add types,
  formulas, identities, references, extraction, and normalization.
- Derived Rhai output has one clear source of truth and cannot be edited as if
  it were stored data.
- Markdown remains readable and does not contain SQL or scripts.
- Evaluation must enforce table-size, dependency, cycle, expression, and Rhai
  runtime limits and return structured diagnostics.
- Registry schema evolution must preserve readable legacy definitions while
  new editor writes use the current managed model.

## Alternatives considered

- **Use SQLite tables and SQL for every source**: powerful for relational data,
  but too indirect for document-native spreadsheet editing.
- **Make Rhai results editable**: obscures whether edits change inputs, the
  transformation, or transient output.
- **Put formulas directly in Markdown tables**: familiar, but lacks stable row
  and column identity and couples data to one renderer.
- **Use an unrestricted scripting language for formulas**: expressive, but
  harder to bound, diagnose by cell, and rewrite during structural edits.

## References

- [Dynamic data views](../dynamic-data-views.md)
- [Architecture](../architecture.md)
- Pull request [#47](https://github.com/Nagitch/tanu-markdown/pull/47)
