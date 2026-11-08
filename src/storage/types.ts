import { PixstackError } from "../errors.js";

export type Visibility = "public" | "private";

export interface PutOptions {
  contentType: string;
  visibility?: Visibility;
}

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Inclusive end offset. */
  end: number;
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  /** Total object size (not the range size). */
  size: number;
  mtime: Date;
  /** Present when a range was requested and honoured. */
  range?: ByteRange;
}

export interface ListedObject {
  key: string;
  size: number;
  mtime: Date;
}

export interface Storage {
  put(key: string, data: Uint8Array, options: PutOptions): Promise<void>;
  get(key: string, range?: ByteRange): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; mtime: Date } | null>;
  delete(key: string): Promise<void>;
  /** Delete every key starting with `prefix` (which must end with "/"). */
  deletePrefix(prefix: string): Promise<void>;
  /**
   * Every key starting with `prefix` (which must end with "/"), in no
   * particular order. Optional, so drivers written before 0.4 still type-check;
   * `sweep()` needs it.
   */
  list?(prefix: string): AsyncIterable<ListedObject>;
  /** When keys are served directly (CDN, nginx alias), the public URL for a key. */
  publicUrl?(key: string): string | null;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]*$/;

/** Throws unless `key` is a plain relative key with no traversal. */
export function assertSafeKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 512 ||
    !KEY_PATTERN.test(key) ||
    key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new PixstackError("INVALID_KEY", `Invalid storage key: ${JSON.stringify(key)}`);
  }
}

export function assertSafePrefix(prefix: string): void {
  if (!prefix.endsWith("/")) throw new PixstackError("INVALID_KEY", "Prefix must end with '/'");
  assertSafeKey(prefix.slice(0, -1));
}
