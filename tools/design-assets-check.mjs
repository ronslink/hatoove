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
 *   6. (D6) EVERY font in `fonts/` has an OFL notice in `licences/` — not only the ones the manifest
 *      happens to list, so a font cannot be added later without its licence
 *   7. (D7) the coverage fonts really do map the codepoints their language needs, read out of each
 *      font's own `cmap` table
 *
 * DISCRIMINATION (X1, X2): a tampered copy of the curated set must FAIL leg 2, and removing a
 * codepoint from a font must FAIL leg 7. Without them those legs could pass on any bytes at all.
 *
 * WHAT THIS DOES NOT PROVE
 *   that anything renders. This is a bytes-and-licences check. Rendered evidence at 390 px in both
 *   themes, Arabic shaping and joining, right-to-left behaviour, and real-device behaviour remain
 *   open, and no view has been built from these assets yet. Leg 7 proves which codepoints a font
 *   DECLARES a glyph for; a `cmap` is a lookup table, not a rendering.
 *
 * Usage: node tools/design-assets-check.mjs
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCmapCodePoints, readFontTables, readNameRecords, toUnicodeRange } from './lib/sfnt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'work', 'implementation', 'DESIGN-REFERENCE-MANIFEST.json');
const CURATED = path.join(ROOT, 'public', 'assets', 'design');
const REFERENCE = path.join(ROOT, 'work', 'design-reference');

/** The design language's load-bearing tokens. A view that cannot see these is not the design. */
const REQUIRED_TOKENS = [
  '--orange', '--orange-dark', '--ink', '--muted', '--line', '--paper', '--canvas', '--card',
  '--display', '--font', '--r', '--shadow',
];

/**
 * D7 — what each coverage font is here to do, and the codepoints that make it true.
 *
 * The product agreed on de/en/uk/ar/tr explanation languages, and the two fonts the supplied design
 * gave us cannot render three of them: measured at 231 and 226 mapped codepoints, with no Cyrillic,
 * no Arabic, and `ı` but not `ĞğİŞş`. These three files are the fix, so each one names the letters
 * its language actually needs. `mustMap` is the strings a Ukrainian, Turkish, German or Arabic
 * explanation cannot be written without — not a codepoint count, which a font could inflate with
 * anything.
 */
const FONT_COVERAGE = {
  'noto-sans-latin-ext.woff2': {
    languages: ['de', 'en', 'tr'],
    family: 'Noto Sans',
    mustMap: 'äöüßÄÖÜQqWwZzĞğİıŞşÇçÖöÜü',
  },
  'noto-sans-cyrillic.woff2': {
    languages: ['uk'],
    family: 'Noto Sans',
    mustMap: 'АБВГҐДЕЄЖЗИІЇЙЛМНОПРСТУФХЦЧШЩЬЮЯабвгґдеєжзиіїйклмнопрстуфхцчшщьюя',
  },
  'noto-sans-arabic.woff2': {
    languages: ['ar'],
    family: 'Noto Sans Arabic',
    mustMap: 'ابتثجحخدذرزشصضطظعغفقكلمنهويءآأإئؤىةًٌٍَُِّْ٠١٢٣٤٥٦٧٨٩',
  },
};

/** The `lang` attributes `hatoove.css` builds a font stack for, and the family that stack names. */
const LANGUAGE_STACK = {
  uk: 'Noto Sans',
  ar: 'Noto Sans Arabic',
  tr: 'Noto Sans',
};

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

/** Normalise a family or file name so `source-sans-3` and `SourceSans3` are the same key. */
export function licenceKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Every `.woff2` in `fonts/` that does NOT have an OFL notice naming it in `licences/`.
 *
 * Shared by D3 (the manifest's fonts) and D6 (every font actually on disk). Matching is on the
 * normalised name, so `source-sans-3` finds `OFL-SourceSans3.txt` and a notice is never "missing"
 * merely because of capitalisation or dashes.
 */
export function findUnlicensedFonts(fontFiles, noticeDir) {
  const notices = existsSync(noticeDir)
    ? readdirSync(noticeDir).map((name) => ({ name, key: licenceKey(name) }))
    : [];
  const problems = [];
  for (const font of fontFiles) {
    const base = path.basename(font, '.woff2');
    const key = licenceKey(base);
    const notice = notices.find((n) => n.key.includes(key));
    if (!notice) { problems.push(`${base}: no licence notice in licences/`); continue; }
    const text = readFileSync(path.join(noticeDir, notice.name), 'utf8');
    if (!/SIL Open Font License/i.test(text)) problems.push(`${base}: ${notice.name} is not an OFL notice`);
  }
  return problems;
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
  const problems = findUnlicensedFonts(fonts.map((f) => f.path), path.join(CURATED, 'licences'));
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

// D6 — EVERY font in `fonts/` has an OFL notice, not just the ones the manifest happens to list.
//
// D3 can only see fonts the manifest already names, so it cannot notice a new font arriving without
// its licence. This leg reads the directory, so adding a font without a notice turns the check red.
const fontsDir = path.join(CURATED, 'fonts');
const licencesDir = path.join(CURATED, 'licences');
const fontsOnDisk = existsSync(fontsDir)
  ? readdirSync(fontsDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.woff2')).map((e) => e.name).sort()
  : [];
if (!fontsOnDisk.length) {
  fail('D6-every-font-licensed', 'every font on disk has a matching OFL notice',
    `no .woff2 file under ${path.relative(ROOT, fontsDir)} — the curated fonts are missing entirely`);
} else {
  const unlicensed = findUnlicensedFonts(fontsOnDisk, licencesDir);
  const noticesOnDisk = existsSync(licencesDir)
    ? readdirSync(licencesDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
    : [];
  if (unlicensed.length) {
    fail('D6-every-font-licensed', 'every font on disk has a matching OFL notice', unlicensed.join('; '));
  } else {
    pass('D6-every-font-licensed', 'every font on disk has a matching OFL notice',
      `${fontsOnDisk.length} font(s) on disk [${fontsOnDisk.join(', ')}], each matched to one of `
      + `${noticesOnDisk.length} notice(s) by normalised name; a new font without a notice fails this leg`);
  }
}

// D7 — the coverage fonts map the codepoints their languages need, read from the font's own cmap.
//
// A header comment or a filename proves nothing here, so this leg decompresses the WOFF2 and reads
// the cmap subtable directly. It is still only a claim about the FONT, not about rendering: see the
// detail line, which says so, and the note at the top of this file.
const coverageProblems = [];
const coverageLines = [];
for (const [fontFile, spec] of Object.entries(FONT_COVERAGE)) {
  const full = path.join(fontsDir, fontFile);
  if (!existsSync(full)) { coverageProblems.push(`${fontFile}: missing`); continue; }
  try {
    const { tables, container } = readFontTables(full);
    const { codePoints, subtables } = readCmapCodePoints(tables.get('cmap'));
    const family = readNameRecords(tables.get('name')).get(1) || '';
    if (family !== spec.family) coverageProblems.push(`${fontFile}: name table says ${JSON.stringify(family)}, expected ${JSON.stringify(spec.family)}`);
    const missing = [...new Set([...spec.mustMap].filter((ch) => !codePoints.has(ch.codePointAt(0))))];
    if (missing.length) coverageProblems.push(`${fontFile}: no glyph for ${missing.map((c) => `${c} U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(', ')}`);
    coverageLines.push(`${fontFile} ${[...spec.languages].join('/')} ${codePoints.size} codepoints (${container})`);
    // The stylesheet has to name the family, or the font is present and never used.
    const css = readFileSync(path.join(CURATED, 'hatoove.css'), 'utf8');
    for (const lang of spec.languages) {
      const wanted = LANGUAGE_STACK[lang];
      if (!wanted) continue;
      const rule = new RegExp(`\\[lang=${lang}\\][^{]*\\{[^}]*${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (!rule.test(css)) coverageProblems.push(`hatoove.css has no font stack naming ${JSON.stringify(wanted)} for [lang=${lang}]`);
    }
    void subtables;
  } catch (error) {
    coverageProblems.push(`${fontFile}: ${error.message}`);
  }
}
if (coverageProblems.length) {
  fail('D7-coverage-proven', 'each coverage font maps the codepoints its language needs', coverageProblems.join('; '));
} else {
  pass('D7-coverage-proven', 'each coverage font maps the codepoints its language needs',
    `${coverageLines.join('; ')}. Read from each font's cmap table. This proves the FONT declares the `
    + 'glyphs; it does NOT prove rendering, Arabic shaping/joining or right-to-left layout.');
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

// X2 — DISCRIMINATION: D6 and D7 must both be able to fail.
if (!fontsOnDisk.length) {
  skip('X2-coverage-legs-can-fail', 'the licence and coverage legs can fail', 'no fonts on disk');
} else {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pilot08a-fonts-'));
  try {
    const problems = [];
    // (a) a font with no notice must be reported ...
    const unlicensed = findUnlicensedFonts(['a-font-that-has-no-notice.woff2'], licencesDir);
    if (!unlicensed.length) problems.push('a font with no notice passed D6');
    // (b) ... and the check must still accept a real font, so the rule is not "fail everything".
    const stillLicensed = findUnlicensedFonts(['noto-sans-arabic.woff2'], licencesDir);
    if (stillLicensed.length) problems.push(`a font that does have a notice was rejected: ${stillLicensed.join('; ')}`);
    // (c) D7 reads real bytes: a font whose cmap loses one codepoint must lose exactly that letter.
    const { tables } = readFontTables(path.join(fontsDir, 'noto-sans-arabic.woff2'));
    const { codePoints } = readCmapCodePoints(tables.get('cmap'));
    const stripped = new Set(codePoints);
    stripped.delete(0x0627); // ARABIC LETTER ALEF, which FONT_COVERAGE requires
    const missing = [...FONT_COVERAGE['noto-sans-arabic.woff2'].mustMap]
      .filter((ch) => !stripped.has(ch.codePointAt(0)));
    if (missing.length !== 1) problems.push(`removing U+0627 from the cmap did not make exactly one required letter missing (got ${missing.length})`);
    if (problems.length) fail('X2-coverage-legs-can-fail', 'the licence and coverage legs can fail', problems.join('; '));
    else pass('X2-coverage-legs-can-fail', 'the licence and coverage legs can fail',
      'a font without a notice is reported, a font with one is accepted, and dropping a codepoint from a real cmap removes exactly that letter');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const passed = results.filter((r) => r.outcome === 'PASS').length;
const skipped = results.filter((r) => r.outcome === 'SKIP').length;
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
