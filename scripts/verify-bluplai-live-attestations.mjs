#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";

const REPOSITORY = "skyremote/bluplai-buzz";
const SIGNER_WORKFLOW =
  "skyremote/bluplai-buzz/.github/workflows/bluplai-package-attestation.yml";
const SOURCE_REF = "refs/heads/main";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      fail(
        "expected unique --landed-main-sha, --tarball, and --manifest arguments",
      );
    }
    values.set(name, value);
  }
  const allowed = new Set(["--landed-main-sha", "--tarball", "--manifest"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) fail(`unknown argument: ${name}`);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`missing argument: ${name}`);
  }
  return {
    landedMainSha: values.get("--landed-main-sha"),
    tarball: resolve(values.get("--tarball")),
    manifest: resolve(values.get("--manifest")),
  };
}

function verifySubject(subject, landedMainSha) {
  execFileSync(
    "gh",
    [
      "attestation",
      "verify",
      subject,
      "--repo",
      REPOSITORY,
      "--signer-workflow",
      SIGNER_WORKFLOW,
      "--source-ref",
      SOURCE_REF,
      "--source-digest",
      landedMainSha,
      "--signer-digest",
      landedMainSha,
    ],
    { stdio: "inherit" },
  );
}

function verify() {
  const options = parseArguments(process.argv.slice(2));
  if (!/^[0-9a-f]{40}$/u.test(options.landedMainSha)) {
    fail("--landed-main-sha must be the full lowercase landed main commit SHA");
  }

  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  if (
    manifest?.release_policy?.host_upload_requires_live_github_attestation !==
    true
  ) {
    fail("release manifest does not require live host-upload attestation");
  }
  if (basename(options.tarball) !== manifest?.package?.filename) {
    fail("tarball filename does not match co-attested release manifest");
  }

  verifySubject(options.tarball, options.landedMainSha);
  verifySubject(options.manifest, options.landedMainSha);
  process.stdout.write(
    `Verified package tarball and release manifest at landed main ${options.landedMainSha}.\n`,
  );
}

try {
  verify();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Bluplai live attestation verification failed: ${message}\n`,
  );
  process.exitCode = 1;
}
