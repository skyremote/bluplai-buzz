//! Durable Bluplai-visible event outbox.
//!
//! Appends occur in the same transaction as the event row. Only a small,
//! explicit human-visible allowlist is mirrored; duplicate relay submissions
//! remain idempotent through `(community_id, event_id)`.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use buzz_core::CommunityId;
use nostr::Event;

use crate::Result;

const BLUPLAI_MESSAGE_KIND: u32 = 9;
const BLUPLAI_REACTION_KIND: u32 = 7;

fn source_class(event: &Event) -> &'static str {
    event
        .tags
        .iter()
        .find_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some("bluplai-source"))
                .then(|| values.get(1).map(String::as_str))
                .flatten()
        })
        .and_then(|value| match value {
            "live_human" => Some("live_human"),
            "live_agent" => Some("live_agent"),
            "imported" => Some("imported"),
            "replayed" => Some("replayed"),
            "system" => Some("system"),
            _ => None,
        })
        .unwrap_or("live_human")
}

fn notification_class(event: &Event) -> Option<&'static str> {
    match u32::from(event.kind.as_u16()) {
        BLUPLAI_REACTION_KIND => Some("reaction"),
        BLUPLAI_MESSAGE_KIND => {
            let reply = event.tags.iter().any(|tag| {
                let values = tag.as_slice();
                values.first().map(String::as_str) == Some("e")
                    && values.get(3).map(String::as_str) == Some("reply")
            });
            Some(if reply { "reply" } else { "message" })
        }
        _ => None,
    }
}

/// Append a committed-visible event inside the caller's event transaction.
pub(crate) async fn append_visible_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    channel_id: Option<Uuid>,
    event: &Event,
) -> Result<()> {
    let Some(channel_id) = channel_id else {
        return Ok(());
    };
    let Some(notification_class) = notification_class(event) else {
        return Ok(());
    };
    let created_at_secs = event.created_at.as_secs() as i64;
    let Some(event_created_at) = DateTime::<Utc>::from_timestamp(created_at_secs, 0) else {
        return Ok(());
    };
    let payload: Value = serde_json::to_value(event)?;
    sqlx::query(
        r#"
        INSERT INTO bluplai_visible_event_outbox
            (community_id, channel_id, event_id, event_created_at, event_kind,
             author_pubkey, notification_class, source_class, payload)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
        WHERE EXISTS (
            SELECT 1 FROM bluplai_managed_rooms
            WHERE community_id=$1 AND channel_id=$2
        )
        ON CONFLICT (community_id, event_id) DO NOTHING
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(event.id.as_bytes().as_slice())
    .bind(event_created_at)
    .bind(i32::from(event.kind.as_u16()))
    .bind(event.pubkey.to_bytes().as_slice())
    .bind(notification_class)
    .bind(source_class(event))
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Mark a provisioned private channel as a Bluplai-owned integration room.
pub async fn mark_managed_room(
    pool: &sqlx::PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    disclosure_scope: &str,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO bluplai_managed_rooms
            (community_id, channel_id, disclosure_scope)
        VALUES ($1, $2, $3)
        ON CONFLICT (community_id, channel_id) DO UPDATE SET
            disclosure_scope=EXCLUDED.disclosure_scope
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(disclosure_scope)
    .execute(pool)
    .await?;
    Ok(())
}

/// One claimed visible event for the Bluplai consumer.
#[derive(Debug)]
pub struct ClaimedVisibleEvent {
    /// Stable outbox row identifier.
    pub id: Uuid,
    /// Bound Buzz room/channel.
    pub channel_id: Uuid,
    /// Signed event id as bytes.
    pub event_id: Vec<u8>,
    /// Signed event timestamp.
    pub event_created_at: DateTime<Utc>,
    /// Signed event kind.
    pub event_kind: i32,
    /// Signed author public key.
    pub author_pubkey: Vec<u8>,
    /// Signed event payload.
    pub payload: Value,
    /// Notification type derived at acceptance.
    pub notification_class: String,
    /// Live/import/replay/system classification.
    pub source_class: String,
}

/// Claim a bounded batch without allowing two consumers to own the same row.
pub async fn claim_visible_events(
    pool: &sqlx::PgPool,
    community_id: CommunityId,
    limit: i64,
) -> Result<Vec<ClaimedVisibleEvent>> {
    let rows = sqlx::query(
        r#"
        WITH claimed AS (
            SELECT id
            FROM bluplai_visible_event_outbox
            WHERE community_id = $1 AND consumed_at IS NULL
              AND available_at <= now()
              AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        )
        UPDATE bluplai_visible_event_outbox AS o
        SET claimed_at = now(), attempts = attempts + 1
        FROM claimed
        WHERE o.id = claimed.id
        RETURNING o.id, o.channel_id, o.event_id, o.event_created_at,
                  o.event_kind, o.author_pubkey, o.payload,
                  o.notification_class, o.source_class
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(limit.clamp(1, 500))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ClaimedVisibleEvent {
            id: row.get("id"),
            channel_id: row.get("channel_id"),
            event_id: row.get("event_id"),
            event_created_at: row.get("event_created_at"),
            event_kind: row.get("event_kind"),
            author_pubkey: row.get("author_pubkey"),
            payload: row.get("payload"),
            notification_class: row.get("notification_class"),
            source_class: row.get("source_class"),
        })
        .collect())
}

/// Mark a journaled row consumed. Repeating the call is harmless.
pub async fn complete_visible_event(
    pool: &sqlx::PgPool,
    community_id: CommunityId,
    id: Uuid,
) -> Result<()> {
    sqlx::query(
        "UPDATE bluplai_visible_event_outbox SET consumed_at=COALESCE(consumed_at, now()) WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bluplai_membership::provision_managed_room;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    async fn pool() -> sqlx::PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .expect("BUZZ_TEST_DATABASE_URL or DATABASE_URL");
        sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect test DB")
    }

    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn bluplai_visible_outbox_is_transactional_classified_and_replay_safe() {
        let pool = pool().await;
        let community_uuid = Uuid::new_v4();
        let community = CommunityId::from_uuid(community_uuid);
        let room = Uuid::new_v4();
        let member = vec![8_u8; 32];
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("bluplai-outbox-{}.test", community_uuid.simple()))
            .execute(&pool)
            .await
            .expect("insert community");
        provision_managed_room(
            &pool,
            community,
            room,
            "Visible outbox",
            "private",
            &member,
            std::slice::from_ref(&member),
        )
        .await
        .expect("provision room");
        let event = EventBuilder::new(Kind::Custom(9), "imported history")
            .tags([Tag::parse(["bluplai-source", "imported"]).expect("source tag")])
            .sign_with_keys(&Keys::generate())
            .expect("sign event");

        let mut rolled_back = pool.begin().await.expect("begin rollback tx");
        append_visible_event_tx(&mut rolled_back, community, Some(room), &event)
            .await
            .expect("append in rollback tx");
        rolled_back.rollback().await.expect("rollback");
        assert!(claim_visible_events(&pool, community, 50)
            .await
            .expect("claim after rollback")
            .is_empty());

        let mut committed = pool.begin().await.expect("begin commit tx");
        append_visible_event_tx(&mut committed, community, Some(room), &event)
            .await
            .expect("append in commit tx");
        committed.commit().await.expect("commit");
        let claimed = claim_visible_events(&pool, community, 50)
            .await
            .expect("claim event");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].notification_class, "message");
        assert_eq!(claimed[0].source_class, "imported");
        assert_eq!(claimed[0].event_id, event.id.as_bytes().to_vec());
        complete_visible_event(&pool, community, claimed[0].id)
            .await
            .expect("complete event");
        assert!(claim_visible_events(&pool, community, 50)
            .await
            .expect("claim after completion")
            .is_empty());

        sqlx::query("DELETE FROM channels WHERE community_id=$1")
            .bind(community_uuid)
            .execute(&pool)
            .await
            .expect("clean channels");
        sqlx::query("DELETE FROM communities WHERE id=$1")
            .bind(community_uuid)
            .execute(&pool)
            .await
            .expect("clean community");
    }
}
