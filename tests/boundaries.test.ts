// The browser/edge-safe entry points must never pull in sharp, the processor
// or Node built-ins, directly or through another module (CLAUDE.md rule).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const SAFE = ["meta.ts", "server.ts", "react.tsx", "react-preload.tsx", "next.ts", "client.ts"];
const ALLOWED_PACKAGES = new Set(["thumbhash", "react", "react-dom", "react/jsx-runtime"]);

/** Runtime imports of a file (type-only imports are erased and don't count). */
function runtimeImports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const found: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) if (!m[2]) found.push(m[3]!);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]!);
  return found;
}

function closure(entry: string): { files: string[]; external: string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of runtimeImports(file)) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      const base = path.resolve(path.dirname(file), spec.replace(/\.js$/, ""));
      const target = [".ts", ".tsx"].map((e) => base + e).find((f) => {
        try {
          readFileSync(f);
          return true;
        } catch {
          return false;
        }
      });
      if (!target) throw new Error(`${file}: cannot resolve ${spec}`);
      visit(target);
    }
  };
  visit(path.join(SRC, entry));
  return { files: [...files].map((f) => path.relative(SRC, f).replace(/\\/g, "/")), external: [...external] };
}

describe("import boundaries", () => {
  it.each(SAFE)("%s reaches no processor, sharp or node:* module", (entry) => {
    const { files, external } = closure(entry);
    expect(files).not.toContain("processor.ts");
    expect(files.filter((f) => f.startsWith("storage/") && f !== "storage/types.ts")).toEqual([]);
    expect(external.filter((e) => !ALLOWED_PACKAGES.has(e))).toEqual([]);
  });

  it("the checker sees runtime imports and skips type-only ones", () => {
    expect(runtimeImports(path.join(SRC, "server.ts"))).toEqual(["./meta.js"]);
    expect(closure("cli.ts").files).toContain("processor.ts");
  });
});
