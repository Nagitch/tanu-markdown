//! Tanu Markdown CLI entrypoint.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Parser, Subcommand};
use html_escape::encode_text;
use pulldown_cmark::{html, Options, Parser as MdParser};
use rusqlite::types::Value as SqlValue;
use tmd_core::{export_db, import_db, read_from_path, reset_db, write_to_path, Format, TmdDoc};

#[derive(Parser)]
#[command(name = "tmd", version, about = "Tanu Markdown CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Create a new `.tmd` or `.tmdz` document with an embedded SQLite database.
    New {
        output: PathBuf,
        #[arg(long)]
        title: Option<String>,
    },
    /// Convert between `.tmd` and `.tmdz` containers.
    Convert { input: PathBuf, output: PathBuf },
    /// Validate a `.tmd` or `.tmdz` document.
    Validate { input: PathBuf },
    /// Export a `.tmd`/`.tmdz` document to HTML.
    ExportHtml {
        input: PathBuf,
        output: PathBuf,
        #[arg(long)]
        self_contained: bool,
    },
    /// Database maintenance commands.
    Db {
        #[command(subcommand)]
        command: DbCommands,
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
    /// Execute SQL against the embedded database.
    Exec {
        doc: PathBuf,
        #[arg(long)]
        sql: String,
    },
    /// Import a SQLite file, replacing the embedded database.
    Import { doc: PathBuf, source: PathBuf },
    /// Export the embedded SQLite database to a standalone file.
    Export { doc: PathBuf, output: PathBuf },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::New { output, title } => cmd_new(&output, title.as_deref()),
        Commands::Convert { input, output } => cmd_convert(&input, &output),
        Commands::Validate { input } => cmd_validate(&input),
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
            DbCommands::Import { doc, source } => cmd_db_import(&doc, &source),
            DbCommands::Export { doc, output } => cmd_db_export(&doc, &output),
        },
    }
}

fn cmd_new(path: &Path, title: Option<&str>) -> Result<()> {
    anyhow::ensure!(!path.exists(), "target `{}` already exists", path.display());
    ensure_parent_directory(path)?;

    let format = detect_format(path)?;
    let display_title = title.unwrap_or("New TMD Document");
    let markdown = format!(
        "# {}\n\nWelcome to **Tanu Markdown**!\n\nThe embedded database is ready for use.",
        display_title
    );
    let mut doc = TmdDoc::new(markdown).context("failed to create document")?;
    doc.manifest.title = Some(display_title.to_string());
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

fn cmd_validate(input: &Path) -> Result<()> {
    let (doc, _) = read_document(input)?;
    let user_version = doc
        .db_with_conn(|conn| conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0)))
        .context("failed to access embedded database")?
        .context("failed to read PRAGMA user_version from embedded database")?;

    if let Some(expected) = doc.manifest.db_schema_version {
        anyhow::ensure!(
            expected == user_version,
            "manifest db_schema_version={} but PRAGMA user_version={}",
            expected,
            user_version
        );
    }

    println!(
        "{} is valid (user_version = {})",
        input.display(),
        user_version
    );
    Ok(())
}

fn cmd_export_html(input: &Path, output: &Path, self_contained: bool) -> Result<()> {
    let (doc, _) = read_document(input)?;
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = MdParser::new_ext(&doc.markdown, options);
    let mut body_html = String::new();
    html::push_html(&mut body_html, parser);

    let attachment_section = if self_contained {
        render_embedded_attachments(&doc)
    } else {
        render_attachment_listing(&doc)
    };

    let title = doc
        .manifest
        .title
        .as_deref()
        .unwrap_or("Tanu Markdown Document");

    let html = format!(
        r#"<!DOCTYPE html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <title>{title}</title>
    <style>
      body {{ font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.6; }}
      pre {{ background: #f5f5f5; padding: 1rem; overflow-x: auto; }}
      code {{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; }}
      table {{ border-collapse: collapse; }}
      th, td {{ border: 1px solid #ccc; padding: 0.25rem 0.5rem; }}
    </style>
  </head>
  <body>
    <article>
    {body}
    </article>
    {attachments}
  </body>
</html>
"#,
        title = encode_text(title),
        body = body_html,
        attachments = attachment_section,
    );

    ensure_parent_directory(output)?;
    fs::write(output, html).with_context(|| format!("failed to write `{}`", output.display()))?;
    println!(
        "Exported `{}` to HTML at `{}`",
        input.display(),
        output.display()
    );
    Ok(())
}

fn cmd_db_init(doc_path: &Path, schema_path: Option<&Path>, version: Option<u32>) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
    let schema_sql = if let Some(path) = schema_path {
        Some(
            fs::read_to_string(path)
                .with_context(|| format!("failed to read schema `{}`", path.display()))?,
        )
    } else {
        None
    };

    if let Some(sql) = schema_sql.as_deref() {
        let version = version.unwrap_or(0);
        reset_db(&mut doc, sql, version).context("failed to reset embedded database")?;
        doc.manifest.db_schema_version = Some(version);
        doc.touch();
    } else if let Some(version) = version {
        doc.db_with_conn_mut(|conn| -> rusqlite::Result<()> {
            conn.pragma_update(None, "user_version", version as i64)?;
            Ok(())
        })
        .context("failed to access embedded database")?
        .context("failed to update database version")?;
        doc.manifest.db_schema_version = Some(version);
        doc.touch();
    }

    write_document(doc_path, &doc, format)?;
    println!(
        "Initialised database for `{}` (schema version = {:?})",
        doc_path.display(),
        doc.manifest.db_schema_version
    );
    Ok(())
}

fn cmd_db_exec(doc_path: &Path, sql: &str) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
    let mut mutated = false;
    let leading_keyword = leading_sql_keyword(sql);

    doc.db_with_conn_mut(|conn| -> rusqlite::Result<()> {
        let mut stmt = conn.prepare(sql)?;
        let column_count = stmt.column_count();
        let readonly = stmt.readonly();

        if column_count > 0 {
            let column_names: Vec<String> = stmt
                .column_names()
                .into_iter()
                .map(|name| name.to_string())
                .collect();

            if column_count > 0 {
                println!("| {} |", column_names.join(" | "));
                println!(
                    "|{}|",
                    column_names
                        .iter()
                        .map(|_| "---")
                        .collect::<Vec<_>>()
                        .join("|")
                );
            }

            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(column_count);
                for idx in 0..column_count {
                    let value: SqlValue = row.get(idx)?;
                    values.push(display_sql_value(&value));
                }
                println!("| {} |", values.join(" | "));
            }

            if !readonly || matches!(leading_keyword.as_deref(), Some("pragma") | Some("with")) {
                mutated = true;
            }
            return Ok(());
        }

        drop(stmt);
        conn.execute_batch(sql)?;
        mutated = true;
        Ok(())
    })
    .context("failed to access embedded database")?
    .context("failed to execute SQL against embedded database")?;

    if mutated {
        doc.touch();
        write_document(doc_path, &doc, format)?;
        println!("Executed SQL and updated `{}`", doc_path.display());
    }

    Ok(())
}

fn leading_sql_keyword(sql: &str) -> Option<String> {
    let token = sql
        .trim_start()
        .split_whitespace()
        .next()
        .map(|candidate| {
            candidate
                .trim_start_matches(|c: char| !c.is_ascii_alphabetic())
                .chars()
                .take_while(|c| c.is_ascii_alphabetic())
                .map(|c| c.to_ascii_lowercase())
                .collect::<String>()
        })
        .unwrap_or_default();

    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn cmd_db_import(doc_path: &Path, source: &Path) -> Result<()> {
    let (mut doc, format) = read_document(doc_path)?;
    import_db(&mut doc, source).context("failed to import SQLite database")?;
    let user_version = doc
        .db_with_conn(|conn| conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0)))
        .context("failed to access embedded database")?
        .context("failed to query imported user_version")?;
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

fn read_document(path: &Path) -> Result<(TmdDoc, Format)> {
    let format = detect_format(path)?;
    let doc = read_from_path(path, Some(format))
        .with_context(|| format!("failed to read `{}`", path.display()))?;
    Ok((doc, format))
}

fn write_document(path: &Path, doc: &TmdDoc, format: Format) -> Result<()> {
    write_to_path(path, doc, format)
        .with_context(|| format!("failed to write `{}`", path.display()))
}

fn detect_format(path: &Path) -> Result<Format> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("tmd") => Ok(Format::Tmd),
        Some("tmdz") => Ok(Format::Tmdz),
        _ => Err(anyhow!(
            "unsupported path `{}` — expected extension .tmd or .tmdz",
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

fn render_attachment_listing(doc: &TmdDoc) -> String {
    let mut metas: Vec<_> = doc.list_attachments().collect();
    if metas.is_empty() {
        return String::new();
    }
    metas.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));

    let mut rows = String::new();
    rows.push_str("<section><h2>Attachments</h2><ul>\n");
    for meta in metas {
        rows.push_str(&format!(
            "  <li><code>{name}</code> ({size} bytes, {mime})</li>\n",
            name = encode_text(&meta.logical_path),
            size = meta.length,
            mime = encode_text(meta.mime.as_ref()),
        ));
    }
    rows.push_str("</ul></section>");
    rows
}

fn render_embedded_attachments(doc: &TmdDoc) -> String {
    let mut entries: Vec<_> = doc.attachments.iter_with_data().collect();
    if entries.is_empty() {
        return String::new();
    }
    entries.sort_by(|(a, _), (b, _)| a.logical_path.cmp(&b.logical_path));

    let mut out = String::new();
    out.push_str("<section><h2>Attachments</h2><ul>\n");
    for (meta, data) in entries {
        let encoded = BASE64_STANDARD.encode(data);
        let href = format!("data:{};base64,{}", meta.mime, encoded);
        out.push_str(&format!(
            "  <li><a download=\"{name}\" href=\"{href}\">{name}</a> ({size} bytes)</li>\n",
            name = encode_text(&meta.logical_path),
            href = href,
            size = meta.length
        ));
    }
    out.push_str("</ul></section>");
    out
}

fn display_sql_value(value: &SqlValue) -> String {
    match value {
        SqlValue::Null => "NULL".to_string(),
        SqlValue::Integer(v) => v.to_string(),
        SqlValue::Real(v) => v.to_string(),
        SqlValue::Text(v) => v.clone(),
        SqlValue::Blob(_) => "<blob>".to_string(),
    }
}

fn format_display(format: Format) -> &'static str {
    match format {
        Format::Tmd => ".tmd",
        Format::Tmdz => ".tmdz",
    }
}
