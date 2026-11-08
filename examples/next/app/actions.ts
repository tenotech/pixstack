"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isPixstackError } from "pixstack";
import { images } from "../lib/images";

export type UploadState = { error?: string; id?: string };

export async function upload(_prev: UploadState, form: FormData): Promise<UploadState> {
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image first." };
  try {
    const meta = await images.ingest(file); // validated from its bytes, WebP ladder stored
    // AVIF after the response. complete() rewrites meta.json; an app that keeps the
    // meta or the ref in its database saves the returned value here.
    after(async () => {
      await images.complete(meta);
      revalidatePath("/");
    });
    revalidatePath("/");
    return { id: meta.id };
  } catch (err) {
    if (isPixstackError(err)) return { error: `${err.code}: ${err.message}` };
    throw err;
  }
}
