/**
 * pixstack/server — serve stored images from any Web-standard runtime.
 *
 *   // Next.js: app/img/[...key]/route.ts
 *   const handler = createImageHandler({ storage });
 *   export { handler as GET, handler as HEAD };
 *
 *   // Hono
 *   app.get("/img/*", (c) => handler(c.req.raw));
 */
import { ORIGINAL_KEY_PATTERN, VARIANT_KEY_PATTERN } from "./meta.js";
import type { ByteRange, Storage } from "./storage/types.js";

export interface ImageHandlerOptions {
  storage: Storage;
  /**
   * URL path prefix that maps to the storage root. Default "/": the URL
   * "/img/<id>/640.webp" serves key "img/<id>/640.webp". With mount "/media",
   * the URL "/media/img/<id>/640.webp" serves the same key.
   */
  mount?: string;
  /** HMAC secret for signed URLs. Required to serve originals (orig/…). */
  secret?: string;
  /** Require a valid signature for every key, not just originals. Default false. */
  requireSignature?: boolean;
  /**
   * Hand the byte transfer to nginx: respond with `X-Accel-Redirect: <prefix>/<key>`
   * and an empty body. Pair with an `internal` nginx location aliased to the storage root.
   */
  accel?: { prefix: string };
}

const CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  gif: "image/gif",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // If someone opens a file directly (notably an original SVG), nothing in it can run.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
} as const;

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { ...BASE_HEADERS, "Cache-Control": "no-store" } });
}

/** RFC 7233 single range. Returns null for "no/ignored range", "invalid" for unsatisfiable. */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or junk: serve the whole thing
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export function createImageHandler(options: ImageHandlerOptions): (request: Request) => Promise<Response> {
  const { storage } = options;
  const mount = (options.mount ?? "/").replace(/\/?$/, "/");

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...BASE_HEADERS, Allow: "GET, HEAD" } });
    }

    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (!pathname.startsWith(mount)) return notFound();
    const key = pathname.slice(mount.length);

    const variant = VARIANT_KEY_PATTERN.exec(key);
    const original = variant ? null : ORIGINAL_KEY_PATTERN.exec(key);
    if (!variant && !original) return notFound();

    // Signed access: originals always, everything when requireSignature.
    let cacheControl = IMMUTABLE;
    if (original || options.requireSignature) {
      if (!options.secret) return notFound();
      const remaining = await verifySignature(url, options.secret);
      if (remaining === null) return notFound();
      cacheControl = `private, max-age=${remaining}`;
    }

    const ext = key.slice(key.lastIndexOf(".") + 1);
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const etag = variant ? `"${variant[1]}-${variant[2]}-${variant[3]}"` : `"${original![1]}-orig"`;

    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      ETag: etag,
      "Accept-Ranges": "bytes",
    };

    if (etagMatches(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers });
    }

    if (options.accel) {
      const prefix = options.accel.prefix.replace(/\/$/, "");
      return new Response(null, { status: 200, headers: { ...headers, "X-Accel-Redirect": `${prefix}/${key}` } });
    }

    const rangeHeader = request.headers.get("Range");
    let range: ByteRange | null = null;
    if (rangeHeader) {
      const stat = await storage.head(key);
      if (!stat) return notFound();
      const parsed = parseRange(rangeHeader, stat.size);
      if (parsed === "invalid") {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
      }
      range = parsed;
    }

    const obj = await storage.get(key, range ?? undefined);
    if (!obj) return notFound();
    headers["Last-Modified"] = obj.mtime.toUTCString();

    if (range) {
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${obj.size}`;
      headers["Content-Length"] = String(range.end - range.start + 1);
    } else {
      headers["Content-Length"] = String(obj.size);
    }

    if (request.method === "HEAD") {
      await obj.body.cancel();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    return new Response(obj.body, { status: range ? 206 : 200, headers });
  };
}

// ── Signed URLs ────────────────────────────────────────────────────────────

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SignOptions {
  secret: string;
  /** Lifetime in seconds. Default 3600. */
  expiresIn?: number;
  /** Override "now" (ms since epoch), for tests. */
  now?: number;
}

/**
 * Sign a path (e.g. "/orig/abc….jpg" or "/img/abc…/640.webp").
 * Returns the path with `exp` and `sig` query parameters.
 */
export async function signUrl(path: string, options: SignOptions): Promise<string> {
  const exp = Math.floor((options.now ?? Date.now()) / 1000) + (options.expiresIn ?? 3600);
  const sig = await hmac(options.secret, `${path}\n${exp}`);
  return `${path}${path.includes("?") ? "&" : "?"}exp=${exp}&sig=${sig}`;
}

/** Seconds left on a valid signature, or null if missing/invalid/expired. */
export async function verifySignature(url: URL, secret: string, now = Date.now()): Promise<number | null> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig");
  if (!sig || !Number.isInteger(exp)) return null;
  const remaining = exp - Math.floor(now / 1000);
  if (remaining <= 0) return null;
  const expected = await hmac(secret, `${url.pathname}\n${exp}`);
  return timingSafeEqual(sig, expected) ? remaining : null;
}
