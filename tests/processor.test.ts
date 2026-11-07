import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { computeImageId, createImageProcessor, isPixstackError, type PixstackErrorCode } from "../src/index";
import { memoryStorage } from "../src/storage";
import { makeAnimatedGif, makeJpeg, makePng, SVG } from "./helpers";

async function expectCode(p: Promise<unknown>, code: PixstackErrorCode) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isPixstackError(err), `expected PixstackError ${code}, got ${String(err)}`).toBe(true);
  expect((err as { code: string }).code).toBe(code);
}

describe("ingest", () => {
  it("produces an AVIF + WebP width ladder, placeholder, colour and original", async () => {
    const storage = memoryStorage();
    const images = createImageProcessor({ storage });
    const input = await makeJpeg(2000, 1000);
    const meta = await images.ingest(input);

    expect(meta).toMatchObject({ v: 1, width: 2000, height: 1000, format: "jpeg", alpha: false, animated: false });
    expect(meta.id).toMatch(/^[a-z2-7]{16}$/);
    expect(meta.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(Buffer.from(meta.thumbhash, "base64").length).toBeLessThan(40);

    const widths = [...new Set(meta.variants.map((v) => v.width))];
    expect(widths).toEqual([160, 240, 320, 400, 480, 640, 800, 960, 1280, 1600, 1920]); // 2000 is within 10% of 1920
    expect(meta.variants.map((v) => v.format).slice(0, 2)).toEqual(["avif", "webp"]);
    for (const v of meta.variants) {
      expect(v.height).toBe(v.width / 2);
      const stored = storage.entries.get(v.key);
      expect(stored?.data.byteLength).toBe(v.bytes);
      expect((await sharp(stored!.data).metadata()).format).toBe(v.format === "avif" ? "heif" : "webp");
    }
    expect(meta.original).toBe(`orig/${meta.id}.jpg`);
    expect(storage.entries.get(meta.original!)?.data).toEqual(input);
    expect(storage.entries.has(`img/${meta.id}/meta.json`)).toBe(true);

    // Compression sanity: the 1280 WebP is far smaller than the 2000px q90 JPEG.
    const w1280 = meta.variants.find((v) => v.width === 1280 && v.format === "webp")!;
    expect(w1280.bytes).toBeLessThan(input.byteLength / 2);
  });

  it("applies EXIF orientation and strips metadata", async () => {
    const storage = memoryStorage();
    const meta = await createImageProcessor({ storage, formats: ["webp"] }).ingest(
      await makeJpeg(400, 200, { orientation: 6 }),
    );
    expect([meta.width, meta.height]).toEqual([200, 400]);
    const out = await sharp(storage.entries.get(meta.variants.at(-1)!.key)!.data).metadata();
    expect([out.width, out.height]).toEqual([200, 400]);
    expect(out.exif).toBeUndefined();
    expect(out.orientation).toBeUndefined();
  });

  it("computeImageId matches the id ingest() assigns", async () => {
    const input = await makeJpeg(120, 80);
    const meta = await createImageProcessor({ storage: memoryStorage(), formats: ["webp"] }).ingest(input);
    expect(computeImageId(input)).toBe(meta.id);
  });

  it("dedupes identical uploads by content hash", async () => {
    const storage = memoryStorage();
    const images = createImageProcessor({ storage, formats: ["webp"] });
    const input = await makeJpeg(500, 300);
    const a = await images.ingest(input);
    const before = storage.entries.size;
    const b = await images.ingest(input.slice());
    expect(b).toEqual(a);
    expect(storage.entries.size).toBe(before);
    const c = await images.ingest(await makeJpeg(500, 300, { seed: 2 }));
    expect(c.id).not.toBe(a.id);
  });

  it("detects transparency and keeps it", async () => {
    const storage = memoryStorage();
    const meta = await createImageProcessor({ storage }).ingest(await makePng(300, 300));
    expect(meta.alpha).toBe(true);
    expect(meta.variants.map((v) => v.width)).toEqual([160, 160, 240, 240, 300, 300]);
    const out = await sharp(storage.entries.get(meta.variants.find((v) => v.format === "webp")!.key)!.data).metadata();
    expect(out.hasAlpha).toBe(true);
  });

  it("handles animated GIFs per the `animated` option", async () => {
    const gif = await makeAnimatedGif();
    const storage = memoryStorage();

    const first = await createImageProcessor({ storage, dedupe: false }).ingest(gif);
    expect(first.animated).toBe(false);
    expect(first.variants.map((v) => v.format)).toEqual(["avif", "webp"]);
    expect([first.width, first.height]).toEqual([64, 48]);

    const kept = await createImageProcessor({ storage, dedupe: false, animated: "keep" }).ingest(gif);
    expect(kept.animated).toBe(true);
    expect(kept.variants.map((v) => v.format)).toEqual(["webp"]);
    expect(kept.variants[0]!.height).toBe(48);
    const out = await sharp(storage.entries.get(kept.variants[0]!.key)!.data, { animated: true }).metadata();
    expect(out.pages).toBe(3);

    await expectCode(createImageProcessor({ storage, animated: "reject" }).ingest(gif), "ANIMATED_NOT_ALLOWED");
  });

  it("rejects bad input with typed errors", async () => {
    const images = createImageProcessor({ storage: memoryStorage(), maxBytes: 200_000, maxPixels: 1_000_000 });
    await expectCode(images.ingest(new Uint8Array()), "EMPTY");
    await expectCode(images.ingest(new Uint8Array(300_000)), "TOO_LARGE");
    await expectCode(images.ingest(new TextEncoder().encode("<html>not an image</html>")), "DECODE_FAILED");
    await expectCode(images.ingest(SVG), "SVG_NOT_ALLOWED");
    await expectCode(
      createImageProcessor({ storage: memoryStorage(), maxPixels: 1_000_000 }).ingest(await makeJpeg(1200, 1000)),
      "TOO_MANY_PIXELS",
    );
    await expectCode(
      createImageProcessor({ storage: memoryStorage(), maxDimension: 500 }).ingest(await makeJpeg(600, 100)),
      "TOO_WIDE",
    );
  });

  it("rasterises SVG only when allowed, and never stores script in variants", async () => {
    const storage = memoryStorage();
    const meta = await createImageProcessor({ storage, allowSvg: true, formats: ["webp"] }).ingest(SVG);
    expect(meta.format).toBe("svg");
    expect([meta.width, meta.height]).toEqual([100, 50]);
    expect((await sharp(storage.entries.get(meta.variants[0]!.key)!.data).metadata()).format).toBe("webp");
  });

  it("accepts Blob and ArrayBuffer input", async () => {
    const images = createImageProcessor({ storage: memoryStorage(), formats: ["webp"], dedupe: false });
    const bytes = await makeJpeg(100, 100);
    await expect(images.ingest(new Blob([bytes]))).resolves.toMatchObject({ width: 100 });
    await expect(images.ingest(bytes.slice().buffer)).resolves.toMatchObject({ width: 100 });
  });
});

describe("defer / complete", () => {
  it("ingests WebP only, then complete() adds AVIF from the original", async () => {
    const storage = memoryStorage();
    const images = createImageProcessor({ storage, defer: ["avif"] });
    const meta = await images.ingest(await makeJpeg(1000, 500));

    expect(meta.pending).toEqual(["avif"]);
    expect(new Set(meta.variants.map((v) => v.format))).toEqual(new Set(["webp"]));
    expect(await images.getMeta(meta.id)).toEqual(meta);

    const done = await images.complete(meta);
    expect(done.pending).toBeUndefined();
    expect(done.variants.map((v) => `${v.width}.${v.format}`)).toEqual(
      [160, 240, 320, 400, 480, 640, 800, 960].flatMap((w) => [`${w}.avif`, `${w}.webp`]),
    );
    for (const v of done.variants) expect(storage.entries.get(v.key)?.data.byteLength).toBe(v.bytes);
    expect(await images.getMeta(meta.id)).toEqual(done);

    // Idempotent, and a stale copy (e.g. from the DB) resolves to the stored result.
    expect(await images.complete(done)).toBe(done);
    expect(await images.complete(meta)).toEqual(done);
  });

  it("works across processor instances (e.g. after a restart)", async () => {
    const storage = memoryStorage();
    const meta = await createImageProcessor({ storage, defer: ["avif"] }).ingest(await makeJpeg(400, 300));
    const done = await createImageProcessor({ storage }).complete(meta);
    expect(done.variants.some((v) => v.format === "avif")).toBe(true);
  });

  it("does not defer for kept animations (WebP only anyway)", async () => {
    const meta = await createImageProcessor({ storage: memoryStorage(), animated: "keep", defer: ["avif"] }).ingest(
      await makeAnimatedGif(),
    );
    expect(meta.pending).toBeUndefined();
  });

  it("rejects configurations that cannot work", async () => {
    const input = await makeJpeg(100, 100);
    await expect(
      createImageProcessor({ storage: memoryStorage(), defer: ["avif", "webp"] }).ingest(input),
    ).rejects.toThrow(/at least one format/);
    await expect(
      createImageProcessor({ storage: memoryStorage(), defer: ["avif"], keepOriginal: false }).ingest(input),
    ).rejects.toThrow(/keepOriginal/);
  });
});

describe("remove / reprocess / getMeta", () => {
  it("remove deletes variants, meta and original", async () => {
    const storage = memoryStorage();
    const images = createImageProcessor({ storage });
    const meta = await images.ingest(await makeJpeg(700, 400));
    expect(await images.getMeta(meta.id)).toEqual(meta);
    await images.remove(meta.id);
    expect(storage.entries.size).toBe(0);
    expect(await images.getMeta(meta.id)).toBeNull();
    await expectCode(images.remove("../../etc"), "INVALID_KEY");
  });

  it("reprocess re-encodes from the original and prunes dropped variants", async () => {
    const storage = memoryStorage();
    const images = createImageProcessor({ storage });
    const meta = await images.ingest(await makeJpeg(1000, 500));
    const next = await images.reprocess(meta, { formats: ["webp"], widths: [400, 800] });
    expect(next.id).toBe(meta.id);
    expect(next.variants.map((v) => `${v.width}.${v.format}`)).toEqual(["400.webp", "800.webp"]); // a custom ladder caps at its largest step
    const variantKeys = [...storage.entries.keys()].filter((k) => /\.(webp|avif)$/.test(k) && k.startsWith("img/"));
    expect(variantKeys.sort()).toEqual(next.variants.map((v) => v.key).sort());
    expect(await images.getMeta(meta.id)).toEqual(next);
  });

  it("reprocess fails clearly without an original", async () => {
    const images = createImageProcessor({ storage: memoryStorage(), keepOriginal: false, formats: ["webp"] });
    const meta = await images.ingest(await makeJpeg(100, 100));
    expect(meta.original).toBeUndefined();
    await expectCode(images.reprocess(meta), "NO_ORIGINAL");
  });
});
