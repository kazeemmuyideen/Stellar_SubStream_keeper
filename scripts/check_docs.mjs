import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const markdownFiles = [];
const skipDirectories = new Set([".git", "node_modules", "target", "dist"]);

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".md")) markdownFiles.push(path);
  }
}

function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`#+`?/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

function anchors(source) {
  const result = new Set();
  for (const line of source.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) result.add(slug(heading[1].replace(/`/g, "")));
  }
  return result;
}

walk(root);

let failures = 0;
for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split(/\s+/)[0];
    if (!raw || /^(https?:|mailto:|data:)/i.test(raw)) continue;
    const [target, fragment] = raw.split("#");
    let absolute;
    try {
      absolute = target
        ? resolve(
            target.startsWith("/") ? root : dirname(file),
            decodeURIComponent(target),
          )
        : file;
    } catch {
      failures += 1;
      console.error(`${file}: malformed link ${raw}`);
      continue;
    }
    const metadata = statSync(absolute, { throwIfNoEntry: false });
    if (!metadata) {
      failures += 1;
      console.error(`${file}: missing ${raw}`);
      continue;
    }
    if (fragment && metadata.isFile()) {
      const available = anchors(readFileSync(absolute, "utf8"));
      if (!available.has(decodeURIComponent(fragment).toLowerCase())) {
        failures += 1;
        console.error(`${file}: missing anchor ${raw}`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} broken local Markdown link(s).`);
  process.exitCode = 1;
} else {
  console.log("All local Markdown links and anchors resolve.");
}
