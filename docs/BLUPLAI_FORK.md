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

The compatibility workflow packs the built package and uploads an artifact
named with the full fork SHA. It records the upstream SHA, fork SHA, audited
merge SHA and both merge parents, package version and tarball SHA-256. It uses
full Git history to prove `UPSTREAM_BASE` is the audited merge's second parent
and an ancestor of the candidate. Registry publication, if enabled later, must
use an immutable prerelease version containing the fork commit and must be an
explicit release action rather than a branch-push side effect.

The host repository is private while this fork is public. Candidate and pull
request workflows never receive a private-host credential or checkout. After
a successful push to `main`, the trusted default-branch
`bluplai-host-compatibility.yml` workflow downloads the immutable artifact by
workflow-run ID, verifies its hash and full merge-parent chain, then checks out
the host with a fine-grained read-only `BLUPLAI_HOST_READ_TOKEN`. Checkout uses
`persist-credentials: false`, so candidate package code runs without that
credential. A missing or expired token is a release blocker, not permission to
bypass the host gate.

## Human-reviewed upstream sync

`.github/workflows/upstream-sync.yml` runs weekly or manually. It:

1. Fetches `upstream/main` and proves the current `UPSTREAM_BASE` is an
   ancestor of both the fork and proposed upstream head.
2. Creates a dedicated merge branch and an upstream-delta report.
3. Updates `UPSTREAM_BASE` within the proposed merge commit.
4. Runs the browser compatibility gate plus upstream `just check` and
   `just test-unit` gates.
5. Packs and hashes the exact browser archive with its explicit merge-parent
   chain; no private-host credential is available in this candidate workflow.
6. Pushes the branch and opens a **draft** pull request.

After reviewed merge, the compatibility workflow emits a new immutable
main-branch artifact and the trusted post-merge host workflow runs the private
host contract tests and production build.

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
accepted release chain is commit- and archive-addressed in the Bluplai host's
`internal-docs/releases/buzz-package-provenance.json`; the workflow rejects a
release candidate when that record does not match.

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
