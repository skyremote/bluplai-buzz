//! Optional room-scoped media authorization for Bluplai uploads.

use sqlx::PgPool;
use uuid::Uuid;

use buzz_core::CommunityId;

use crate::Result;

/// Bind a claimed hash to one room before object storage begins.
///
/// A compatible repeat updates only verified metadata. A different-room race
/// affects zero rows, so an object can never exist briefly without a private
/// room ACL or be rebound after its URL is known.
#[allow(clippy::too_many_arguments)]
pub async fn bind_room_media(
    pool: &PgPool,
    community_id: CommunityId,
    sha256: &[u8],
    channel_id: Uuid,
    uploader_pubkey: &[u8],
    byte_size: i64,
    content_type: Option<&str>,
) -> Result<bool> {
    let result = sqlx::query(
        r#"
        INSERT INTO bluplai_room_media_acl
            (community_id, sha256, channel_id, uploader_pubkey, byte_size, content_type)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (community_id, sha256) DO UPDATE SET
            byte_size=EXCLUDED.byte_size,
            content_type=COALESCE(EXCLUDED.content_type, bluplai_room_media_acl.content_type)
        WHERE bluplai_room_media_acl.channel_id=EXCLUDED.channel_id
          AND bluplai_room_media_acl.deleted_at IS NULL
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(sha256)
    .bind(channel_id)
    .bind(uploader_pubkey)
    .bind(byte_size)
    .bind(content_type)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Return the room for a protected hash, or `None` for ordinary Blossom media.
pub async fn protected_media_room(
    pool: &PgPool,
    community_id: CommunityId,
    sha256: &[u8],
) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        r#"
        SELECT channel_id FROM bluplai_room_media_acl
        WHERE community_id=$1 AND sha256=$2 AND deleted_at IS NULL
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(sha256)
    .fetch_optional(pool)
    .await?)
}

/// Check current room membership for every GET/HEAD/range/thumbnail request.
pub async fn can_read_protected_media(
    pool: &PgPool,
    community_id: CommunityId,
    sha256: &[u8],
    reader_pubkey: &[u8],
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM bluplai_room_media_acl AS media
            JOIN channel_members AS member
              ON member.community_id = media.community_id
             AND member.channel_id = media.channel_id
             AND member.pubkey = $3
             AND member.removed_at IS NULL
            WHERE media.community_id=$1 AND media.sha256=$2
              AND media.deleted_at IS NULL
        )
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(sha256)
    .bind(reader_pubkey)
    .fetch_one(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bluplai_membership::provision_managed_room;

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
    async fn bluplai_media_acl_requires_current_exact_room_membership() {
        let pool = pool().await;
        let community_uuid = Uuid::new_v4();
        let community = CommunityId::from_uuid(community_uuid);
        let room = Uuid::new_v4();
        let member = vec![4_u8; 32];
        let peer = vec![5_u8; 32];
        let same_org_nonmember = vec![6_u8; 32];
        let sha256 = vec![7_u8; 32];
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("bluplai-media-{}.test", community_uuid.simple()))
            .execute(&pool)
            .await
            .expect("insert community");
        provision_managed_room(
            &pool,
            community,
            room,
            "Private media",
            "private",
            &member,
            &[member.clone(), peer.clone()],
        )
        .await
        .expect("provision room");
        assert!(bind_room_media(
            &pool,
            community,
            &sha256,
            room,
            &member,
            42,
            Some("image/png"),
        )
        .await
        .expect("bind media"));
        assert!(bind_room_media(
            &pool,
            community,
            &sha256,
            room,
            &member,
            42,
            Some("image/png"),
        )
        .await
        .expect("repeat compatible media binding"));
        let other_room = Uuid::new_v4();
        provision_managed_room(
            &pool,
            community,
            other_room,
            "Other private room",
            "private",
            &same_org_nonmember,
            std::slice::from_ref(&same_org_nonmember),
        )
        .await
        .expect("provision other room");
        assert!(!bind_room_media(
            &pool,
            community,
            &sha256,
            other_room,
            &same_org_nonmember,
            42,
            Some("image/png"),
        )
        .await
        .expect("reject conflicting room binding"));
        assert_eq!(
            protected_media_room(&pool, community, &sha256)
                .await
                .expect("resolve media room"),
            Some(room)
        );
        assert!(can_read_protected_media(&pool, community, &sha256, &peer)
            .await
            .expect("member read"));
        assert!(
            !can_read_protected_media(&pool, community, &sha256, &same_org_nonmember)
                .await
                .expect("nonmember denial")
        );

        sqlx::query(
            "UPDATE channel_members SET removed_at=now() \
             WHERE community_id=$1 AND channel_id=$2 AND pubkey=$3",
        )
        .bind(community_uuid)
        .bind(room)
        .bind(&peer)
        .execute(&pool)
        .await
        .expect("revoke member");
        assert!(!can_read_protected_media(&pool, community, &sha256, &peer)
            .await
            .expect("revoked denial"));

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
