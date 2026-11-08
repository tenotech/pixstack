"use client";
/**
 * The preload hint for `<Img priority>`, as a Client Component. Calling
 * ReactDOM.preload() from a Server Component only puts the hint in the RSC
 * payload when the page awaits data first (every dynamic page): the browser
 * then sees it after hydration, too late to help. Rendered on the client side
 * of the boundary, it runs during HTML rendering and lands in <head>, like
 * next/image's `priority`. Built as its own file so the directive survives.
 */
import * as ReactDOM from "react-dom";

export interface ImagePreloadProps {
  href: string;
  imageSrcSet?: string;
  imageSizes?: string;
  /** MIME type, so a browser that can't decode it skips the hint instead of downloading twice. */
  type?: string;
}

type PreloadFn = (
  href: string,
  options: { as: "image"; imageSrcSet?: string; imageSizes?: string; fetchPriority?: "high"; type?: string },
) => void;

// React 19 API; absent in React 18, where preloading is skipped.
const reactPreload = (ReactDOM as unknown as { preload?: PreloadFn }).preload;

export function ImagePreload({ href, imageSrcSet, imageSizes, type }: ImagePreloadProps): null {
  if (typeof reactPreload === "function") {
    reactPreload(href, {
      as: "image",
      fetchPriority: "high",
      ...(imageSrcSet ? { imageSrcSet } : {}),
      ...(imageSizes ? { imageSizes } : {}),
      ...(type ? { type } : {}),
    });
  }
  return null;
}
