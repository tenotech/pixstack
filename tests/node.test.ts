import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createImageProcessor, type ImageMeta } from "../src/index";
import { toNodeHandler } from "../src/node";
import { createImageHandler } from "../src/server";
import { memoryStorage } from "../src/storage";
import { makeJpeg } from "./helpers";

const storage = memoryStorage();
let meta: ImageMeta;
let base: string;
const servers: http.Server[] = [];

async function listen(listener: http.RequestListener): Promise<string> {
  const server = http.createServer(listener);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  meta = await createImageProcessor({ storage, widths: [160, 320], formats: ["webp"] }).ingest(await makeJpeg(400, 300));
  base = await listen(toNodeHandler(createImageHandler({ storage })));
});
afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

describe("toNodeHandler", () => {
  it("serves bytes, ranges, HEAD and 304 like the Web handler", async () => {
    const v = meta.variants[0]!;
    const full = await fetch(`${base}/${v.key}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/webp");
    expect(full.headers.get("cache-control")).toContain("immutable");
    expect((await full.arrayBuffer()).byteLength).toBe(v.bytes);

    const part = await fetch(`${base}/${v.key}`, { headers: { Range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(10);

    const head = await fetch(`${base}/${v.key}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(v.bytes));

    const etag = full.headers.get("etag")!;
    const again = await fetch(`${base}/${v.key}`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("answers 404 and 405 itself when there is no next()", async () => {
    expect((await fetch(`${base}/img/aaaaaaaaaaaaaaaa/160.webp`)).status).toBe(404);
    expect((await fetch(`${base}/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/${meta.variants[0]!.key}`, { method: "POST" })).status).toBe(405);
  });

  it("as Express-style middleware: uses originalUrl and passes 404s to next()", async () => {
    const node = toNodeHandler(createImageHandler({ storage, mount: "/media" }));
    const url = await listen((req, res) => {
      // What Express does for app.use("/media", …): req.url loses the mount, originalUrl keeps it.
      const r = Object.assign(req, { originalUrl: req.url });
      r.url = req.url!.replace(/^\/media/, "") || "/";
      void node(r, res, (err) => {
        res.statusCode = err ? 500 : 418;
        res.end(err ? "error" : "next");
      });
    });
    expect((await fetch(`${url}/media/${meta.variants[0]!.key}`)).status).toBe(200);
    const miss = await fetch(`${url}/media/img/aaaaaaaaaaaaaaaa/160.webp`);
    expect(miss.status).toBe(418);
    expect(await miss.text()).toBe("next");
  });

  it("turns a handler crash into a 500 (or next(err))", async () => {
    const url = await listen(toNodeHandler(() => Promise.reject(new Error("boom"))));
    const res = await fetch(`${url}/x`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
  });
});
