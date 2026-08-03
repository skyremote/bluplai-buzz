//! Transactional, idempotent Bluplai historical event import.
//!
//! This deliberately owns a raw writer connection. Normal [`crate::Db`] pools
//! arm the created-at floor guard and must never be used for old history.

use chrono::{DateTime, Utc};
use nostr::Event;
use sqlx::{Connection, PgConnection, Row};
use uuid::Uuid;

use buzz_core::{tenant::CommunityId, verification::verify_event};

use crate::error::{DbError, Result};
use crate::event::{insert_event_with_thread_metadata_tx, ThreadMetadataParams};

/// One immutable signed event plus Bluplai source provenance.
#[derive(Debug, Clone)]
pub struct HistoricalImportRecord {
    /// Stable manifest source uniqueness key.
    pub source_key: String,
    /// Canonical source item SHA-256.
    pub source_sha256: String,
    /// Canonical encrypted-manifest plaintext SHA-256.
    pub manifest_sha256: String,
    /// Destination private room.
    pub channel_id: Uuid,
    /// Precomputed, migration-signed Nostr event.
    pub event: Event,
}

/// Result of importing one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoricalImportOutcome {
    /// Event and all derived rows were committed now.
    Inserted,
    /// The exact source key/event/hash already committed earlier.
    AlreadyImported,
}

/// Dedicated unarmed writer connection for old-event imports.
pub struct HistoricalImportDb {
    connection: PgConnection,
}

impl HistoricalImportDb {
    /// Connect directly to the writer and prove the created-at floor is unset.
    pub async fn connect(database_url: &str) -> Result<Self> {
        let mut connection = PgConnection::connect(database_url).await?;
        let armed: Option<String> =
            sqlx::query_scalar("SELECT current_setting('buzz.created_at_floor', true)")
                .fetch_one(&mut connection)
                .await?;
        if armed.as_deref().is_some_and(|value| !value.is_empty()) {
            return Err(DbError::InvalidData(
                "historical importer must not use an armed writer session".to_string(),
            ));
        }
        let is_replica: bool = sqlx::query_scalar("SELECT pg_is_in_recovery()")
            .fetch_one(&mut connection)
            .await?;
        if is_replica {
            return Err(DbError::InvalidData(
                "historical importer requires the writer endpoint".to_string(),
            ));
        }
        Ok(Self { connection })
    }

    /// Import a bounded batch in one explicit transaction.
    pub async fn import_batch(
        &mut self,
        community_id: CommunityId,
        records: &[HistoricalImportRecord],
    ) -> Result<Vec<HistoricalImportOutcome>> {
        if records.len() > 500 {
            return Err(DbError::InvalidData(
                "historical import batch exceeds 500 records".to_string(),
            ));
        }
        let mut tx = self.connection.begin().await?;
        let mut outcomes = Vec::with_capacity(records.len());
        for record in records {
            validate_record(record)?;
            let existing = sqlx::query(
                "SELECT source_sha256,event_id FROM bluplai_historical_imports \
                 WHERE community_id=$1 AND source_key=$2",
            )
            .bind(community_id.as_uuid())
            .bind(&record.source_key)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(existing) = existing {
                let source_sha256: String = existing.try_get("source_sha256")?;
                let event_id: Vec<u8> = existing.try_get("event_id")?;
                if source_sha256 != record.source_sha256
                    || event_id.as_slice() != record.event.id.as_bytes()
                {
                    return Err(DbError::InvalidData(
                        "historical source identity conflict".to_string(),
                    ));
                }
                outcomes.push(HistoricalImportOutcome::AlreadyImported);
                continue;
            }

            let thread =
                resolve_thread_metadata(&mut tx, community_id, record.channel_id, &record.event)
                    .await?;
            let thread_params = thread.as_ref().map(|thread| ThreadMetadataParams {
                event_id: record.event.id.as_bytes().as_slice(),
                event_created_at: thread.event_created_at,
                channel_id: record.channel_id,
                parent_event_id: Some(thread.parent_event_id.as_slice()),
                parent_event_created_at: Some(thread.parent_event_created_at),
                root_event_id: Some(thread.root_event_id.as_slice()),
                root_event_created_at: Some(thread.root_event_created_at),
                depth: thread.depth,
                broadcast: thread.broadcast,
            });
            let (_stored, inserted) = insert_event_with_thread_metadata_tx(
                &mut tx,
                community_id,
                &record.event,
                Some(record.channel_id),
                thread_params,
            )
            .await?;
            if !inserted {
                return Err(DbError::InvalidData(
                    "event id exists without matching historical ledger".to_string(),
                ));
            }
            insert_mentions_tx(&mut tx, community_id, record).await?;
            insert_reaction_tx(&mut tx, community_id, record).await?;
            let created_at =
                DateTime::<Utc>::from_timestamp(record.event.created_at.as_secs() as i64, 0)
                    .ok_or(DbError::InvalidTimestamp(
                        record.event.created_at.as_secs() as i64
                    ))?;
            sqlx::query(
                "INSERT INTO bluplai_historical_imports \
                 (community_id,source_key,source_sha256,manifest_sha256,channel_id, \
                  event_id,event_created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            )
            .bind(community_id.as_uuid())
            .bind(&record.source_key)
            .bind(&record.source_sha256)
            .bind(&record.manifest_sha256)
            .bind(record.channel_id)
            .bind(record.event.id.as_bytes().as_slice())
            .bind(created_at)
            .execute(&mut *tx)
            .await?;
            outcomes.push(HistoricalImportOutcome::Inserted);
        }
        tx.commit().await?;
        Ok(outcomes)
    }
}

fn validate_record(record: &HistoricalImportRecord) -> Result<()> {
    for value in [&record.source_sha256, &record.manifest_sha256] {
        if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err(DbError::InvalidData("invalid import checksum".to_string()));
        }
    }
    verify_event(&record.event)
        .map_err(|_| DbError::InvalidData("invalid import event signature".to_string()))?;
    let tags: Vec<Vec<String>> = record
        .event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    let has_source = tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some("bluplai-source")
            && tag.get(1).map(String::as_str) == Some("imported")
    });
    let has_key = tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some("bluplai-migration-key")
            && tag.get(1).map(String::as_str) == Some(record.source_key.as_str())
    });
    let has_source_hash = tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some("bluplai-source-sha256")
            && tag.get(1).map(String::as_str) == Some(record.source_sha256.as_str())
    });
    let has_manifest_hash = tags.iter().any(|tag| {
        tag.first().map(String::as_str) == Some("bluplai-manifest-sha256")
            && tag.get(1).map(String::as_str) == Some(record.manifest_sha256.as_str())
    });
    let forbidden_identity = tags.iter().any(|tag| {
        matches!(
            tag.first().map(String::as_str),
            Some("clerk") | Some("email") | Some("bluplai-clerk-user")
        )
    });
    if !has_source || !has_key || !has_source_hash || !has_manifest_hash || forbidden_identity {
        return Err(DbError::InvalidData(
            "invalid Bluplai import provenance tags".to_string(),
        ));
    }
    Ok(())
}

fn reply_target(event: &Event) -> Option<Vec<u8>> {
    event.tags.iter().find_map(|tag| {
        let values = tag.as_slice();
        (values.first().map(String::as_str) == Some("e")
            && values.get(3).map(String::as_str) == Some("reply"))
        .then(|| values.get(1))
        .flatten()
        .and_then(|value| hex::decode(value).ok())
        .filter(|value| value.len() == 32)
    })
}

struct OwnedThreadMetadata {
    event_created_at: DateTime<Utc>,
    parent_event_id: Vec<u8>,
    parent_event_created_at: DateTime<Utc>,
    root_event_id: Vec<u8>,
    root_event_created_at: DateTime<Utc>,
    depth: i32,
    broadcast: bool,
}

async fn resolve_thread_metadata(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community_id: CommunityId,
    channel_id: Uuid,
    event: &Event,
) -> Result<Option<OwnedThreadMetadata>> {
    let Some(parent_id) = reply_target(event) else {
        return Ok(None);
    };
    let parent = sqlx::query(
        "SELECT e.created_at,tm.root_event_id,tm.root_event_created_at,tm.depth \
         FROM events e LEFT JOIN thread_metadata tm \
           ON tm.community_id=e.community_id AND tm.event_id=e.id \
         WHERE e.community_id=$1 AND e.channel_id=$2 AND e.id=$3 \
         ORDER BY e.created_at LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(&parent_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| DbError::InvalidData("historical reply parent missing".to_string()))?;
    let parent_created_at: DateTime<Utc> = parent.try_get("created_at")?;
    let stored_root: Option<Vec<u8>> = parent.try_get("root_event_id")?;
    let stored_root_created: Option<DateTime<Utc>> = parent.try_get("root_event_created_at")?;
    let parent_depth: Option<i32> = parent.try_get("depth")?;
    let root_id = stored_root.unwrap_or_else(|| parent_id.clone());
    let root_created_at = stored_root_created.unwrap_or(parent_created_at);
    let created_at = DateTime::<Utc>::from_timestamp(event.created_at.as_secs() as i64, 0)
        .ok_or(DbError::InvalidTimestamp(event.created_at.as_secs() as i64))?;
    let broadcast = event.tags.iter().any(|tag| {
        let values = tag.as_slice();
        values.first().map(String::as_str) == Some("bluplai-broadcast")
            && values.get(1).map(String::as_str) == Some("true")
    });
    Ok(Some(OwnedThreadMetadata {
        event_created_at: created_at,
        parent_event_id: parent_id,
        parent_event_created_at: parent_created_at,
        root_event_id: root_id,
        root_event_created_at: root_created_at,
        depth: parent_depth.unwrap_or(0) + 1,
        broadcast,
    }))
}

async fn insert_mentions_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community_id: CommunityId,
    record: &HistoricalImportRecord,
) -> Result<()> {
    let created_at = DateTime::<Utc>::from_timestamp(record.event.created_at.as_secs() as i64, 0)
        .ok_or(DbError::InvalidTimestamp(
        record.event.created_at.as_secs() as i64
    ))?;
    for pubkey in record.event.tags.iter().filter_map(|tag| {
        let values = tag.as_slice();
        (values.first().map(String::as_str) == Some("p"))
            .then(|| values.get(1).cloned())
            .flatten()
    }) {
        if pubkey.len() != 64 || !pubkey.chars().all(|value| value.is_ascii_hexdigit()) {
            continue;
        }
        sqlx::query(
            "INSERT INTO event_mentions \
             (community_id,pubkey_hex,event_id,event_created_at,channel_id,event_kind) \
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        )
        .bind(community_id.as_uuid())
        .bind(pubkey.to_ascii_lowercase())
        .bind(record.event.id.as_bytes().as_slice())
        .bind(created_at)
        .bind(record.channel_id)
        .bind(i32::from(record.event.kind.as_u16()))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_reaction_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community_id: CommunityId,
    record: &HistoricalImportRecord,
) -> Result<()> {
    if record.event.kind.as_u16() != 7 {
        return Ok(());
    }
    let target = record.event.tags.iter().find_map(|tag| {
        let values = tag.as_slice();
        (values.first().map(String::as_str) == Some("e"))
            .then(|| values.get(1))
            .flatten()
            .and_then(|value| hex::decode(value).ok())
    });
    let Some(target) = target else {
        return Err(DbError::InvalidData("reaction target missing".to_string()));
    };
    let target_created_at: DateTime<Utc> = sqlx::query_scalar(
        "SELECT created_at FROM events WHERE community_id=$1 AND id=$2 ORDER BY created_at LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(&target)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO reactions \
         (community_id,event_created_at,event_id,pubkey,emoji,reaction_event_id) \
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    )
    .bind(community_id.as_uuid())
    .bind(target_created_at)
    .bind(target)
    .bind(record.event.pubkey.to_bytes().as_slice())
    .bind(&record.event.content)
    .bind(record.event.id.as_bytes().as_slice())
    .execute(&mut **tx)
    .await?;
    Ok(())
}
