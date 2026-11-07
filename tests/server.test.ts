import { beforeAll, describe, expect, it } from "vitest";
import { createImageProcessor, type ImageMeta } from "../src/index";
import { createImageHandler, parseRange, signUrl, verifySignature } from "../src/server";
import { memoryStorage } from "../src/storage";
import { makeJpeg } from "./helpers";

const storage = memoryStorage();
const secret = "test-secret";
const handler = createImageHandler({ storage, secret });
let meta: ImageMeta;
let webp: ImageMeta["variants"][number];

const get = (path: string, init?: RequestInit) => handler(new Request(`http://x${path}`, init));

beforeAll(async () => {
  meta = await createImageProcessor({ storage }).ingest(await makeJpeg(800, 600));
  webp = meta.variants.find((v) => v.format === "webp" && v.width === 640)!;
});

describe("createImageHandler", () => {
  it("serves a variant with immutable caching and safety headers", async () => {
    const res = await get(`/${webp.key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe(String(webp.bytes));
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(`"${meta.id}-640-webp"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect((await res.arrayBuffer()).byteLength).toBe(webp.bytes);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const res = await get(`/${webp.key}`, { headers: { "If-None-Match": `W/"${meta.id}-640-webp", "other"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("supports single byte ranges", async () => {
    const res = await get(`/${webp.key}`, { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${webp.bytes}`);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
    const bad = await get(`/${webp.key}`, { headers: { Range: `bytes=${webp.bytes + 5}-` } });
    expect(bad.status).toBe(416);
  });

  it("HEAD returns headers only", async () => {
    const res = await get(`/${webp.key}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(webp.bytes));
    expect(await res.text()).toBe("");
  });

  it("404s anything that is not a variant key", async () => {
    for (const p of [
      `/img/${meta.id}/meta.json`,
      `/img/${meta.id}/641.webp`,
      "/img/../orig/x.jpg",
      "/img/%2e%2e/%2e%2e/etc/passwd",
      "/package.json",
      `/img/${meta.id}/640.png`,
    ]) {
      expect((await get(p)).status, p).toBe(404);
    }
    expect((await get(`/${webp.key}`, { method: "POST" })).status).toBe(405);
  });

  it("serves originals only with a valid signature, privately", async () => {
    const path = `/${meta.original}`;
    expect((await get(path)).status).toBe(404);
    expect((await get(`${path}?exp=9999999999&sig=forged`)).status).toBe(404);

    const signed = await signUrl(path, { secret, expiresIn: 600 });
    const res = await get(signed);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toMatch(/^private, max-age=(599|600)$/);

    const expired = await signUrl(path, { secret, expiresIn: 10, now: Date.now() - 60_000 });
    expect((await get(expired)).status).toBe(404);
    const otherPath = signed.replace(meta.id, "aaaaaaaaaaaaaaaa");
    expect((await get(otherPath)).status).toBe(404);
  });

  it("refuses originals when no secret is configured", async () => {
    const h = createImageHandler({ storage });
    const signed = await signUrl(`/${meta.original}`, { secret });
    expect((await h(new Request(`http://x${signed}`))).status).toBe(404);
  });

  it("honours a mount prefix", async () => {
    const h = createImageHandler({ storage, mount: "/media" });
    expect((await h(new Request(`http://x/media/${webp.key}`))).status).toBe(200);
    expect((await h(new Request(`http://x/${webp.key}`))).status).toBe(404);
  });

  it("hands off to nginx with X-Accel-Redirect", async () => {
    const h = createImageHandler({ storage, accel: { prefix: "/_pixstack/" } });
    const res = await h(new Request(`http://x/${webp.key}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-accel-redirect")).toBe(`/_pixstack/${webp.key}`);
    expect(await res.text()).toBe("");
  });
});

describe("parseRange / verifySignature", () => {
  it("parses ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=-0", 100)).toBe("invalid");
  });
  it("binds the signature to the path and expiry", async () => {
    const now = 1_700_000_000_000;
    const signed = await signUrl("/orig/abc.jpg", { secret, expiresIn: 60, now });
    const url = new URL(`http://x${signed}`);
    expect(await verifySignature(url, secret, now)).toBe(60);
    expect(await verifySignature(url, "wrong", now)).toBeNull();
    url.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 1000));
    expect(await verifySignature(url, secret, now)).toBeNull();
  });
});
