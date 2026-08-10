import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const read = (path) => readFileSync(path, "utf8");
const release = JSON.parse(read(".github/bluplai-package-release.json"));
const compatibility = read(".github/workflows/bluplai-compatibility.yml");
const upstreamSync = read(".github/workflows/upstream-sync.yml");
const attestation = read(".github/workflows/bluplai-package-attestation.yml");
const forkDocumentation = read("docs/BLUPLAI_FORK.md");

const expectedRelease = {
  schema_version: 1,
  release_id:
    "@bluplai/buzz-chat-react@0.1.0-bluplai.15+7baefe6d194bb792666c8cfabec24fc1410ec289",
  source: {
    repository: "https://github.com/skyremote/bluplai-buzz",
    package_path: "packages/bluplai-chat-react",
    package_commit: "7baefe6d194bb792666c8cfabec24fc1410ec289",
    package_tree: "0f838c8a632da21bd62e1ad1bb2dffb891ccc2bc",
    upstream_repository: "https://github.com/block/buzz",
    upstream_commit: "5bf78671f45178f8de02ba18d3d321cbbf19cd1f",
    audited_merge_commit: "1f4dd94b31e7e347b82e64756920eb457468f45f",
    audited_merge_first_parent: "ce702e152460ad5c4de8a3b10112aa2afe9a96de",
    audited_merge_second_parent: "5bf78671f45178f8de02ba18d3d321cbbf19cd1f",
  },
  toolchain: {
    node: "24.15.0",
    npm: "11.12.1",
    pnpm: "11.4.0",
    pack_command: "npm pack --pack-destination <directory>",
  },
  package: {
    name: "@bluplai/buzz-chat-react",
    version: "0.1.0-bluplai.15",
    filename: "bluplai-buzz-chat-react-0.1.0-bluplai.15.tgz",
    sha256: "7674c3ef087cd3d6fe0ab74e6f15810079d47bcdaeee680e7885dd3491d69227",
  },
  attestation: {
    workflow: ".github/workflows/bluplai-package-attestation.yml",
    required_ref: "refs/heads/main",
  },
  release_policy: {
    landing_history: "ancestry_preserving",
    prohibited_landing_modes: ["squash", "rebase", "cherry-pick"],
    host_upload_requires_live_github_attestation: true,
    live_attestation_subjects: [
      "package_tarball",
      ".github/bluplai-package-release.json",
    ],
    required_digest_identity: ["source_digest", "signer_digest"],
  },
};

const approvedActions = Object.freeze({
  compatibility: [
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "cashapp/activate-hermit@cea9af7913204a965fd488637a8d1811bba2e616",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ],
  upstreamSync: [
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "cashapp/activate-hermit@cea9af7913204a965fd488637a8d1811bba2e616",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ],
  attestation: [
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "cashapp/activate-hermit@cea9af7913204a965fd488637a8d1811bba2e616",
    "actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ],
});

function assertApprovedActions(workflow, expected) {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(uses, expected);
}

function assertCanonicalDoublePack(workflow) {
  assert.doesNotMatch(workflow, /pnpm[^\n]*\bpack\b/u);
  assert.match(
    workflow,
    /working-directory:[^\n]*packages\/bluplai-chat-react/u,
  );
  assert.equal(
    [...workflow.matchAll(/^\s*npm pack --pack-destination /gmu)].length,
    2,
    "workflow must run the canonical npm pack twice",
  );
  assert.match(workflow, /cmp "\$first_tarball" "\$second_tarball"/u);
}

function runReleaseVerifier(manifest, tarball) {
  return spawnSync(
    process.execPath,
    [
      "scripts/verify-bluplai-package-release.mjs",
      "--manifest",
      manifest,
      "--repository",
      ".",
      "--tarball",
      tarball,
    ],
    { encoding: "utf8" },
  );
}

function assertExactLiveAttestationContract(documentation) {
  assert.equal(
    [...documentation.matchAll(/gh attestation verify /gu)].length,
    2,
    "tarball and manifest must each be verified live",
  );
  assert.match(
    documentation,
    /gh attestation verify bluplai-buzz-chat-react-0\.1\.0-bluplai\.15\.tgz/u,
  );
  assert.match(
    documentation,
    /gh attestation verify \.github\/bluplai-package-release\.json/u,
  );
  assert.equal(
    [...documentation.matchAll(/--source-digest <LANDED_MAIN_SHA>/gu)].length,
    2,
    "both verifications must pin exact source digest",
  );
  assert.equal(
    [...documentation.matchAll(/--signer-digest <LANDED_MAIN_SHA>/gu)].length,
    2,
    "both verifications must pin exact signer digest",
  );
  assert.equal(
    [...documentation.matchAll(/--source-ref refs\/heads\/main/gu)].length,
    2,
  );
  assert.match(
    documentation,
    /Host upload is prohibited until both\s+live verifications succeed/u,
  );
}

test("checked-in package release facts are exact and immutable", () => {
  assert.deepEqual(release, expectedRelease);
});

test("candidate workflows use deterministic npm packing without private host access", () => {
  for (const [workflow, actions] of [
    [compatibility, approvedActions.compatibility],
    [upstreamSync, approvedActions.upstreamSync],
  ]) {
    assertCanonicalDoublePack(workflow);
    assert.doesNotMatch(workflow, /BLUPLAI_HOST_READ_TOKEN|bluplai-david/u);
    assertApprovedActions(workflow, actions);
  }
  assert.match(compatibility, /test-bluplai-package-release-contract\.mjs/u);
  assert.match(compatibility, /verify-bluplai-package-release\.mjs/u);
  assert.match(compatibility, /\.github\/workflows\/\*\*/u);
});

test("public repository has no private-host workflow", () => {
  assert.equal(
    existsSync(".github/workflows/bluplai-host-compatibility.yml"),
    false,
  );
  for (const filename of readdirSync(".github/workflows")) {
    if (!filename.endsWith(".yml") && !filename.endsWith(".yaml")) continue;
    assert.doesNotMatch(
      read(`.github/workflows/${filename}`),
      /BLUPLAI_HOST_READ_TOKEN|skyremote\/bluplai-david/u,
      `${filename} must not require private-host access`,
    );
  }
});

test("main-only workflow has minimal attestation authority", () => {
  assert.match(attestation, /^\s*push:\s*\n\s*branches:\s*\[main\]/mu);
  assert.doesNotMatch(attestation, /^\s*pull_request:|^\s*workflow_run:/gmu);
  assert.match(
    attestation,
    /permissions:\s*\n\s*contents:\s*read\s*\n\s*id-token:\s*write\s*\n\s*attestations:\s*write/u,
  );
  assert.doesNotMatch(attestation, /contents:\s*write|packages:\s*write/u);
  assert.doesNotMatch(attestation, /BLUPLAI_HOST_READ_TOKEN|bluplai-david/u);
  assertApprovedActions(attestation, approvedActions.attestation);
});

test("pull-request compatibility remains unprivileged", () => {
  assert.match(compatibility, /^permissions:\s*\{\}\s*$/mu);
  assert.match(compatibility, /permissions:\s*\n\s*contents:\s*read/u);
  assert.doesNotMatch(
    compatibility,
    /id-token:\s*write|attestations:\s*write|contents:\s*write|secrets\./u,
  );
});

test("attestation proves source, ancestry, cleanliness, repeatability, and hash", () => {
  for (const fact of [
    "package_commit",
    "package_tree",
    "upstream_commit",
    "audited_merge_commit",
    "audited_merge_first_parent",
    "audited_merge_second_parent",
  ]) {
    assert.match(attestation, new RegExp(`\\.${fact}`, "u"));
  }
  assert.match(attestation, /git merge-base --is-ancestor/u);
  assert.match(attestation, /git worktree add --detach/u);
  assert.match(
    attestation,
    /git(?: -C "\$package_source")? status --porcelain --untracked-files=all/u,
  );
  assertCanonicalDoublePack(attestation);
  assert.match(attestation, /sha256sum/u);
  assert.match(attestation, /actions\/attest-build-provenance@/u);
  assert.match(attestation, /\.github\/bluplai-package-release\.json/u);
});

test("release verifier rejects a candidate whose archive hash is not in the manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "bluplai-release-contract-"));
  const tarball = join(directory, release.package.filename);
  writeFileSync(tarball, "not-the-approved-package", "utf8");
  const result = runReleaseVerifier(
    ".github/bluplai-package-release.json",
    tarball,
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /tarball SHA-256 does not match release manifest/u,
  );
});

test("release verifier rejects a packed filename outside the manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "bluplai-release-contract-"));
  const manifest = join(directory, "release.json");
  const changed = structuredClone(release);
  changed.package.filename = "different-package.tgz";
  writeFileSync(manifest, JSON.stringify(changed), "utf8");
  const tarball = join(directory, release.package.filename);
  writeFileSync(tarball, "not-the-approved-package", "utf8");
  const result = runReleaseVerifier(manifest, tarball);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /packed filename does not match release manifest/u,
  );
});

test("release verifier rejects a package tree outside the manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "bluplai-release-contract-"));
  const manifest = join(directory, "release.json");
  const changed = structuredClone(release);
  changed.source.package_tree = "0".repeat(40);
  writeFileSync(manifest, JSON.stringify(changed), "utf8");
  const tarball = join(directory, release.package.filename);
  writeFileSync(tarball, "not-the-approved-package", "utf8");
  const result = runReleaseVerifier(manifest, tarball);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /package source tree does not match release manifest/u,
  );
});

test("landing and host-upload policy is fail-closed", () => {
  assert.match(
    attestation,
    /merge-base --is-ancestor "\$package_commit" HEAD/u,
  );
  assert.match(forkDocumentation, /Do not squash, rebase, or cherry-pick/u);
  assert.match(forkDocumentation, /gh attestation verify/u);
  assert.match(forkDocumentation, /before any host\s+upload/u);
  assertExactLiveAttestationContract(forkDocumentation);
});

test("live attestation contract rejects mutable or incomplete identity", () => {
  const withoutExactSource = forkDocumentation.replaceAll(
    "--source-digest <LANDED_MAIN_SHA>",
    "",
  );
  assert.throws(
    () => assertExactLiveAttestationContract(withoutExactSource),
    /pin exact source digest/u,
  );
  const withoutExactSigner = forkDocumentation.replaceAll(
    "--signer-digest <LANDED_MAIN_SHA>",
    "",
  );
  assert.throws(
    () => assertExactLiveAttestationContract(withoutExactSigner),
    /pin exact signer digest/u,
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/verify-bluplai-live-attestations.mjs"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing argument: --landed-main-sha/u);
});
