import "server-only";
import { createImageProcessor, type ImageMeta } from "pixstack";
import { diskStorage } from "pixstack/storage";

export const storage = diskStorage({ root: process.env.MEDIA_DIR ?? "./media" });
export const images = createImageProcessor({ storage, defer: ["avif"] });

/**
 * Every stored image, newest first. A real app reads its own records (a JSON
 * column holding the meta, or a string column holding the ref); listing the
 * storage keeps this example free of a database.
 */
export async function allImages(): Promise<ImageMeta[]> {
  const found: { id: string; mtime: Date }[] = [];
  for await (const o of storage.list!("img/")) {
    if (o.key.endsWith("/meta.json")) found.push({ id: o.key.split("/")[1]!, mtime: o.mtime });
  }
  found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const metas = await Promise.all(found.map((f) => images.getMeta(f.id)));
  return metas.filter((m): m is ImageMeta => m !== null);
}
