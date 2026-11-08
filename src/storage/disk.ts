import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { assertSafeKey, assertSafePrefix, type ByteRange, type ListedObject, type PutOptions, type Storage, type StoredObject } from "./types.js";

export interface DiskStorageOptions {
  /** Absolute or cwd-relative directory. Keys map to files below it. */
  root: string;
  /**
   * Base URL when the root (or its `img/` folder) is served directly by nginx
   * or a CDN, e.g. "https://cdn.example.com". Enables `publicUrl()`.
   */
  publicBaseUrl?: string;
}

/**
 * Stores objects as files under `root`. Writes are atomic (temp file + rename)
 * so readers never see half-written images. Visibility is not enforced on
 * disk: keep `orig/` out of any public nginx alias.
 */
export function diskStorage(options: DiskStorageOptions): Storage {
  const root = path.resolve(options.root);

  const resolve = (key: string): string => {
    assertSafeKey(key);
    const full = path.resolve(root, ...key.split("/"));
    if (!full.startsWith(root + path.sep)) throw new Error("Key escapes storage root");
    return full;
  };

  return {
    async put(key: string, data: Uint8Array, _options: PutOptions) {
      const file = resolve(key);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },

    async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
      const file = resolve(key);
      let info;
      try {
        info = await stat(file);
      } catch {
        return null;
      }
      if (!info.isFile()) return null;
      const stream = range
        ? createReadStream(file, { start: range.start, end: range.end })
        : createReadStream(file);
      return {
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        size: info.size,
        mtime: info.mtime,
        ...(range ? { range } : {}),
      };
    },

    async head(key: string) {
      try {
        const info = await stat(resolve(key));
        return info.isFile() ? { size: info.size, mtime: info.mtime } : null;
      } catch {
        return null;
      }
    },

    async delete(key: string) {
      try {
        await unlink(resolve(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    async deletePrefix(prefix: string) {
      assertSafePrefix(prefix);
      await rm(resolve(prefix.slice(0, -1)), { recursive: true, force: true });
    },

    async *list(prefix: string): AsyncIterable<ListedObject> {
      assertSafePrefix(prefix);
      let names: string[];
      try {
        names = await readdir(resolve(prefix.slice(0, -1)), { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const name of names) {
        const key = prefix + name.split(path.sep).join("/");
        let info;
        try {
          info = await stat(path.join(root, ...key.split("/")));
        } catch {
          continue; // deleted while listing
        }
        if (info.isFile()) yield { key, size: info.size, mtime: info.mtime };
      }
    },

    publicUrl: options.publicBaseUrl
      ? (key: string) => `${options.publicBaseUrl!.replace(/\/$/, "")}/${key}`
      : undefined,
  };
}
