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

// ── Image refs ─────────────────────────────────────────────────────────────
//
// An ImageRef packs what rendering needs into one URL string, for apps that
// store images in existing string columns instead of a JSON column:
//
//   /img/<id>/1280.webp?pv=1&w=1945&h=809&l=320.640.960.1280.1920&f=aw&s=j&c=a38668&t=<thumbhash>
//
// The path is a real variant, so code that treats the ref as a plain URL
// (an <img src>, an e-mail, og:image) still shows the image. Parsing is strict
// because refs are read back from the database: anything odd returns null.
// A parsed ref has no per-variant byte sizes (bytes = 0) and no `original`;
// the full meta stays in storage (`processor.getMeta(id)`).

const FORMAT_CODE: Record<OutputFormat, string> = { avif: "a", webp: "w" };
const CODE_FORMAT: Record<string, OutputFormat> = { a: "avif", w: "webp" };
const SOURCE_CODE: Record<SourceFormat, string> = {
  jpeg: "j", png: "p", webp: "w", avif: "a", heif: "h", gif: "g", tiff: "t", svg: "s",
};
const CODE_SOURCE: Record<string, SourceFormat> = Object.fromEntries(
  Object.entries(SOURCE_CODE).map(([k, v]) => [v, k as SourceFormat]),
);

const REF_PATH = /(?:^|\/)img\/([a-z2-7]{16})\/([1-9][0-9]{0,4})\.(avif|webp)\?(.+)$/;

const toB64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64Url = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
};

/** Encode a meta as a ref string. `urlFor` sets the URL base (default "/img/…"). */
export function toImageRef(meta: ImageMeta, urlFor: UrlFor = defaultUrlFor): string {
  const fallback = pickVariant(meta, 1280);
  if (!fallback) throw new Error(`ImageMeta ${meta.id} has no variants`);
  const widths = [...new Set(meta.variants.map((v) => Number(/\/(\d+)\.\w+$/.exec(v.key)![1])))].sort((a, b) => a - b);
  const q = new URLSearchParams({
    pv: "1",
    w: String(meta.width),
    h: String(meta.height),
    l: widths.join("."),
    f: formatsOf(meta).map((f) => FORMAT_CODE[f]).join(""),
    s: SOURCE_CODE[meta.format],
    c: meta.color.replace(/^#/, ""),
    t: toB64Url(meta.thumbhash),
  });
  if (meta.alpha) q.set("a", "1");
  if (meta.animated) q.set("n", "1");
  if (meta.pending?.length) q.set("p", meta.pending.map((f) => FORMAT_CODE[f]).join(""));
  return `${urlFor(fallback.key)}?${q.toString()}`;
}

export interface ParsedImageRef {
  meta: ImageMeta;
  /** Everything before "img/<id>/…" in the ref, e.g. "/" or "https://cdn.example.com/". */
  base: string;
}

/** Decode a ref string. Returns null for anything that isn't a well-formed ref. */
export function parseImageRef(ref: unknown): ParsedImageRef | null {
  if (typeof ref !== "string" || ref.length > 2048) return null;
  const m = REF_PATH.exec(ref);
  if (!m) return null;
  const [whole, id, , , query] = m as unknown as [string, string, string, string, string];
  const q = new URLSearchParams(query);
  if (q.get("pv") !== "1") return null;

  const width = Number(q.get("w"));
  const height = Number(q.get("h"));
  const ok = (n: number) => Number.isInteger(n) && n > 0 && n <= 100_000;
  if (!ok(width) || !ok(height)) return null;

  const widths = (q.get("l") ?? "").split(".").map(Number);
  if (widths.length === 0 || widths.length > 24 || !widths.every((w) => ok(w) && w <= width)) return null;

  const formats = [...(q.get("f") ?? "")].map((c) => CODE_FORMAT[c]);
  const pending = [...(q.get("p") ?? "")].map((c) => CODE_FORMAT[c]);
  if (formats.length === 0 || formats.includes(undefined as never) || pending.includes(undefined as never)) return null;

  const format = CODE_SOURCE[q.get("s") ?? ""];
  const color = q.get("c") ?? "";
  const thumb = q.get("t") ?? "";
  if (!format || !/^[0-9a-f]{6}$/.test(color) || !/^[A-Za-z0-9_-]{4,64}$/.test(thumb)) return null;

  const variants: Variant[] = widths.flatMap((w) =>
    (formats as OutputFormat[]).map((f) => ({
      key: variantKey(id, w, f),
      format: f,
      width: w,
      height: Math.max(1, Math.round((w * height) / width)),
      bytes: 0,
    })),
  );
  variants.sort((a, b) => a.width - b.width || FORMAT_ORDER[a.format] - FORMAT_ORDER[b.format]);

  const meta: ImageMeta = {
    v: 1,
    id,
    width,
    height,
    format,
    bytes: 0,
    alpha: q.get("a") === "1",
    animated: q.get("n") === "1",
    color: `#${color}`,
    thumbhash: fromB64Url(thumb),
    variants,
    ...(pending.length ? { pending: pending as OutputFormat[] } : {}),
  };
  return { meta, base: ref.slice(0, ref.length - whole.length + (whole.startsWith("/") ? 1 : 0)) };
}

/**
 * True when `value` is a well-formed ref string. A plain boolean, not a type
 * guard: the values tested are usually already `string`, and a `value is string`
 * guard would narrow the other branch (a legacy URL) to `never`.
 */
export function isImageRef(value: unknown): boolean {
  return parseImageRef(value) !== null;
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
