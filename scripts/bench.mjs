#!/usr/bin/env node
// Bytes vs quality per format and setting, to tune defaults with data.
//
//   pnpm bench <dir-of-photos> [--width 1280] [--webp 60,70,78,85,90] [--avif 40,46,52,58,64]
//
// Each photo is resized to --width (the size most pages actually load), encoded
// with the same settings as the processor (effort 4, smart subsampling for WebP,
// 4:2:0 for AVIF), decoded again and compared with the resized source using
// SSIM on luma (8×8 windows, the usual constants). Photos are not shipped with
// the repo: point it at any folder (public-domain sets, your own catalogue).
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: "string", default: "1280" },
    webp: { type: "string", default: "60,70,78,85,90" },
    avif: { type: "string", default: "40,46,52,58,64" },
  },
});
const dir = positionals[0];
if (!dir) {
  console.error("usage: pnpm bench <dir-of-photos> [--width 1280] [--webp 60,78,90] [--avif 40,52,64]");
  process.exit(2);
}
const width = Number(values.width);
const nums = (s) => s.split(",").map(Number).filter(Number.isFinite);
const settings = [
  ...nums(values.webp).map((q) => ({ format: "webp", q, opts: { quality: q, effort: 4, smartSubsample: true } })),
  ...nums(values.avif).map((q) => ({ format: "avif", q, opts: { quality: q, effort: 4, chromaSubsampling: "4:2:0" } })),
];
const DEFAULTS = { webp: 78, avif: 52 };

/** Mean SSIM over non-overlapping 8×8 windows of two same-size 8-bit luma buffers. */
function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let n = 0;
  for (let y = 0; y + 8 <= h; y += 8) {
    for (let x = 0; x + 8 <= w; x += 8) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let j = 0; j < 8; j++) {
        let i = (y + j) * w + x;
        for (let k = 0; k < 8; k++, i++) {
          const va = a[i], vb = b[i];
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const ma = sa / 64, mb = sb / 64;
      const va = saa / 64 - ma * ma, vb = sbb / 64 - mb * mb, cov = sab / 64 - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? total / n : 1;
}

const luma = (input) => sharp(input).greyscale().raw().toBuffer({ resolveWithObject: true });

const files = (await readdir(dir, { recursive: true }))
  .filter((f) => /\.(jpe?g|png|webp|avif|tiff?)$/i.test(f))
  .map((f) => path.join(dir, f));
if (files.length === 0) {
  console.error(`no photos in ${dir}`);
  process.exit(1);
}

const rows = new Map(settings.map((s) => [`${s.format} q${s.q}`, { ...s, bytes: [], ssim: [], ms: [] }]));
let used = 0;
for (const file of files) {
  let ref;
  try {
    ref = await sharp(file).rotate().resize({ width, withoutEnlargement: true }).toColourspace("srgb").png().toBuffer();
  } catch {
    console.error(`skip ${path.basename(file)} (cannot decode)`);
    continue;
  }
  const base = await luma(ref);
  used++;
  for (const s of settings) {
    const t = performance.now();
    const out = await sharp(ref)[s.format](s.opts).toBuffer();
    const ms = performance.now() - t;
    const dec = await luma(out);
    const row = rows.get(`${s.format} q${s.q}`);
    row.bytes.push(out.length);
    row.ssim.push(ssim(base.data, dec.data, base.info.width, base.info.height));
    row.ms.push(ms);
  }
  process.stderr.write(`\r${used}/${files.length}`);
}
process.stderr.write("\n");

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`${used} photos, resized to ${width} px wide\n`);
console.log("| Setting | Median KB | Mean KB | Mean SSIM | Worst SSIM | Encode ms (mean) |");
console.log("|---|---|---|---|---|---|");
for (const [name, r] of rows) {
  const mark = DEFAULTS[r.format] === r.q ? " **(default)**" : "";
  console.log(
    `| ${name}${mark} | ${(median(r.bytes) / 1024).toFixed(1)} | ${(avg(r.bytes) / 1024).toFixed(1)} | ` +
      `${avg(r.ssim).toFixed(4)} | ${Math.min(...r.ssim).toFixed(4)} | ${avg(r.ms).toFixed(0)} |`,
  );
}
