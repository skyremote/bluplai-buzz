use buzz_core::tenant::CommunityId;
use buzz_db::historical_import::{
    HistoricalImportDb, HistoricalImportOutcome, HistoricalImportRecord,
};
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

fn database_url() -> Option<String> {
    std::env::var("BUZZ_TEST_DATABASE_URL")
        .ok()
        .or_else(|| std::env::var("DATABASE_URL").ok())
}

#[tokio::test]
#[ignore = "requires a migrated Postgres writer"]
async fn historical_import_is_atomic_idempotent_and_silent() {
    let Some(database_url) = database_url() else {
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .expect("connect test database");
    let community_uuid = Uuid::new_v4();
    let community = CommunityId::from_uuid(community_uuid);
    let channel_id = Uuid::new_v4();
    let keys = Keys::generate();
    sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
        .bind(community_uuid)
        .bind(format!("historical-{}.test", community_uuid.simple()))
        .execute(&pool)
        .await
        .expect("community");
    sqlx::query(
        "INSERT INTO channels \
         (community_id,id,name,channel_type,visibility,created_by) \
         VALUES ($1,$2,'Historical','stream','private',$3)",
    )
    .bind(community_uuid)
    .bind(channel_id)
    .bind(keys.public_key().to_bytes().as_slice())
    .execute(&pool)
    .await
    .expect("channel");
    sqlx::query(
        "INSERT INTO bluplai_managed_rooms \
         (community_id,channel_id,disclosure_scope) VALUES ($1,$2,'private')",
    )
    .bind(community_uuid)
    .bind(channel_id)
    .execute(&pool)
    .await
    .expect("managed room");

    let source_key = format!("legacy-message:{:064x}", 1);
    let source_sha256 = "b".repeat(64);
    let manifest_sha256 = "a".repeat(64);
    let event = EventBuilder::new(Kind::Custom(9), "historical hello")
        .tags([
            Tag::parse(["h", channel_id.to_string().as_str()]).expect("h"),
            Tag::parse(["bluplai-source", "imported"]).expect("source"),
            Tag::parse(["bluplai-migration-key", source_key.as_str()]).expect("key"),
            Tag::parse(["bluplai-source-sha256", source_sha256.as_str()]).expect("hash"),
            Tag::parse(["bluplai-manifest-sha256", manifest_sha256.as_str()]).expect("manifest"),
        ])
        .custom_created_at(Timestamp::from(1_700_000_000))
        .sign_with_keys(&keys)
        .expect("sign");
    let record = HistoricalImportRecord {
        source_key: source_key.clone(),
        source_sha256: source_sha256.clone(),
        manifest_sha256,
        channel_id,
        event: event.clone(),
    };
    let mut importer = HistoricalImportDb::connect(&database_url)
        .await
        .expect("unarmed writer");
    assert_eq!(
        importer
            .import_batch(community, std::slice::from_ref(&record))
            .await
            .expect("first import"),
        vec![HistoricalImportOutcome::Inserted]
    );
    assert_eq!(
        importer
            .import_batch(community, std::slice::from_ref(&record))
            .await
            .expect("replay"),
        vec![HistoricalImportOutcome::AlreadyImported]
    );
    let event_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND id=$2")
            .bind(community_uuid)
            .bind(event.id.as_bytes().as_slice())
            .fetch_one(&pool)
            .await
            .expect("event count");
    let ledger_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM bluplai_historical_imports \
         WHERE community_id=$1 AND source_key=$2",
    )
    .bind(community_uuid)
    .bind(&source_key)
    .fetch_one(&pool)
    .await
    .expect("ledger count");
    let source_class: String = sqlx::query_scalar(
        "SELECT source_class FROM bluplai_visible_event_outbox \
         WHERE community_id=$1 AND event_id=$2",
    )
    .bind(community_uuid)
    .bind(event.id.as_bytes().as_slice())
    .fetch_one(&pool)
    .await
    .expect("outbox source");
    assert_eq!((event_count, ledger_count), (1, 1));
    assert_eq!(source_class, "imported");

    let conflicting = HistoricalImportRecord {
        source_sha256: "c".repeat(64),
        ..record
    };
    assert!(importer
        .import_batch(community, &[conflicting])
        .await
        .is_err());
    let still_one: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM bluplai_historical_imports \
         WHERE community_id=$1 AND source_key=$2",
    )
    .bind(community_uuid)
    .bind(&source_key)
    .fetch_one(&pool)
    .await
    .expect("post-conflict ledger count");
    assert_eq!(still_one, 1);

    sqlx::query("DELETE FROM events WHERE community_id=$1")
        .bind(community_uuid)
        .execute(&pool)
        .await
        .expect("event cleanup");
    sqlx::query("DELETE FROM channels WHERE community_id=$1 AND id=$2")
        .bind(community_uuid)
        .bind(channel_id)
        .execute(&pool)
        .await
        .expect("channel cleanup");
    sqlx::query("DELETE FROM communities WHERE id=$1")
        .bind(community_uuid)
        .execute(&pool)
        .await
        .expect("cleanup");
}
