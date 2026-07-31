use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tmd_core::{write_tmd, write_to_path, Format, TmdDoc, WriteMode};

fn argument(path: &Path) -> OsString {
    path.as_os_str().to_owned()
}

fn run(args: Vec<OsString>, stdin: Option<&str>) -> Output {
    let output = run_raw(args, stdin);
    assert!(
        output.status.success(),
        "tmd failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn run_raw(args: Vec<OsString>, stdin: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tmd"));
    command.args(args);
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn tmd");
    if let Some(stdin) = stdin {
        child
            .stdin
            .take()
            .expect("stdin pipe")
            .write_all(stdin.as_bytes())
            .expect("write stdin");
    }
    child.wait_with_output().expect("wait for tmd")
}

fn text(value: &str) -> OsString {
    OsString::from(value)
}

fn parse_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("valid JSON output")
}

#[test]
fn query_preserves_non_finite_real_values() {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("non-finite.tmd");
    run(vec![text("new"), argument(&doc)], None);

    let json_output = run(
        vec![
            text("db"),
            text("query"),
            argument(&doc),
            text("--sql"),
            text("SELECT 1e999 AS positive, -1e999 AS negative"),
            text("--json"),
        ],
        None,
    );
    let query = parse_json(&json_output);
    assert_eq!(
        query["rows"],
        json!([[{"real": "Infinity"}, {"real": "-Infinity"}]])
    );

    let table_output = run(
        vec![
            text("db"),
            text("query"),
            argument(&doc),
            text("--sql"),
            text("SELECT 1e999 AS positive, -1e999 AS negative"),
        ],
        None,
    );
    let table = String::from_utf8(table_output.stdout).expect("UTF-8 table output");
    assert!(table.contains("| Infinity | -Infinity |"));
}

#[test]
fn query_table_output_preserves_cell_boundaries() {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("table-output.tmd");
    run(vec![text("new"), argument(&doc)], None);

    let table_output = run(
        vec![
            text("db"),
            text("query"),
            argument(&doc),
            text("--sql"),
            text(
                "SELECT 'left|right' AS \"pipe|column\", \
                 'line1' || char(10) || 'line2' AS lines",
            ),
        ],
        None,
    );
    let table = String::from_utf8(table_output.stdout).expect("UTF-8 table output");
    assert!(table.contains("| pipe\\|column | lines |"));
    assert!(table.contains("| left\\|right | line1\\nline2 |"));
    assert_eq!(table.lines().count(), 3);
}

#[test]
fn db_exec_rejects_scripts_that_leave_transactions_open() {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("open-transaction.tmd");
    run(vec![text("new"), argument(&doc)], None);
    let original = fs::read(&doc).expect("original document");

    let execution = run_raw(
        vec![
            text("db"),
            text("exec"),
            argument(&doc),
            text("--sql"),
            text("BEGIN; CREATE TABLE rolled_back (id INTEGER);"),
        ],
        None,
    );

    assert!(!execution.status.success());
    assert!(
        String::from_utf8_lossy(&execution.stderr).contains("SQL script left a transaction open")
    );
    assert_eq!(
        fs::read(&doc).expect("document after rejected SQL"),
        original
    );
}

#[test]
fn db_exec_synchronizes_and_validates_user_version() {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("user-version.tmd");
    run(vec![text("new"), argument(&doc)], None);

    run(
        vec![
            text("db"),
            text("exec"),
            argument(&doc),
            text("--sql"),
            text("PRAGMA user_version = 2;"),
        ],
        None,
    );
    let inspection = parse_json(&run(
        vec![text("inspect"), argument(&doc), text("--json")],
        None,
    ));
    assert_eq!(inspection["manifest"]["db_schema_version"], 2);
    assert_eq!(inspection["database_user_version"], 2);
    assert_eq!(
        parse_json(&run(
            vec![text("validate"), argument(&doc), text("--json")],
            None,
        ))["valid"],
        true
    );

    let original = fs::read(&doc).expect("valid version document");
    let negative = run_raw(
        vec![
            text("db"),
            text("exec"),
            argument(&doc),
            text("--sql"),
            text("PRAGMA user_version = -1;"),
        ],
        None,
    );
    assert!(!negative.status.success());
    assert_eq!(fs::read(&doc).expect("preserved document"), original);
}

#[test]
fn conditional_convert_rejects_stale_and_created_outputs() {
    let directory = tempdir().expect("temporary directory");
    let first = directory.path().join("first.tmd");
    let second = directory.path().join("second.tmd");
    let output = directory.path().join("output.tmd");
    let missing_output = directory.path().join("missing-output.tmd");
    run(
        vec![
            text("new"),
            argument(&first),
            text("--title"),
            text("First"),
        ],
        None,
    );
    run(
        vec![
            text("new"),
            argument(&second),
            text("--title"),
            text("Second"),
        ],
        None,
    );
    run(
        vec![text("convert"), argument(&first), argument(&output)],
        None,
    );

    let original = fs::read(&output).expect("original output");
    assert_eq!(
        fs::read(&first).expect("source document"),
        original,
        "same-format conversion must produce the bytes whose digest is published"
    );
    let original_sha256 = hex::encode(Sha256::digest(&original));
    run(
        vec![
            text("convert"),
            argument(&second),
            argument(&output),
            text("--expected-output-state"),
            text(&original_sha256),
        ],
        None,
    );
    let replaced = fs::read(&output).expect("conditionally replaced output");
    assert_ne!(replaced, original);

    let stale = run_raw(
        vec![
            text("convert"),
            argument(&first),
            argument(&output),
            text("--expected-output-state"),
            text(&original_sha256),
        ],
        None,
    );
    assert!(!stale.status.success());
    assert_eq!(fs::read(&output).expect("preserved output"), replaced);

    run(
        vec![
            text("convert"),
            argument(&first),
            argument(&missing_output),
            text("--expected-output-state"),
            text("missing"),
        ],
        None,
    );
    let created = fs::read(&missing_output).expect("conditionally created output");
    let created_conflict = run_raw(
        vec![
            text("convert"),
            argument(&second),
            argument(&missing_output),
            text("--expected-output-state"),
            text("missing"),
        ],
        None,
    );
    assert!(!created_conflict.status.success());
    assert_eq!(
        fs::read(&missing_output).expect("preserved created output"),
        created
    );
}

#[test]
fn linked_html_export_cleans_up_assets_after_output_failure() {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("export.tmd");
    let source = directory.path().join("attachment.txt");
    let output = directory.path().join("blocked.html");
    let assets = directory.path().join("blocked_assets");
    fs::write(&source, "attachment").expect("attachment fixture");
    run(vec![text("new"), argument(&doc)], None);
    run(
        vec![
            text("attachment"),
            text("add"),
            argument(&doc),
            argument(&source),
            text("--path"),
            text("attachment.txt"),
            text("--mime"),
            text("text/plain"),
        ],
        None,
    );
    fs::create_dir(&output).expect("blocking output directory");

    let failed_export = run_raw(
        vec![text("export-html"), argument(&doc), argument(&output)],
        None,
    );

    assert!(!failed_export.status.success());
    assert!(!assets.exists(), "failed export must clean up assets");

    fs::remove_dir(&output).expect("remove blocking output directory");
    run(
        vec![text("export-html"), argument(&doc), argument(&output)],
        None,
    );
    assert!(output.is_file());
    assert!(assets.is_dir());
}

#[cfg(unix)]
#[test]
fn html_export_preserves_output_symlinks_and_target_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("export.tmd");
    let target = directory.path().join("shared.html");
    let output = directory.path().join("linked.html");
    run(vec![text("new"), argument(&doc)], None);
    fs::write(&target, "old HTML").expect("HTML target");
    fs::set_permissions(&target, fs::Permissions::from_mode(0o644))
        .expect("shared target permissions");
    symlink(&target, &output).expect("HTML output symlink");

    run(
        vec![
            text("export-html"),
            argument(&doc),
            argument(&output),
            text("--self-contained"),
        ],
        None,
    );

    assert!(fs::symlink_metadata(&output)
        .expect("preserved output symlink")
        .file_type()
        .is_symlink());
    assert!(fs::read_to_string(&target)
        .expect("exported target")
        .contains("<!DOCTYPE html>"));
    assert_eq!(
        fs::metadata(&target)
            .expect("target metadata")
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}

#[test]
fn update_reports_persisted_attachment_metadata() {
    let directory = tempdir().expect("temporary directory");
    let doc_path = directory.path().join("missing-hash.tmd");
    let mut doc = TmdDoc::new("# Before\n".to_owned()).expect("document model");
    let attachment_id = doc
        .add_attachment(
            "attachments/note.txt",
            "text/plain".parse().expect("text MIME"),
            b"attachment".to_vec(),
        )
        .expect("add attachment");
    let mut attachment_meta = doc
        .attachment_meta(attachment_id)
        .expect("attachment metadata")
        .clone();
    let attachment_data = doc
        .attachments
        .data(attachment_id)
        .expect("attachment data")
        .to_vec();
    doc.remove_attachment(attachment_id)
        .expect("remove hashed attachment");
    attachment_meta.sha256 = None;
    doc.attachments
        .insert_entry(attachment_meta, attachment_data, false)
        .expect("insert attachment without hash");
    let mut output = fs::File::create(&doc_path).expect("create fixture");
    write_tmd(
        &mut output,
        &doc,
        WriteMode {
            compute_hashes: false,
        },
    )
    .expect("write fixture without hashes");
    drop(output);

    let update = json!({
        "schema_version": 1,
        "markdown": "# After\n",
    });
    let response = parse_json(&run(
        vec![text("update"), argument(&doc_path), text("--json-stdin")],
        Some(&update.to_string()),
    ));
    assert!(response["attachments"][0]["sha256"].is_string());
    assert_eq!(response["validation"]["valid"], true);
    assert!(response["validation"]["issues"]
        .as_array()
        .expect("validation issues")
        .iter()
        .all(|issue| issue["code"] != "attachment_sha256_missing"));
}

#[test]
fn attachment_extract_never_clobbers_targets() {
    let directory = tempdir().expect("temporary directory");
    let doc_path = directory.path().join("attachments.tmd");
    let existing = directory.path().join("existing.txt");
    let mut doc = TmdDoc::new("# Attachments\n".to_owned()).expect("document model");
    doc.add_attachment(
        "attachments/note.txt",
        "text/plain".parse().expect("text MIME"),
        b"attachment".to_vec(),
    )
    .expect("add attachment");
    write_to_path(&doc_path, &doc, Format::Tmd).expect("write document");
    fs::write(&existing, "preserve me").expect("existing target");

    let extraction = run_raw(
        vec![
            text("attachment"),
            text("extract"),
            argument(&doc_path),
            text("--path"),
            text("attachments/note.txt"),
            argument(&existing),
        ],
        None,
    );
    assert!(!extraction.status.success());
    assert_eq!(
        fs::read_to_string(&existing).expect("preserved target"),
        "preserve me"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let dangling_target = directory.path().join("missing.txt");
        let dangling_link = directory.path().join("dangling.txt");
        symlink(&dangling_target, &dangling_link).expect("dangling symlink");
        let extraction = run_raw(
            vec![
                text("attachment"),
                text("extract"),
                argument(&doc_path),
                text("--path"),
                text("attachments/note.txt"),
                argument(&dangling_link),
            ],
            None,
        );
        assert!(!extraction.status.success());
        assert!(!dangling_target.exists());
        assert!(fs::symlink_metadata(dangling_link)
            .expect("preserved symlink")
            .file_type()
            .is_symlink());
    }
}

fn only_file_in(directory: &Path) -> PathBuf {
    let mut entries = fs::read_dir(directory)
        .expect("read asset directory")
        .map(|entry| entry.expect("asset entry").path());
    let file = entries.next().expect("one asset");
    assert!(file.is_file(), "asset must be a regular file");
    assert!(entries.next().is_none(), "expected exactly one asset");
    file
}

fn exercise_lifecycle(extension: &str) {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join(format!("document.{extension}"));
    let converted_extension = if extension == "tmd" { "tmdp" } else { "tmd" };
    let converted = directory
        .path()
        .join(format!("converted.{converted_extension}"));
    let source = directory.path().join("note.txt");
    let extracted = directory.path().join("extracted.txt");
    let schema = directory.path().join("schema.sql");
    let database = directory.path().join("export.sqlite3");
    let imported = directory.path().join(format!("imported.{extension}"));
    let standalone_html = directory.path().join("standalone.html");
    let linked_html = directory.path().join("linked.html");

    fs::write(&source, "attachment contents").expect("attachment fixture");
    fs::write(
        &schema,
        "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
    )
    .expect("schema fixture");

    run(
        vec![
            text("new"),
            argument(&doc),
            text("--title"),
            text("Lifecycle"),
        ],
        None,
    );
    let update = json!({
        "schema_version": 1,
        "markdown": "# Lifecycle\n\n[Download the note](attach:assets/note.txt)\n",
        "title": "Updated lifecycle",
        "authors": ["Tanu"],
        "tags": ["integration"],
    });
    let updated = run(
        vec![text("update"), argument(&doc), text("--json-stdin")],
        Some(&update.to_string()),
    );
    assert_eq!(
        parse_json(&updated)["manifest"]["title"],
        "Updated lifecycle"
    );

    run(
        vec![
            text("attachment"),
            text("add"),
            argument(&doc),
            argument(&source),
            text("--path"),
            text("assets/note.txt"),
            text("--mime"),
            text("text/plain"),
            text("--title"),
            text("Note"),
            text("--alt"),
            text("Download note"),
        ],
        None,
    );
    let attachments = parse_json(&run(
        vec![
            text("attachment"),
            text("list"),
            argument(&doc),
            text("--json"),
        ],
        None,
    ));
    assert_eq!(
        attachments["attachments"][0]["logical_path"],
        "assets/note.txt"
    );

    run(
        vec![
            text("db"),
            text("init"),
            argument(&doc),
            text("--schema"),
            argument(&schema),
            text("--version"),
            text("2"),
        ],
        None,
    );
    run(
        vec![
            text("db"),
            text("exec"),
            argument(&doc),
            text("--sql"),
            text("INSERT INTO notes(body) VALUES ('hello');"),
        ],
        None,
    );
    let query = parse_json(&run(
        vec![
            text("db"),
            text("query"),
            argument(&doc),
            text("--sql"),
            text("SELECT id, body FROM notes ORDER BY id"),
            text("--json"),
        ],
        None,
    ));
    assert_eq!(query["columns"], json!(["id", "body"]));
    assert_eq!(query["rows"], json!([[1, "hello"]]));

    run(
        vec![
            text("db"),
            text("migrate"),
            argument(&doc),
            text("--from"),
            text("2"),
            text("--to"),
            text("3"),
            text("--sql"),
            text("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;"),
        ],
        None,
    );
    let inspected = parse_json(&run(
        vec![text("inspect"), argument(&doc), text("--json")],
        None,
    ));
    assert_eq!(inspected["schema_version"], 1);
    assert_eq!(inspected["database_user_version"], 3);
    assert_eq!(inspected["database"]["objects"][0]["name"], "notes");
    assert_eq!(inspected["validation"]["valid"], true);

    let validation = parse_json(&run(
        vec![text("validate"), argument(&doc), text("--json")],
        None,
    ));
    assert_eq!(validation["valid"], true);
    assert_eq!(validation["attachment_references"][0]["resolved"], true);

    run(
        vec![
            text("export-html"),
            argument(&doc),
            argument(&standalone_html),
            text("--self-contained"),
        ],
        None,
    );
    let standalone = fs::read_to_string(&standalone_html).expect("standalone HTML");
    assert!(standalone.contains("href=\"data:text/plain;base64,"));
    assert!(standalone.contains("Download the note"));

    run(
        vec![text("export-html"), argument(&doc), argument(&linked_html)],
        None,
    );
    let linked = fs::read_to_string(&linked_html).expect("linked HTML");
    let linked_asset = only_file_in(&directory.path().join("linked_assets"));
    let linked_asset_name = linked_asset
        .file_name()
        .and_then(|name| name.to_str())
        .expect("UTF-8 asset name");
    assert!(linked_asset_name.ends_with(".txt"));
    assert!(linked.contains(&format!("linked_assets/{linked_asset_name}")));
    assert_eq!(
        fs::read_to_string(linked_asset).expect("linked attachment"),
        "attachment contents"
    );

    run(
        vec![text("convert"), argument(&doc), argument(&converted)],
        None,
    );
    let converted_validation = parse_json(&run(
        vec![text("validate"), argument(&converted), text("--json")],
        None,
    ));
    assert_eq!(converted_validation["valid"], true);

    run(
        vec![
            text("attachment"),
            text("rename"),
            argument(&converted),
            text("--from"),
            text("assets/note.txt"),
            text("--to"),
            text("assets/renamed.txt"),
        ],
        None,
    );
    let rename_update = json!({
        "schema_version": 1,
        "markdown": "# Lifecycle\n\n[Download the note](attach:assets/renamed.txt)\n",
    });
    run(
        vec![text("update"), argument(&converted), text("--json-stdin")],
        Some(&rename_update.to_string()),
    );
    run(
        vec![
            text("attachment"),
            text("extract"),
            argument(&converted),
            text("--path"),
            text("assets/renamed.txt"),
            argument(&extracted),
        ],
        None,
    );
    assert_eq!(
        fs::read_to_string(&extracted).expect("extracted attachment"),
        "attachment contents"
    );

    run(
        vec![
            text("attachment"),
            text("remove"),
            argument(&converted),
            text("--path"),
            text("assets/renamed.txt"),
        ],
        None,
    );
    let remove_update = json!({
        "schema_version": 1,
        "markdown": "# Lifecycle\n\nAttachment removed.\n",
    });
    run(
        vec![text("update"), argument(&converted), text("--json-stdin")],
        Some(&remove_update.to_string()),
    );
    run(
        vec![text("validate"), argument(&converted), text("--json")],
        None,
    );

    run(
        vec![
            text("db"),
            text("export"),
            argument(&doc),
            argument(&database),
        ],
        None,
    );
    run(vec![text("new"), argument(&imported)], None);
    run(
        vec![
            text("db"),
            text("import"),
            argument(&imported),
            argument(&database),
        ],
        None,
    );
    let imported_query = parse_json(&run(
        vec![
            text("db"),
            text("query"),
            argument(&imported),
            text("--sql"),
            text("SELECT body, pinned FROM notes"),
            text("--json"),
        ],
        None,
    ));
    assert_eq!(imported_query["rows"], json!([["hello", 0]]));
}

#[test]
fn complete_tmd_lifecycle() {
    exercise_lifecycle("tmd");
}

#[test]
fn complete_tmdp_lifecycle() {
    exercise_lifecycle("tmdp");
}

#[test]
fn machine_interfaces_reject_unsafe_inputs() {
    let directory = tempdir().expect("temporary directory");
    let doc = directory.path().join("document.tmd");
    run(vec![text("new"), argument(&doc)], None);

    let mutating_query = run_raw(
        vec![
            text("db"),
            text("query"),
            argument(&doc),
            text("--sql"),
            text("CREATE TABLE forbidden(id INTEGER)"),
            text("--json"),
        ],
        None,
    );
    assert!(!mutating_query.status.success());
    assert!(String::from_utf8_lossy(&mutating_query.stderr).contains("read-only"));

    let multiple_query = run_raw(
        vec![
            text("db"),
            text("query"),
            argument(&doc),
            text("--sql"),
            text("SELECT 1; SELECT 2"),
            text("--json"),
        ],
        None,
    );
    assert!(!multiple_query.status.success());

    let corrupt = directory.path().join("corrupt.tmd");
    fs::write(&corrupt, b"not a ZIP archive").expect("corrupt fixture");
    let validation = run_raw(
        vec![text("validate"), argument(&corrupt), text("--json")],
        None,
    );
    assert!(!validation.status.success());
    let report = parse_json(&validation);
    assert_eq!(report["valid"], false);
    assert_eq!(report["issues"][0]["code"], "container_read_failed");

    let corrupt_database_doc = directory.path().join("corrupt-database.tmd");
    let corrupt_document = TmdDoc::new("# Corrupt database\n".to_owned()).expect("document model");
    let mut corrupt_database = vec![0; 512];
    corrupt_database[..16].copy_from_slice(b"SQLite format 3\0");
    fs::write(corrupt_document.db.as_path(), corrupt_database).expect("corrupt embedded database");
    write_to_path(&corrupt_database_doc, &corrupt_document, Format::Tmd)
        .expect("corrupt database container");
    let database_validation = run_raw(
        vec![
            text("validate"),
            argument(&corrupt_database_doc),
            text("--json"),
        ],
        None,
    );
    assert!(!database_validation.status.success());
    let database_report = parse_json(&database_validation);
    assert_eq!(database_report["valid"], false);
    assert_eq!(database_report["issues"][0]["code"], "validation_failed");
    assert_eq!(database_report["database_user_version"], Value::Null);

    let oversized_version = run_raw(
        vec![
            text("db"),
            text("init"),
            argument(&doc),
            text("--version"),
            text("2147483648"),
        ],
        None,
    );
    assert!(!oversized_version.status.success());
    assert!(
        String::from_utf8_lossy(&oversized_version.stderr).contains("must not exceed 2147483647")
    );

    let safe_html_doc = directory.path().join("safe-html.tmd");
    let safe_html_output = directory.path().join("safe.html");
    let safe_html_linked_output = directory.path().join("safe-linked.html");
    let active_html = directory.path().join("active.html");
    fs::write(&active_html, "<script>alert('attachment')</script>")
        .expect("active HTML attachment");
    run(vec![text("new"), argument(&safe_html_doc)], None);
    run(
        vec![
            text("attachment"),
            text("add"),
            argument(&safe_html_doc),
            argument(&active_html),
            text("--path"),
            text("active.html"),
            text("--mime"),
            text("text/html"),
        ],
        None,
    );
    let safe_markdown = [
        "# Safe",
        "",
        "<script>alert('unsafe')</script>",
        "",
        "[script](javascript:alert(1))",
        "[mixed case](JaVaScRiPt:alert(2))",
        "[data](data:text/html,<script>alert(3)</script>)",
        "![remote pixel](//attacker.example/pixel)",
        "[attachment](attach:active.html)",
        "[safe](https://example.com/path)",
        "",
    ]
    .join("\n");
    let html_update = json!({
        "schema_version": 1,
        "markdown": safe_markdown,
    });
    run(
        vec![
            text("update"),
            argument(&safe_html_doc),
            text("--json-stdin"),
        ],
        Some(&html_update.to_string()),
    );
    run(
        vec![
            text("export-html"),
            argument(&safe_html_doc),
            argument(&safe_html_output),
            text("--self-contained"),
        ],
        None,
    );
    let html = fs::read_to_string(safe_html_output).expect("safe HTML output");
    assert!(!html.contains("<script>"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.to_ascii_lowercase().contains("href=\"javascript:"));
    assert!(html.matches("href=\"#\"").count() >= 3);
    assert!(html.contains("href=\"https://example.com/path\""));
    assert!(!html.to_ascii_lowercase().contains("href=\"data:text/html"));
    assert!(!html.contains("src=\"//attacker.example"));
    assert!(html.contains("<img src=\"#\" alt=\"remote pixel\""));
    assert!(html.contains("data:application/octet-stream;base64,"));

    run(
        vec![
            text("export-html"),
            argument(&safe_html_doc),
            argument(&safe_html_linked_output),
        ],
        None,
    );
    let linked_html = fs::read_to_string(safe_html_linked_output).expect("safe linked HTML output");
    let linked_asset = only_file_in(&directory.path().join("safe-linked_assets"));
    let linked_asset_name = linked_asset
        .file_name()
        .and_then(|name| name.to_str())
        .expect("UTF-8 asset name");
    assert!(linked_asset_name.ends_with(".bin"));
    let linked_asset_url = format!("safe-linked_assets/{linked_asset_name}");
    assert!(linked_html.contains(&format!(
        "<a download href=\"{linked_asset_url}\">attachment</a>"
    )));
    assert!(linked_html.contains(&format!(
        "<a download href=\"{linked_asset_url}\">active.html</a>"
    )));

    let original_document = fs::read(&safe_html_doc).expect("original document");
    let overwrite = run_raw(
        vec![
            text("export-html"),
            argument(&safe_html_doc),
            argument(&safe_html_doc),
            text("--self-contained"),
        ],
        None,
    );
    assert!(!overwrite.status.success());
    assert!(
        String::from_utf8_lossy(&overwrite.stderr).contains("refusing to overwrite input document")
    );
    assert_eq!(
        fs::read(&safe_html_doc).expect("preserved source document"),
        original_document
    );

    let database_overwrite = run_raw(
        vec![
            text("db"),
            text("export"),
            argument(&safe_html_doc),
            argument(&safe_html_doc),
        ],
        None,
    );
    assert!(!database_overwrite.status.success());
    assert!(String::from_utf8_lossy(&database_overwrite.stderr)
        .contains("refusing to overwrite input document"));
    assert_eq!(
        fs::read(&safe_html_doc).expect("preserved database export source"),
        original_document
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let converted_alias = directory.path().join("converted-alias.tmdp");
        symlink(&safe_html_doc, &converted_alias).expect("conversion symlink");
        let aliased_conversion = run_raw(
            vec![
                text("convert"),
                argument(&safe_html_doc),
                argument(&converted_alias),
            ],
            None,
        );
        assert!(!aliased_conversion.status.success());
        assert_eq!(
            fs::read(&safe_html_doc).expect("preserved conversion source"),
            original_document
        );

        let hard_link = directory.path().join("database-export-hard-link.tmd");
        fs::hard_link(&safe_html_doc, &hard_link).expect("database export hard link");
        let hard_link_overwrite = run_raw(
            vec![
                text("db"),
                text("export"),
                argument(&safe_html_doc),
                argument(&hard_link),
            ],
            None,
        );
        assert!(!hard_link_overwrite.status.success());
        assert_eq!(
            fs::read(&safe_html_doc).expect("preserved hard-linked source"),
            original_document
        );
    }

    let collision_doc = directory.path().join("collision.tmd");
    let collision_html = directory.path().join("collision.html");
    let first_source = directory.path().join("first.txt");
    let second_source = directory.path().join("second.txt");
    fs::write(&first_source, "first").expect("first collision fixture");
    fs::write(&second_source, "second").expect("second collision fixture");
    run(vec![text("new"), argument(&collision_doc)], None);
    for (source, logical_path) in [(&first_source, "a"), (&second_source, "a/b")] {
        run(
            vec![
                text("attachment"),
                text("add"),
                argument(&collision_doc),
                argument(source),
                text("--path"),
                text(logical_path),
                text("--mime"),
                text("text/plain"),
            ],
            None,
        );
    }
    run(
        vec![
            text("export-html"),
            argument(&collision_doc),
            argument(&collision_html),
        ],
        None,
    );
    let exported_contents: Vec<String> = fs::read_dir(directory.path().join("collision_assets"))
        .expect("collision-safe assets")
        .map(|entry| {
            fs::read_to_string(entry.expect("asset entry").path()).expect("asset contents")
        })
        .collect();
    assert_eq!(exported_contents.len(), 2);
    assert!(exported_contents.contains(&"first".to_owned()));
    assert!(exported_contents.contains(&"second".to_owned()));
}
