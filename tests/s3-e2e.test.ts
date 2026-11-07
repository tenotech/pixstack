import { describe, expect, it } from "vitest";
import { createImageProcessor } from "../src/index";
import { createImageHandler } from "../src/server";
import { makeJpeg, testS3 } from "./helpers";

describe.skipIf(!process.env.PIXSTACK_S3_ENDPOINT)("S3 end to end", () => {
  it("ingests, completes deferred AVIF, serves with ranges and removes", async () => {
    const storage = testS3();
    const images = createImageProcessor({ storage, defer: ["avif"] });
    const meta = await images.ingest(await makeJpeg(900, 600));
    const done = await images.complete(meta);
    expect(done.variants.filter((v) => v.format === "avif")).toHaveLength(3);

    const handler = createImageHandler({ storage });
    const v = done.variants.find((x) => x.format === "avif" && x.width === 640)!;
    const res = await handler(new Request(`http://x/${v.key}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(v.bytes));
    expect((await res.arrayBuffer()).byteLength).toBe(v.bytes);

    const part = await handler(new Request(`http://x/${v.key}`, { headers: { Range: "bytes=0-99" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${v.bytes}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    // dedupe reads meta.json back from S3
    expect(await images.ingest(await makeJpeg(900, 600))).toEqual(done);

    await images.remove(done);
    expect(await storage.head(v.key)).toBeNull();
    expect(await storage.head(done.original!)).toBeNull();
    expect(await images.getMeta(done.id)).toBeNull();
  });
});
