import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareUpload, targetSize } from "../src/client";

describe("targetSize", () => {
  it("fits the longest side, keeps the ratio, never upscales", () => {
    expect(targetSize(4000, 3000)).toEqual({ width: 2560, height: 1920, resized: true });
    expect(targetSize(3000, 4000)).toEqual({ width: 1920, height: 2560, resized: true });
    expect(targetSize(2560, 100)).toEqual({ width: 2560, height: 100, resized: false });
    expect(targetSize(800, 600, 400)).toEqual({ width: 400, height: 300, resized: true });
    expect(targetSize(100_000, 1, 2560)).toEqual({ width: 2560, height: 1, resized: true });
  });
});

describe("prepareUpload (stubbed canvas)", () => {
  let decoded: { width: number; height: number };
  let encodedBytes: number;
  let encodeType: (requested: string) => string;
  const draws: { w: number; h: number; type?: string; quality?: number }[] = [];

  beforeEach(() => {
    draws.length = 0;
    encodedBytes = 1000;
    encodeType = (t) => t;
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      if (blob.type === "image/heic") throw new Error("unsupported");
      return { ...decoded, close() {} };
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage: (_i: unknown, _x: number, _y: number, w: number, h: number) => draws.push({ w, h }), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
        }
        async convertToBlob({ type, quality }: { type: string; quality: number }) {
          Object.assign(draws[draws.length - 1]!, { type, quality });
          return new Blob([new Uint8Array(encodedBytes)], { type: encodeType(type) });
        }
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const file = (bytes: number, type: string, name = "IMG_0001.HEIC.jpg") => new File([new Uint8Array(bytes)], name, { type });

  it("downscales a large phone JPEG to 2560 px, as JPEG, keeping a File with a fitting name", async () => {
    decoded = { width: 4032, height: 3024 };
    const res = await prepareUpload(file(5_000_000, "image/jpeg"));
    expect(res).toMatchObject({ changed: true, width: 2560, height: 1920 });
    expect(draws).toEqual([{ w: 2560, h: 1920, type: "image/jpeg", quality: 0.9 }]);
    expect(res.file).toBeInstanceOf(File);
    expect((res.file as File).name).toBe("IMG_0001.HEIC.jpg");
    expect(res.file.size).toBe(1000);
  });

  it("leaves small files alone, and files it cannot decode or should not flatten", async () => {
    decoded = { width: 1200, height: 800 };
    const small = file(300_000, "image/jpeg");
    expect(await prepareUpload(small)).toEqual({ file: small, changed: false, width: 1200, height: 800 });
    for (const type of ["image/gif", "image/svg+xml", "image/heic", ""]) {
      const f = file(9_000_000, type);
      expect((await prepareUpload(f)).file, type).toBe(f);
    }
    expect(draws).toEqual([]);
  });

  it("re-encodes a heavy PNG within the size limit as WebP, but only when that is smaller", async () => {
    decoded = { width: 2000, height: 1500 };
    const png = file(6_000_000, "image/png", "shot.png");
    const res = await prepareUpload(png);
    expect(res.changed).toBe(true);
    expect(draws[0]).toMatchObject({ w: 2000, h: 1500, type: "image/webp" });
    expect((res.file as File).name).toBe("shot.webp");

    encodedBytes = 7_000_000; // no gain: keep the original
    expect((await prepareUpload(png)).file).toBe(png);
  });

  it("accepts a PNG when the browser cannot encode WebP (older Safari)", async () => {
    decoded = { width: 5000, height: 2000 };
    encodeType = () => "image/png";
    const res = await prepareUpload(file(9_000_000, "image/png", "a.png"));
    expect(res).toMatchObject({ changed: true, width: 2560, height: 1024 });
    expect(res.file.type).toBe("image/png");
  });

  it("does nothing outside a browser", async () => {
    vi.unstubAllGlobals();
    const f = file(9_000_000, "image/jpeg");
    expect(await prepareUpload(f)).toEqual({ file: f, changed: false });
  });
});
