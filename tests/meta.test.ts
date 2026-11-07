import { describe, expect, it } from "vitest";
import { isImageMeta, pickVariant, srcSet, widthLadder, type ImageMeta } from "../src/meta";
import { base32, createLimiter } from "../src/util";

describe("widthLadder", () => {
  it("drops steps above the source and adds the source width", () => {
    expect(widthLadder(1200)).toEqual([160, 240, 320, 400, 480, 640, 800, 960, 1200]);
    expect(widthLadder(960)).toEqual([160, 240, 320, 400, 480, 640, 800, 960]);
  });
  it("skips a near-duplicate source width (within 10% of the last step)", () => {
    expect(widthLadder(1000)).toEqual([160, 240, 320, 400, 480, 640, 800, 960]);
    expect(widthLadder(1945)).toEqual([160, 240, 320, 400, 480, 640, 800, 960, 1280, 1600, 1920]);
  });
  it("caps at the largest step for huge sources", () => {
    expect(widthLadder(6000)).toEqual([160, 240, 320, 400, 480, 640, 800, 960, 1280, 1600, 1920, 2560]);
  });
  it("returns the source width for tiny images", () => {
    expect(widthLadder(120)).toEqual([120]);
  });
  it("dedupes and sorts custom widths", () => {
    expect(widthLadder(500, [400, 100, 400])).toEqual([100, 400]);
  });
});

const meta: ImageMeta = {
  v: 1,
  id: "abcdefghijklmnop",
  width: 1000,
  height: 500,
  format: "jpeg",
  bytes: 1,
  alpha: false,
  animated: false,
  color: "#000000",
  thumbhash: "",
  variants: [320, 640, 1000].flatMap((w) =>
    (["avif", "webp"] as const).map((format) => ({
      key: `img/abcdefghijklmnop/${w}.${format}`,
      format,
      width: w,
      height: w / 2,
      bytes: w,
    })),
  ),
};

describe("srcSet / pickVariant", () => {
  it("builds a srcset per format", () => {
    expect(srcSet(meta, "webp")).toBe(
      "/img/abcdefghijklmnop/320.webp 320w, /img/abcdefghijklmnop/640.webp 640w, /img/abcdefghijklmnop/1000.webp 1000w",
    );
    expect(srcSet(meta, "avif", (k) => `https://cdn.test/${k}`)).toContain("https://cdn.test/img/");
  });
  it("picks the smallest variant that is wide enough, else the largest", () => {
    expect(pickVariant(meta, 500)?.width).toBe(640);
    expect(pickVariant(meta, 5000)?.width).toBe(1000);
    expect(pickVariant(meta, 1, "avif")?.key).toMatch(/320\.avif$/);
  });
  it("recognises ImageMeta from JSON", () => {
    expect(isImageMeta(JSON.parse(JSON.stringify(meta)))).toBe(true);
    expect(isImageMeta({ v: 1, id: "../../x" })).toBe(false);
  });
});

describe("util", () => {
  it("base32 matches RFC 4648 vectors (lower-case, unpadded)", () => {
    const b = (s: string) => base32(new TextEncoder().encode(s));
    expect(b("")).toBe("");
    expect(b("f")).toBe("my");
    expect(b("foobar")).toBe("mzxw6ytboi");
  });
  it("limiter never exceeds max concurrency", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
