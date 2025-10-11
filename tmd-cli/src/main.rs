//! Tanu Markdown CLI entrypoint.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Parser, Subcommand};
use html_escape::encode_text;
use pulldown_cmark::{html, Options, Parser as MdParser};
use rusqlite::{types::Value as SqlValue, Connection, OpenFlags};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tmd_core::{Manifest, TmdDoc};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Parser)]
#[command(name = "tmd", version, about = "Tanu Markdown CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Scaffold a new TMD workspace directory.
    New {
        path: String,
        #[arg(long)]
        title: Option<String>,
    },
    /// Pack a `.tmd` document from a directory or `.tmdz` archive.
    Pack { input: String, output: String },
    /// Unpack a `.tmd` document into a directory or `.tmdz` archive.
    Unpack { input: String, output: String },
    /// Validate a `.tmd` or `.tmdz` document.
    Validate { input: String },
    /// Export a `.tmd`/`.tmdz` document to HTML.
    ExportHtml {
        input: String,
        output: String,
        #[arg(long)]
        self_contained: bool,
    },
    /// Execute a read-only SQL query against the embedded SQLite database.
    Query {
        input: String,
        #[arg(long)]
        sql: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::New { path, title } => cmd_new(Path::new(&path), title.as_deref()),
        Commands::Pack { input, output } => cmd_pack(Path::new(&input), Path::new(&output)),
        Commands::Unpack { input, output } => cmd_unpack(Path::new(&input), Path::new(&output)),
        Commands::Validate { input } => cmd_validate(Path::new(&input)),
        Commands::ExportHtml {
            input,
            output,
            self_contained,
        } => cmd_export_html(Path::new(&input), Path::new(&output), self_contained),
        Commands::Query { input, sql } => cmd_query(Path::new(&input), &sql),
    }
}

fn cmd_new(path: &Path, title: Option<&str>) -> Result<()> {
    anyhow::ensure!(
        !path.exists(),
        "target directory `{}` already exists",
        path.display()
    );
    fs::create_dir_all(path)
        .with_context(|| format!("failed to create directory `{}`", path.display()))?;
    fs::create_dir_all(path.join("images")).context("failed to create images directory")?;
    fs::create_dir_all(path.join("data")).context("failed to create data directory")?;

    let title = title.unwrap_or("New TMD Document");
    let markdown = format!(
        "# {}\n\nWelcome to **Tanu Markdown**!\n\nStart editing `index.md` to add your content.",
        title
    );
    fs::write(path.join("index.md"), markdown).context("failed to write initial index.md")?;

    let manifest = serde_json::json!({
        "version": 1,
        "schemaVersion": "2025.10",
        "title": title,
        "attachments": {},
        "data": {
            "engine": "none",
            "entry": ""
        }
    });

    fs::write(
        path.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)? + "\n",
    )
    .context("failed to write manifest.json")?;

    println!("Initialized new TMD workspace at {}", path.display());
    Ok(())
}

fn cmd_pack(input: &Path, output: &Path) -> Result<()> {
    let doc = load_document(input)?;
    doc.write_to_path(output)
        .with_context(|| format!("failed to write `{}`", output.display()))?;
    println!("Packed `{}` into `{}`", input.display(), output.display());
    Ok(())
}

fn cmd_unpack(input: &Path, output: &Path) -> Result<()> {
    let doc = load_document(input)?;
    if output
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("tmdz"))
    {
        write_tmdz(&doc, output)?;
    } else if output
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("tmd"))
    {
        doc.write_to_path(output)?;
    } else {
        write_directory(&doc, output)?;
    }
    println!("Unpacked `{}` into `{}`", input.display(), output.display());
    Ok(())
}

fn cmd_validate(input: &Path) -> Result<()> {
    let _doc = load_document(input)?;
    println!("{} is valid", input.display());
    Ok(())
}

fn cmd_export_html(input: &Path, output: &Path, self_contained: bool) -> Result<()> {
    let doc = load_document(input)?;
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
        title = encode_text(&doc.manifest.title),
        body = body_html,
        attachments = attachment_section,
    );

    fs::write(output, html).with_context(|| format!("failed to write `{}`", output.display()))?;
    println!(
        "Exported `{}` to HTML at `{}`",
        input.display(),
        output.display()
    );
    Ok(())
}

fn cmd_query(input: &Path, sql: &str) -> Result<()> {
    let doc = load_document(input)?;
    anyhow::ensure!(
        doc.manifest.data.engine.eq_ignore_ascii_case("sqlite"),
        "document does not declare a SQLite data section"
    );
    let entry = PathBuf::from(&doc.manifest.data.entry);
    let entry_str = entry
        .to_str()
        .with_context(|| "data entry path is not valid UTF-8")?;
    let attachment = doc
        .attachments
        .get(entry_str)
        .with_context(|| format!("attachment `{}` not found", entry.display()))?;
    anyhow::ensure!(
        !attachment.is_empty(),
        "attachment `{}` is empty; nothing to query",
        entry.display()
    );

    let mut temp = NamedTempFile::new().context("failed to create temporary SQLite file")?;
    temp.write_all(attachment)
        .context("failed to write SQLite data to temporary file")?;
    let temp_path = temp.into_temp_path();

    let conn = Connection::open_with_flags(&temp_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("failed to open SQLite database")?;
    let mut stmt = conn
        .prepare(sql)
        .with_context(|| "failed to prepare SQL statement")?;
    let column_count = stmt.column_count();
    let column_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|name| name.to_string())
        .collect();

    println!("| {} |", column_names.join(" | "));
    println!(
        "|{}|",
        column_names
            .iter()
            .map(|_| "---")
            .collect::<Vec<_>>()
            .join("|")
    );

    let mut rows = stmt.query([]).with_context(|| "failed to execute query")?;
    while let Some(row) = rows.next()? {
        let mut values = Vec::with_capacity(column_count);
        for idx in 0..column_count {
            let value: SqlValue = row.get(idx)?;
            values.push(display_sql_value(&value));
        }
        println!("| {} |", values.join(" | "));
    }

    Ok(())
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

fn load_document(path: &Path) -> Result<TmdDoc> {
    if path.is_dir() {
        return load_from_directory(path);
    }
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("tmd") => {
            let bytes =
                fs::read(path).with_context(|| format!("failed to read `{}`", path.display()))?;
            TmdDoc::open_bytes(&bytes)
        }
        Some("tmdz") => load_from_tmdz(path),
        _ => anyhow::bail!(
            "unsupported input `{}` — expected directory, .tmd, or .tmdz",
            path.display()
        ),
    }
}

fn load_from_directory(path: &Path) -> Result<TmdDoc> {
    let markdown_path = path.join("index.md");
    let manifest_path = path.join("manifest.json");
    let markdown = fs::read_to_string(&markdown_path)
        .with_context(|| format!("failed to read markdown at `{}`", markdown_path.display()))?;
    let manifest_json = fs::read_to_string(&manifest_path)
        .with_context(|| format!("failed to read manifest at `{}`", manifest_path.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&manifest_json).context("failed to deserialize manifest.json")?;

    let mut attachments = HashMap::new();
    for path_entry in manifest.attachments.keys() {
        let file_path = path.join(path_entry);
        let data = fs::read(&file_path)
            .with_context(|| format!("failed to read attachment `{}`", file_path.display()))?;
        attachments.insert(path_entry.clone(), data);
    }

    Ok(TmdDoc::from_parts(markdown, manifest, attachments))
}

fn load_from_tmdz(path: &Path) -> Result<TmdDoc> {
    let file = File::open(path).with_context(|| format!("failed to open `{}`", path.display()))?;
    let mut archive = ZipArchive::new(file).context("failed to read .tmdz archive")?;

    let markdown = {
        let mut file = archive
            .by_name("index.md")
            .context("index.md missing from archive")?;
        let mut buf = String::new();
        file.read_to_string(&mut buf)
            .context("failed to read index.md")?;
        buf
    };

    let manifest: Manifest = {
        let mut file = archive
            .by_name("manifest.json")
            .context("manifest.json missing from archive")?;
        let mut buf = String::new();
        file.read_to_string(&mut buf)
            .context("failed to read manifest.json")?;
        serde_json::from_str(&buf).context("failed to deserialize manifest.json")?
    };

    let mut attachments = HashMap::new();
    let mut seen = HashSet::new();
    for (path_entry, meta) in &manifest.attachments {
        let mut file = archive
            .by_name(path_entry)
            .with_context(|| format!("attachment `{}` missing from archive", path_entry))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .with_context(|| format!("failed to read attachment `{}`", path_entry))?;

        anyhow::ensure!(
            data.len() as u64 == meta.size,
            "attachment `{}` size mismatch: manifest={} actual={}",
            path_entry,
            meta.size,
            data.len()
        );

        let digest_hex = sha256_hex(&data);
        anyhow::ensure!(
            digest_hex.eq_ignore_ascii_case(&meta.sha256),
            "attachment `{}` sha256 mismatch: manifest={} actual={}",
            path_entry,
            meta.sha256,
            digest_hex
        );

        attachments.insert(path_entry.clone(), data);
        seen.insert(path_entry.clone());
    }

    for idx in 0..archive.len() {
        let file = archive
            .by_index(idx)
            .with_context(|| format!("failed to inspect ZIP entry at index {}", idx))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name();
        if name == "index.md" || name == "manifest.json" {
            continue;
        }
        anyhow::ensure!(
            seen.contains(name),
            "ZIP archive contains undeclared entry `{}`",
            name
        );
    }

    Ok(TmdDoc::from_parts(markdown, manifest, attachments))
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        // Writing to `String` cannot fail.
        let _ = write!(&mut out, "{:02x}", byte);
    }
    out
}

fn write_directory(doc: &TmdDoc, output: &Path) -> Result<()> {
    fs::create_dir_all(output)
        .with_context(|| format!("failed to create `{}`", output.display()))?;
    fs::write(output.join("index.md"), &doc.markdown).context("failed to write index.md")?;
    fs::write(
        output.join("manifest.json"),
        serde_json::to_string_pretty(&doc.manifest)? + "\n",
    )
    .context("failed to write manifest.json")?;

    for (path_entry, data) in &doc.attachments {
        let target_path = output.join(path_entry);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory `{}`", parent.display()))?;
        }
        fs::write(&target_path, data)
            .with_context(|| format!("failed to write attachment `{}`", target_path.display()))?;
    }
    Ok(())
}

fn write_tmdz(doc: &TmdDoc, output: &Path) -> Result<()> {
    let file =
        File::create(output).with_context(|| format!("failed to create `{}`", output.display()))?;
    let mut writer = ZipWriter::new(file);
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);

    writer
        .start_file("index.md", options)
        .context("failed to start index.md entry")?;
    writer
        .write_all(doc.markdown.as_bytes())
        .context("failed to write index.md")?;

    writer
        .start_file("manifest.json", options)
        .context("failed to start manifest.json entry")?;
    writer
        .write_all(serde_json::to_string_pretty(&doc.manifest)?.as_bytes())
        .context("failed to write manifest.json")?;

    let mut ordered: BTreeMap<&String, &Vec<u8>> = BTreeMap::new();
    for (path_entry, data) in &doc.attachments {
        ordered.insert(path_entry, data);
    }

    for (path_entry, data) in ordered {
        writer
            .start_file(path_entry, options)
            .with_context(|| format!("failed to start attachment `{}`", path_entry))?;
        writer
            .write_all(data)
            .with_context(|| format!("failed to write attachment `{}`", path_entry))?;
    }

    writer.finish().context("failed to finish ZIP archive")?;
    Ok(())
}

fn render_attachment_listing(doc: &TmdDoc) -> String {
    if doc.attachments.is_empty() {
        return String::new();
    }
    let mut rows = String::new();
    rows.push_str("<section><h2>Attachments</h2><ul>\n");
    for (path_entry, meta) in &doc.manifest.attachments {
        let escaped = encode_text(path_entry);
        let mime = encode_text(&meta.mime);
        rows.push_str(&format!(
            "  <li><code>{}</code> ({} bytes, {})</li>\n",
            escaped, meta.size, mime
        ));
    }
    rows.push_str("</ul></section>");
    rows
}

fn render_embedded_attachments(doc: &TmdDoc) -> String {
    if doc.attachments.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push_str("<section><h2>Attachments</h2><ul>\n");
    for (path_entry, meta) in &doc.manifest.attachments {
        if let Some(data) = doc.attachments.get(path_entry) {
            let encoded = BASE64_STANDARD.encode(data);
            let href = format!("data:{};base64,{}", meta.mime, encoded);
            out.push_str(&format!(
                "  <li><a download=\"{name}\" href=\"{href}\">{name}</a> ({size} bytes)</li>\n",
                name = encode_text(path_entry),
                href = href,
                size = meta.size
            ));
        }
    }
    out.push_str("</ul></section>");
    out
}
