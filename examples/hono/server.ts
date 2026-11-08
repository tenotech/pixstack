// pixstack + Hono on Node: upload, serve, render. Run: pnpm install && pnpm start
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createImageProcessor, isPixstackError, srcSet, toImageRef, type ImageMeta } from "pixstack";
import { createImageHandler } from "pixstack/server";
import { diskStorage } from "pixstack/storage";

const storage = diskStorage({ root: process.env.MEDIA_DIR ?? "./media" });
// WebP at upload (fast), AVIF in the background.
const images = createImageProcessor({ storage, defer: ["avif"] });
const serveImage = createImageHandler({ storage });

// A real app keeps these in its database (a JSON column, or the ref string).
const gallery: ImageMeta[] = [];

const app = new Hono();

app.post("/upload", bodyLimit({ maxSize: 25 * 1024 * 1024 }), async (c) => {
  const body = await c.req.parseBody();
  const file = body.image;
  if (!(file instanceof File)) return c.json({ error: "send the image in a form field named 'image'" }, 400);
  try {
    const meta = await images.ingest(file);
    gallery.unshift(meta);
    // Finish AVIF after answering, then save the completed meta (here: replace it in the list).
    void images
      .complete(meta)
      .then((done) => gallery.splice(gallery.findIndex((m) => m.id === done.id), 1, done))
      .catch((err) => console.error("complete failed", err));
    return c.json({ id: meta.id, ref: toImageRef(meta) }, 201);
  } catch (err) {
    // Typed errors map to a 4xx: TOO_LARGE 413, UNSUPPORTED_FORMAT 415, …
    if (isPixstackError(err)) return c.json({ error: err.code, message: err.message }, err.status as 400);
    throw err;
  }
});

app.on(["GET", "HEAD"], "/img/*", (c) => serveImage(c.req.raw));

app.get("/", (c) => {
  const items = gallery
    .map((m) => {
      const avif = m.variants.some((v) => v.format === "avif")
        ? `<source type="image/avif" srcset="${srcSet(m, "avif")}" sizes="300px">`
        : "";
      return `<picture>${avif}<img src="/${m.variants.find((v) => v.format === "webp")!.key}" srcset="${srcSet(m, "webp")}"
        sizes="300px" width="300" height="${Math.round((300 * m.height) / m.width)}" loading="lazy" decoding="async"
        style="background:${m.color};object-fit:cover" alt=""></picture>`;
    })
    .join("\n");
  return c.html(`<!doctype html><meta charset="utf-8"><title>pixstack + Hono</title>
<form method="post" action="/upload" enctype="multipart/form-data" onsubmit="event.preventDefault();
  fetch(this.action,{method:'POST',body:new FormData(this)}).then(r=>r.json()).then(j=>j.error?alert(j.error):location.reload())">
  <input type="file" name="image" accept="image/*" required> <button>Upload</button>
</form>
<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px">${items || "<p>No images yet.</p>"}</div>`);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`http://localhost:${port}`);
