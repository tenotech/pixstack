import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getImageProps, Img } from "../src/react";
import type { ImageMeta } from "../src/meta";

const meta: ImageMeta = {
  v: 1,
  id: "abcdefghijklmnop",
  width: 1600,
  height: 900,
  format: "jpeg",
  bytes: 1,
  alpha: false,
  animated: false,
  color: "#a3826b",
  // A real thumbhash (landscape, warm tones).
  thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
  variants: [640, 1280, 1600].flatMap((w) =>
    (["avif", "webp"] as const).map((format) => ({
      key: `img/abcdefghijklmnop/${w}.${format}`,
      format,
      width: w,
      height: Math.round((w * 9) / 16),
      bytes: w,
    })),
  ),
};

describe("<Img>", () => {
  it("renders <picture> with an AVIF source, WebP img, intrinsic size, lazy loading and placeholder", () => {
    const html = renderToStaticMarkup(<Img image={meta} alt="Cake" sizes="50vw" className="hero" />);
    expect(html).toMatch(/^<picture><source type="image\/avif" srcSet="[^"]*640\.avif 640w, [^"]*1280\.avif 1280w/);
    expect(html).toContain('src="/img/abcdefghijklmnop/1280.webp"');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('sizes="50vw"');
    expect(html).toContain('class="hero"');
    expect(html).toContain("background-color:#a3826b");
    expect(html).toContain("data:image/png;base64");
  });

  it("priority images load eagerly at high priority without a placeholder", () => {
    const html = renderToStaticMarkup(<Img image={meta} alt="" priority />);
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain("background");
  });

  it("renders a bare <img> when only one format exists, and honours urlFor", () => {
    const webpOnly = { ...meta, variants: meta.variants.filter((v) => v.format === "webp") };
    const html = renderToStaticMarkup(<Img image={webpOnly} alt="x" urlFor={(k) => `https://cdn.test/${k}`} />);
    expect(html.startsWith("<img")).toBe(true);
    expect(html).toContain("https://cdn.test/img/abcdefghijklmnop/640.webp 640w");
  });

  it("skips the placeholder for transparent images by default", () => {
    const props = getImageProps({ ...meta, alpha: true }, { alt: "logo" });
    expect(props.img.style).toBeUndefined();
    expect(getImageProps(meta, { alt: "", placeholder: "color" }).img.style).toEqual({ backgroundColor: "#a3826b" });
  });
});
