//! Tanu Markdown command-line interface.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, ensure, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Parser, Subcommand};
use html_escape::{encode_double_quoted_attribute, encode_text};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{
    html, CodeBlockKind, CowStr, Event, Options, Parser as MdParser, Tag, TagEnd,
};
use rusqlite::types::Value as SqlValue;
use same_file::Handle;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use tmd_core::{
    apply_data_cell_edits, attachment_references, data_source_edit_info, evaluate_data_source,
    export_db, import_db, inline_data_view_references, migrate, parse_data_view_block, read_tmd,
    reset_db, validate_document, write_bytes_to_path, write_to_path, AttachmentMeta, DataCellEdit,
    DataScalar, DataValue, DataViewRenderKind, ReadMode, TmdDoc, ValidationSeverity,
    SQLITE_MAX_USER_VERSION,
};

const JSON_SCHEMA_VERSION: u32 = 1;
const MAX_TEXT_ATTACHMENT_EDITS: usize = 16;
const MAX_TEXT_ATTACHMENT_BYTES: usize = 256 * 1024;
const MAX_DATABASE_CELL_EDITS: usize = 10_000;
const URL_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Parser)]
#[command(name = "tmd", version, about = "Tanu Markdown CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Create a new `.tmd` document.
    New {
        output: PathBuf,
        #[arg(long)]
        title: Option<String>,
    },
    /// Atomically publish a validated `.tmd` document.
    Publish {
        input: PathBuf,
        output: PathBuf,
        /// Publish only if the output is still `missing` or has this SHA-256 digest.
        #[arg(long, value_parser = parse_expected_output_state)]
        expected_output_state: Option<ExpectedOutputState>,
    },
    /// Validate a document and its cross-component invariants.
    Validate {
        input: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Inspect a document through the stable JSON bridge used by editor integrations.
    Inspect {
        input: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Apply a schema-versioned JSON update read from stdin.
    Update {
        input: PathBuf,
        #[arg(long)]
        json_stdin: bool,
    },
    /// Render safe preview HTML using the document data and Markdown from JSON stdin.
    Preview {
        input: PathBuf,
        #[arg(long)]
        json_stdin: bool,
    },
    /// Evaluate a named tabular data source using a JSON request from stdin.
    DataSource {
        input: PathBuf,
        #[arg(long)]
        json_stdin: bool,
    },
    /// Manage embedded attachments.
    Attachment {
        #[command(subcommand)]
        command: AttachmentCommands,
    },
    /// Export a document to HTML.
    ExportHtml {
        input: PathBuf,
        output: PathBuf,
        #[arg(long)]
        self_contained: bool,
        /// Publish only if the output is still `missing` or has this SHA-256 digest.
        #[arg(long, value_parser = parse_expected_output_state)]
        expected_output_state: Option<ExpectedOutputState>,
    },
    /// Manage the embedded SQLite database.
    Db {
        #[command(subcommand)]
        command: DbCommands,
    },
}

#[derive(Subcommand)]
enum AttachmentCommands {
    /// List attachment metadata.
    List {
        doc: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Read one UTF-8 attachment through the editor JSON bridge.
    Text {
        doc: PathBuf,
        #[arg(long = "path")]
        logical_path: String,
        #[arg(long)]
        json: bool,
    },
    /// Add an attachment; duplicate logical paths are rejected.
    Add {
        doc: PathBuf,
        source: PathBuf,
        #[arg(long = "path")]
        logical_path: String,
        #[arg(long)]
        mime: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        alt: Option<String>,
    },
    /// Remove an attachment by logical path.
    Remove {
        doc: PathBuf,
        #[arg(long = "path")]
        logical_path: String,
    },
    /// Rename an attachment while preserving its identity and bytes.
    Rename {
        doc: PathBuf,
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
    },
    /// Extract an attachment to a standalone file.
    Extract {
        doc: PathBuf,
        #[arg(long = "path")]
        logical_path: String,
        output: PathBuf,
    },
}

#[derive(Subcommand)]
enum DbCommands {
    /// Initialise or reset the embedded database schema.
    Init {
        doc: PathBuf,
        #[arg(long)]
        schema: Option<PathBuf>,
        #[arg(long, value_parser = parse_sqlite_user_version)]
        version: Option<u32>,
    },
    /// Execute one or more mutating SQL statements.
    Exec {
        doc: PathBuf,
        #[arg(long)]
        sql: String,
    },
    /// Execute exactly one read-only query.
    Query {
        doc: PathBuf,
        #[arg(long)]
        sql: String,
        #[arg(long)]
        json: bool,
    },
    /// Apply an explicit database migration and update the manifest version.
    Migrate {
        doc: PathBuf,
        #[arg(long, value_parser = parse_sqlite_user_version)]
        from: u32,
        #[arg(long, value_parser = parse_sqlite_user_version)]
        to: u32,
        #[arg(long)]
        sql: String,
    },
    /// Import a SQLite file, replacing the embedded database.
    Import { doc: PathBuf, source: PathBuf },
    /// Export the embedded SQLite database to a standalone file.
    Export { doc: PathBuf, output: PathBuf },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentUpdate {
    schema_version: u32,
    markdown: Option<String>,
    title: Option<String>,
    authors: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    extras: Option<JsonValue>,
    text_attachments: Option<Vec<TextAttachmentUpdate>>,
    database_edits: Option<Vec<DataCellEditUpdate>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewRequest {
    schema_version: u32,
    markdown: String,
    extras: Option<JsonValue>,
    text_attachments: Option<Vec<TextAttachmentUpdate>>,
    database_edits: Option<Vec<DataCellEditUpdate>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DataSourceRequest {
    schema_version: u32,
    source: String,
    extras: Option<JsonValue>,
    text_attachments: Option<Vec<TextAttachmentUpdate>>,
    database_edits: Option<Vec<DataCellEditUpdate>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextAttachmentUpdate {
    logical_path: String,
    text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DataCellEditUpdate {
    source: String,
    key: DataCellScalarUpdate,
    column: String,
    value: DataCellScalarUpdate,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
enum DataCellScalarUpdate {
    Null,
    Boolean(bool),
    Integer(String),
    Real(f64),
    String(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExpectedOutputState {
    Missing,
    Sha256([u8; 32]),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::New { output, title } => cmd_new(&output, title.as_deref()),
        Commands::Publish {
            input,
            output,
            expected_output_state,
        } => cmd_publish(&input, &output, expected_output_state.as_ref()),
        Commands::Validate { input, json } => cmd_validate(&input, json),
        Commands::Inspect { input, json } => cmd_inspect(&input, json),
        Commands::Update { input, json_stdin } => cmd_update(&input, json_stdin),
        Commands::Preview { input, json_stdin } => cmd_preview(&input, json_stdin),
        Commands::DataSource { input, json_stdin } => cmd_data_source(&input, json_stdin),
        Commands::Attachment { command } => match command {
            AttachmentCommands::List { doc, json } => cmd_attachment_list(&doc, json),
            AttachmentCommands::Text {
                doc,
                logical_path,
                json,
            } => cmd_attachment_text(&doc, &logical_path, json),
            AttachmentCommands::Add {
                doc,
                source,
                logical_path,
                mime,
                title,
                alt,
            } => cmd_attachment_add(&doc, &source, &logical_path, mime.as_deref(), title, alt),
            AttachmentCommands::Remove { doc, logical_path } => {
                cmd_attachment_remove(&doc, &logical_path)
            }
            AttachmentCommands::Rename { doc, from, to } => cmd_attachment_rename(&doc, &from, &to),
            AttachmentCommands::Extract {
                doc,
                logical_path,
                output,
            } => cmd_attachment_extract(&doc, &logical_path, &output),
        },
        Commands::ExportHtml {
            input,
            output,
            self_contained,
            expected_output_state,
        } => cmd_export_html(
            &input,
            &output,
            self_contained,
            expected_output_state.as_ref(),
        ),
        Commands::Db { command } => match command {
            DbCommands::Init {
                doc,
                schema,
                version,
            } => cmd_db_init(&doc, schema.as_deref(), version),
            DbCommands::Exec { doc, sql } => cmd_db_exec(&doc, &sql),
            DbCommands::Query { doc, sql, json } => cmd_db_query(&doc, &sql, json),
            DbCommands::Migrate { doc, from, to, sql } => cmd_db_migrate(&doc, from, to, &sql),
            DbCommands::Import { doc, source } => cmd_db_import(&doc, &source),
            DbCommands::Export { doc, output } => cmd_db_export(&doc, &output),
        },
    }
}

fn cmd_new(path: &Path, title: Option<&str>) -> Result<()> {
    ensure!(!path.exists(), "target `{}` already exists", path.display());
    ensure_parent_directory(path)?;

    ensure_tmd_path(path)?;
    let display_title = title.unwrap_or("New TMD Document");
    let markdown =
        format!("# {display_title}\n\nWelcome to **Tanu Markdown**!\n\nThe embedded database is ready for use.\n");
    let mut doc = TmdDoc::new(markdown).context("failed to create document")?;
    doc.manifest.title = Some(display_title.to_owned());
    doc.touch();

    write_document_if_expected(path, &doc, Some(&ExpectedOutputState::Missing))?;
    println!("Created new .tmd document at {}", path.display());
    Ok(())
}

fn cmd_publish(
    input: &Path,
    output: &Path,
    expected_output_state: Option<&ExpectedOutputState>,
) -> Result<()> {
    ensure_distinct_existing_paths(input, output, "published document")?;
    let (doc, input_bytes) = read_document_snapshot(input)?;
    let validation = validate_document(&doc).context("failed to validate document")?;
    ensure!(
        validation.valid,
        "refusing to publish an invalid document; run `tmd validate {}`",
        input.display()
    );
    ensure_tmd_path(output)?;
    ensure_parent_directory(output)?;
    write_bytes_if_expected(output, &input_bytes, expected_output_state)?;
    println!("Published `{}` to `{}`", input.display(), output.display());
    Ok(())
}

fn cmd_validate(input: &Path, json_output: bool) -> Result<()> {
    let doc = match read_document(input) {
        Ok(result) => result,
        Err(error) => {
            if json_output {
                print_validation_error("container_read_failed", &error)?;
            }
            return Err(error);
        }
    };
    let report = match validate_document(&doc).context("failed to validate document") {
        Ok(report) => report,
        Err(error) => {
            if json_output {
                print_validation_error("validation_failed", &error)?;
            }
            return Err(error);
        }
    };

    if json_output {
        let mut value = serde_json::to_value(&report)?;
        value
            .as_object_mut()
            .expect("validation report serializes as object")
            .insert("schema_version".to_owned(), json!(JSON_SCHEMA_VERSION));
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else if report.valid {
        println!(
            "{} is valid (user_version = {})",
            input.display(),
            report.database_user_version
        );
        for issue in &report.issues {
            println!("warning [{}]: {}", issue.code, issue.message);
        }
    } else {
        for issue in &report.issues {
            println!(
                "{} [{}]: {}",
                match issue.severity {
                    ValidationSeverity::Error => "error",
                    ValidationSeverity::Warning => "warning",
                },
                issue.code,
                issue.message
            );
        }
    }

    ensure!(report.valid, "document validation failed");
    Ok(())
}

fn print_validation_error(code: &str, error: &anyhow::Error) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema_version": JSON_SCHEMA_VERSION,
            "valid": false,
            "issues": [{
                "severity": "error",
                "code": code,
                "message": format!("{error:#}"),
            }],
            "attachment_references": [],
            "data_view_references": [],
            "database_user_version": null,
        }))?
    );
    Ok(())
}

fn cmd_inspect(input: &Path, json_output: bool) -> Result<()> {
    let doc = read_document(input)?;
    let value = inspection_value(&doc)?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        let attachments = value["attachments"].as_array().map_or(0, Vec::len);
        println!(
            "{} ({}, {} attachment(s), valid={})",
            input.display(),
            value["format"].as_str().unwrap_or("unknown"),
            attachments,
            value["validation"]["valid"].as_bool().unwrap_or(false)
        );
    }
    Ok(())
}

fn cmd_update(input: &Path, json_stdin: bool) -> Result<()> {
    ensure!(
        json_stdin,
        "`update` requires --json-stdin to make the input contract explicit"
    );
    let mut payload = String::new();
    io::stdin()
        .read_to_string(&mut payload)
        .context("failed to read JSON update from stdin")?;
    let update: DocumentUpdate =
        serde_json::from_str(&payload).context("failed to parse document update JSON")?;
    ensure!(
        update.schema_version == JSON_SCHEMA_VERSION,
        "unsupported update schema_version {}; expected {}",
        update.schema_version,
        JSON_SCHEMA_VERSION
    );

    let (mut doc, expected) = read_document_for_update(input)?;
    if let Some(markdown) = update.markdown {
        doc.markdown = markdown;
    }
    if let Some(title) = update.title {
        doc.manifest.title = if title.is_empty() { None } else { Some(title) };
    }
    if let Some(authors) = update.authors {
        doc.manifest.authors = authors;
    }
    if let Some(tags) = update.tags {
        doc.manifest.tags = tags;
    }
    if let Some(extras) = update.extras {
        doc.manifest.extras = extras;
    }
    if let Some(text_attachments) = update.text_attachments {
        apply_text_attachment_updates(&mut doc, &text_attachments)?;
    }
    apply_database_edit_updates(&mut doc, update.database_edits.as_deref())?;
    doc.touch();
    write_document_if_expected(input, &doc, Some(&expected))?;
    let persisted_doc = read_document(input)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&inspection_value(&persisted_doc)?)?
    );
    Ok(())
}

fn cmd_preview(input: &Path, json_stdin: bool) -> Result<()> {
    ensure!(
        json_stdin,
        "`preview` requires --json-stdin to make the input contract explicit"
    );
    let mut payload = String::new();
    io::stdin()
        .read_to_string(&mut payload)
        .context("failed to read JSON preview request from stdin")?;
    let request: PreviewRequest =
        serde_json::from_str(&payload).context("failed to parse preview request JSON")?;
    ensure!(
        request.schema_version == JSON_SCHEMA_VERSION,
        "unsupported preview schema_version {}; expected {}",
        request.schema_version,
        JSON_SCHEMA_VERSION
    );
    let mut doc = read_document(input)?;
    if let Some(extras) = request.extras {
        doc.manifest.extras = extras;
    }
    if let Some(text_attachments) = request.text_attachments {
        apply_text_attachment_updates(&mut doc, &text_attachments)?;
    }
    apply_database_edit_updates(&mut doc, request.database_edits.as_deref())?;
    let attachment_urls = embedded_attachment_urls(&doc);
    let preview_html = render_markdown_body(&doc, &request.markdown, &attachment_urls)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema_version": JSON_SCHEMA_VERSION,
            "preview_html": preview_html,
        }))?
    );
    Ok(())
}

fn cmd_data_source(input: &Path, json_stdin: bool) -> Result<()> {
    ensure!(
        json_stdin,
        "`data-source` requires --json-stdin to make the input contract explicit"
    );
    let mut payload = String::new();
    io::stdin()
        .read_to_string(&mut payload)
        .context("failed to read JSON data-source request from stdin")?;
    let request: DataSourceRequest =
        serde_json::from_str(&payload).context("failed to parse data-source request JSON")?;
    ensure!(
        request.schema_version == JSON_SCHEMA_VERSION,
        "unsupported data-source schema_version {}; expected {}",
        request.schema_version,
        JSON_SCHEMA_VERSION
    );
    let mut doc = read_document(input)?;
    if let Some(extras) = request.extras {
        doc.manifest.extras = extras;
    }
    if let Some(text_attachments) = request.text_attachments {
        apply_text_attachment_updates(&mut doc, &text_attachments)?;
    }
    apply_database_edit_updates(&mut doc, request.database_edits.as_deref())?;
    let value = evaluate_data_source(&doc, &request.source)?;
    let table = value.as_table()?;
    let rows = table
        .rows
        .iter()
        .map(|row| row.iter().map(data_scalar_json).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let editable = data_source_edit_info(&doc, &request.source)?.map(|info| {
        json!({
            "input_source": info.input_source,
            "key_column": info.key_column,
            "editable_columns": info.editable_columns,
            "row_keys": info.row_keys.iter().map(data_scalar_json).collect::<Vec<_>>(),
            "input_rows": info.input_rows.iter().map(|row| {
                row.iter().map(data_scalar_json).collect::<Vec<_>>()
            }).collect::<Vec<_>>(),
        })
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema_version": JSON_SCHEMA_VERSION,
            "source": request.source,
            "kind": "table",
            "columns": table.columns,
            "rows": rows,
            "editable": editable,
        }))?
    );
    Ok(())
}

fn apply_database_edit_updates(
    doc: &mut TmdDoc,
    updates: Option<&[DataCellEditUpdate]>,
) -> Result<()> {
    let Some(updates) = updates else {
        return Ok(());
    };
    ensure!(
        updates.len() <= MAX_DATABASE_CELL_EDITS,
        "database cell edit count exceeds {MAX_DATABASE_CELL_EDITS}"
    );
    let edits = updates
        .iter()
        .map(|update| {
            Ok(DataCellEdit {
                source: update.source.clone(),
                key: data_cell_scalar(&update.key)?,
                column: update.column.clone(),
                value: data_cell_scalar(&update.value)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    apply_data_cell_edits(doc, &edits)?;
    Ok(())
}

fn data_cell_scalar(value: &DataCellScalarUpdate) -> Result<DataScalar> {
    match value {
        DataCellScalarUpdate::Null => Ok(DataScalar::Null),
        DataCellScalarUpdate::Boolean(value) => Ok(DataScalar::Boolean(*value)),
        DataCellScalarUpdate::Integer(value) => {
            Ok(DataScalar::Integer(value.parse::<i64>().with_context(
                || format!("invalid 64-bit integer cell value `{value}`"),
            )?))
        }
        DataCellScalarUpdate::Real(value) => {
            ensure!(value.is_finite(), "real cell values must be finite");
            Ok(DataScalar::Real(*value))
        }
        DataCellScalarUpdate::String(value) => Ok(DataScalar::String(value.clone())),
    }
}

fn data_scalar_json(value: &DataScalar) -> JsonValue {
    match value {
        DataScalar::Null => json!({ "type": "null" }),
        DataScalar::Boolean(value) => json!({ "type": "boolean", "value": value }),
        DataScalar::Integer(value) => {
            json!({ "type": "integer", "value": value.to_string() })
        }
        DataScalar::Real(value) => json!({ "type": "real", "value": value }),
        DataScalar::String(value) => json!({ "type": "string", "value": value }),
    }
}

fn cmd_attachment_list(doc_path: &Path, json_output: bool) -> Result<()> {
    let doc = read_document(doc_path)?;
    let attachments = sorted_attachment_values(&doc)?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "schema_version": JSON_SCHEMA_VERSION,
                "attachments": attachments,
            }))?
        );
    } else if attachments.is_empty() {
        println!("No attachments");
    } else {
        for attachment in attachments {
            println!(
                "{}\t{}\t{} bytes",
                attachment["logical_path"].as_str().unwrap_or_default(),
                attachment["mime"].as_str().unwrap_or_default(),
                attachment["length"].as_u64().unwrap_or_default()
            );
        }
    }
    Ok(())
}

fn cmd_attachment_text(doc_path: &Path, logical_path: &str, json_output: bool) -> Result<()> {
    let doc = read_document(doc_path)?;
    let id = attachment_id_by_path(&doc, logical_path)?;
    let data = doc
        .attachments
        .data(id)
        .ok_or_else(|| anyhow!("attachment `{logical_path}` has no data"))?;
    ensure!(
        data.len() <= MAX_TEXT_ATTACHMENT_BYTES,
        "attachment `{logical_path}` exceeds the {MAX_TEXT_ATTACHMENT_BYTES}-byte text limit"
    );
    let text = std::str::from_utf8(data)
        .with_context(|| format!("attachment `{logical_path}` is not UTF-8"))?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "schema_version": JSON_SCHEMA_VERSION,
                "logical_path": logical_path,
                "text": text,
            }))?
        );
    } else {
        print!("{text}");
    }
    Ok(())
}

fn apply_text_attachment_updates(doc: &mut TmdDoc, updates: &[TextAttachmentUpdate]) -> Result<()> {
    ensure!(
        updates.len() <= MAX_TEXT_ATTACHMENT_EDITS,
        "a document update may replace at most {MAX_TEXT_ATTACHMENT_EDITS} text attachments"
    );
    let mut paths = HashSet::new();
    for update in updates {
        ensure!(
            paths.insert(update.logical_path.as_str()),
            "text attachment `{}` is updated more than once",
            update.logical_path
        );
        ensure!(
            update.text.len() <= MAX_TEXT_ATTACHMENT_BYTES,
            "text attachment `{}` exceeds the {MAX_TEXT_ATTACHMENT_BYTES}-byte limit",
            update.logical_path
        );
        let id = attachment_id_by_path(doc, &update.logical_path)?;
        let mut data = doc
            .attachments
            .data_mut(id)
            .ok_or_else(|| anyhow!("attachment `{}` has no data", update.logical_path))?;
        data.clear();
        data.extend_from_slice(update.text.as_bytes());
    }
    Ok(())
}

fn cmd_attachment_add(
    doc_path: &Path,
    source: &Path,
    logical_path: &str,
    mime: Option<&str>,
    title: Option<String>,
    alt: Option<String>,
) -> Result<()> {
    let bytes =
        fs::read(source).with_context(|| format!("failed to read `{}`", source.display()))?;
    let mime = match mime {
        Some(value) => value
            .parse()
            .with_context(|| format!("invalid MIME type `{value}`"))?,
        None => mime_guess::from_path(source).first_or_octet_stream(),
    };
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    let id = doc
        .add_attachment(logical_path, mime, bytes)
        .context("failed to add attachment")?;
    doc.update_attachment_metadata(id, title, alt)
        .context("failed to update attachment metadata")?;
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!("Added `{logical_path}` to `{}`", doc_path.display());
    Ok(())
}

fn cmd_attachment_remove(doc_path: &Path, logical_path: &str) -> Result<()> {
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    ensure_attachment_unreferenced(&doc, logical_path, "remove")?;
    let id = attachment_id_by_path(&doc, logical_path)?;
    if doc
        .manifest
        .cover_image
        .as_ref()
        .is_some_and(|cover| cover.id == id)
    {
        doc.manifest.cover_image = None;
    }
    doc.remove_attachment(id)
        .context("failed to remove attachment")?;
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!("Removed `{logical_path}` from `{}`", doc_path.display());
    Ok(())
}

fn cmd_attachment_rename(doc_path: &Path, from: &str, to: &str) -> Result<()> {
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    ensure_attachment_unreferenced(&doc, from, "rename")?;
    let id = attachment_id_by_path(&doc, from)?;
    doc.rename_attachment(id, to)
        .context("failed to rename attachment")?;
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!("Renamed `{from}` to `{to}` in `{}`", doc_path.display());
    Ok(())
}

fn ensure_attachment_unreferenced(doc: &TmdDoc, logical_path: &str, operation: &str) -> Result<()> {
    ensure!(
        !attachment_references(&doc.markdown)
            .iter()
            .any(|path| path == logical_path),
        "cannot {operation} attachment `{logical_path}` while Markdown references it; update the attach: destination first"
    );
    Ok(())
}

fn cmd_attachment_extract(doc_path: &Path, logical_path: &str, output: &Path) -> Result<()> {
    let doc = read_document(doc_path)?;
    let id = attachment_id_by_path(&doc, logical_path)?;
    let data = doc
        .attachments
        .data(id)
        .ok_or_else(|| anyhow!("attachment `{logical_path}` has no data"))?;
    ensure_parent_directory(output)?;
    write_new_file(output, |destination| {
        destination.write_all(data)?;
        destination.sync_all()
    })?;
    println!("Extracted `{logical_path}` to `{}`", output.display());
    Ok(())
}

fn write_new_file(
    output: &Path,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
) -> Result<()> {
    let mut destination = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .with_context(|| {
            format!(
                "failed to create new extraction target `{}`",
                output.display()
            )
        })?;
    let created_handle = Handle::from_file(
        destination
            .try_clone()
            .with_context(|| format!("failed to retain identity for `{}`", output.display()))?,
    )
    .with_context(|| format!("failed to identify new output `{}`", output.display()))?;
    if let Err(error) = write(&mut destination) {
        drop(destination);
        if let Err(cleanup_error) = remove_created_file_if_current(output, &created_handle) {
            return Err(anyhow!(
                "failed to write `{}`: {}; additionally failed to remove incomplete output: {}",
                output.display(),
                error,
                cleanup_error
            ));
        }
        return Err(error).with_context(|| format!("failed to write `{}`", output.display()));
    }
    Ok(())
}

fn remove_created_file_if_current(output: &Path, created_handle: &Handle) -> Result<()> {
    match Handle::from_path(output) {
        Ok(current_handle) if &current_handle == created_handle => fs::remove_file(output)
            .with_context(|| format!("failed to remove incomplete output `{}`", output.display())),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to identify incomplete output `{}`",
                output.display()
            )
        }),
    }
}

fn cmd_export_html(
    input: &Path,
    output: &Path,
    self_contained: bool,
    expected_output_state: Option<&ExpectedOutputState>,
) -> Result<()> {
    ensure_distinct_existing_paths(input, output, "HTML output")?;
    let doc = read_document(input)?;
    let validation = validate_document(&doc).context("failed to validate document")?;
    ensure!(
        validation.valid,
        "refusing to export an invalid document; run `tmd validate {}`",
        input.display()
    );

    ensure_parent_directory(output)?;
    let attachment_export = if self_contained || doc.attachments.is_empty() {
        AttachmentExport::Embedded(embedded_attachment_urls(&doc))
    } else {
        AttachmentExport::Staged(stage_extracted_attachment_urls(&doc, output)?)
    };
    let attachment_urls = attachment_export.urls();

    let body_html = render_markdown_body(&doc, &doc.markdown, attachment_urls)?;

    let title = doc
        .manifest
        .title
        .as_deref()
        .unwrap_or("Tanu Markdown Document");
    let attachment_section = render_attachment_listing(&doc, attachment_urls);
    let output_html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>
      body {{ font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.6; }}
      img {{ max-width: 100%; height: auto; }}
      pre {{ background: #f5f5f5; padding: 1rem; overflow-x: auto; }}
      code {{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }}
      table {{ border-collapse: collapse; }}
      th, td {{ border: 1px solid #ccc; padding: 0.25rem 0.5rem; }}
      .tmd-view-error {{ color: #b42318; border: 1px solid currentColor; padding: 0.25rem 0.5rem; }}
    </style>
  </head>
  <body>
    <article>{body}</article>
    {attachments}
  </body>
</html>
"#,
        title = encode_text(title),
        body = body_html,
        attachments = attachment_section,
    );
    let published_assets = attachment_export.publish()?;
    if let Err(error) =
        write_bytes_if_expected(output, output_html.as_bytes(), expected_output_state)
    {
        if let Some(directory) = published_assets {
            let directory_path = directory.path.clone();
            if let Err(cleanup_error) = directory.remove_if_current() {
                return Err(anyhow!(
                    "failed to write `{}`: {}; additionally failed to remove staged assets `{}`: {}",
                    output.display(),
                    error,
                    directory_path.display(),
                    cleanup_error
                ));
            }
        }
        return Err(error).with_context(|| format!("failed to write `{}`", output.display()));
    }
    println!(
        "Exported `{}` to HTML at `{}`",
        input.display(),
        output.display()
    );
    Ok(())
}

fn render_markdown_body(
    doc: &TmdDoc,
    markdown: &str,
    attachment_urls: &HashMap<String, AttachmentExportUrls>,
) -> Result<String> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    let mut parser = MdParser::new_ext(markdown, options);
    let mut output_events = Vec::new();
    let mut evaluated = HashMap::<String, std::result::Result<DataValue, String>>::new();
    let mut attachment_link_open = false;

    while let Some(event) = parser.next() {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                if info.starts_with("tmd-view:") =>
            {
                let mut body = String::new();
                for inner in parser.by_ref() {
                    match inner {
                        Event::End(TagEnd::CodeBlock) => break,
                        Event::Text(value) | Event::Code(value) => body.push_str(&value),
                        _ => {}
                    }
                }
                let rendered = match parse_data_view_block(&info, &body) {
                    Some(Ok(reference)) => render_block_data_view(doc, &reference, &mut evaluated),
                    Some(Err(error)) => render_view_error(&error.to_string(), true),
                    None => unreachable!("guard accepts only tmd-view fences"),
                };
                output_events.push(Event::Html(CowStr::from(rendered)));
            }
            Event::Text(text) => {
                append_inline_data_views(doc, text, &mut evaluated, &mut output_events)
            }
            other => output_events.push(rewrite_attachment_event(
                other,
                attachment_urls,
                &mut attachment_link_open,
            )),
        }
    }

    let mut body_html = String::new();
    html::push_html(&mut body_html, output_events.into_iter());
    Ok(body_html)
}

fn append_inline_data_views<'a>(
    doc: &TmdDoc,
    text: CowStr<'a>,
    evaluated: &mut HashMap<String, std::result::Result<DataValue, String>>,
    output: &mut Vec<Event<'a>>,
) {
    let text = text.to_string();
    let references = inline_data_view_references(&text);
    if references.is_empty() {
        output.push(Event::Text(CowStr::from(text)));
        return;
    }

    let mut cursor = 0;
    for reference in references {
        if reference.range.start > cursor {
            output.push(Event::Text(CowStr::from(
                text[cursor..reference.range.start].to_owned(),
            )));
        }
        let value = evaluated
            .entry(reference.source.clone())
            .or_insert_with(|| {
                evaluate_data_source(doc, &reference.source).map_err(|error| error.to_string())
            });
        match value {
            Ok(value) => match value.as_scalar() {
                Ok(value) => output.push(Event::Text(CowStr::from(value.display_text()))),
                Err(error) => output.push(Event::Html(CowStr::from(render_view_error(
                    &error.to_string(),
                    false,
                )))),
            },
            Err(error) => output.push(Event::Html(CowStr::from(render_view_error(error, false)))),
        }
        cursor = reference.range.end;
    }
    if cursor < text.len() {
        output.push(Event::Text(CowStr::from(text[cursor..].to_owned())));
    }
}

fn render_block_data_view(
    doc: &TmdDoc,
    reference: &tmd_core::DataViewReference,
    evaluated: &mut HashMap<String, std::result::Result<DataValue, String>>,
) -> String {
    let value = evaluated
        .entry(reference.source.clone())
        .or_insert_with(|| {
            evaluate_data_source(doc, &reference.source).map_err(|error| error.to_string())
        });
    let value = match value {
        Ok(value) => value,
        Err(error) => return render_view_error(error, true),
    };

    match reference.render {
        DataViewRenderKind::Scalar => match value.as_scalar() {
            Ok(value) => format!(
                "<p class=\"tmd-view-scalar\">{}</p>",
                encode_text(&value.display_text())
            ),
            Err(error) => render_view_error(&error.to_string(), true),
        },
        DataViewRenderKind::Table => match value.as_table() {
            Ok(table) => render_data_table(table),
            Err(error) => render_view_error(&error.to_string(), true),
        },
        DataViewRenderKind::List | DataViewRenderKind::Code => render_view_error(
            &format!(
                "data-view renderer `{:?}` is reserved but not implemented",
                reference.render
            )
            .to_ascii_lowercase(),
            true,
        ),
    }
}

fn render_data_table(table: &tmd_core::DataTable) -> String {
    let mut output = String::from("<table class=\"tmd-view-table\"><thead><tr>");
    for column in &table.columns {
        output.push_str("<th>");
        output.push_str(&encode_text(column));
        output.push_str("</th>");
    }
    output.push_str("</tr></thead><tbody>");
    for row in &table.rows {
        output.push_str("<tr>");
        for value in row {
            output.push_str("<td>");
            output.push_str(&encode_text(&value.display_text()));
            output.push_str("</td>");
        }
        output.push_str("</tr>");
    }
    output.push_str("</tbody></table>");
    output
}

fn render_view_error(message: &str, block: bool) -> String {
    let tag = if block { "div" } else { "span" };
    format!(
        "<{tag} class=\"tmd-view-error\">Data view error: {}</{tag}>",
        encode_text(message)
    )
}

fn cmd_db_init(doc_path: &Path, schema_path: Option<&Path>, version: Option<u32>) -> Result<()> {
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    let schema_sql = schema_path
        .map(|path| {
            fs::read_to_string(path)
                .with_context(|| format!("failed to read schema `{}`", path.display()))
        })
        .transpose()?;

    if let Some(sql) = schema_sql.as_deref() {
        let version = version.unwrap_or(0);
        reset_db(&mut doc, sql, version).context("failed to reset embedded database")?;
        doc.manifest.db_schema_version = Some(version);
    } else if let Some(version) = version {
        doc.db_with_conn_mut(|conn| -> rusqlite::Result<()> {
            conn.pragma_update(None, "user_version", version as i64)?;
            Ok(())
        })
        .context("failed to access embedded database")?
        .context("failed to update database version")?;
        doc.manifest.db_schema_version = Some(version);
    }
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!(
        "Initialised database for `{}` (schema version = {:?})",
        doc_path.display(),
        doc.manifest.db_schema_version
    );
    Ok(())
}

fn cmd_db_exec(doc_path: &Path, sql: &str) -> Result<()> {
    ensure!(!sql.trim().is_empty(), "SQL must not be empty");
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    let user_version = doc
        .db_with_conn_mut(|conn| -> Result<u32> {
            conn.execute_batch(sql)?;
            if !conn.is_autocommit() {
                conn.execute_batch("ROLLBACK")
                    .context("failed to roll back incomplete SQL transaction")?;
                return Err(anyhow!("SQL script left a transaction open"));
            }
            let user_version: i64 =
                conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            ensure!(
                (0..=i64::from(SQLITE_MAX_USER_VERSION)).contains(&user_version),
                "SQL script set unsupported user_version {user_version}"
            );
            Ok(user_version as u32)
        })
        .context("failed to access embedded database")?
        .context("failed to execute SQL against embedded database")?;
    doc.manifest.db_schema_version = Some(user_version);
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!("Executed SQL and updated `{}`", doc_path.display());
    Ok(())
}

fn cmd_db_query(doc_path: &Path, sql: &str, json_output: bool) -> Result<()> {
    ensure!(!sql.trim().is_empty(), "SQL must not be empty");
    let doc = read_document(doc_path)?;
    let stdout = io::stdout();
    let mut output = io::BufWriter::new(stdout.lock());
    doc.db_with_conn(|conn| stream_db_query(conn, sql, json_output, &mut output))
        .context("failed to access embedded database")?
        .context("query must contain exactly one read-only SQLite statement")?;
    output.flush().context("failed to flush query output")?;
    Ok(())
}

fn stream_db_query(
    conn: &rusqlite::Connection,
    sql: &str,
    json_output: bool,
    output: &mut impl Write,
) -> Result<()> {
    let mut statement = conn.prepare(sql)?;
    ensure!(statement.readonly(), "query statement must be read-only");
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(ToString::to_string)
        .collect();

    if json_output {
        write!(
            output,
            "{{\n  \"schema_version\": {JSON_SCHEMA_VERSION},\n  \"columns\": "
        )?;
        serde_json::to_writer(&mut *output, &columns)?;
        write!(output, ",\n  \"rows\": [")?;
    } else {
        writeln!(
            output,
            "| {} |",
            columns
                .iter()
                .map(|column| escape_table_cell(column))
                .collect::<Vec<_>>()
                .join(" | ")
        )?;
        writeln!(
            output,
            "|{}|",
            columns.iter().map(|_| "---").collect::<Vec<_>>().join("|")
        )?;
    }

    let mut first_json_row = true;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let mut values = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            let value: SqlValue = row.get(index)?;
            values.push(sql_value_json(&value));
        }
        if json_output {
            if first_json_row {
                write!(output, "\n    ")?;
                first_json_row = false;
            } else {
                write!(output, ",\n    ")?;
            }
            serde_json::to_writer(&mut *output, &values)?;
        } else {
            writeln!(
                output,
                "| {} |",
                values
                    .iter()
                    .map(display_table_value)
                    .collect::<Vec<_>>()
                    .join(" | ")
            )?;
        }
    }

    if json_output {
        if !first_json_row {
            write!(output, "\n  ")?;
        }
        writeln!(output, "]\n}}")?;
    }
    Ok(())
}

fn cmd_db_migrate(doc_path: &Path, from: u32, to: u32, sql: &str) -> Result<()> {
    ensure!(to > from, "migration target must be greater than source");
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    migrate(&mut doc, sql, from, to).context("failed to migrate embedded database")?;
    doc.manifest.db_schema_version = Some(to);
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!(
        "Migrated `{}` from schema version {} to {}",
        doc_path.display(),
        from,
        to
    );
    Ok(())
}

fn cmd_db_import(doc_path: &Path, source: &Path) -> Result<()> {
    let (mut doc, expected) = read_document_for_update(doc_path)?;
    import_db(&mut doc, source).context("failed to import SQLite database")?;
    let user_version = database_user_version(&doc)?;
    doc.manifest.db_schema_version = Some(user_version);
    doc.touch();
    write_document_if_expected(doc_path, &doc, Some(&expected))?;
    println!(
        "Imported database from `{}` into `{}` (user_version = {})",
        source.display(),
        doc_path.display(),
        user_version
    );
    Ok(())
}

fn cmd_db_export(doc_path: &Path, output: &Path) -> Result<()> {
    ensure_distinct_existing_paths(doc_path, output, "database export")?;
    let doc = read_document(doc_path)?;
    ensure_parent_directory(output)?;
    export_db(&doc, output).context("failed to export embedded database")?;
    println!(
        "Exported embedded database from `{}` to `{}`",
        doc_path.display(),
        output.display()
    );
    Ok(())
}

fn inspection_value(doc: &TmdDoc) -> Result<JsonValue> {
    Ok(json!({
        "schema_version": JSON_SCHEMA_VERSION,
        "format": "tmd",
        "markdown": doc.markdown,
        "manifest": doc.manifest,
        "attachments": sorted_attachment_values(doc)?,
        "database_user_version": database_user_version(doc)?,
        "database": database_inspection(doc)?,
        "validation": validate_document(doc)?,
    }))
}

fn sorted_attachment_values(doc: &TmdDoc) -> Result<Vec<JsonValue>> {
    let mut attachments: Vec<&AttachmentMeta> = doc.list_attachments().collect();
    attachments.sort_by(|left, right| left.logical_path.cmp(&right.logical_path));
    attachments
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .context("failed to serialize attachment metadata")
}

fn attachment_id_by_path(doc: &TmdDoc, logical_path: &str) -> Result<tmd_core::AttachmentId> {
    doc.attachment_meta_by_path(logical_path)
        .map(|meta| meta.id)
        .ok_or_else(|| anyhow!("attachment `{logical_path}` does not exist"))
}

fn database_user_version(doc: &TmdDoc) -> Result<u32> {
    doc.db_with_conn(|conn| {
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
    })
    .context("failed to access embedded database")?
    .context("failed to read PRAGMA user_version")
}

fn database_inspection(doc: &TmdDoc) -> Result<JsonValue> {
    doc.db_with_conn(|conn| -> rusqlite::Result<JsonValue> {
        let user_version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let mut statement = conn.prepare(
            "SELECT type, name, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name",
        )?;
        let objects = statement
            .query_map([], |row| {
                Ok(json!({
                    "type": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "sql": row.get::<_, Option<String>>(2)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({
            "user_version": user_version,
            "objects": objects,
        }))
    })
    .context("failed to access embedded database")?
    .context("failed to inspect embedded database")
}

fn read_document(path: &Path) -> Result<TmdDoc> {
    let (doc, _) = read_document_snapshot(path)?;
    Ok(doc)
}

fn read_document_snapshot(path: &Path) -> Result<(TmdDoc, Vec<u8>)> {
    ensure_tmd_path(path)?;
    let bytes = fs::read(path).with_context(|| format!("failed to read `{}`", path.display()))?;
    let mut cursor = Cursor::new(bytes.as_slice());
    let doc = read_tmd(&mut cursor, ReadMode::default())
        .with_context(|| format!("failed to parse `{}`", path.display()))?;
    Ok((doc, bytes))
}

fn read_document_for_update(path: &Path) -> Result<(TmdDoc, ExpectedOutputState)> {
    let (doc, bytes) = read_document_snapshot(path)?;
    let digest = Sha256::digest(&bytes).into();
    Ok((doc, ExpectedOutputState::Sha256(digest)))
}

fn write_document_if_expected(
    path: &Path,
    doc: &TmdDoc,
    expected: Option<&ExpectedOutputState>,
) -> Result<()> {
    write_output_if_expected(path, expected, || {
        write_to_path(path, doc)
            .with_context(|| format!("failed to atomically write `{}`", path.display()))
    })
}

fn write_bytes_if_expected(
    path: &Path,
    bytes: &[u8],
    expected: Option<&ExpectedOutputState>,
) -> Result<()> {
    write_output_if_expected(path, expected, || {
        write_bytes_to_path(path, bytes)
            .with_context(|| format!("failed to atomically write `{}`", path.display()))
    })
}

fn write_output_if_expected(
    path: &Path,
    expected: Option<&ExpectedOutputState>,
    write: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let mut locked = lock_document_output(path, expected)?;
    let write_result = (|| {
        verify_expected_output(&mut locked, path, expected)?;
        write()
    })();
    let cleanup_result = if write_result.is_err() {
        locked.remove_placeholder_if_current(path)
    } else {
        Ok(())
    };
    let unlock_result = locked
        .file
        .unlock()
        .with_context(|| format!("failed to unlock `{}`", path.display()));
    write_result?;
    cleanup_result?;
    unlock_result
}

struct LockedOutput {
    file: File,
    placeholder_created: bool,
}

impl LockedOutput {
    fn remove_placeholder_if_current(&self, path: &Path) -> Result<()> {
        if self.placeholder_created && locked_file_is_current(&self.file, path).unwrap_or(false) {
            fs::remove_file(path).with_context(|| {
                format!("failed to remove output placeholder `{}`", path.display())
            })?;
        }
        Ok(())
    }
}

fn lock_document_output(
    path: &Path,
    expected: Option<&ExpectedOutputState>,
) -> Result<LockedOutput> {
    const MAX_LOCK_ATTEMPTS: usize = 8;

    for _ in 0..MAX_LOCK_ATTEMPTS {
        let open_result = OpenOptions::new().read(true).write(true).open(path);
        match open_result {
            Ok(file) => {
                if expected == Some(&ExpectedOutputState::Missing) {
                    return Err(output_conflict(path));
                }
                file.lock()
                    .with_context(|| format!("failed to lock `{}`", path.display()))?;
                if locked_file_is_current(&file, path).unwrap_or(false) {
                    return Ok(LockedOutput {
                        file,
                        placeholder_created: false,
                    });
                }
                file.unlock()
                    .with_context(|| format!("failed to unlock stale `{}`", path.display()))?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if matches!(expected, Some(ExpectedOutputState::Sha256(_))) {
                    return Err(output_conflict(path));
                }
                match OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(path)
                {
                    Ok(file) => {
                        file.lock().with_context(|| {
                            format!("failed to lock new output `{}`", path.display())
                        })?;
                        return Ok(LockedOutput {
                            file,
                            placeholder_created: true,
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!("failed to create output placeholder `{}`", path.display())
                        });
                    }
                }
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to open output `{}`", path.display()));
            }
        }
    }
    Err(anyhow!(
        "output `{}` kept changing while it was being locked",
        path.display()
    ))
}

fn locked_file_is_current(file: &File, path: &Path) -> io::Result<bool> {
    Ok(Handle::from_file(file.try_clone()?)? == Handle::from_path(path)?)
}

fn verify_expected_output(
    locked: &mut LockedOutput,
    path: &Path,
    expected: Option<&ExpectedOutputState>,
) -> Result<()> {
    match expected {
        None => Ok(()),
        Some(ExpectedOutputState::Missing) if locked.placeholder_created => Ok(()),
        Some(ExpectedOutputState::Missing) => Err(output_conflict(path)),
        Some(ExpectedOutputState::Sha256(expected_digest)) if !locked.placeholder_created => {
            let actual_digest = sha256_file(&mut locked.file)
                .with_context(|| format!("failed to hash locked output `{}`", path.display()))?;
            if &actual_digest == expected_digest {
                Ok(())
            } else {
                Err(output_conflict(path))
            }
        }
        Some(ExpectedOutputState::Sha256(_)) => Err(output_conflict(path)),
    }
}

fn sha256_file(file: &mut File) -> io::Result<[u8; 32]> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn output_conflict(path: &Path) -> anyhow::Error {
    anyhow!(
        "output `{}` changed after it was opened; refusing to overwrite external changes",
        path.display()
    )
}

fn ensure_tmd_path(path: &Path) -> Result<()> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("tmd") => Ok(()),
        _ => Err(anyhow!(
            "unsupported path `{}` — expected extension .tmd",
            path.display()
        )),
    }
}

fn parse_sqlite_user_version(value: &str) -> std::result::Result<u32, String> {
    let version = value
        .parse::<u32>()
        .map_err(|error| format!("invalid SQLite schema version `{value}`: {error}"))?;
    if version > SQLITE_MAX_USER_VERSION {
        return Err(format!(
            "SQLite schema version must not exceed {SQLITE_MAX_USER_VERSION}"
        ));
    }
    Ok(version)
}

fn parse_expected_output_state(value: &str) -> std::result::Result<ExpectedOutputState, String> {
    if value == "missing" {
        return Ok(ExpectedOutputState::Missing);
    }
    let bytes = hex::decode(value)
        .map_err(|error| format!("invalid expected output SHA-256 `{value}`: {error}"))?;
    let digest: [u8; 32] = bytes.try_into().map_err(|bytes: Vec<u8>| {
        format!(
            "invalid expected output SHA-256 length {}; expected 64 hexadecimal characters",
            bytes.len() * 2
        )
    })?;
    Ok(ExpectedOutputState::Sha256(digest))
}

fn ensure_parent_directory(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory `{}`", parent.display()))?;
        }
    }
    Ok(())
}

fn ensure_distinct_existing_paths(input: &Path, output: &Path, output_kind: &str) -> Result<()> {
    match fs::metadata(output) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect `{}`", output.display()));
        }
    }
    let same_path = same_file::is_same_file(input, output).with_context(|| {
        format!(
            "failed to compare `{}` and `{}`",
            input.display(),
            output.display()
        )
    })?;

    ensure!(
        !same_path,
        "refusing to overwrite input document `{}` with {output_kind}",
        input.display(),
    );
    Ok(())
}

#[derive(Clone, Debug)]
struct AttachmentExportUrls {
    inline_url: String,
    download_url: String,
}

enum AttachmentExport {
    Embedded(HashMap<String, AttachmentExportUrls>),
    Staged(StagedAttachmentExport),
}

impl AttachmentExport {
    fn urls(&self) -> &HashMap<String, AttachmentExportUrls> {
        match self {
            Self::Embedded(urls) => urls,
            Self::Staged(export) => &export.urls,
        }
    }

    fn publish(self) -> Result<Option<PublishedAttachmentExport>> {
        match self {
            Self::Embedded(_) => Ok(None),
            Self::Staged(export) => export.publish().map(Some),
        }
    }
}

struct StagedAttachmentExport {
    urls: HashMap<String, AttachmentExportUrls>,
    staging_directory: tempfile::TempDir,
    final_directory: PathBuf,
}

impl StagedAttachmentExport {
    fn publish(self) -> Result<PublishedAttachmentExport> {
        let handle = Handle::from_path(self.staging_directory.path()).with_context(|| {
            format!(
                "failed to identify staged attachment directory `{}`",
                self.staging_directory.path().display()
            )
        })?;
        fs::rename(self.staging_directory.path(), &self.final_directory).with_context(|| {
            format!(
                "refusing to overwrite attachment directory `{}`; remove or rename it first",
                self.final_directory.display()
            )
        })?;
        Ok(PublishedAttachmentExport {
            path: self.final_directory,
            handle,
        })
    }
}

struct PublishedAttachmentExport {
    path: PathBuf,
    handle: Handle,
}

impl PublishedAttachmentExport {
    fn remove_if_current(self) -> Result<()> {
        match Handle::from_path(&self.path) {
            Ok(current) if current == self.handle => {
                fs::remove_dir_all(&self.path).with_context(|| {
                    format!(
                        "failed to remove published attachment directory `{}`",
                        self.path.display()
                    )
                })
            }
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| {
                format!(
                    "failed to identify published attachment directory `{}`",
                    self.path.display()
                )
            }),
        }
    }
}

fn embedded_attachment_urls(doc: &TmdDoc) -> HashMap<String, AttachmentExportUrls> {
    doc.attachments
        .iter_with_data()
        .map(|(meta, data)| {
            let url = format!(
                "data:{};base64,{}",
                safe_embedded_mime(meta.mime.as_ref()),
                BASE64_STANDARD.encode(data)
            );
            (
                meta.logical_path.clone(),
                AttachmentExportUrls {
                    inline_url: url.clone(),
                    download_url: url,
                },
            )
        })
        .collect()
}

fn safe_embedded_mime(mime: &str) -> &'static str {
    passive_attachment_mime(mime).unwrap_or("application/octet-stream")
}

fn passive_attachment_mime(mime: &str) -> Option<&'static str> {
    match mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/avif" => Some("image/avif"),
        "image/bmp" => Some("image/bmp"),
        "image/gif" => Some("image/gif"),
        "image/jpeg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        "text/plain" => Some("text/plain"),
        _ => None,
    }
}

fn stage_extracted_attachment_urls(doc: &TmdDoc, output: &Path) -> Result<StagedAttachmentExport> {
    let output_stem = output
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("document");
    let directory_name = format!("{output_stem}_assets");
    let final_directory = output
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&directory_name);
    if let Err(error) = fs::symlink_metadata(&final_directory) {
        ensure!(
            error.kind() == io::ErrorKind::NotFound,
            "failed to inspect attachment directory `{}`: {error}",
            final_directory.display()
        );
    } else {
        return Err(anyhow!(
            "refusing to overwrite attachment directory `{}`; remove or rename it first",
            final_directory.display()
        ));
    }
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staging_directory = tempfile::Builder::new()
        .prefix(".tmd-assets-")
        .tempdir_in(parent)
        .with_context(|| {
            format!(
                "failed to stage attachment directory in `{}`",
                parent.display()
            )
        })?;
    let mut urls = HashMap::new();

    for (meta, data) in doc.attachments.iter_with_data() {
        let file_name = format!(
            "{}{}",
            meta.id,
            exported_asset_extension(meta.mime.as_ref())
        );
        let destination = staging_directory.path().join(&file_name);
        fs::write(&destination, data)
            .with_context(|| format!("failed to write `{}`", destination.display()))?;
        let download_url = format!(
            "{}/{}",
            utf8_percent_encode(&directory_name, URL_SEGMENT_ENCODE_SET),
            file_name
        );
        let inline_url = if passive_attachment_mime(meta.mime.as_ref()).is_some() {
            download_url.clone()
        } else {
            "#".to_owned()
        };
        urls.insert(
            meta.logical_path.clone(),
            AttachmentExportUrls {
                inline_url,
                download_url,
            },
        );
    }
    Ok(StagedAttachmentExport {
        urls,
        staging_directory,
        final_directory,
    })
}

fn exported_asset_extension(mime: &str) -> &'static str {
    match passive_attachment_mime(mime) {
        Some("image/avif") => ".avif",
        Some("image/bmp") => ".bmp",
        Some("image/gif") => ".gif",
        Some("image/jpeg") => ".jpg",
        Some("image/png") => ".png",
        Some("image/webp") => ".webp",
        Some("text/plain") => ".txt",
        _ => ".bin",
    }
}

fn rewrite_attachment_event<'a>(
    event: Event<'a>,
    attachment_urls: &HashMap<String, AttachmentExportUrls>,
    attachment_link_open: &mut bool,
) -> Event<'a> {
    match event {
        Event::Html(source) | Event::InlineHtml(source) => Event::Text(source),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            if let Some(path) = dest_url.strip_prefix("attach:") {
                *attachment_link_open = true;
                let href = attachment_urls
                    .get(path)
                    .map(|urls| urls.download_url.as_str())
                    .unwrap_or("#");
                let title_attribute = if title.is_empty() {
                    String::new()
                } else {
                    format!(
                        " title=\"{}\"",
                        encode_double_quoted_attribute(title.as_ref())
                    )
                };
                Event::Html(CowStr::from(format!(
                    "<a download href=\"{}\"{}>",
                    encode_double_quoted_attribute(href),
                    title_attribute
                )))
            } else {
                Event::Start(Tag::Link {
                    link_type,
                    dest_url: rewritten_destination(dest_url, attachment_urls),
                    title,
                    id,
                })
            }
        }
        Event::End(TagEnd::Link) if *attachment_link_open => {
            *attachment_link_open = false;
            Event::Html(CowStr::from("</a>"))
        }
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: rewritten_destination(dest_url, attachment_urls),
            title,
            id,
        }),
        other => other,
    }
}

fn rewritten_destination<'a>(
    destination: CowStr<'a>,
    attachment_urls: &HashMap<String, AttachmentExportUrls>,
) -> CowStr<'a> {
    if let Some(path) = destination.strip_prefix("attach:") {
        return attachment_urls
            .get(path)
            .map(|urls| urls.inline_url.clone())
            .map(CowStr::from)
            .unwrap_or_else(|| CowStr::from("#"));
    }
    if is_safe_export_destination(destination.as_ref()) {
        destination
    } else {
        CowStr::from("#")
    }
}

fn is_safe_export_destination(destination: &str) -> bool {
    let destination = destination.trim();
    if destination
        .as_bytes()
        .get(..2)
        .is_some_and(|prefix| prefix.iter().all(|byte| matches!(byte, b'/' | b'\\')))
    {
        return false;
    }
    if destination
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte == b' ')
    {
        return false;
    }

    let scheme_end = destination
        .bytes()
        .position(|byte| matches!(byte, b':' | b'/' | b'?' | b'#'));
    match scheme_end.and_then(|index| destination.as_bytes().get(index).map(|byte| (index, *byte)))
    {
        Some((index, b':')) => matches!(
            destination[..index].to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto" | "tel"
        ),
        _ => true,
    }
}

fn render_attachment_listing(
    doc: &TmdDoc,
    attachment_urls: &HashMap<String, AttachmentExportUrls>,
) -> String {
    let mut metadata: Vec<_> = doc.list_attachments().collect();
    if metadata.is_empty() {
        return String::new();
    }
    metadata.sort_by(|left, right| left.logical_path.cmp(&right.logical_path));

    let mut output = String::from("<section><h2>Attachments</h2><ul>\n");
    for meta in metadata {
        let href = attachment_urls
            .get(&meta.logical_path)
            .map(|urls| urls.download_url.as_str())
            .unwrap_or("#");
        output.push_str(&format!(
            "  <li><a download href=\"{}\">{}</a> ({} bytes, {})</li>\n",
            encode_double_quoted_attribute(href),
            encode_text(&meta.logical_path),
            meta.length,
            encode_text(meta.mime.as_ref())
        ));
    }
    output.push_str("</ul></section>");
    output
}

fn sql_value_json(value: &SqlValue) -> JsonValue {
    match value {
        SqlValue::Null => JsonValue::Null,
        SqlValue::Integer(value) => json!(value),
        SqlValue::Real(value) if value.is_finite() => json!(value),
        SqlValue::Real(value) => json!({
            "real": if value.is_nan() {
                "NaN"
            } else if value.is_sign_positive() {
                "Infinity"
            } else {
                "-Infinity"
            }
        }),
        SqlValue::Text(value) => json!(value),
        SqlValue::Blob(value) => json!({ "base64": BASE64_STANDARD.encode(value) }),
    }
}

fn display_json_value(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "NULL".to_owned(),
        JsonValue::String(value) => value.clone(),
        JsonValue::Object(value) if value.len() == 1 && value.contains_key("real") => value["real"]
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| JsonValue::Object(value.clone()).to_string()),
        other => other.to_string(),
    }
}

fn display_table_value(value: &JsonValue) -> String {
    escape_table_cell(&display_json_value(value))
}

fn escape_table_cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_file_write_failures_remove_partial_output() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let output = directory.path().join("partial.bin");

        let error = write_new_file(&output, |destination| {
            destination.write_all(b"partial")?;
            Err(io::Error::other("injected write failure"))
        })
        .expect_err("injected write failure must be reported");

        assert!(error.to_string().contains("failed to write"));
        assert!(!output.exists(), "partial output must be removed");
    }

    #[cfg(unix)]
    #[test]
    fn new_file_write_failures_preserve_replacement_output() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let output = directory.path().join("partial.bin");
        let displaced = directory.path().join("displaced.bin");

        let error = write_new_file(&output, |destination| {
            destination.write_all(b"partial")?;
            fs::rename(&output, &displaced)?;
            fs::write(&output, b"external replacement")?;
            Err(io::Error::other("injected write failure"))
        })
        .expect_err("injected write failure must be reported");

        assert!(error.to_string().contains("failed to write"));
        assert_eq!(
            fs::read(&output).expect("replacement output"),
            b"external replacement"
        );
        assert_eq!(fs::read(&displaced).expect("partial output"), b"partial");
    }

    #[test]
    fn stale_document_mutations_cannot_replace_newer_contents() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let output = directory.path().join("document.tmd");
        let original = TmdDoc::new("original".to_owned()).expect("original document");
        write_to_path(&output, &original).expect("write original");
        let (mut stale, expected) =
            read_document_for_update(&output).expect("read mutation snapshot");

        let external = TmdDoc::new("external".to_owned()).expect("external document");
        write_to_path(&output, &external).expect("write external replacement");
        stale.markdown = "stale mutation".to_owned();

        let error = write_document_if_expected(&output, &stale, Some(&expected))
            .expect_err("stale mutation must be rejected");

        assert!(error
            .to_string()
            .contains("refusing to overwrite external changes"));
        assert_eq!(
            read_document(&output).expect("preserved document").markdown,
            "external"
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_output_rejects_multiply_linked_destinations() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let output = directory.path().join("export.html");
        let alias = directory.path().join("export-alias.html");
        fs::write(&output, b"shared export").expect("existing output");
        fs::hard_link(&output, &alias).expect("hard-linked alias");

        let error = write_bytes_to_path(&output, b"replacement")
            .expect_err("hard-linked output must be rejected");

        assert!(error.to_string().contains("hard links"));
        assert_eq!(
            fs::read(&output).expect("preserved output"),
            b"shared export"
        );
        assert_eq!(fs::read(&alias).expect("preserved alias"), b"shared export");
    }

    #[cfg(unix)]
    #[test]
    fn asset_cleanup_preserves_replacement_directory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let published_path = directory.path().join("document_assets");
        let displaced_path = directory.path().join("displaced_assets");
        fs::create_dir(&published_path).expect("published directory");
        fs::write(published_path.join("original.bin"), b"original").expect("published asset");
        let published = PublishedAttachmentExport {
            handle: Handle::from_path(&published_path).expect("published identity"),
            path: published_path.clone(),
        };
        fs::rename(&published_path, &displaced_path).expect("displace published directory");
        fs::create_dir(&published_path).expect("replacement directory");
        fs::write(published_path.join("external.bin"), b"external").expect("replacement asset");

        published
            .remove_if_current()
            .expect("replacement must be preserved");

        assert_eq!(
            fs::read(published_path.join("external.bin")).expect("replacement asset"),
            b"external"
        );
        assert_eq!(
            fs::read(displaced_path.join("original.bin")).expect("original asset"),
            b"original"
        );
    }
}
