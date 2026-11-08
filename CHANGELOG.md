# Changelog

pixstack follows [semver](https://semver.org). Before 1.0, a minor version (0.x → 0.y) may change the API; patch versions don't. The `ImageMeta` and ImageRef formats are versioned separately (`v`, `pv`) and only change with a migration.

## 0.5.0 (2026-11-08)

First release on npm.

**New entry points**
- `pixstack/node`: `toNodeHandler()` runs the image handler on `node:http`, Express, Connect and Fastify. With Express, unknown keys fall through to `next()`.
- `pixstack/next`: a `next/image` loader (`export { default } from "pixstack/next"`). Refs map each width to a stored variant; other URLs get `?w=`.
- `pixstack/client`: `prepareUpload()` shrinks photos to 2560 px in the browser before upload (EXIF dropped, input returned untouched when nothing is gained). `targetSize()` for Expo.
- `pixstack` CLI: `ingest` (files or folders, for backfills), `complete`, `reprocess`, `audit`, `sweep` (dry run unless `--yes`), `ref`. Disk (`--root`) or S3 (`--s3-bucket`).

**Fixed**
- `<Img priority>`: on pages that await data (every dynamic App Router page), the preload only travelled in the RSC payload, so the browser saw it after hydration. It is now rendered by a small Client Component and lands in `<head>`, like `next/image`'s `priority`. Apps on 0.3.1–0.4.0 get the fix by upgrading.

**Tooling**
- CI on Linux, macOS and Windows with Node 22 and 24; S3 tests against S3Mock; both examples built.
- Fuzz tests: mutated image files, refs and request paths fail cleanly (typed errors, no 5xx, no unsafe keys).
- Import boundaries checked on the sources and on the build (`check:dist`).
- `pnpm bench <dir>`: bytes and SSIM per format and quality. First results in `docs/design.md`.
- Examples: `examples/next` (App Router), `examples/hono`.

**Breaking**
- Node ≥ 22 (Node 20 reached end of life in April 2026).

## 0.4.0 (2026-11-08)

- `images.sweep({ keep })` deletes stored images that no record references, with a 24 h grace period. It refuses an empty `keep`, and never touches keys that aren't image ids.
- `Storage.list(prefix)`, optional in the interface, on disk, memory and S3.
- A dedupe hit rewrites `meta.json`, so a re-uploaded orphan restarts its grace period.

## 0.3.1 (2026-11-07)

- `<Img priority>` adds a typed AVIF `<link rel="preload">`.

## 0.3.0 (2026-11-07)

- ImageRef: the meta packed into a URL string, for apps with string image columns. `<Img>` accepts a ref.
- Denser default width ladder (160 … 2560); `isImageRef` returns a boolean; `computeImageId`.

## 0.1.0–0.2.0 (2026-11-06)

- Core: validation from bytes, EXIF handling, AVIF + WebP ladder, thumbhash, content-addressed ids, typed errors, `defer` + `complete()`, `reprocess()`.
- Storage: disk, memory, S3. Server handler: ETag, Range, immutable caching, signed URLs, X-Accel-Redirect. React `<Img>`.
