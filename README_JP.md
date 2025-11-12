# 🦝 Tanu Markdown (TMD)

**Tanu Markdown (TMD)** は、通常の Markdown ファイルに **画像・データベース・添付リソースを同梱できる**
「自己完結型ドキュメント形式」を目指す新しい仕様です。

TMD は `.tmd` 拡張子を持ち、1 つのファイルに **Markdown本文 + 添付ファイル + メタ情報 (manifest)** を統合します。
これにより、ドキュメント単体で構造的・視覚的な再現性を維持できます。

---

## 📦 構成概要

| ディレクトリ | 内容 |
|--------------|------|
| `tmd-sample/` | `.tmd` / `.tmdz` サンプルと構造解説 |
| `tmd-vscode/` | VSCode 拡張の雛形 (TypeScript) |
| `tmd-core/` | Rust ライブラリコア (TMDドキュメント構造体と基本処理) |
| `tmd-cli/` | Rust CLI (TMDドキュメントを操作するツール) |

---

## 🛠 開発環境

### Docker でまとめて構築する

リポジトリには開発用の Docker イメージが含まれています。以下のコマンドでビルドし、対話的なシェルを起動できます。

```bash
docker compose build
docker compose run --rm dev bash
```

Rust / Cargo / Node.js / TypeScript など必要なツールが揃っており、ワークスペースはホストとマウントされます。

### VS Code Dev Container

VS Code の **Dev Containers** 拡張機能を利用すると、同じイメージを使ってフォルダーを直接コンテナー内で開けます。`.devcontainer` の設定により `rustfmt` / `clippy` のインストールと、VSCode 拡張向けの `npm install` が自動で実行されます。

---

## 🧩 ファイル形式概要

### `.tmd` — Polyglot 形式 (Markdown + ZIP)

```
+------------------------+
| Markdown (UTF-8 text)  |
+------------------------+
| ZIP archive (manifest, |
| images/, data/, etc.)  |
+------------------------+
| EOCD comment           |
|  TMD1\0<md_len_le64>   |
+------------------------+
```

### `.tmdz` — ZIP 形式

- `.tmd` を展開した構造をそのまま ZIP 化
- `index.md`, `manifest.json`, `images/`, `data/` を格納

---

## 🧰 各コンポーネント

### `tmd-vscode/`
VSCode 拡張 (MVP)。TypeScript 製で、次の機能を提供します：
- `.tmd` ファイルの新規作成
- `attach:` リンクの挿入
- バリデーション / `.tmdz` 変換（スタブ）

```bash
cd tmd-vscode
npm install
npm run compile
```

VSCode で `F5` を押すとデバッグ起動します。

### `tmd-core/`
Rust ライブラリ。
- `TmdDoc` 構造体: Markdown 本文, manifest, 添付ファイルを保持
- `to_bytes()` / `open_bytes()` : polyglot 形式の生成・読取 (未実装スタブ)

### `tmd-cli/`
Rust CLI。TMD ドキュメントを操作するためのコマンドラインツールです。

**利用可能なコマンド:**

#### ドキュメント操作
```bash
# 新しいドキュメントを作成
tmd new mydoc.tmd --title "マイドキュメント"

# .tmd と .tmdz 形式間の変換
tmd convert mydoc.tmd mydoc.tmdz
tmd convert mydoc.tmdz mydoc.tmd

# ドキュメントの検証
tmd validate mydoc.tmd

# HTML形式への出力
tmd export-html mydoc.tmd output.html
tmd export-html mydoc.tmd output.html --self-contained
```

#### データベース操作
```bash
# 埋め込みデータベースの初期化/リセット
tmd db init mydoc.tmd --schema schema.sql --version 1
tmd db init mydoc.tmd --version 2

# SQLクエリの実行
tmd db exec mydoc.tmd --sql "SELECT * FROM users"
tmd db exec mydoc.tmd --sql "INSERT INTO users (name) VALUES ('太郎')"

# SQLiteデータベースのインポート
tmd db import mydoc.tmd database.db

# 埋め込みデータベースの出力
tmd db export mydoc.tmd output.db
```

**使用例:**

```bash
# CLIのビルドと実行
cd tmd-cli
cargo build
cargo run -- --help

# ドキュメントの作成と操作
cargo run -- new example.tmd --title "サンプルドキュメント"
cargo run -- db init example.tmd --version 1
cargo run -- db exec example.tmd --sql "CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT)"
cargo run -- db exec example.tmd --sql "INSERT INTO notes (content) VALUES ('こんにちは、TMD!')"
cargo run -- db exec example.tmd --sql "SELECT * FROM notes"
cargo run -- validate example.tmd
cargo run -- export-html example.tmd example.html --self-contained
```

---

## 🧱 今後の展開

- [ ] `.tmd` 読み書き処理の実装
- [ ] VSCode 拡張での添付管理 UI
- [ ] HTML / PDF 出力機能
- [ ] SQLite・SQL ブロック評価
- [ ] 仕様書ドラフト化

---

## 📜 ライセンス

MIT License  
(c) 2025 Tanu Markdown Project

---

🧡 *Tanu Markdown — Markdown that packs everything inside.*
