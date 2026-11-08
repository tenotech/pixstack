/**
 * pixstack/client — shrink photos in the browser before upload. The server
 * never serves anything wider than its largest ladder step (2560 px), so a
 * 4000 px phone photo is mostly wasted upload time on a mobile connection.
 *
 *   const { file } = await prepareUpload(input.files[0]);
 *   form.append("image", file);
 *
 * The server still validates and re-encodes everything: this is a speed-up,
 * not a security boundary. No imports, no Node APIs.
 *
 * Expo / React Native has no canvas: compute the size with `targetSize()` and
 * hand it to expo-image-manipulator:
 *
 *   const size = targetSize(asset.width, asset.height);
 *   if (size.resized) await manipulateAsync(asset.uri, [{ resize: size }], { compress: 0.9 });
 */

export interface PrepareUploadOptions {
  /** Longest side allowed, in px. Default 2560 (the largest default ladder width). */
  maxSize?: number;
  /** Re-encode files within `maxSize` only when larger than this. Default 4 MB. */
  maxBytes?: number;
  /** Encoder quality, 0–1. Default 0.9: the server re-encodes, so this is only a near-lossless intermediate. */
  quality?: number;
}

export interface PreparedUpload {
  /** The file to upload: the input itself when nothing was gained. A `File` when the input was one. */
  file: Blob;
  /** True when the file was re-encoded. */
  changed: boolean;
  /** Decoded size of the uploaded file, when the browser could decode it. */
  width?: number;
  height?: number;
}

export interface TargetSize {
  width: number;
  height: number;
  resized: boolean;
}

const DEFAULT_MAX_SIZE = 2560;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUALITY = 0.9;

/** Fit `width × height` inside a `maxSize` square, keeping the aspect ratio. Never upscales. */
export function targetSize(width: number, height: number, maxSize = DEFAULT_MAX_SIZE): TargetSize {
  const longest = Math.max(width, height);
  if (!(longest > maxSize)) return { width, height, resized: false };
  const scale = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

// Types the browser decodes to one frame without losing anything that matters.
// GIF (animation) and SVG (vector) go up untouched; HEIC fails to decode in most
// browsers and goes up untouched too (the server reads it).
const RE_ENCODABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp", "image/heic", "image/heif"]);
const MAY_HAVE_ALPHA = new Set(["image/png", "image/webp", "image/avif"]);

type Canvas2D = {
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: "low" | "medium" | "high";
};

async function encode(bitmap: ImageBitmap, width: number, height: number, type: string, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d") as unknown as Canvas2D | null;
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality });
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d") as unknown as Canvas2D | null;
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };

function rename(original: Blob, blob: Blob): Blob {
  if (typeof File === "undefined" || !(original instanceof File)) return blob;
  const ext = EXT[blob.type] ?? "bin";
  const name = original.name.replace(/\.[^.]*$/, "") || "image";
  return new File([blob], `${name}.${ext}`, { type: blob.type, lastModified: original.lastModified });
}

/**
 * Downscale (and re-encode when it pays) a photo before upload. Returns the
 * input untouched when it is already small enough, when the browser cannot
 * decode it, or when re-encoding would not make it smaller. Also drops EXIF
 * (location included), since a canvas never carries metadata.
 */
export async function prepareUpload(input: Blob, options: PrepareUploadOptions = {}): Promise<PreparedUpload> {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const untouched = (w?: number, h?: number): PreparedUpload => ({
    file: input,
    changed: false,
    ...(w ? { width: w, height: h } : {}),
  });

  if (!RE_ENCODABLE.has(input.type) || typeof createImageBitmap === "undefined") return untouched();

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input, { imageOrientation: "from-image" });
  } catch {
    return untouched(); // HEIC in most browsers, or a broken file: the server decides.
  }
  try {
    const size = targetSize(bitmap.width, bitmap.height, maxSize);
    if (!size.resized && input.size <= maxBytes) return untouched(bitmap.width, bitmap.height);

    let out: Blob | null = null;
    if (MAY_HAVE_ALPHA.has(input.type)) {
      out = await encode(bitmap, size.width, size.height, "image/webp", quality);
      // Older Safari cannot encode WebP and silently returns PNG: keep it, it is lossless.
      if (out && out.type !== "image/webp" && out.type !== "image/png") out = null;
    } else {
      out = await encode(bitmap, size.width, size.height, "image/jpeg", quality);
    }
    if (!out || (!size.resized && out.size >= input.size)) return untouched(bitmap.width, bitmap.height);
    return { file: rename(input, out), changed: true, width: size.width, height: size.height };
  } finally {
    bitmap.close();
  }
}
