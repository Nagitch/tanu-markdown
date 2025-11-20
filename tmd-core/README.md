# tmd-core API ドキュメント

`tmd-core` は Tanu Markdown (`.tmd` / `.tmdz`) 文書を読み書きするための Rust ライブラリです。Markdown 本文、マニフェスト、添付ファイル、および組み込み SQLite データベースを 1 つの `TmdDoc` 構造体で管理します。本書では、利用者が主に使用する API をまとめます。

## 依存関係
Cargo.toml に次のように追記します。

```toml
[dependencies]
tmd-core = { path = "../tmd-core" }
mime = "0.3"
``` 

## 主要な型とエイリアス

- `TmdDoc` — Markdown、`Manifest`、`AttachmentStore`、`DbHandle` を保持する文書コンテナ。
- `Manifest` — バージョン、作成者、タグ、リンク、スキーマバージョンなどの文書メタデータを表現。`Semver` で TMD バージョンを保持。【F:tmd-core/src/lib.rs†L37-L87】【F:tmd-core/src/lib.rs†L211-L261】
- `AttachmentStore` — 添付ファイルのメタデータとバイト列を管理し、`AttachmentStoreIter` で列挙できる。【F:tmd-core/src/lib.rs†L213-L234】【F:tmd-core/src/lib.rs†L272-L360】
- `DbHandle` — SQLite 接続を保持し、`with_conn`/`with_conn_mut` 経由で SQL を実行。【F:tmd-core/src/lib.rs†L4-L8】【F:tmd-core/src/lib.rs†L104-L113】
- `Format` — `Tmd`（プレーン）と `Tmdz`（ZIP 包含形式）を識別。【F:tmd-core/src/lib.rs†L433-L453】
- `TmdResult<T>` / `TmdError` — ライブラリ全体で使用する Result/エラー型。【F:tmd-core/src/lib.rs†L21-L34】

## 文書の生成と保存

### 新規文書の作成

```rust
use mime::IMAGE_PNG;
use tmd_core::{write_to_path, AttachmentId, Format, TmdDoc};

fn main() -> tmd_core::TmdResult<()> {
    // Markdown 文字列から空の文書を生成
    let mut doc = TmdDoc::new("# Hello TMD".to_string())?;

    // 添付ファイルを追加（SHA-256 は自動計算され、重複パスはエラー）
    let _logo: AttachmentId = doc.add_attachment("images/logo.png", IMAGE_PNG, b"...bytes...")?;

    // 文書を TMDZ 形式で保存
    write_to_path("hello.tmdz", &doc, Format::Tmdz)?;
    Ok(())
}
```

- `TmdDoc::new` はデフォルトマニフェストと空の SQLite を初期化します。【F:tmd-core/src/lib.rs†L36-L101】
- `write_to_path` は `Format` に応じて `.tmd` または `.tmdz` を生成します。【F:tmd-core/src/lib.rs†L702-L726】
- 添付は論理パス衝突時に `TmdError::Attachment` を返します。【F:tmd-core/src/lib.rs†L272-L332】

### 既存文書の読み込み

```rust
use tmd_core::{read_from_path, Format, ReadMode};

fn main() -> tmd_core::TmdResult<()> {
    // 拡張子からフォーマット推測（Auto）
    let doc = read_from_path("hello.tmdz", None)?;
    println!("Title: {:?}, tags: {:?}", doc.manifest.title, doc.manifest.tags);

    // 検証やレイジー読み込みを制御したい場合
    use std::fs::File;
    use std::io::{BufReader, Seek};
    use tmd_core::{Reader, TmdDoc};

    let file = File::open("hello.tmdz")?;
    let mut reader = Reader::new(BufReader::new(file), Some(Format::Tmdz), ReadMode {
        verify_hashes: true,
        lazy_attachments: false,
    })?;
    let doc: TmdDoc = reader.read_doc()?;
    Ok(())
}
```

- `sniff_format` でヘッダーを見て自動判定します。【F:tmd-core/src/lib.rs†L433-L452】
- `ReadMode::verify_hashes` を `true` にすると、添付の長さや SHA-256 をチェックします。【F:tmd-core/src/lib.rs†L351-L387】
- `ReadMode::lazy_attachments` を `true` にすると添付を遅延ロードできます（デフォルトは `false`）。【F:tmd-core/src/lib.rs†L351-L387】

## 添付ファイル操作

- 追加: `add_attachment`（バッファ）または `add_attachment_stream`（ストリーム）。【F:tmd-core/src/lib.rs†L64-L92】【F:tmd-core/src/lib.rs†L92-L116】
- 削除: `remove_attachment(id)`。【F:tmd-core/src/lib.rs†L116-L125】
- リネーム: `rename_attachment(id, new_path)`（パス正規化込み）。【F:tmd-core/src/lib.rs†L125-L135】【F:tmd-core/src/lib.rs†L181-L202】
- メタ情報取得: `attachment_meta(id)` / `attachment_meta_by_path(path)`。【F:tmd-core/src/lib.rs†L135-L145】
- 一覧: `list_attachments()` で `AttachmentStoreIter` を返す。【F:tmd-core/src/lib.rs†L145-L154】
- データ参照: `attachments.data(id)` で `&[u8]`、`attachments.iter_with_data()` でメタとバイト列の組を列挙。【F:tmd-core/src/lib.rs†L334-L360】

## マニフェスト編集

`TmdDoc.manifest` を直接編集するか、`with_manifest` で置換します。

```rust
use tmd_core::{Manifest, Semver, TmdDoc};
use uuid::Uuid;

let manifest = Manifest {
    tmd_version: Semver { major: 1, minor: 0, patch: 0 },
    doc_id: Uuid::new_v4(),
    title: Some("Notebook".into()),
    authors: vec!["Alice".into()],
    created_utc: tmd_core::now_utc(),
    modified_utc: tmd_core::now_utc(),
    tags: vec!["demo".into()],
    cover_image: None,
    links: vec![],
    db_schema_version: None,
    extras: serde_json::json!({ "category": "sample" }),
};
let doc = TmdDoc::new("# Document".into())?.with_manifest(manifest);
```

`touch()` を呼ぶと `modified_utc` のみ現在時刻に更新されます。【F:tmd-core/src/lib.rs†L151-L158】

## 組み込みデータベースの利用

- 読み取り専用: `db_with_conn(|conn| { /* SELECT ... */ })`。【F:tmd-core/src/lib.rs†L104-L110】
- 書き込み: `db_with_conn_mut(|conn| { /* INSERT/UPDATE */ })`。処理後に自動で `rusqlite::Error` を `TmdError::Db` へ変換します。【F:tmd-core/src/lib.rs†L110-L113】【F:tmd-core/src/lib.rs†L34-L52】
- マイグレーション: `migrate(&mut doc, from, to, up_sql)` で `PRAGMA user_version` を検証しながらバージョンを進めます。【F:tmd-core/src/lib.rs†L361-L422】

## 読み書きオプション

- `ReadMode` — `verify_hashes`（添付のハッシュ検証）、`lazy_attachments`（遅延読込）。【F:tmd-core/src/lib.rs†L351-L387】
- `WriteMode` — `compute_hashes`（添付の SHA-256 出力）、`solid_zip`（ZIP を単一ストリームで格納）、`dedup_by_hash`（添付の重複排除）。【F:tmd-core/src/lib.rs†L387-L431】
- `Writer::write_doc` / `Reader::read_doc` で `Format` とモードを指定できます。【F:tmd-core/src/lib.rs†L453-L501】【F:tmd-core/src/lib.rs†L431-L453】

## エラー処理

すべての関数は `TmdResult<T>` を返し、失敗時は `TmdError` を返します。

- I/O: `TmdError::Io`
- JSON: `TmdError::Json`
- ZIP: `TmdError::Zip`
- 添付管理: `TmdError::Attachment`（重複、ハッシュ不一致、パスの検証エラーなど）
- フォーマット: `TmdError::InvalidFormat`（EOCD 署名不正、コメント長不正など）
- DB: `TmdError::Db`（`rusqlite` エラーを文字列化）【F:tmd-core/src/lib.rs†L21-L53】【F:tmd-core/src/lib.rs†L598-L679】

## FFI（オプション）

`ffi` フィーチャを有効化すると、C 互換関数で文書の読み書きやエラー取得が可能になります。主なエントリーポイントは以下です。【F:tmd-core/src/lib.rs†L728-L1207】

- `tmd_doc_new` / `tmd_doc_free`
- `tmd_read_from_path` / `tmd_write_to_path`
- `tmd_last_error_message`
- `tmd_doc_markdown`（Markdown 取得）、`tmd_doc_set_markdown`（設定）

FFI 層ではポインタの NULL チェックや UTF-8 変換エラーを専用メッセージとして保持します。

## 典型的なワークフロー

1. `TmdDoc::new` で文書作成、または `read_from_path` で既存文書をロード。
2. Markdown 編集・マニフェスト更新・添付追加／削除。
3. 必要に応じて `db_with_conn_mut` で DB を更新、`migrate` でスキーマを進める。
4. `write_to_path` / `Writer` で `.tmd` または `.tmdz` に保存。

`write_tmdz` / `write_tmd` を直接使う場合は、`WriteMode` でハッシュ計算や ZIP オプションを制御できます。【F:tmd-core/src/lib.rs†L598-L679】

