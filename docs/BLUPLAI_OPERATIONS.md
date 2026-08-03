# Bluplai Buzz operations

This document is the production contract for the isolated Buzz substrate used by
Bluplai Chat. It supplements, and does not change, the upstream Compose defaults.

## Trust boundary

- Bluplai remains the business permission authority. A Buzz community or relay
  membership row is only an enforcement projection; possession of a Nostr key or
  Buzz membership never grants organisation, account, project, guest or view-as
  access.
- Every organisation has one host-derived Buzz community. The browser cannot
  provide a host, relay URL, pubkey, timestamp, event kind or protocol tags.
- `buzz-admin provision-bluplai-community` accepts only an opaque stable
  organisation chat key. It hashes `environment + key` and appends the configured
  canonical base domain. The raw key is neither stored in Buzz nor printed.
- Community media isolation is not room media authorisation. The U4 room-media
  ACL must reauthorise every object read before external collaborators are enabled.

## Reproducible deployment

1. Build the maintained fork at the reviewed commit and publish an OCI image by
   immutable `sha256` digest. Record the fork commit, upstream base from
   `UPSTREAM_BASE`, image digest and license notices.
2. Copy `deploy/bluplai/env.example` to `deploy/bluplai/env.production` and store
   its secret values in the deployment platform. Never commit it.
3. Supply durable external Postgres, Redis and S3-compatible storage. Enable
   Postgres PITR, Redis multi-AZ/AOF (or the provider equivalent), S3 versioning
   and object-lock/retention appropriate to the data policy.
4. Supply a certificate covering the control host and exact wildcard community
   domain. Caddy only serves HTTPS, redirects HTTP, overwrites forwarded host and
   scheme headers, and admits browser WebSocket upgrades from the one configured
   HTTPS origin.
5. Validate the rendered configuration and the in-image production contract:

   ```bash
   cd deploy/bluplai
   docker compose --env-file env.production config
   docker compose --env-file env.production run --rm preflight
   ```

   Preflight rejects tag-only or malformed images, disabled token or membership
   authentication, wildcard/multiple/non-HTTPS CORS origins and auto-migration.

6. Run migrations as an explicit release step, then start the unchanged image:

   ```bash
   docker compose --env-file env.production --profile migrate run --rm migrate
   docker compose --env-file env.production up -d --wait preflight relay caddy
   ```

   Never grant the steady-state relay database role schema-change privileges when
   the platform can use a separate migrator role.

## Provision an organisation community

The opaque chat key is generated and persisted by Bluplai. It must be 32-128
ASCII letters, digits, `_` or `-`; it must not be a Clerk organisation ID, slug,
email or other enumerable business identifier.

```bash
docker compose --env-file env.production exec relay \
  /usr/local/bin/buzz-admin provision-bluplai-community \
  --organization-chat-key "$ORGANIZATION_CHAT_KEY"
```

The command returns one JSON object containing only `community_id`, canonical
`host`, and `status` (`created` or `existing`). Retrying the same key under the
same immutable environment/domain returns the same community. A changed
environment, base domain or key deliberately derives a different host; treat
those three inputs as immutable mapping data and reconcile any change in
Bluplai before traffic is admitted.

Provisioning does not add human members. U3/U4 reconcile managed identities and
room membership only after current Clerk and Bluplai authorisation succeeds.

## Recover visible events after an older snapshot

The recovery reader is deliberately narrower than normal ingest. It accepts a
bounded immutable v1 JSONL journal for one canonical active community host,
verifies each signed event and channel binding, and initially permits only
visible message kinds `9` and `40002`. It never accepts a community UUID,
membership/control event, browser identity header or replacement timestamp.

Keep public ingress and every ordinary writer stopped. The one-off command
requires an explicit acknowledgement and refuses to start while
`READ_DATABASE_URL` is configured:

```bash
export BUZZ_RECOVERY_MODE_ACK=offline-writers-stopped-replica-fence-closed
unset READ_DATABASE_URL

docker compose --env-file env.production run --rm --no-deps \
  -v /secure/bluplai-recovery:/recovery:ro \
  --entrypoint /usr/local/bin/buzz-admin relay \
  recover-bluplai-events \
  --community-host "$COMMUNITY_HOST" \
  --journal /recovery/accepted-events.v1.jsonl \
  --dry-run
```

Review and retain the content-free JSON reconciliation summary, then repeat
without `--dry-run`. The dedicated writer-only recovery pool is the only path
that unsets the 960-second live-ingest floor; the ordinary relay pool remains
armed and no replica is contacted. After apply, require `present == expected`
and `missing == 0` before separately reconciling member state, channel/thread
and search projections, and S3/object inventory. This command recovers signed
database event rows only and deliberately leaves derived mention/thread/search
tables for that independent rebuild. Its JSON summary never claims projection
completeness; it is not PITR, an S3 restore or a membership restore.

The full stop/restore/replay/reopen sequence and v1 journal contract are in
[`BLUPLAI_BACKUP_RESTORE.md`](BLUPLAI_BACKUP_RESTORE.md).

## Health and alert contract

These signals are independent; do not collapse them into a single green light.

| Signal | Source | Ready rule | Failure posture |
|---|---|---|---|
| Relay liveness | relay health port `/_liveness` | process answers | restart pod |
| Relay readiness | relay health port `/_readiness` | Postgres and Redis answer, not shutting down | remove from service; auth replay protection is unavailable |
| Metrics | relay metrics port `/metrics` | scrape succeeds with expected build/pool series | alert; do not infer readiness |
| Community resolution | authenticated canary using the exact canonical host | host maps to expected community; unknown/proxy-mismatched host fails | fail tenant admission |
| Postgres | readiness plus direct platform probe | writer available and migrations at recorded head | relay not ready |
| Read replica | replica-fence metrics | fence open only for proven-fresh reads | degrade to writer; never serve unproved replica data |
| Redis | readiness plus replay/pubsub metrics | Redis reachable | reject authenticated operations; do not bypass replay checks |
| Object storage | dedicated write/read/delete canary | private canary object round-trips | disable file operations; text chat may remain available only when product health reports degraded |
| Gateway | Bluplai `/health/buzz` | configured gateway check ready | organisation remains legacy/unavailable; unrelated tenants stay up |
| Migration | recorded schema head and operator job state | exact release head | block rollout, not unrelated API health |
| AI bridge | separate Bluplai agent health | configured bridge ready | disable room AI without claiming relay failure |

The relay's `/_readiness` currently covers Postgres and Redis, not S3, replica
freshness, gateway, migration or AI. Bluplai's aggregate endpoint reports these
separately and treats a disabled Buzz integration as disabled rather than making
the whole application unhealthy.

## Security invariants

- Production sets `BUZZ_REQUIRE_AUTH_TOKEN=true` and
  `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`; therefore the `X-Pubkey` development
  fallback cannot authenticate HTTP bridge requests. NIP-42 WebSocket and NIP-98
  HTTP authentication remain unchanged.
- Redis replay marking is required for NIP-98/operator authentication. Redis
  errors reject the request; they are never converted to allow.
- CORS is one exact HTTPS Bluplai origin. WebSocket upgrades with a missing,
  `null`, HTTP or different Origin are rejected at ingress.
- Caddy discards inbound `Forwarded`, `X-Forwarded-Host` and
  `X-Forwarded-Proto`, then writes the validated external host and `https` for
  the sole trusted proxy hop.
- Shared physical Postgres, Redis and S3 are acceptable only because every
  observable key/path is community-scoped. Run the upstream same-ID
  cross-community isolation suites at every pinned release.

## Rollout and incident posture

Buzz enablement is globally and per-organisation gated in Bluplai. Relay,
gateway, migration and AI failures are reported separately. When Buzz is
disabled, the application health endpoint must remain healthy and unrelated
organisations must not be taken down. During an auth/Redis incident, reject new
chat operations rather than accepting unauditable or replayable requests.

For backup, restore and signed-event recovery, follow
[`BLUPLAI_BACKUP_RESTORE.md`](BLUPLAI_BACKUP_RESTORE.md).
