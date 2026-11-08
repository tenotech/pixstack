import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idsFromLines, main } from "../src/cli";
import { toImageRef, type ImageMeta } from "../src/meta";
import { makeJpeg, makePng } from "./helpers";

let dir: string;
let root: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pixstack-cli-"));
  root = path.join(dir, "media");
  await mkdir(path.join(dir, "in", "sub"), { recursive: true });
  await writeFile(path.join(dir, "in", "a.jpg"), await makeJpeg(500, 300, { seed: 1 }));
  await writeFile(path.join(dir, "in", "sub", "b.png"), await makePng(400, 400));
  await writeFile(path.join(dir, "in", "notes.txt"), "not an image");
  await writeFile(path.join(dir, "in", "broken.jpg"), "not a jpeg either");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {});
  return { code, out, err: err.join("\n"), json: out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("pixstack CLI", () => {
  let a: string;
  let b: string;

  it("ingests a directory tree (images only), reports per file and fails on broken ones", async () => {
    const res = await run("ingest", path.join(dir, "in"), "--root", root, "--widths", "160,320", "--defer", "avif");
    expect(res.code).toBe(1);
    const byFile = Object.fromEntries(res.json.map((j) => [path.basename(String(j.file)), j]));
    expect(Object.keys(byFile).sort()).toEqual(["a.jpg", "b.png", "broken.jpg"]);
    expect(byFile["broken.jpg"]).toMatchObject({ error: "DECODE_FAILED" });
    a = String(byFile["a.jpg"]!.id);
    b = String(byFile["b.png"]!.id);
    expect(String(byFile["a.jpg"]!.ref)).toContain(`/img/${a}/320.webp?pv=1`);
    expect(res.err).toContain("ingested 2 file(s), 1 failed");
  });

  it("audits: pending formats, then missing variants and stray files", async () => {
    let res = await run("audit", "--root", root);
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/2 image\(s\).*0 issue\(s\).*2 with pending formats/);

    expect((await run("complete", "--root", root)).json.map((j) => j.id).sort()).toEqual([a, b].sort());
    expect((await run("audit", "--root", root)).err).not.toContain("pending");

    await rm(path.join(root, "img", a, "160.avif"));
    await writeFile(path.join(root, "img", b, "999.webp"), "x");
    res = await run("audit", "--root", root);
    expect(res.code).toBe(1);
    expect(res.json).toEqual(
      expect.arrayContaining([
        { id: a, problem: "missing-variants", detail: [`img/${a}/160.avif`] },
        { id: b, problem: "stray-files", detail: [`img/${b}/999.webp`] },
      ]),
    );
    // reprocess repairs the missing variant from the original
    expect((await run("reprocess", a, "--root", root, "--widths", "160,320")).code).toBe(0);
    await rm(path.join(root, "img", b, "999.webp"));
    expect((await run("audit", "--root", root)).code).toBe(0);
  });

  it("prints refs, and sweeps only what the keep list lacks (dry run first)", async () => {
    const ref = await run("ref", a, "--root", root);
    expect(ref.out[0]).toMatch(new RegExp(`^/img/${a}/320\\.webp\\?pv=1`));

    const keep = path.join(dir, "keep.txt");
    await writeFile(keep, `# in use\n${ref.out[0]}\n`);
    const recent = await run("sweep", "--keep", keep, "--root", root);
    expect(recent.err).toContain("would remove 0 image(s)");
    expect(recent.err).toContain("1 recent");

    const old = new Date(Date.now() - 3 * 864e5);
    for (const f of ["meta.json", "160.webp", "320.webp", "160.avif", "320.avif"]) {
      await utimes(path.join(root, "img", b, f), old, old).catch(() => {});
    }
    await utimes(path.join(root, "orig", `${b}.png`), old, old);
    const dry = await run("sweep", "--keep", keep, "--root", root);
    expect(dry.json).toEqual([{ id: b, removed: false }]);
    expect((await run("ref", b, "--root", root)).code).toBe(0);

    const wet = await run("sweep", "--keep", keep, "--root", root, "--yes");
    expect(wet.json).toEqual([{ id: b, removed: true }]);
    expect((await run("ref", b, "--root", root)).code).toBe(1);
    expect((await run("audit", "--root", root)).err).toMatch(/^1 image\(s\)/);
  });

  it("explains usage errors with exit code 2", async () => {
    expect((await run()).code).toBe(2);
    expect((await run("audit")).err).toContain("no storage");
    expect((await run("sweep", "--root", root)).err).toContain("--keep");
    expect((await run("nope", "--root", root)).err).toContain('unknown command "nope"');
    expect((await run("ingest", "x", "--root", root, "--formats", "jpeg")).code).toBe(2);
    expect((await run("--help")).code).toBe(0);
  });
});

describe("idsFromLines", () => {
  it("accepts ids, refs and URLs, ignores comments and junk", () => {
    const meta = {
      v: 1, id: "bbbbbbbbbbbbbbbb", width: 10, height: 10, format: "jpeg", bytes: 1, alpha: false, animated: false,
      color: "#000000", thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
      variants: [{ key: "img/bbbbbbbbbbbbbbbb/10.webp", format: "webp", width: 10, height: 10, bytes: 1 }],
    } satisfies ImageMeta;
    expect(
      idsFromLines(
        ["aaaaaaaaaaaaaaaa", toImageRef(meta), "https://cdn.x/img/cccccccccccccccc/640.avif", "# dddddddddddddddd", "", "/uploads/x.jpg", "aaaaaaaaaaaaaaaa"].join("\n"),
      ),
    ).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"]);
  });
});
