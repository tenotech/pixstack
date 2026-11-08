#!/usr/bin/env node
// Checks the built package the way a consumer sees it: every export points at
// a file, browser-safe bundles import nothing Node-only, the Client Component
// keeps its directive, the CLI keeps its shebang.
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];
const read = (f) => readFileSync(f, "utf8");

for (const [sub, target] of Object.entries(pkg.exports)) {
  const files = typeof target === "string" ? [target] : Object.values(target);
  for (const f of files) if (!existsSync(f)) problems.push(`exports["${sub}"] → missing ${f}`);
}
for (const f of Object.values(pkg.bin ?? {})) {
  if (!existsSync(f)) problems.push(`bin → missing ${f}`);
  else if (!read(f).startsWith("#!/usr/bin/env node")) problems.push(`${f}: no shebang`);
}

const preload = "dist/react-preload.js";
if (!existsSync(preload) || !/^"use client";/.test(read(preload))) problems.push(`${preload}: must start with "use client"`);
if (existsSync("dist/react.js")) {
  const react = read("dist/react.js");
  if (!react.includes('from "./react-preload.js"')) problems.push("dist/react.js must import ./react-preload.js, not inline it");
  if (react.includes("use client")) problems.push("dist/react.js must not be a Client Component");
}

// Browser/edge bundles and every chunk they import: no Node built-ins, no sharp, no AWS SDK.
const SAFE = ["dist/meta.js", "dist/server.js", "dist/react.js", "dist/react-preload.js", "dist/next.js", "dist/client.js"];
const seen = new Set();
const visit = (file) => {
  if (seen.has(file) || !existsSync(file)) return;
  seen.add(file);
  for (const m of read(file).matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
    const spec = m[1];
    if (spec.startsWith("./")) visit(`dist/${spec.slice(2)}`);
    else if (/^(node:|sharp$|@aws-sdk\/)/.test(spec)) problems.push(`${file} imports ${spec} (reached from a browser-safe entry)`);
  }
};
SAFE.forEach(visit);

if (problems.length) {
  console.error("check:dist failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`check:dist: ${Object.keys(pkg.exports).length} exports, ${seen.size} browser-safe files clean.`);
