# pixstack architecture

pixstack takes an uploaded image, processes it once, stores ready-to-serve files, serves them the cheapest way available, and renders them with the right `srcset` and placeholder. One JSON object, `ImageMeta`, connects all of these steps.

## The pipeline

```
 browser / app                 your server                          storage            visitor
 ─────────────                 ───────────                          ───────            ───────
 pixstack/client               pixstack/core                         pixstack/storage
 prepareUpload()   ──upload──▶ ingest(bytes)                         disk | s3 | memory
  • downscale ≤2560px            1. sniff the real format from bytes
  • re-encode q≈0.85             2. refuse: too large, too many pixels, SVG
                                 3. decode once, rotate (EXIF), sRGB
                                 4. hash the original → id
                                 5. clone → width ladder × formats ──put──▶ img/<id>/640.webp
                                 6. thumbhash + dominant colour            img/<id>/640.avif
                                 7. optionally keep the original ──put──▶ orig/<id>.jpg (private)
                               ◀── ImageMeta (JSON)
                               save in DB (one Json column)

                               pixstack/server                                          GET /img/<id>/640.webp
                               createImageHandler()  ◀────────────────────────────────── 
                                 • streams, Content-Length, Range
                                 • ETag → 304, immutable 1y
                                 • signed URLs for private files
                                 • or X-Accel-Redirect → nginx sends the bytes

                               pixstack/react
                               <Img image={meta} sizes="…"/>  ──HTML──▶  <picture>
                                                                           <source type=avif srcset=…>
                                                                           <img srcset=webp… width height
                                                                                style=thumbhash/colour>
```

## Modules

| Import | Runs on | Depends on | Job |
|---|---|---|---|
| `pixstack` / `pixstack/core` | Node ≥ 20 | `sharp` (peer), `thumbhash` | `createImageProcessor()`: validate, process, build `ImageMeta`, write through storage |
| `pixstack/storage` | Node | none | `Storage` interface; `diskStorage`, `memoryStorage` |
| `pixstack/storage/s3` | any runtime the AWS SDK supports | `@aws-sdk/client-s3` (optional peer) | `s3Storage` for AWS S3, Cloudflare R2, MinIO and others. It writes `Cache-Control` on each object, so a CDN in front of the bucket caches correctly. |
| `pixstack/server` | any Web-standard runtime (Node 20+, Bun, Deno, edge) | none | `createImageHandler()`: `(Request) => Response`; `signUrl()` / `verifySignature()` |
| `pixstack/react` | React 18/19, server or client | `react` (peer), `thumbhash` | `<Img>`, `getImageProps()`, `placeholderStyle()` |
| `pixstack/meta` | anywhere | none | `ImageMeta` types, `pickVariant()`, `srcSet()`, URL builder |
| `pixstack/client` *(phase 2)* | browser, Expo | none | `prepareUpload()`: downscale before upload |
| `pixstack/next` *(phase 2)* | Next.js | `next` (peer) | `next/image` loader pointing at stored variants |
| `pixstack` CLI *(phase 3)* | Node | core | backfill, migrate, audit, delete orphans |

Rule: `meta` is pure and dependency-free. `react` and `server` import only `meta`. Only `core` touches sharp, so a frontend bundle never pulls in native code.

## Data model: one JSON column

```prisma
model Product {
  id    String @id
  image Json?          // ImageMeta
}
```

`ImageMeta` contains everything every layer needs: dimensions, variant list, placeholder and dominant colour. There are no extra tables or join queries, and rendering needs no storage round-trip. See [design.md](design.md#imagemeta) for the schema.

## Storage layout

```
img/<id>/<width>.<format>    public, content-addressed, never changes → cache forever
orig/<id>.<ext>              private, optional, used to re-encode later (new format, new ladder)
```

`<id>` is the first 16 base32 characters of the SHA-256 of the original bytes. The same image uploaded twice gets the same id and stays one copy on disk. Because a URL's content never changes, `Cache-Control: immutable` is always correct and CDNs never need purging.

## Serving: three deployment modes

| Mode | Who sends the bytes | Use when |
|---|---|---|
| **A. Static** | nginx `location /img/ { alias /data/uploads/img/; }` or a CDN in front of S3/R2 | Public images (the common case). Node is never involved. |
| **B. Handler** | `createImageHandler()` in a route (Next, Hono, …) | Simple setups, local dev, or no access to nginx config. |
| **C. Handler + X-Accel** | Handler checks access, nginx streams the file | Private images (`orig/`, invoices, KYC) at static-file speed. |

All three use the same URLs, so you can switch modes without touching the database or frontend.

## Why upload-time variants, not on-demand resizing

| | On demand (`/_next/image`, imgproxy) | Upload time (pixstack) |
|---|---|---|
| CPU | every cache miss, on the request path | once, on upload |
| First visitor | slow (AVIF encode ≈ 0.5–2 s) | fast |
| Cache | must be configured (and often isn't) | files *are* the cache |
| Attack surface | public endpoint that decodes arbitrary input | decoder runs only on authenticated uploads |
| Disk | low | ≈ 1.5–2× the original JPEG, spread over the width ladder |
| New sizes later | free | re-run `reprocess()` from `orig/` (CLI) |

For sites with thousands of images on a single VPS, upload time wins. Disk is cheap and CPU on the request path is not.

## Security boundaries

- Input is untrusted. The format comes from magic bytes, never from the client MIME or file name. Limits on byte size, pixel count and dimensions apply before full decode. SVG is refused unless explicitly enabled.
- Output is clean. Everything is re-encoded, so EXIF/GPS/ICC payloads never survive, and the encoder only produces formats we chose.
- Paths are never user-controlled. Keys are built from hashes and integers only, and storage drivers additionally refuse any key outside their root.
- The serving handler only serves extensions it knows, always sends `nosniff`, and returns 404 for anything that doesn't match the key pattern.
