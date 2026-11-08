# Adopting pixstack in an existing app

This guide is for an app that already handles uploads itself: `sharp` at upload time, URLs saved in `imageUrl`-style **string columns**, and `next/image` doing the resizing. It follows the first production migration, a Next.js App Router storefront running in Docker with blue-green deploys behind a shared nginx. The numbers are from that migration.

## What you gain

Measured on a production build, empty browser cache, same catalogue before and after:

| | Before (`next/image`) | After (pixstack) |
|---|---|---|
| Slowest image, first visit after a deploy, home page, mobile | 1.54 s | **0.11 s** |
| LCP, first visit, home page, mobile | 4.35 s | **0.80 s** |
| LCP, first visit, home page, desktop | 2.56 s | **0.92 s** |
| Image bytes per page | 5–88 KB | within ±10% |
| Visual difference (full-page pixel diff, 5 pages × 2 devices) | | none (< 0.5/255 mean) |

In production (shared VPS, measured the same day, empty browser cache, right after a deploy):

| | Before | After |
|---|---|---|
| LCP, home page, desktop | 6.26 s | **1.07 s** |
| Slowest image, home page, desktop | 5.95 s | **0.33 s** |
| Slowest image, product page, mobile | 2.02 s | **0.42 s** |
| Image bytes per page | 10–68 KB | within ±13% |

Warm visits are unchanged (network-bound). The difference is that a deploy no longer resets anything: the files and nginx's copy survive it.

Two causes, both removed:
- `next/image` encodes on request.
- Its cache lives inside the container, so every deploy empties it.

pixstack encodes once at upload, into a volume that survives deploys.

## The steps

### 1. Install

```sh
npm i pixstack sharp
```

Until pixstack is on npm, vendor a packed tarball (`pnpm pack` → `vendor/pixstack-x.y.z.tgz`, then `"pixstack": "file:vendor/pixstack-x.y.z.tgz"`). In Docker, `COPY vendor ./vendor` **before** `npm ci`.

### 2. A storage volume outside `public/`

```ts
// lib/images/pixstack.ts (no "server-only": seed scripts import it too)
export const MEDIA_ROOT = process.env.MEDIA_DIR ?? path.join(process.cwd(), "media");
export const mediaStorage = diskStorage({ root: MEDIA_ROOT });
export const images = createImageProcessor({
  storage: mediaStorage,
  widths: [160, 240, 320, 400, 480, 640, 800, 960, 1280, 1600, 1920], // drop steps wider than your widest slot
  concurrency: 1, // small shared VPS
});
```

Keep the root **outside `public/`**. Kept originals (`orig/`) still carry their EXIF and GPS data, and a framework that serves `public/` would expose them.

In Docker:
- add a named volume (for example `media:/app/media`) to the app service **and** to every service that runs seeds or maintenance scripts
- create the directory owned by the app user in the runtime image

Scripts that run as root (a `migrate` container) create root-owned files, and the app can no longer write next to them. Give the tree back to the app user (`chown -R <uid>`) after writing.

**Back up the new volume.** If your backup script archives the old uploads volume, add this one.

### 3. Store refs in the existing columns

```ts
export async function saveImage(file: File): Promise<string> {
  try {
    return toImageRef(await images.ingest(file));
  } catch (err) {
    if (isPixstackError(err)) throw new UploadError(messageFor(err.code)); // TOO_LARGE, SVG_NOT_ALLOWED…
    throw err;
  }
}
```

A ref (`/img/<id>/1280.webp?pv=1&w=…`, ~120–190 characters) fits any text column, so **no migration** is needed. Old values (`/uploads/…`, static files) keep working: tell them apart with `isImageRef(url)`.

Two consequences of content addressing:
- **Copying is free:** a duplicated record can reuse the same ref.
- **Deleting needs care:** another record may share the file. Make `delete(ref)` a no-op and reclaim unused files with `images.sweep({ keep })`, fed with the ids of every image column (`parseImageRef(url)?.id`). Run it with `dryRun: true` first and read the count.

### 4. Serve `/img/`

```ts
// app/img/[...key]/route.ts
const handler = createImageHandler({ storage: mediaStorage });
export const GET = handler;
export const HEAD = handler;
```

Check that your middleware matcher skips `/img/` (a `.webp`/`.avif` extension rule usually covers it already). In nginx, cache it like static files and **leave the query string out of the cache key** (the ref's query is only metadata):

```nginx
location /img/ {
    proxy_pass http://app;
    proxy_cache static_cache;
    proxy_cache_key $scheme$host$uri;   # never put signed URLs under this location
    proxy_cache_valid 200 1y;
    proxy_cache_valid 404 1m;
}
```

### 5. Render

In the component that wraps `next/image`, add a branch for refs:

```tsx
if (isImageRef(src)) {
  return (
    <Img
      image={src}
      alt={alt}
      sizes={sizes}
      priority={priority}
      className={fill ? "absolute inset-0 size-full object-cover" : undefined}
      placeholder={coversBox ? "thumbhash" : "none"}
    />
  );
}
return <Image src={src} … />; // SVGs and legacy URLs, unchanged
```

- **Placeholder only when the photo covers its box.** It paints the `<img>` background, so with `object-contain` or padding it would stay visible around the photo.
- **Never key lists by the image URL alone.** Identical photos share one URL; use `` `${index}-${url}` `` or a row id.
- Check your CSP: the placeholder needs `img-src data:` and inline style attributes.

### 6. Convert existing data

Write one function that scans every image column, finds values pointing at local raster files (`/uploads/…`, seed photos under `public/`), ingests them and writes the ref back. Make it idempotent and guard paths against traversal. Run it:
- at the end of your seed
- as an npm script for production data

Seed and reset scripts that recognised "demo" images by their URL prefix need another rule once those become refs. Compare content ids instead (`computeImageId(bytes)` against the seed files).

### 7. Verify before deploying

- Unit-test upload → ref, refused files, the route (variants 200 and immutable; `meta.json` and originals 404) and path guards.
- Build **before and after** in production mode against two throwaway databases seeded the same way. Measure from an empty cache, then compare full-page screenshots pixel by pixel.
- Run your end-to-end upload flows. The first migration found a duplicate React key this way: two variants sharing one photo.

## Gotchas found in the first migration

| Symptom | Cause | Fix |
|---|---|---|
| Pages 2× heavier than `next/image` | Sparse ladder (320/640/960…): a 300 px card downloaded the 640 px file | Default ladder is now 160…2560 in ~1.25–1.5× steps (0.3) |
| `isImageRef(x)` narrowed the else branch to `never` | Was a `value is string` type guard | Plain `boolean` since 0.3 |
| Seed crashed: "Argument `not` must not be null" | Prisma rejects `{ not: null }` on required columns | Filter `{ startsWith: "/uploads/" }` etc. instead |
| "Encountered two children with the same key" | Two rows share one ref (dedupe) | Don't key by URL alone |
| Uploads fail after running a seed in Docker | Seed ran as root; app user can't write into root-owned dirs | `chown -R` the media tree to the app user after scripts |
| The first deploy skipped the new "convert existing photos" step | The deploy script `git pull`s itself; bash keeps executing the old file | Run the conversion by hand after the first deploy (later deploys include it) |
| Seed got slower (≈ 70 s for 34 photos on a laptop) | Every seed photo is encoded once at all widths | Expected. Later runs are instant (dedupe); keep demo images when resetting |
