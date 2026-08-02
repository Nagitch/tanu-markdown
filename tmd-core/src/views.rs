use crate::{TmdDoc, TmdError, TmdResult};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ops::Range;

/// Manifest `extras` key containing versioned dynamic-data source definitions.
pub const DATA_SOURCES_EXTRAS_KEY: &str = "tmd_data_sources";

const DATA_SOURCES_SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_NAME_BYTES: usize = 128;
const MAX_QUERY_BYTES: usize = 64 * 1024;
const MAX_TABLE_ROWS: usize = 1_000;
const MAX_TABLE_COLUMNS: usize = 128;
const MAX_TABLE_CELLS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// Versioned collection of named dynamic-data sources.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataSourceRegistry {
    /// Schema version for the registry payload.
    pub schema_version: u32,
    /// Definitions keyed by the name referenced from Markdown.
    pub sources: BTreeMap<String, DataSourceDefinition>,
}

impl Default for DataSourceRegistry {
    fn default() -> Self {
        Self {
            schema_version: DATA_SOURCES_SCHEMA_VERSION,
            sources: BTreeMap::new(),
        }
    }
}

impl DataSourceRegistry {
    /// Parse the registry stored in `manifest.extras`.
    pub fn from_manifest_extras(extras: &serde_json::Value) -> TmdResult<Self> {
        if extras.is_null() {
            return Ok(Self::default());
        }
        let Some(extras) = extras.as_object() else {
            // `Manifest::extras` accepts any JSON value. Non-object application
            // data cannot contain the namespaced registry and remains valid.
            return Ok(Self::default());
        };
        let Some(value) = extras.get(DATA_SOURCES_EXTRAS_KEY) else {
            return Ok(Self::default());
        };
        let registry: Self = serde_json::from_value(value.clone()).map_err(|error| {
            TmdError::DataView(format!("invalid data-source registry: {error}"))
        })?;
        if registry.schema_version != DATA_SOURCES_SCHEMA_VERSION {
            return Err(TmdError::DataView(format!(
                "unsupported data-source schema_version {}; expected {}",
                registry.schema_version, DATA_SOURCES_SCHEMA_VERSION
            )));
        }
        for (name, definition) in &registry.sources {
            validate_source_name(name)?;
            definition.validate(name)?;
        }
        Ok(registry)
    }
}

/// Definition for one named data source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum DataSourceDefinition {
    /// One read-only query against the embedded SQLite database.
    Sqlite {
        /// SQL statement evaluated when the source is rendered.
        query: String,
    },
}

impl DataSourceDefinition {
    fn validate(&self, name: &str) -> TmdResult<()> {
        match self {
            Self::Sqlite { query } => {
                if query.trim().is_empty() {
                    return Err(TmdError::DataView(format!(
                        "SQLite source `{name}` has an empty query"
                    )));
                }
                if query.len() > MAX_QUERY_BYTES {
                    return Err(TmdError::DataView(format!(
                        "SQLite source `{name}` query exceeds {MAX_QUERY_BYTES} bytes"
                    )));
                }
            }
        }
        Ok(())
    }
}

/// Scalar value shared by dynamic-data sources and renderers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum DataScalar {
    /// SQL or structured-data null.
    Null,
    /// Boolean value.
    Boolean(bool),
    /// Signed 64-bit integer.
    Integer(i64),
    /// Finite floating-point number.
    Real(f64),
    /// UTF-8 string.
    String(String),
}

impl DataScalar {
    /// Convert the scalar to its passive display representation.
    pub fn display_text(&self) -> String {
        match self {
            Self::Null => "NULL".to_owned(),
            Self::Boolean(value) => value.to_string(),
            Self::Integer(value) => value.to_string(),
            Self::Real(value) => value.to_string(),
            Self::String(value) => value.clone(),
        }
    }
}

/// Ordered table returned by a tabular data source.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DataTable {
    /// Ordered result-column labels.
    pub columns: Vec<String>,
    /// Ordered result rows containing scalar cells.
    pub rows: Vec<Vec<DataScalar>>,
}

/// Common typed value returned by a dynamic-data source.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DataValue {
    /// One scalar value.
    Scalar(DataScalar),
    /// Ordered tabular data.
    Table(DataTable),
}

impl DataValue {
    /// Return a scalar directly or from a one-row, one-column table.
    pub fn as_scalar(&self) -> TmdResult<&DataScalar> {
        match self {
            Self::Scalar(value) => Ok(value),
            Self::Table(table)
                if table.columns.len() == 1
                    && table.rows.len() == 1
                    && table.rows[0].len() == 1 =>
            {
                Ok(&table.rows[0][0])
            }
            Self::Table(table) => Err(TmdError::DataView(format!(
                "scalar rendering requires exactly one row and one column; query returned {} row(s) and {} column(s)",
                table.rows.len(),
                table.columns.len()
            ))),
        }
    }

    /// Return the value as a table or report a shape mismatch.
    pub fn as_table(&self) -> TmdResult<&DataTable> {
        match self {
            Self::Table(table) => Ok(table),
            Self::Scalar(_) => Err(TmdError::DataView(
                "table rendering requires a table value".to_owned(),
            )),
        }
    }
}

/// Renderer requested by a Markdown data-view reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataViewRenderKind {
    /// Passive scalar output.
    Scalar,
    /// Header and row output.
    Table,
    /// List output reserved by the proposal.
    List,
    /// Serialized code output reserved by the proposal.
    Code,
}

impl DataViewRenderKind {
    fn parse(value: &str) -> TmdResult<Self> {
        match value {
            "scalar" => Ok(Self::Scalar),
            "table" => Ok(Self::Table),
            "list" => Ok(Self::List),
            "code" => Ok(Self::Code),
            other => Err(TmdError::DataView(format!(
                "unknown data-view renderer `{other}`"
            ))),
        }
    }
}

/// Parsed dynamic-data reference from Markdown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataViewReference {
    /// Named source selected by the reference.
    pub source: String,
    /// Renderer requested at the Markdown use site.
    pub render: DataViewRenderKind,
    /// Optional serialization format used by the future `code` renderer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// Byte range and source name for one inline scalar reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineDataViewReference {
    /// Byte range occupied by the complete `{{tmd-view:...}}` expression.
    pub range: Range<usize>,
    /// Named source selected by the expression.
    pub source: String,
}

/// References and syntax errors found while scanning Markdown.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DataViewParseReport {
    /// Successfully parsed references in document order.
    pub references: Vec<DataViewReference>,
    /// Human-readable inline and fenced-block syntax errors.
    pub errors: Vec<String>,
}

/// Find valid inline scalar references within one Markdown text event.
pub fn inline_data_view_references(text: &str) -> Vec<InlineDataViewReference> {
    scan_inline_data_view_references(text).0
}

fn scan_inline_data_view_references(text: &str) -> (Vec<InlineDataViewReference>, Vec<String>) {
    const PREFIX: &str = "{{tmd-view:";
    let mut references = Vec::new();
    let mut errors = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = text[cursor..].find(PREFIX) {
        let start = cursor + relative_start;
        let name_start = start + PREFIX.len();
        let Some(relative_end) = text[name_start..].find("}}") else {
            errors.push("unclosed inline data-view reference".to_owned());
            break;
        };
        let name_end = name_start + relative_end;
        let source = &text[name_start..name_end];
        let end = name_end + 2;
        match validate_source_name(source) {
            Ok(()) => references.push(InlineDataViewReference {
                range: start..end,
                source: source.to_owned(),
            }),
            Err(error) => errors.push(error.to_string()),
        }
        cursor = end;
    }
    (references, errors)
}

/// Parse dynamic-data references from Markdown without evaluating them.
pub fn data_view_references(markdown: &str) -> DataViewParseReport {
    let mut report = DataViewParseReport::default();
    let mut parser = Parser::new_ext(markdown, Options::ENABLE_TABLES);
    while let Some(event) = parser.next() {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let mut body = String::new();
                for inner in parser.by_ref() {
                    match inner {
                        Event::End(TagEnd::CodeBlock) => break,
                        Event::Text(value) | Event::Code(value) => body.push_str(&value),
                        _ => {}
                    }
                }
                if let CodeBlockKind::Fenced(info) = kind {
                    match parse_data_view_block(&info, &body) {
                        Some(Ok(reference)) => report.references.push(reference),
                        Some(Err(error)) => report.errors.push(error.to_string()),
                        None => {}
                    }
                }
            }
            Event::Text(text) => {
                let (references, errors) = scan_inline_data_view_references(&text);
                report
                    .references
                    .extend(references.into_iter().map(|reference| DataViewReference {
                        source: reference.source,
                        render: DataViewRenderKind::Scalar,
                        format: None,
                    }));
                report.errors.extend(errors);
            }
            _ => {}
        }
    }
    report
}

/// Parse one fenced data-view block, or return `None` for an ordinary fence.
pub fn parse_data_view_block(info: &str, body: &str) -> Option<TmdResult<DataViewReference>> {
    let render_name = info.strip_prefix("tmd-view:")?;
    Some((|| {
        let render = DataViewRenderKind::parse(render_name)?;
        let mut source = None;
        let mut format = None;
        for (line_index, line) in body.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (key, value) = line.split_once('=').ok_or_else(|| {
                TmdError::DataView(format!(
                    "invalid view option on line {}: expected key = value",
                    line_index + 1
                ))
            })?;
            let key = key.trim();
            let value: String = serde_json::from_str(value.trim()).map_err(|error| {
                TmdError::DataView(format!(
                    "invalid quoted string for `{key}` on line {}: {error}",
                    line_index + 1
                ))
            })?;
            match key {
                "source" if source.is_none() => source = Some(value),
                "format" if format.is_none() => format = Some(value),
                "source" | "format" => {
                    return Err(TmdError::DataView(format!("duplicate view option `{key}`")))
                }
                _ => return Err(TmdError::DataView(format!("unknown view option `{key}`"))),
            }
        }
        let source =
            source.ok_or_else(|| TmdError::DataView("view block requires `source`".to_owned()))?;
        validate_source_name(&source)?;
        if format.is_some() && render != DataViewRenderKind::Code {
            return Err(TmdError::DataView(
                "view option `format` is valid only for the reserved `code` renderer".to_owned(),
            ));
        }
        Ok(DataViewReference {
            source,
            render,
            format,
        })
    })())
}

/// Evaluate a named source against a loaded TMD document.
pub fn evaluate_data_source(doc: &TmdDoc, name: &str) -> TmdResult<DataValue> {
    validate_source_name(name)?;
    let registry = DataSourceRegistry::from_manifest_extras(&doc.manifest.extras)?;
    let definition = registry
        .sources
        .get(name)
        .ok_or_else(|| TmdError::DataView(format!("data source `{name}` is not defined")))?;
    match definition {
        DataSourceDefinition::Sqlite { query } => evaluate_sqlite(doc, name, query),
    }
}

fn evaluate_sqlite(doc: &TmdDoc, name: &str, query: &str) -> TmdResult<DataValue> {
    doc.db_with_conn(|connection| -> TmdResult<DataValue> {
        let mut statement = connection.prepare(query).map_err(|error| {
            TmdError::DataView(format!(
                "SQLite source `{name}` could not be prepared: {error}"
            ))
        })?;
        if !statement.readonly() {
            return Err(TmdError::DataView(format!(
                "SQLite source `{name}` must contain one read-only statement"
            )));
        }
        let columns = statement
            .column_names()
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if columns.len() > MAX_TABLE_COLUMNS {
            return Err(TmdError::DataView(format!(
                "SQLite source `{name}` returned more than {MAX_TABLE_COLUMNS} columns"
            )));
        }
        let mut rows = Vec::new();
        let mut query_rows = statement.query([]).map_err(|error| {
            TmdError::DataView(format!(
                "SQLite source `{name}` could not be evaluated: {error}"
            ))
        })?;
        while let Some(row) = query_rows.next().map_err(|error| {
            TmdError::DataView(format!(
                "SQLite source `{name}` failed while reading: {error}"
            ))
        })? {
            if rows.len() >= MAX_TABLE_ROWS
                || (rows.len() + 1).saturating_mul(columns.len()) > MAX_TABLE_CELLS
            {
                return Err(TmdError::DataView(format!(
                    "SQLite source `{name}` exceeded the table output limit"
                )));
            }
            let mut values = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                let value = row.get_ref(index).map_err(|error| {
                    TmdError::DataView(format!(
                        "SQLite source `{name}` could not read column {index}: {error}"
                    ))
                })?;
                values.push(sqlite_scalar(name, value)?);
            }
            rows.push(values);
        }
        Ok(DataValue::Table(DataTable { columns, rows }))
    })?
}

fn sqlite_scalar(name: &str, value: ValueRef<'_>) -> TmdResult<DataScalar> {
    match value {
        ValueRef::Null => Ok(DataScalar::Null),
        ValueRef::Integer(value) => Ok(DataScalar::Integer(value)),
        ValueRef::Real(value) if value.is_finite() => Ok(DataScalar::Real(value)),
        ValueRef::Real(_) => Err(TmdError::DataView(format!(
            "SQLite source `{name}` returned a non-finite real value"
        ))),
        ValueRef::Text(value) => {
            if value.len() > MAX_TEXT_BYTES {
                return Err(TmdError::DataView(format!(
                    "SQLite source `{name}` returned text exceeding {MAX_TEXT_BYTES} bytes"
                )));
            }
            let value = std::str::from_utf8(value).map_err(|error| {
                TmdError::DataView(format!(
                    "SQLite source `{name}` returned invalid UTF-8 text: {error}"
                ))
            })?;
            Ok(DataScalar::String(value.to_owned()))
        }
        ValueRef::Blob(_) => Err(TmdError::DataView(format!(
            "SQLite source `{name}` returned a BLOB, which dynamic views do not support"
        ))),
    }
}

fn validate_source_name(name: &str) -> TmdResult<()> {
    if name.is_empty()
        || name.len() > MAX_SOURCE_NAME_BYTES
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(TmdError::DataView(format!(
            "invalid data-source name `{name}`; use 1-{MAX_SOURCE_NAME_BYTES} ASCII letters, digits, '.', '_' or '-'"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document_with_sources(markdown: &str) -> TmdDoc {
        let mut doc = TmdDoc::new(markdown.to_owned()).expect("document");
        doc.manifest.extras = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 1,
                "sources": {
                    "first-note": {
                        "type": "sqlite",
                        "query": "SELECT body FROM sample_notes WHERE id = 1"
                    },
                    "sample-notes": {
                        "type": "sqlite",
                        "query": "SELECT id, body FROM sample_notes ORDER BY id"
                    }
                }
            }
        });
        doc.db_with_conn_mut(|connection| {
            connection.execute_batch(
                "CREATE TABLE sample_notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);\
                 INSERT INTO sample_notes(body) VALUES ('hello'), ('world');",
            )
        })
        .expect("database access")
        .expect("database fixture");
        doc
    }

    #[test]
    fn evaluates_scalar_and_table_shapes() {
        let doc = document_with_sources("");
        let scalar = evaluate_data_source(&doc, "first-note").expect("scalar source");
        assert_eq!(
            scalar.as_scalar().expect("one cell"),
            &DataScalar::String("hello".to_owned())
        );
        let table = evaluate_data_source(&doc, "sample-notes")
            .expect("table source")
            .as_table()
            .expect("table")
            .clone();
        assert_eq!(table.columns, vec!["id", "body"]);
        assert_eq!(table.rows.len(), 2);
    }

    #[test]
    fn parses_inline_and_fenced_references() {
        let report = data_view_references(
            "Owner: {{tmd-view:first-note}}\n\n```tmd-view:table\nsource = \"sample-notes\"\n```\n",
        );
        assert!(report.errors.is_empty());
        assert_eq!(
            report.references,
            vec![
                DataViewReference {
                    source: "first-note".to_owned(),
                    render: DataViewRenderKind::Scalar,
                    format: None,
                },
                DataViewReference {
                    source: "sample-notes".to_owned(),
                    render: DataViewRenderKind::Table,
                    format: None,
                },
            ]
        );
    }

    #[test]
    fn rejects_mutating_and_malformed_sources() {
        let mut doc = document_with_sources("");
        doc.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["bad"] = json!({
            "type": "sqlite",
            "query": "DELETE FROM sample_notes"
        });
        let error = evaluate_data_source(&doc, "bad").expect_err("mutating source");
        assert!(error.to_string().contains("read-only"));

        doc.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["multiple"] = json!({
            "type": "sqlite",
            "query": "SELECT 1; SELECT 2"
        });
        let error = evaluate_data_source(&doc, "multiple").expect_err("multiple statements");
        assert!(error.to_string().contains("could not be prepared"));

        let report = data_view_references("```tmd-view:table\nunknown = \"value\"\n```\n");
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].contains("unknown view option"));

        let report = data_view_references("{{tmd-view:invalid name}} {{tmd-view:unclosed");
        assert_eq!(report.errors.len(), 2);
        assert!(report.errors[0].contains("invalid data-source name"));
        assert!(report.errors[1].contains("unclosed inline"));
    }

    #[test]
    fn ignores_unrelated_non_object_manifest_extras() {
        let registry = DataSourceRegistry::from_manifest_extras(&json!(["application", "data"]))
            .expect("unrelated extras remain valid");
        assert_eq!(registry.schema_version, DATA_SOURCES_SCHEMA_VERSION);
        assert!(registry.sources.is_empty());
    }
}
