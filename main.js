#!/usr/bin/env node
import { Command } from 'commander';
import fg from 'fast-glob';
import pLimit from 'p-limit';
import sharp from 'sharp';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXT_GLOB = '{png,jpg,jpeg}';
const EXTS = new Set(['.png', '.jpg', '.jpeg']);

const num = (v) => {
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Not a number: ${v}`);
  return n;
};

const kb = (b) => (b / 1024).toFixed(1) + 'KB';

function checkCwebp() {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error('cwebp not found on PATH. Install libwebp first.');
    process.exit(1);
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Resolve [{ file, out }] from input path + --out
async function resolveJobs(input, out, recursive) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input not found: ${input}`);

  if (stat.isFile()) {
    if (!EXTS.has(path.extname(input).toLowerCase())) {
      throw new Error('Input must be .png, .jpg or .jpeg');
    }
    const defaultOut = input.replace(/\.[^.]+$/, '.webp');
    let outPath;
    if (!out) outPath = defaultOut;
    else if (out.toLowerCase().endsWith('.webp')) outPath = out;
    else outPath = path.join(out, path.basename(defaultOut));
    return [{ file: input, out: outPath }];
  }

  const pattern = recursive ? `**/*.${EXT_GLOB}` : `*.${EXT_GLOB}`;
  const files = await fg(pattern, {
    cwd: input,
    absolute: false,
    caseSensitiveMatch: false,
    onlyFiles: true,
  });
  files.sort();
  const outDir = out ?? input;
  return files.map((rel) => ({
    file: path.join(input, rel),
    out: path.join(outDir, rel.replace(/\.[^.]+$/, '.webp')),
  }));
}

function encode(png, outPath, o) {
  return new Promise((resolve, reject) => {
    const args = ['-quiet', '-m', '6', '-af', '-mt', '-alpha_q', '100'];
    if (o.nearLossless != null) args.push('-near_lossless', String(o.nearLossless));
    else if (o.lossless) args.push('-lossless');
    else args.push('-q', String(o.quality));
    args.push('-o', outPath, '--', '-');

    const p = spawn('cwebp', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdin.on('error', () => {}); // EPIPE; real failure surfaces via exit code
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `cwebp exited ${code}`))
    );
    p.stdin.end(png);
  });
}

async function processFile({ file, out }, o) {
  const origSize = (await fs.stat(file)).size;

  // Decode to lossless PNG buffer (JPG decoded once, never recompressed)
  const src = await sharp(file).rotate().png({ compressionLevel: 0 }).toBuffer();
  const srcMeta = await sharp(src).metadata();

  // Background: corner sample, or user-supplied color
  let bg;
  let transparent = false;
  if (o.bg === 'auto') {
    const px = await sharp(src)
      .ensureAlpha()
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer();
    if (px[3] < 255) {
      transparent = true;
      bg = { r: 0, g: 0, b: 0, alpha: 0 };
    } else {
      bg = { r: px[0], g: px[1], b: px[2], alpha: 1 };
    }
  } else {
    bg = o.bg;
  }

  // Trim
  let trimmedBuf = src;
  let trimmed = true;
  try {
    const trimOpts = { threshold: o.threshold };
    if (!transparent) trimOpts.background = bg;
    trimmedBuf = await sharp(src).trim(trimOpts).png({ compressionLevel: 0 }).toBuffer();
  } catch {
    trimmed = false; // blank image or nothing to trim
  }
  const tMeta = await sharp(trimmedBuf).metadata();

  // Pad (uniform, % of longer side of trimmed image)
  const pad = Math.round((o.pad / 100) * Math.max(tMeta.width, tMeta.height));
  let finalBuf = trimmedBuf;
  if (pad > 0) {
    finalBuf = await sharp(trimmedBuf)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg })
      .png({ compressionLevel: 0 })
      .toBuffer();
  }
  const fMeta = await sharp(finalBuf).metadata();

  await fs.mkdir(path.dirname(out), { recursive: true });
  await encode(finalBuf, out, o);

  const newSize = (await fs.stat(out)).size;
  return {
    file,
    out,
    trimmed,
    pad,
    from: `${srcMeta.width}x${srcMeta.height}`,
    to: `${fMeta.width}x${fMeta.height}`,
    origSize,
    newSize,
  };
}

const program = new Command();
program
  .name('trimwebp')
  .description('Trim whitespace borders, add uniform padding, encode to WebP via cwebp')
  .argument('<input>', 'image file or folder')
  .option('-o, --out <path>', 'output folder (or .webp file path for a single input)')
  .option('-p, --pad <percent>', 'padding as % of longer side of trimmed image', num, 5)
  .option('-t, --threshold <n>', 'trim tolerance (0-255)', num, 10)
  .option('-b, --bg <color>', "border color: 'auto' (corner pixel), 'white', '#fff', ...", 'auto')
  .option('-q, --quality <n>', 'lossy quality 0-100', num, 90)
  .option('--lossless', 'lossless WebP')
  .option('--near-lossless <n>', 'near-lossless 0-100 (overrides -q)', num)
  .option('-r, --recursive', 'recurse into subfolders (folder input)')
  .option('-f, --overwrite', 'overwrite existing output files')
  .option('-c, --concurrency <n>', 'parallel jobs', num, Math.max(1, Math.floor(os.cpus().length / 2)))
  .action(async (input, o) => {
    checkCwebp();

    let jobs;
    try {
      jobs = await resolveJobs(input, o.out, o.recursive);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    if (!jobs.length) {
      console.error('No png/jpg/jpeg files found.');
      process.exit(1);
    }

    // Dedupe output collisions (a.png + a.jpg -> a.webp)
    const seen = new Set();
    jobs = jobs.filter((j) => {
      const key = path.resolve(j.out);
      if (seen.has(key)) {
        console.warn(`SKIP  ${j.file}  (output name collision: ${j.out})`);
        return false;
      }
      seen.add(key);
      return true;
    });

    const limit = pLimit(Math.max(1, o.concurrency));
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let totalOrig = 0;
    let totalNew = 0;

    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          if (!o.overwrite && (await exists(job.out))) {
            skipped++;
            console.log(`SKIP  ${job.out}  (exists, use --overwrite)`);
            return;
          }
          try {
            const r = await processFile(job, o);
            ok++;
            totalOrig += r.origSize;
            totalNew += r.newSize;
            const saved = Math.round((1 - r.newSize / r.origSize) * 100);
            console.log(
              `OK    ${path.basename(r.file)}  ${r.from} -> ${r.to}  pad ${r.pad}px  ` +
                `${kb(r.origSize)} -> ${kb(r.newSize)} (${saved >= 0 ? '-' : '+'}${Math.abs(saved)}%)` +
                (r.trimmed ? '' : '  [not trimmed]')
            );
          } catch (e) {
            failed++;
            console.error(`FAIL  ${job.file}  ${e.message}`);
          }
        })
      )
    );

    console.log(
      `\nDone: ${ok} ok, ${skipped} skipped, ${failed} failed` +
        (ok ? `  |  ${kb(totalOrig)} -> ${kb(totalNew)}` : '')
    );
    if (failed) process.exit(1);
  });

program.parseAsync().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
