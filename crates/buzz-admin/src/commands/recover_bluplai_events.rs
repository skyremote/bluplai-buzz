use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use buzz_core::kind::{KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2};
use buzz_core::{normalize_host, verify_event, Event, VerificationError};
use buzz_db::{DbError, EventRecoveryDb};
use nostr::JsonUtil;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(crate) const MAX_JOURNAL_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_RECORD_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RECORDS: usize = 100_000;
const MAX_TAGS: usize = 256;
const MAX_TAG_PARTS: usize = 16;
const MAX_TAG_PART_BYTES: usize = 4096;
const JOURNAL_VERSION: u8 = 1;
const EVENT_SET_HASH_DOMAIN: &[u8] = b"bluplai-signed-event-recovery-v1\0";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalRecord {
    version: u8,
    community_host: String,
    channel_id: String,
    event: RawSignedEvent,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawSignedEvent {
    id: String,
    pubkey: String,
    created_at: u64,
    kind: u16,
    tags: Vec<Vec<String>>,
    content: String,
    sig: String,
}

#[derive(Debug)]
pub(crate) struct PreparedRecord {
    pub line: usize,
    pub channel_id: Uuid,
    pub event: Event,
}

#[derive(Debug)]
pub(crate) struct PreparedJournal {
    community_host: String,
    records: Vec<PreparedRecord>,
    watermark_created_at: u64,
    watermark_event_id: String,
    event_set_sha256: String,
}

impl PreparedJournal {
    pub(crate) fn records(&self) -> &[PreparedRecord] {
        &self.records
    }

    pub(crate) fn reconciliation_summary(
        &self,
        already_present: usize,
        inserted: usize,
        dry_run: bool,
    ) -> Result<RecoverySummary, String> {
        if dry_run && inserted != 0 {
            return Err("dry-run recovery cannot report inserted events".to_string());
        }
        let present = already_present
            .checked_add(inserted)
            .filter(|present| *present <= self.records.len())
            .ok_or_else(|| "recovery reconciliation counts are inconsistent".to_string())?;
        Ok(RecoverySummary {
            version: JOURNAL_VERSION,
            community_host: self.community_host.clone(),
            dry_run,
            expected: self.records.len(),
            present,
            inserted,
            already_present,
            missing: self.records.len() - present,
            watermark_created_at: self.watermark_created_at,
            watermark_event_id: self.watermark_event_id.clone(),
            event_set_sha256: self.event_set_sha256.clone(),
        })
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct RecoverySummary {
    pub version: u8,
    pub community_host: String,
    pub dry_run: bool,
    pub expected: usize,
    pub present: usize,
    pub inserted: usize,
    pub already_present: usize,
    pub missing: usize,
    pub watermark_created_at: u64,
    pub watermark_event_id: String,
    pub event_set_sha256: String,
}

pub(crate) fn parse_and_verify_journal(
    input: &[u8],
    selected_host: &str,
) -> Result<PreparedJournal, String> {
    if input.len() > MAX_JOURNAL_BYTES {
        return Err(format!(
            "journal exceeds {MAX_JOURNAL_BYTES}-byte recovery limit"
        ));
    }
    validate_canonical_host(selected_host)?;

    let mut lines: Vec<&[u8]> = input.split(|byte| *byte == b'\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if lines.len() > MAX_RECORDS {
        return Err(format!(
            "journal record count exceeds {MAX_RECORDS}-record recovery limit"
        ));
    }
    if lines.is_empty() {
        return Err("recovery journal is empty".to_string());
    }

    let mut records = Vec::with_capacity(lines.len());
    let mut seen_event_ids = HashSet::with_capacity(lines.len());
    for (offset, raw_line) in lines.into_iter().enumerate() {
        let line_number = offset + 1;
        let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if raw_line.len() > MAX_RECORD_BYTES {
            return Err(format!(
                "line {line_number}: record exceeds {MAX_RECORD_BYTES}-byte recovery limit"
            ));
        }
        if raw_line.is_empty() {
            return Err(format!(
                "line {line_number}: empty recovery records are forbidden"
            ));
        }

        let record: JournalRecord = serde_json::from_slice(raw_line)
            .map_err(|error| format!("line {line_number}: invalid recovery record: {error}"))?;
        let prepared = validate_record(record, selected_host, line_number)?;
        if !seen_event_ids.insert(prepared.event.id.to_bytes()) {
            return Err(format!(
                "line {line_number}: duplicate event ID in recovery journal"
            ));
        }
        records.push(prepared);
    }

    let watermark = records
        .iter()
        .max_by_key(|record| {
            (
                record.event.created_at.as_secs(),
                record.event.id.to_bytes(),
            )
        })
        .expect("non-empty journal was checked above");
    let watermark_created_at = watermark.event.created_at.as_secs();
    let watermark_event_id = watermark.event.id.to_hex();
    let event_set_sha256 = event_set_hash(selected_host, &records);
    Ok(PreparedJournal {
        community_host: selected_host.to_string(),
        records,
        watermark_created_at,
        watermark_event_id,
        event_set_sha256,
    })
}

pub(crate) async fn recover(
    db: &EventRecoveryDb,
    input: &[u8],
    selected_host: &str,
    dry_run: bool,
) -> Result<RecoverySummary, String> {
    let journal = parse_and_verify_journal(input, selected_host)?;
    let community = db
        .lookup_community_by_host(selected_host)
        .await
        .map_err(|_| "failed to resolve the recovery community".to_string())?
        .ok_or_else(|| "selected host is not an active server-owned community".to_string())?;
    if community.host != selected_host {
        return Err("resolved community host is not canonical".to_string());
    }

    let mut checked_channels = HashSet::new();
    for record in journal.records() {
        if !checked_channels.insert(record.channel_id) {
            continue;
        }
        match db.get_channel(community.id, record.channel_id).await {
            Ok(channel) if channel.archived_at.is_none() => {}
            Ok(_) | Err(DbError::ChannelNotFound(_)) => {
                return Err(format!(
                    "line {}: recovery references a missing, archived, or cross-community channel",
                    record.line
                ));
            }
            Err(_) => return Err("failed to validate recovery channels".to_string()),
        }
    }

    let mut already_present = 0usize;
    let mut missing_indexes = Vec::new();
    for (index, record) in journal.records().iter().enumerate() {
        match existing_event_state(db, community.id, record).await? {
            ExistingEventState::AlreadyPresent => already_present += 1,
            ExistingEventState::Missing => missing_indexes.push(index),
        }
    }

    if dry_run {
        return journal.reconciliation_summary(already_present, 0, true);
    }

    let mut inserted = 0usize;
    for index in missing_indexes {
        let record = &journal.records()[index];
        let (_, was_inserted) = db
            .insert_event(community.id, &record.event, record.channel_id)
            .await
            .map_err(|_| format!("line {}: recovery event insert failed", record.line))?;
        if was_inserted {
            inserted += 1;
        } else {
            match existing_event_state(db, community.id, record).await? {
                ExistingEventState::AlreadyPresent => already_present += 1,
                ExistingEventState::Missing => {
                    return Err(format!(
                        "line {}: recovery insert did not produce a visible event",
                        record.line
                    ));
                }
            }
        }
    }

    for record in journal.records() {
        if !matches!(
            existing_event_state(db, community.id, record).await?,
            ExistingEventState::AlreadyPresent
        ) {
            return Err(format!(
                "line {}: recovery reconciliation found a missing event",
                record.line
            ));
        }
    }
    journal.reconciliation_summary(already_present, inserted, false)
}

pub(crate) fn read_journal_file(path: &Path) -> Result<Vec<u8>, String> {
    let file =
        std::fs::File::open(path).map_err(|_| "failed to open the recovery journal".to_string())?;
    let metadata_len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if metadata_len > MAX_JOURNAL_BYTES as u64 {
        return Err(format!(
            "journal exceeds {MAX_JOURNAL_BYTES}-byte recovery limit"
        ));
    }

    let mut input = Vec::with_capacity((metadata_len as usize).min(MAX_JOURNAL_BYTES));
    file.take(MAX_JOURNAL_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|_| "failed to read the recovery journal".to_string())?;
    if input.len() > MAX_JOURNAL_BYTES {
        return Err(format!(
            "journal exceeds {MAX_JOURNAL_BYTES}-byte recovery limit"
        ));
    }
    Ok(input)
}

pub(crate) fn validate_recovery_environment(
    read_database_url: Option<&str>,
    acknowledgement: Option<&str>,
) -> Result<(), String> {
    if read_database_url.is_some_and(|url| !url.trim().is_empty()) {
        return Err("READ_DATABASE_URL must be unset during event recovery".to_string());
    }
    if acknowledgement != Some("offline-writers-stopped-replica-fence-closed") {
        return Err(
            "BUZZ_RECOVERY_MODE_ACK must equal offline-writers-stopped-replica-fence-closed"
                .to_string(),
        );
    }
    Ok(())
}

enum ExistingEventState {
    AlreadyPresent,
    Missing,
}

async fn existing_event_state(
    db: &EventRecoveryDb,
    community_id: buzz_core::CommunityId,
    record: &PreparedRecord,
) -> Result<ExistingEventState, String> {
    let active = db
        .get_event_by_id(community_id, record.event.id.as_bytes())
        .await
        .map_err(|_| format!("line {}: recovery event lookup failed", record.line))?;
    if let Some(stored) = active {
        if stored.channel_id == Some(record.channel_id)
            && stored.event.as_json() == record.event.as_json()
        {
            return Ok(ExistingEventState::AlreadyPresent);
        }
        return Err(format!(
            "line {}: conflicting event row already exists; recovery will not overwrite it",
            record.line
        ));
    }

    let including_deleted = db
        .get_event_by_id_including_deleted(community_id, record.event.id.as_bytes())
        .await
        .map_err(|_| format!("line {}: recovery event lookup failed", record.line))?;
    if including_deleted.is_some() {
        return Err(format!(
            "line {}: event exists only as deleted; recovery will not overwrite lifecycle state",
            record.line
        ));
    }
    Ok(ExistingEventState::Missing)
}

fn validate_record(
    record: JournalRecord,
    selected_host: &str,
    line_number: usize,
) -> Result<PreparedRecord, String> {
    if record.version != JOURNAL_VERSION {
        return Err(format!(
            "line {line_number}: unsupported recovery record version"
        ));
    }
    if record.community_host != selected_host {
        return Err(format!(
            "line {line_number}: community host does not match the selected server-owned host"
        ));
    }

    let channel_id = Uuid::parse_str(&record.channel_id)
        .map_err(|_| format!("line {line_number}: channel_id must be a canonical channel UUID"))?;
    if channel_id.to_string() != record.channel_id {
        return Err(format!(
            "line {line_number}: channel_id must be a canonical channel UUID"
        ));
    }

    let raw_event = record.event;
    validate_lower_hex(&raw_event.id, 64, "event ID", line_number)?;
    validate_lower_hex(&raw_event.pubkey, 64, "event pubkey", line_number)?;
    validate_lower_hex(&raw_event.sig, 128, "event signature", line_number)?;
    if raw_event.created_at > i64::MAX as u64 {
        return Err(format!(
            "line {line_number}: event timestamp exceeds the recovery range"
        ));
    }
    if !matches!(
        u32::from(raw_event.kind),
        KIND_STREAM_MESSAGE | KIND_STREAM_MESSAGE_V2
    ) {
        return Err(format!(
            "line {line_number}: event kind is not an allowlisted visible event kind"
        ));
    }
    validate_tags(&raw_event.tags, channel_id, line_number)?;

    let event = Event::from_json(
        serde_json::to_string(&raw_event)
            .map_err(|_| format!("line {line_number}: event serialization failed"))?,
    )
    .map_err(|_| format!("line {line_number}: malformed signed event"))?;
    match verify_event(&event) {
        Ok(()) => {}
        Err(VerificationError::InvalidId { .. }) => {
            return Err(format!(
                "line {line_number}: signed event ID verification failed"
            ));
        }
        Err(VerificationError::InvalidSignature | VerificationError::Secp(_)) => {
            return Err(format!(
                "line {line_number}: signed event signature verification failed"
            ));
        }
    }

    Ok(PreparedRecord {
        line: line_number,
        channel_id,
        event,
    })
}

fn validate_tags(tags: &[Vec<String>], channel_id: Uuid, line: usize) -> Result<(), String> {
    if tags.len() > MAX_TAGS {
        return Err(format!("line {line}: event has too many tags"));
    }
    for tag in tags {
        if tag.len() > MAX_TAG_PARTS || tag.iter().any(|part| part.len() > MAX_TAG_PART_BYTES) {
            return Err(format!("line {line}: event tag exceeds recovery limits"));
        }
    }

    let h_tags: Vec<&Vec<String>> = tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|name| name == "h"))
        .collect();
    if h_tags.len() != 1 || h_tags[0].len() != 2 {
        return Err(format!(
            "line {line}: event must have exactly one canonical channel h-tag"
        ));
    }
    let bound = Uuid::parse_str(&h_tags[0][1])
        .map_err(|_| format!("line {line}: event must have exactly one canonical channel h-tag"))?;
    if bound.to_string() != h_tags[0][1] {
        return Err(format!(
            "line {line}: event must have exactly one canonical channel h-tag"
        ));
    }
    if bound != channel_id {
        return Err(format!(
            "line {line}: journal channel binding does not match the signed event"
        ));
    }
    Ok(())
}

fn validate_lower_hex(value: &str, length: usize, name: &str, line: usize) -> Result<(), String> {
    if value.len() != length
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "line {line}: {name} must be canonical lowercase hex"
        ));
    }
    Ok(())
}

fn validate_canonical_host(host: &str) -> Result<(), String> {
    let valid_labels = host.len() <= 255
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        });
    if normalize_host(host) != host || !valid_labels {
        return Err("selected community host must be a canonical DNS host".to_string());
    }
    Ok(())
}

fn event_set_hash(host: &str, records: &[PreparedRecord]) -> String {
    let mut sorted: Vec<&PreparedRecord> = records.iter().collect();
    sorted.sort_by_key(|record| record.event.id.to_bytes());

    let mut hasher = Sha256::new();
    hasher.update(EVENT_SET_HASH_DOMAIN);
    hasher.update((host.len() as u64).to_be_bytes());
    hasher.update(host.as_bytes());
    for record in sorted {
        hasher.update(record.event.id.as_bytes());
        hasher.update(record.event.sig.serialize());
        hasher.update(record.channel_id.as_bytes());
        hasher.update(record.event.created_at.as_secs().to_be_bytes());
        hasher.update(record.event.kind.as_u16().to_be_bytes());
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use buzz_db::channel::{ChannelType, ChannelVisibility};
    use buzz_db::{Db, DbConfig, EventRecoveryDb};
    use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
    use serde_json::{json, Value};
    use uuid::Uuid;

    use super::*;

    const HOST: &str = "org-0123456789abcdef0123456789abcdef01234567.chat.bluplai.com";
    const CHANNEL: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    fn keys() -> Keys {
        Keys::parse("0000000000000000000000000000000000000000000000000000000000000001")
            .expect("fixed test key")
    }

    fn event(kind: u16, content: &str, channel: &str, created_at: u64) -> Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .tags([Tag::parse(["h", channel]).expect("h tag")])
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(&keys())
            .expect("signed event")
    }

    fn fixed_visible_events() -> [Event; 2] {
        [
            Event::from_json(
                r#"{"id":"959029bf276343ed3b6104d78f92f12228d660cc54c2255d2bda7d1adb144549","pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","created_at":1800000000,"kind":9,"tags":[["h","aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]],"content":"first","sig":"631e53a761d24d22f83138e0c42e44a4f0de13eda469e8e7eca58e36743c3d4d5085cc17c59df0e863f6d17c177518fbf5d642b686606e3fa67355e39be5eb69"}"#,
            )
            .expect("fixed kind 9 event"),
            Event::from_json(
                r#"{"id":"5b6f798016423074931c33392e792abff11d7ec433821b2785d8fdbbb6d3c395","pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","created_at":1800000001,"kind":40002,"tags":[["h","aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]],"content":"second","sig":"2004666960123c53da8d27da4f1864fccebe5eeb84db313d7b9dedde93b7633eb0b44f904503275303a6c8e1e037ddf4a8213419d931af9efbaed663e1cbf3a5"}"#,
            )
            .expect("fixed kind 40002 event"),
        ]
    }

    fn record(event: &Event, host: &str, channel: &str) -> Value {
        json!({
            "version": 1,
            "community_host": host,
            "channel_id": channel,
            "event": serde_json::from_str::<Value>(&event.as_json()).expect("event json")
        })
    }

    fn jsonl(records: &[Value]) -> Vec<u8> {
        let mut out = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes();
        out.push(b'\n');
        out
    }

    fn error_for(records: &[Value]) -> String {
        parse_and_verify_journal(&jsonl(records), HOST).expect_err("journal must be rejected")
    }

    #[test]
    fn accepts_signed_visible_events_and_derives_order_independent_reconciliation() {
        let [first, second] = fixed_visible_events();
        let records = [
            record(&first, HOST, CHANNEL),
            record(&second, HOST, CHANNEL),
        ];
        let reversed = [records[1].clone(), records[0].clone()];

        let forward = parse_and_verify_journal(&jsonl(&records), HOST).expect("valid journal");
        let backward =
            parse_and_verify_journal(&jsonl(&reversed), HOST).expect("valid reversed journal");

        assert_eq!(forward.records.len(), 2);
        assert_eq!(forward.watermark_created_at, 1_800_000_001);
        assert_eq!(
            forward.watermark_event_id,
            "5b6f798016423074931c33392e792abff11d7ec433821b2785d8fdbbb6d3c395"
        );
        assert_eq!(forward.event_set_sha256, backward.event_set_sha256);
        assert_eq!(
            forward.event_set_sha256,
            "e0b87dbb7a8ec2e98482e3dac4d3ca43989911b5705fa9c220841b618aa5c2ec"
        );

        assert_eq!(
            forward
                .reconciliation_summary(1, 0, true)
                .expect("dry-run summary"),
            RecoverySummary {
                version: 1,
                community_host: HOST.to_string(),
                dry_run: true,
                expected: 2,
                present: 1,
                inserted: 0,
                already_present: 1,
                missing: 1,
                watermark_created_at: 1_800_000_001,
                watermark_event_id:
                    "5b6f798016423074931c33392e792abff11d7ec433821b2785d8fdbbb6d3c395".to_string(),
                event_set_sha256: forward.event_set_sha256.clone(),
            }
        );
        assert_eq!(
            forward
                .reconciliation_summary(1, 1, false)
                .expect("applied summary")
                .missing,
            0
        );
    }

    #[test]
    fn rejects_unknown_record_and_event_fields() {
        let signed = event(9, "visible", CHANNEL, 1_800_000_000);
        let mut unknown_record = record(&signed, HOST, CHANNEL);
        unknown_record["community_id"] = json!(Uuid::new_v4());
        assert!(error_for(&[unknown_record]).contains("unknown field"));

        let mut unknown_event = record(&signed, HOST, CHANNEL);
        unknown_event["event"]["received_at"] = json!(1_800_000_001u64);
        assert!(error_for(&[unknown_event]).contains("unknown field"));
    }

    #[test]
    fn rejects_tampering_before_any_recovery_write() {
        let signed = event(9, "visible", CHANNEL, 1_800_000_000);
        let mut tampered_id = record(&signed, HOST, CHANNEL);
        tampered_id["event"]["content"] = json!("tampered");
        assert!(error_for(&[tampered_id]).contains("event ID"));

        let mut tampered_signature = record(&signed, HOST, CHANNEL);
        tampered_signature["event"]["sig"] = json!("0".repeat(128));
        assert!(error_for(&[tampered_signature]).contains("signature"));
    }

    #[test]
    fn rejects_wrong_host_and_noncanonical_or_cross_channel_binding() {
        let signed = event(9, "visible", CHANNEL, 1_800_000_000);
        assert!(
            error_for(&[record(&signed, "other.chat.bluplai.com", CHANNEL)])
                .contains("community host")
        );

        let upper_channel = CHANNEL.to_ascii_uppercase();
        assert!(error_for(&[record(&signed, HOST, &upper_channel)]).contains("canonical channel"));

        let wrong_channel = "22222222-2222-4222-8222-222222222222";
        assert!(error_for(&[record(&signed, HOST, wrong_channel)]).contains("channel binding"));

        let missing_h = EventBuilder::new(Kind::Custom(9), "visible")
            .custom_created_at(Timestamp::from(1_800_000_000))
            .sign_with_keys(&keys())
            .expect("signed event");
        assert!(error_for(&[record(&missing_h, HOST, CHANNEL)]).contains("canonical channel"));
    }

    #[test]
    fn rejects_auth_ephemeral_control_and_unapproved_visible_kinds() {
        for kind in [22242, 20001, 9002, 40003] {
            let signed = event(kind, "not recoverable", CHANNEL, 1_800_000_000);
            let error = error_for(&[record(&signed, HOST, CHANNEL)]);
            assert!(
                error.contains("allowlisted visible event kind"),
                "kind {kind}: {error}"
            );
        }
    }

    #[test]
    fn rejects_duplicate_empty_and_bounded_input_failures() {
        let signed = event(9, "visible", CHANNEL, 1_800_000_000);
        let duplicate = record(&signed, HOST, CHANNEL);
        assert!(error_for(&[duplicate.clone(), duplicate]).contains("duplicate event"));
        assert!(parse_and_verify_journal(b"", HOST)
            .expect_err("empty journal")
            .contains("empty"));

        let oversized = vec![b' '; MAX_RECORD_BYTES + 1];
        assert!(parse_and_verify_journal(&oversized, HOST)
            .expect_err("oversized record")
            .contains("record exceeds"));

        let too_many = vec![b'\n'; MAX_RECORDS + 1];
        assert!(parse_and_verify_journal(&too_many, HOST)
            .expect_err("too many records")
            .contains("record count"));

        let oversized_journal = vec![b' '; MAX_JOURNAL_BYTES + 1];
        assert!(parse_and_verify_journal(&oversized_journal, HOST)
            .expect_err("oversized journal")
            .contains("journal exceeds"));
    }

    #[test]
    fn bounded_file_reader_rejects_a_sparse_file_above_the_journal_limit() {
        let path = std::env::temp_dir().join(format!(
            "buzz-recovery-oversize-{}.jsonl",
            Uuid::new_v4().simple()
        ));
        let file = std::fs::File::create(&path).expect("create sparse journal");
        file.set_len((MAX_JOURNAL_BYTES + 1) as u64)
            .expect("set sparse length");
        drop(file);

        let error = read_journal_file(&path).expect_err("oversized file must fail closed");
        std::fs::remove_file(&path).expect("remove sparse journal");
        assert!(error.contains("journal exceeds"), "{error}");
    }

    #[test]
    fn recovery_environment_requires_offline_ack_and_no_read_replica() {
        assert!(validate_recovery_environment(
            None,
            Some("offline-writers-stopped-replica-fence-closed")
        )
        .is_ok());
        assert!(validate_recovery_environment(None, None)
            .expect_err("missing acknowledgement")
            .contains("BUZZ_RECOVERY_MODE_ACK"));
        assert!(validate_recovery_environment(
            Some("postgres://reader.internal/buzz"),
            Some("offline-writers-stopped-replica-fence-closed")
        )
        .expect_err("read pool must be absent")
        .contains("READ_DATABASE_URL"));
    }

    #[tokio::test]
    #[ignore = "requires migrated Postgres"]
    async fn restored_snapshot_replay_is_idempotent_and_community_scoped() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must point to a migrated recovery-test database");
        let db = Db::new(&DbConfig {
            database_url: database_url.clone(),
            min_connections: 0,
            ..DbConfig::default()
        })
        .await
        .expect("connect recovery DB");
        db.migrate().await.expect("migrate recovery DB");
        let sql = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect SQL cleanup pool");

        let suffix = Uuid::new_v4().simple().to_string();
        let host_a = format!("org-{suffix}.a.chat.bluplai.test");
        let host_b = format!("org-{suffix}.b.chat.bluplai.test");
        let community_a = db
            .ensure_configured_community(&host_a)
            .await
            .expect("community A");
        let community_b = db
            .ensure_configured_community(&host_b)
            .await
            .expect("community B");
        let shared_channel = Uuid::new_v4();
        let other_channel = Uuid::new_v4();
        let author = keys().public_key().to_bytes();
        for community in [community_a.id, community_b.id] {
            db.create_channel_with_id(
                community,
                shared_channel,
                "shared-id",
                ChannelType::Stream,
                ChannelVisibility::Open,
                None,
                &author,
                None,
            )
            .await
            .expect("same channel UUID in each community");
        }
        db.create_channel_with_id(
            community_b.id,
            other_channel,
            "community-b-only",
            ChannelType::Stream,
            ChannelVisibility::Open,
            None,
            &author,
            None,
        )
        .await
        .expect("community B only channel");
        let recovery_db = EventRecoveryDb::connect(&DbConfig {
            database_url: database_url.clone(),
            read_database_url: None,
            min_connections: 0,
            ..DbConfig::default()
        })
        .await
        .expect("connect dedicated unarmed recovery DB");

        let old_created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("wall clock")
            .as_secs()
            - 7_200;
        let shared_channel_tag = shared_channel.to_string();
        let mentioned_pubkey = keys().public_key().to_hex();
        let signed = EventBuilder::new(Kind::Custom(9), "recover after old snapshot")
            .tags([
                Tag::parse(["h", shared_channel_tag.as_str()]).expect("h tag"),
                Tag::parse(["p", mentioned_pubkey.as_str()]).expect("p tag"),
            ])
            .custom_created_at(Timestamp::from(old_created_at))
            .sign_with_keys(&keys())
            .expect("signed recovery event with mention projection input");
        let journal_a = jsonl(&[record(&signed, &host_a, &shared_channel.to_string())]);
        let journal_b = jsonl(&[record(&signed, &host_b, &shared_channel.to_string())]);

        let dry_a = recover(&recovery_db, &journal_a, &host_a, true)
            .await
            .expect("dry-run A recovery");
        assert_eq!((dry_a.present, dry_a.inserted, dry_a.missing), (0, 0, 1));
        assert!(db
            .get_event_by_id(community_a.id, signed.id.as_bytes())
            .await
            .expect("read after dry-run")
            .is_none());

        let first_a = recover(&recovery_db, &journal_a, &host_a, false)
            .await
            .expect("first A recovery");
        let first_b = recover(&recovery_db, &journal_b, &host_b, false)
            .await
            .expect("same signed event recovers independently in B");
        assert_eq!((first_a.inserted, first_a.already_present), (1, 0));
        assert_eq!((first_b.inserted, first_b.already_present), (1, 0));
        let mention_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM event_mentions WHERE event_id = $1 AND community_id = ANY($2)",
        )
        .bind(signed.id.as_bytes())
        .bind([community_a.id.as_uuid(), community_b.id.as_uuid()])
        .fetch_one(&sql)
        .await
        .expect("count recovery mention projections");
        assert_eq!(
            mention_rows, 0,
            "event recovery must not populate derived mention projections"
        );
        let summary_json = serde_json::to_value(&first_a).expect("serialize recovery summary");
        assert!(
            summary_json.get("projections_complete").is_none(),
            "event-row reconciliation must not claim projection completeness"
        );

        sqlx::query("DELETE FROM events WHERE community_id = $1 AND id = $2")
            .bind(community_a.id.as_uuid())
            .bind(signed.id.as_bytes())
            .execute(&sql)
            .await
            .expect("simulate restoring A to a snapshot before the event");

        let restored_a = recover(&recovery_db, &journal_a, &host_a, false)
            .await
            .expect("recover missing A event after rollback");
        let untouched_b = recover(&recovery_db, &journal_b, &host_b, false)
            .await
            .expect("B remains independently present");
        let retry_a = recover(&recovery_db, &journal_a, &host_a, false)
            .await
            .expect("A replay is idempotent");
        assert_eq!((restored_a.inserted, restored_a.missing), (1, 0));
        assert_eq!((untouched_b.already_present, untouched_b.missing), (1, 0));
        assert_eq!((retry_a.inserted, retry_a.already_present), (0, 1));
        assert_eq!(restored_a.event_set_sha256, retry_a.event_set_sha256);

        let mut tampered = record(&signed, &host_a, &shared_channel.to_string());
        tampered["event"]["sig"] = json!("0".repeat(128));
        assert!(recover(&recovery_db, &jsonl(&[tampered]), &host_a, true)
            .await
            .expect_err("tampered signature")
            .contains("signature"));

        let cross_event = event(
            9,
            "wrong tenant channel",
            &other_channel.to_string(),
            old_created_at + 1,
        );
        assert!(recover(
            &recovery_db,
            &jsonl(&[record(&cross_event, &host_a, &other_channel.to_string())]),
            &host_a,
            true,
        )
        .await
        .expect_err("channel exists only in B")
        .contains("missing, archived, or cross-community channel"));

        sqlx::query("UPDATE channels SET archived_at = now() WHERE community_id = $1 AND id = $2")
            .bind(community_b.id.as_uuid())
            .bind(other_channel)
            .execute(&sql)
            .await
            .expect("archive B-only channel");
        assert!(recover(
            &recovery_db,
            &jsonl(&[record(&cross_event, &host_b, &other_channel.to_string())]),
            &host_b,
            true,
        )
        .await
        .expect_err("archived channel")
        .contains("missing, archived, or cross-community channel"));

        sqlx::query("UPDATE events SET content = 'corrupt' WHERE community_id = $1 AND id = $2")
            .bind(community_b.id.as_uuid())
            .bind(signed.id.as_bytes())
            .execute(&sql)
            .await
            .expect("corrupt B row without changing its event ID");
        assert!(recover(&recovery_db, &journal_b, &host_b, true)
            .await
            .expect_err("conflicting row")
            .contains("will not overwrite"));

        sqlx::query("UPDATE communities SET archived_at = now() WHERE id = $1")
            .bind(community_a.id.as_uuid())
            .execute(&sql)
            .await
            .expect("archive A");
        assert!(recover(&recovery_db, &journal_a, &host_a, true)
            .await
            .expect_err("archived host")
            .contains("not an active server-owned community"));
        sqlx::query("UPDATE communities SET archived_at = NULL WHERE id = $1")
            .bind(community_a.id.as_uuid())
            .execute(&sql)
            .await
            .expect("unarchive A for cleanup");

        sqlx::query("DELETE FROM events WHERE community_id = ANY($1)")
            .bind([community_a.id.as_uuid(), community_b.id.as_uuid()])
            .execute(&sql)
            .await
            .expect("clean events");
        sqlx::query("DELETE FROM channel_members WHERE community_id = ANY($1)")
            .bind([community_a.id.as_uuid(), community_b.id.as_uuid()])
            .execute(&sql)
            .await
            .expect("clean channel members");
        sqlx::query("DELETE FROM channels WHERE community_id = ANY($1)")
            .bind([community_a.id.as_uuid(), community_b.id.as_uuid()])
            .execute(&sql)
            .await
            .expect("clean channels");
        sqlx::query("DELETE FROM communities WHERE id = ANY($1)")
            .bind([community_a.id.as_uuid(), community_b.id.as_uuid()])
            .execute(&sql)
            .await
            .expect("clean communities");
    }
}
