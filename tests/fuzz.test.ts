// Malformed input must fail cleanly: a typed PixstackError (→ a 4xx), never a
// crash, a hang or an unsafe key. Seeded, so a failure reproduces.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createImageProcessor, isPixstackError } from "../src/index";
import { isImageMeta, parseImageRef, toImageRef, VARIANT_KEY_PATTERN } from "../src/meta";
import { createImageHandler } from "../src/server";
import { memoryStorage } from "../src/storage";
import { makeAnimatedGif, makeJpeg, makePng } from "./helpers";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(bytes: Uint8Array, rand: () => number): Uint8Array {
  const out = Uint8Array.from(bytes);
  switch (Math.floor(rand() * 4)) {
    case 0: // flip bytes, header included
      for (let i = 0; i < 1 + rand() * 12; i++) out[Math.floor(rand() * out.length)] = Math.floor(rand() * 256);
      return out;
    case 1: // truncate
      return out.subarray(0, Math.floor(rand() * out.length));
    case 2: // overwrite a run with zeros or 0xff
      {
        const at = Math.floor(rand() * out.length);
        out.fill(rand() < 0.5 ? 0 : 0xff, at, at + Math.floor(rand() * 64));
      }
      return out;
    default: // splice random junk in
      {
        const at = Math.floor(rand() * out.length);
        const junk = Uint8Array.from({ length: 1 + Math.floor(rand() * 32) }, () => Math.floor(rand() * 256));
        return new Uint8Array([...out.subarray(0, at), ...junk, ...out.subarray(at)]);
      }
  }
}

describe("fuzz: ingest", () => {
  it("mutated JPEG/PNG/WebP/GIF files either ingest or fail with a PixstackError", async () => {
    const webp = await sharp(await makeJpeg(64, 48)).webp().toBuffer();
    const seeds: Uint8Array[] = [await makeJpeg(64, 48), await makePng(48, 48), new Uint8Array(webp), await makeAnimatedGif()];
    const images = createImageProcessor({ storage: memoryStorage(), widths: [32], formats: ["webp"], dedupe: false });
    const rand = rng(20261108);
    const outcomes = { ok: 0, rejected: 0 };
    const unexpected: string[] = [];
    for (let i = 0; i < 160; i++) {
      const input = mutate(seeds[i % seeds.length]!, rand);
      try {
        const meta = await images.ingest(input);
        expect(isImageMeta(meta)).toBe(true);
        outcomes.ok++;
      } catch (err) {
        if (isPixstackError(err)) outcomes.rejected++;
        else unexpected.push(`#${i}: ${String(err)}`);
      }
    }
    expect(unexpected).toEqual([]);
    expect(outcomes.rejected).toBeGreaterThan(10); // the mutations do break files
  }, 120_000);

  it("random bytes and empty input are rejected", async () => {
    const images = createImageProcessor({ storage: memoryStorage(), widths: [32], formats: ["webp"] });
    const rand = rng(7);
    for (let i = 0; i < 30; i++) {
      const junk = Uint8Array.from({ length: Math.floor(rand() * 4096) }, () => Math.floor(rand() * 256));
      const err = await images.ingest(junk).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isPixstackError(err), String(err)).toBe(true);
    }
  });
});

describe("fuzz: refs and served paths", () => {
  const meta = {
    v: 1 as const, id: "abcdefghijklmnop", width: 1600, height: 900, format: "jpeg" as const, bytes: 1, alpha: false,
    animated: false, color: "#123456", thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    variants: [320, 640, 1280].map((w) => ({ key: `img/abcdefghijklmnop/${w}.webp`, format: "webp" as const, width: w, height: Math.round(w * 0.5625), bytes: 1 })),
  };
  const ref = toImageRef(meta);
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567/.?&=%-_+#\\:@ \u0000éAZ09";

  it("parseImageRef never throws, and anything it accepts yields safe variant keys", () => {
    const rand = rng(42);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      let s: string;
      if (i % 2 === 0) {
        const chars = [...ref];
        for (let j = 0; j < 1 + rand() * 6; j++) chars[Math.floor(rand() * chars.length)] = ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
        s = chars.join("");
      } else {
        s = Array.from({ length: Math.floor(rand() * 200) }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join("");
      }
      const parsed = parseImageRef(s);
      if (!parsed) continue;
      accepted++;
      expect(isImageMeta(parsed.meta), s).toBe(true);
      for (const v of parsed.meta.variants) expect(VARIANT_KEY_PATTERN.test(v.key), v.key).toBe(true);
    }
    expect(accepted).toBeGreaterThan(0); // some mutations land in harmless spots
  });

  it("the handler answers random paths without a server error", async () => {
    const storage = memoryStorage();
    await storage.put("img/abcdefghijklmnop/320.webp", new Uint8Array(10), { contentType: "image/webp" });
    const handler = createImageHandler({ storage, secret: "s" });
    const rand = rng(99);
    const bases = ["/img/abcdefghijklmnop/320.webp", "/orig/abcdefghijklmnop.jpg", "/img/", "/"];
    for (let i = 0; i < 1500; i++) {
      const chars = [...bases[i % bases.length]!];
      for (let j = 0; j < 1 + rand() * 4; j++) {
        chars.splice(Math.floor(rand() * (chars.length + 1)), rand() < 0.3 ? 1 : 0, ALPHABET[Math.floor(rand() * ALPHABET.length)]!);
      }
      const p = chars.join("").replace(/^([^/])/, "/$1");
      let url: URL;
      try {
        url = new URL(p, "http://x");
      } catch {
        continue;
      }
      const headers = i % 5 === 0 ? { Range: `bytes=${Math.floor(rand() * 20) - 5}-${Math.floor(rand() * 20) - 5}` } : undefined;
      const res = await handler(new Request(url, headers ? { headers } : {}));
      expect(res.status, url.pathname).toBeLessThan(500);
    }
  });
});
