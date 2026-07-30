use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};
use tempfile::tempdir;

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
    assert!(linked.contains("linked_assets/assets/note.txt"));
    assert_eq!(
        fs::read_to_string(directory.path().join("linked_assets/assets/note.txt"))
            .expect("linked attachment"),
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

    let safe_html_doc = directory.path().join("safe-html.tmd");
    let safe_html_output = directory.path().join("safe.html");
    run(vec![text("new"), argument(&safe_html_doc)], None);
    let html_update = json!({
        "schema_version": 1,
        "markdown": "# Safe\n\n<script>alert('unsafe')</script>\n",
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
}
