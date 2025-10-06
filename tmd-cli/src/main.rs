use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "tmd", version, about = "Tanu Markdown CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    New { path: String, #[arg(long)] title: Option<String> },
    Add { doc: String, src: String, #[arg(long)] as_path: String, #[arg(long)] mime: Option<String> },
    Ls { doc: String },
    Validate { doc: String },
    ExportHtml { doc: String, out: String, #[arg(long)] self_contained: bool },
    ConvertTmdz { doc: String, out: String },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::New { path, title } => println!("(MVP stub) Create new: {} title={:?}", path, title),
        Commands::Add { doc, src, as_path, mime } => println!("(MVP stub) Add attachment to {} from {} as {} mime={:?}", doc, src, as_path, mime),
        Commands::Ls { doc } => println!("(MVP stub) List attachments in {}", doc),
        Commands::Validate { doc } => println!("(MVP stub) Validate {}", doc),
        Commands::ExportHtml { doc, out, self_contained } => println!("(MVP stub) Export HTML from {} to {} selfContained={}", doc, out, self_contained),
        Commands::ConvertTmdz { doc, out } => println!("(MVP stub) Convert {} -> {}", doc, out),
    }
    Ok(())
}
