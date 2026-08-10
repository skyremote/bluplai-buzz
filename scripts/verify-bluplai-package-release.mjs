#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      fail("expected unique --manifest, --repository, and --tarball arguments");
    }
    values.set(name, value);
  }
  const allowed = new Set(["--manifest", "--repository", "--tarball"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) fail(`unknown argument: ${name}`);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`missing argument: ${name}`);
  }
  return {
    manifest: resolve(values.get("--manifest")),
    repository: resolve(values.get("--repository")),
    tarball: resolve(values.get("--tarball")),
  };
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verify() {
  const paths = parseArguments(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  const packagePath = requireString(
    manifest?.source?.package_path,
    "source.package_path",
  );
  if (isAbsolute(packagePath) || packagePath.split("/").includes("..")) {
    fail("source.package_path must stay inside the repository");
  }

  const packageCommit = requireString(
    manifest?.source?.package_commit,
    "source.package_commit",
  );
  const packageTree = requireString(
    manifest?.source?.package_tree,
    "source.package_tree",
  );
  const expectedFilename = requireString(
    manifest?.package?.filename,
    "package.filename",
  );
  const expectedSha256 = requireString(
    manifest?.package?.sha256,
    "package.sha256",
  );
  if (!/^[0-9a-f]{40}$/u.test(packageCommit)) {
    fail("source.package_commit must be a full lowercase Git SHA");
  }
  if (!/^[0-9a-f]{40}$/u.test(packageTree)) {
    fail("source.package_tree must be a full lowercase Git tree SHA");
  }
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    fail("package.sha256 must be a lowercase SHA-256 digest");
  }

  const head = git(paths.repository, "rev-parse", "HEAD");
  execFileSync(
    "git",
    [
      "-C",
      paths.repository,
      "merge-base",
      "--is-ancestor",
      packageCommit,
      head,
    ],
    { stdio: "ignore" },
  );
  const sourceTree = git(
    paths.repository,
    "rev-parse",
    `${packageCommit}:${packagePath}`,
  );
  if (sourceTree !== packageTree) {
    fail("package source tree does not match release manifest");
  }
  const candidateTree = git(
    paths.repository,
    "rev-parse",
    `HEAD:${packagePath}`,
  );
  if (candidateTree !== packageTree) {
    fail("candidate HEAD package tree does not match release manifest");
  }

  const packageJson = JSON.parse(
    readFileSync(join(paths.repository, packagePath, "package.json"), "utf8"),
  );
  if (packageJson.name !== manifest.package.name) {
    fail("candidate package name does not match release manifest");
  }
  if (packageJson.version !== manifest.package.version) {
    fail("candidate package version does not match release manifest");
  }
  if (basename(paths.tarball) !== expectedFilename) {
    fail("packed filename does not match release manifest");
  }

  const actualSha256 = createHash("sha256")
    .update(readFileSync(paths.tarball))
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    fail("tarball SHA-256 does not match release manifest");
  }

  process.stdout.write(
    `${JSON.stringify({ head, package_tree: candidateTree, filename: expectedFilename, sha256: actualSha256 })}\n`,
  );
}

try {
  verify();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Bluplai package release verification failed: ${message}\n`,
  );
  process.exitCode = 1;
}
