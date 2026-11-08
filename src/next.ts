/**
 * pixstack/next — a `next/image` loader that points at stored variants, for
 * apps that keep `next/image` instead of `<Img>`. Next's optimizer no longer
 * runs for refs: each width maps to the stored file.
 *
 *   // image-loader.ts
 *   export { default } from "pixstack/next";
 *
 *   // next.config.ts
 *   images: { loader: "custom", loaderFile: "./image-loader.ts" }
 *
 * `<Img>` is still the better choice where you can use it: a loader returns a
 * single URL per width, so it cannot offer AVIF with a WebP fallback, and
 * `next/image` adds no thumbhash placeholder.
 */
import { parseImageRef, pickVariant, type OutputFormat } from "./meta.js";

export interface NextLoaderParams {
  src: string;
  width: number;
  quality?: number;
}

export type NextLoader = (params: NextLoaderParams) => string;

export interface NextLoaderOptions {
  /**
   * Format to serve for refs. Default "webp": every browser decodes it. "avif"
   * is ~20–30% smaller but not decoded by a few percent of browsers.
   */
  format?: OutputFormat;
  /**
   * URL for anything that is not an ImageRef (static files, legacy uploads).
   * Default: `src` with `w=<width>` appended, which keeps Next's
   * "loader does not use width" check quiet and is ignored by static servers.
   */
  fallback?: NextLoader;
}

const appendWidth: NextLoader = ({ src, width }) => `${src}${src.includes("?") ? "&" : "?"}w=${width}`;

export function createNextLoader(options: NextLoaderOptions = {}): NextLoader {
  const fallback = options.fallback ?? appendWidth;
  return function pixstackLoader(params) {
    const parsed = parseImageRef(params.src);
    if (!parsed) return fallback(params);
    const { meta, base } = parsed;
    const wanted = options.format ?? "webp";
    // A deferred format (still `pending`) has no files yet.
    const format = meta.variants.some((v) => v.format === wanted) ? wanted : undefined;
    const variant = pickVariant(meta, params.width, format);
    return variant ? `${base}${variant.key}` : fallback(params);
  };
}

/** The default loader: WebP variants for refs, `?w=` for everything else. */
const loader: NextLoader = createNextLoader();
export default loader;
