# pixstack roadmap

These are targets, not promises. Each phase ends with something usable in a real app.

## 0.1–0.3: core ✅

- [x] `pixstack/meta`: `ImageMeta` contract, width ladder, `srcSet`, `pickVariant`
- [x] `pixstack`: validation from bytes, pixel/size/dimension limits, EXIF rotation and stripping, AVIF + WebP ladder, thumbhash, dominant colour, content-hash dedupe, typed errors, concurrency limit
- [x] `defer` + `complete()`: WebP at upload, AVIF in a background queue (ingest 4.5–5× faster)
- [x] `reprocess()` from the kept original
- [x] `pixstack/storage`: `diskStorage` (atomic writes, safe keys), `memoryStorage`
- [x] `pixstack/storage/s3`: AWS S3, Cloudflare R2, MinIO (tested against S3Mock)
- [x] `pixstack/server`: Web-standard handler (stream, ETag/304, Range, immutable, nosniff, X-Accel-Redirect), signed URLs
- [x] `pixstack/react`: `<Img>`, `getImageProps`, thumbhash placeholder
- [x] 0.3: `ImageRef`. The meta packed in a URL string, for apps with string image columns (no schema migration); `<Img>` accepts it

## 0.4: first production adopters

The API gets validated by migrating existing production apps (e-commerce storefronts, a booking platform, a Hono API with an Expo client) off hand-rolled sharp code.

- [x] First adopter: a Next.js storefront (Docker, blue-green, shared nginx), string image columns via `ImageRef`, no schema migration. See [adoption.md](adoption.md) for the guide and the measured results.
- [x] Pilot fixes: denser default width ladder, `isImageRef` returns `boolean`, `computeImageId`
- [x] 0.3.1: `priority` images are preloaded in `<head>` (typed AVIF), found by a storefront's loading test that `next/image` passed
- [x] Production results after deploy: first-visit LCP 6.26 s → 1.07 s, slowest image 5.95 s → 0.33 s (see [adoption.md](adoption.md))
- [x] 0.4.0: `sweep({ keep, olderThan, dryRun })` reclaims stored images no record references (24 h grace, refuses an empty `keep`); `Storage.list()` on disk, memory and S3

- [x] 0.5.0: `pixstack/client`: `prepareUpload()` downscales in the browser before upload; `targetSize()` for Expo
- [x] 0.5.0: `pixstack/next`: `next/image` loader that points at stored variants
- [x] 0.5.0: `pixstack/node`: Node `http` adapter (Express / Connect / Fastify)
- [x] 0.5.0: `examples/next` (App Router) and `examples/hono`, built in CI
- [x] 0.5.0: `pnpm bench <dir>`: bytes and SSIM per format/quality (first results in [design.md](design.md#measured-bytes-vs-quality-pnpm-bench))
- [x] 0.5.0: `<Img priority>` preload reaches `<head>` on dynamic pages too (it only travelled in the RSC payload)
- [ ] Verified on Cloudflare R2 and AWS S3 (not just S3Mock): needs real buckets
- [ ] Perceptual metric (SSIMULACRA2) in the bench, then settle the AVIF quality default (open question in design.md)

## 0.5: tooling

- [x] 0.5.0: CLI: `pixstack ingest` (backfill a folder), `complete`, `reprocess`, `audit`, `sweep`, `ref`; disk or S3
- [ ] Focal-point crops (`crop` hints) and art direction
- [ ] Optional P3 output with an embedded profile

## 1.0: public release

Release only after several apps have run it in production for a month.

- [ ] API and `ImageMeta` v1 frozen (later changes via `v: 2` + migrate helper)
- [x] 0.5.0: CI on Linux/macOS/Windows × Node 22/24, S3 tests against S3Mock, examples built; tag-driven npm release with provenance
- [x] 0.5.0: `SECURITY.md`, fuzz tests on malformed files, refs and request paths; import-boundary checks on sources and build
- [ ] README benchmarks against `next/image` and raw uploads

## Success metrics (measured on adopters)

| Metric | Target |
|---|---|
| Image bytes on a product-list page (mobile) | −40% compared with before migration |
| LCP p75 (mobile) | < 2.0 s |
| CLS from images | 0 |
| Server CPU per 1 000 image requests | ≈ 0 (served by nginx/CDN) |
| Upload → usable (12 MP photo, small VPS, `defer: ["avif"]`) | < 1.5 s |
