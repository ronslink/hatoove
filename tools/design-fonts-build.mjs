#!/usr/bin/env node
/**
 * Regenerate the bundled script-coverage fonts.
 *
 * `public/assets/design/fonts/` ships two fonts the supplied design gave us — Source Sans 3 and
 * Bricolage Grotesque — whose subsets cover Latin-1 at best. Measured, they map 231 and 226
 * codepoints: no Cyrillic, no Arabic, and they carry `ı` without `ĞğİŞş`. So Ukrainian, Arabic and
 * Turkish explanations could not render at all.
 *
 * This script rebuilds the coverage fonts from the pinned upstream Google Fonts sources. It is a
 * RECORD OF HOW THE SHIPPED BYTES WERE MADE, not a step in any check or build: the committed
 * `.woff2` files are the artifact, and `tools/design-assets-check.mjs` verifies them from their
 * cmap tables without needing Python.
 *
 * Requirements: Python 3 with `fonttools` and `brotli` (`python -m pip install fonttools brotli`).
 * The script installs nothing on the Node side.
 *
 * Usage: node tools/design-fonts-build.mjs [--out <dir>]
 *   Without --out it writes into a scratch directory and reports the hashes, so it never silently
 *   overwrites the committed artifacts. Pass --out public/assets/design/fonts to refresh them, then
 *   update public/assets/design/PROVENANCE.md with the new hashes it prints.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH
 *   It establishes exactly which upstream bytes were used and which codepoints survive subsetting —
 *   both are asserted below from the fonts' own cmap tables. It does not establish that anything
 *   renders, that Arabic shapes correctly, or that RTL layout is right. Those need a browser.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFontTables, readCmapCodePoints, readNameRecords } from './lib/sfnt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pinned google/fonts commit. Every source URL below is fetched at this exact revision. */
const UPSTREAM_COMMIT = '9710da1eacb3be272583c3224dcb70f9da6eadbb';
const RAW = `https://raw.githubusercontent.com/google/fonts/${UPSTREAM_COMMIT}`;

const SOURCES = [
  {
    url: `${RAW}/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf`,
    file: 'NotoSans[wdth,wght].ttf',
    sha256: 'bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d',
  },
  {
    url: `${RAW}/ofl/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf`,
    file: 'NotoSansArabic[wdth,wght].ttf',
    sha256: '63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e',
  },
];

// Ranges chosen from the languages the product agreed on, per MFP-DESIGN-DECISIONS.md
// "Asset and CSS foundation": de/en/uk/ar/tr.
const RANGES = {
  latin: 'U+0000-024F,U+0259,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,'
    + 'U+1E00-1EFF,U+2018-2019,U+201C-201D,U+2020-2026,U+2030,U+2039-203A,U+20AC,U+2122,'
    + 'U+2190-2193,U+2212,U+2215,U+FEFF,U+FFFD',
  cyrillic: 'U+0301,U+0400-045F,U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,'
    + 'U+FE2E-FE2F,U+2018-2019,U+201C-201D,U+2020-2026',
  arabic: 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,'
    + 'U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC',
};

/** The codepoints each shipped font must be able to map, as evidence for its language. */
const REQUIRED = {
  'noto-sans-latin-ext.woff2': {
    languages: ['de', 'en', 'tr'],
    mustMap: 'äöüßÄÖÜQqWwZzĞğİıŞşÇçÖöÜü',
  },
  'noto-sans-cyrillic.woff2': {
    languages: ['uk'],
    mustMap: 'АБВГҐДЕЄЖИІЇЙЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюя',
  },
  'noto-sans-arabic.woff2': {
    languages: ['ar'],
    mustMap: 'ابتثجحخدذرزشصضطظعغفقكلمنهويءآأإئؤىةًٌٍَُِّْ٠١٢٣٤٥٦٧٨٩',
  },
};

function python(args) {
  execFileSync('python', args, { cwd: ROOT, stdio: 'inherit' });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const outFlag = process.argv.indexOf('--out');
const outDir = outFlag === -1
  ? mkdtempSync(path.join(os.tmpdir(), 'hatoove-fonts-'))
  : path.resolve(ROOT, process.argv[outFlag + 1]);
mkdirSync(outDir, { recursive: true });
const workDir = mkdtempSync(path.join(os.tmpdir(), 'hatoove-fonts-src-'));

console.log(`\n=== coverage fonts: pinned google/fonts @ ${UPSTREAM_COMMIT} ===`);
console.log(`scratch: ${workDir}`);
console.log(`output:  ${outDir}\n`);

// 1. Fetch each pinned source and refuse to continue if it is not the byte-identical file.
for (const source of SOURCES) {
  const dest = path.join(workDir, source.file);
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  const got = sha256(dest);
  if (got !== source.sha256) {
    throw new Error(`${source.file}: upstream bytes changed (${got} != pinned ${source.sha256}). `
      + 'Do not proceed: the pin, not the network, decides what ships.');
  }
  console.log(`source  ${source.file}  ${buf.length} bytes  sha256 ok`);
}

// 2. Keep only the weight axis. The design language asks for 200-900; the width axis is unused.
const wght = {};
for (const source of SOURCES) {
  const base = source.file.split('[')[0];
  const dest = path.join(workDir, `${base}-wght.ttf`);
  python(['-m', 'fontTools.varLib.instancer', path.join(workDir, source.file), 'wdth=100', 'wght=200:900', '--output', dest]);
  wght[base] = dest;
  console.log(`axis    ${path.basename(dest)}  ${readFileSync(dest).length} bytes`);
}

// 3. Subset to the language ranges and emit woff2. Latin and Cyrillic drop every layout feature —
//    nothing in either script needs contextual shaping. Arabic keeps all of them: `init`, `medi`,
//    `fina`, `isol`, `rlig`, `calt` and `mark` are what make the script render as Arabic at all.
const JOBS = [
  { src: wght.NotoSans, dest: 'noto-sans-latin-ext.woff2', unicodes: RANGES.latin, features: ',' },
  { src: wght.NotoSans, dest: 'noto-sans-cyrillic.woff2', unicodes: RANGES.cyrillic, features: ',' },
  { src: wght.NotoSansArabic, dest: 'noto-sans-arabic.woff2', unicodes: RANGES.arabic, features: '*' },
];

const produced = [];
for (const job of JOBS) {
  const dest = path.join(outDir, job.dest);
  python([
    '-m', 'fontTools.subset', job.src,
    `--output-file=${dest}`,
    '--flavor=woff2',
    `--unicodes=${job.unicodes}`,
    `--layout-features=${job.features}`,
    '--name-IDs=1,2,3,4,5,6,16,17',
    '--name-languages=0x409',
    '--no-hinting',
    '--desubroutinize',
    '--drop-tables+=DSIG',
    '--recalc-bounds',
    '--notdef-outline',
  ]);
  produced.push(dest);
  console.log(`font    ${job.dest}  ${readFileSync(dest).length} bytes`);
}

// 4. Assert from the fonts' own cmap tables that the codepoints the languages need are really there.
console.log('\n--- coverage asserted from each font\'s own cmap ---');
let failed = 0;
for (const file of produced) {
  const name = path.basename(file);
  const { tables } = readFontTables(file);
  const { codePoints } = readCmapCodePoints(tables.get('cmap'));
  const names = readNameRecords(tables.get('name'));
  const spec = REQUIRED[name];
  if (!spec) { console.log(`  ${name}: no expectation recorded`); continue; }
  const missing = [...spec.mustMap].filter((ch) => !codePoints.has(ch.codePointAt(0)));
  const status = missing.length === 0 ? 'ok' : `MISSING ${[...new Set(missing)].join('')}`;
  if (missing.length) failed += 1;
  console.log(`  ${name.padEnd(28)} family=${JSON.stringify(names.get(1))} codepoints=${codePoints.size} `
    + `[${spec.languages.join('/')}] ${status}`);
}

console.log('');
for (const file of produced) {
  console.log(`${path.basename(file)}\t${readFileSync(file).length}\tsha256 ${sha256(file)}`);
}
if (failed) {
  console.log(`\n${failed} font(s) do not map every required codepoint. Do not ship these.\n`);
  process.exit(1);
}
console.log('\nAll coverage assertions passed.');
console.log('These bytes are NOT proven to render, to shape Arabic, or to lay out right-to-left.');
console.log(`Set --out public/assets/design/fonts to replace the committed fonts, then update`);
console.log('public/assets/design/PROVENANCE.md with the hashes above.\n');
