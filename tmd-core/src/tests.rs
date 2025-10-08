use super::*;
use anyhow::Result;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tmd-sample")
        .join(name)
}

#[test]
fn open_sample_document() -> Result<()> {
    let bytes = fs::read(fixture_path("sample.tmd"))?;
    let doc = TmdDoc::open_bytes(&bytes)?;
    assert!(doc.markdown.contains("TMD MVP Sample"));
    assert_eq!(doc.manifest.title, "TMD MVP Sample");
    assert!(doc.manifest.attachments.contains_key("images/pixel.png"));
    assert!(doc.attachments.contains_key("images/pixel.png"));
    Ok(())
}

#[test]
fn round_trip_serialisation() -> Result<()> {
    let bytes = fs::read(fixture_path("sample.tmd"))?;
    let doc = TmdDoc::open_bytes(&bytes)?;
    let rebuilt = TmdDoc::open_bytes(&doc.to_bytes()?)?;

    assert_eq!(doc.markdown, rebuilt.markdown);
    assert_eq!(doc.manifest, rebuilt.manifest);
    assert_eq!(doc.attachments, rebuilt.attachments);

    // Ensure deterministic ZIP entry ordering by comparing keys.
    let original_keys: BTreeSet<_> = doc.attachments.keys().cloned().collect();
    let rebuilt_keys: BTreeSet<_> = rebuilt.attachments.keys().cloned().collect();
    assert_eq!(original_keys, rebuilt_keys);

    Ok(())
}

#[test]
fn extract_markdown_len_validates_prefix_and_length() {
    let mut comment = Vec::new();
    comment.extend_from_slice(TMD_COMMENT_PREFIX);
    comment.extend_from_slice(&1234u64.to_le_bytes());

    assert_eq!(extract_markdown_len_from_comment(&comment).unwrap(), 1234);

    let mut bad_prefix = comment.clone();
    bad_prefix[0] = b'X';
    assert!(extract_markdown_len_from_comment(&bad_prefix).is_err());

    let mut bad_length = comment.clone();
    bad_length.push(0);
    assert!(extract_markdown_len_from_comment(&bad_length).is_err());
}

#[test]
fn set_tmd_comment_writes_expected_marker() -> Result<()> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let file_options = FileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);
    writer.start_file("dummy.txt", file_options)?;
    writer.write_all(b"hello world")?;

    let mut zip_bytes = writer.finish()?.into_inner();
    set_tmd_comment(&mut zip_bytes, 42)?;

    let eocd_offset = find_eocd_offset(&zip_bytes)?;
    let comment_len_pos = eocd_offset + 20;
    let comment_len = u16::from_le_bytes([
        zip_bytes[comment_len_pos],
        zip_bytes[comment_len_pos + 1],
    ]) as usize;
    assert_eq!(comment_len, TMD_COMMENT_PREFIX.len() + 8);

    let comment_start = eocd_offset + 22;
    let comment = &zip_bytes[comment_start..comment_start + comment_len];
    assert!(comment.starts_with(TMD_COMMENT_PREFIX));
    let mut len_bytes = [0u8; 8];
    len_bytes.copy_from_slice(&comment[TMD_COMMENT_PREFIX.len()..]);
    assert_eq!(u64::from_le_bytes(len_bytes), 42);

    Ok(())
}

#[test]
fn to_bytes_requires_manifest_attachment_data() {
    let mut attachments = HashMap::new();
    attachments.insert(
        "image.bin".to_string(),
        AttachmentMeta {
            mime: "application/octet-stream".to_string(),
            sha256: sha256_hex(b"hello"),
            size: 5,
        },
    );

    let doc = TmdDoc::from_parts(
        "# Title".to_string(),
        Manifest {
            version: 1,
            schemaVersion: "2025.01".to_string(),
            title: "Missing attachment".to_string(),
            attachments,
            data: DataSection {
                engine: "markdown".to_string(),
                entry: "main".to_string(),
            },
        },
        HashMap::new(),
    );

    let err = doc.to_bytes().unwrap_err();
    assert!(
        err.to_string()
            .contains("attachment data for `image.bin` missing")
    );
}
