#!/usr/bin/env node
// Fails if any term from .private/denylist.txt appears in a file git would
// publish (tracked + untracked-but-not-ignored). The denylist itself lives in
// the gitignored .private/ folder, so private names never reach the repo.
//
//   pnpm check:private
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const LIST = ".private/denylist.txt";
if (!existsSync(LIST)) {
  console.log(`check:private: no ${LIST}, skipping.`);
  process.exit(0);
}

const terms = readFileSync(LIST, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((t) => t.toLowerCase());

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const hits = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString("utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const t of terms) if (lower.includes(t)) hits.push(`${file}:${i + 1}: "${t}"`);
  });
}

// Commit identity is published too.
for (const key of ["user.name", "user.email"]) {
  try {
    const v = execFileSync("git", ["config", key], { encoding: "utf8" }).trim().toLowerCase();
    for (const t of terms) if (v.includes(t)) hits.push(`git config ${key}: "${t}"`);
  } catch {
    /* not set */
  }
}

if (hits.length) {
  console.error(`check:private: ${hits.length} private term(s) would be published:\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`check:private: ${files.length} files clean.`);
