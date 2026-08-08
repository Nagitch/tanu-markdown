use crate::{normalize_logical_path, TmdDoc, TmdError, TmdResult};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use rhai::{Array, Dynamic, Engine, ImmutableString, Map, Scope, FLOAT, INT};
use rusqlite::types::{Value, ValueRef};
use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::time::{Duration, Instant};
use tmd_data::{DataScalar, DataTable};
use tmd_formula::{
    evaluate_formula_program_with_limits, parse_formula_program, FormulaEvaluationLimits,
};

/// Manifest `extras` key containing versioned dynamic-data source definitions.
pub const DATA_SOURCES_EXTRAS_KEY: &str = "tmd_data_sources";

const DATA_SOURCES_SCHEMA_VERSION: u32 = 5;
const EDITABLE_DATA_SOURCES_SCHEMA_VERSION: u32 = 4;
const FORMULA_DATA_SOURCES_SCHEMA_VERSION: u32 = 3;
const RHAI_DATA_SOURCES_SCHEMA_VERSION: u32 = 2;
const LEGACY_DATA_SOURCES_SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_NAME_BYTES: usize = 128;
const MAX_QUERY_BYTES: usize = 64 * 1024;
const MAX_RHAI_SCRIPT_BYTES: usize = 256 * 1024;
const MAX_RHAI_INPUTS: usize = 16;
const MAX_RHAI_OPERATIONS: u64 = 200_000;
const MAX_RHAI_ARRAY_SIZE: usize = 2_000;
const MAX_RHAI_MAP_SIZE: usize = 256;
const MAX_RHAI_VARIABLES: usize = 256;
const MAX_RHAI_FUNCTIONS: usize = 64;
const MAX_RHAI_CALL_LEVELS: usize = 32;
const MAX_RHAI_EXPR_DEPTH: usize = 64;
const MAX_RHAI_FUNCTION_EXPR_DEPTH: usize = 32;
const MAX_RHAI_RUN_TIME: Duration = Duration::from_millis(250);
pub(crate) const MAX_TABLE_ROWS: usize = 1_000;
const MAX_TABLE_COLUMNS: usize = 128;
pub(crate) const MAX_TABLE_CELLS: usize = 10_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_COLUMN_NAME_BYTES: usize = 256;
const MAX_SQLITE_IDENTIFIER_BYTES: usize = 128;

/// Versioned collection of named dynamic-data sources.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataSourceRegistry {
    /// Schema version read from the registry payload.
    ///
    /// Serialization always emits the current schema version after legacy
    /// source definitions have been normalized.
    pub schema_version: u32,
    /// Definitions keyed by the name referenced from Markdown.
    pub sources: BTreeMap<String, DataSourceDefinition>,
}

impl Serialize for DataSourceRegistry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("schema_version", &DATA_SOURCES_SCHEMA_VERSION)?;
        map.serialize_entry("sources", &self.sources)?;
        map.end()
    }
}

impl Default for DataSourceRegistry {
    fn default() -> Self {
        Self {
            schema_version: DATA_SOURCES_SCHEMA_VERSION,
            sources: BTreeMap::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDataSourceRegistry {
    schema_version: u32,
    sources: BTreeMap<String, RawDataSourceDefinition>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum RawDataSourceDefinition {
    Sqlite {
        query: String,
        #[serde(default)]
        edit: Option<SqliteEditDefinition>,
    },
    Formula(RawFormulaDefinition),
    Rhai {
        script: String,
        inputs: BTreeMap<String, String>,
        output: DataSourceOutput,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawFormulaDefinition {
    Query(RawFormulaQueryDefinition),
    Computed(RawComputedFormulaDefinition),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFormulaQueryDefinition {
    query: String,
    #[serde(default, deserialize_with = "deserialize_present_formula_edit")]
    edit: Option<SqliteEditDefinition>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawComputedFormulaDefinition {
    input: String,
    program: String,
    output: DataSourceOutput,
}

fn deserialize_present_formula_edit<'de, D>(
    deserializer: D,
) -> Result<Option<SqliteEditDefinition>, D::Error>
where
    D: Deserializer<'de>,
{
    SqliteEditDefinition::deserialize(deserializer).map(Some)
}

impl<'de> Deserialize<'de> for DataSourceRegistry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawDataSourceRegistry::deserialize(deserializer)?;
        Self::try_from_raw(raw).map_err(D::Error::custom)
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
        let raw: RawDataSourceRegistry =
            serde_json::from_value(value.clone()).map_err(|error| {
                TmdError::DataView(format!("invalid data-source registry: {error}"))
            })?;
        Self::try_from_raw(raw)
    }

    fn try_from_raw(raw: RawDataSourceRegistry) -> TmdResult<Self> {
        if !matches!(raw.schema_version, 1..=DATA_SOURCES_SCHEMA_VERSION) {
            return Err(TmdError::DataView(format!(
                "unsupported data-source schema_version {}; expected {}, {}, {}, {}, or {}",
                raw.schema_version,
                LEGACY_DATA_SOURCES_SCHEMA_VERSION,
                RHAI_DATA_SOURCES_SCHEMA_VERSION,
                FORMULA_DATA_SOURCES_SCHEMA_VERSION,
                EDITABLE_DATA_SOURCES_SCHEMA_VERSION,
                DATA_SOURCES_SCHEMA_VERSION
            )));
        }
        let mut sources = BTreeMap::new();
        for (name, raw_definition) in raw.sources {
            validate_source_name(&name)?;
            let definition = raw_definition.into_definition(&name, raw.schema_version)?;
            definition.validate(&name)?;
            sources.insert(name, definition);
        }
        let registry = Self {
            schema_version: raw.schema_version,
            sources,
        };
        registry.validate_input_references()?;
        Ok(registry)
    }

    fn validate_input_references(&self) -> TmdResult<()> {
        for (name, definition) in &self.sources {
            match definition {
                DataSourceDefinition::Rhai { inputs, .. } => {
                    for (alias, source_name) in inputs {
                        match self.sources.get(source_name) {
                            Some(DataSourceDefinition::FormulaQuery { .. }) => {}
                            Some(other) => {
                                return Err(TmdError::DataView(format!(
                                    "Rhai source `{name}` input `{alias}` must reference a Formula query source; `{source_name}` is {}",
                                    other.kind_name()
                                )));
                            }
                            None => {
                                return Err(TmdError::DataView(format!(
                                    "Rhai source `{name}` input `{alias}` references undefined source `{source_name}`"
                                )));
                            }
                        }
                    }
                }
                DataSourceDefinition::Formula { input, .. } => match self.sources.get(input) {
                    Some(DataSourceDefinition::FormulaQuery { .. }) => {}
                    Some(other) => {
                        return Err(TmdError::DataView(format!(
                            "Formula source `{name}` input must reference a Formula query source; `{input}` is {}",
                            other.kind_name()
                        )));
                    }
                    None => {
                        return Err(TmdError::DataView(format!(
                            "Formula source `{name}` input references undefined source `{input}`"
                        )));
                    }
                },
                DataSourceDefinition::FormulaQuery { .. } => {}
            }
        }
        Ok(())
    }
}

impl RawDataSourceDefinition {
    fn into_definition(self, name: &str, schema_version: u32) -> TmdResult<DataSourceDefinition> {
        match self {
            Self::Sqlite { query, edit } => {
                if schema_version >= DATA_SOURCES_SCHEMA_VERSION {
                    return Err(TmdError::DataView(format!(
                        "legacy SQLite source `{name}` is supported only in data-source schema_version 1 through {EDITABLE_DATA_SOURCES_SCHEMA_VERSION}; use a Formula query source"
                    )));
                }
                if edit.is_some() && schema_version < EDITABLE_DATA_SOURCES_SCHEMA_VERSION {
                    return Err(TmdError::DataView(format!(
                        "editable SQLite source `{name}` requires data-source schema_version {EDITABLE_DATA_SOURCES_SCHEMA_VERSION}"
                    )));
                }
                Ok(DataSourceDefinition::FormulaQuery { query, edit })
            }
            Self::Formula(definition) => match definition {
                RawFormulaDefinition::Query(RawFormulaQueryDefinition { query, edit }) => {
                    if schema_version < DATA_SOURCES_SCHEMA_VERSION {
                        return Err(TmdError::DataView(format!(
                            "Formula query source `{name}` requires data-source schema_version {DATA_SOURCES_SCHEMA_VERSION}"
                        )));
                    }
                    Ok(DataSourceDefinition::FormulaQuery { query, edit })
                }
                RawFormulaDefinition::Computed(RawComputedFormulaDefinition {
                    input,
                    program,
                    output,
                }) => {
                    if schema_version < FORMULA_DATA_SOURCES_SCHEMA_VERSION {
                        return Err(TmdError::DataView(format!(
                            "Formula source `{name}` requires data-source schema_version {FORMULA_DATA_SOURCES_SCHEMA_VERSION}"
                        )));
                    }
                    Ok(DataSourceDefinition::Formula {
                        input,
                        program,
                        output,
                    })
                }
            },
            Self::Rhai {
                script,
                inputs,
                output,
            } => {
                if schema_version < RHAI_DATA_SOURCES_SCHEMA_VERSION {
                    return Err(TmdError::DataView(format!(
                        "Rhai source `{name}` requires data-source schema_version {RHAI_DATA_SOURCES_SCHEMA_VERSION}"
                    )));
                }
                Ok(DataSourceDefinition::Rhai {
                    script,
                    inputs,
                    output,
                })
            }
        }
    }
}

/// Definition for one named data source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataSourceDefinition {
    /// One read-only query treated as an identity Formula table.
    FormulaQuery {
        /// SQL statement evaluated when the source is rendered.
        query: String,
        /// Explicit primary-keyed write-back contract for table editing.
        edit: Option<SqliteEditDefinition>,
    },
    /// A sandboxed Rhai transformation over declared Formula query inputs.
    Rhai {
        /// Logical path of the Rhai script attachment.
        script: String,
        /// Script-visible aliases mapped to named Formula query sources.
        inputs: BTreeMap<String, String>,
        /// Required output shape for the script result.
        output: DataSourceOutput,
    },
    /// An Excel-like formula program over one declared Formula query input.
    Formula {
        /// Named Formula query source used as the program's initial table.
        input: String,
        /// Inline formula program containing one cell assignment per line.
        program: String,
        /// Required output table columns.
        output: DataSourceOutput,
    },
}

impl Serialize for DataSourceDefinition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::FormulaQuery { query, edit } => {
                let mut map = serializer.serialize_map(Some(if edit.is_some() { 3 } else { 2 }))?;
                map.serialize_entry("type", "formula")?;
                map.serialize_entry("query", query)?;
                if let Some(edit) = edit {
                    map.serialize_entry("edit", edit)?;
                }
                map.end()
            }
            Self::Formula {
                input,
                program,
                output,
            } => {
                let mut map = serializer.serialize_map(Some(5))?;
                map.serialize_entry("type", "formula")?;
                map.serialize_entry("input", input)?;
                map.serialize_entry("program", program)?;
                map.serialize_entry("output", output)?;
                map.end()
            }
            Self::Rhai {
                script,
                inputs,
                output,
            } => {
                let mut map = serializer.serialize_map(Some(5))?;
                map.serialize_entry("type", "rhai")?;
                map.serialize_entry("script", script)?;
                map.serialize_entry("inputs", inputs)?;
                map.serialize_entry("output", output)?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for DataSourceDefinition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match RawDataSourceDefinition::deserialize(deserializer)? {
            RawDataSourceDefinition::Sqlite { .. } => Err(D::Error::custom(
                "legacy SQLite sources require a versioned data-source registry",
            )),
            definition => definition
                .into_definition("<unknown>", DATA_SOURCES_SCHEMA_VERSION)
                .map_err(D::Error::custom),
        }
    }
}

/// Safe write-back contract for an editable Formula query data source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqliteEditDefinition {
    /// SQLite table receiving updates.
    pub table: String,
    /// Mapping from the query result's stable key to the table key column.
    pub key: SqliteEditKey,
    /// Query-result columns mapped to writable SQLite table columns.
    pub columns: BTreeMap<String, String>,
}

/// Stable key mapping used by an editable Formula query source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqliteEditKey {
    /// Column name exposed by the Formula source query.
    pub source_column: String,
    /// Corresponding key column in the target table.
    pub table_column: String,
}

/// One primary-keyed Formula-query cell update staged by an editor.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataCellEdit {
    /// Editable Formula query source owning the update contract.
    pub source: String,
    /// Stable query-result key identifying the row.
    pub key: DataScalar,
    /// Query-result column being changed.
    pub column: String,
    /// New typed scalar value.
    pub value: DataScalar,
}

/// Metadata needed to edit a direct or Formula-derived table safely.
#[derive(Clone, Debug, PartialEq)]
pub struct DataSourceEditInfo {
    /// Formula query source whose contract receives updates.
    pub input_source: String,
    /// Stable key column in the input query.
    pub key_column: String,
    /// Query-result columns that may be edited.
    pub editable_columns: Vec<String>,
    /// Stable keys in input-row order.
    pub row_keys: Vec<DataScalar>,
    /// Current input rows before Formula evaluation.
    pub input_rows: Vec<Vec<DataScalar>>,
}

/// Declared output shape for a computed data source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum DataSourceOutput {
    /// An ordered table with declared column labels.
    Table {
        /// Ordered output columns.
        columns: Vec<String>,
    },
}

impl DataSourceDefinition {
    fn validate(&self, name: &str) -> TmdResult<()> {
        match self {
            Self::FormulaQuery { query, edit } => {
                if query.trim().is_empty() {
                    return Err(TmdError::DataView(format!(
                        "Formula query source `{name}` has an empty query"
                    )));
                }
                if query.len() > MAX_QUERY_BYTES {
                    return Err(TmdError::DataView(format!(
                        "Formula query source `{name}` query exceeds {MAX_QUERY_BYTES} bytes"
                    )));
                }
                if let Some(edit) = edit {
                    edit.validate(name)?;
                }
            }
            Self::Rhai {
                script,
                inputs,
                output,
            } => {
                let normalized = normalize_logical_path(script).map_err(|error| {
                    TmdError::DataView(format!(
                        "Rhai source `{name}` has invalid script attachment path `{script}`: {error}"
                    ))
                })?;
                if normalized != *script {
                    return Err(TmdError::DataView(format!(
                        "Rhai source `{name}` script path must be canonical; use `{normalized}`"
                    )));
                }
                if inputs.is_empty() {
                    return Err(TmdError::DataView(format!(
                        "Rhai source `{name}` requires at least one Formula query input"
                    )));
                }
                if inputs.len() > MAX_RHAI_INPUTS {
                    return Err(TmdError::DataView(format!(
                        "Rhai source `{name}` exceeds the {MAX_RHAI_INPUTS}-input limit"
                    )));
                }
                for (alias, source_name) in inputs {
                    validate_source_name(alias).map_err(|_| {
                        TmdError::DataView(format!(
                            "Rhai source `{name}` has invalid input alias `{alias}`"
                        ))
                    })?;
                    validate_source_name(source_name)?;
                }
                output.validate(name, "Rhai")?;
            }
            Self::Formula {
                input,
                program,
                output,
            } => {
                validate_source_name(input).map_err(|_| {
                    TmdError::DataView(format!(
                        "Formula source `{name}` has invalid Formula query input name `{input}`"
                    ))
                })?;
                parse_formula_program(program).map_err(|error| {
                    TmdError::DataView(format!(
                        "Formula source `{name}` program is invalid: {error}"
                    ))
                })?;
                output.validate(name, "Formula")?;
            }
        }
        Ok(())
    }

    fn kind_name(&self) -> &'static str {
        match self {
            Self::FormulaQuery { .. } => "Formula query",
            Self::Rhai { .. } => "Rhai",
            Self::Formula { .. } => "Formula",
        }
    }
}

impl SqliteEditDefinition {
    fn validate(&self, source_name: &str) -> TmdResult<()> {
        validate_sqlite_identifier(&self.table).map_err(|message| {
            TmdError::DataView(format!(
                "editable Formula query source `{source_name}` has invalid table `{}`: {message}",
                self.table
            ))
        })?;
        validate_output_column_name(source_name, &self.key.source_column)?;
        validate_sqlite_identifier(&self.key.table_column).map_err(|message| {
            TmdError::DataView(format!(
                "editable Formula query source `{source_name}` has invalid key table column `{}`: {message}",
                self.key.table_column
            ))
        })?;
        if self.columns.is_empty() {
            return Err(TmdError::DataView(format!(
                "editable Formula query source `{source_name}` requires at least one writable column"
            )));
        }
        for (source_column, table_column) in &self.columns {
            validate_output_column_name(source_name, source_column)?;
            if source_column == &self.key.source_column {
                return Err(TmdError::DataView(format!(
                    "editable Formula query source `{source_name}` cannot make its stable key column `{source_column}` writable"
                )));
            }
            validate_sqlite_identifier(table_column).map_err(|message| {
                TmdError::DataView(format!(
                    "editable Formula query source `{source_name}` has invalid table column `{table_column}`: {message}"
                ))
            })?;
        }
        Ok(())
    }
}

impl DataSourceOutput {
    fn validate(&self, name: &str, source_kind: &str) -> TmdResult<()> {
        match self {
            Self::Table { columns } => {
                if columns.is_empty() {
                    return Err(TmdError::DataView(format!(
                        "{source_kind} source `{name}` table output requires at least one column"
                    )));
                }
                if columns.len() > MAX_TABLE_COLUMNS {
                    return Err(TmdError::DataView(format!(
                        "{source_kind} source `{name}` table output exceeds {MAX_TABLE_COLUMNS} columns"
                    )));
                }
                let mut seen = BTreeSet::new();
                for column in columns {
                    if column.is_empty() || column.len() > MAX_COLUMN_NAME_BYTES {
                        return Err(TmdError::DataView(format!(
                            "{source_kind} source `{name}` has an empty or overlong output column"
                        )));
                    }
                    if !seen.insert(column) {
                        return Err(TmdError::DataView(format!(
                            "{source_kind} source `{name}` repeats output column `{column}`"
                        )));
                    }
                }
            }
        }
        Ok(())
    }
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
        DataSourceDefinition::FormulaQuery { query, .. } => {
            evaluate_formula_query(doc, name, query)
        }
        DataSourceDefinition::Rhai {
            script,
            inputs,
            output,
        } => evaluate_rhai(doc, &registry, name, script, inputs, output),
        DataSourceDefinition::Formula {
            input,
            program,
            output,
        } => evaluate_formula(doc, &registry, name, input, program, output),
    }
}

/// Return safe write-back metadata for a Formula query table or its computed view.
pub fn data_source_edit_info(doc: &TmdDoc, name: &str) -> TmdResult<Option<DataSourceEditInfo>> {
    validate_source_name(name)?;
    let registry = DataSourceRegistry::from_manifest_extras(&doc.manifest.extras)?;
    let definition = registry
        .sources
        .get(name)
        .ok_or_else(|| TmdError::DataView(format!("data source `{name}` is not defined")))?;
    let input_source = match definition {
        DataSourceDefinition::FormulaQuery { .. } => name,
        DataSourceDefinition::Formula { input, .. } => input,
        DataSourceDefinition::Rhai { .. } => return Ok(None),
    };
    let DataSourceDefinition::FormulaQuery {
        query,
        edit: Some(edit),
    } = registry
        .sources
        .get(input_source)
        .expect("data-source input references were validated")
    else {
        return Ok(None);
    };

    let DataValue::Table(table) = evaluate_formula_query(doc, input_source, query)? else {
        unreachable!("Formula query sources always produce tables");
    };
    let key_indexes = table
        .columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| (column == &edit.key.source_column).then_some(index))
        .collect::<Vec<_>>();
    let [key_index] = key_indexes.as_slice() else {
        return Err(TmdError::DataView(format!(
            "editable Formula query source `{input_source}` query must return key column `{}` exactly once",
            edit.key.source_column
        )));
    };
    for column in edit.columns.keys() {
        if table
            .columns
            .iter()
            .filter(|candidate| *candidate == column)
            .count()
            != 1
        {
            return Err(TmdError::DataView(format!(
                "editable Formula query source `{input_source}` query must return writable column `{column}` exactly once"
            )));
        }
    }

    let mut row_keys = Vec::with_capacity(table.rows.len());
    for (row_index, row) in table.rows.iter().enumerate() {
        let key = row.get(*key_index).ok_or_else(|| {
            TmdError::DataView(format!(
                "editable Formula query source `{input_source}` row {} does not contain its key column",
                row_index + 1
            ))
        })?;
        if matches!(key, DataScalar::Null) {
            return Err(TmdError::DataView(format!(
                "editable Formula query source `{input_source}` row {} has a null key",
                row_index + 1
            )));
        }
        if row_keys.iter().any(|candidate| candidate == key) {
            return Err(TmdError::DataView(format!(
                "editable Formula query source `{input_source}` query returned duplicate key `{}`",
                key.display_text()
            )));
        }
        row_keys.push(key.clone());
    }

    Ok(Some(DataSourceEditInfo {
        input_source: input_source.to_owned(),
        key_column: edit.key.source_column.clone(),
        editable_columns: edit.columns.keys().cloned().collect(),
        row_keys,
        input_rows: table.rows,
    }))
}

/// Apply staged primary-keyed cell updates to a document's embedded database.
pub fn apply_data_cell_edits(doc: &mut TmdDoc, edits: &[DataCellEdit]) -> TmdResult<()> {
    if edits.is_empty() {
        return Ok(());
    }
    let registry = DataSourceRegistry::from_manifest_extras(&doc.manifest.extras)?;
    doc.db_with_conn_mut(|connection| -> TmdResult<()> {
        let transaction = connection.transaction().map_err(|error| {
            TmdError::DataView(format!("could not begin Formula query table edit: {error}"))
        })?;
        for cell_edit in edits {
            validate_source_name(&cell_edit.source)?;
            let Some(DataSourceDefinition::FormulaQuery {
                edit: Some(definition),
                ..
            }) = registry.sources.get(&cell_edit.source)
            else {
                return Err(TmdError::DataView(format!(
                    "Formula query source `{}` is not editable",
                    cell_edit.source
                )));
            };
            let table_column = definition.columns.get(&cell_edit.column).ok_or_else(|| {
                TmdError::DataView(format!(
                    "Formula query source `{}` column `{}` is not editable",
                    cell_edit.source, cell_edit.column
                ))
            })?;
            if matches!(cell_edit.key, DataScalar::Null) {
                return Err(TmdError::DataView(format!(
                    "Formula query source `{}` cannot update a row with a null key",
                    cell_edit.source
                )));
            }
            let value = sqlite_value(&cell_edit.value, "cell value")?;
            let key = sqlite_value(&cell_edit.key, "row key")?;
            let sql = format!(
                "UPDATE {} SET {} = ?1 WHERE {} = ?2",
                quote_sqlite_identifier(&definition.table),
                quote_sqlite_identifier(table_column),
                quote_sqlite_identifier(&definition.key.table_column)
            );
            let changed = transaction
                .execute(&sql, rusqlite::params![value, key])
                .map_err(|error| {
                    TmdError::DataView(format!(
                        "Formula query source `{}` could not update column `{}`: {error}",
                        cell_edit.source, cell_edit.column
                    ))
                })?;
            if changed != 1 {
                return Err(TmdError::DataView(format!(
                    "Formula query source `{}` update for key `{}` matched {changed} rows; expected exactly one",
                    cell_edit.source,
                    cell_edit.key.display_text()
                )));
            }
        }
        transaction.commit().map_err(|error| {
            TmdError::DataView(format!("could not commit Formula query table edits: {error}"))
        })?;
        Ok(())
    })?
}

fn evaluate_formula(
    doc: &TmdDoc,
    registry: &DataSourceRegistry,
    name: &str,
    input: &str,
    program: &str,
    output: &DataSourceOutput,
) -> TmdResult<DataValue> {
    let DataSourceDefinition::FormulaQuery { query, .. } = registry
        .sources
        .get(input)
        .expect("formula input reference was validated")
    else {
        unreachable!("computed Formula sources accept only Formula query inputs");
    };
    let input_value = evaluate_formula_query(doc, input, query)?;
    let DataValue::Table(input_table) = input_value else {
        unreachable!("Formula query sources always produce tables");
    };
    let program = parse_formula_program(program).map_err(|error| {
        TmdError::DataView(format!("Formula source `{name}` program failed: {error}"))
    })?;
    match output {
        DataSourceOutput::Table { columns } => evaluate_formula_program_with_limits(
            &program,
            &input_table,
            columns,
            FormulaEvaluationLimits::new(MAX_TABLE_ROWS, MAX_TABLE_CELLS),
        )
        .map(DataValue::Table)
        .map_err(|error| {
            TmdError::DataView(format!(
                "Formula source `{name}` evaluation failed: {error}"
            ))
        }),
    }
}

fn evaluate_rhai(
    doc: &TmdDoc,
    registry: &DataSourceRegistry,
    name: &str,
    script_path: &str,
    inputs: &BTreeMap<String, String>,
    output: &DataSourceOutput,
) -> TmdResult<DataValue> {
    let meta = doc.attachment_meta_by_path(script_path).ok_or_else(|| {
        TmdError::DataView(format!(
            "Rhai source `{name}` script attachment `{script_path}` does not exist"
        ))
    })?;
    if meta.length > MAX_RHAI_SCRIPT_BYTES as u64 {
        return Err(TmdError::DataView(format!(
            "Rhai source `{name}` script exceeds {MAX_RHAI_SCRIPT_BYTES} bytes"
        )));
    }
    let script_bytes = doc.attachments.data(meta.id).ok_or_else(|| {
        TmdError::DataView(format!(
            "Rhai source `{name}` script attachment `{script_path}` has no data"
        ))
    })?;
    let script = std::str::from_utf8(script_bytes).map_err(|error| {
        TmdError::DataView(format!(
            "Rhai source `{name}` script attachment `{script_path}` is not UTF-8: {error}"
        ))
    })?;

    let mut rhai_inputs = Map::new();
    for (alias, source_name) in inputs {
        let DataSourceDefinition::FormulaQuery { query, .. } = registry
            .sources
            .get(source_name)
            .expect("registry input references were validated")
        else {
            unreachable!("Rhai inputs accept only Formula query sources");
        };
        let value = evaluate_formula_query(doc, source_name, query)?;
        let DataValue::Table(table) = value else {
            unreachable!("Formula query sources always produce tables");
        };
        rhai_inputs.insert(
            alias.as_str().into(),
            Dynamic::from_array(data_table_to_rhai_rows(name, alias, &table)?),
        );
    }

    let mut engine = sandboxed_rhai_engine();
    let started = Instant::now();
    engine.on_progress(move |_| {
        (started.elapsed() > MAX_RHAI_RUN_TIME).then(|| Dynamic::from("Rhai execution timed out"))
    });
    let mut scope = Scope::new();
    scope.push_constant("inputs", Dynamic::from_map(rhai_inputs));
    let result = engine
        .eval_with_scope::<Dynamic>(&mut scope, script)
        .map_err(|error| {
            TmdError::DataView(format!(
                "Rhai source `{name}` script `{script_path}` failed: {error}"
            ))
        })?;

    match output {
        DataSourceOutput::Table { columns } => {
            rhai_result_to_table(name, result.flatten(), columns)
        }
    }
}

fn sandboxed_rhai_engine() -> Engine {
    let mut engine = Engine::new();
    engine
        .set_fail_on_invalid_map_property(true)
        .set_max_operations(MAX_RHAI_OPERATIONS)
        .set_max_array_size(MAX_RHAI_ARRAY_SIZE)
        .set_max_map_size(MAX_RHAI_MAP_SIZE)
        .set_max_string_size(MAX_TEXT_BYTES)
        .set_max_variables(MAX_RHAI_VARIABLES)
        .set_max_functions(MAX_RHAI_FUNCTIONS)
        .set_max_call_levels(MAX_RHAI_CALL_LEVELS)
        .set_max_expr_depths(MAX_RHAI_EXPR_DEPTH, MAX_RHAI_FUNCTION_EXPR_DEPTH);
    engine.on_print(|_| {});
    engine.on_debug(|_, _, _| {});
    engine
}

fn data_table_to_rhai_rows(owner_name: &str, alias: &str, table: &DataTable) -> TmdResult<Array> {
    let mut unique_columns = BTreeSet::new();
    for column in &table.columns {
        if !unique_columns.insert(column) {
            return Err(TmdError::DataView(format!(
                "Rhai source `{owner_name}` input `{alias}` has duplicate column `{column}`; alias Formula query columns uniquely"
            )));
        }
    }
    let mut result = Array::with_capacity(table.rows.len());
    for row in &table.rows {
        let mut map = Map::new();
        for (column, value) in table.columns.iter().zip(row) {
            map.insert(column.as_str().into(), data_scalar_to_rhai(value));
        }
        result.push(Dynamic::from_map(map));
    }
    Ok(result)
}

fn data_scalar_to_rhai(value: &DataScalar) -> Dynamic {
    match value {
        DataScalar::Null => Dynamic::UNIT,
        DataScalar::Boolean(value) => Dynamic::from_bool(*value),
        DataScalar::Integer(value) => Dynamic::from_int(*value as INT),
        DataScalar::Real(value) => Dynamic::from_float(*value as FLOAT),
        DataScalar::String(value) => Dynamic::from(value.clone()),
    }
}

fn rhai_result_to_table(name: &str, result: Dynamic, columns: &[String]) -> TmdResult<DataValue> {
    let result_type = result.type_name().to_owned();
    let rows = result.try_cast::<Array>().ok_or_else(|| {
        TmdError::DataView(format!(
            "Rhai source `{name}` must return an array of object maps, found `{result_type}`"
        ))
    })?;
    if rows.len() > MAX_TABLE_ROWS || rows.len().saturating_mul(columns.len()) > MAX_TABLE_CELLS {
        return Err(TmdError::DataView(format!(
            "Rhai source `{name}` exceeded the table output limit"
        )));
    }

    let declared = columns.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let mut table_rows = Vec::with_capacity(rows.len());
    for (row_index, row) in rows.into_iter().enumerate() {
        let row_type = row.type_name().to_owned();
        let map = row.try_cast::<Map>().ok_or_else(|| {
            TmdError::DataView(format!(
                "Rhai source `{name}` row {} must be an object map, found `{row_type}`",
                row_index + 1
            ))
        })?;
        for key in map.keys() {
            if !declared.contains(key.as_str()) {
                return Err(TmdError::DataView(format!(
                    "Rhai source `{name}` row {} contains undeclared column `{key}`",
                    row_index + 1
                )));
            }
        }
        let mut values = Vec::with_capacity(columns.len());
        for column in columns {
            let value = map.get(column.as_str()).ok_or_else(|| {
                TmdError::DataView(format!(
                    "Rhai source `{name}` row {} is missing column `{column}`; use `()` for NULL",
                    row_index + 1
                ))
            })?;
            values.push(rhai_scalar(name, row_index, column, value)?);
        }
        table_rows.push(values);
    }
    Ok(DataValue::Table(DataTable {
        columns: columns.to_vec(),
        rows: table_rows,
    }))
}

fn rhai_scalar(
    name: &str,
    row_index: usize,
    column: &str,
    value: &Dynamic,
) -> TmdResult<DataScalar> {
    let scalar = if value.is_unit() {
        DataScalar::Null
    } else if value.is::<bool>() {
        DataScalar::Boolean(value.clone_cast::<bool>())
    } else if value.is::<INT>() {
        DataScalar::Integer(value.clone_cast::<INT>())
    } else if value.is::<FLOAT>() {
        let value = value.clone_cast::<FLOAT>();
        if !value.is_finite() {
            return Err(TmdError::DataView(format!(
                "Rhai source `{name}` row {} column `{column}` returned a non-finite real",
                row_index + 1
            )));
        }
        DataScalar::Real(value)
    } else if value.is::<ImmutableString>() {
        let value = value.clone_cast::<ImmutableString>().to_string();
        if value.len() > MAX_TEXT_BYTES {
            return Err(TmdError::DataView(format!(
                "Rhai source `{name}` row {} column `{column}` returned text exceeding {MAX_TEXT_BYTES} bytes",
                row_index + 1
            )));
        }
        DataScalar::String(value)
    } else {
        return Err(TmdError::DataView(format!(
            "Rhai source `{name}` row {} column `{column}` returned unsupported type `{}`",
            row_index + 1,
            value.type_name()
        )));
    };
    Ok(scalar)
}

fn evaluate_formula_query(doc: &TmdDoc, name: &str, query: &str) -> TmdResult<DataValue> {
    doc.db_with_conn(|connection| -> TmdResult<DataValue> {
        let mut statement = connection.prepare(query).map_err(|error| {
            TmdError::DataView(format!(
                "Formula query source `{name}` could not be prepared: {error}"
            ))
        })?;
        if !statement.readonly() {
            return Err(TmdError::DataView(format!(
                "Formula query source `{name}` must contain one read-only statement"
            )));
        }
        let columns = statement
            .column_names()
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if columns.len() > MAX_TABLE_COLUMNS {
            return Err(TmdError::DataView(format!(
                "Formula query source `{name}` returned more than {MAX_TABLE_COLUMNS} columns"
            )));
        }
        let mut rows = Vec::new();
        let mut query_rows = statement.query([]).map_err(|error| {
            TmdError::DataView(format!(
                "Formula query source `{name}` could not be evaluated: {error}"
            ))
        })?;
        while let Some(row) = query_rows.next().map_err(|error| {
            TmdError::DataView(format!(
                "Formula query source `{name}` failed while reading: {error}"
            ))
        })? {
            if rows.len() >= MAX_TABLE_ROWS
                || (rows.len() + 1).saturating_mul(columns.len()) > MAX_TABLE_CELLS
            {
                return Err(TmdError::DataView(format!(
                    "Formula query source `{name}` exceeded the table output limit"
                )));
            }
            let mut values = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                let value = row.get_ref(index).map_err(|error| {
                    TmdError::DataView(format!(
                        "Formula query source `{name}` could not read column {index}: {error}"
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
            "Formula query source `{name}` returned a non-finite real value"
        ))),
        ValueRef::Text(value) => {
            if value.len() > MAX_TEXT_BYTES {
                return Err(TmdError::DataView(format!(
                    "Formula query source `{name}` returned text exceeding {MAX_TEXT_BYTES} bytes"
                )));
            }
            let value = std::str::from_utf8(value).map_err(|error| {
                TmdError::DataView(format!(
                    "Formula query source `{name}` returned invalid UTF-8 text: {error}"
                ))
            })?;
            Ok(DataScalar::String(value.to_owned()))
        }
        ValueRef::Blob(_) => Err(TmdError::DataView(format!(
            "Formula query source `{name}` returned a BLOB, which dynamic views do not support"
        ))),
    }
}

fn sqlite_value(value: &DataScalar, role: &str) -> TmdResult<Value> {
    match value {
        DataScalar::Null => Ok(Value::Null),
        DataScalar::Boolean(value) => Ok(Value::Integer(i64::from(*value))),
        DataScalar::Integer(value) => Ok(Value::Integer(*value)),
        DataScalar::Real(value) if value.is_finite() => Ok(Value::Real(*value)),
        DataScalar::Real(_) => Err(TmdError::DataView(format!(
            "Formula query table edit {role} must be a finite real"
        ))),
        DataScalar::String(value) if value.len() <= MAX_TEXT_BYTES => {
            Ok(Value::Text(value.clone()))
        }
        DataScalar::String(_) => Err(TmdError::DataView(format!(
            "Formula query table edit {role} exceeds {MAX_TEXT_BYTES} bytes"
        ))),
    }
}

fn validate_output_column_name(source_name: &str, column: &str) -> TmdResult<()> {
    if column.is_empty() || column.len() > MAX_COLUMN_NAME_BYTES {
        return Err(TmdError::DataView(format!(
            "editable Formula query source `{source_name}` has an empty or overlong query-result column"
        )));
    }
    Ok(())
}

fn validate_sqlite_identifier(identifier: &str) -> Result<(), &'static str> {
    let mut bytes = identifier.bytes();
    let Some(first) = bytes.next() else {
        return Err("identifier is empty");
    };
    if identifier.len() > MAX_SQLITE_IDENTIFIER_BYTES {
        return Err("identifier is too long");
    }
    if !(first.is_ascii_alphabetic() || first == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(
            "use ASCII letters, digits, and underscores, starting with a letter or underscore",
        );
    }
    Ok(())
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    debug_assert!(validate_sqlite_identifier(identifier).is_ok());
    format!("\"{identifier}\"")
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
                "schema_version": 5,
                "sources": {
                    "first-note": {
                        "type": "formula",
                        "query": "SELECT body FROM sample_notes WHERE id = 1"
                    },
                    "sample-notes": {
                        "type": "formula",
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

    fn document_with_rhai(script: &str, columns: &[&str]) -> TmdDoc {
        let mut doc = TmdDoc::new(String::new()).expect("document");
        doc.manifest.extras = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 5,
                "sources": {
                    "sales": {
                        "type": "formula",
                        "query": "SELECT category, amount_cents FROM sample_sales ORDER BY id"
                    },
                    "category-summary": {
                        "type": "rhai",
                        "script": "views/category-summary.rhai",
                        "inputs": { "sales": "sales" },
                        "output": {
                            "type": "table",
                            "columns": columns
                        }
                    }
                }
            }
        });
        doc.db_with_conn_mut(|connection| {
            connection.execute_batch(
                "CREATE TABLE sample_sales(\
                    id INTEGER PRIMARY KEY,\
                    category TEXT NOT NULL,\
                    amount_cents INTEGER NOT NULL\
                 );\
                 INSERT INTO sample_sales(category, amount_cents) VALUES\
                    ('books', 1200), ('games', 3500), ('books', 800);",
            )
        })
        .expect("database access")
        .expect("database fixture");
        doc.add_attachment(
            "views/category-summary.rhai",
            "text/x-rhai".parse().expect("Rhai MIME type"),
            script.as_bytes().to_vec(),
        )
        .expect("Rhai script attachment");
        doc
    }

    fn document_with_formula(program: &str) -> TmdDoc {
        let mut doc = TmdDoc::new(String::new()).expect("document");
        doc.manifest.extras = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 5,
                "sources": {
                    "sales": {
                        "type": "formula",
                        "query": "SELECT category, amount_cents FROM sample_sales ORDER BY id"
                    },
                    "sales-formulas": {
                        "type": "formula",
                        "input": "sales",
                        "program": program,
                        "output": {
                            "type": "table",
                            "columns": ["category", "amount_cents", "double_cents"]
                        }
                    }
                }
            }
        });
        doc.db_with_conn_mut(|connection| {
            connection.execute_batch(
                "CREATE TABLE sample_sales(\
                    id INTEGER PRIMARY KEY,\
                    category TEXT NOT NULL,\
                    amount_cents INTEGER NOT NULL\
                 );\
                 INSERT INTO sample_sales(category, amount_cents) VALUES\
                    ('books', 1200), ('games', 3500), ('books', 800);",
            )
        })
        .expect("database access")
        .expect("database fixture");
        doc
    }

    fn document_with_editable_formula(program: &str) -> TmdDoc {
        let mut doc = TmdDoc::new(String::new()).expect("document");
        doc.manifest.extras = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 5,
                "sources": {
                    "sales": {
                        "type": "formula",
                        "query": "SELECT id, category, amount_cents FROM sample_sales ORDER BY id",
                        "edit": {
                            "table": "sample_sales",
                            "key": {
                                "source_column": "id",
                                "table_column": "id"
                            },
                            "columns": {
                                "category": "category",
                                "amount_cents": "amount_cents"
                            }
                        }
                    },
                    "sales-formulas": {
                        "type": "formula",
                        "input": "sales",
                        "program": program,
                        "output": {
                            "type": "table",
                            "columns": ["id", "category", "amount_cents", "double_cents"]
                        }
                    }
                }
            }
        });
        doc.db_with_conn_mut(|connection| {
            connection.execute_batch(
                "CREATE TABLE sample_sales(\
                    id INTEGER PRIMARY KEY,\
                    category TEXT NOT NULL,\
                    amount_cents INTEGER NOT NULL\
                 );\
                 INSERT INTO sample_sales(category, amount_cents) VALUES\
                    ('books', 1200), ('games', 3500);",
            )
        })
        .expect("database access")
        .expect("database fixture");
        doc
    }

    #[test]
    fn normalizes_legacy_sqlite_sources_and_serializes_formula_tags() {
        for schema_version in 1..=EDITABLE_DATA_SOURCES_SCHEMA_VERSION {
            let extras = json!({
                DATA_SOURCES_EXTRAS_KEY: {
                    "schema_version": schema_version,
                    "sources": {
                        "legacy": {
                            "type": "sqlite",
                            "query": "SELECT 1 AS value"
                        }
                    }
                }
            });
            let registry = DataSourceRegistry::from_manifest_extras(&extras)
                .expect("legacy SQLite registry remains readable");
            assert!(matches!(
                registry.sources.get("legacy"),
                Some(DataSourceDefinition::FormulaQuery { query, edit: None })
                    if query == "SELECT 1 AS value"
            ));
            let serialized = serde_json::to_value(&registry).expect("serialize current registry");
            assert_eq!(serialized["schema_version"], json!(5));
            assert_eq!(serialized["sources"]["legacy"]["type"], json!("formula"));
        }
    }

    #[test]
    fn enforces_schema_five_formula_query_contracts() {
        let legacy_in_current = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 5,
                "sources": {
                    "rows": { "type": "sqlite", "query": "SELECT 1" }
                }
            }
        });
        let error = DataSourceRegistry::from_manifest_extras(&legacy_in_current)
            .expect_err("schema version 5 rejects legacy source tags");
        assert!(error.to_string().contains("legacy SQLite source"));

        let current_in_legacy = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 4,
                "sources": {
                    "rows": { "type": "formula", "query": "SELECT 1" }
                }
            }
        });
        let error = DataSourceRegistry::from_manifest_extras(&current_in_legacy)
            .expect_err("Formula query requires schema version 5");
        assert!(error
            .to_string()
            .contains("requires data-source schema_version 5"));

        let invalid_rhai_input = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 5,
                "sources": {
                    "rows": { "type": "formula", "query": "SELECT 1 AS value" },
                    "computed": {
                        "type": "formula",
                        "input": "rows",
                        "program": "A1 = 1",
                        "output": { "type": "table", "columns": ["value"] }
                    },
                    "scripted": {
                        "type": "rhai",
                        "script": "views/scripted.rhai",
                        "inputs": { "rows": "computed" },
                        "output": { "type": "table", "columns": ["value"] }
                    }
                }
            }
        });
        let error = DataSourceRegistry::from_manifest_extras(&invalid_rhai_input)
            .expect_err("Rhai cannot consume a computed Formula");
        assert!(error
            .to_string()
            .contains("must reference a Formula query source"));
    }

    #[test]
    fn rejects_null_and_mixed_formula_shapes() {
        let invalid_definitions = [
            ("null query", json!({ "type": "formula", "query": null })),
            (
                "null query edit",
                json!({ "type": "formula", "query": "SELECT 1", "edit": null }),
            ),
            (
                "computed Formula with a null query",
                json!({
                    "type": "formula",
                    "query": null,
                    "input": "rows",
                    "program": "A1 = 1",
                    "output": { "type": "table", "columns": ["value"] }
                }),
            ),
            (
                "query Formula with null computed fields",
                json!({
                    "type": "formula",
                    "query": "SELECT 1",
                    "input": null,
                    "program": null,
                    "output": null
                }),
            ),
            (
                "computed Formula with a null edit",
                json!({
                    "type": "formula",
                    "input": "rows",
                    "program": "A1 = 1",
                    "output": { "type": "table", "columns": ["value"] },
                    "edit": null
                }),
            ),
            (
                "mixed query and computed Formula",
                json!({
                    "type": "formula",
                    "query": "SELECT 1",
                    "input": "rows",
                    "program": "A1 = 1",
                    "output": { "type": "table", "columns": ["value"] }
                }),
            ),
        ];

        for (label, definition) in invalid_definitions {
            let extras = json!({
                DATA_SOURCES_EXTRAS_KEY: {
                    "schema_version": 5,
                    "sources": {
                        "rows": { "type": "formula", "query": "SELECT 1 AS value" },
                        "candidate": definition
                    }
                }
            });
            assert!(
                DataSourceRegistry::from_manifest_extras(&extras).is_err(),
                "{label} must be rejected"
            );
        }
    }

    #[test]
    fn retains_schema_three_computed_formula_compatibility() {
        let extras = json!({
            DATA_SOURCES_EXTRAS_KEY: {
                "schema_version": 3,
                "sources": {
                    "rows": { "type": "sqlite", "query": "SELECT 1 AS value" },
                    "computed": {
                        "type": "formula",
                        "input": "rows",
                        "program": "A1 = 1",
                        "output": { "type": "table", "columns": ["value"] }
                    }
                }
            }
        });
        let registry = DataSourceRegistry::from_manifest_extras(&extras)
            .expect("schema version 3 computed Formula remains readable");
        assert!(matches!(
            registry.sources.get("rows"),
            Some(DataSourceDefinition::FormulaQuery { .. })
        ));
        assert!(matches!(
            registry.sources.get("computed"),
            Some(DataSourceDefinition::Formula { input, .. }) if input == "rows"
        ));
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
    fn exposes_formula_input_edit_metadata_and_applies_atomic_keyed_edits() {
        let mut doc =
            document_with_editable_formula("D1 = [@amount_cents] * 2\nD2 = [@amount_cents] * 2");
        let info = data_source_edit_info(&doc, "sales-formulas")
            .expect("edit metadata")
            .expect("editable source");
        assert_eq!(info.input_source, "sales");
        assert_eq!(info.key_column, "id");
        assert_eq!(
            info.row_keys,
            vec![DataScalar::Integer(1), DataScalar::Integer(2)]
        );
        assert_eq!(
            info.editable_columns,
            vec!["amount_cents".to_owned(), "category".to_owned()]
        );

        apply_data_cell_edits(
            &mut doc,
            &[DataCellEdit {
                source: "sales".to_owned(),
                key: DataScalar::Integer(2),
                column: "amount_cents".to_owned(),
                value: DataScalar::Integer(4_000),
            }],
        )
        .expect("keyed update");
        let table = evaluate_data_source(&doc, "sales-formulas")
            .expect("Formula evaluation")
            .as_table()
            .expect("table")
            .clone();
        assert_eq!(table.rows[1][2], DataScalar::Integer(4_000));
        assert_eq!(table.rows[1][3], DataScalar::Integer(8_000));

        let error = apply_data_cell_edits(
            &mut doc,
            &[
                DataCellEdit {
                    source: "sales".to_owned(),
                    key: DataScalar::Integer(1),
                    column: "amount_cents".to_owned(),
                    value: DataScalar::Integer(100),
                },
                DataCellEdit {
                    source: "sales".to_owned(),
                    key: DataScalar::Integer(99),
                    column: "amount_cents".to_owned(),
                    value: DataScalar::Integer(200),
                },
            ],
        )
        .expect_err("missing key must roll back the edit batch");
        assert!(error.to_string().contains("matched 0 rows"));
        let sales = evaluate_data_source(&doc, "sales")
            .expect("sales")
            .as_table()
            .expect("table")
            .clone();
        assert_eq!(sales.rows[0][2], DataScalar::Integer(1_200));
    }

    #[test]
    fn evaluates_rhai_table_aggregation() {
        let doc = document_with_rhai(
            r#"
                let totals = #{};
                for row in inputs.sales {
                    if row.category in totals {
                        totals[row.category] += row.amount_cents;
                    } else {
                        totals[row.category] = row.amount_cents;
                    }
                }

                let categories = totals.keys();
                categories.sort();
                let output = [];
                for category in categories {
                    output.push(#{
                        category: category,
                        total_cents: totals[category]
                    });
                }
                output
            "#,
            &["category", "total_cents"],
        );

        assert_eq!(
            evaluate_data_source(&doc, "category-summary").expect("Rhai table source"),
            DataValue::Table(DataTable {
                columns: vec!["category".to_owned(), "total_cents".to_owned()],
                rows: vec![
                    vec![
                        DataScalar::String("books".to_owned()),
                        DataScalar::Integer(2_000),
                    ],
                    vec![
                        DataScalar::String("games".to_owned()),
                        DataScalar::Integer(3_500),
                    ],
                ],
            })
        );
    }

    #[test]
    fn evaluates_formula_table_with_derived_and_summary_cells() {
        let doc = document_with_formula(
            "C1 = [@amount_cents] * 2\n\
             C2 = [@amount_cents] * 2\n\
             C3 = [@amount_cents] * 2\n\
             B4 = SUM([amount_cents])\n\
             C4 = SUM(C1:C3)",
        );

        assert_eq!(
            evaluate_data_source(&doc, "sales-formulas").expect("Formula table source"),
            DataValue::Table(DataTable {
                columns: vec![
                    "category".to_owned(),
                    "amount_cents".to_owned(),
                    "double_cents".to_owned(),
                ],
                rows: vec![
                    vec![
                        DataScalar::String("books".to_owned()),
                        DataScalar::Integer(1_200),
                        DataScalar::Integer(2_400),
                    ],
                    vec![
                        DataScalar::String("games".to_owned()),
                        DataScalar::Integer(3_500),
                        DataScalar::Integer(7_000),
                    ],
                    vec![
                        DataScalar::String("books".to_owned()),
                        DataScalar::Integer(800),
                        DataScalar::Integer(1_600),
                    ],
                    vec![
                        DataScalar::Null,
                        DataScalar::Integer(5_500),
                        DataScalar::Integer(11_000),
                    ],
                ],
            })
        );
    }

    #[test]
    fn enforces_formula_schema_input_and_output_contracts() {
        let mut version_two = document_with_formula("C1 = 1");
        version_two.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["schema_version"] = json!(2);
        version_two.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["sales"]["type"] =
            json!("sqlite");
        let error = evaluate_data_source(&version_two, "sales-formulas")
            .expect_err("Formula requires schema version 3");
        assert!(error
            .to_string()
            .contains("requires data-source schema_version 3"));

        let mut wrong_input = document_with_formula("C1 = 1");
        wrong_input.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["transform"] = json!({
            "type": "rhai",
            "script": "views/transform.rhai",
            "inputs": { "sales": "sales" },
            "output": { "type": "table", "columns": ["value"] }
        });
        wrong_input.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["sales-formulas"]
            ["input"] = json!("transform");
        let error = evaluate_data_source(&wrong_input, "sales-formulas")
            .expect_err("Formula input must be a Formula query");
        assert!(error
            .to_string()
            .contains("must reference a Formula query source"));

        let mut wrong_output = document_with_formula("C1 = 1");
        wrong_output.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["sales-formulas"]
            ["output"]["columns"] = json!(["renamed", "amount_cents", "result"]);
        let error = evaluate_data_source(&wrong_output, "sales-formulas")
            .expect_err("input columns must be an output prefix");
        assert!(error
            .to_string()
            .contains("must begin with the input table columns"));

        let mut schema_three_rhai = document_with_rhai("[]", &["category"]);
        schema_three_rhai.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["schema_version"] = json!(3);
        schema_three_rhai.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["sales"]["type"] =
            json!("sqlite");
        evaluate_data_source(&schema_three_rhai, "category-summary")
            .expect("schema version 3 retains Rhai sources");
    }

    #[test]
    fn rejects_rhai_results_that_do_not_match_declared_columns() {
        let doc = document_with_rhai(
            "[#{ category: \"books\", total_cents: 2000, extra: true }]",
            &["category", "total_cents"],
        );
        let error =
            evaluate_data_source(&doc, "category-summary").expect_err("undeclared output column");
        assert!(error.to_string().contains("undeclared column `extra`"));

        let doc = document_with_rhai("[#{ category: \"books\" }]", &["category", "total_cents"]);
        let error =
            evaluate_data_source(&doc, "category-summary").expect_err("missing output column");
        assert!(error.to_string().contains("missing column `total_cents`"));

        let doc = document_with_rhai("#{ category: \"books\" }", &["category"]);
        let error = evaluate_data_source(&doc, "category-summary").expect_err("non-array output");
        assert!(error.to_string().contains("must return an array"));
    }

    #[test]
    fn rejects_rhai_in_legacy_registry_and_unbounded_execution() {
        let mut legacy = document_with_rhai("[]", &["category"]);
        legacy.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["schema_version"] = json!(1);
        legacy.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["sales"]["type"] =
            json!("sqlite");
        let error = evaluate_data_source(&legacy, "category-summary")
            .expect_err("Rhai requires schema version 2");
        assert!(error
            .to_string()
            .contains("requires data-source schema_version 2"));

        let doc = document_with_rhai("loop {}", &["category"]);
        let error = evaluate_data_source(&doc, "category-summary")
            .expect_err("operation limit interrupts runaway script");
        assert!(error.to_string().contains("failed"));
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
            "type": "formula",
            "query": "DELETE FROM sample_notes"
        });
        let error = evaluate_data_source(&doc, "bad").expect_err("mutating source");
        assert!(error.to_string().contains("read-only"));

        doc.manifest.extras[DATA_SOURCES_EXTRAS_KEY]["sources"]["multiple"] = json!({
            "type": "formula",
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
