use crate::{normalize_logical_path, AttachmentId, TmdDoc, TmdResult};
use pulldown_cmark::{Event, Parser, Tag};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// Severity assigned to a document validation issue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationSeverity {
    Error,
    Warning,
}

/// A single machine-readable document validation issue.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub severity: ValidationSeverity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// An `attach:` reference found in Markdown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentReference {
    pub logical_path: String,
    pub resolved: bool,
}

/// Complete validation result for a loaded document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationReport {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
    pub attachment_references: Vec<AttachmentReference>,
    pub database_user_version: u32,
}

fn issue(
    severity: ValidationSeverity,
    code: &str,
    message: impl Into<String>,
    path: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        severity,
        code: code.to_owned(),
        message: message.into(),
        path,
    }
}

/// Return the unique `attach:` destinations referenced by Markdown.
pub fn attachment_references(markdown: &str) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for event in Parser::new(markdown) {
        let destination = match event {
            Event::Start(Tag::Link { dest_url, .. })
            | Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url),
            _ => None,
        };
        if let Some(destination) = destination {
            if let Some(path) = destination.strip_prefix("attach:") {
                paths.insert(path.to_owned());
            }
        }
    }
    paths.into_iter().collect()
}

/// Validate container invariants that require the complete document model.
pub fn validate_document(doc: &TmdDoc) -> TmdResult<ValidationReport> {
    let mut issues = Vec::new();

    if doc.manifest.tmd_version.major != 1 {
        issues.push(issue(
            ValidationSeverity::Error,
            "unsupported_tmd_version",
            format!(
                "unsupported TMD version {}.{}.{}; this implementation supports major version 1",
                doc.manifest.tmd_version.major,
                doc.manifest.tmd_version.minor,
                doc.manifest.tmd_version.patch
            ),
            None,
        ));
    }

    let database_user_version = doc.db_with_conn(|conn| {
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
    })??;
    if let Some(expected) = doc.manifest.db_schema_version {
        if expected != database_user_version {
            issues.push(issue(
                ValidationSeverity::Error,
                "database_schema_version_mismatch",
                format!(
                    "manifest db_schema_version={expected} but PRAGMA user_version={database_user_version}"
                ),
                Some("db/main.sqlite3".to_owned()),
            ));
        }
    }

    let mut attachment_ids = BTreeSet::<AttachmentId>::new();
    for (meta, data) in doc.attachments.iter_with_data() {
        attachment_ids.insert(meta.id);
        match normalize_logical_path(&meta.logical_path) {
            Ok(normalized) if normalized == meta.logical_path => {}
            Ok(normalized) => issues.push(issue(
                ValidationSeverity::Error,
                "non_canonical_attachment_path",
                format!(
                    "attachment path `{}` is not canonical; expected `{normalized}`",
                    meta.logical_path
                ),
                Some(meta.logical_path.clone()),
            )),
            Err(error) => issues.push(issue(
                ValidationSeverity::Error,
                "invalid_attachment_path",
                error.to_string(),
                Some(meta.logical_path.clone()),
            )),
        }

        if meta.length != data.len() as u64 {
            issues.push(issue(
                ValidationSeverity::Error,
                "attachment_length_mismatch",
                format!(
                    "attachment length is {}, but metadata records {}",
                    data.len(),
                    meta.length
                ),
                Some(meta.logical_path.clone()),
            ));
        }
        if let Some(expected) = meta.sha256 {
            let actual = Sha256::digest(data);
            if expected.as_slice() != actual.as_slice() {
                issues.push(issue(
                    ValidationSeverity::Error,
                    "attachment_sha256_mismatch",
                    "attachment SHA-256 digest does not match its metadata",
                    Some(meta.logical_path.clone()),
                ));
            }
        } else {
            issues.push(issue(
                ValidationSeverity::Warning,
                "attachment_sha256_missing",
                "attachment metadata does not contain a SHA-256 digest",
                Some(meta.logical_path.clone()),
            ));
        }
    }

    if let Some(cover) = &doc.manifest.cover_image {
        if !attachment_ids.contains(&cover.id) {
            issues.push(issue(
                ValidationSeverity::Error,
                "cover_image_missing",
                format!("cover image attachment {} does not exist", cover.id),
                None,
            ));
        }
    }

    let mut references = Vec::new();
    for path in attachment_references(&doc.markdown) {
        let resolved = normalize_logical_path(&path)
            .ok()
            .is_some_and(|normalized| {
                normalized == path && doc.attachment_meta_by_path(&normalized).is_some()
            });
        if !resolved {
            issues.push(issue(
                ValidationSeverity::Error,
                "unresolved_attachment_reference",
                format!("Markdown references missing or invalid attachment `{path}`"),
                Some(path.clone()),
            ));
        }
        references.push(AttachmentReference {
            logical_path: path,
            resolved,
        });
    }

    let valid = !issues
        .iter()
        .any(|entry| entry.severity == ValidationSeverity::Error);
    Ok(ValidationReport {
        valid,
        issues,
        attachment_references: references,
        database_user_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mime::TEXT_PLAIN;

    #[test]
    fn extracts_unique_attachment_references() {
        let markdown =
            "![one](attach:images/a.png)\n[other](attach:files/b.txt)\n[again](attach:files/b.txt)";
        assert_eq!(
            attachment_references(markdown),
            vec!["files/b.txt".to_owned(), "images/a.png".to_owned()]
        );
    }

    #[test]
    fn reports_unresolved_references_and_database_versions() {
        let mut doc = TmdDoc::new(
            "![known](attach:files/known.txt) ![missing](attach:files/missing.txt)".into(),
        )
        .expect("document");
        doc.add_attachment("files/known.txt", TEXT_PLAIN, b"known".to_vec())
            .expect("attachment");
        doc.manifest.db_schema_version = Some(7);

        let report = validate_document(&doc).expect("validation");
        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|entry| entry.code == "unresolved_attachment_reference"));
        assert!(report
            .issues
            .iter()
            .any(|entry| entry.code == "database_schema_version_mismatch"));
    }
}
