# Bluplai Buzz fork

This repository is the maintained full-replacement fork behind **Bluplai Chat,
powered by Buzz**. It preserves Buzz's event and relay foundation while keeping
Bluplai's browser integration deliberately narrower than the desktop product.

## Pinned foundation and licensing

- Audited upstream repository: `https://github.com/block/buzz.git`
- Fork origin: `https://github.com/skyremote/bluplai-buzz.git`
- Audited base: the full commit SHA stored in root `UPSTREAM_BASE`
- License: Apache License 2.0, preserved in root `LICENSE`
- Modification notice: root `NOTICE-BLUPLAI.md`

Both `origin` and `upstream` remotes must remain configured in maintained local
checkouts. Production and host-test artifacts are identified by the full fork
commit SHA; a branch name or mutable package tag is not a production pin.

## Browser package contract

`@bluplai/buzz-chat-react` is the only supported browser entry point. It
contains chat projections, a React workspace, a capability guard, and a host
transport contract. It does not import the Buzz desktop app, Tauri APIs,
authentication UI, relay credentials, a second room store, or an iframe.

React and React DOM are peer dependencies (`>=18.3.0 <20`) and are external in
the production bundle. Bluplai owns the React host and will supply a managed
gateway adapter in a later bounded unit. A direct-relay desktop adapter may be
added separately; this fork does not mint or accept a special relay JWT.

The capability boundary exposes rooms, threads, reactions, and read state. It
denies Git, workflow, project, canvas, huddle, and ACP commands before the host
transport can observe them. Those surfaces must not be added to browser
navigation or routed around `executeChatCommand`.

Run the package gate from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @bluplai/buzz-chat-react check
pnpm --filter @bluplai/buzz-chat-react test
pnpm --filter @bluplai/buzz-chat-react build
```

The compatibility workflow packs the built package twice, with the Hermit-pinned
Node/npm toolchain and `npm pack` run from the package directory. It rejects
non-identical archives, uploads one candidate named with the full fork SHA, and
records the upstream SHA, fork SHA, audited merge SHA and both merge parents,
package version and tarball SHA-256. It uses full Git history to prove
`UPSTREAM_BASE` is the audited merge's second parent and an ancestor of the
candidate. Registry publication, if enabled later, must use an immutable
prerelease version containing the fork commit and must be an explicit release
action rather than a branch-push side effect.

The host repository is private while this fork is public. No workflow in this
public repository receives a private-host credential or checks out the host.
Pull-request checks remain read-only and unprivileged. Host compatibility runs
from the private host repository after it has independently pinned the exact
tarball hash; its result is a separate release gate and cannot be inferred from
this public package build.

The immutable facts for the current package are checked in at
`.github/bluplai-package-release.json`. A push of those facts to `main` runs
`bluplai-package-attestation.yml`, reconstructs the exact package source in a
clean detached worktree, proves the audited merge-parent and upstream ancestry,
builds and tests, packs twice, verifies SHA-256, and asks GitHub to attest both
the tarball and checked-in manifest. The attestation job has only `contents:
read`, `id-token: write`, and `attestations: write`; it has no registry,
deployment, host, or repository-write authority.

**Current attestation status (2026-08-10): blocked.** The manifest and workflow
are on the review branch, not `main`, so GitHub has not produced an attestation
for `@bluplai/buzz-chat-react@0.1.0-bluplai.14`. Do not describe the archive as
attested until the reviewed commit lands on `main` and the main-only workflow
succeeds. This status does not authorize pushing, merging, publishing, or
deploying the package.

Release landing must preserve the package-source commit named by the manifest
as an ancestor of `main`; the attestation workflow enforces that relationship
with `git merge-base --is-ancestor`. **Do not squash, rebase, or cherry-pick**
the audited package and release commits when landing them. Use an
ancestry-preserving merge or fast-forward. Rewritten history is a hard release
failure even when its final files happen to be byte-identical.

After the main-only workflow succeeds, copy the exact 40-character
`GITHUB_SHA` from that landed `main` run into `<LANDED_MAIN_SHA>`. Verify both
downloaded subjects against GitHub's live attestation service before any host
upload or installation. The source digest and signer-workflow digest must both
equal that landed commit; `refs/heads/main` alone is mutable and insufficient.

```bash
gh attestation verify bluplai-buzz-chat-react-0.1.0-bluplai.14.tgz \
  --repo skyremote/bluplai-buzz \
  --signer-workflow skyremote/bluplai-buzz/.github/workflows/bluplai-package-attestation.yml \
  --source-ref refs/heads/main \
  --source-digest <LANDED_MAIN_SHA> \
  --signer-digest <LANDED_MAIN_SHA>

gh attestation verify .github/bluplai-package-release.json \
  --repo skyremote/bluplai-buzz \
  --signer-workflow skyremote/bluplai-buzz/.github/workflows/bluplai-package-attestation.yml \
  --source-ref refs/heads/main \
  --source-digest <LANDED_MAIN_SHA> \
  --signer-digest <LANDED_MAIN_SHA>
```

A local checksum, workflow summary, or uploaded Actions artifact is not a
substitute for these live verifications. Host upload is prohibited until both
live verifications succeed against the same exact landed builder/source SHA and
signer workflow. The checked-in helper
`scripts/verify-bluplai-live-attestations.mjs` runs both fail-closed checks when
given `--landed-main-sha`, `--tarball`, and `--manifest`.

## Human-reviewed upstream sync

`.github/workflows/upstream-sync.yml` runs weekly or manually. It:

1. Fetches `upstream/main` and proves the current `UPSTREAM_BASE` is an
   ancestor of both the fork and proposed upstream head.
2. Creates a dedicated merge branch and an upstream-delta report.
3. Updates `UPSTREAM_BASE` within the proposed merge commit.
4. Runs the browser compatibility gate plus upstream `just check` and
   `just test-unit` gates.
5. Packs the exact browser archive twice with pinned `npm pack`, rejects any
   byte difference, and records its explicit merge-parent chain and hash; no
   private-host credential is available in this candidate workflow.
6. Pushes the branch and opens a **draft** pull request.

After reviewed merge, the compatibility workflow emits a new immutable
main-branch candidate. The main-only attestation workflow will attest only a
release whose checked-in manifest, package tree, ancestry, toolchain and archive
hash all match. Private-host contract tests and the production build remain an
independent gate owned by the private host repository.

The workflow contains no deployment, image publication, package publication,
or automatic merge step. A maintainer must review the incoming commits, the
Bluplai delta report, licensing changes, schema or protocol changes, and both
gate results before merging. Deployment remains a separate, commit-pinned
operator action.

If an upstream merge conflicts with the browser package boundary or requires a
broad unrelated desktop rewrite, stop the sync. Do not weaken the Tauri, React,
or hidden-capability checks to make the merge pass; reassess the extraction
contract first.

### Accepted 2026-08-09 upstream boundary

The current `UPSTREAM_BASE` advances from
`a5dbdf5e61e4c512acd99c219c79c154ddb57295` to
`5bf78671f45178f8de02ba18d3d321cbbf19cd1f`, reconciling 151 upstream commits
against 19 fork commits. `docs/UPSTREAM_ADOPTION.md` is the exhaustive
Adopt/Adapt/Exclude ledger and records the three conflict resolutions. The
public package release facts are commit-, tree-, and archive-addressed in
`.github/bluplai-package-release.json`; the private host must independently pin
the same archive identity before release.

### Recorded 2026-08-03 sync rehearsal

On 2026-08-03 the maintained fork at
`c1208cd43b068c21a342dc0709edd3099e247e48` fetched upstream main at
`651f6372754e60e3f936b3397040eb0f1e44c9f3`. The merge base was
`a5dbdf5e61e4c512acd99c219c79c154ddb57295`; the fork was five commits ahead
and upstream was 15 commits ahead. `git merge-tree --write-tree` produced tree
`639b23a469ef474099e426c3dd7d6ce224706686` with no textual conflict, and the
upstream range did not touch the Bluplai browser package/docs or Bluplai
relay/admin/database extensions.

This is rehearsal evidence, not approval. No upstream commit was merged,
published or deployed. A candidate sync must still review all changed paths,
licensing, migrations, protocol/auth/media behavior and pass the complete fork
and Bluplai integration suites before Bluplai repins the package.

For an urgent upstream security fix, prefer a reviewed cherry-pick only when
its dependency chain is understood. Record the source commit, run the same
security/tenant/package gates, then reconcile it in the next full upstream sync
so the fork does not permanently diverge.

## Release and retirement boundary

The fork can be updated independently, but no fork change can enter production
until Bluplai pins the exact package/image SHA and deploys it through the
separate release gate. Legacy-chat retirement is also separate: it requires a
fresh restore rehearsal, privacy/legal-hold clearance, zero legacy runtime
dependencies and a minimum 30-day post-final-cohort window. An upstream sync
never authorises either a deployment or destructive retirement.
