import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(packageRoot, "src");
const deniedPatterns = [
  /@tauri-apps\//,
  /__TAURI(?:_|__)/,
  /shared\/api\/tauri/,
  /features\/(?:agents|canvas|projects|workflows|huddles)/,
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(target) : [target];
    }),
  );
  return files.flat().filter((file) => /\.(?:ts|tsx|css)$/.test(file));
}

const violations = [];
for (const file of await sourceFiles(sourceRoot)) {
  const content = await readFile(file, "utf8");
  for (const pattern of deniedPatterns) {
    if (pattern.test(content)) {
      violations.push(`${path.relative(packageRoot, file)} matches ${pattern}`);
    }
  }
}

const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
if (
  packageJson.dependencies?.react ||
  packageJson.dependencies?.["react-dom"]
) {
  violations.push(
    "React must remain a peer dependency, not a bundled dependency",
  );
}

if (violations.length > 0) {
  throw new Error(
    `Browser package boundary violations:\n${violations.join("\n")}`,
  );
}

console.log("Browser package boundaries verified: no Tauri/desktop imports.");
