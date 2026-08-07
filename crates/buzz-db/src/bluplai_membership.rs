//! Operator-authorized, idempotent Bluplai membership projection.

use sqlx::{PgPool, Row};
use uuid::Uuid;

use buzz_core::{channel::MemberRole, CommunityId};

use crate::Result;

/// Idempotently provision one private managed room and its immutable DM set.
#[allow(clippy::too_many_arguments)]
pub async fn provision_managed_room(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    name: &str,
    disclosure_scope: &str,
    owner_pubkey: &[u8],
    member_pubkeys: &[Vec<u8>],
) -> Result<bool> {
    if channel_id.is_nil() || owner_pubkey.len() != 32 {
        return Err(crate::DbError::InvalidData(
            "invalid managed room identity".into(),
        ));
    }
    if !matches!(disclosure_scope, "internal" | "shared" | "private" | "dm") {
        return Err(crate::DbError::InvalidData(
            "invalid disclosure scope".into(),
        ));
    }
    let name = buzz_core::channel::canonical_channel_name(name);
    if name.trim().is_empty() {
        return Err(crate::DbError::InvalidData(
            "managed room name is required".into(),
        ));
    }

    let mut members = member_pubkeys.to_vec();
    if !members
        .iter()
        .any(|member| member.as_slice() == owner_pubkey)
    {
        members.push(owner_pubkey.to_vec());
    }
    members.sort_unstable();
    members.dedup();
    if members.iter().any(|member| member.len() != 32) {
        return Err(crate::DbError::InvalidData(
            "managed room pubkeys must be 32 bytes".into(),
        ));
    }
    if disclosure_scope == "dm" && !(2..=9).contains(&members.len()) {
        return Err(crate::DbError::InvalidData(
            "managed DM requires 2-9 participants".into(),
        ));
    }
    let channel_type = if disclosure_scope == "dm" {
        "dm"
    } else {
        "stream"
    };
    let participant_hash = (disclosure_scope == "dm").then(|| {
        let refs = members.iter().map(Vec::as_slice).collect::<Vec<_>>();
        crate::dm::compute_participant_hash(&refs).to_vec()
    });
    let owner_hex = hex::encode(owner_pubkey);

    let mut tx = pool.begin().await?;
    let created = sqlx::query(
        r#"
        INSERT INTO channels
            (id, community_id, name, channel_type, visibility, description,
             created_by, participant_hash)
        VALUES ($1, $2, $3, $4::channel_type, 'private',
                'Managed by Bluplai', $5, $6)
        ON CONFLICT (community_id, id) DO NOTHING
        "#,
    )
    .bind(channel_id)
    .bind(community_id.as_uuid())
    .bind(name)
    .bind(channel_type)
    .bind(owner_pubkey)
    .bind(participant_hash.as_deref())
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;

    let existing = sqlx::query(
        r#"
        SELECT channel_type::text AS channel_type,
               visibility::text AS visibility, participant_hash
        FROM channels WHERE community_id=$1 AND id=$2
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .fetch_one(&mut *tx)
    .await?;
    let existing_type: String = existing.get("channel_type");
    let existing_visibility: String = existing.get("visibility");
    let existing_hash: Option<Vec<u8>> = existing.get("participant_hash");
    if existing_type != channel_type
        || existing_visibility != "private"
        || existing_hash != participant_hash
    {
        return Err(crate::DbError::InvalidData(
            "managed room id is already bound differently".into(),
        ));
    }

    // Managed-room users are ordinary Buzz members. The isolated operator API
    // owns raw administration, so a Bluplai owner/admin never gains a relay
    // owner role that would outlive Bluplai revocation.
    for member in &members {
        let member_hex = hex::encode(member);
        // Managed Nostr keys are server-held, but closed relays still require
        // tenant-scoped relay admission before NIP-42 authentication. Keep
        // existing owner/admin roles intact if this pubkey was already known.
        sqlx::query(
            r#"
            INSERT INTO relay_members
                (community_id, pubkey, role, added_by)
            VALUES ($1, $2, 'member', $3)
            ON CONFLICT (community_id, pubkey) DO NOTHING
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(&member_hex)
        .bind(&owner_hex)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO channel_members
                (community_id, channel_id, pubkey, role, invited_by)
            VALUES ($1, $2, $3, 'member', $4)
            ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                role='member', removed_at=NULL, removed_by=NULL
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(channel_id)
        .bind(member)
        .bind(owner_pubkey)
        .execute(&mut *tx)
        .await?;
    }
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
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(created)
}

/// Apply one desired member row without treating Buzz as the authority source.
pub async fn project_member(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    member_pubkey: &[u8],
    operation: &str,
    role: MemberRole,
    operator_pubkey: &[u8],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let managed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM bluplai_managed_rooms WHERE community_id=$1 AND channel_id=$2)",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .fetch_one(&mut *tx)
    .await?;
    if !managed {
        return Err(crate::DbError::InvalidData(
            "room is not managed by Bluplai".into(),
        ));
    }
    let channel_type: String = sqlx::query_scalar(
        "SELECT channel_type::text FROM channels WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .fetch_one(&mut *tx)
    .await?;
    match operation {
        "upsert" => {
            if channel_type == "dm" {
                let original_member: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM channel_members WHERE community_id=$1 AND channel_id=$2 AND pubkey=$3)",
                )
                .bind(community_id.as_uuid())
                .bind(channel_id)
                .bind(member_pubkey)
                .fetch_one(&mut *tx)
                .await?;
                if !original_member {
                    return Err(crate::DbError::InvalidData(
                        "DM participant sets are immutable".into(),
                    ));
                }
            }
            let member_hex = hex::encode(member_pubkey);
            let operator_hex = hex::encode(operator_pubkey);
            sqlx::query(
                r#"
                INSERT INTO relay_members
                    (community_id, pubkey, role, added_by)
                VALUES ($1, $2, 'member', $3)
                ON CONFLICT (community_id, pubkey) DO NOTHING
                "#,
            )
            .bind(community_id.as_uuid())
            .bind(&member_hex)
            .bind(&operator_hex)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO channel_members
                    (community_id, channel_id, pubkey, role, invited_by)
                VALUES ($1, $2, $3, $4::member_role, $5)
                ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                    role=EXCLUDED.role,
                    invited_by=EXCLUDED.invited_by,
                    removed_at=NULL,
                    removed_by=NULL
                "#,
            )
            .bind(community_id.as_uuid())
            .bind(channel_id)
            .bind(member_pubkey)
            .bind(role.as_str())
            .bind(operator_pubkey)
            .execute(&mut *tx)
            .await?;
        }
        "remove" => {
            sqlx::query(
                r#"
                UPDATE channel_members
                SET removed_at=COALESCE(removed_at, now()), removed_by=$1
                WHERE community_id=$2 AND channel_id=$3 AND pubkey=$4
                "#,
            )
            .bind(operator_pubkey)
            .bind(community_id.as_uuid())
            .bind(channel_id)
            .bind(member_pubkey)
            .execute(&mut *tx)
            .await?;
            let member_hex = hex::encode(member_pubkey);
            sqlx::query(
                r#"
                DELETE FROM relay_members AS relay
                WHERE relay.community_id=$1
                  AND relay.pubkey=$2
                  AND relay.role='member'
                  AND NOT EXISTS (
                    SELECT 1 FROM channel_members AS channel
                    WHERE channel.community_id=relay.community_id
                      AND channel.pubkey=$3
                      AND channel.removed_at IS NULL
                  )
                "#,
            )
            .bind(community_id.as_uuid())
            .bind(&member_hex)
            .bind(member_pubkey)
            .execute(&mut *tx)
            .await?;
        }
        _ => return Err(crate::DbError::InvalidData("invalid operation".into())),
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .expect("BUZZ_TEST_DATABASE_URL or DATABASE_URL");
        PgPool::connect(&database_url)
            .await
            .expect("connect test DB")
    }

    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn bluplai_managed_dm_is_exact_member_only_and_idempotent() {
        let pool = pool().await;
        let community_uuid = Uuid::new_v4();
        let community = CommunityId::from_uuid(community_uuid);
        let room = Uuid::new_v4();
        let owner = vec![1_u8; 32];
        let peer = vec![2_u8; 32];
        let outsider = vec![3_u8; 32];
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("bluplai-dm-{}.test", community_uuid.simple()))
            .execute(&pool)
            .await
            .expect("insert community");

        assert!(provision_managed_room(
            &pool,
            community,
            room,
            "Direct message",
            "dm",
            &owner,
            &[owner.clone(), peer.clone()],
        )
        .await
        .expect("provision DM"));
        assert!(!provision_managed_room(
            &pool,
            community,
            room,
            "Direct message",
            "dm",
            &owner,
            &[peer.clone(), owner.clone()],
        )
        .await
        .expect("repeat exact DM"));
        let rows: Vec<(Vec<u8>, String, bool)> = sqlx::query_as(
            "SELECT pubkey, role::text, removed_at IS NULL FROM channel_members \
             WHERE community_id=$1 AND channel_id=$2 ORDER BY pubkey",
        )
        .bind(community_uuid)
        .bind(room)
        .fetch_all(&pool)
        .await
        .expect("read projected members");
        assert_eq!(
            rows,
            vec![
                (owner.clone(), "member".into(), true),
                (peer.clone(), "member".into(), true),
            ]
        );
        let relay_rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT pubkey, role FROM relay_members WHERE community_id=$1 ORDER BY pubkey",
        )
        .bind(community_uuid)
        .fetch_all(&pool)
        .await
        .expect("read relay members");
        assert_eq!(
            relay_rows,
            vec![
                (hex::encode(&owner), "member".into()),
                (hex::encode(&peer), "member".into()),
            ]
        );

        let denied = project_member(
            &pool,
            community,
            room,
            &outsider,
            "upsert",
            MemberRole::Member,
            &owner,
        )
        .await;
        assert!(denied.is_err(), "DM must reject a new participant");

        project_member(
            &pool,
            community,
            room,
            &peer,
            "remove",
            MemberRole::Member,
            &owner,
        )
        .await
        .expect("revoke original participant");
        let peer_is_relay_member: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM relay_members WHERE community_id=$1 AND pubkey=$2)",
        )
        .bind(community_uuid)
        .bind(hex::encode(&peer))
        .fetch_one(&pool)
        .await
        .expect("read revoked relay member");
        assert!(!peer_is_relay_member);
        project_member(
            &pool,
            community,
            room,
            &peer,
            "upsert",
            MemberRole::Member,
            &owner,
        )
        .await
        .expect("restore original participant");
        let peer_is_relay_member: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM relay_members WHERE community_id=$1 AND pubkey=$2)",
        )
        .bind(community_uuid)
        .bind(hex::encode(&peer))
        .fetch_one(&pool)
        .await
        .expect("read restored relay member");
        assert!(peer_is_relay_member);

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
