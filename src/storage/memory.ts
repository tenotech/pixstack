import { assertSafeKey, assertSafePrefix, type ByteRange, type ListedObject, type PutOptions, type Storage, type StoredObject } from "./types.js";

interface Entry {
  data: Uint8Array;
  contentType: string;
  mtime: Date;
}

/** In-memory storage for tests and prototypes. Exposes `entries` for inspection. */
export function memoryStorage(): Storage & { entries: Map<string, Entry> } {
  const entries = new Map<string, Entry>();

  const streamOf = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  return {
    entries,
    async put(key: string, data: Uint8Array, options: PutOptions) {
      assertSafeKey(key);
      entries.set(key, { data: new Uint8Array(data), contentType: options.contentType, mtime: new Date() });
    },
    async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
      assertSafeKey(key);
      const e = entries.get(key);
      if (!e) return null;
      const bytes = range ? e.data.subarray(range.start, range.end + 1) : e.data;
      return { body: streamOf(bytes), size: e.data.byteLength, mtime: e.mtime, ...(range ? { range } : {}) };
    },
    async head(key: string) {
      assertSafeKey(key);
      const e = entries.get(key);
      return e ? { size: e.data.byteLength, mtime: e.mtime } : null;
    },
    async delete(key: string) {
      assertSafeKey(key);
      entries.delete(key);
    },
    async deletePrefix(prefix: string) {
      assertSafePrefix(prefix);
      for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
    },
    async *list(prefix: string): AsyncIterable<ListedObject> {
      assertSafePrefix(prefix);
      for (const [key, e] of [...entries]) {
        if (key.startsWith(prefix)) yield { key, size: e.data.byteLength, mtime: e.mtime };
      }
    },
  };
}
