# pixstack

A self-hosted image pipeline, published as one npm package (`pixstack`) with subpath exports. **This repo is public.**

Read first: `docs/design.md` (contract and defaults), `docs/architecture.md`, `docs/roadmap.md` (what's next).

## Layout

- `src/meta.ts`: `ImageMeta` contract plus pure helpers. **No imports** besides types. It's safe for browsers and edge runtimes.
- `src/processor.ts`: `createImageProcessor` (the only file that uses sharp, loaded lazily).
- `src/storage/`: `Storage` interface, `diskStorage`, `memoryStorage`, and `s3.ts` (its own subpath, `pixstack/storage/s3`, so the AWS SDK is never pulled into disk users). Every driver must call `assertSafeKey` and pass the shared suite in `tests/storage.test.ts`.
- S3 tests: start `adobe/s3mock:4.7.0` (see `tests/helpers.ts`), then run with `PIXSTACK_S3_ENDPOINT=http://localhost:19090`. Without that variable they are skipped.
- `src/server.ts`: Web-standard handler and signed URLs (Web Crypto only, no `node:` imports).
- `src/react.tsx`: `<Img>` / `getImageProps`. Imports only `meta`, `thumbhash` and `react-preload.tsx` (the `"use client"` preload, built as its own file, see `tsup.config.ts`).
- `src/next.ts` (`next/image` loader) and `src/client.ts` (`prepareUpload`): browser-safe, `meta` only.
- `src/node.ts`: Node `http` / Express adapter. `src/cli.ts` (logic, tested) + `src/bin.ts` (the `pixstack` bin).
- `scripts/bench.mjs`: bytes/SSIM benchmark on a folder of photos. `scripts/check-dist.mjs`: checks the build (exports exist, browser bundles clean, `"use client"` kept).
- `examples/next`, `examples/hono`: installed against the local build, built in CI.
- `tests/`: vitest. Test images are generated with sharp in `tests/helpers.ts`, so no binary fixtures.

## Rules

- Nothing private in tracked files: no client or project names, local paths or people. Private notes go in the gitignored `.private/`. `pnpm check:private` enforces this from `.private/denylist.txt`.
- `meta`, `server`, `react`, `next` and `client` must never import `processor` or `node:*` (except types). `tests/boundaries.test.ts` and `check:dist` enforce it.
- Releases: bump `package.json`, add a `CHANGELOG.md` section, push a `v<version>` tag (`.github/workflows/release.yml` publishes).
- Changing `ImageMeta` means bumping `v` and adding a migration. Never change v1 fields silently.
- Every new default (quality, width, limit) needs a reason written in the `docs/design.md` table.
- Security-relevant behaviour (key validation, served types, signatures) needs a test.
- `pnpm check` must pass before a change is done.
