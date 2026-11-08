/**
 * pixstack/storage/s3 — S3-compatible storage (AWS S3, Cloudflare R2, MinIO, …).
 * Requires the optional peer dependency `@aws-sdk/client-s3`.
 *
 *   import { S3Client } from "@aws-sdk/client-s3";
 *   const storage = s3Storage({
 *     client: new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT, credentials: {…} }),
 *     bucket: "media",
 *     publicBaseUrl: "https://media.example.com", // R2 custom domain / CloudFront
 *   });
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { assertSafeKey, assertSafePrefix, type ByteRange, type ListedObject, type PutOptions, type Storage, type StoredObject } from "./types.js";

export interface S3StorageOptions {
  client: S3Client;
  bucket: string;
  /** Optional key prefix inside the bucket, e.g. "pixstack/". */
  prefix?: string;
  /** Public base URL when the bucket (or a CDN in front of it) serves keys directly. */
  publicBaseUrl?: string;
}

/** Cache-Control written on the object, so a CDN in front of the bucket gets it right. */
const OBJECT_CACHE: Record<"public" | "private", string> = {
  public: "public, max-age=31536000, immutable",
  private: "private, no-store",
};

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export function s3Storage(options: S3StorageOptions): Storage {
  const { client, bucket } = options;
  const prefix = options.prefix ? options.prefix.replace(/\/?$/, "/") : "";
  if (prefix) assertSafePrefix(prefix);

  const full = (key: string) => {
    assertSafeKey(key);
    return prefix + key;
  };

  return {
    async put(key: string, data: Uint8Array, opts: PutOptions) {
      // JSON (meta) changes on complete()/reprocess(): never mark it immutable.
      const cacheControl =
        opts.contentType === "application/json" ? "no-cache" : OBJECT_CACHE[opts.visibility ?? "public"];
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: full(key),
          Body: data,
          ContentType: opts.contentType,
          ContentLength: data.byteLength,
          CacheControl: cacheControl,
        }),
      );
    },

    async get(key: string, range?: ByteRange): Promise<StoredObject | null> {
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: full(key),
            ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
          }),
        );
        if (!res.Body) return null;
        // "bytes 0-9/1234" → total size; without a range ContentLength is the size.
        const total = res.ContentRange ? Number(res.ContentRange.split("/")[1]) : Number(res.ContentLength ?? 0);
        return {
          body: res.Body.transformToWebStream() as ReadableStream<Uint8Array>,
          size: total,
          mtime: res.LastModified ?? new Date(0),
          ...(range ? { range } : {}),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async head(key: string) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: full(key) }));
        return { size: Number(res.ContentLength ?? 0), mtime: res.LastModified ?? new Date(0) };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async delete(key: string) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: full(key) }));
    },

    async deletePrefix(p: string) {
      assertSafePrefix(p);
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix + p, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
        if (keys.length > 0) {
          const res = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          if (res.Errors?.length) {
            throw new Error(`S3 deletePrefix failed for ${res.Errors.length} keys: ${res.Errors[0]?.Message ?? ""}`);
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },

    async *list(p: string): AsyncIterable<ListedObject> {
      assertSafePrefix(p);
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix + p, ContinuationToken: token }),
        );
        for (const o of page.Contents ?? []) {
          if (!o.Key) continue;
          yield { key: o.Key.slice(prefix.length), size: o.Size ?? 0, mtime: o.LastModified ?? new Date(0) };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },

    publicUrl: options.publicBaseUrl
      ? (key: string) => `${options.publicBaseUrl!.replace(/\/$/, "")}/${prefix}${key}`
      : undefined,
  };
}
