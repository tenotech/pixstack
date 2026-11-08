# pixstack + Next.js (App Router)

```bash
pnpm build            # in the repo root, once: then `pnpm install` here again after each rebuild
cd examples/next
pnpm install
pnpm dev              # http://localhost:3000
```

| File | What it shows |
|---|---|
| `lib/images.ts` | Storage + processor, created once (`server-only`) |
| `app/actions.ts` | Server Action: `ingest()` (WebP now), `complete()` in `after()` (AVIF after the response), typed errors |
| `app/upload-form.tsx` | `prepareUpload()` from `pixstack/client`: shrinks photos in the browser before sending |
| `app/img/[...key]/route.ts` | Serving the variants (immutable, ETag, Range) |
| `app/page.tsx` | `<Img>` with `priority` on the first image; the same image through `next/image` |
| `image-loader.ts` + `next.config.ts` | The `pixstack/next` loader, for code that keeps `next/image` |

The list comes from the storage itself to keep the example free of a database. A real app saves the meta (JSON column) or `toImageRef(meta)` (string column) on its record.
