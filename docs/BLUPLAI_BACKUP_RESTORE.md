# Bluplai Buzz backup and restore

## Objectives

- **Database and signed-event RPO:** 5 minutes, using managed Postgres PITR. The
  U2 recovery reader can safely reconcile a v1 visible-event journal after an
  older restore. The RPO only closes to the journal watermark after the U4
  producer is durably enabled, monitored and proven; the reader alone creates
  no backup data.
- **Media RPO:** 5 minutes, using S3 versioning plus cross-zone/provider
  replication where available.
- **Service RTO:** 4 hours for a region/service restore, including reconciliation
  and tenant-isolation acceptance. A routine single-pod replacement remains a
  normal platform availability event, not a disaster restore.

Before the U4 append-only journal is enabled and monitored, the database RPO is
the PITR provider's proven recovery point. Do not claim zero-loss signed-event
recovery before that journal exists.

## Backup set

Capture and retain as one release-labelled recovery set:

1. Postgres PITR/WAL plus scheduled logical schema/data backup.
2. Private S3 bucket versions, lifecycle configuration and object inventory.
3. Redis persistence/provider snapshot for replay keys and operational state.
   Redis is an authentication dependency, not the system of record.
4. Bluplai's append-only accepted-event journal. Each v1 JSONL record contains
   the canonical host, canonical channel UUID and exact raw signed Nostr event
   object. Community UUID is deliberately absent: recovery resolves the active
   community from the server-owned host map. Preserve the journal append
   position and immutable manifest hash beside the file.
5. Relay private key, operator identity, encryption/KMS references, exact image
   digest, fork commit, `UPSTREAM_BASE`, migration head and environment/domain
   mapping. Store secrets in the platform secret manager, separately encrypted
   from the database backup.
6. Git volume if Git remains enabled. It is not part of Bluplai Chat's initial
   product surface but the relay image still contains the upstream capability.

Never place populated environment files, raw private keys, tokens or database
replicas in Git, object paths readable by room members, or support bundles.

## Restore to an older snapshot

1. Activate the global Bluplai Chat kill switch. Quiesce the gateway and stop
   Caddy/relay writers. Record the last accepted journal watermark.
2. Restore Postgres and S3 to the newest mutually consistent recovery point in
   an isolated network. Restore the exact pinned relay image and configuration;
   do not migrate while restoring.
3. Restore Redis persistence if trustworthy. If replay state cannot be restored,
   keep ingress closed for at least the maximum accepted NIP-98 authentication
   window and rotate/reissue gateway capabilities before reopening. Never start
   with replay checking bypassed.
4. Run the explicit migration job to the recorded release head only after the
   restored schema/version inventory is captured.
5. Start relay without public ingress. Verify liveness, Postgres/Redis readiness,
   S3 canary, exact image digest, community count/map and closed replica fence.
6. Reconcile the restored watermark set:

   - maximum accepted journal sequence and relay event receipt watermark;
   - per-community event IDs/counts by allowlisted visible kind;
   - current relay-member projection checksum;
   - S3 object key/count/size/hash inventory;
   - migration head and replica-fence state.

7. If the journal is ahead, run the narrow signed-event recovery procedure
   below, dry-run first. Reconcile again; any event, membership or object
   mismatch blocks ingress. The event command does not restore S3 objects,
   memberships, channel metadata or downstream projections.
8. Run two-community isolation probes (including the same channel UUID in both),
   canonical/unknown host rejection, authenticated NIP-42/NIP-98 replay tests,
   current-member and revoked-member checks, and file canaries.
9. Reopen a single internal organisation, then cohorts. Record start/end
   watermarks and preserve the older environment until the acceptance window
   completes.

## Narrow signed-event recovery contract

The recovery input is the Bluplai-owned journal, never a browser upload or an
operator-edited JSON body. `buzz-admin recover-bluplai-events` is available in
U2. It enforces the following narrow contract:

- operator-only, offline/private-network execution with a manifest hash and
  immutable audit record;
- one explicitly selected canonical host per invocation, resolved through the
  active server-owned community map; there is no `--community-id` authority;
- strict version-1 JSONL with unknown fields rejected, at most 100,000 records,
  1 MiB per record and 64 MiB per journal;
- recompute every event ID and verify every Schnorr signature before any write;
- exactly one canonical signed `h` tag equal to the record channel, followed by
  an active channel lookup inside the resolved community;
- only kind `9` and `40002` in the initial human-visible allowlist. AUTH,
  ephemeral, channel-control, membership, workflow, AI-trigger, edit and other
  kinds fail closed;
- insert only event IDs absent from the restored community, preserving the
  original signed bytes and event ID; never rewrite timestamps or re-sign as a
  human;
- use the dedicated writer-only `EventRecoveryDb`. It refuses a read-replica
  URL, proves each connection is a writable primary, keeps its replica fence
  closed and unsets the 960-second live-ingest floor only on that recovery pool.
  Normal `Db` writers remain armed;
- suppress duplicate notifications, workflow/AI execution and external side
  effects during replay;
- use the shared idempotent event-row insert helper. An existing row is counted
  only when its reconstructed signed event and channel exactly match; deleted
  or conflicting rows are never overwritten. Recovery deliberately does not
  write mention, thread, search or other derived projection tables;
- output content-free JSON with `expected`, `present`, `inserted`,
  `already_present`, `missing`, the maximum `(created_at,event_id)` watermark,
  and a deterministic SHA-256 committing to host, event IDs, signatures,
  channels, timestamps and kinds;
- recover database event rows only. Rebuild/reconcile mention/thread/search
  projections, member state and S3/object inventories separately before
  cutover.

With writers and public ingress stopped, `READ_DATABASE_URL` unset, and the
replica breaker operationally closed, run:

```bash
export BUZZ_RECOVERY_MODE_ACK=offline-writers-stopped-replica-fence-closed
unset READ_DATABASE_URL

buzz-admin recover-bluplai-events \
  --community-host org-0123456789abcdef0123456789abcdef01234567.chat.bluplai.com \
  --journal /recovery/accepted-events.v1.jsonl \
  --dry-run

buzz-admin recover-bluplai-events \
  --community-host org-0123456789abcdef0123456789abcdef01234567.chat.bluplai.com \
  --journal /recovery/accepted-events.v1.jsonl
```

`--dry-run` performs all parsing, cryptographic verification, active
host/channel resolution and conflict checks but performs no insert. Any
non-zero `missing` value is the proposed apply set. After apply, require
`present == expected` and `missing == 0`, preserve the JSON summary with the
journal manifest, then perform the independent member/object/projection checks.
These counts prove only the signed database event-row set; they never claim
projection completeness.

Until the U4 journal producer is present and its durability is proven, stop
after PITR restore and report the provider recovery point as the achieved RPO.
Do not simulate recovery with `X-Pubkey`, ordinary `/events`, timestamp changes,
direct armed-pool SQL or a broad database dump replay.

## Rehearsal cadence and evidence

Rehearse quarterly and before the first external cohort. Preserve command logs
with secrets redacted, restore point, achieved RPO/RTO, image/fork/migration
revisions, pre/post watermarks, two-community isolation results, revoked-user
result and operator sign-off. A green process health endpoint alone is not
restore evidence.
