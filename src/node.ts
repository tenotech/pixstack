/**
 * pixstack/node — run a Web-standard handler (createImageHandler) on Node's
 * `http` server, Express, Connect or Fastify.
 *
 *   // node:http
 *   http.createServer(toNodeHandler(handler)).listen(3000);
 *
 *   // Express: unknown keys fall through to the next middleware
 *   app.use("/img", toNodeHandler(handler));   // mount "/" is fine: originalUrl is used
 *
 *   // Fastify
 *   app.get("/img/*", (req, reply) => { reply.hijack(); return node(req.raw, reply.raw); });
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type WebHandler = (request: Request) => Response | Promise<Response>;

export interface NodeHandlerOptions {
  /**
   * Origin used to build the Request URL, e.g. "https://example.com". Default:
   * "http://" + the Host header. Only the path matters to the image handler.
   */
  origin?: string;
  /**
   * With Express/Connect (`next` given): pass 404s to the next middleware
   * instead of answering them. Default true, like `express.static`.
   */
  fallthrough?: boolean;
}

type NodeRequest = IncomingMessage & { originalUrl?: string };
type Next = (err?: unknown) => void;

/** Build a Web `Request` from a Node request (no body: images are served with GET/HEAD). */
export function toWebRequest(req: NodeRequest, origin?: string): Request {
  const host = (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host) ?? "localhost";
  const base = origin ?? `http://${host}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue; // HTTP/2 pseudo-headers
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const controller = new AbortController();
  req.once("close", () => controller.abort());
  return new Request(new URL(req.originalUrl ?? req.url ?? "/", base), {
    method: req.method ?? "GET",
    headers,
    signal: controller.signal,
  });
}

/** Write a Web `Response` to a Node response, streaming the body. */
export async function sendWebResponse(res: ServerResponse, response: Response, method = "GET"): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body || method === "HEAD") {
    await response.body?.cancel();
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
  } catch (err) {
    // The client went away mid-transfer: nothing to report.
    if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
  }
}

/** Adapt a Web handler to `(req, res, next?)`: works as a node:http listener and as Express middleware. */
export function toNodeHandler(handler: WebHandler, options: NodeHandlerOptions = {}) {
  const fallthrough = options.fallthrough ?? true;
  return async function pixstackNode(req: NodeRequest, res: ServerResponse, next?: Next): Promise<void> {
    try {
      const response = await handler(toWebRequest(req, options.origin));
      if (next && fallthrough && response.status === 404) {
        await response.body?.cancel();
        next();
        return;
      }
      await sendWebResponse(res, response, req.method);
    } catch (err) {
      if (next) {
        next(err);
        return;
      }
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Cache-Control", "no-store");
        res.end("Internal error");
      } else {
        res.destroy(err as Error);
      }
    }
  };
}
