# Security

## Reporting a vulnerability

Please report security issues privately through [GitHub security advisories](https://github.com/tenotech/pixstack/security/advisories/new), not in public issues. You should get a first answer within a week. Fixes are released as a patch version for the latest minor, with an advisory once users have had time to upgrade.

## Supported versions

Before 1.0, only the latest minor version (currently 0.5.x) gets security fixes.

## What pixstack defends against

pixstack sits on the upload path, so it treats every input as hostile.

| Threat | Defence | Tested in |
|---|---|---|
| A file that lies about its type (`.jpg` that is HTML/SVG/script) | The type comes from the bytes, never the name or the client's `Content-Type`. Output is always re-encoded AVIF/WebP. | `tests/processor.test.ts`, `tests/fuzz.test.ts` |
| Decompression bombs | Pixel, dimension and byte limits checked from the header before full decode (`maxPixels`, `maxDimension`, `maxBytes`). | `tests/processor.test.ts` |
| Malformed or truncated files | Fail with a typed `PixstackError` (4xx), never a crash. | `tests/fuzz.test.ts` |
| SVG scripts | SVG is refused by default; when allowed, it is rasterised. Any file opened directly is served with `nosniff` and a sandboxing CSP. | `tests/processor.test.ts`, `tests/server.test.ts` |
| Location leaks | EXIF (GPS included) is stripped from every variant; `prepareUpload()` drops it before upload too. | `tests/processor.test.ts` |
| Path traversal | Storage keys are validated by every driver (`assertSafeKey`); the handler serves only keys matching the variant and original patterns. | `tests/storage.test.ts`, `tests/server.test.ts`, `tests/fuzz.test.ts` |
| Forged refs from the database | `parseImageRef` is strict; anything it accepts yields only well-formed variant keys. | `tests/ref.test.tsx`, `tests/fuzz.test.ts` |
| Access to originals | Originals are private and served only with an HMAC-signed, expiring URL. | `tests/server.test.ts` |
| Native code in browser bundles | `meta`, `server`, `react`, `next` and `client` never import sharp or Node built-ins. | `tests/boundaries.test.ts`, `scripts/check-dist.mjs` |

## What it does not do

- **Authentication and authorisation.** pixstack does not know who may upload or see what. Check that in your route before calling `ingest()`, and use `requireSignature` for private images.
- **Rate limiting.** Encoding is CPU-heavy. Limit uploads per user in your app; `concurrency` only bounds the work of one process.
- **Content moderation.** A valid image is stored, whatever it shows.
- **libvips vulnerabilities.** Decoding is done by sharp/libvips. Keep `sharp` up to date: it is a peer dependency so you control its version.
