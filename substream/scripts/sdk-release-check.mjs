#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const sdkDir = join(root, "packages", "sdk");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));

if (pkg.name !== "@substream/sdk") fail(`unexpected package name ${pkg.name}`);
if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  fail("package version must be a plain semver string");
}
if (pkg.license !== "MIT") fail("SDK license must be MIT");
if (pkg.private === true) fail("SDK package must not be private");

for (const path of ["dist/index.js", "dist/index.d.ts", "README.md"]) {
  if (!existsSync(join(sdkDir, path))) fail(`missing release artifact ${path}`);
}

const entry = pkg.exports?.["."];
if (entry?.import !== "./dist/index.js" || entry?.types !== "./dist/index.d.ts") {
  fail("package exports must point at dist/index.js and dist/index.d.ts");
}

const expectedTag = process.env.SDK_RELEASE_TAG?.trim();
if (expectedTag && expectedTag !== `sdk-v${pkg.version}`) {
  fail(
    `tag ${expectedTag} does not match package version ${pkg.version} ` +
      `(expected sdk-v${pkg.version})`,
  );
}

const output = execFileSync(
  "npm",
  ["pack", "-w", "@substream/sdk", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const pack = JSON.parse(output)[0];
if (!pack || !Array.isArray(pack.files)) fail("npm pack did not return a file list");

const packed = new Set(pack.files.map((file) => file.path));
for (const path of [
  "package.json",
  "README.md",
  "dist/index.js",
  "dist/index.d.ts",
]) {
  if (!packed.has(path)) fail(`tarball is missing ${path}`);
}
for (const file of packed) {
  if (file.startsWith("src/") || file.startsWith(".env")) {
    fail(`tarball must not include ${file}`);
  }
}

console.log(
  `${pkg.name}@${pkg.version}: release metadata and tarball contents OK (${pack.files.length} files)`,
);
