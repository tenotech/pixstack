# pixstack + Hono

Upload, serve and render with [Hono](https://hono.dev) on Node.

```bash
pnpm build            # in the repo root, once: then `pnpm install` here again after each rebuild
cd examples/hono
pnpm install
pnpm start            # http://localhost:3000
```

- `POST /upload` (form field `image`) ingests the file: WebP right away, AVIF in the background. It answers `{ id, ref }`, or a typed error with a 4xx status.
- `GET /img/*` serves the variants with immutable caching, ETag and Range.
- `/` lists the uploads with `<picture>` (AVIF + WebP srcset) and the dominant colour as a placeholder.

The list lives in memory to keep the example short. A real app stores the meta (a JSON column) or the ref (a string column) with its record.
