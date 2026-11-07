import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createImageProcessor } from "../src/index";
import { isImageRef, parseImageRef, toImageRef, type ImageMeta } from "../src/meta";
import { Img } from "../src/react";
import { memoryStorage } from "../src/storage";
import { makeJpeg, makePng } from "./helpers";

async function realMeta(): Promise<ImageMeta> {
  return createImageProcessor({ storage: memoryStorage() }).ingest(await makeJpeg(1945, 809));
}

describe("ImageRef", () => {
  it("round-trips everything rendering needs, in a short real URL", async () => {
    const meta = await realMeta();
    const ref = toImageRef(meta);
    expect(ref.startsWith(`/img/${meta.id}/1280.webp?pv=1&`)).toBe(true);
    expect(ref.length).toBeLessThan(200);

    const parsed = parseImageRef(ref)!;
    expect(parsed.base).toBe("/");
    const m = parsed.meta;
    expect([m.id, m.width, m.height, m.format, m.color, m.thumbhash, m.alpha]).toEqual([
      meta.id, meta.width, meta.height, meta.format, meta.color, meta.thumbhash, false,
    ]);
    expect(m.variants.map((v) => v.key)).toEqual(meta.variants.map((v) => v.key));
    // Heights are recomputed from the aspect ratio: within 1px of the encoder's.
    m.variants.forEach((v, i) => expect(Math.abs(v.height - meta.variants[i]!.height)).toBeLessThanOrEqual(1));
  });

  it("keeps a CDN base, alpha, and pending formats", async () => {
    const storage = memoryStorage();
    const meta = await createImageProcessor({ storage, defer: ["avif"] }).ingest(await makePng(300, 200));
    const ref = toImageRef(meta, (k) => `https://cdn.example.com/${k}`);
    const parsed = parseImageRef(ref)!;
    expect(parsed.base).toBe("https://cdn.example.com/");
    expect(parsed.meta.alpha).toBe(true);
    expect(parsed.meta.pending).toEqual(["avif"]);
    expect(parsed.meta.variants.every((v) => v.format === "webp")).toBe(true);

    const html = renderToStaticMarkup(<Img image={ref} alt="logo" />);
    expect(html).toContain(`https://cdn.example.com/img/${meta.id}/300.webp 300w`);
  });

  it("renders <Img> from a ref string like from a meta", async () => {
    const meta = await realMeta();
    const fromMeta = renderToStaticMarkup(<Img image={meta} alt="x" sizes="50vw" />);
    const fromRef = renderToStaticMarkup(<Img image={toImageRef(meta)} alt="x" sizes="50vw" />);
    expect(fromRef).toBe(fromMeta);
    expect(() => renderToStaticMarkup(<Img image="/uploads/a.webp" alt="" />)).toThrow(/not an image ref/);
  });

  it("rejects anything malformed (refs come back from the database)", async () => {
    const good = toImageRef(await realMeta());
    const bad = [
      "",
      "/uploads/x/123.webp",
      "/demo/photo.webp",
      good.replace("pv=1", "pv=2"),
      good.replace(/\?.*/, ""),
      good.replace(/c=[0-9a-f]{6}/, "c=red"),
      good.replace(/w=\d+/, "w=-5"),
      good.replace(/l=[\d.]+/, "l=320.99999999"),
      good.replace(/f=\w+/, "f=x"),
      good.replace(/t=[^&]+/, "t=%3Cscript%3E"),
      good.replace(/\/img\/[a-z2-7]{16}/, "/img/../../etc"),
      `${good}&`.repeat(30),
      42,
      null,
    ];
    for (const b of bad) expect(isImageRef(b), String(b).slice(0, 60)).toBe(false);
    expect(isImageRef(good)).toBe(true);
  });
});
