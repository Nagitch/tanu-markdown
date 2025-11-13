//! Core library for handling Tanu Markdown documents.

pub use attach::{AttachmentDataMut, AttachmentStore, AttachmentStoreIter};
pub use db::{
    export_db, import_db, migrate, reset_db, with_conn, with_conn_mut, DbHandle, DbOptions,
};
pub use format::{
    read_from_path, read_tmd, read_tmdz, sniff_format, write_tmd, write_tmdz, write_to_path,
    Format, ReadMode, Reader, WriteMode, Writer,
};
pub use manifest::{AttachmentMeta, AttachmentRef, LinkRef, Manifest, Semver};
pub use util::{normalize_logical_path, now_utc};

use mime::Mime;
use rusqlite::Connection;
use thiserror::Error;
use uuid::Uuid;

pub type AttachmentId = Uuid;
pub type LogicalPath = String;

/// Result type specialised for `tmd-core` operations.
pub type TmdResult<T> = Result<T, TmdError>;

/// Error type covering the operations provided by this crate.
#[derive(Debug, Error)]
pub enum TmdError {
    /// Wrapper around standard I/O errors.
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    /// Wrapper for JSON serialisation and deserialisation errors.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    /// Wrapper for ZIP processing errors.
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    /// Indicates that an attachment already exists or is invalid.
    #[error("attachment error: {0}")]
    Attachment(String),
    /// Indicates invalid TMD formatting or structure.
    #[error("invalid format: {0}")]
    InvalidFormat(String),
    /// Wrapper for SQLite related errors.
    #[error("sqlite: {0}")]
    Db(String),
}

impl From<rusqlite::Error> for TmdError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Db(err.to_string())
    }
}

/// Document representation that holds the Markdown, manifest, attachments, and database handle.
#[derive(Debug)]
pub struct TmdDoc {
    pub markdown: String,
    pub manifest: Manifest,
    pub attachments: AttachmentStore,
    pub db: DbHandle,
}

impl TmdDoc {
    /// Create a new in-memory document with an empty SQLite database.
    pub fn new(markdown: String) -> TmdResult<Self> {
        let mut db = DbHandle::new_empty()?;
        db.ensure_initialized(None)?;

        let now = now_utc();
        let manifest = Manifest {
            tmd_version: Semver {
                major: 1,
                minor: 0,
                patch: 0,
            },
            doc_id: Uuid::new_v4(),
            title: None,
            authors: Vec::new(),
            created_utc: now,
            modified_utc: now,
            tags: Vec::new(),
            cover_image: None,
            links: Vec::new(),
            db_schema_version: None,
            extras: serde_json::Value::default(),
        };

        Ok(Self {
            markdown,
            manifest,
            attachments: AttachmentStore::new(),
            db,
        })
    }

    /// Replace the document manifest, returning the updated document.
    pub fn with_manifest(mut self, manifest: Manifest) -> Self {
        self.manifest = manifest;
        self
    }

    fn add_attachment_inner(
        &mut self,
        logical_path: &str,
        mime: Mime,
        bytes: Vec<u8>,
    ) -> TmdResult<AttachmentId> {
        let id = Uuid::new_v4();
        let path = normalize_logical_path(logical_path)?;
        self.attachments.insert(id, path, mime, bytes)
    }

    /// Add an attachment using an owned byte buffer.
    pub fn add_attachment<B: Into<Vec<u8>>>(
        &mut self,
        logical_path: &str,
        mime: Mime,
        bytes: B,
    ) -> TmdResult<AttachmentId> {
        self.add_attachment_inner(logical_path, mime, bytes.into())
    }

    /// Add an attachment from a stream, buffering it in memory.
    pub fn add_attachment_stream<R: std::io::Read + Send + 'static>(
        &mut self,
        logical_path: &str,
        mime: Mime,
        mut reader: R,
    ) -> TmdResult<AttachmentId> {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;
        self.add_attachment_inner(logical_path, mime, buf)
    }

    /// Remove an attachment by ID.
    pub fn remove_attachment(&mut self, id: AttachmentId) -> TmdResult<()> {
        self.attachments
            .remove(id)
            .map_err(|e| TmdError::Attachment(e.to_string()))
    }

    /// Rename an attachment to a new logical path.
    pub fn rename_attachment(&mut self, id: AttachmentId, new_logical_path: &str) -> TmdResult<()> {
        let path = normalize_logical_path(new_logical_path)?;
        self.attachments.rename(id, path)
    }

    /// Get attachment metadata by ID.
    pub fn attachment_meta(&self, id: AttachmentId) -> Option<&AttachmentMeta> {
        self.attachments.meta(id)
    }

    /// Get attachment metadata by logical path.
    pub fn attachment_meta_by_path(&self, logical_path: &str) -> Option<&AttachmentMeta> {
        self.attachments.meta_by_path(logical_path)
    }

    /// List all attachment metadata.
    pub fn list_attachments(&self) -> AttachmentStoreIter<'_> {
        self.attachments.iter()
    }

    /// Execute a read-only closure with a SQLite connection.
    pub fn db_with_conn<T, F: FnOnce(&Connection) -> T>(&self, f: F) -> TmdResult<T> {
        self.db.with_conn(f)
    }

    /// Execute a mutable closure with a SQLite connection.
    pub fn db_with_conn_mut<T, F: FnOnce(&mut Connection) -> T>(&mut self, f: F) -> TmdResult<T> {
        self.db.with_conn_mut(f)
    }
}

/// Utility helper to set the manifest modification timestamp to now.
fn touch_manifest(manifest: &mut Manifest) {
    manifest.modified_utc = now_utc();
}

impl TmdDoc {
    /// Update the modified timestamp to the current time.
    pub fn touch(&mut self) {
        touch_manifest(&mut self.manifest);
    }
}
mod util {
    use super::{LogicalPath, TmdError, TmdResult};
    use chrono::{DateTime, Utc};

    /// Return the current UTC time.
    pub fn now_utc() -> DateTime<Utc> {
        Utc::now()
    }

    /// Normalise a logical attachment path, ensuring POSIX separators and security constraints.
    pub fn normalize_logical_path(input: &str) -> TmdResult<LogicalPath> {
        if input.is_empty() {
            return Err(TmdError::Attachment(
                "logical path must not be empty".into(),
            ));
        }

        if input.starts_with('/') {
            return Err(TmdError::Attachment(
                "logical path must not start with '/'".into(),
            ));
        }

        let normalized = input.replace('\\', "/");
        let mut components = Vec::new();
        for part in normalized.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            if part == ".." {
                return Err(TmdError::Attachment(
                    "logical path must not contain '..'".into(),
                ));
            }
            components.push(part);
        }

        if components.is_empty() {
            return Err(TmdError::Attachment(
                "logical path resolves to empty".into(),
            ));
        }

        Ok(components.join("/"))
    }
}
mod manifest {
    use super::{AttachmentId, LogicalPath};
    use chrono::{DateTime, Utc};
    use mime::Mime;
    use serde::{Deserialize, Serialize};
    use uuid::Uuid;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Semver {
        pub major: u16,
        pub minor: u16,
        pub patch: u16,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct AttachmentRef {
        pub id: AttachmentId,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct LinkRef {
        pub rel: String,
        pub href: String,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Manifest {
        pub tmd_version: Semver,
        pub doc_id: Uuid,
        pub title: Option<String>,
        pub authors: Vec<String>,
        pub created_utc: DateTime<Utc>,
        pub modified_utc: DateTime<Utc>,
        pub tags: Vec<String>,
        pub cover_image: Option<AttachmentRef>,
        pub links: Vec<LinkRef>,
        pub db_schema_version: Option<u32>,
        #[serde(default)]
        pub extras: serde_json::Value,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct AttachmentMeta {
        pub id: AttachmentId,
        pub logical_path: LogicalPath,
        #[serde(with = "mime_serde")]
        pub mime: Mime,
        pub length: u64,
        #[serde(default, with = "sha_option")]
        pub sha256: Option<[u8; 32]>,
        pub title: Option<String>,
        pub alt: Option<String>,
        #[serde(default)]
        pub extras: serde_json::Value,
    }

    mod mime_serde {
        use super::Mime;
        use serde::de::Error as DeError;
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S>(mime: &Mime, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            serializer.serialize_str(mime.as_ref())
        }

        pub fn deserialize<'de, D>(deserializer: D) -> Result<Mime, D::Error>
        where
            D: Deserializer<'de>,
        {
            let s = String::deserialize(deserializer)?;
            s.parse().map_err(|_| DeError::custom("invalid MIME type"))
        }
    }

    mod sha_option {
        use serde::de::Error as DeError;
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S>(value: &Option<[u8; 32]>, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            match value {
                Some(bytes) => serializer.serialize_some(&hex::encode(bytes)),
                None => serializer.serialize_none(),
            }
        }

        pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<[u8; 32]>, D::Error>
        where
            D: Deserializer<'de>,
        {
            let opt = Option::<String>::deserialize(deserializer)?;
            match opt {
                Some(s) => {
                    let decoded = hex::decode(&s).map_err(|_| DeError::custom("invalid hex"))?;
                    if decoded.len() != 32 {
                        return Err(DeError::custom("invalid sha256 length"));
                    }
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&decoded);
                    Ok(Some(arr))
                }
                None => Ok(None),
            }
        }
    }
}
mod attach {
    use super::{AttachmentId, AttachmentMeta, LogicalPath, TmdError, TmdResult};
    use mime::Mime;
    use serde_json;
    use sha2::{Digest, Sha256};
    use std::collections::{hash_map::Values, HashMap};
    use std::ops::{Deref, DerefMut};

    #[derive(Debug)]
    struct AttachmentEntry {
        meta: AttachmentMeta,
        data: Vec<u8>,
    }

    #[derive(Debug, Default)]
    pub struct AttachmentStore {
        entries: HashMap<AttachmentId, AttachmentEntry>,
        by_path: HashMap<LogicalPath, AttachmentId>,
    }

    impl AttachmentStore {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn insert(
            &mut self,
            id: AttachmentId,
            logical_path: LogicalPath,
            mime: Mime,
            data: Vec<u8>,
        ) -> TmdResult<AttachmentId> {
            if self.entries.contains_key(&id) {
                return Err(TmdError::Attachment(format!(
                    "attachment id {} already exists",
                    id
                )));
            }
            if self.by_path.contains_key(&logical_path) {
                return Err(TmdError::Attachment(format!(
                    "attachment `{}` already exists",
                    logical_path
                )));
            }

            let length = data.len() as u64;
            let sha = Sha256::digest(&data);
            let mut sha_bytes = [0u8; 32];
            sha_bytes.copy_from_slice(&sha);
            let meta = AttachmentMeta {
                id,
                logical_path: logical_path.clone(),
                mime,
                length,
                sha256: Some(sha_bytes),
                title: None,
                alt: None,
                extras: serde_json::Value::default(),
            };
            self.by_path.insert(logical_path.clone(), id);
            self.entries.insert(id, AttachmentEntry { meta, data });
            Ok(id)
        }

        pub fn remove(&mut self, id: AttachmentId) -> Result<(), String> {
            if let Some(entry) = self.entries.remove(&id) {
                self.by_path.remove(&entry.meta.logical_path);
                Ok(())
            } else {
                Err(format!("attachment id {} not found", id))
            }
        }

        pub fn rename(&mut self, id: AttachmentId, new_path: LogicalPath) -> TmdResult<()> {
            if self.by_path.contains_key(&new_path) {
                return Err(TmdError::Attachment(format!(
                    "attachment `{}` already exists",
                    new_path
                )));
            }
            let entry = self
                .entries
                .get_mut(&id)
                .ok_or_else(|| TmdError::Attachment(format!("attachment id {} not found", id)))?;
            self.by_path.remove(&entry.meta.logical_path);
            self.by_path.insert(new_path.clone(), id);
            entry.meta.logical_path = new_path;
            Ok(())
        }

        pub fn meta(&self, id: AttachmentId) -> Option<&AttachmentMeta> {
            self.entries.get(&id).map(|entry| &entry.meta)
        }

        pub fn meta_by_path(&self, logical_path: &str) -> Option<&AttachmentMeta> {
            self.by_path
                .get(logical_path)
                .and_then(|id| self.entries.get(id))
                .map(|entry| &entry.meta)
        }

        pub fn data(&self, id: AttachmentId) -> Option<&[u8]> {
            self.entries.get(&id).map(|entry| entry.data.as_slice())
        }

        pub fn data_mut(&mut self, id: AttachmentId) -> Option<AttachmentDataMut<'_>> {
            self.entries
                .get_mut(&id)
                .map(|entry| AttachmentDataMut { entry })
        }

        pub fn iter(&self) -> AttachmentStoreIter<'_> {
            AttachmentStoreIter {
                inner: self.entries.values(),
            }
        }

        pub fn iter_with_data(&self) -> impl Iterator<Item = (&AttachmentMeta, &[u8])> {
            self.entries
                .values()
                .map(|entry| (&entry.meta, entry.data.as_slice()))
        }

        pub fn is_empty(&self) -> bool {
            self.entries.is_empty()
        }

        pub fn insert_entry(
            &mut self,
            meta: AttachmentMeta,
            data: Vec<u8>,
            verify_hashes: bool,
        ) -> TmdResult<()> {
            if self.entries.contains_key(&meta.id) {
                return Err(TmdError::Attachment(format!(
                    "attachment id {} already exists",
                    meta.id
                )));
            }
            if self.by_path.contains_key(&meta.logical_path) {
                return Err(TmdError::Attachment(format!(
                    "attachment `{}` already exists",
                    meta.logical_path
                )));
            }
            let length = data.len() as u64;
            if length != meta.length {
                return Err(TmdError::Attachment(format!(
                    "attachment `{}` length mismatch: manifest={} actual={}",
                    meta.logical_path, meta.length, length
                )));
            }
            if verify_hashes {
                if let Some(expected) = &meta.sha256 {
                    let digest = Sha256::digest(&data);
                    let mut computed = [0u8; 32];
                    computed.copy_from_slice(&digest);
                    if expected != &computed {
                        return Err(TmdError::Attachment(format!(
                            "attachment `{}` sha256 mismatch",
                            meta.logical_path
                        )));
                    }
                }
            }
            self.by_path.insert(meta.logical_path.clone(), meta.id);
            self.entries.insert(meta.id, AttachmentEntry { meta, data });
            Ok(())
        }
    }

    pub struct AttachmentDataMut<'a> {
        entry: &'a mut AttachmentEntry,
    }

    impl<'a> Deref for AttachmentDataMut<'a> {
        type Target = Vec<u8>;

        fn deref(&self) -> &Self::Target {
            &self.entry.data
        }
    }

    impl<'a> DerefMut for AttachmentDataMut<'a> {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.entry.data
        }
    }

    impl<'a> Drop for AttachmentDataMut<'a> {
        fn drop(&mut self) {
            self.entry.meta.length = self.entry.data.len() as u64;
            let digest = Sha256::digest(&self.entry.data);
            let mut sha = [0u8; 32];
            sha.copy_from_slice(&digest);
            self.entry.meta.sha256 = Some(sha);
        }
    }

    pub struct AttachmentStoreIter<'a> {
        inner: Values<'a, AttachmentId, AttachmentEntry>,
    }

    impl<'a> Iterator for AttachmentStoreIter<'a> {
        type Item = &'a AttachmentMeta;

        fn next(&mut self) -> Option<Self::Item> {
            self.inner.next().map(|entry| &entry.meta)
        }
    }
}
mod db {
    use super::{TmdDoc, TmdError, TmdResult};
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    #[derive(Clone, Debug, Default)]
    pub struct DbOptions {
        pub page_size: Option<u32>,
        pub journal_mode: Option<String>,
        pub synchronous: Option<String>,
    }

    #[derive(Debug)]
    pub struct DbHandle {
        _temp_dir: TempDir,
        path: PathBuf,
    }

    impl DbHandle {
        pub fn new_empty() -> TmdResult<Self> {
            let temp_dir = TempDir::new()?;
            let path = temp_dir.path().join("main.sqlite3");
            let conn = Connection::open(&path)?;
            conn.execute_batch("PRAGMA user_version = 0;")?;
            conn.close()
                .map_err(|(_, err)| TmdError::Db(err.to_string()))?;
            Ok(Self {
                _temp_dir: temp_dir,
                path,
            })
        }

        pub fn from_bytes(bytes: &[u8]) -> TmdResult<Self> {
            let temp_dir = TempDir::new()?;
            let path = temp_dir.path().join("main.sqlite3");
            fs::write(&path, bytes)?;
            Ok(Self {
                _temp_dir: temp_dir,
                path,
            })
        }

        pub fn ensure_initialized(&mut self, opts: Option<DbOptions>) -> TmdResult<()> {
            let mut conn = Connection::open(&self.path)?;
            if let Some(opts) = opts {
                apply_options(&mut conn, &opts)?;
            }
            conn.close()
                .map_err(|(_, err)| TmdError::Db(err.to_string()))?;
            Ok(())
        }

        pub fn with_conn<T, F: FnOnce(&Connection) -> T>(&self, f: F) -> TmdResult<T> {
            let conn = Connection::open(&self.path)?;
            let result = f(&conn);
            conn.close()
                .map_err(|(_, err)| TmdError::Db(err.to_string()))?;
            Ok(result)
        }

        pub fn with_conn_mut<T, F: FnOnce(&mut Connection) -> T>(&mut self, f: F) -> TmdResult<T> {
            let mut conn = Connection::open(&self.path)?;
            let result = f(&mut conn);
            conn.close()
                .map_err(|(_, err)| TmdError::Db(err.to_string()))?;
            Ok(result)
        }

        pub fn as_path(&self) -> &Path {
            &self.path
        }
    }

    fn apply_options(conn: &mut Connection, opts: &DbOptions) -> TmdResult<()> {
        if let Some(page_size) = opts.page_size {
            conn.pragma_update(None, "page_size", page_size)?;
        }
        if let Some(mode) = &opts.journal_mode {
            conn.pragma_update(None, "journal_mode", mode.as_str())?;
        }
        if let Some(sync) = &opts.synchronous {
            conn.pragma_update(None, "synchronous", sync.as_str())?;
        }
        Ok(())
    }

    pub fn with_conn<T, F: FnOnce(&Connection) -> T>(doc: &TmdDoc, f: F) -> TmdResult<T> {
        doc.db.with_conn(f)
    }

    pub fn with_conn_mut<T, F: FnOnce(&mut Connection) -> T>(
        doc: &mut TmdDoc,
        f: F,
    ) -> TmdResult<T> {
        doc.db.with_conn_mut(f)
    }

    pub fn export_db(doc: &TmdDoc, out_path: impl AsRef<Path>) -> TmdResult<()> {
        let out = out_path.as_ref();
        fs::copy(doc.db.as_path(), out)?;
        Ok(())
    }

    pub fn import_db(doc: &mut TmdDoc, in_path: impl AsRef<Path>) -> TmdResult<()> {
        let bytes = fs::read(in_path)?;
        fs::write(doc.db.as_path(), bytes)?;
        Ok(())
    }

    pub fn reset_db(doc: &mut TmdDoc, schema_sql: &str, version: u32) -> TmdResult<()> {
        doc.db
            .with_conn_mut(|conn| -> rusqlite::Result<()> {
                conn.execute_batch("VACUUM;")?;
                conn.execute_batch(schema_sql)?;
                conn.pragma_update(None, "user_version", version as i64)?;
                Ok(())
            })?
            .map_err(TmdError::from)?;
        Ok(())
    }

    pub fn migrate(doc: &mut TmdDoc, up_sql: &str, from: u32, to: u32) -> TmdResult<()> {
        let current: u32 = doc
            .db
            .with_conn(|conn| conn.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0)))
            .and_then(|res| res.map_err(super::TmdError::from))?;
        if current != from {
            return Err(super::TmdError::Db(format!(
                "expected user_version {} but found {}",
                from, current
            )));
        }
        doc.db
            .with_conn_mut(|conn| -> rusqlite::Result<()> {
                conn.execute_batch(up_sql)?;
                conn.pragma_update(None, "user_version", to as i64)?;
                Ok(())
            })?
            .map_err(TmdError::from)?;
        Ok(())
    }
}
mod format {
    use super::attach::AttachmentStore;
    use super::db::DbHandle;
    use super::manifest::{AttachmentMeta, Manifest};
    use super::{TmdDoc, TmdError, TmdResult};
    use serde::{Deserialize, Serialize};
    use serde_json;
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::Path;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipArchive, ZipWriter};

    const EOCD_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const MAX_COMMENT_SEARCH: usize = 0xFFFF + 22;
    const TMD_COMMENT_PREFIX: &[u8] = b"TMD1\0";

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Format {
        Tmd,
        Tmdz,
    }

    pub fn sniff_format(header: &[u8]) -> Option<Format> {
        if header.len() >= 4 && &header[0..4] == b"PK\x03\x04" {
            Some(Format::Tmdz)
        } else if !header.is_empty() {
            Some(Format::Tmd)
        } else {
            None
        }
    }

    #[derive(Clone, Copy, Debug)]
    pub struct ReadMode {
        pub verify_hashes: bool,
        pub lazy_attachments: bool,
    }

    impl Default for ReadMode {
        fn default() -> Self {
            Self {
                verify_hashes: true,
                lazy_attachments: false,
            }
        }
    }

    #[derive(Clone, Copy, Debug)]
    pub struct WriteMode {
        pub compute_hashes: bool,
        pub solid_zip: bool,
        pub dedup_by_hash: bool,
    }

    impl Default for WriteMode {
        fn default() -> Self {
            Self {
                compute_hashes: true,
                solid_zip: false,
                dedup_by_hash: false,
            }
        }
    }

    pub struct Reader<'a, R: Read + Seek> {
        inner: R,
        format: Format,
        mode: ReadMode,
        _marker: std::marker::PhantomData<&'a ()>,
    }

    impl<'a, R: Read + Seek> Reader<'a, R> {
        pub fn new(mut inner: R, assumed: Option<Format>, mode: ReadMode) -> TmdResult<Self> {
            let format = if let Some(format) = assumed {
                format
            } else {
                let mut header = [0u8; 8];
                let read = inner.read(&mut header)?;
                inner.seek(SeekFrom::Start(0))?;
                sniff_format(&header[..read])
                    .ok_or_else(|| TmdError::InvalidFormat("unable to sniff format".into()))?
            };

            Ok(Self {
                inner,
                format,
                mode,
                _marker: std::marker::PhantomData,
            })
        }

        pub fn read_doc(&mut self) -> TmdResult<TmdDoc> {
            match self.format {
                Format::Tmd => read_tmd(&mut self.inner, self.mode),
                Format::Tmdz => read_tmdz(&mut self.inner, self.mode),
            }
        }
    }

    pub struct Writer<'a, W: Write + Seek> {
        inner: W,
        format: Format,
        mode: WriteMode,
        _marker: std::marker::PhantomData<&'a ()>,
    }

    impl<'a, W: Write + Seek> Writer<'a, W> {
        pub fn new(inner: W, format: Format, mode: WriteMode) -> TmdResult<Self> {
            Ok(Self {
                inner,
                format,
                mode,
                _marker: std::marker::PhantomData,
            })
        }

        pub fn write_doc(&mut self, doc: &TmdDoc) -> TmdResult<()> {
            match self.format {
                Format::Tmd => write_tmd(&mut self.inner, doc, self.mode),
                Format::Tmdz => write_tmdz(&mut self.inner, doc, self.mode),
            }
        }

        pub fn finish(self) -> TmdResult<()> {
            Ok(())
        }
    }

    #[derive(Serialize, Deserialize)]
    struct AttachmentManifest {
        attachments: Vec<AttachmentMeta>,
    }

    fn find_eocd_offset(data: &[u8]) -> TmdResult<usize> {
        let min_len = 22;
        if data.len() < min_len {
            return Err(TmdError::InvalidFormat(
                "input too small to contain EOCD".into(),
            ));
        }
        let search_start = if data.len() > MAX_COMMENT_SEARCH {
            data.len() - MAX_COMMENT_SEARCH
        } else {
            0
        };

        for idx in (search_start..=data.len() - min_len).rev() {
            if &data[idx..idx + 4] == EOCD_SIGNATURE {
                return Ok(idx);
            }
        }

        Err(TmdError::InvalidFormat(
            "ZIP EOCD signature not found".into(),
        ))
    }

    fn extract_markdown_len_from_comment(comment: &[u8]) -> TmdResult<u64> {
        if !comment.starts_with(TMD_COMMENT_PREFIX) {
            return Err(TmdError::InvalidFormat(
                "missing TMD comment signature".into(),
            ));
        }
        let expected_len = TMD_COMMENT_PREFIX.len() + 8;
        if comment.len() != expected_len {
            return Err(TmdError::InvalidFormat(format!(
                "unexpected TMD comment length: expected {} bytes, got {}",
                expected_len,
                comment.len()
            )));
        }
        let mut len_bytes = [0u8; 8];
        len_bytes.copy_from_slice(&comment[TMD_COMMENT_PREFIX.len()..]);
        Ok(u64::from_le_bytes(len_bytes))
    }

    fn split_tmd_bytes(bytes: &[u8]) -> TmdResult<(&[u8], &[u8])> {
        let eocd_offset = find_eocd_offset(bytes)?;
        if eocd_offset + 22 > bytes.len() {
            return Err(TmdError::InvalidFormat(
                "EOCD extends past end of buffer".into(),
            ));
        }
        let comment_len_start = eocd_offset + 20;
        let comment_len =
            u16::from_le_bytes([bytes[comment_len_start], bytes[comment_len_start + 1]]) as usize;
        let comment_start = eocd_offset + 22;
        if comment_start + comment_len > bytes.len() {
            return Err(TmdError::InvalidFormat(
                "EOCD comment length exceeds buffer".into(),
            ));
        }
        let comment = &bytes[comment_start..comment_start + comment_len];
        let markdown_len = extract_markdown_len_from_comment(comment)? as usize;
        if markdown_len > bytes.len() {
            return Err(TmdError::InvalidFormat(
                "markdown length exceeds buffer".into(),
            ));
        }
        let (markdown, zip_bytes) = bytes.split_at(markdown_len);
        Ok((markdown, zip_bytes))
    }

    fn read_manifest_from_zip<R: Read + Seek>(zip: &mut ZipArchive<R>) -> TmdResult<Manifest> {
        let mut file = zip.by_name("manifest.json")?;
        let mut buf = String::new();
        file.read_to_string(&mut buf)?;
        let manifest: Manifest = serde_json::from_str(&buf)?;
        Ok(manifest)
    }

    fn read_markdown_from_zip<R: Read + Seek>(zip: &mut ZipArchive<R>) -> TmdResult<String> {
        let mut file = zip.by_name("index.md")?;
        let mut markdown = String::new();
        file.read_to_string(&mut markdown)?;
        Ok(markdown)
    }

    fn read_attachment_manifest<R: Read + Seek>(
        zip: &mut ZipArchive<R>,
    ) -> TmdResult<Vec<AttachmentMeta>> {
        let mut file = zip.by_name("attachments.json")?;
        let mut buf = String::new();
        file.read_to_string(&mut buf)?;
        let manifest: AttachmentManifest = serde_json::from_str(&buf)?;
        Ok(manifest.attachments)
    }

    fn read_db_from_zip<R: Read + Seek>(zip: &mut ZipArchive<R>) -> TmdResult<DbHandle> {
        let mut file = zip.by_name("db/main.sqlite3")?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        if bytes.len() < 16 || &bytes[..16] != b"SQLite format 3\0" {
            return Err(TmdError::InvalidFormat(
                "db/main.sqlite3 is not a SQLite database".into(),
            ));
        }
        DbHandle::from_bytes(&bytes)
    }

    fn read_doc_from_zip<R: Read + Seek>(
        zip: &mut ZipArchive<R>,
        mode: ReadMode,
    ) -> TmdResult<TmdDoc> {
        let markdown = read_markdown_from_zip(zip)?;
        let manifest = read_manifest_from_zip(zip)?;
        let attachment_metas = read_attachment_manifest(zip)?;

        let mut attachments = AttachmentStore::new();
        for meta in attachment_metas {
            let mut file = zip.by_name(&meta.logical_path)?;
            let mut data = Vec::new();
            file.read_to_end(&mut data)?;
            attachments.insert_entry(meta, data, mode.verify_hashes)?;
        }

        let mut db = read_db_from_zip(zip)?;
        db.ensure_initialized(None)?;

        Ok(TmdDoc {
            markdown,
            manifest,
            attachments,
            db,
        })
    }

    pub fn read_tmd<R: Read + Seek>(reader: &mut R, mode: ReadMode) -> TmdResult<TmdDoc> {
        reader.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        let (markdown_bytes, zip_bytes) = split_tmd_bytes(&bytes)?;
        let markdown = String::from_utf8(markdown_bytes.to_vec())
            .map_err(|_| TmdError::InvalidFormat("markdown section is not valid UTF-8".into()))?;
        let cursor = std::io::Cursor::new(zip_bytes.to_vec());
        let mut zip = ZipArchive::new(cursor)?;
        let mut doc = read_doc_from_zip(&mut zip, mode)?;
        doc.markdown = markdown;
        Ok(doc)
    }

    pub fn read_tmdz<R: Read + Seek>(reader: &mut R, mode: ReadMode) -> TmdResult<TmdDoc> {
        reader.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = ZipArchive::new(cursor)?;
        read_doc_from_zip(&mut zip, mode)
    }

    fn set_tmd_comment(zip_bytes: &mut Vec<u8>, markdown_len: u64) -> TmdResult<()> {
        let eocd_offset = find_eocd_offset(zip_bytes)?;
        if eocd_offset + 22 > zip_bytes.len() {
            return Err(TmdError::InvalidFormat(
                "EOCD extends past end of ZIP buffer".into(),
            ));
        }
        let comment_data = {
            let mut buf = Vec::with_capacity(TMD_COMMENT_PREFIX.len() + 8);
            buf.extend_from_slice(TMD_COMMENT_PREFIX);
            buf.extend_from_slice(&markdown_len.to_le_bytes());
            buf
        };
        if comment_data.len() > u16::MAX as usize {
            return Err(TmdError::InvalidFormat(
                "TMD comment would exceed ZIP comment limit".into(),
            ));
        }
        let comment_len_pos = eocd_offset + 20;
        let comment_start = eocd_offset + 22;
        let comment_len_bytes = (comment_data.len() as u16).to_le_bytes();
        zip_bytes[comment_len_pos] = comment_len_bytes[0];
        zip_bytes[comment_len_pos + 1] = comment_len_bytes[1];
        zip_bytes.truncate(comment_start);
        zip_bytes.extend_from_slice(&comment_data);
        Ok(())
    }

    fn build_zip(doc: &TmdDoc, _mode: WriteMode) -> TmdResult<Vec<u8>> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let stored = FileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);

        // manifest
        writer.start_file("manifest.json", stored)?;
        let manifest_json = serde_json::to_vec_pretty(&doc.manifest)?;
        writer.write_all(&manifest_json)?;

        // attachments manifest
        let mut attachment_metas: Vec<AttachmentMeta> = doc.attachments.iter().cloned().collect();
        attachment_metas.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
        let attachments_json = serde_json::to_vec_pretty(&AttachmentManifest {
            attachments: attachment_metas.clone(),
        })?;

        // index.md
        writer.start_file("index.md", stored)?;
        writer.write_all(doc.markdown.as_bytes())?;

        writer.start_file("attachments.json", stored)?;
        writer.write_all(&attachments_json)?;

        // db
        writer.start_file("db/main.sqlite3", stored)?;
        let db_bytes = std::fs::read(doc.db.as_path())?;
        writer.write_all(&db_bytes)?;

        // attachments data
        for meta in &attachment_metas {
            let data = doc.attachments.data(meta.id).ok_or_else(|| {
                TmdError::Attachment(format!("missing data for attachment {}", meta.id))
            })?;
            writer.start_file(&meta.logical_path, stored)?;
            writer.write_all(data)?;
        }

        let zip_bytes = writer.finish()?.into_inner();
        Ok(zip_bytes)
    }

    pub fn write_tmd<W: Write + Seek>(
        writer: &mut W,
        doc: &TmdDoc,
        mode: WriteMode,
    ) -> TmdResult<()> {
        let markdown_bytes = doc.markdown.as_bytes();
        let mut zip_bytes = build_zip(doc, mode)?;
        let markdown_len = u64::try_from(markdown_bytes.len())
            .map_err(|_| TmdError::InvalidFormat("markdown length exceeds u64 range".into()))?;
        set_tmd_comment(&mut zip_bytes, markdown_len)?;
        writer.write_all(markdown_bytes)?;
        writer.write_all(&zip_bytes)?;
        Ok(())
    }

    pub fn write_tmdz<W: Write + Seek>(
        writer: &mut W,
        doc: &TmdDoc,
        mode: WriteMode,
    ) -> TmdResult<()> {
        let zip_bytes = build_zip(doc, mode)?;
        writer.write_all(&zip_bytes)?;
        Ok(())
    }

    pub fn read_from_path(path: impl AsRef<Path>, assumed: Option<Format>) -> TmdResult<TmdDoc> {
        let file = File::open(path.as_ref())?;
        let mut reader = Reader::new(std::io::BufReader::new(file), assumed, ReadMode::default())?;
        reader.read_doc()
    }

    pub fn write_to_path(path: impl AsRef<Path>, doc: &TmdDoc, format: Format) -> TmdResult<()> {
        let file = File::create(path.as_ref())?;
        let mut writer = Writer::new(std::io::BufWriter::new(file), format, WriteMode::default())?;
        writer.write_doc(doc)?;
        writer.finish()
    }

    // No additional helpers
}

#[cfg(feature = "ffi")]
pub mod ffi {
    //! C-compatible bindings for `tmd-core` exposed when the `ffi` feature is enabled.

    use super::{read_from_path, write_to_path, Format, TmdDoc, TmdError};
    use std::cell::RefCell;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::path::PathBuf;
    use std::ptr;

    thread_local! {
        static LAST_ERROR: RefCell<Option<CString>> = RefCell::new(None);
    }

    const NULL_PTR_MESSAGE: &str = "null pointer provided";
    const INVALID_UTF8_MESSAGE: &str = "input was not valid UTF-8";
    const INTERIOR_NUL_MESSAGE: &str = "string contained an interior NUL byte";

    fn set_last_error_message<S: Into<String>>(message: S) {
        let message = message.into();
        let c_string =
            CString::new(message).unwrap_or_else(|_| CString::new(INTERIOR_NUL_MESSAGE).unwrap());
        LAST_ERROR.with(|slot| {
            *slot.borrow_mut() = Some(c_string);
        });
    }

    fn set_last_error(error: TmdError) {
        set_last_error_message(error.to_string());
    }

    fn clear_last_error() {
        LAST_ERROR.with(|slot| {
            *slot.borrow_mut() = None;
        });
    }

    fn path_from_ptr(ptr: *const c_char) -> Result<PathBuf, String> {
        if ptr.is_null() {
            return Err(NULL_PTR_MESSAGE.to_string());
        }
        let c_str = unsafe { CStr::from_ptr(ptr) };
        let utf8 = c_str
            .to_str()
            .map_err(|_| INVALID_UTF8_MESSAGE.to_string())?;
        Ok(PathBuf::from(utf8))
    }

    fn parse_optional_format(value: i32) -> Result<Option<Format>, String> {
        match value {
            0 => Ok(None),
            1 => Ok(Some(Format::Tmd)),
            2 => Ok(Some(Format::Tmdz)),
            other => Err(format!("unknown format value: {}", other)),
        }
    }

    fn parse_required_format(value: i32) -> Result<Format, String> {
        parse_optional_format(value)?
            .ok_or_else(|| "format must not be Auto when writing".to_string())
    }

    fn string_from_ptr(ptr: *const c_char) -> Result<String, String> {
        if ptr.is_null() {
            return Err(NULL_PTR_MESSAGE.to_string());
        }
        let c_str = unsafe { CStr::from_ptr(ptr) };
        Ok(c_str
            .to_str()
            .map_err(|_| INVALID_UTF8_MESSAGE.to_string())?
            .to_owned())
    }

    fn c_string_from_str(value: &str) -> Result<CString, ()> {
        CString::new(value).map_err(|_| ())
    }

    /// Retrieve the last error message generated by the FFI layer for the current thread.
    #[no_mangle]
    pub extern "C" fn tmd_last_error_message() -> *const c_char {
        LAST_ERROR.with(|slot| {
            slot.borrow()
                .as_ref()
                .map(|s| s.as_ptr())
                .unwrap_or(ptr::null())
        })
    }

    /// Create a new in-memory document from the provided Markdown string.
    #[no_mangle]
    pub extern "C" fn tmd_doc_new(markdown: *const c_char) -> *mut TmdDoc {
        let markdown = match string_from_ptr(markdown) {
            Ok(value) => value,
            Err(message) => {
                set_last_error_message(message);
                return ptr::null_mut();
            }
        };

        match TmdDoc::new(markdown) {
            Ok(doc) => {
                clear_last_error();
                Box::into_raw(Box::new(doc))
            }
            Err(err) => {
                set_last_error(err);
                ptr::null_mut()
            }
        }
    }

    /// Load a document from disk, optionally specifying the expected format.
    ///
    /// Pass `0` for automatic format detection, `1` for `.tmd`, and `2` for `.tmdz`.
    #[no_mangle]
    pub extern "C" fn tmd_doc_read_from_path(path: *const c_char, format: i32) -> *mut TmdDoc {
        let assumed = match parse_optional_format(format) {
            Ok(value) => value,
            Err(message) => {
                set_last_error_message(message);
                return ptr::null_mut();
            }
        };

        let path_buf = match path_from_ptr(path) {
            Ok(path) => path,
            Err(message) => {
                set_last_error_message(message);
                return ptr::null_mut();
            }
        };

        match read_from_path(&path_buf, assumed) {
            Ok(doc) => {
                clear_last_error();
                Box::into_raw(Box::new(doc))
            }
            Err(err) => {
                set_last_error(err);
                ptr::null_mut()
            }
        }
    }

    /// Persist the document to disk using the specified format.
    ///
    /// Pass `1` for `.tmd` or `2` for `.tmdz`.
    #[no_mangle]
    pub extern "C" fn tmd_doc_write_to_path(
        doc: *const TmdDoc,
        path: *const c_char,
        format: i32,
    ) -> i32 {
        if doc.is_null() {
            set_last_error_message(NULL_PTR_MESSAGE);
            return -1;
        }

        let format = match parse_required_format(format) {
            Ok(value) => value,
            Err(message) => {
                set_last_error_message(message);
                return -1;
            }
        };

        let path_buf = match path_from_ptr(path) {
            Ok(path) => path,
            Err(message) => {
                set_last_error_message(message);
                return -1;
            }
        };

        let doc_ref = unsafe { &*doc };
        match write_to_path(&path_buf, doc_ref, format) {
            Ok(()) => {
                clear_last_error();
                0
            }
            Err(err) => {
                set_last_error(err);
                -1
            }
        }
    }

    /// Retrieve the Markdown content of the document.
    ///
    /// The returned pointer must be released with [`tmd_string_free`].
    #[no_mangle]
    pub extern "C" fn tmd_doc_get_markdown(doc: *const TmdDoc) -> *mut c_char {
        if doc.is_null() {
            set_last_error_message(NULL_PTR_MESSAGE);
            return ptr::null_mut();
        }

        let doc_ref = unsafe { &*doc };
        match c_string_from_str(&doc_ref.markdown) {
            Ok(markdown) => {
                clear_last_error();
                markdown.into_raw()
            }
            Err(()) => {
                set_last_error_message(INTERIOR_NUL_MESSAGE);
                ptr::null_mut()
            }
        }
    }

    /// Replace the Markdown content of the document.
    #[no_mangle]
    pub extern "C" fn tmd_doc_set_markdown(doc: *mut TmdDoc, markdown: *const c_char) -> i32 {
        if doc.is_null() {
            set_last_error_message(NULL_PTR_MESSAGE);
            return -1;
        }

        let markdown = match string_from_ptr(markdown) {
            Ok(value) => value,
            Err(message) => {
                set_last_error_message(message);
                return -1;
            }
        };

        let doc_ref = unsafe { &mut *doc };
        doc_ref.markdown = markdown;
        clear_last_error();
        0
    }

    /// Release a document created by the FFI helpers.
    #[no_mangle]
    pub extern "C" fn tmd_doc_free(doc: *mut TmdDoc) {
        if doc.is_null() {
            return;
        }
        unsafe {
            drop(Box::from_raw(doc));
        }
        clear_last_error();
    }

    /// Release a string allocated by the FFI helpers.
    #[no_mangle]
    pub extern "C" fn tmd_string_free(ptr: *mut c_char) {
        if ptr.is_null() {
            return;
        }
        unsafe {
            drop(CString::from_raw(ptr));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mime::TEXT_PLAIN;
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Seek, SeekFrom};
    use tempfile::tempdir;

    fn sample_doc() -> TmdDoc {
        TmdDoc::new("# Sample\n".to_string()).expect("doc creation")
    }

    #[test]
    fn normalize_logical_path_rejects_invalid_segments() {
        assert!(normalize_logical_path("foo/../bar").is_err());
        assert!(normalize_logical_path("/absolute").is_err());
        assert_eq!(
            normalize_logical_path("images/figure.png").unwrap(),
            "images/figure.png"
        );
    }

    #[test]
    fn new_doc_initializes_database() {
        let doc = sample_doc();
        let result = doc
            .db_with_conn(|conn| {
                conn.query_row("SELECT 1", [], |row| row.get::<_, i32>(0))
                    .unwrap()
            })
            .expect("db query");
        assert_eq!(result, 1);
    }

    #[test]
    fn attachment_lifecycle() {
        let mut doc = sample_doc();
        let attachment_id = doc
            .add_attachment("attachments/data.bin", TEXT_PLAIN, vec![1, 2, 3])
            .expect("add attachment");
        let meta = doc.attachment_meta(attachment_id).expect("meta exists");
        assert_eq!(meta.logical_path, "attachments/data.bin");
        assert_eq!(meta.length, 3);

        doc.rename_attachment(attachment_id, "data/renamed.bin")
            .expect("rename");
        assert!(doc
            .attachment_meta_by_path("attachments/data.bin")
            .is_none());
        assert!(doc.attachment_meta_by_path("data/renamed.bin").is_some());

        doc.remove_attachment(attachment_id).expect("remove");
        assert!(doc.attachment_meta(attachment_id).is_none());
    }

    #[test]
    fn attachment_data_mut_refreshes_metadata() {
        let mut doc = sample_doc();
        let attachment_id = doc
            .add_attachment("attachments/blob.bin", TEXT_PLAIN, vec![0, 1, 2, 3])
            .expect("add attachment");

        {
            let mut data = doc
                .attachments
                .data_mut(attachment_id)
                .expect("mutable handle");
            data.extend_from_slice(&[4, 5, 6]);
        }

        let meta = doc
            .attachment_meta(attachment_id)
            .expect("updated metadata");
        assert_eq!(meta.length, 7);

        let expected = {
            let digest = Sha256::digest([0, 1, 2, 3, 4, 5, 6]);
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&digest);
            arr
        };
        assert_eq!(meta.sha256, Some(expected));
    }

    #[test]
    fn writing_after_mutation_keeps_manifest_consistent() {
        let mut doc = sample_doc();
        let attachment_id = doc
            .add_attachment("attachments/data.bin", TEXT_PLAIN, vec![1, 2, 3, 4])
            .expect("add attachment");

        {
            let mut data = doc
                .attachments
                .data_mut(attachment_id)
                .expect("mutable handle");
            data.extend_from_slice(&[5, 6]);
        }

        let mut buffer = Cursor::new(Vec::new());
        write_tmd(&mut buffer, &doc, WriteMode::default()).expect("write");
        buffer.seek(SeekFrom::Start(0)).unwrap();
        let mut reader =
            Reader::new(buffer, Some(Format::Tmd), ReadMode::default()).expect("reader");
        let rebuilt = reader.read_doc().expect("read");

        let rebuilt_meta = rebuilt
            .attachment_meta(attachment_id)
            .expect("attachment meta");
        assert_eq!(rebuilt_meta.length, 6);
        assert_eq!(
            rebuilt.attachments.data(attachment_id).unwrap(),
            &[1, 2, 3, 4, 5, 6]
        );
    }

    fn build_doc_with_attachment() -> TmdDoc {
        let mut doc = sample_doc();
        doc.markdown.push_str("Body text\n");
        doc.manifest.title = Some("Roundtrip".into());
        doc.manifest.tags = vec!["report".into()];
        doc.add_attachment(
            "images/pixel.png",
            "image/png".parse().unwrap(),
            vec![0, 1, 2, 3],
        )
        .expect("add attachment");
        doc.db_with_conn_mut(|conn| {
            conn.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)", [])
                .unwrap();
            conn.execute("INSERT INTO items(name) VALUES ('apricot')", [])
                .unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
        })
        .expect("populate db");
        doc.manifest.db_schema_version = Some(2);
        doc
    }

    #[test]
    fn tmd_roundtrip_preserves_content() {
        let doc = build_doc_with_attachment();
        let mut buffer = Cursor::new(Vec::new());
        write_tmd(&mut buffer, &doc, WriteMode::default()).expect("write");
        buffer.seek(SeekFrom::Start(0)).unwrap();
        let mut reader =
            Reader::new(buffer, Some(Format::Tmd), ReadMode::default()).expect("reader");
        let rebuilt = reader.read_doc().expect("read");

        assert_eq!(rebuilt.markdown, doc.markdown);
        assert_eq!(rebuilt.manifest.title, doc.manifest.title);
        assert_eq!(
            rebuilt.manifest.db_schema_version,
            doc.manifest.db_schema_version
        );

        let original_meta = doc
            .list_attachments()
            .next()
            .expect("original attachment meta");
        let rebuilt_meta = rebuilt
            .list_attachments()
            .next()
            .expect("rebuilt attachment meta");
        assert_eq!(original_meta.logical_path, rebuilt_meta.logical_path);
        assert_eq!(original_meta.length, rebuilt_meta.length);
        assert_eq!(
            rebuilt.attachments.data(rebuilt_meta.id).unwrap(),
            &[0, 1, 2, 3]
        );

        let user_version: u32 = rebuilt
            .db_with_conn(|conn| {
                conn.query_row("PRAGMA user_version", [], |row| row.get(0))
                    .unwrap()
            })
            .expect("user version");
        assert_eq!(user_version, 2);
    }

    #[test]
    fn tmdz_roundtrip_preserves_content() {
        let doc = build_doc_with_attachment();
        let mut buffer = Cursor::new(Vec::new());
        write_tmdz(&mut buffer, &doc, WriteMode::default()).expect("write");
        buffer.seek(SeekFrom::Start(0)).unwrap();
        let mut reader =
            Reader::new(buffer, Some(Format::Tmdz), ReadMode::default()).expect("reader");
        let rebuilt = reader.read_doc().expect("read");
        assert_eq!(rebuilt.markdown, doc.markdown);
        assert_eq!(rebuilt.manifest.title, doc.manifest.title);
    }

    #[test]
    fn sniff_format_detects_variants() {
        assert_eq!(sniff_format(b"PK\x03\x04"), Some(Format::Tmdz));
        assert_eq!(sniff_format(b"#"), Some(Format::Tmd));
        assert_eq!(sniff_format(b""), None);
    }

    #[test]
    fn export_and_import_db() {
        let mut doc = sample_doc();
        doc.db_with_conn_mut(|conn| {
            conn.execute("CREATE TABLE value_store(val INTEGER)", [])
                .unwrap();
            conn.execute("INSERT INTO value_store(val) VALUES (42)", [])
                .unwrap();
        })
        .unwrap();

        let dir = tempdir().unwrap();
        let export_path = dir.path().join("db.sqlite3");
        export_db(&doc, &export_path).expect("export");

        doc.db_with_conn_mut(|conn| {
            conn.execute("DELETE FROM value_store", []).unwrap();
            conn.execute("INSERT INTO value_store(val) VALUES (7)", [])
                .unwrap();
        })
        .unwrap();

        import_db(&mut doc, &export_path).expect("import");
        let value: i32 = doc
            .db_with_conn(|conn| {
                conn.query_row("SELECT val FROM value_store", [], |row| row.get(0))
                    .unwrap()
            })
            .expect("query");
        assert_eq!(value, 42);
    }

    #[test]
    fn reset_and_migrate_database() {
        let mut doc = sample_doc();
        reset_db(
            &mut doc,
            "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT);",
            1,
        )
        .expect("reset");
        doc.db_with_conn_mut(|conn| {
            conn.execute("INSERT INTO items(name) VALUES ('alpha')", [])
                .unwrap();
        })
        .unwrap();

        migrate(
            &mut doc,
            "ALTER TABLE items ADD COLUMN qty INTEGER DEFAULT 0;",
            1,
            2,
        )
        .expect("migrate");
        let version: u32 = doc
            .db_with_conn(|conn| {
                conn.query_row("PRAGMA user_version", [], |row| row.get(0))
                    .unwrap()
            })
            .expect("user_version");
        assert_eq!(version, 2);
    }

    #[test]
    fn reset_db_propagates_sql_errors() {
        let mut doc = sample_doc();
        let err = reset_db(&mut doc, "CREATE TABLE ???", 1).expect_err("reset should fail");
        match err {
            TmdError::Db(message) => assert!(
                message.contains("near") || message.contains("syntax"),
                "unexpected error message: {}",
                message
            ),
            other => panic!("expected database error, got {:?}", other),
        }
    }

    #[test]
    fn migrate_propagates_sql_errors() {
        let mut doc = sample_doc();
        reset_db(&mut doc, "CREATE TABLE base(id INTEGER PRIMARY KEY);", 1).expect("reset");

        let err = migrate(
            &mut doc,
            "ALTER TABLE missing ADD COLUMN value INTEGER;",
            1,
            2,
        )
        .expect_err("migrate should fail");

        match err {
            TmdError::Db(message) => assert!(
                message.contains("no such table") || message.contains("missing"),
                "unexpected error message: {}",
                message
            ),
            other => panic!("expected database error, got {:?}", other),
        }

        let version: u32 = doc
            .db_with_conn(|conn| {
                conn.query_row("PRAGMA user_version", [], |row| row.get(0))
                    .unwrap()
            })
            .expect("user_version");
        assert_eq!(version, 1);
    }

    #[test]
    fn module_with_conn_helpers_work() {
        let mut doc = sample_doc();
        with_conn_mut(&mut doc, |conn| {
            conn.execute("CREATE TABLE helpers(id INTEGER)", [])
                .unwrap();
        })
        .expect("with_conn_mut");

        let count: i64 = with_conn(&doc, |conn| {
            conn.query_row("SELECT COUNT(*) FROM helpers", [], |row| row.get(0))
                .unwrap()
        })
        .expect("with_conn");

        assert_eq!(count, 0);
    }

    #[test]
    fn read_and_write_path_helpers() {
        let doc = build_doc_with_attachment();
        let dir = tempdir().unwrap();
        let path = dir.path().join("sample.tmd");
        write_to_path(&path, &doc, Format::Tmd).expect("write path");
        let loaded = read_from_path(&path, Some(Format::Tmd)).expect("read path");
        assert_eq!(loaded.markdown, doc.markdown);
        assert_eq!(loaded.list_attachments().count(), 1);
    }
}
