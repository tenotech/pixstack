import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { s3Storage } from "../src/storage/s3";
import type { Storage } from "../src/storage";

/**
 * S3 tests run against a real S3-compatible server only when PIXSTACK_S3_ENDPOINT is set:
 *   docker run --rm -p 19090:9090 -e COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=pixstack adobe/s3mock:4.7.0
 *   PIXSTACK_S3_ENDPOINT=http://localhost:19090 pnpm test
 */
export function testS3(): Storage {
  const client = new S3Client({
    endpoint: process.env.PIXSTACK_S3_ENDPOINT!,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  // A fresh prefix per call keeps runs isolated in a shared bucket.
  return s3Storage({ client, bucket: process.env.PIXSTACK_S3_BUCKET ?? "pixstack", prefix: `t-${randomUUID()}/` });
}

/** A photo-like JPEG: gradient + noise so encoders behave realistically. */
export async function makeJpeg(width: number, height: number, opts: { orientation?: number; seed?: number } = {}) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  let s = opts.seed ?? 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s >> 16) % 24;
      const i = (y * width + x) * channels;
      data[i] = (x * 255) / width + n;
      data[i + 1] = (y * 255) / height + n;
      data[i + 2] = 128 + n;
    }
  }
  let img = sharp(data, { raw: { width, height, channels } }).jpeg({ quality: 90 });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation, exif: { IFD0: { Copyright: "secret-gps" } } });
  return new Uint8Array(await img.toBuffer());
}

export async function makePng(width: number, height: number, alpha = true) {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 30, b: 30, alpha: 0.5 } : "#336699" },
    })
      .png()
      .toBuffer(),
  );
}

export async function makeAnimatedGif() {
  const frame = (c: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: c } }).png().toBuffer();
  const frames = await Promise.all([frame("#ff0000"), frame("#00ff00"), frame("#0000ff")]);
  return new Uint8Array(await sharp(frames, { join: { animated: true } }).gif().toBuffer());
}

export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><script>alert(1)</script><rect width="100" height="50" fill="red"/></svg>',
);
