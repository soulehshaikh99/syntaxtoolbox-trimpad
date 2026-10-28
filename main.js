#!/usr/bin/env node
import * as p from '@clack/prompts';
import { Command, Option } from 'commander';
import fg from 'fast-glob';
import pLimit from 'p-limit';
import sharp from 'sharp';
import { spawn, execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXT_GLOB = '{png,jpg,jpeg}';
const EXTS = new Set(['.png', '.jpg', '.jpeg']);
const FORMATS = ['same', 'webp', 'png', 'jpg', 'avif'];
const FORMAT_EXT = { webp: '.webp', png: '.png', jpg: '.jpg', avif: '.avif' };
const EXT_FORMAT = { '.webp': 'webp', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.avif': 'avif' };
// Added when the output would land on its own source (same format, same folder)
const SUFFIX = '.trim';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !p.isCI();

const num = (v) => {
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Not a number: ${v}`);
  return n;
};

const kb = (b) => (b / 1024).toFixed(1) + 'KB';

const extOf = (f) => path.extname(f).toLowerCase();

const samePath = (a, b) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

function checkCwebp() {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
  } catch {
    p.log.error('cwebp not found on PATH. Install libwebp first (needed for WebP output).');
    process.exit(1);
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// Output path for one source file: swap extension, then suffix if it would overwrite the source
function outFor(file, outFile, fmt) {
  const ext = fmt === 'same' ? path.extname(file) : FORMAT_EXT[fmt];
  let out = outFile.replace(/\.[^.]+$/, ext);
  if (samePath(out, file)) out = out.replace(/(\.[^.]+)$/, `${SUFFIX}$1`);
  return { file, out, format: fmt === 'same' ? EXT_FORMAT[extOf(file)] : fmt };
}

// Resolve [{ file, out, format }] from input path + --out + --format (undefined = not given)
async function resolveJobs(input, out, recursive, format) {
  const stat = await fs.stat(input).catch(() => null);
  if (!stat) throw new Error(`Input not found: ${input}`);

  if (stat.isFile()) {
    if (!EXTS.has(extOf(input))) {
      throw new Error('Input must be .png, .jpg or .jpeg');
    }
    // --out with an image extension is a file path; its extension picks the format if -F not given
    const outFmt = out && EXT_FORMAT[extOf(out)];
    if (outFmt) {
      const want = format === 'same' ? EXT_FORMAT[extOf(input)] : format;
      if (want && want !== outFmt) {
        throw new Error(`--out extension ${extOf(out)} does not match --format ${format}`);
      }
      const outPath = samePath(out, input) ? out.replace(/(\.[^.]+)$/, `${SUFFIX}$1`) : out;
      return [{ file: input, out: outPath, format: outFmt }];
    }
    const base = out ? path.join(out, path.basename(input)) : input;
    return [outFor(input, base, format ?? 'same')];
  }

  const pattern = recursive ? `**/*.${EXT_GLOB}` : `*.${EXT_GLOB}`;
  const files = await fg(pattern, {
    cwd: input,
    absolute: false,
    caseSensitiveMatch: false,
    onlyFiles: true,
    ignore: [`**/*${SUFFIX}.*`], // our own same-format outputs
  });
  files.sort();
  const outDir = out ?? input;
  return files.map((rel) => outFor(path.join(input, rel), path.join(outDir, rel), format ?? 'same'));
}

function encodeWebp(png, outPath, o) {
  return new Promise((resolve, reject) => {
    const args = ['-quiet', '-m', '6', '-af', '-mt', '-alpha_q', '100'];
    if (o.nearLossless != null) args.push('-near_lossless', String(o.nearLossless));
    else if (o.lossless) args.push('-lossless');
    else args.push('-q', String(o.quality));
    args.push('-o', outPath, '--', '-');

    const proc = spawn('cwebp', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.stdin.on('error', () => {}); // EPIPE; real failure surfaces via exit code
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `cwebp exited ${code}`))
    );
    proc.stdin.end(png);
  });
}

async function encode(buf, outPath, format, flatBg, o) {
  switch (format) {
    case 'webp':
      return encodeWebp(buf, outPath, o);
    case 'png':
      return sharp(buf).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(outPath);
    case 'jpg':
      // JPG has no alpha: flatten onto the border color
      return sharp(buf).flatten({ background: flatBg }).jpeg({ quality: o.quality, mozjpeg: true }).toFile(outPath);
    case 'avif':
      return sharp(buf).avif({ quality: o.quality, lossless: Boolean(o.lossless) }).toFile(outPath);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

async function processFile({ file, out, format }, o) {
  const origSize = (await fs.stat(file)).size;

  // Decode to lossless PNG buffer (source decoded once; only the final encode is lossy)
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
  await encode(finalBuf, out, format, transparent ? '#ffffff' : bg, o);

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

// Unwrap a clack answer; Ctrl+C / Esc exits
async function ask(prompt) {
  const v = await prompt;
  if (p.isCancel(v)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return v;
}

const numIn = (lo, hi) => (v) => {
  const n = Number(v);
  if (v === '' || v == null || Number.isNaN(n) || n < lo || n > hi) return `Enter a number ${lo}-${hi}`;
};

// Interactive wizard: fills in whatever was not passed as a flag
async function wizard(o, given) {
  const input = await ask(
    p.path({
      message: 'Input image or folder',
      root: process.cwd(),
      validate: (v) => {
        if (!v) return 'Required';
        const st = fsSync.statSync(v, { throwIfNoEntry: false });
        if (!st) return 'Not found';
        if (st.isFile() && !EXTS.has(extOf(v))) return 'Must be .png, .jpg, .jpeg or a folder';
      },
    })
  );

  if (fsSync.statSync(input).isDirectory() && !given('recursive')) {
    o.recursive = await ask(p.confirm({ message: 'Include subfolders?', initialValue: false }));
  }

  if (!given('format')) {
    o.format = await ask(
      p.select({
        message: 'Output format',
        initialValue: 'same',
        options: [
          { value: 'same', label: 'Same as input', hint: 'png -> png, jpg -> jpg' },
          { value: 'webp', label: 'WebP', hint: 'cwebp' },
          { value: 'png', label: 'PNG', hint: 'lossless' },
          { value: 'jpg', label: 'JPG', hint: 'transparency flattened onto background' },
          { value: 'avif', label: 'AVIF' },
        ],
      })
    );
  }

  const fmt = o.format;
  if ((fmt === 'webp' || fmt === 'avif') && !given('lossless') && !given('nearLossless')) {
    const mode = await ask(
      p.select({
        message: 'Compression',
        initialValue: 'lossy',
        options: [
          { value: 'lossy', label: 'Lossy', hint: 'quality setting' },
          { value: 'lossless', label: 'Lossless' },
          ...(fmt === 'webp' ? [{ value: 'near', label: 'Near-lossless' }] : []),
        ],
      })
    );
    if (mode === 'lossless') o.lossless = true;
    if (mode === 'near') {
      o.nearLossless = Number(
        await ask(p.text({ message: 'Near-lossless level (0-100)', initialValue: '60', validate: numIn(0, 100) }))
      );
    }
  }

  const lossy = fmt !== 'png' && !o.lossless && o.nearLossless == null;
  if (lossy && !given('quality')) {
    o.quality = Number(
      await ask(
        p.text({
          message: fmt === 'same' ? 'Quality 0-100 (applies to JPG sources)' : 'Quality (0-100)',
          initialValue: String(o.quality),
          validate: numIn(0, 100),
        })
      )
    );
  }

  if (!given('out')) {
    const out = await ask(
      p.text({ message: 'Output folder', placeholder: 'blank = beside source', defaultValue: '' })
    );
    o.out = out.trim() || undefined;
  }

  const advanced = await ask(
    p.confirm({ message: 'Adjust padding, trim tolerance, background, concurrency?', initialValue: false })
  );
  if (advanced) {
    if (!given('pad')) {
      o.pad = Number(await ask(p.text({ message: 'Padding (% of longer side)', initialValue: String(o.pad), validate: numIn(0, 1000) })));
    }
    if (!given('threshold')) {
      o.threshold = Number(await ask(p.text({ message: 'Trim tolerance (0-255)', initialValue: String(o.threshold), validate: numIn(0, 255) })));
    }
    if (!given('bg')) {
      o.bg = (await ask(p.text({ message: "Border color ('auto', 'white', '#fff', ...)", initialValue: o.bg }))).trim() || 'auto';
    }
    if (!given('concurrency')) {
      o.concurrency = Number(await ask(p.text({ message: 'Parallel jobs', initialValue: String(o.concurrency), validate: numIn(1, 256) })));
    }
  }

  return input;
}

function settingsNote(input, o, jobs) {
  const fmt = o.format === 'same' ? 'same as input' : o.format;
  const comp = o.nearLossless != null ? `near-lossless ${o.nearLossless}` : o.lossless ? 'lossless' : `q ${o.quality}`;
  return [
    `Input:   ${input}${o.recursive ? ' (recursive)' : ''}`,
    `Output:  ${o.out ?? 'beside source'}`,
    `Format:  ${fmt}${o.format === 'png' ? '' : `, ${comp}`}`,
    `Pad ${o.pad}%  threshold ${o.threshold}  bg ${o.bg}  jobs ${o.concurrency}`,
    `Files:   ${jobs.length}`,
  ].join('\n');
}

const program = new Command();
program
  .name('trimpad')
  .description('Trim whitespace borders, add uniform padding, re-encode (same format, WebP, PNG, JPG or AVIF)')
  .argument('[input]', 'image file or folder (omit to run interactively)')
  .option('-o, --out <path>', 'output folder (or output file path for a single input)')
  .addOption(new Option('-F, --format <fmt>', 'output format (default: same)').choices(FORMATS))
  .option('-p, --pad <percent>', 'padding as % of longer side of trimmed image', num, 5)
  .option('-t, --threshold <n>', 'trim tolerance (0-255)', num, 10)
  .option('-b, --bg <color>', "border color: 'auto' (corner pixel), 'white', '#fff', ...", 'auto')
  .option('-q, --quality <n>', 'lossy quality 0-100 (webp, jpg, avif)', num, 90)
  .option('--lossless', 'lossless (webp, avif)')
  .option('--near-lossless <n>', 'near-lossless 0-100, webp only (overrides -q)', num)
  .option('-r, --recursive', 'recurse into subfolders (folder input)')
  .option('-f, --overwrite', 'overwrite existing output files')
  .option('-c, --concurrency <n>', 'parallel jobs', num, Math.max(1, Math.floor(os.cpus().length / 2)))
  .action(async (input, o, cmd) => {
    const given = (k) => cmd.getOptionValueSource(k) === 'cli';
    const wizardMode = !input;

    if (wizardMode && !interactive) cmd.error("error: missing required argument 'input'");

    p.intro('trimpad');
    if (wizardMode) input = await wizard(o, given);

    let jobs;
    try {
      jobs = await resolveJobs(input, o.out, o.recursive, o.format);
    } catch (e) {
      p.cancel(e.message);
      process.exit(1);
    }
    o.format ??= 'same';
    if (!jobs.length) {
      p.cancel('No png/jpg/jpeg files found.');
      process.exit(1);
    }

    // Dedupe output collisions (a.png + a.jpg -> a.webp)
    const seen = new Set();
    jobs = jobs.filter((j) => {
      const key = path.resolve(j.out).toLowerCase();
      if (seen.has(key)) {
        p.log.warn(`SKIP  ${j.file}  (output name collision: ${j.out})`);
        return false;
      }
      seen.add(key);
      return true;
    });

    if (jobs.some((j) => j.format === 'webp')) checkCwebp();

    if (wizardMode) {
      p.note(settingsNote(input, o, jobs), 'Settings');
      if (!(await ask(p.confirm({ message: 'Start?' })))) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
    }

    // Existing outputs: ask once when a human is at the terminal, else skip (as before)
    let skipped = 0;
    if (!o.overwrite) {
      const existing = new Set();
      for (const j of jobs) if (await exists(j.out)) existing.add(j);
      if (existing.size) {
        let mode = 'skip';
        if (interactive) {
          mode = await ask(
            p.select({
              message: `${existing.size} output file(s) already exist`,
              options: [
                { value: 'skip', label: 'Skip existing' },
                { value: 'overwrite', label: 'Overwrite all' },
                { value: 'cancel', label: 'Cancel' },
              ],
            })
          );
          if (mode === 'cancel') {
            p.cancel('Cancelled.');
            process.exit(0);
          }
        }
        if (mode === 'skip') {
          for (const j of existing) p.log.warn(`SKIP  ${j.out}  (exists${interactive ? '' : ', use --overwrite'})`);
          skipped = existing.size;
          jobs = jobs.filter((j) => !existing.has(j));
        }
      }
    }

    const limit = pLimit(Math.max(1, o.concurrency));
    let ok = 0;
    let failed = 0;
    let totalOrig = 0;
    let totalNew = 0;

    // TTY: progress bar, per-file lines afterwards. Non-TTY: lines as they finish.
    const bar = interactive && jobs.length ? p.progress({ max: jobs.length }) : null;
    const lines = [];
    const emit = (kind, msg) => (bar ? lines.push([kind, msg]) : p.log[kind](msg));
    bar?.start(`Processing ${jobs.length} file(s)`);

    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          try {
            const r = await processFile(job, o);
            ok++;
            totalOrig += r.origSize;
            totalNew += r.newSize;
            const saved = Math.round((1 - r.newSize / r.origSize) * 100);
            emit(
              'success',
              `${path.basename(r.file)} -> ${path.basename(r.out)}  ${r.from} -> ${r.to}  pad ${r.pad}px  ` +
                `${kb(r.origSize)} -> ${kb(r.newSize)} (${saved >= 0 ? '-' : '+'}${Math.abs(saved)}%)` +
                (r.trimmed ? '' : '  [not trimmed]')
            );
          } catch (e) {
            failed++;
            emit('error', `FAIL  ${job.file}  ${e.message}`);
          }
          bar?.advance(1, path.basename(job.file));
        })
      )
    );

    bar?.stop(`Processed ${jobs.length} file(s)`);
    for (const [kind, msg] of lines) p.log[kind](msg);

    p.outro(
      `Done: ${ok} ok, ${skipped} skipped, ${failed} failed` +
        (ok ? `  |  ${kb(totalOrig)} -> ${kb(totalNew)}` : '')
    );
    if (failed) process.exit(1);
  });

program.parseAsync().catch((e) => {
  p.log.error(e.message);
  process.exit(1);
});
