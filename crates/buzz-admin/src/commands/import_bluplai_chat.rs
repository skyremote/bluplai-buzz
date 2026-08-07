use std::collections::HashMap;
use std::path::Path;

use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use buzz_core::tenant::CommunityId;
use buzz_db::historical_import::{
    HistoricalImportDb, HistoricalImportOutcome, HistoricalImportRecord,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportManifest {
    pub manifest_version: String,
    pub manifest_sha256: String,
    pub import_sha256: String,
    pub community_id: Uuid,
    pub records: Vec<ImportSourceRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportSourceRecord {
    pub source_key: String,
    pub source_sha256: String,
    pub source_ordinal: u64,
    pub channel_id: Uuid,
    pub kind: u16,
    pub content: String,
    pub created_at: u64,
    pub author_display_name: String,
    pub author_type: String,
    #[serde(default)]
    pub parent_source_key: Option<String>,
    #[serde(default)]
    pub target_source_key: Option<String>,
    #[serde(default)]
    pub mentioned_pubkeys: Vec<String>,
    #[serde(default)]
    pub attachment_sha256: Vec<String>,
    #[serde(default)]
    pub tombstone: bool,
    #[serde(default)]
    pub edited_at: Option<u64>,
    #[serde(default)]
    pub broadcast: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportResult {
    pub source_key: String,
    pub event_id: String,
    pub status: &'static str,
}

pub(crate) fn validate_environment(acknowledgement: Option<&str>) -> Result<(), String> {
    if acknowledgement != Some("I_UNDERSTAND_THIS_IMPORTS_SIGNED_HISTORY") {
        return Err(
            "BUZZ_HISTORICAL_IMPORT_ACK must explicitly acknowledge signed history import"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn read_manifest_file(path: &Path) -> Result<ImportManifest, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("inspect manifest: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("manifest must be a regular non-symlink file".to_string());
    }
    if metadata.len() > 64 * 1024 * 1024 {
        return Err("manifest exceeds 64 MiB".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("manifest permissions must not grant group/other access".to_string());
        }
    }
    let bytes = std::fs::read(path).map_err(|error| format!("read manifest: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("parse manifest: {error}"))
}

pub(crate) fn build_signed_records(
    manifest: &ImportManifest,
    keys: &Keys,
) -> Result<Vec<HistoricalImportRecord>, String> {
    if manifest.manifest_version != "bluplai-chat-import/v1" {
        return Err("unsupported import manifest version".to_string());
    }
    validate_hash(&manifest.manifest_sha256)?;
    validate_hash(&manifest.import_sha256)?;
    let expected_import_hash = computed_import_sha256(manifest)?;
    if manifest.import_sha256 != expected_import_hash {
        return Err("import manifest checksum mismatch".to_string());
    }
    let mut records = manifest.records.iter().collect::<Vec<_>>();
    records.sort_by_key(|record| (record.source_ordinal, record.source_key.as_str()));
    let mut event_by_source = HashMap::<String, String>::new();
    let mut signed = Vec::with_capacity(records.len());
    for record in records {
        validate_source_record(record)?;
        let mut tags = vec![
            Tag::parse(["h", record.channel_id.to_string().as_str()])
                .map_err(|error| error.to_string())?,
            Tag::parse(["bluplai-source", "imported"]).map_err(|error| error.to_string())?,
            Tag::parse(["bluplai-migration-key", record.source_key.as_str()])
                .map_err(|error| error.to_string())?,
            Tag::parse(["bluplai-source-sha256", record.source_sha256.as_str()])
                .map_err(|error| error.to_string())?,
            Tag::parse(["bluplai-manifest-sha256", manifest.manifest_sha256.as_str()])
                .map_err(|error| error.to_string())?,
            Tag::parse([
                "bluplai-attribution",
                record.author_display_name.as_str(),
                record.author_type.as_str(),
            ])
            .map_err(|error| error.to_string())?,
            Tag::parse([
                "bluplai-source-ordinal",
                record.source_ordinal.to_string().as_str(),
            ])
            .map_err(|error| error.to_string())?,
        ];
        if record.tombstone {
            tags.push(Tag::parse(["bluplai-tombstone", "true"]).map_err(|e| e.to_string())?);
        }
        if let Some(edited_at) = record.edited_at {
            tags.push(
                Tag::parse(["bluplai-edited-at", edited_at.to_string().as_str()])
                    .map_err(|e| e.to_string())?,
            );
        }
        if record.broadcast {
            tags.push(Tag::parse(["bluplai-broadcast", "true"]).map_err(|e| e.to_string())?);
        }
        let relationship = if record.kind == 7 {
            record
                .target_source_key
                .as_ref()
                .map(|key| (key, "reaction"))
        } else {
            record.parent_source_key.as_ref().map(|key| (key, "reply"))
        };
        if let Some((source_key, marker)) = relationship {
            let event_id = event_by_source
                .get(source_key)
                .ok_or_else(|| format!("referenced source was not imported first: {source_key}"))?;
            tags.push(
                Tag::parse(["e", event_id.as_str(), "", marker])
                    .map_err(|error| error.to_string())?,
            );
        }
        for pubkey in &record.mentioned_pubkeys {
            validate_hex(pubkey, 64, "mention pubkey")?;
            tags.push(Tag::parse(["p", pubkey.as_str()]).map_err(|e| e.to_string())?);
        }
        for hash in &record.attachment_sha256 {
            validate_hash(hash)?;
            tags.push(
                Tag::parse(["bluplai-attachment-sha256", hash.as_str()])
                    .map_err(|error| error.to_string())?,
            );
        }
        let content = if record.tombstone {
            String::new()
        } else {
            record.content.clone()
        };
        let event = EventBuilder::new(Kind::Custom(record.kind), content)
            .tags(tags)
            .custom_created_at(Timestamp::from(record.created_at))
            .sign_with_keys(keys)
            .map_err(|error| format!("sign import event: {error}"))?;
        event_by_source.insert(record.source_key.clone(), event.id.to_hex());
        signed.push(HistoricalImportRecord {
            source_key: record.source_key.clone(),
            source_sha256: record.source_sha256.clone(),
            manifest_sha256: manifest.manifest_sha256.clone(),
            channel_id: record.channel_id,
            event,
        });
    }
    Ok(signed)
}

pub(crate) async fn import(
    database_url: &str,
    manifest: &ImportManifest,
    keys: &Keys,
) -> Result<Vec<ImportResult>, String> {
    let records = build_signed_records(manifest, keys)?;
    let mut db = HistoricalImportDb::connect(database_url)
        .await
        .map_err(|error| error.to_string())?;
    let mut results = Vec::with_capacity(records.len());
    for batch in records.chunks(500) {
        let outcomes = db
            .import_batch(CommunityId::from_uuid(manifest.community_id), batch)
            .await
            .map_err(|error| error.to_string())?;
        for (record, outcome) in batch.iter().zip(outcomes) {
            results.push(ImportResult {
                source_key: record.source_key.clone(),
                event_id: record.event.id.to_hex(),
                status: match outcome {
                    HistoricalImportOutcome::Inserted => "imported",
                    HistoricalImportOutcome::AlreadyImported => "existed",
                },
            });
        }
    }
    Ok(results)
}

fn validate_source_record(record: &ImportSourceRecord) -> Result<(), String> {
    validate_hash(&record.source_sha256)?;
    if !matches!(record.kind, 7 | 9) {
        return Err("only imported messages and reactions are supported".to_string());
    }
    if record.source_key.is_empty() || record.source_key.len() > 255 {
        return Err("invalid source key".to_string());
    }
    if record.author_display_name.is_empty()
        || record.author_display_name.len() > 255
        || record.author_display_name.contains('@')
    {
        return Err("invalid non-identifying author attribution".to_string());
    }
    if !matches!(record.author_type.as_str(), "user" | "agent" | "former") {
        return Err("invalid author attribution type".to_string());
    }
    if record.kind == 7 && record.target_source_key.is_none() {
        return Err("reaction target is required".to_string());
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), String> {
    validate_hex(value, 64, "sha256")
}

fn validate_hex(value: &str, length: usize, label: &str) -> Result<(), String> {
    if value.len() != length || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn computed_import_sha256(manifest: &ImportManifest) -> Result<String, String> {
    let mut value = serde_json::to_value(manifest).map_err(|error| error.to_string())?;
    value
        .as_object_mut()
        .ok_or_else(|| "invalid import manifest".to_string())?
        .remove("import_sha256");
    let canonical = canonical_json(&value);
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let body = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("object key"),
                        canonical_json(&values[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).expect("scalar JSON"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ImportManifest {
        let mut manifest = ImportManifest {
            manifest_version: "bluplai-chat-import/v1".to_string(),
            manifest_sha256: "a".repeat(64),
            import_sha256: String::new(),
            community_id: Uuid::nil(),
            records: vec![
                ImportSourceRecord {
                    source_key: "legacy:root".to_string(),
                    source_sha256: "b".repeat(64),
                    source_ordinal: 1,
                    channel_id: Uuid::nil(),
                    kind: 9,
                    content: "hello".to_string(),
                    created_at: 1_800_000_000,
                    author_display_name: "Former member".to_string(),
                    author_type: "former".to_string(),
                    parent_source_key: None,
                    target_source_key: None,
                    mentioned_pubkeys: vec![],
                    attachment_sha256: vec![],
                    tombstone: false,
                    edited_at: None,
                    broadcast: false,
                },
                ImportSourceRecord {
                    source_key: "legacy:reply".to_string(),
                    source_sha256: "c".repeat(64),
                    source_ordinal: 2,
                    channel_id: Uuid::nil(),
                    kind: 9,
                    content: "reply".to_string(),
                    created_at: 1_800_000_000,
                    author_display_name: "Daniel".to_string(),
                    author_type: "user".to_string(),
                    parent_source_key: Some("legacy:root".to_string()),
                    target_source_key: None,
                    mentioned_pubkeys: vec![],
                    attachment_sha256: vec![],
                    tombstone: false,
                    edited_at: None,
                    broadcast: true,
                },
            ],
        };
        manifest.import_sha256 = computed_import_sha256(&manifest).expect("import hash");
        manifest
    }

    #[test]
    fn signing_is_deterministic_and_links_threads_without_private_identity_tags() {
        let keys = Keys::parse("0000000000000000000000000000000000000000000000000000000000000001")
            .expect("key");
        let first = build_signed_records(&manifest(), &keys).expect("first");
        let second = build_signed_records(&manifest(), &keys).expect("second");
        assert_eq!(first[0].event.id, second[0].event.id);
        assert!(first[1].event.tags.iter().any(|tag| {
            let values = tag.as_slice();
            values.first().map(String::as_str) == Some("e")
                && values.get(1).map(String::as_str) == Some(first[0].event.id.to_hex().as_str())
        }));
        let json = serde_json::to_string(&first[0].event.tags).expect("json");
        assert!(!json.contains("clerk"));
        assert!(!json.contains("email"));
    }

    #[test]
    fn acknowledgement_is_mandatory() {
        assert!(validate_environment(None).is_err());
        assert!(validate_environment(Some("I_UNDERSTAND_THIS_IMPORTS_SIGNED_HISTORY")).is_ok());
    }

    #[test]
    fn accepts_python_canonical_import_checksum_and_unicode() {
        let raw = r#"{"community_id":"11111111-1111-4111-8111-111111111111","import_sha256":"c0b52b63495abbb995ed4db925804955a46656a6a6a3f6732ac05bab7b4a12b6","manifest_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","manifest_version":"bluplai-chat-import/v1","records":[{"attachment_sha256":[],"author_display_name":"Former member","author_type":"former","broadcast":false,"channel_id":"22222222-2222-4222-8222-222222222222","content":"Hello 🚀","created_at":1785758400,"edited_at":null,"kind":9,"mentioned_pubkeys":[],"parent_source_key":null,"source_key":"legacy-message:1111111111111111111111111111111111111111111111111111111111111111","source_ordinal":1,"source_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","target_source_key":null,"tombstone":false}]}"#;
        let manifest: ImportManifest = serde_json::from_str(raw).expect("Python manifest");
        let keys = Keys::parse("0000000000000000000000000000000000000000000000000000000000000001")
            .expect("key");
        assert_eq!(
            build_signed_records(&manifest, &keys)
                .expect("cross-language manifest")
                .len(),
            1
        );
    }
}
