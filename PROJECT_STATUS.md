# 🐾 Tanu Markdown — Project Status

_Last updated: 2025-10-09_

---

## 概要

**Tanu Markdown (TMD)** は、Markdown本文・埋め込みアセット・メタデータを  
**単一ファイルに統合する拡張Markdownフォーマット**です。

目的：

- Markdownと添付リソースを1つのファイルで持ち運び・配布できる  
- 添付ファイルの**整合性・再現性・検証可能性**を保証する  
- CLI / VSCode / Rustライブラリとして統一的に扱えるフォーマット基盤を提供する  

---

## フォーマット概要

| 形式 | 内容 | 用途 |
|------|------|------|
| `.tmd` | MarkdownとZIPを連結したポリグロット形式（ZIPコメントにMarkdown長を格納） | 配布・共有向け |
| `.tmdz` | 通常のZIP形式（`index.md`, `manifest.json`, `images/`, `data/`） | 編集・構築向け |

### `.tmd` ファイル構造（簡略）

```

+----------------------+ 0
| Markdown text        |
+----------------------+
| ZIP archive          |
| ├── index.md         |
| ├── manifest.json    |
| ├── images/...       |
| └── data/...         |
+----------------------+
| EOCD + "TMD1\0" + 8-byte length |
+----------------------+

```

---

## リポジトリ構成

| ディレクトリ | 内容 |
|---------------|------|
| `tmd-core/` | Rustライブラリコア：読み書き・検証・構造定義 |
| `tmd-cli/` | CLIツール：`pack`, `unpack`, `validate`, `export-html` など |
| `tmd-vscode/` | VSCode拡張：作成・添付管理・整合性チェックUI |
| `tmd-sample/` | フォーマット例・テスト用サンプル |
| `AGENT.md` | 自動補助エージェント向けの運用指針 |

---

## 現在の進行状況

### ✅ 実装済み
- `.tmd` 読み取り（MarkdownとZIPの分離）
  - EOCD検出・コメント解析 (`find_eocd_offset`)
  - Markdownサイズ取得・分離 (`split_tmd_bytes`)
  - manifestのサイズ／SHA256検証
  - ZIPコメント再設定ユーティリティ (`set_tmd_comment`)
- コードベース整備（`tmd-core` 内にread/validateロジック）

### 🚧 進行中
- `.tmd` 書き出しロジック (`to_bytes()`, `to_tmdz_bytes()`)
- CLI MVP構築（`pack/unpack/validate/export-html`）
- VSCode拡張スタブ（コマンドスケルトン）

### 💤 未着手
- formal spec ドキュメント
- CIによる往復テスト
- エクスポート（HTML/PDF）
- SQLite・署名ブロック統合（後期フェーズ）

---

## 今後のタスク（優先度順）

### 1️⃣ コア書き出し (`.tmd` 生成)
- Markdown + ZIP + EOCDコメント統合
- `.tmdz` ↔ `.tmd` 相互変換
- 大容量ファイル対応（ストリーミングZipWriter）

### 2️⃣ CLI MVP
- `tmd new` — プロジェクト雛形生成  
- `tmd pack/unpack` — フォーマット相互変換  
- `tmd validate` — manifest検証（サイズ・ハッシュ・スキーマ）  
- `tmd export-html` — 自己完結型HTML出力  

### 3️⃣ VSCode拡張
- `.tmd` 新規作成ウィザード  
- `attach:` リンクのドラッグ&ドロップ  
- 検証結果・エラーのUI表示  
- CLI機能呼び出し統合  

### 4️⃣ フォーマル仕様 (`docs/spec.md`)
- EOCDコメント形式・エンディアン定義  
- manifestスキーマとキー制約  
- パストラバーサル・ファイルサイズ制限  
- 将来の拡張ポリシー（バージョニング）

### 5️⃣ テスト・サンプル
- `tmd-sample/hello-world`（最小構成）  
- 壊れたZIPや不正manifestのテストケース  
- CIでの往復テスト（read→write→read）

### 6️⃣ 将来拡張
- SQLite埋め込み・読み取り専用クエリ  
- 暗号署名ブロックによる整合性保証  
- 完全自己完結型HTML/PDFエクスポート  

---

## 直近スプリント（短期目標）

| スプリント | 内容 | 目的 |
|-------------|------|------|
| **A. Writeパス実装** | `.tmd` 書き出しロジック追加 | 読み書き往復を可能に |
| **B. CLI MVP実装** | `pack/unpack/validate` 機能を提供 | 開発者が操作できるCLI環境の確立 |
| **C. サンプル整備** | `tmd-sample/hello-world` | 実例・回帰テスト両用データの作成 |

---

## 将来的なユースケース

- 技術文書・ノート・研究ログを**自己完結型で保存・共有**  
- 生成AIの出力・再現性確保に活用  
- Webやクラウド環境を介さない**安全なドキュメント流通形式**  

---

## ライセンスと著作権

このリポジトリの内容は、プロジェクトルートの `LICENSE` に従います。  
貢献者は同ライセンスに基づき、コード・ドキュメントを追加できます。

---

_Authored and maintained by the **Tanu Markdown Project** community._
