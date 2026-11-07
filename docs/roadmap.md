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

- [ ] `pixstack/client`: `prepareUpload()` to downscale in the browser / Expo before upload
- [ ] `pixstack/next`: `next/image` loader that points at stored variants
- [ ] Node `http` adapter (Express / Fastify)
- [ ] Verified on Cloudflare R2 and AWS S3 (not just S3Mock)
- [ ] `examples/next` (App Router) and `examples/hono`
- [ ] Benchmark script over a public-domain photo set: bytes and SSIM per format/quality, to tune defaults with data

## 0.5: tooling

- [ ] CLI: `pixstack backfill` (adopt existing uploads), `complete` (finish images left `pending`), `reprocess`, `audit` (orphans, missing variants), `sweep`
- [ ] Focal-point crops (`crop` hints) and art direction
- [ ] Optional P3 output with an embedded profile

## 1.0: public release

Release only after several apps have run it in production for a month.

- [ ] API and `ImageMeta` v1 frozen (later changes via `v: 2` + migrate helper)
- [ ] CI: lint, test on Linux/macOS/Windows and Node 20/22/24, S3 tests against S3Mock; changesets; npm provenance
- [ ] README benchmarks against `next/image` and raw uploads
- [ ] `SECURITY.md`, fuzz tests on malformed files

## Success metrics (measured on adopters)

| Metric | Target |
|---|---|
| Image bytes on a product-list page (mobile) | −40% compared with before migration |
| LCP p75 (mobile) | < 2.0 s |
| CLS from images | 0 |
| Server CPU per 1 000 image requests | ≈ 0 (served by nginx/CDN) |
| Upload → usable (12 MP photo, small VPS, `defer: ["avif"]`) | < 1.5 s |
