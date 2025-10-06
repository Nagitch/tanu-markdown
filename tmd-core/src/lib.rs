use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AttachmentMeta {
    pub mime: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Manifest {
    pub version: u32,
    pub schemaVersion: String,
    pub title: String,
    pub attachments: HashMap<String, AttachmentMeta>,
    pub data: DataSection,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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

    pub fn open_bytes(_bytes: &[u8]) -> anyhow::Result<Self> {
        anyhow::bail!("MVP stub: implement EOCD scan and ZIP parse (TMD1 signature)")
    }

    pub fn to_bytes(&self) -> anyhow::Result<Vec<u8>> {
        anyhow::bail!("MVP stub: implement serializer")
    }
}
