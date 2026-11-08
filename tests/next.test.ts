import { describe, expect, it } from "vitest";
import { toImageRef, type ImageMeta } from "../src/meta";
import loader, { createNextLoader } from "../src/next";

const id = "abcdefghijklmnop";
const meta = (formats: ("avif" | "webp")[], pending?: ("avif" | "webp")[]): ImageMeta => ({
  v: 1,
  id,
  width: 2000,
  height: 1000,
  format: "jpeg",
  bytes: 1,
  alpha: false,
  animated: false,
  color: "#336699",
  thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
  variants: [320, 640, 1280].flatMap((w) =>
    formats.map((f) => ({ key: `img/${id}/${w}.${f}`, format: f, width: w, height: w / 2, bytes: 1 })),
  ),
  ...(pending ? { pending } : {}),
});

describe("pixstack/next loader", () => {
  const ref = toImageRef(meta(["avif", "webp"]));

  it("maps each requested width to the smallest stored variant at least that wide", () => {
    expect(loader({ src: ref, width: 300 })).toBe(`/img/${id}/320.webp`);
    expect(loader({ src: ref, width: 640 })).toBe(`/img/${id}/640.webp`);
    expect(loader({ src: ref, width: 3840, quality: 75 })).toBe(`/img/${id}/1280.webp`);
  });

  it("keeps the ref's base (CDN) and can serve AVIF, falling back while AVIF is pending", () => {
    const cdn = toImageRef(meta(["avif", "webp"]), (k) => `https://cdn.example.com/${k}`);
    expect(createNextLoader({ format: "avif" })({ src: cdn, width: 600 })).toBe(
      `https://cdn.example.com/img/${id}/640.avif`,
    );
    const pending = toImageRef(meta(["webp"], ["avif"]));
    expect(createNextLoader({ format: "avif" })({ src: pending, width: 600 })).toBe(`/img/${id}/640.webp`);
  });

  it("passes anything that is not a ref to the fallback", () => {
    expect(loader({ src: "/demo/photo.jpg", width: 640 })).toBe("/demo/photo.jpg?w=640");
    expect(loader({ src: "/a.png?v=2", width: 64 })).toBe("/a.png?v=2&w=64");
    expect(loader({ src: `/img/${id}/640.webp`, width: 64 })).toBe(`/img/${id}/640.webp?w=64`); // no meta in it
    const custom = createNextLoader({ fallback: ({ src, width, quality }) => `/_next/image?url=${src}&w=${width}&q=${quality ?? 75}` });
    expect(custom({ src: "/x.jpg", width: 10 })).toBe("/_next/image?url=/x.jpg&w=10&q=75");
  });
});
