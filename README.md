# pixstack

**Cloudinary-quality images for self-hosted apps.** Upload once, and pixstack validates the file, compresses it to AVIF + WebP at a ladder of widths, stores the results on disk or S3, serves them with forever-caching, and renders them with `srcset`, intrinsic size and an instant thumbhash placeholder.

No SaaS, no image CDN bill, and no CPU spent on the request path.

> Status: **0.3, pre-release.** The API may change before 1.0. See [docs/roadmap.md](docs/roadmap.md).

```
2.1 MB PNG hero (1945×809) → 88 KB AVIF full width · 6 KB at 320px · 25-byte placeholder
```

## Why

`next/image` and similar optimizers resize **on request**. The first visitor waits while the server encodes, every cache miss costs CPU, and a public endpoint decodes arbitrary input (the Next.js optimizer had several critical CVEs in 2026). Hand-rolled upload code tends to be worse: originals served from Node, no dimensions stored, no placeholders, `Cache-Control` guessed.

pixstack does the work **at upload time** and stores ready-made files under content-addressed URLs. Those URLs never change, so they can be cached forever and served by nginx or a CDN directly.

## Install

```sh
pnpm add pixstack sharp
```

`sharp` is needed only where you ingest (the server). `react` is needed only for `pixstack/react`.

## Quick start (Next.js App Router)

```ts
// lib/images.ts
import { createImageProcessor } from "pixstack";
import { diskStorage } from "pixstack/storage";

export const storage = diskStorage({ root: process.env.UPLOAD_DIR ?? "./uploads" });
export const images = createImageProcessor({ storage });
```

```ts
// app/api/upload/route.ts
import { isPixstackError } from "pixstack";
import { images } from "@/lib/images";

export async function POST(req: Request) {
  // …authenticate first…
  const file = (await req.formData()).get("file");
  if (!(file instanceof Blob)) return Response.json({ error: "No file" }, { status: 400 });
  try {
    const meta = await images.ingest(file);
    await db.product.update({ where: { id }, data: { image: meta } }); // a Json column
    return Response.json(meta);
  } catch (err) {
    if (isPixstackError(err)) return Response.json({ error: err.code }, { status: err.status });
    throw err;
  }
}
```

```ts
// app/img/[...key]/route.ts — or skip this and let nginx serve /img/ (below)
import { createImageHandler } from "pixstack/server";
import { storage } from "@/lib/images";

const handler = createImageHandler({ storage });
export { handler as GET, handler as HEAD };
```

```tsx
// anywhere
import { Img } from "pixstack/react";

<Img image={product.image} alt={product.name} sizes="(min-width: 768px) 33vw, 100vw" />
<Img image={hero.image} alt="" sizes="100vw" priority />   {/* the LCP image */}
```

This renders:

```html
<picture>
  <source type="image/avif" srcset="/img/k3…/320.avif 320w, /img/k3…/640.avif 640w, …" sizes="…">
  <img src="/img/k3…/1280.webp" srcset="/img/k3…/320.webp 320w, …" sizes="…"
       width="1945" height="809" loading="lazy" decoding="async" alt="…"
       style="background-color:#a38668;background-image:url(data:image/png;base64,…);…">
</picture>
```

## Already have `imageUrl` string columns? Use refs

If you don't want a JSON column, store an **ImageRef** instead. It's a normal image URL that also carries the meta:

```ts
import { toImageRef } from "pixstack/meta";

const ref = toImageRef(await images.ingest(file));
// "/img/k3…/1280.webp?pv=1&w=1945&h=809&l=320.640.960.1280.1920&f=aw&s=j&c=a38668&t=…"
await db.category.update({ where: { id }, data: { imageUrl: ref } });

<Img image={category.imageUrl} alt={category.name} sizes="50vw" />  // same output as with the meta
```

Old code that does `<img src={imageUrl}>` keeps working, because the ref points at a real 1280px WebP. Use `isImageRef(url)` to tell refs apart from legacy URLs while you migrate.

> **Identical files share one URL.** pixstack names files by their content, so the same photo uploaded twice (say, one shot used for two colour variants) gives the same ref. Don't use the image URL alone as a React `key`, and don't delete stored files when one record drops a ref: another record may still use it. Reclaim unused files with a sweep instead.

## Store on S3 / Cloudflare R2

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { s3Storage } from "pixstack/storage/s3";

const storage = s3Storage({
  client: new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_KEY!, secretAccessKey: process.env.R2_SECRET! },
  }),
  bucket: "media",
  publicBaseUrl: "https://media.example.com", // custom domain on the bucket
});
// <Img urlFor={(key) => storage.publicUrl!(key)} … /> serves straight from the CDN
```

Variants are written with `Cache-Control: public, max-age=31536000, immutable`, originals with `private, no-store`. Keep `orig/` out of the public bucket domain: with R2, use a separate bucket or a WAF rule.

## Serve with nginx (recommended)

Public variants are plain files, so let nginx send them and keep Node out of the path:

```nginx
location /img/ {
    alias /data/uploads/img/;
    expires max;
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header X-Content-Type-Options nosniff;
    location ~ /meta\.json$ { return 404; }
}
# Never alias /data/uploads/orig/. Originals are private (see signed URLs).
```

For **private** images, keep the access check in your app and let nginx stream the bytes:

```ts
createImageHandler({ storage, secret: process.env.IMAGE_SECRET, accel: { prefix: "/_pixstack" } });
```

```nginx
location /_pixstack/ { internal; alias /data/uploads/; }
```

## What `ingest()` does

1. Detects the format from the **bytes** (never trusts the MIME type or file name). Accepts JPEG, PNG, WebP, AVIF, HEIC, GIF and TIFF. SVG is refused unless `allowSvg`, and then it is rasterised.
2. Enforces `maxBytes` (25 MB), `maxPixels` (50 MP) and `maxDimension` (12 000 px) from the header, before decoding.
3. Applies EXIF orientation, converts to sRGB and **strips all metadata** (GPS included).
4. Hashes the original into an id. Re-uploading the same file returns the existing meta.
5. Encodes widths `320 / 640 / 960 / 1280 / 1920 / 2560` (never upscaling) as AVIF q52 and WebP q78. Transparent images get higher alpha quality, and small PNG art is encoded losslessly.
6. Computes a [thumbhash](https://evanw.github.io/thumbhash/) and the dominant colour.
7. Stores `img/<id>/<w>.<fmt>` (public), `orig/<id>.<ext>` (private, for `reprocess()`) and `img/<id>/meta.json`.
8. Returns an `ImageMeta` (~1.4 KB JSON) that you save next to your record.

### Faster uploads: AVIF in the background

AVIF compresses best but encodes slowest. Defer it so the upload returns 4–5× sooner:

```ts
import { after } from "next/server";

const meta = await images.ingest(file, { defer: ["avif"] }); // WebP ready, meta.pending = ["avif"]
await db.product.update({ where: { id }, data: { image: meta } });
after(async () => {
  const full = await images.complete(meta); // adds AVIF from the kept original
  await db.product.update({ where: { id }, data: { image: full } });
});
```

Until `complete()` finishes, `<Img>` serves WebP only. `complete()` is idempotent and reads the original from storage, so it also works from a queue worker or after a restart.

Errors are `PixstackError`s with a `code` (`TOO_LARGE`, `TOO_MANY_PIXELS`, `UNSUPPORTED_FORMAT`, `SVG_NOT_ALLOWED`, …) and a suggested HTTP `status`.

## Modules

| Import | For |
|---|---|
| `pixstack` | `createImageProcessor`: `ingest`, `reprocess`, `remove`, `getMeta` |
| `pixstack/storage` | `diskStorage`, `memoryStorage`, the `Storage` interface |
| `pixstack/storage/s3` | `s3Storage` for AWS S3, Cloudflare R2, MinIO (needs `@aws-sdk/client-s3`) |
| `pixstack/server` | `createImageHandler` (Web `Request → Response`; works in Next, Hono, Bun, Deno), `signUrl` |
| `pixstack/react` | `<Img>`, `getImageProps`, `placeholderStyle` |
| `pixstack/meta` | `ImageMeta` types, `srcSet`, `pickVariant`, `widthLadder` (no dependencies) |

## Docs

- [Architecture](docs/architecture.md): pipeline, modules, storage layout, serving modes
- [Design](docs/design.md): `ImageMeta`, defaults and why, API, decisions
- [Adoption guide](docs/adoption.md): migrating an existing app (string image columns, `next/image`, Docker)
- [Roadmap](docs/roadmap.md): what's done and what's next

## Development

```sh
pnpm install
pnpm check   # typecheck + tests + build
```

## License

MIT
