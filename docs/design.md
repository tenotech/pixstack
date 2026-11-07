# pixstack design

Status: **0.2 draft**. The parts marked *(phase 2/3)* are designed but not built yet. See [roadmap.md](roadmap.md).

## Goals

1. **Best default quality per byte.** Pick sensible encoders and settings once, so nobody has to tune them per project.
2. **Zero CPU on the request path** for public images.
3. **No layout shift and an instant placeholder.** Every image carries its dimensions and a ~25-byte thumbhash.
4. **Safe by default** against untrusted uploads.
5. **Framework-agnostic core.** Next.js and Hono get thin adapters, not the reverse.
6. **No SaaS.** It runs on a VPS disk or any S3-compatible bucket.

## Non-goals

- Live transforms through URL parameters (crop/blur/rotate). imgproxy already does this well, and it's the opposite trade-off.
- Image editing UI or cropping. Callers can pass `crop` focal hints *(phase 2)*.
- Video.

---

## ImageMeta

The single contract between all modules. It is stored as JSON and versioned with `v`.

```ts
interface ImageMeta {
  v: 1;
  id: string;            // 16-char base32 SHA-256 prefix of the original bytes
  width: number;         // after EXIF rotation
  height: number;
  format: SourceFormat;  // "jpeg" | "png" | "webp" | "avif" | "heif" | "gif" | "tiff"
  bytes: number;         // original size
  alpha: boolean;
  animated: boolean;
  color: string;         // dominant colour "#rrggbb", used as the background while loading
  thumbhash: string;     // base64; decoded into a ~32px placeholder data URL at render time
  variants: Variant[];   // sorted by width, then format
  original?: string;     // storage key of the kept original (private)
  pending?: OutputFormat[]; // since 0.2, optional: formats complete() still has to produce
  alt?: string;          // optional; most apps keep alt per usage, not per file
}

interface Variant {
  key: string;           // "img/<id>/<w>.<f>"
  format: "webp" | "avif";
  width: number;
  height: number;
  bytes: number;
}
```

About 1.4 KB for six widths × two formats (measured). That's small enough for a JSON column next to the row that uses it. *(v2 idea: drop `key`, which can be derived from id/width/format, to get ≈ 700 bytes.)*

## Processing defaults (`createImageProcessor`)

| Option | Default | Why |
|---|---|---|
| `widths` | `[320, 640, 960, 1280, 1920, 2560]` | Covers 1×/2× of a phone (360–430 CSS px), a card, a laptop and a retina hero. Widths above the source are skipped. The source width is added only when it is >10% wider than the last step that fits, which avoids near-duplicates like 1920 + 1945. |
| `formats` | `["avif", "webp"]` | AVIF is about 20–30% smaller than WebP at the same quality, and WebP is the fallback (supported by 97%+ of browsers). JPEG is not produced. |
| `webp` | `{ quality: 78, effort: 4, smartSubsample: true }` | q78 is visually lossless on photos at typical display sizes, and `smartSubsample` keeps red/blue edges sharp. |
| `avif` | `{ quality: 52, effort: 4, chromaSubsampling: "4:2:0" }` | AVIF's quality scale is lower than WebP's, and q≈50 ≈ WebP q78. `effort` 4 is about 5× faster than 9 with ~3% larger files. |
| PNG / alpha sources | WebP lossless when ≤ 512px wide, otherwise q90 + `alphaQuality: 90` | Logos and UI art: lossy WebP smears hard edges. |
| `maxBytes` | 25 MB | |
| `maxPixels` | 50 MP | Above a 48 MP phone sensor, below decompression-bomb territory. Checked from the header before full decode. |
| `maxDimension` | 12 000 px per side | |
| `allowSvg` | `false` | SVG is a document, not an image. Enable explicitly, and then it is rasterised. |
| `animated` | `"first-frame"` | Alternatives: `"keep"` (animated WebP, no AVIF) or `"reject"`. |
| `keepOriginal` | `true` | Lets you re-encode later. Stored privately under `orig/`. |
| `concurrency` | `2` | Max ingests running at once per process. sharp's internal thread pool is also capped. |
| `defer` | `[]` | Formats to skip in `ingest()` and produce later with `complete()`. Not on by default because it needs a second save of the meta. `["avif"]` is recommended for interactive uploads: ingest is 4.5–5× faster (measured: 3.7 s → 0.8 s on a 2 MB PNG hero). |
| `backgroundConcurrency` | `1` | `complete()` jobs run in their own queue, so background AVIF never delays uploads. |

The output is always 8-bit sRGB with metadata stripped. Wide-gamut (P3) photos are converted to sRGB *(phase 2: keep P3 with an embedded profile when `colorSpace: "p3"`)*.

### Algorithm

```
bytes ─▶ size check ─▶ sharp(bytes, { limitInputPixels, failOn: "error" }).metadata()
      ─▶ format allowlist, dimension/pixel checks
      ─▶ id = base32(sha256(bytes)).slice(0, 16)
      ─▶ if storage has img/<id>/ already and meta is known → return it (dedupe)
      ─▶ base = sharp(...).rotate().toColourspace("srgb")
      ─▶ for each width in ladder(meta.width):
             for each format: base.clone().resize(width).toFormat(...).toBuffer()
      ─▶ thumbhash from base.clone().resize(100, 100, { fit: "inside" }).raw()
      ─▶ colour: average of the thumbhash (no extra decode)
      ─▶ storage.put(...) all variants in parallel
      ─▶ keepOriginal → storage.put("orig/<id>.<ext>", bytes, { visibility: "private" })
      ─▶ return ImageMeta
```

Errors are typed (`PixstackError` with `code`: `TOO_LARGE`, `TOO_MANY_PIXELS`, `UNSUPPORTED_FORMAT`, `DECODE_FAILED`, `SVG_NOT_ALLOWED`, `ANIMATED_NOT_ALLOWED`), so routes can map them to 400/413/415 without parsing strings.

## Public API (v0.1)

```ts
// server-side
import { createImageProcessor } from "pixstack";
import { diskStorage } from "pixstack/storage";
import { createImageHandler, signUrl } from "pixstack/server";

const storage = diskStorage({ root: process.env.UPLOAD_DIR! });
export const images = createImageProcessor({ storage });

const meta = await images.ingest(await file.arrayBuffer());  // → ImageMeta
await images.remove(meta);                                    // deletes variants + original
await images.reprocess(meta, { formats: ["avif", "webp"] });  // from orig/

// fast uploads: WebP now, AVIF in the background
const fast = await images.ingest(bytes, { defer: ["avif"] }); // fast.pending = ["avif"]
await db.save(fast);
after(async () => db.save(await images.complete(fast)));     // Next.js `after()`, or a queue

// app/img/[...key]/route.ts (Next) or app.get("/img/*") (Hono)
export const GET = createImageHandler({ storage, basePath: "/img" });

// front end
import { Img } from "pixstack/react";
<Img image={product.image} alt={product.name} sizes="(min-width: 768px) 33vw, 100vw" priority />
```

### Storage interface

```ts
interface Storage {
  put(key: string, data: Uint8Array, opts: { contentType: string; visibility?: "public" | "private" }): Promise<void>;
  get(key: string, range?: { start: number; end: number }): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; mtime: Date } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  publicUrl?(key: string): string | null;  // set when a CDN/nginx serves keys directly
}
```

Drivers must reject keys that don't match `^[a-z0-9][a-z0-9/_.-]*$` or that contain `..`. Disk writes are atomic (temp file + rename).

### Serving handler

`createImageHandler({ storage, basePath, private?: { secret }, accel?: { prefix } })` returns `(req: Request) => Promise<Response>`:

- Only `GET`/`HEAD`. Only keys matching `img/<id>/<w>.(webp|avif)` or, when signed, `orig/<id>.<ext>`.
- `ETag: "<id>-<w>-<f>"` (strong, derived from the key since content is immutable) → `304` on `If-None-Match`.
- `Cache-Control: public, max-age=31536000, immutable` (public) / `private, max-age=<remaining signature life>` (signed).
- Streams the body, sets `Content-Length`, supports single `Range` (`206`/`416`), `Accept-Ranges: bytes`.
- Always `X-Content-Type-Options: nosniff`, plus `Content-Security-Policy: default-src 'none'; sandbox`.
- With `accel`, it returns an empty body and `X-Accel-Redirect: <prefix>/<key>` so nginx sends the file.

Signed URLs: `signUrl("/img/orig/abc.jpg", { secret, expiresIn: 3600 })` → `?exp=…&sig=…` (HMAC-SHA256 over path + exp, base64url, compared in constant time).

### React

`getImageProps(meta, { sizes, urlFor?, priority?, alt })` returns plain props, and `<Img>` renders them:

```html
<picture>
  <source type="image/avif" srcset="/img/ab…/320.avif 320w, … 1920w" sizes="…">
  <img src="/img/ab…/960.webp" srcset="/img/ab…/320.webp 320w, …" sizes="…"
       width="1920" height="1280" alt="…" loading="lazy" decoding="async"
       style="background:#a3826b url(data:image/png;base64,…) center/cover no-repeat">
</picture>
```

- `priority` → `loading="eager"` + `fetchpriority="high"`, and no placeholder background (the LCP image should paint itself).
- `width`/`height` always come from the meta, so the browser reserves the aspect ratio. CSS can still set `width:100%; height:auto`.
- The placeholder is the thumbhash decoded to a ~32px PNG data URL (≈ 300–600 bytes inline) over the dominant colour. Pass `placeholder="color"` for colour only, or `"none"`.
- `urlFor(key)` defaults to `/img/<key without "img/">`. Override it for a CDN (`https://cdn.example.com/${key}`).

### `pixstack/next` *(phase 2)*

A custom `next/image` loader for projects that want to keep `<Image>`: `src` = `pixstack:<id>` and the loader picks the nearest ladder width. It removes `/_next/image` from the hot path (and with it the optimizer CVEs). `<Img>` is still preferred because it knows the real variant list.

### `pixstack/client` *(phase 2)*

`prepareUpload(file, { maxEdge: 2560, quality: 0.85 })` in the browser: `createImageBitmap(file, { imageOrientation: "from-image" })` → `OffscreenCanvas` → WebP/JPEG `Blob`. Typically shrinks a 12 MB phone photo to ~800 KB before upload. The server still does full validation.

## Decisions

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | Variants at upload time | On-demand optimizer: CPU on hot path, CVE surface, cache config burden |
| D2 | Content-addressed keys | uuid (no dedupe, needs DB to map), date paths |
| D3 | One `ImageMeta` JSON per usage | Separate `Image`/`Variant` tables: joins everywhere, migrations |
| D4 | AVIF + WebP, no JPEG | JPEG fallback: <3% of traffic, doubles storage |
| D5 | thumbhash | BlurHash (no alpha, needs aspect separately), base64 WebP LQIP (~20× larger) |
| D6 | Web-standard `Request → Response` handler | Express/Node `req,res`: doesn't run in Next route handlers, Hono, Bun |
| D7 | Single npm package, subpath exports | `@pixstack/*` monorepo: more install friction for users; split later if needed |
| D8 | sharp as peer dependency | Bundled: version conflicts with apps that already use sharp |
