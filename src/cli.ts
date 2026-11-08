/**
 * The `pixstack` command. Logic lives here (testable `main`), src/bin.ts runs it.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isPixstackError } from "./errors.js";
import { ID_PATTERN, ORIGINAL_KEY_PATTERN, parseImageRef, toImageRef, type ImageMeta, type OutputFormat } from "./meta.js";
import { createImageProcessor, type ImageProcessor, type IngestOverrides } from "./processor.js";
import { diskStorage } from "./storage/disk.js";
import type { Storage } from "./storage/types.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `pixstack <command> [options]

Commands
  ingest <file|dir>...   Store images (dirs are walked). One JSON line per file: {file,id,ref} or {file,error}
  complete               Encode the formats left pending by \`defer\`, for every stored image
  reprocess [id...]      Re-encode from the kept originals (every image when no id is given)
  audit                  Check storage: missing meta or variants, stray files, pending formats, missing originals
  sweep --keep <file>    Delete images whose id is not listed in <file>. Dry run unless --yes
  ref <id>...            Print the ImageRef of stored images

Storage (one of)
  --root <dir>           Disk storage root (default: $PIXSTACK_ROOT)
  --s3-bucket <name>     S3 / R2 / MinIO; credentials from the usual AWS_* environment
  --s3-endpoint <url>    --s3-region <region> (default "auto")   --s3-prefix <prefix>

Options
  --widths 320,640,…     Width ladder (ingest, reprocess)
  --formats avif,webp    Output formats (ingest, reprocess)
  --defer avif           Formats to leave for \`complete\` (ingest)
  --allow-svg            Accept SVG (ingest)
  --keep <file>          One id, ref or /img/<id>/… URL per line (sweep). "-" reads stdin
  --older-than 24h       Grace period (sweep): 30m, 24h, 7d, 0
  --yes                  Actually delete (sweep)
  --concurrency <n>      Parallel jobs (default 2)
`;

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|heic|heif|gif|tiff?|svg)$/i;

function list<T extends string>(value: string | undefined, allowed?: readonly T[]): T[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed) for (const i of items) if (!allowed.includes(i as T)) throw new UsageError(`unknown value "${i}" (expected ${allowed.join(", ")})`);
  return items as T[];
}

function duration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new UsageError(`bad duration "${value}" (examples: 30m, 24h, 7d)`);
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] ?? "ms") as "ms"];
  return Number(m[1]) * unit;
}

class UsageError extends Error {}

/** Ids from a keep list: bare ids, refs, or any URL containing img/<id>/. */
export function idsFromLines(text: string): string[] {
  const ids = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (ID_PATTERN.test(line)) ids.add(line);
    else {
      const id = parseImageRef(line)?.meta.id ?? /(?:^|\/)img\/([a-z2-7]{16})\//.exec(line)?.[1];
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

async function* walk(target: string): AsyncGenerator<string> {
  const info = await stat(target);
  if (info.isFile()) {
    yield target;
    return;
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && IMAGE_EXT.test(entry.name)) yield full;
  }
}

async function pool<T>(items: AsyncIterable<T> | Iterable<T>, size: number, job: (item: T) => Promise<void>) {
  const it = (Symbol.asyncIterator in items ? items[Symbol.asyncIterator]() : (items as Iterable<T>)[Symbol.iterator]()) as
    | AsyncIterator<T>
    | Iterator<T>;
  const worker = async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      await job(next.value);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
}

async function storedIds(storage: Storage): Promise<string[]> {
  if (!storage.list) throw new UsageError("this storage cannot list keys");
  const ids = new Set<string>();
  for await (const o of storage.list("img/")) {
    const id = o.key.split("/")[1];
    if (id && ID_PATTERN.test(id)) ids.add(id);
  }
  return [...ids].sort();
}

async function makeStorage(values: Record<string, string | boolean | undefined>, env: NodeJS.ProcessEnv): Promise<Storage> {
  const bucket = values["s3-bucket"] as string | undefined;
  if (bucket) {
    let sdk: typeof import("@aws-sdk/client-s3");
    let s3: typeof import("./storage/s3.js");
    try {
      sdk = await import("@aws-sdk/client-s3");
      s3 = await import("./storage/s3.js");
    } catch {
      throw new UsageError("--s3-bucket needs @aws-sdk/client-s3 installed");
    }
    const endpoint = values["s3-endpoint"] as string | undefined;
    const client = new sdk.S3Client({
      region: (values["s3-region"] as string | undefined) ?? env.AWS_REGION ?? "auto",
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    const prefix = values["s3-prefix"] as string | undefined;
    return s3.s3Storage({ client, bucket, ...(prefix ? { prefix } : {}) });
  }
  const root = (values.root as string | undefined) ?? env.PIXSTACK_ROOT;
  if (!root) throw new UsageError("no storage: pass --root <dir> or --s3-bucket <name> (or set PIXSTACK_ROOT)");
  return diskStorage({ root });
}

async function readKeep(file: string, stdin: () => Promise<string>): Promise<string> {
  return file === "-" ? stdin() : readFile(file, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function describeError(err: unknown): { error: string; message: string } {
  if (isPixstackError(err)) return { error: err.code, message: err.message };
  return { error: "ERROR", message: err instanceof Error ? err.message : String(err) };
}

/** Run the CLI. Returns the exit code. */
export async function main(
  argv: string[],
  io: Io = { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n") },
  env: NodeJS.ProcessEnv = process.env,
  stdin: () => Promise<string> = readStdin,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        "s3-bucket": { type: "string" },
        "s3-endpoint": { type: "string" },
        "s3-region": { type: "string" },
        "s3-prefix": { type: "string" },
        widths: { type: "string" },
        formats: { type: "string" },
        defer: { type: "string" },
        "allow-svg": { type: "boolean" },
        keep: { type: "string" },
        "older-than": { type: "string" },
        yes: { type: "boolean" },
        concurrency: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    io.err((err as Error).message);
    io.err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help || !command) {
    (command || values.help ? io.out : io.err)(USAGE);
    return command || values.help ? 0 : 2;
  }

  try {
    const storage = await makeStorage(values, env);
    const concurrency = values.concurrency ? Number(values.concurrency) : 2;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError("--concurrency must be a positive integer");
    const widths = list(values.widths)?.map((w) => {
      const n = Number(w);
      if (!Number.isInteger(n) || n < 1 || n > 20_000) throw new UsageError(`bad width "${w}"`);
      return n;
    });
    const formats = list<OutputFormat>(values.formats, ["avif", "webp"]);
    const defer = list<OutputFormat>(values.defer, ["avif", "webp"]);
    const overrides: IngestOverrides = {
      ...(widths ? { widths } : {}),
      ...(formats ? { formats } : {}),
      ...(defer ? { defer } : {}),
      ...(values["allow-svg"] ? { allowSvg: true } : {}),
    };
    const images = createImageProcessor({ storage, concurrency, ...overrides });

    switch (command) {
      case "ingest":
        return await ingest(images, args, concurrency, io);
      case "complete":
        return await complete(images, storage, concurrency, io);
      case "reprocess":
        return await reprocess(images, storage, args, overrides, concurrency, io);
      case "audit":
        return await audit(images, storage, io);
      case "sweep": {
        if (!values.keep) throw new UsageError("sweep needs --keep <file> (ids or refs still in use, one per line)");
        const keep = idsFromLines(await readKeep(values.keep, stdin));
        const olderThan = duration(values["older-than"]);
        const res = await images.sweep({ keep, dryRun: !values.yes, ...(olderThan !== undefined ? { olderThan } : {}) });
        for (const id of res.removed) io.out(JSON.stringify({ id, removed: Boolean(values.yes) }));
        io.err(
          `${values.yes ? "removed" : "would remove"} ${res.removed.length} image(s), ${(res.bytes / 1024 / 1024).toFixed(1)} MB` +
            ` · kept ${res.kept} in use · ${res.recent} recent (grace period)` +
            (values.yes ? "" : " · dry run: pass --yes to delete"),
        );
        return 0;
      }
      case "ref": {
        if (args.length === 0) throw new UsageError("ref needs at least one id");
        let code = 0;
        for (const id of args) {
          const meta = await images.getMeta(id);
          if (meta) io.out(toImageRef(meta));
          else {
            io.err(`${id}: not found`);
            code = 1;
          }
        }
        return code;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`pixstack: ${err.message}`);
      return 2;
    }
    io.err(`pixstack: ${describeError(err).message}`);
    return 1;
  }
}

async function ingest(images: ImageProcessor, targets: string[], concurrency: number, io: Io): Promise<number> {
  if (targets.length === 0) throw new UsageError("ingest needs files or directories");
  let failed = 0;
  let done = 0;
  async function* files() {
    for (const t of targets) yield* walk(t);
  }
  await pool(files(), concurrency, async (file) => {
    try {
      const meta = await images.ingest(await readFile(file));
      io.out(JSON.stringify({ file, id: meta.id, ref: toImageRef(meta) }));
      done++;
    } catch (err) {
      io.out(JSON.stringify({ file, ...describeError(err) }));
      failed++;
    }
  });
  io.err(`ingested ${done} file(s)${failed ? `, ${failed} failed` : ""}`);
  return failed ? 1 : 0;
}

async function complete(images: ImageProcessor, storage: Storage, concurrency: number, io: Io): Promise<number> {
  let completed = 0;
  let failed = 0;
  await pool(await storedIds(storage), concurrency, async (id) => {
    const meta = await images.getMeta(id);
    if (!meta?.pending?.length) return;
    try {
      const next = await images.complete(meta);
      io.out(JSON.stringify({ id, ref: toImageRef(next) }));
      completed++;
    } catch (err) {
      io.out(JSON.stringify({ id, ...describeError(err) }));
      failed++;
    }
  });
  io.err(`completed ${completed} image(s)${failed ? `, ${failed} failed` : ""}`);
  return failed ? 1 : 0;
}

async function reprocess(
  images: ImageProcessor,
  storage: Storage,
  ids: string[],
  overrides: IngestOverrides,
  concurrency: number,
  io: Io,
): Promise<number> {
  let done = 0;
  let failed = 0;
  await pool(ids.length ? ids : await storedIds(storage), concurrency, async (id) => {
    try {
      const meta = await images.getMeta(id);
      if (!meta) throw new Error("not found");
      const next = await images.reprocess(meta, overrides);
      io.out(JSON.stringify({ id, ref: toImageRef(next) }));
      done++;
    } catch (err) {
      io.out(JSON.stringify({ id, ...describeError(err) }));
      failed++;
    }
  });
  io.err(
    `reprocessed ${done} image(s)${failed ? `, ${failed} failed` : ""}.` +
      " Records that hold refs keep the old width list: save the printed refs where the ladder changed.",
  );
  return failed ? 1 : 0;
}

async function audit(images: ImageProcessor, storage: Storage, io: Io): Promise<number> {
  if (!storage.list) throw new UsageError("this storage cannot list keys");
  const files = new Map<string, Set<string>>();
  let bytes = 0;
  for await (const o of storage.list("img/")) {
    const id = o.key.split("/")[1] ?? "";
    if (!ID_PATTERN.test(id)) continue;
    bytes += o.size;
    (files.get(id) ?? files.set(id, new Set()).get(id)!).add(o.key);
  }
  const originals = new Set<string>();
  for await (const o of storage.list("orig/")) {
    bytes += o.size;
    if (ORIGINAL_KEY_PATTERN.test(o.key)) originals.add(o.key);
  }

  const issue = (id: string, problem: string, detail?: unknown) =>
    io.out(JSON.stringify({ id, problem, ...(detail !== undefined ? { detail } : {}) }));
  let issues = 0;
  let pending = 0;
  const referenced = new Set<string>();
  for (const [id, keys] of [...files].sort()) {
    const meta: ImageMeta | null = await images.getMeta(id);
    if (!meta) {
      issue(id, "no-meta", "variants without meta.json: an ingest was interrupted");
      issues++;
      continue;
    }
    const listed = new Set(meta.variants.map((v) => v.key));
    const missing = [...listed].filter((k) => !keys.has(k));
    const stray = [...keys].filter((k) => !listed.has(k) && !k.endsWith("/meta.json"));
    if (missing.length) {
      issue(id, "missing-variants", missing);
      issues++;
    }
    if (stray.length) {
      issue(id, "stray-files", stray);
      issues++;
    }
    if (meta.pending?.length) pending++;
    if (meta.original) {
      referenced.add(meta.original);
      if (!originals.has(meta.original)) {
        issue(id, "missing-original", meta.original);
        issues++;
      }
    }
  }
  for (const key of originals) {
    if (!referenced.has(key)) {
      issue(ORIGINAL_KEY_PATTERN.exec(key)![1]!, "orphan-original", key);
      issues++;
    }
  }
  io.err(
    `${files.size} image(s), ${(bytes / 1024 / 1024).toFixed(1)} MB · ${issues} issue(s)` +
      (pending ? ` · ${pending} with pending formats (run \`pixstack complete\`)` : ""),
  );
  return issues ? 1 : 0;
}
