import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entry = await readFile(path.join(packageRoot, "dist/index.js"), "utf8");
await readFile(path.join(packageRoot, "dist/index.d.ts"), "utf8");
await readFile(path.join(packageRoot, "dist/styles.css"), "utf8");

const violations = [];
if (!/from\s+["']react(?:\/jsx-runtime)?["']/.test(entry)) {
  violations.push("dist/index.js does not externalize React through an import");
}
if (/@tauri-apps\//.test(entry) || /__TAURI(?:_|__)/.test(entry)) {
  violations.push("dist/index.js contains a Tauri boundary");
}
if (/__SECRET_INTERNALS_DO_NOT_USE|react\.production\.min/.test(entry)) {
  violations.push("dist/index.js appears to contain a bundled React runtime");
}

if (violations.length > 0) {
  throw new Error(`Invalid browser package:\n${violations.join("\n")}`);
}

console.log("Built package verified: React is external and Tauri is absent.");
