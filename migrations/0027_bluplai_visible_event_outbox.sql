-- Additive Bluplai integration seam. Normal Nostr event and Blossom semantics
-- are unchanged unless a row is explicitly bound to a Bluplai room.

CREATE TABLE bluplai_managed_rooms (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL,
    disclosure_scope TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, channel_id),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE,
    CONSTRAINT bluplai_managed_rooms_scope_check
        CHECK (disclosure_scope IN ('internal', 'shared', 'private', 'dm'))
);

CREATE TABLE bluplai_visible_event_outbox (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL,
    event_id BYTEA NOT NULL,
    event_created_at TIMESTAMPTZ NOT NULL,
    event_kind INT NOT NULL,
    author_pubkey BYTEA NOT NULL,
    notification_class TEXT NOT NULL,
    source_class TEXT NOT NULL,
    payload JSONB NOT NULL,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, event_id),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE,
    CONSTRAINT bluplai_visible_event_outbox_notification_check
        CHECK (notification_class IN ('message', 'reply', 'reaction', 'none')),
    CONSTRAINT bluplai_visible_event_outbox_source_check
        CHECK (source_class IN ('live_human', 'live_agent', 'imported', 'replayed', 'system'))
);

CREATE INDEX bluplai_visible_event_outbox_claim_idx
    ON bluplai_visible_event_outbox (community_id, available_at, created_at)
    WHERE consumed_at IS NULL;

CREATE TABLE bluplai_room_media_acl (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    sha256 BYTEA NOT NULL,
    channel_id UUID NOT NULL,
    uploader_pubkey BYTEA NOT NULL,
    byte_size BIGINT NOT NULL,
    content_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (community_id, sha256),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE,
    CONSTRAINT bluplai_room_media_acl_hash_check CHECK (octet_length(sha256) = 32),
    CONSTRAINT bluplai_room_media_acl_size_check CHECK (byte_size >= 0)
);

CREATE INDEX bluplai_room_media_acl_channel_idx
    ON bluplai_room_media_acl (community_id, channel_id)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE bluplai_visible_event_outbox IS
    'Community-scoped committed visible events consumed idempotently by Bluplai.';
COMMENT ON TABLE bluplai_room_media_acl IS
    'Optional room ACL for private Bluplai media; absent rows retain normal Blossom semantics.';
