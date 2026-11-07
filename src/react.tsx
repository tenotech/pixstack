/**
 * pixstack/react — render an ImageMeta with srcset, intrinsic size and an
 * instant thumbhash placeholder. Works in Server and Client Components.
 */
import type { CSSProperties, ImgHTMLAttributes } from "react";
import { thumbHashToDataURL } from "thumbhash";
import { defaultUrlFor, formatsOf, OUTPUT_MIME, pickVariant, srcSet, type ImageMeta, type UrlFor } from "./meta.js";

export type PlaceholderMode = "thumbhash" | "color" | "none";

export interface ImageOptions {
  alt: string;
  /** The `sizes` attribute. Get this right: it decides which width the browser downloads. Default "100vw". */
  sizes?: string;
  /** LCP image: eager + fetchpriority=high, no placeholder. */
  priority?: boolean;
  /** Default "thumbhash" for opaque images, "none" for images with transparency. */
  placeholder?: PlaceholderMode;
  /** Map a storage key to a URL. Default `/${key}`. */
  urlFor?: UrlFor;
}

export interface ImageSourceProps {
  type: string;
  srcSet: string;
  sizes: string;
}

export interface ImageProps {
  /** Extra formats for <picture>, best first. Empty when only one format exists. */
  sources: ImageSourceProps[];
  img: {
    src: string;
    srcSet: string;
    sizes: string;
    width: number;
    height: number;
    alt: string;
    loading: "eager" | "lazy";
    decoding: "async" | "auto";
    fetchPriority?: "high";
    style?: CSSProperties;
  };
}

const placeholderCache = new Map<string, string>();

/** Decode a base64 thumbhash into a tiny PNG data URL (memoised). */
export function thumbhashDataUrl(thumbhash: string): string {
  let url = placeholderCache.get(thumbhash);
  if (!url) {
    const bin = atob(thumbhash);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    url = thumbHashToDataURL(bytes);
    if (placeholderCache.size > 500) placeholderCache.clear();
    placeholderCache.set(thumbhash, url);
  }
  return url;
}

/** CSS that paints the placeholder behind the image until it loads. */
export function placeholderStyle(meta: ImageMeta, mode: PlaceholderMode = "thumbhash"): CSSProperties | undefined {
  if (mode === "none") return undefined;
  if (mode === "color") return { backgroundColor: meta.color };
  return {
    backgroundColor: meta.color,
    backgroundImage: `url("${thumbhashDataUrl(meta.thumbhash)}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  };
}

/** Framework-free props; use with your own <img>/<picture> or next/image `unoptimized`. */
export function getImageProps(meta: ImageMeta, options: ImageOptions): ImageProps {
  const urlFor = options.urlFor ?? defaultUrlFor;
  const sizes = options.sizes ?? "100vw";
  const formats = formatsOf(meta);
  const fallbackFormat = formats.includes("webp") ? "webp" : formats[formats.length - 1];
  if (!fallbackFormat) throw new Error(`ImageMeta ${meta.id} has no variants`);

  const fallback = pickVariant(meta, 1280, fallbackFormat)!;
  const mode = options.priority ? "none" : (options.placeholder ?? (meta.alpha ? "none" : "thumbhash"));

  return {
    sources: formats
      .filter((f) => f !== fallbackFormat)
      .map((f) => ({ type: OUTPUT_MIME[f], srcSet: srcSet(meta, f, urlFor), sizes })),
    img: {
      src: urlFor(fallback.key),
      srcSet: srcSet(meta, fallbackFormat, urlFor),
      sizes,
      width: meta.width,
      height: meta.height,
      alt: options.alt,
      loading: options.priority ? "eager" : "lazy",
      decoding: options.priority ? "auto" : "async",
      ...(options.priority ? { fetchPriority: "high" as const } : {}),
      ...(mode !== "none" ? { style: placeholderStyle(meta, mode) } : {}),
    },
  };
}

export type ImgProps = ImageOptions &
  Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes" | "width" | "height" | "alt" | "placeholder"> & {
    image: ImageMeta;
  };

/**
 * <Img image={meta} alt="…" sizes="(min-width: 768px) 33vw, 100vw" />
 * Renders <picture> with an AVIF <source> and a WebP <img>. Pass `className`/`style`
 * as usual; `style` is merged over the placeholder.
 */
export function Img({ image, alt, sizes, priority, placeholder, urlFor, style, ...rest }: ImgProps) {
  const props = getImageProps(image, {
    alt,
    ...(sizes !== undefined ? { sizes } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(urlFor !== undefined ? { urlFor } : {}),
  });
  const img = <img {...props.img} {...rest} style={{ ...props.img.style, ...style }} />;
  if (props.sources.length === 0) return img;
  return (
    <picture>
      {props.sources.map((s) => (
        <source key={s.type} type={s.type} srcSet={s.srcSet} sizes={s.sizes} />
      ))}
      {img}
    </picture>
  );
}
