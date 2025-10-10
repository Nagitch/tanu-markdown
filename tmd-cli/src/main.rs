use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::fs;
use std::path::Path;
use tmd_core::TmdDoc;

#[derive(Parser)]
#[command(name = "tmd", version, about = "Tanu Markdown CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    New {
        path: String,
        #[arg(long)]
        title: Option<String>,
    },
    Add {
        doc: String,
        src: String,
        #[arg(long)]
        as_path: String,
        #[arg(long)]
        mime: Option<String>,
    },
    Ls {
        doc: String,
    },
    Validate {
        doc: String,
    },
    ExportHtml {
        doc: String,
        out: String,
        #[arg(long)]
        self_contained: bool,
    },
    ConvertTmdz {
        doc: String,
        out: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::New { path, title } => {
            println!("(MVP stub) Create new: {} title={:?}", path, title)
        }
        Commands::Add {
            doc,
            src,
            as_path,
            mime,
        } => println!(
            "(MVP stub) Add attachment to {} from {} as {} mime={:?}",
            doc, src, as_path, mime
        ),
        Commands::Ls { doc } => println!("(MVP stub) List attachments in {}", doc),
        Commands::Validate { doc } => validate_command(&doc)?,
        Commands::ExportHtml {
            doc,
            out,
            self_contained,
        } => println!(
            "(MVP stub) Export HTML from {} to {} selfContained={}",
            doc, out, self_contained
        ),
        Commands::ConvertTmdz { doc, out } => println!("(MVP stub) Convert {} -> {}", doc, out),
    }
    Ok(())
}

fn validate_command(doc: &str) -> Result<()> {
    let path = Path::new(doc);
    let document = load_document(path)?;
    println!(
        "{}: OK (title: {})",
        path.display(),
        document.manifest.title
    );
    Ok(())
}

fn load_document(path: &Path) -> Result<TmdDoc> {
    let bytes = fs::read(path).with_context(|| format!("failed to read `{}`", path.display()))?;
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("tmd") => TmdDoc::open_bytes(&bytes),
        Some("tmdz") => TmdDoc::from_tmdz_bytes(&bytes),
        _ => anyhow::bail!("unsupported document extension for `{}`", path.display()),
    }
}
