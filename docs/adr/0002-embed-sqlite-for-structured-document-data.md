# 0002: Embed SQLite for structured document data

- Status: Accepted
- Decision date: 2025-11-10

## Context

TMD needs structured data that can be queried and migrated without forcing
Markdown or attachment metadata to become a database schema. A sidecar database
would break the single-file document model, while a custom JSON store would
need to recreate query, transaction, and migration behavior.

## Decision

Every `.tmd` container includes a SQLite database at `db/main.sqlite3`.
`tmd-core` owns database lifecycle, schema-version coordination, import,
export, and migration. Mutating SQL and read-only queries are distinct
operations, and migrations update both SQLite `user_version` and the document
manifest consistently.

The database is document data, not the authority for the Markdown, attachment
registry, or manifest. Features that do not require relational storage may use
other versioned document structures; in particular, managed Formula tables are
not required to stage their data through SQLite.

## Consequences

- A document can carry relational data, indexes, and migrations without an
  external service or sidecar.
- Existing SQLite tools and semantics are reusable through explicit import and
  export workflows.
- Database access must be bounded by the document lifecycle; clients must not
  assume a stable on-disk sidecar path inside the archive.
- Container writes and database migrations require transaction and atomicity
  checks across both SQLite and manifest state.
- SQLite increases the minimum document size and native dependency surface.

## Alternatives considered

- **External or adjacent SQLite file**: easier for DB clients to open, but it
  separates data from the portable document and permits mismatched versions.
- **JSON-only structured data**: simpler to inspect, but insufficient for
  relational queries and transactional migrations.
- **Store all document state in SQLite**: provides one internal store, but makes
  Markdown, attachments, and the container contract less transparent and more
  tightly coupled to SQLite.

## References

- [Format overview](../format-overview.md)
- [`tmd-core` database API](../../tmd-core/README.md)
- Commit `cbcc000` (`[tmd-core] Implement SQLite-integrated document API`)
