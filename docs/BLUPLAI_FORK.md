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

The compatibility workflow also packs the built package and uploads an
artifact named with `${github.sha}`. Registry publication, if enabled later,
must use an immutable prerelease version containing the fork commit and must be
an explicit release action rather than a branch-push side effect.

## Human-reviewed upstream sync

`.github/workflows/upstream-sync.yml` runs weekly or manually. It:

1. Fetches `upstream/main` and validates the current `UPSTREAM_BASE` object.
2. Creates a dedicated merge branch and an upstream-delta report.
3. Updates `UPSTREAM_BASE` within the proposed merge commit.
4. Runs the browser compatibility gate plus upstream `just check` and
   `just test-unit` gates.
5. Pushes the branch and opens a **draft** pull request.

The workflow contains no deployment, image publication, package publication,
or automatic merge step. A maintainer must review the incoming commits, the
Bluplai delta report, licensing changes, schema or protocol changes, and both
gate results before merging. Deployment remains a separate, commit-pinned
operator action.

If an upstream merge conflicts with the browser package boundary or requires a
broad unrelated desktop rewrite, stop the sync. Do not weaken the Tauri, React,
or hidden-capability checks to make the merge pass; reassess the extraction
contract first.

## Production boundary still to prove

This foundation proves browser consumption and fork reproducibility only. It
does not claim the later production tenant, membership-revocation, admission,
backup, restore, or rollback evidence. Those controls belong to the managed
gateway and production runtime units and must be proven against the exact
fork/runtime SHA before any cohort is activated.
