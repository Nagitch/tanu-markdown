//! Tanu Markdown command-line interface.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, ensure, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Parser, Subcommand};
use html_escape::{encode_double_quoted_attribute, encode_text};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{html, CowStr, Event, Options, Parser as MdParser, Tag};
use rusqlite::types::Value as SqlValue;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tmd_core::{
    export_db, import_db, migrate, read_from_path, reset_db, validate_document, write_to_path,
    AttachmentMeta, Format, TmdDoc, ValidationSeverity,
};

const JSON_SCHEMA_VERSION: u32 = 1;
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
    /// Create a new `.tmd` or `.tmdp` document.
    New {
        output: PathBuf,
        #[arg(long)]
        title: Option<String>,
    },
    /// Convert between `.tmd` and `.tmdp` containers.
    Convert { input: PathBuf, output: PathBuf },
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
        #[arg(long)]
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
        #[arg(long)]
        from: u32,
        #[arg(long)]
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
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::New { output, title } => cmd_new(&output, title.as_deref()),
        Commands::Convert { input, output } => cmd_convert(&input, &output),
        Commands::Validate { input, json } => cmd_validate(&input, json),
        Commands::Inspect { input, json } => cmd_inspect(&input, json),
        Commands::Update { input, json_stdin } => cmd_update(&input, json_stdin),
        Commands::Attachment { command } => match command {
            AttachmentCommands::List { doc, json } => cmd_attachment_list(&doc, json),
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
        } => cmd_export_html(&input, &output, self_contained),
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

    let format = detect_format(path)?;
    let display_title = title.unwrap_or("New TMD Document");
    let markdown =
        format!("# {display_title}\n\nWelcome to **Tanu Markdown**!\n\nThe embedded database is ready for use.\n");
    let mut doc = TmdDoc::new(markdown).context("failed to create document")?;
    doc.manifest.title = Some(display_title.to_owned());
    doc.touch();

    write_document(path, &doc, format)?;
    println!(
        "Created new {} document at {}",
        format_display(format),
        path.display()
    );
    Ok(())
}

fn cmd_convert(input: &Path, output: &Path) -> Result<()> {
    let (doc, _) = read_document(input)?;
    let format = detect_format(output)?;
    ensure_parent_directory(output)?;
    write_document(output, &doc, format)?;
    println!(
        "Converted `{}` into `{}`",
        input.display(),
        output.display()
    );
    Ok(())
}

fn cmd_validate(input: &Path, json_output: bool) -> Result<()> {
    let (doc, _) = match read_document(input) {
        Ok(result) => result,
        Err(error) => {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "schema_version": JSON_SCHEMA_VERSION,
                        "valid": false,
                        "issues": [{
                            "severity": "error",
                            "code": "container_read_failed",
                            "message": format!("{error:#}"),
                        }],
                        "attachment_references": [],
                        "database_user_version": null,
                    }))?
                );
            }
            return Err(error);
        }
    };
    let report = validate_document(&doc).context("failed to validate document")?;

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

fn cmd_inspect(input: &Path, json_output: bool) -> Result<()> {
    let (doc, format) = read_document(input)?;
    let value = inspection_value(&doc, format)?;
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

    let (mut doc, format) = read_document(input)?;
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
    doc.touch();
    write_document(input, &doc, format)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&inspection_value(&doc, format)?)?
    );
    Ok(())
}

fn cmd_attachment_list(doc_path: &Path, json_output: bool) -> Result<()> {
    let (doc, _) = read_document(doc_path)?;
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
    let (mut doc, format) = read_document(doc_path)?;
    let id = doc
        .add_attachment(logical_path, mime, bytes)
        .context("failed to add attachment")?;
    doc.update_attachment_metadata(id, title, alt)
        .context("failed to update attachment metadata")?;
    doc.touch();
    write_document(doc_path, &doc, format)?;
    println!("Added `{logical_path}` to `{}`", doc_path.display());
    Ok(())
}

fn cmd_attachment_remove(doc_path: &Path, logical_path: &str) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
    let id = attachment_id_by_path(&doc, logical_path)?;
    doc.remove_attachment(id)
        .context("failed to remove attachment")?;
    doc.touch();
    write_document(doc_path, &doc, format)?;
    println!("Removed `{logical_path}` from `{}`", doc_path.display());
    Ok(())
}

fn cmd_attachment_rename(doc_path: &Path, from: &str, to: &str) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
    let id = attachment_id_by_path(&doc, from)?;
    doc.rename_attachment(id, to)
        .context("failed to rename attachment")?;
    doc.touch();
    write_document(doc_path, &doc, format)?;
    println!("Renamed `{from}` to `{to}` in `{}`", doc_path.display());
    Ok(())
}

fn cmd_attachment_extract(doc_path: &Path, logical_path: &str, output: &Path) -> Result<()> {
    ensure!(
        !output.exists(),
        "target `{}` already exists",
        output.display()
    );
    let (doc, _) = read_document(doc_path)?;
    let id = attachment_id_by_path(&doc, logical_path)?;
    let data = doc
        .attachments
        .data(id)
        .ok_or_else(|| anyhow!("attachment `{logical_path}` has no data"))?;
    ensure_parent_directory(output)?;
    fs::write(output, data).with_context(|| format!("failed to write `{}`", output.display()))?;
    println!("Extracted `{logical_path}` to `{}`", output.display());
    Ok(())
}

fn cmd_export_html(input: &Path, output: &Path, self_contained: bool) -> Result<()> {
    let (doc, _) = read_document(input)?;
    let validation = validate_document(&doc).context("failed to validate document")?;
    ensure!(
        validation.valid,
        "refusing to export an invalid document; run `tmd validate {}`",
        input.display()
    );

    ensure_parent_directory(output)?;
    let attachment_urls = if self_contained {
        embedded_attachment_urls(&doc)
    } else {
        extracted_attachment_urls(&doc, output)?
    };

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = MdParser::new_ext(&doc.markdown, options)
        .map(|event| rewrite_attachment_event(event, &attachment_urls));
    let mut body_html = String::new();
    html::push_html(&mut body_html, parser);

    let title = doc
        .manifest
        .title
        .as_deref()
        .unwrap_or("Tanu Markdown Document");
    let attachment_section = render_attachment_listing(&doc, &attachment_urls);
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
    fs::write(output, output_html)
        .with_context(|| format!("failed to write `{}`", output.display()))?;
    println!(
        "Exported `{}` to HTML at `{}`",
        input.display(),
        output.display()
    );
    Ok(())
}

fn cmd_db_init(doc_path: &Path, schema_path: Option<&Path>, version: Option<u32>) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
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
    write_document(doc_path, &doc, format)?;
    println!(
        "Initialised database for `{}` (schema version = {:?})",
        doc_path.display(),
        doc.manifest.db_schema_version
    );
    Ok(())
}

fn cmd_db_exec(doc_path: &Path, sql: &str) -> Result<()> {
    ensure!(!sql.trim().is_empty(), "SQL must not be empty");
    let (mut doc, format) = read_document(doc_path)?;
    doc.db_with_conn_mut(|conn| conn.execute_batch(sql))
        .context("failed to access embedded database")?
        .context("failed to execute SQL against embedded database")?;
    doc.touch();
    write_document(doc_path, &doc, format)?;
    println!("Executed SQL and updated `{}`", doc_path.display());
    Ok(())
}

fn cmd_db_query(doc_path: &Path, sql: &str, json_output: bool) -> Result<()> {
    ensure!(!sql.trim().is_empty(), "SQL must not be empty");
    let (doc, _) = read_document(doc_path)?;
    let result = doc
        .db_with_conn(|conn| -> rusqlite::Result<JsonValue> {
            let mut statement = conn.prepare(sql)?;
            if !statement.readonly() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let columns: Vec<String> = statement
                .column_names()
                .iter()
                .map(ToString::to_string)
                .collect();
            let mut rows_json = Vec::new();
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(columns.len());
                for index in 0..columns.len() {
                    let value: SqlValue = row.get(index)?;
                    values.push(sql_value_json(&value));
                }
                rows_json.push(JsonValue::Array(values));
            }
            Ok(json!({
                "schema_version": JSON_SCHEMA_VERSION,
                "columns": columns,
                "rows": rows_json,
            }))
        })
        .context("failed to access embedded database")?
        .context("query must contain exactly one read-only SQLite statement")?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        let columns = result["columns"]
            .as_array()
            .expect("query columns are an array");
        println!(
            "| {} |",
            columns
                .iter()
                .map(|entry| entry.as_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" | ")
        );
        println!(
            "|{}|",
            columns.iter().map(|_| "---").collect::<Vec<_>>().join("|")
        );
        for row in result["rows"].as_array().expect("query rows are an array") {
            println!(
                "| {} |",
                row.as_array()
                    .expect("query row is an array")
                    .iter()
                    .map(display_json_value)
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
        }
    }
    Ok(())
}

fn cmd_db_migrate(doc_path: &Path, from: u32, to: u32, sql: &str) -> Result<()> {
    ensure!(to > from, "migration target must be greater than source");
    let (mut doc, format) = read_document(doc_path)?;
    migrate(&mut doc, sql, from, to).context("failed to migrate embedded database")?;
    doc.manifest.db_schema_version = Some(to);
    doc.touch();
    write_document(doc_path, &doc, format)?;
    println!(
        "Migrated `{}` from schema version {} to {}",
        doc_path.display(),
        from,
        to
    );
    Ok(())
}

fn cmd_db_import(doc_path: &Path, source: &Path) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
    import_db(&mut doc, source).context("failed to import SQLite database")?;
    let user_version = database_user_version(&doc)?;
    doc.manifest.db_schema_version = Some(user_version);
    doc.touch();
    write_document(doc_path, &doc, format)?;
    println!(
        "Imported database from `{}` into `{}` (user_version = {})",
        source.display(),
        doc_path.display(),
        user_version
    );
    Ok(())
}

fn cmd_db_export(doc_path: &Path, output: &Path) -> Result<()> {
    let (doc, _) = read_document(doc_path)?;
    ensure_parent_directory(output)?;
    export_db(&doc, output).context("failed to export embedded database")?;
    println!(
        "Exported embedded database from `{}` to `{}`",
        doc_path.display(),
        output.display()
    );
    Ok(())
}

fn inspection_value(doc: &TmdDoc, format: Format) -> Result<JsonValue> {
    Ok(json!({
        "schema_version": JSON_SCHEMA_VERSION,
        "format": format_name(format),
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

fn read_document(path: &Path) -> Result<(TmdDoc, Format)> {
    let format = detect_format(path)?;
    let doc = read_from_path(path, Some(format))
        .with_context(|| format!("failed to read `{}`", path.display()))?;
    Ok((doc, format))
}

fn write_document(path: &Path, doc: &TmdDoc, format: Format) -> Result<()> {
    write_to_path(path, doc, format)
        .with_context(|| format!("failed to atomically write `{}`", path.display()))
}

fn detect_format(path: &Path) -> Result<Format> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("tmd") => Ok(Format::Tmd),
        Some("tmdp") => Ok(Format::Tmdp),
        _ => Err(anyhow!(
            "unsupported path `{}` — expected extension .tmd or .tmdp",
            path.display()
        )),
    }
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

fn embedded_attachment_urls(doc: &TmdDoc) -> HashMap<String, String> {
    doc.attachments
        .iter_with_data()
        .map(|(meta, data)| {
            (
                meta.logical_path.clone(),
                format!("data:{};base64,{}", meta.mime, BASE64_STANDARD.encode(data)),
            )
        })
        .collect()
}

fn extracted_attachment_urls(doc: &TmdDoc, output: &Path) -> Result<HashMap<String, String>> {
    let output_stem = output
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("document");
    let directory_name = format!("{output_stem}_assets");
    let directory = output
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&directory_name);
    let mut urls = HashMap::new();

    if !doc.attachments.is_empty() {
        fs::create_dir(&directory).with_context(|| {
            format!(
                "refusing to overwrite attachment directory `{}`; remove or rename it first",
                directory.display()
            )
        })?;
    }
    for (meta, data) in doc.attachments.iter_with_data() {
        let destination = directory.join(&meta.logical_path);
        ensure_parent_directory(&destination)?;
        fs::write(&destination, data)
            .with_context(|| format!("failed to write `{}`", destination.display()))?;
        let encoded_path = meta
            .logical_path
            .split('/')
            .map(|segment| utf8_percent_encode(segment, URL_SEGMENT_ENCODE_SET).to_string())
            .collect::<Vec<_>>()
            .join("/");
        urls.insert(
            meta.logical_path.clone(),
            format!(
                "{}/{}",
                utf8_percent_encode(&directory_name, URL_SEGMENT_ENCODE_SET),
                encoded_path
            ),
        );
    }
    Ok(urls)
}

fn rewrite_attachment_event<'a>(
    event: Event<'a>,
    attachment_urls: &HashMap<String, String>,
) -> Event<'a> {
    match event {
        Event::Html(source) | Event::InlineHtml(source) => Event::Text(source),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: rewritten_destination(dest_url, attachment_urls),
            title,
            id,
        }),
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
    attachment_urls: &HashMap<String, String>,
) -> CowStr<'a> {
    destination
        .strip_prefix("attach:")
        .and_then(|path| attachment_urls.get(path))
        .cloned()
        .map(CowStr::from)
        .unwrap_or(destination)
}

fn render_attachment_listing(doc: &TmdDoc, attachment_urls: &HashMap<String, String>) -> String {
    let mut metadata: Vec<_> = doc.list_attachments().collect();
    if metadata.is_empty() {
        return String::new();
    }
    metadata.sort_by(|left, right| left.logical_path.cmp(&right.logical_path));

    let mut output = String::from("<section><h2>Attachments</h2><ul>\n");
    for meta in metadata {
        let href = attachment_urls
            .get(&meta.logical_path)
            .map(String::as_str)
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
        SqlValue::Real(value) => json!(value),
        SqlValue::Text(value) => json!(value),
        SqlValue::Blob(value) => json!({ "base64": BASE64_STANDARD.encode(value) }),
    }
}

fn display_json_value(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "NULL".to_owned(),
        JsonValue::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn format_display(format: Format) -> &'static str {
    match format {
        Format::Tmd => ".tmd",
        Format::Tmdp => ".tmdp",
    }
}

fn format_name(format: Format) -> &'static str {
    match format {
        Format::Tmd => "tmd",
        Format::Tmdp => "tmdp",
    }
}
