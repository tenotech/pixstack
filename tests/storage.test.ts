import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diskStorage, memoryStorage, type Storage } from "../src/storage";
import { testS3 } from "./helpers";
import { readAll } from "../src/util";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function disk(): Promise<{ storage: Storage; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pixstack-"));
  dirs.push(root);
  return { storage: diskStorage({ root, publicBaseUrl: "https://cdn.test/" }), root };
}

const s3Endpoint = process.env.PIXSTACK_S3_ENDPOINT;

const drivers: [string, () => Promise<Storage>][] = [
  ["disk", async () => (await disk()).storage],
  ["memory", async () => memoryStorage()],
  ...(s3Endpoint ? [["s3", async () => testS3()] as [string, () => Promise<Storage>]] : []),
];

describe.each(drivers)("%s storage", (_name, make) => {
  const bytes = new TextEncoder().encode("0123456789");

  it("puts, heads, gets (with range) and deletes", async () => {
    const s = await make();
    await s.put("img/a/1.webp", bytes, { contentType: "image/webp" });
    expect((await s.head("img/a/1.webp"))?.size).toBe(10);
    const full = await s.get("img/a/1.webp");
    expect(new TextDecoder().decode(await readAll(full!.body))).toBe("0123456789");
    const part = await s.get("img/a/1.webp", { start: 2, end: 4 });
    expect(new TextDecoder().decode(await readAll(part!.body))).toBe("234");
    expect(part!.size).toBe(10);
    await s.delete("img/a/1.webp");
    await s.delete("img/a/1.webp"); // idempotent
    expect(await s.get("img/a/1.webp")).toBeNull();
    expect(await s.head("img/a/1.webp")).toBeNull();
  });

  it("deletes by prefix", async () => {
    const s = await make();
    await s.put("img/a/1.webp", bytes, { contentType: "x" });
    await s.put("img/a/2.webp", bytes, { contentType: "x" });
    await s.put("img/b/1.webp", bytes, { contentType: "x" });
    await s.deletePrefix("img/a/");
    expect(await s.head("img/a/1.webp")).toBeNull();
    expect(await s.head("img/b/1.webp")).not.toBeNull();
    await expect(s.deletePrefix("img/a")).rejects.toThrow();
  });

  it("rejects unsafe keys", async () => {
    const s = await make();
    for (const k of ["../x", "img/../../x", "/abs", "img//x", "IMG/x", "img/x\\y", "", "img/./x"]) {
      await expect(s.put(k, bytes, { contentType: "x" }), k).rejects.toThrow(/Invalid storage key/);
      await expect(s.get(k), k).rejects.toThrow();
    }
  });
});

describe("diskStorage specifics", () => {
  it("writes atomically (no temp files left) and exposes public URLs", async () => {
    const { storage, root } = await disk();
    await storage.put("img/a/1.webp", new Uint8Array([1, 2, 3]), { contentType: "image/webp" });
    expect(await readdir(path.join(root, "img", "a"))).toEqual(["1.webp"]);
    expect(storage.publicUrl?.("img/a/1.webp")).toBe("https://cdn.test/img/a/1.webp");
  });
});
