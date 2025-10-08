use anyhow::Context;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as FmtWrite;
use std::io::{Cursor, Read, Write};
use std::convert::TryFrom;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const EOCD_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const MAX_COMMENT_SEARCH: usize = 0xFFFF + 22;
const TMD_COMMENT_PREFIX: &[u8] = b"TMD1\0";

fn find_eocd_offset(data: &[u8]) -> anyhow::Result<usize> {
    let min_len = 22;
    anyhow::ensure!(data.len() >= min_len, "input too small to contain EOCD");

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

    anyhow::bail!("ZIP EOCD signature not found");
}

fn extract_markdown_len_from_comment(comment: &[u8]) -> anyhow::Result<u64> {
    anyhow::ensure!(
        comment.starts_with(TMD_COMMENT_PREFIX),
        "missing TMD comment signature"
    );
    let expected_len = TMD_COMMENT_PREFIX.len() + 8;
    anyhow::ensure!(
        comment.len() == expected_len,
        "unexpected TMD comment length: expected {} bytes, got {}",
        expected_len,
        comment.len()
    );
    let mut len_bytes = [0u8; 8];
    len_bytes.copy_from_slice(&comment[TMD_COMMENT_PREFIX.len()..]);
    Ok(u64::from_le_bytes(len_bytes))
}

fn split_tmd_bytes(bytes: &[u8]) -> anyhow::Result<(&[u8], &[u8])> {
    let eocd_offset = find_eocd_offset(bytes)?;
    anyhow::ensure!(
        eocd_offset + 22 <= bytes.len(),
        "EOCD extends past end of buffer"
    );
    let comment_len_start = eocd_offset + 20;
    let comment_len = u16::from_le_bytes([
        bytes[comment_len_start],
        bytes[comment_len_start + 1],
    ]) as usize;
    let comment_start = eocd_offset + 22;
    anyhow::ensure!(
        comment_start + comment_len <= bytes.len(),
        "EOCD comment length exceeds buffer"
    );
    let comment = &bytes[comment_start..comment_start + comment_len];
    let markdown_len = extract_markdown_len_from_comment(comment)?;
    let markdown_len_usize = usize::try_from(markdown_len)
        .map_err(|_| anyhow::anyhow!("markdown length does not fit in usize"))?;
    anyhow::ensure!(
        markdown_len_usize <= bytes.len(),
        "markdown length exceeds buffer"
    );
    let (markdown, zip_bytes) = bytes.split_at(markdown_len_usize);
    Ok((markdown, zip_bytes))
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing to `String` cannot fail.
        FmtWrite::write_fmt(&mut out, format_args!("{:02x}", byte))
            .expect("writing to String cannot fail");
    }
    out
}

fn set_tmd_comment(zip_bytes: &mut Vec<u8>, markdown_len: u64) -> anyhow::Result<()> {
    let eocd_offset = find_eocd_offset(zip_bytes)?;
    anyhow::ensure!(
        eocd_offset + 22 <= zip_bytes.len(),
        "EOCD extends past end of ZIP buffer"
    );
    let comment_data = {
        let mut buf = Vec::with_capacity(TMD_COMMENT_PREFIX.len() + 8);
        buf.extend_from_slice(TMD_COMMENT_PREFIX);
        buf.extend_from_slice(&markdown_len.to_le_bytes());
        buf
    };
    anyhow::ensure!(
        comment_data.len() <= u16::MAX as usize,
        "TMD comment would exceed ZIP comment limit"
    );
    let comment_len_pos = eocd_offset + 20;
    let comment_start = eocd_offset + 22;
    let comment_len_bytes = (comment_data.len() as u16).to_le_bytes();
    zip_bytes[comment_len_pos] = comment_len_bytes[0];
    zip_bytes[comment_len_pos + 1] = comment_len_bytes[1];
    zip_bytes.truncate(comment_start);
    zip_bytes.extend_from_slice(&comment_data);
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct AttachmentMeta {
    pub mime: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Manifest {
    pub version: u32,
    pub schemaVersion: String,
    pub title: String,
    pub attachments: HashMap<String, AttachmentMeta>,
    pub data: DataSection,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct DataSection {
    pub engine: String,
    pub entry: String,
}

#[derive(Debug)]
pub struct TmdDoc {
    pub markdown: String,
    pub manifest: Manifest,
    pub attachments: HashMap<String, Vec<u8>>,
}

impl TmdDoc {
    pub fn from_parts(markdown: String, manifest: Manifest, attachments: HashMap<String, Vec<u8>>) -> Self {
        Self { markdown, manifest, attachments }
    }

    pub fn open_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        let (markdown_bytes, zip_bytes) = split_tmd_bytes(bytes)?;
        let markdown = String::from_utf8(markdown_bytes.to_vec())
            .context("markdown section is not valid UTF-8")?;

        let mut zip = ZipArchive::new(Cursor::new(zip_bytes))
            .context("failed to open embedded ZIP archive")?;

        let manifest_json = {
            let mut file = zip
                .by_name("manifest.json")
                .context("manifest.json not found in TMD archive")?;
            let mut buf = String::new();
            file.read_to_string(&mut buf)
                .context("failed to read manifest.json")?;
            buf
        };

        let manifest: Manifest = serde_json::from_str(&manifest_json)
            .context("failed to deserialize manifest.json")?;

        let mut attachments = HashMap::new();
        let mut seen = HashSet::new();

        for (path, meta) in &manifest.attachments {
            let mut file = zip
                .by_name(path)
                .with_context(|| format!("attachment `{}` not found in archive", path))?;
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .with_context(|| format!("failed to read attachment `{}`", path))?;
            anyhow::ensure!(
                data.len() as u64 == meta.size,
                "attachment `{}` size mismatch: manifest={} actual={}",
                path,
                meta.size,
                data.len()
            );
            let digest_hex = sha256_hex(&data);
            anyhow::ensure!(
                digest_hex.eq_ignore_ascii_case(&meta.sha256),
                "attachment `{}` sha256 mismatch: manifest={} actual={}",
                path,
                meta.sha256,
                digest_hex
            );
            attachments.insert(path.clone(), data);
            seen.insert(path.clone());
        }

        for idx in 0..zip.len() {
            let file = zip
                .by_index(idx)
                .with_context(|| format!("failed to inspect ZIP entry at index {}", idx))?;
            if file.is_dir() {
                continue;
            }
            let name = file.name().to_string();
            if name == "manifest.json" {
                continue;
            }
            anyhow::ensure!(
                seen.contains(&name),
                "ZIP archive contains undeclared entry `{}`",
                name
            );
        }

        Ok(Self { markdown, manifest, attachments })
    }

    pub fn to_bytes(&self) -> anyhow::Result<Vec<u8>> {
        let markdown_bytes = self.markdown.as_bytes();
        let markdown_len = u64::try_from(markdown_bytes.len())
            .map_err(|_| anyhow::anyhow!("markdown length exceeds u64 range"))?;

        anyhow::ensure!(
            !self.manifest.attachments.is_empty() || self.attachments.is_empty(),
            "manifest attachments map is empty but attachment data was provided"
        );

        let mut manifest_keys = HashSet::new();
        for (path, meta) in &self.manifest.attachments {
            manifest_keys.insert(path.clone());
            let data = self
                .attachments
                .get(path)
                .with_context(|| format!("attachment data for `{}` missing", path))?;
            let actual_size = data.len() as u64;
            anyhow::ensure!(
                actual_size == meta.size,
                "attachment `{}` size mismatch: manifest={} actual={}",
                path,
                meta.size,
                actual_size
            );
            let digest_hex = sha256_hex(data);
            anyhow::ensure!(
                digest_hex.eq_ignore_ascii_case(&meta.sha256),
                "attachment `{}` sha256 mismatch: manifest={} actual={}",
                path,
                meta.sha256,
                digest_hex
            );
        }

        for key in self.attachments.keys() {
            anyhow::ensure!(
                manifest_keys.contains(key),
                "attachment data `{}` provided but missing from manifest",
                key
            );
        }

        let manifest_json = serde_json::to_vec_pretty(&self.manifest)
            .context("failed to serialise manifest.json")?;

        let cursor = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let file_options = FileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);

        writer
            .start_file("manifest.json", file_options)
            .context("failed to start manifest.json entry")?;
        writer
            .write_all(&manifest_json)
            .context("failed to write manifest.json")?;

        let mut attachment_paths: Vec<_> = manifest_keys.into_iter().collect();
        attachment_paths.sort();
        for path in attachment_paths {
            let data = self
                .attachments
                .get(&path)
                .expect("attachment paths already validated");
            writer
                .start_file(&path, file_options)
                .with_context(|| format!("failed to start ZIP entry `{}`", path))?;
            writer
                .write_all(data)
                .with_context(|| format!("failed to write ZIP entry `{}`", path))?;
        }

        let mut zip_bytes = writer
            .finish()
            .context("failed to finalise ZIP archive")?
            .into_inner();

        set_tmd_comment(&mut zip_bytes, markdown_len)?;

        let mut out = Vec::with_capacity(markdown_bytes.len() + zip_bytes.len());
        out.extend_from_slice(markdown_bytes);
        out.extend_from_slice(&zip_bytes);
        Ok(out)
    }
}

#[cfg(test)]
mod tests;
