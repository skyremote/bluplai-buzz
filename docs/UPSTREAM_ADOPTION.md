# Upstream adoption ledger — 2026-08-09

This ledger classifies the complete upstream range
`a5dbdf5e61e4c512acd99c219c79c154ddb57295..5bf78671f45178f8de02ba18d3d321cbbf19cd1f`.
The range contains exactly **151 commits**. Classification controls what may
enter the Bluplai browser package and managed host contract; it does not erase
upstream source retained in this full fork.

## Decision meanings

- **Adopt** — take the upstream server, protocol or security behavior directly.
- **Adapt** — take the behavior or invariant, but translate desktop/Tauri or
  single-community orchestration into Bluplai's browser gateway,
  organization-scoped authorization and React 18 host contract.
- **Exclude** — retain only as inherited upstream source. Do not export it from
  `@bluplai/buzz-chat-react`, enable it in the managed relay, or ship it through
  the Bluplai host.

## Adopt — 6 commits

| Commit | Adopted boundary |
|---|---|
| `885bed35e` | Workflow trigger identity comes only from the signed event author; caller-controlled actor tags are never authority. |
| `769ac70b7` | Every media read is authenticated and privately cacheable; Bluplai room binding remains an additional tenant-scoped check. |
| `997b8caaa` | Banned relay members lose repository access. |
| `efe1893dd` | Private-channel invitations remain membership constrained. |
| `65834d68d` | Development services bind to loopback by default. |
| `78c87ae20` | Signed SDK message/forum builders preserve self-mention `p` tags. |

## Adapt — 10 commits

| Commit | Adaptation boundary |
|---|---|
| `b29c8cdaa` | Adopt signed Huddle started/ended/participant kinds, lifecycle ownership, generation fencing and event-ID transcript dedupe. Exclude local STT/TTS voices, raw audio playout and companion-window UI. Browser delivery must use managed gateway events and host consent. |
| `ce56e3441` | Carry stale-session recovery into browser socket generation ownership; do not import Flutter lifecycle code. |
| `e5efd0470` | Carry reconnect generation fencing and bounded replay into the gateway transport; do not import Tauri relay orchestration. |
| `19b41e9c8` | Preserve an authenticated socket during rate-limited backfill; express it in the browser gateway state machine. |
| `bc9e6528a` | Adopt the channel lookup index as migration `0029`, preserving Bluplai's already-released immutable migrations `0027` and `0028`. |
| `2ea938501` | Adopt the 66-character reaction projection as migration `0030` for the same compatibility reason. |
| `067c085f3` | Retain only the inert private managed-agent wire codec/kind reservation. Generic relay ingest remains fail-closed until every NIP-PMA privacy, CAS, backup, revocation and capability gate exists. |
| `4da7264d9` | Reuse bounded observer telemetry semantics behind the managed gateway; never expose an unrestricted ACP session to the browser. |
| `06b60e682` | Merge relay recounts with locally observed replies in the host read-state projection, not via Flutter state. |
| `b42b09361` | Reuse per-group channel ordering semantics through the host snapshot contract, not the mobile persistence layer. |

## Exclude — 135 commits

Every commit in the 151-commit range not listed in **Adopt** or **Adapt** above
is classified **Exclude** for the Bluplai release surface. This exhaustive
default is deliberate: `151 = 6 Adopt + 10 Adapt + 135 Exclude`.

The excluded set includes all local voice-model acquisition and execution,
raw Buzz audio mesh, mesh-LLM release enablement, ACP/provider-selection UI,
Buzz Term, device identity recovery, desktop/mobile release machinery and
Tauri-/Flutter-only presentation. It also includes unrelated desktop/mobile
polish until a separate reviewed package change names the host contract and
adds React 18 tests.

This set explicitly excludes `ad923353a`: kind `30179` must not enter through
generic relay ingest. `docs/nips/NIP-PMA.md` requires the atomic aggregate,
author-only privacy, CAS, recovery, revocation and capability boundaries to
land before ingest acceptance.

An excluded commit may still be present in the fork because the repository
tracks upstream as a whole. Presence is not authorization: the browser package
boundary checks, capability allowlist, clean-host package tests and
commit-addressed provenance gate prevent these surfaces from entering Bluplai.

## Conflict resolutions

The merge had three textual conflicts:

1. **Migrations:** kept Bluplai `0027_bluplai_visible_event_outbox` and
   `0028_bluplai_historical_import` checksum/version identities. Renumbered the
   new upstream channel index and reaction widening to `0029` and `0030`.
2. **Media:** adopted authentication on every GET/HEAD and private cache
   control while retaining host-derived tenant binding, protected-room lookup
   and non-disclosing room authorization failures.
3. **Ingest:** retained Bluplai's agent-lifecycle kind, but rejected upstream's
   private-managed-agent kind from the generic scope tables to preserve the
   fail-closed NIP-PMA deployment order.

## Release boundary

The package candidate is not identified by a branch or mutable tag. Candidate
CI records the upstream SHA, fork SHA, audited merge SHA and both merge parents,
package version and tarball SHA-256, then uploads the tarball with its
attestation. Only the trusted post-merge `workflow_run` gate may use the
private-host read token. It downloads the immutable artifact from the exact
successful main-branch run, verifies its history and hash, installs it into a
clean `skyremote/bluplai-david` checkout, and runs the host contracts and
production build. The gate additionally requires
`internal-docs/releases/buzz-package-provenance.json` in the host checkout to
match the candidate and say `accepted`.

No sync workflow deploys, publishes a registry package or weakens Bluplai's
organization, gateway, package, rollout or compatibility boundaries.
