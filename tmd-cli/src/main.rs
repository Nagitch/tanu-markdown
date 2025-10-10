//! Tanu Markdown CLI entrypoint.

use std::collections::{BTreeMap, HashMap};
use std::convert::TryFrom;
use std::fmt::Write as FmtWrite;
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use clap::{Parser, Subcommand};
use html_escape::encode_text;
use mime::Mime;
use pulldown_cmark::{html, Options, Parser as MdParser};
use rusqlite::{types::Value as SqlValue, Connection, OpenFlags};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tmd_core::{AttachmentMeta, DataSection, Manifest, TmdDoc};
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
    /// Add or replace an attachment within a document or workspace.
    Add {
        doc: String,
        src: String,
        #[arg(long)]
        as_path: String,
        #[arg(long)]
        mime: Option<String>,
    },
    /// List attachments described in the document manifest.
    Ls { doc: String },
    /// Convert a document into a `.tmdz` archive.
    ConvertTmdz { doc: String, out: String },
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
        Commands::Add {
            doc,
            src,
            as_path,
            mime,
        } => cmd_add(Path::new(&doc), Path::new(&src), &as_path, mime.as_deref()),
        Commands::Ls { doc } => cmd_ls(Path::new(&doc)),
        Commands::ConvertTmdz { doc, out } => cmd_convert_tmdz(Path::new(&doc), Path::new(&out)),
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

    let manifest = Manifest {
        version: 1,
        schema_version: "2025.10".to_string(),
        title: title.to_string(),
        attachments: HashMap::new(),
        data: DataSection {
            engine: "none".to_string(),
            entry: String::new(),
        },
    };

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
    if output.is_dir() {
        write_directory(&doc, output)?;
    } else {
        match output
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref()
        {
            Some("tmd") => write_tmd(&doc, output)?,
            Some("tmdz") => write_tmdz(&doc, output)?,
            _ => {
                anyhow::bail!(
                    "unsupported output `{}` — expected .tmd, .tmdz, or directory",
                    output.display()
                )
            }
        }
    }
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
        write_tmd(&doc, output)?;
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

fn cmd_add(doc_path: &Path, src: &Path, as_path: &str, mime: Option<&str>) -> Result<()> {
    ensure_attachment_path(as_path)?;
    let mut doc = load_document(doc_path)?;
    let data = fs::read(src)
        .with_context(|| format!("failed to read attachment source `{}`", src.display()))?;
    anyhow::ensure!(
        !data.is_empty(),
        "source `{}` is empty; nothing to attach",
        src.display()
    );
    let size = u64::try_from(data.len()).context("attachment size exceeds u64")?;
    let mime = determine_mime_type(as_path, mime)?;
    let sha256 = compute_sha256_hex(&data);

    doc.attachments.insert(as_path.to_string(), data);
    doc.manifest
        .attachments
        .insert(as_path.to_string(), AttachmentMeta { mime, sha256, size });

    save_document(&doc, doc_path)?;

    println!(
        "Added `{}` ({} bytes) from `{}` into `{}`",
        as_path,
        size,
        src.display(),
        doc_path.display()
    );
    Ok(())
}

fn cmd_ls(doc_path: &Path) -> Result<()> {
    let doc = load_document(doc_path)?;
    if doc.manifest.attachments.is_empty() {
        println!("{} has no attachments", doc_path.display());
        return Ok(());
    }

    println!("Attachments in {}:", doc_path.display());
    let mut ordered: BTreeMap<_, _> = BTreeMap::new();
    for (path, meta) in &doc.manifest.attachments {
        ordered.insert(path, meta);
    }
    for (path, meta) in ordered {
        println!(
            "  {} — {} bytes, {}, sha256={}",
            path, meta.size, meta.mime, meta.sha256
        );
    }
    Ok(())
}

fn cmd_convert_tmdz(input: &Path, output: &Path) -> Result<()> {
    let doc = load_document(input)?;
    anyhow::ensure!(
        output
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tmdz")),
        "output `{}` must end with .tmdz",
        output.display()
    );
    write_tmdz(&doc, output)?;
    println!(
        "Converted `{}` into .tmdz at `{}`",
        input.display(),
        output.display()
    );
    Ok(())
}

fn save_document(doc: &TmdDoc, destination: &Path) -> Result<()> {
    if destination.is_dir() {
        write_directory(doc, destination)
    } else {
        match destination
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref()
        {
            Some("tmd") => write_tmd(doc, destination),
            Some("tmdz") => write_tmdz(doc, destination),
            _ => anyhow::bail!(
                "unsupported destination `{}` — expected directory, .tmd, or .tmdz",
                destination.display()
            ),
        }
    }
}

fn write_tmd(doc: &TmdDoc, output: &Path) -> Result<()> {
    ensure_parent_dir(output)?;
    doc.write_to_path(output)
        .with_context(|| format!("failed to write `{}`", output.display()))
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory `{}`", parent.display()))?;
        }
    }
    Ok(())
}

fn ensure_attachment_path(path: &str) -> Result<()> {
    anyhow::ensure!(!path.trim().is_empty(), "attachment path cannot be empty");
    let candidate = Path::new(path);
    anyhow::ensure!(
        candidate.file_name().is_some(),
        "attachment path must include a file name"
    );
    anyhow::ensure!(!candidate.is_absolute(), "attachment path must be relative");
    anyhow::ensure!(
        candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_))),
        "attachment path must not contain navigation segments"
    );
    Ok(())
}

fn determine_mime_type(target: &str, provided: Option<&str>) -> Result<String> {
    if let Some(mime) = provided {
        let trimmed = mime.trim();
        anyhow::ensure!(!trimmed.is_empty(), "MIME type cannot be empty");
        trimmed
            .parse::<Mime>()
            .with_context(|| format!("invalid MIME type `{}`", trimmed))?;
        return Ok(trimmed.to_string());
    }

    let guess = mime_guess::from_path(target)
        .first()
        .map(|mime| mime.essence_str().to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok(guess)
}

fn compute_sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing to a `String` cannot fail.
        FmtWrite::write_fmt(&mut out, format_args!("{:02x}", byte))
            .expect("writing to String cannot fail");
    }
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
    for path_entry in manifest.attachments.keys() {
        let mut file = archive
            .by_name(path_entry)
            .with_context(|| format!("attachment `{}` missing from archive", path_entry))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .with_context(|| format!("failed to read attachment `{}`", path_entry))?;
        attachments.insert(path_entry.clone(), data);
    }

    Ok(TmdDoc::from_parts(markdown, manifest, attachments))
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
    ensure_parent_dir(output)?;
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
