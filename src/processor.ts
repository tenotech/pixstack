import { createHash } from "node:crypto";
import type { Metadata, Sharp, SharpOptions } from "sharp";
import { rgbaToThumbHash, thumbHashToAverageRGBA } from "thumbhash";
import { PixstackError } from "./errors.js";
import {
  DEFAULT_WIDTHS,
  FORMAT_ORDER,
  ID_PATTERN,
  OUTPUT_MIME,
  variantKey,
  widthLadder,
  type ImageMeta,
  type OutputFormat,
  type SourceFormat,
  type Variant,
} from "./meta.js";
import type { Storage } from "./storage/types.js";
import { base32, createLimiter, readAll, toBytes, type ImageInput } from "./util.js";

export interface WebpSettings {
  quality?: number;
  effort?: number;
  smartSubsample?: boolean;
  alphaQuality?: number;
  lossless?: boolean;
}

export interface AvifSettings {
  quality?: number;
  effort?: number;
  chromaSubsampling?: "4:2:0" | "4:4:4";
}

export interface ProcessorOptions {
  storage: Storage;
  /** Target widths in px. Default: 320, 640, 960, 1280, 1920, 2560. */
  widths?: readonly number[];
  /** Output formats, best first. Default: ["avif", "webp"]. */
  formats?: readonly OutputFormat[];
  webp?: WebpSettings;
  avif?: AvifSettings;
  /** Max upload size in bytes. Default 25 MB. */
  maxBytes?: number;
  /** Max decoded pixels (width × height × frames). Default 50 MP. */
  maxPixels?: number;
  /** Max width or height in px. Default 12 000. */
  maxDimension?: number;
  /** Accept SVG (rasterised). Default false. */
  allowSvg?: boolean;
  /** Animated GIF/WebP handling. Default "first-frame". */
  animated?: "first-frame" | "keep" | "reject";
  /** Keep the original under orig/ (private) for later reprocessing. Default true. */
  keepOriginal?: boolean;
  /** Return the stored meta when the same bytes were already ingested. Default true. */
  dedupe?: boolean;
  /**
   * Formats to leave out of `ingest()` and produce later with `complete()`.
   * Default [] (everything at upload). ["avif"] makes uploads ~3× faster but
   * needs a second save of the meta once `complete()` resolves.
   */
  defer?: readonly OutputFormat[];
  /** Max concurrent ingests in this processor. Default 2. */
  concurrency?: number;
  /** Max concurrent `complete()` jobs. Default 1, so background work never starves uploads. */
  backgroundConcurrency?: number;
}

export type IngestOverrides = Partial<Omit<ProcessorOptions, "storage" | "concurrency" | "backgroundConcurrency">>;

export interface ImageProcessor {
  /** Validate, encode the width ladder, store everything, return the meta. */
  ingest(input: ImageInput, overrides?: IngestOverrides): Promise<ImageMeta>;
  /**
   * Encode the formats listed in `meta.pending` (from `defer`) using the kept
   * original, store them and return the completed meta. Idempotent: returns the
   * meta unchanged when nothing is pending. Safe to call after a restart.
   */
  complete(meta: ImageMeta): Promise<ImageMeta>;
  /** Re-encode from the kept original (e.g. after changing widths/formats/quality). */
  reprocess(meta: ImageMeta, overrides?: IngestOverrides): Promise<ImageMeta>;
  /** Delete all variants, the meta file and the original. */
  remove(meta: ImageMeta | string): Promise<void>;
  /** Read the stored meta for an id (written at ingest time). */
  getMeta(id: string): Promise<ImageMeta | null>;
}

const DEFAULT_WEBP: Required<Omit<WebpSettings, "alphaQuality" | "lossless">> = {
  quality: 78,
  effort: 4,
  smartSubsample: true,
};
const DEFAULT_AVIF: Required<AvifSettings> = { quality: 52, effort: 4, chromaSubsampling: "4:2:0" };

const ORIGINAL_EXT: Record<SourceFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  avif: "avif",
  heif: "heic",
  gif: "gif",
  tiff: "tiff",
  svg: "svg",
};

const ORIGINAL_MIME: Record<SourceFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heif: "image/heic",
  gif: "image/gif",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

type SharpFactory = typeof import("sharp").default;
let sharpPromise: Promise<SharpFactory> | undefined;
/** sharp is an optional peer: loaded on first ingest so `pixstack/meta` & co. never need it. */
async function loadSharp(): Promise<SharpFactory> {
  sharpPromise ??= import("sharp").then(
    (m) => (m as unknown as { default?: SharpFactory }).default ?? (m as unknown as SharpFactory),
  );
  return sharpPromise;
}

function sourceFormatOf(meta: Metadata): SourceFormat | null {
  switch (meta.format) {
    case "jpeg":
    case "png":
    case "webp":
    case "gif":
    case "tiff":
    case "svg":
      return meta.format;
    case "heif":
      return meta.compression === "av1" ? "avif" : "heif";
    default:
      return null;
  }
}

function hex(n: number): string {
  return Math.round(Math.min(1, Math.max(0, n)) * 255)
    .toString(16)
    .padStart(2, "0");
}

interface EncodeContext {
  sharp: SharpFactory;
  bytes: Uint8Array;
  inputOptions: SharpOptions;
  id: string;
  alpha: boolean;
  format: SourceFormat;
  keepAnimation: boolean;
  settings: Pick<ProcessorOptions, "webp" | "avif">;
}

interface Encoded {
  variant: Variant;
  data: Uint8Array;
}

async function encodeVariant(ctx: EncodeContext, w: number, f: OutputFormat): Promise<Encoded> {
  const { sharp, bytes, inputOptions, id, alpha, format, keepAnimation, settings } = ctx;
  let pipeline: Sharp = sharp(bytes, inputOptions)
    .rotate()
    .toColourspace("srgb")
    .resize({ width: w, withoutEnlargement: true });
  if (f === "webp") {
    const s = { ...DEFAULT_WEBP, ...settings.webp };
    const losslessArt = alpha && format === "png" && w <= 512;
    pipeline = pipeline.webp(
      losslessArt
        ? { lossless: true, effort: s.effort }
        : alpha
          ? { ...s, quality: Math.max(s.quality, 90), alphaQuality: s.alphaQuality ?? 90 }
          : s,
    );
  } else {
    const s = { ...DEFAULT_AVIF, ...settings.avif };
    pipeline = pipeline.avif(alpha ? { ...s, quality: Math.max(s.quality, 64) } : s);
  }
  let out;
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (cause) {
    const msg = String((cause as Error)?.message ?? cause);
    if (/pixel limit/i.test(msg)) throw new PixstackError("TOO_MANY_PIXELS", msg, { cause });
    throw new PixstackError("DECODE_FAILED", "Image could not be decoded", { cause });
  }
  const outHeight = keepAnimation ? (out.info.pageHeight ?? out.info.height) : out.info.height;
  return {
    variant: { key: variantKey(id, w, f), format: f, width: out.info.width, height: outHeight, bytes: out.info.size },
    data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength),
  };
}

/**
 * The id `ingest()` gives these bytes (16-char base32 SHA-256 prefix), without
 * processing anything. Use it to recognise a known file, e.g. "is this stored
 * image one of our seed photos?".
 */
export function computeImageId(bytes: Uint8Array): string {
  return base32(createHash("sha256").update(bytes).digest()).slice(0, 16);
}

export function createImageProcessor(options: ProcessorOptions): ImageProcessor {
  const { storage } = options;
  const limit = createLimiter(options.concurrency ?? 2);
  const background = createLimiter(options.backgroundConcurrency ?? 1);

  const metaKey = (id: string) => `img/${id}/meta.json`;

  async function getMeta(id: string): Promise<ImageMeta | null> {
    if (!ID_PATTERN.test(id)) return null;
    const obj = await storage.get(metaKey(id));
    if (!obj) return null;
    try {
      return JSON.parse(new TextDecoder().decode(await readAll(obj.body))) as ImageMeta;
    } catch {
      return null;
    }
  }

  async function run(bytes: Uint8Array, o: ProcessorOptions & IngestOverrides): Promise<ImageMeta> {
    const maxBytes = o.maxBytes ?? 25 * 1024 * 1024;
    const maxPixels = o.maxPixels ?? 50_000_000;
    const maxDimension = o.maxDimension ?? 12_000;
    const animatedMode = o.animated ?? "first-frame";
    const formats = [...new Set(o.formats ?? (["avif", "webp"] as const))].sort(
      (a, b) => FORMAT_ORDER[a] - FORMAT_ORDER[b],
    );

    if (bytes.byteLength === 0) throw new PixstackError("EMPTY", "Empty file");
    if (bytes.byteLength > maxBytes) {
      throw new PixstackError("TOO_LARGE", `File is ${bytes.byteLength} bytes (max ${maxBytes})`);
    }

    const sharp = await loadSharp();

    // 1. Sniff from the bytes. sharp reads only the header here.
    let info: Metadata;
    try {
      info = await sharp(bytes, { limitInputPixels: false }).metadata();
    } catch (cause) {
      throw new PixstackError("DECODE_FAILED", "Not a readable image", { cause });
    }
    const format = sourceFormatOf(info);
    if (!format) throw new PixstackError("UNSUPPORTED_FORMAT", `Unsupported format: ${info.format ?? "unknown"}`);
    if (format === "svg" && !o.allowSvg) throw new PixstackError("SVG_NOT_ALLOWED", "SVG uploads are disabled");

    const rawW = info.width ?? 0;
    const rawH = info.pageHeight ?? info.height ?? 0;
    if (!rawW || !rawH) throw new PixstackError("DECODE_FAILED", "Image has no dimensions");
    if (rawW > maxDimension || rawH > maxDimension) {
      throw new PixstackError("TOO_WIDE", `Image is ${rawW}×${rawH} (max ${maxDimension} per side)`);
    }

    const frames = info.pages ?? 1;
    const animated = frames > 1 && (format === "gif" || format === "webp");
    if (animated && animatedMode === "reject") {
      throw new PixstackError("ANIMATED_NOT_ALLOWED", "Animated images are not accepted");
    }
    const keepAnimation = animated && animatedMode === "keep";
    const pixels = rawW * rawH * (keepAnimation ? frames : 1);
    if (pixels > maxPixels) {
      throw new PixstackError("TOO_MANY_PIXELS", `Image has ${pixels} pixels (max ${maxPixels})`);
    }

    // EXIF orientations 5–8 swap axes.
    const rotated = (info.orientation ?? 1) >= 5;
    const width = rotated ? rawH : rawW;
    const height = rotated ? rawW : rawH;

    // 2. Identity.
    const id = computeImageId(bytes);
    if (o.dedupe ?? true) {
      const existing = await getMeta(id);
      if (existing) return existing;
    }

    // 3. Encode now; deferred formats come later via complete().
    const inputOptions: SharpOptions = {
      limitInputPixels: maxPixels,
      failOn: "error",
      ...(keepAnimation ? { animated: true } : { pages: 1 }),
    };
    const alpha = Boolean(info.hasAlpha);
    const keepOriginal = o.keepOriginal ?? true;
    const allFormats: OutputFormat[] = keepAnimation ? ["webp"] : formats;
    const deferred = keepAnimation ? [] : allFormats.filter((f) => o.defer?.includes(f));
    const immediate = allFormats.filter((f) => !deferred.includes(f));
    if (immediate.length === 0) throw new TypeError("pixstack: `defer` must leave at least one format for ingest()");
    if (deferred.length > 0 && !keepOriginal) throw new TypeError("pixstack: `defer` requires keepOriginal: true");

    const ladder = widthLadder(width, o.widths ?? DEFAULT_WIDTHS);
    const ctx: EncodeContext = { sharp, bytes, inputOptions, id, alpha, format, keepAnimation, settings: o };
    const encoded: Encoded[] = [];
    for (const w of ladder) for (const f of immediate) encoded.push(await encodeVariant(ctx, w, f));

    // 4. Placeholder + colour from one ≤100px decode.
    const thumb = await sharp(bytes, { ...inputOptions, animated: false, pages: 1 })
      .rotate()
      .toColourspace("srgb")
      .resize(100, 100, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hash = rgbaToThumbHash(thumb.info.width, thumb.info.height, thumb.data);
    const avg = thumbHashToAverageRGBA(hash);
    const thumbhash = Buffer.from(hash).toString("base64");
    const color = `#${hex(avg.r)}${hex(avg.g)}${hex(avg.b)}`;

    // 5. Store.
    const originalKey = keepOriginal ? `orig/${id}.${ORIGINAL_EXT[format]}` : undefined;

    const meta: ImageMeta = {
      v: 1,
      id,
      width,
      height,
      format,
      bytes: bytes.byteLength,
      alpha,
      animated: keepAnimation,
      color,
      thumbhash,
      variants: encoded
        .map((e) => e.variant)
        .sort((a, b) => a.width - b.width || FORMAT_ORDER[a.format] - FORMAT_ORDER[b.format]),
      ...(originalKey ? { original: originalKey } : {}),
      ...(deferred.length > 0 ? { pending: deferred } : {}),
    };

    await Promise.all([
      ...encoded.map(putVariant),
      originalKey
        ? storage.put(originalKey, bytes, { contentType: ORIGINAL_MIME[format], visibility: "private" })
        : Promise.resolve(),
    ]);
    // Written last: its presence means the image is usable (used by dedupe).
    await putMeta(meta);
    return meta;
  }

  function putVariant(e: Encoded) {
    return storage.put(e.variant.key, e.data, { contentType: OUTPUT_MIME[e.variant.format], visibility: "public" });
  }

  function putMeta(meta: ImageMeta) {
    return storage.put(metaKey(meta.id), new TextEncoder().encode(JSON.stringify(meta)), {
      contentType: "application/json",
      visibility: "public",
    });
  }

  async function completeNow(given: ImageMeta): Promise<ImageMeta> {
    // Another worker (or an earlier call) may have finished it already.
    const current = (await getMeta(given.id)) ?? given;
    const pending = current.pending ?? [];
    if (pending.length === 0) return current;
    if (!current.original) throw new PixstackError("NO_ORIGINAL", `Image ${current.id} has no kept original`);
    const obj = await storage.get(current.original);
    if (!obj) throw new PixstackError("NO_ORIGINAL", `Original ${current.original} is missing`);

    const ctx: EncodeContext = {
      sharp: await loadSharp(),
      bytes: await readAll(obj.body),
      inputOptions: { limitInputPixels: options.maxPixels ?? 50_000_000, failOn: "error", pages: 1 },
      id: current.id,
      alpha: current.alpha,
      format: current.format,
      keepAnimation: false,
      settings: options,
    };
    // Same ladder as the immediate formats, read from their keys ("img/<id>/<w>.<f>").
    const widths = [...new Set(current.variants.map((v) => Number(/\/(\d+)\.\w+$/.exec(v.key)![1])))];
    const encoded: Encoded[] = [];
    for (const w of widths) for (const f of pending) encoded.push(await encodeVariant(ctx, w, f));
    await Promise.all(encoded.map(putVariant));

    const { pending: _done, ...rest } = current;
    const next: ImageMeta = {
      ...rest,
      variants: [...current.variants.filter((v) => !pending.includes(v.format)), ...encoded.map((e) => e.variant)].sort(
        (a, b) => a.width - b.width || FORMAT_ORDER[a.format] - FORMAT_ORDER[b.format],
      ),
    };
    await putMeta(next);
    return next;
  }

  return {
    getMeta,

    complete(meta) {
      if (!meta.pending?.length) return Promise.resolve(meta);
      return background(() => completeNow(meta));
    },

    ingest(input, overrides) {
      return limit(async () => run(await toBytes(input), { ...options, ...overrides }));
    },

    reprocess(meta, overrides) {
      return limit(async () => {
        if (!meta.original) throw new PixstackError("NO_ORIGINAL", `Image ${meta.id} has no kept original`);
        const obj = await storage.get(meta.original);
        if (!obj) throw new PixstackError("NO_ORIGINAL", `Original ${meta.original} is missing`);
        const next = await run(await readAll(obj.body), {
          ...options,
          ...overrides,
          dedupe: false,
          // It was accepted once; don't let a later allowSvg=false strand it.
          ...(meta.format === "svg" ? { allowSvg: true } : {}),
        });
        // Remove variants the new settings no longer produce (written-then-pruned, so no 404 gap).
        const keep = new Set(next.variants.map((v) => v.key));
        await Promise.all(meta.variants.filter((v) => !keep.has(v.key)).map((v) => storage.delete(v.key)));
        return next;
      });
    },

    async remove(metaOrId) {
      const id = typeof metaOrId === "string" ? metaOrId : metaOrId.id;
      if (!ID_PATTERN.test(id)) throw new PixstackError("INVALID_KEY", `Invalid image id: ${id}`);
      const meta = typeof metaOrId === "string" ? await getMeta(id) : metaOrId;
      await storage.deletePrefix(`img/${id}/`);
      if (meta?.original) await storage.delete(meta.original);
    },
  };
}
