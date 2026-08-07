-- Operator-only historical import audit. The event, derived rows, visible
-- outbox and this ledger row commit in one unarmed writer transaction.

CREATE TABLE bluplai_historical_imports (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    channel_id UUID NOT NULL,
    event_id BYTEA NOT NULL,
    event_created_at TIMESTAMPTZ NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, source_key),
    UNIQUE (community_id, event_id),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE,
    CONSTRAINT bluplai_historical_import_source_hash_check
        CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT bluplai_historical_import_manifest_hash_check
        CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT bluplai_historical_import_event_check
        CHECK (octet_length(event_id) = 32)
);

CREATE INDEX bluplai_historical_import_manifest_idx
    ON bluplai_historical_imports (community_id, manifest_sha256, event_created_at, event_id);

COMMENT ON TABLE bluplai_historical_imports IS
    'Idempotent source-to-signed-event audit for explicitly imported Bluplai chat history.';
