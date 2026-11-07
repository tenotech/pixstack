/**
 * pixstack/meta — the ImageMeta contract shared by every module.
 * Pure and dependency-free: safe to import from browsers, edge runtimes and React.
 */

export type SourceFormat = "jpeg" | "png" | "webp" | "avif" | "heif" | "gif" | "tiff" | "svg";
export type OutputFormat = "avif" | "webp";

export interface Variant {
  /** Storage key, e.g. "img/k3j2…/640.webp". */
  key: string;
  format: OutputFormat;
  width: number;
  height: number;
  bytes: number;
}

export interface ImageMeta {
  v: 1;
  /** 16-char base32 prefix of the SHA-256 of the original bytes. */
  id: string;
  /** Dimensions after EXIF orientation. */
  width: number;
  height: number;
  format: SourceFormat;
  /** Size of the original upload in bytes. */
  bytes: number;
  alpha: boolean;
  animated: boolean;
  /** Dominant colour, "#rrggbb". */
  color: string;
  /** Base64 thumbhash (https://evanw.github.io/thumbhash/). */
  thumbhash: string;
  /** Sorted by width ascending, then format (avif before webp). */
  variants: Variant[];
  /** Storage key of the kept original, if any (private). */
  original?: string;
  /**
   * Formats still to be produced by `complete()` (after ingest with `defer`).
   * Optional and additive (since 0.2): absent means the image is complete.
   */
  pending?: OutputFormat[];
  alt?: string;
}

export const DEFAULT_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;

export const OUTPUT_MIME: Record<OutputFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
};

export const FORMAT_ORDER: Record<OutputFormat, number> = { avif: 0, webp: 1 };

/** id is 16 chars of RFC 4648 base32, lower-cased. */
export const ID_PATTERN = /^[a-z2-7]{16}$/;

/** Public variant keys: img/<id>/<width>.<format> */
export const VARIANT_KEY_PATTERN = /^img\/([a-z2-7]{16})\/([1-9][0-9]{0,4})\.(avif|webp)$/;

/** Private originals: orig/<id>.<ext> */
export const ORIGINAL_KEY_PATTERN = /^orig\/([a-z2-7]{16})\.(jpg|png|webp|avif|heic|gif|tiff|svg)$/;

export function variantKey(id: string, width: number, format: OutputFormat): string {
  return `img/${id}/${width}.${format}`;
}

/**
 * The widths to produce for a source of `sourceWidth` px.
 * Steps above the source are dropped (never upscale). The source width itself
 * is added when it is more than 10% wider than the last step that fits, so a
 * 1945px image gets …1920 (not 1920 + a near-duplicate 1945) while a 1000px
 * image after the 640 step still gets its full 1000px.
 */
export function widthLadder(sourceWidth: number, widths: readonly number[] = DEFAULT_WIDTHS): number[] {
  const sorted = [...new Set(widths)].filter((w) => w > 0).sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] ?? sourceWidth;
  const out = sorted.filter((w) => w <= sourceWidth);
  const cap = Math.min(sourceWidth, max);
  const last = out[out.length - 1];
  if (last === undefined || cap > last * 1.1) out.push(cap);
  return out;
}

/** Variants of one format, ascending by width. */
export function variantsOf(meta: ImageMeta, format: OutputFormat): Variant[] {
  return meta.variants.filter((v) => v.format === format).sort((a, b) => a.width - b.width);
}

/** Formats present in the meta, best first. */
export function formatsOf(meta: ImageMeta): OutputFormat[] {
  return [...new Set(meta.variants.map((v) => v.format))].sort((a, b) => FORMAT_ORDER[a] - FORMAT_ORDER[b]);
}

export type UrlFor = (key: string) => string;

/** Default URL builder: "/img/<id>/<w>.<f>" for variants. */
export const defaultUrlFor: UrlFor = (key) => `/${key}`;

/** Build a srcset string for one format. */
export function srcSet(meta: ImageMeta, format: OutputFormat, urlFor: UrlFor = defaultUrlFor): string {
  return variantsOf(meta, format)
    .map((v) => `${urlFor(v.key)} ${v.width}w`)
    .join(", ");
}

/**
 * The smallest variant at least `targetWidth` wide (or the largest available).
 * Use for fixed-size contexts: og:image, emails, `src` fallback.
 */
export function pickVariant(meta: ImageMeta, targetWidth: number, format?: OutputFormat): Variant | undefined {
  const fmt = format ?? (meta.variants.some((v) => v.format === "webp") ? "webp" : formatsOf(meta)[0]);
  if (!fmt) return undefined;
  const list = variantsOf(meta, fmt);
  return list.find((v) => v.width >= targetWidth) ?? list[list.length - 1];
}

/** Type guard for values read back from a JSON column. */
export function isImageMeta(value: unknown): value is ImageMeta {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<ImageMeta>;
  return (
    m.v === 1 &&
    typeof m.id === "string" &&
    ID_PATTERN.test(m.id) &&
    typeof m.width === "number" &&
    typeof m.height === "number" &&
    Array.isArray(m.variants)
  );
}
