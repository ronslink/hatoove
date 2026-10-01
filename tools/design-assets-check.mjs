#!/usr/bin/env node
/**
 * PILOT-08a — the design foundation check.
 *
 * The supplied Hatoove design is the product's visual driver, but it lives in `/design/`, which
 * `.gitignore` excludes. So the driver was untracked, invisible to CI and to the remote workers,
 * and one disk failure from gone. `DESIGN-WIRE-01.md:12` promised to curate the assets into the
 * repository and then recorded that it had not: *"This planning change imports no assets."*
 *
 * This check makes the curation real and keeps it honest:
 *
 *   1. the curated design system is PRESENT at `public/assets/design/`
 *   2. every curated byte MATCHES the digest pinned in DESIGN-REFERENCE-MANIFEST.json, so what
 *      ships is provably the reviewed artifact and not a re-export
 *   3. every bundled font ships WITH its licence notice
 *   4. the token stylesheet still declares the design language's required tokens and dark theme
 *   5. the reference screens are imported to `work/design-reference/` so a remote worker can read
 *      them without a drive letter, and they are hash-pinned too
 *
 * DISCRIMINATION (X1): a tampered copy of the curated set must FAIL leg 2. Without it, leg 2 could
 * pass on any bytes at all.
 *
 * WHAT THIS DOES NOT PROVE
 *   that anything renders. This is a bytes-and-licences check. Rendered evidence at 390 px in both
 *   themes, real font glyph coverage (the supplied subsets cover neither Cyrillic nor Arabic) and
 *   real-device behaviour remain open, and no view has been built from these assets yet.
 *
 * Usage: node tools/design-assets-check.mjs
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'work', 'implementation', 'DESIGN-REFERENCE-MANIFEST.json');
const CURATED = path.join(ROOT, 'public', 'assets', 'design');
const REFERENCE = path.join(ROOT, 'work', 'design-reference');

/** The design language's load-bearing tokens. A view that cannot see these is not the design. */
const REQUIRED_TOKENS = [
  '--orange', '--orange-dark', '--ink', '--muted', '--line', '--paper', '--canvas', '--card',
  '--display', '--font', '--r', '--shadow',
];

const results = [];
function record(id, title, outcome, detail) {
  results.push({ id, outcome });
  console.log(`${outcome.padEnd(4)} ${id.padEnd(30)} ${title}`);
  if (detail) console.log(`     ${detail}`);
}
const pass = (id, title, detail) => record(id, title, 'PASS', detail);
const fail = (id, title, detail) => record(id, title, 'FAIL', detail);
const skip = (id, title, detail) => record(id, title, 'SKIP', detail);

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `assets/hatoove.css` -> `public/assets/design/hatoove.css`; `screens/x.html` -> reference. */
export function curatedPathFor(designPath) {
  return path.join(CURATED, designPath.replace(/^assets\//, ''));
}
export function referencePathFor(designPath) {
  return path.join(REFERENCE, designPath);
}

/** Every curated/reference file whose bytes differ from the pinned digest. */
export function findMismatches(entries, resolve) {
  const bad = [];
  for (const entry of entries) {
    const file = resolve(entry.path);
    if (!existsSync(file)) { bad.push({ path: entry.path, why: 'missing' }); continue; }
    const got = sha256(file);
    if (got !== String(entry.sha256).toLowerCase()) {
      bad.push({ path: entry.path, why: `digest ${got.slice(0, 12)} != pinned ${String(entry.sha256).slice(0, 12)}` });
    }
  }
  return bad;
}

console.log('\n=== PILOT-08a design foundation check ===\n');

if (!existsSync(MANIFEST)) {
  fail('D0-manifest', 'the design manifest exists', `missing ${path.relative(ROOT, MANIFEST)}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const assetEntries = manifest.files.filter((f) => f.path.startsWith('assets/'));
const screenEntries = manifest.files.filter((f) => f.path.startsWith('screens/') || f.path === 'index.html');

// D1 — the curated design system is present.
const absent = assetEntries.filter((e) => !existsSync(curatedPathFor(e.path)));
if (absent.length) {
  fail('D1-design-system-present', 'the curated design system is at public/assets/design/',
    `NOT CURATED: ${absent.length} of ${assetEntries.length} asset(s) absent (${absent.map((e) => e.path).join(', ')}). `
    + 'The design is the product\'s driver and it is currently untracked.');
} else {
  pass('D1-design-system-present', 'the curated design system is at public/assets/design/',
    `${assetEntries.length} curated file(s): ${assetEntries.map((e) => path.basename(e.path)).join(', ')}`);
}

// D2 — every curated byte matches the pinned digest. This is the leg X1 must be able to break.
let mismatches = [];
if (absent.length) {
  skip('D2-bytes-match-manifest', 'every curated byte matches the pinned digest', 'depends on D1');
} else {
  mismatches = findMismatches(assetEntries, curatedPathFor);
  if (mismatches.length) {
    fail('D2-bytes-match-manifest', 'every curated byte matches the pinned digest',
      mismatches.map((m) => `${m.path} (${m.why})`).join('; '));
  } else {
    pass('D2-bytes-match-manifest', 'every curated byte matches the pinned digest',
      `${assetEntries.length}/${assetEntries.length} match DESIGN-REFERENCE-MANIFEST.json`);
  }
}

// D3 — every bundled font ships with the licence notice that covers it.
if (absent.length) {
  skip('D3-font-licences', 'every bundled font ships with its licence notice', 'depends on D1');
} else {
  const fonts = assetEntries.filter((e) => e.path.endsWith('.woff2'));
  const licenceDir = path.join(CURATED, 'licences');
  const notices = existsSync(licenceDir)
    ? readdirSync(licenceDir).map((name) => ({ name, key: name.toLowerCase().replace(/[^a-z0-9]/g, '') }))
    : [];
  const problems = [];
  for (const font of fonts) {
    const base = path.basename(font.path, '.woff2');
    const key = base.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Match on the normalised name, so `source-sans-3` finds `OFL-SourceSans3.txt` and a licence
    // is never "missing" merely because of capitalisation or dashes.
    const notice = notices.find((n) => n.key.includes(key));
    if (!notice) { problems.push(`${base}: no licence notice in licences/`); continue; }
    const text = readFileSync(path.join(licenceDir, notice.name), 'utf8');
    if (!/SIL Open Font License/i.test(text)) problems.push(`${base}: ${notice.name} is not an OFL notice`);
  }
  if (problems.length) fail('D3-font-licences', 'every bundled font ships with its licence notice', problems.join('; '));
  else pass('D3-font-licences', 'every bundled font ships with its licence notice',
    `${fonts.length} font(s), each with an OFL notice naming its family`);
}

// D4 — the token stylesheet still declares the design language's tokens and dark theme.
if (absent.length) {
  skip('D4-tokens-declared', 'the token stylesheet declares the required tokens', 'depends on D1');
} else {
  const cssPath = path.join(CURATED, 'hatoove.css');
  if (!existsSync(cssPath)) {
    fail('D4-tokens-declared', 'the token stylesheet declares the required tokens', 'public/assets/design/hatoove.css is absent');
  } else {
    const css = readFileSync(cssPath, 'utf8');
    const missing = REQUIRED_TOKENS.filter((t) => !new RegExp(`${t}\\s*:`).test(css));
    const hasDark = /prefers-color-scheme\s*:\s*dark/.test(css);
    if (missing.length) fail('D4-tokens-declared', 'the token stylesheet declares the required tokens', `missing: ${missing.join(', ')}`);
    else if (!hasDark) fail('D4-tokens-declared', 'the token stylesheet declares the required tokens', 'no prefers-color-scheme:dark block');
    else pass('D4-tokens-declared', 'the token stylesheet declares the required tokens',
      `${REQUIRED_TOKENS.length} tokens present; dark theme present; ${(css.match(/@font-face/g) || []).length} @font-face rule(s)`);
  }
}

// D5 — the reference screens are importable by a remote worker, and pinned like the assets.
if (!screenEntries.length) {
  skip('D5-reference-present', 'the reference screens are imported and pinned', 'manifest lists no screens');
} else {
  const bad = findMismatches(screenEntries, referencePathFor);
  if (bad.length) {
    fail('D5-reference-present', 'the reference screens are imported and pinned',
      `${bad.length} of ${screenEntries.length} not imported or changed: ${bad.slice(0, 4).map((b) => `${b.path} (${b.why})`).join('; ')}`
      + (bad.length > 4 ? ` … +${bad.length - 4}` : ''));
  } else {
    pass('D5-reference-present', 'the reference screens are imported and pinned',
      `${screenEntries.length} reference file(s) under work/design-reference/, every digest matching`);
  }
}

// X1 — DISCRIMINATION: a tampered copy of the curated set must fail D2's assertion.
if (absent.length) {
  skip('X1-tamper-detected', 'a tampered asset fails the digest leg', 'depends on D1');
} else {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pilot08a-'));
  try {
    const target = assetEntries.find((e) => e.path.endsWith('.css')) || assetEntries[0];
    const rel = target.path.replace(/^assets\//, '');
    const copy = path.join(scratch, rel);
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(curatedPathFor(target.path), copy);
    appendFileSync(copy, '\n/* one appended byte: the reviewed artifact is now different */\n');
    const caught = findMismatches([target], (p) => path.join(scratch, p.replace(/^assets\//, '')));
    if (caught.length === 1) pass('X1-tamper-detected', 'a tampered asset fails the digest leg', `${target.path} appended to -> detected`);
    else fail('X1-tamper-detected', 'a tampered asset fails the digest leg', 'a modified copy passed the digest comparison — the leg cannot fail');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const passed = results.filter((r) => r.outcome === 'PASS').length;
const skipped = results.filter((r) => r.outcome === 'SKIP').length;
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
