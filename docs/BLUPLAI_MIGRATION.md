# Bluplai historical chat import

`buzz-admin import-bluplai-chat` is the only supported path for inserting old
Bluplai conversation history. It uses a dedicated migration signer and a raw
writer connection whose `buzz.created_at_floor` setting must be unset. The
command rejects a read replica, invalid signatures, identity-bearing tags,
oversized batches, missing thread parents, and source-key conflicts.

Required environment:

- `DATABASE_URL`: the primary writer endpoint, never `READ_DATABASE_URL`.
- `BUZZ_MIGRATION_PRIVATE_KEY`: a dedicated secp256k1 private key; do not reuse
  a human managed key or the relay key.
- `BUZZ_HISTORICAL_IMPORT_ACK=I_UNDERSTAND_THIS_IMPORTS_SIGNED_HISTORY`.

Run migrations first, then import a protected `bluplai-chat-import/v1` JSON
manifest:

```bash
buzz_chat_export.py --organization-id <uuid> \
  --emit-import-manifest --output /protected/path/import.json \
  --acknowledge-sensitive-output
buzz-admin migrate
buzz-admin import-bluplai-chat --manifest /protected/path/import.json
```

The exporter resolves only active provisioned room bindings and managed Nostr
public keys. It refuses source blockers, requires exactly one destination
community and creates the output as mode `0600` without following symlinks. The
importer recomputes `import_sha256` using the same canonical UTF-8 JSON contract
before it signs anything. Signed tags contain opaque source keys, checksums and
display attribution only; Clerk IDs and email addresses are forbidden.

Every batch is one PostgreSQL transaction containing the signed event, thread
or reaction materialisation, mention index, Bluplai visible-event outbox and
`bluplai_historical_imports` audit row. Imported events carry
`["bluplai-source","imported"]`, so Bluplai suppresses notifications,
workflows and agent invocation. Re-running the exact file returns `existed`;
reusing a source key for different bytes fails closed.

Before cutover, compare the command's source-key/event-ID results against the
operator-only Bluplai import-results endpoint, then call reconciliation. The
first call durably advances the cross-database saga from `pending` to
`imported`; it is safe to replay after a crash because source keys and signed
event IDs are stable. Counts and canonical source checksums must match exactly.
Reconciliation advances `imported` to `reconciled` and also maps every legacy read timestamp to the
latest imported message at or before that frontier; an unmappable cursor blocks
cutover. Keep the source database and encrypted manifest intact through the
rollback retention window.

## Redaction and retirement evidence

If a source message is deleted or redacted after import, emit and retain its
signed tombstone, replace the legacy body with the deletion placeholder, mark
the migration item/attachment mapping `redacted`, and preserve only the minimum
source key/checksum/event ID required for integrity. Reconciliation must treat a
redacted mapping as deliberate; it must never re-import the previous encrypted
body or object from an older manifest/backup.

The retirement preflight reports aggregate legacy rows, manifests, journal
rows, unmapped objects, unresolved deep links, legal holds, open privacy work
and runtime dependencies. Any non-zero blocker refuses retirement. The importer,
source schema or recovery controls must not be removed in the same change that
produces the report; destructive cleanup requires a later approved plan after
the 30-day final-cohort stability window and a fresh restore rehearsal.
