/*
 * VENDOR-INTEGRITY — every vendored browser asset is pinned to its digest, and carries its licence.
 *
 * WHY THIS EXISTS. The app makes no third-party request at runtime, which is a promise only as long as the
 * vendored files are the ones that were reviewed. A file in `public/assets/vendor/` is served to every learner;
 * if it changes, nothing else in this repository would notice — `repository-check` reads the tree, not digests,
 * and a browser check would happily run the altered code. This is the gate that notices.
 *
 * It also checks the LICENCE travels with the artifact, because "MIT" in a README is a claim and the licence
 * text in the tree is the attribution.
 *
 * Usage: node tools/vendor-integrity-check.mjs   (exit 0 when every pin matches)
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'public', 'assets', 'vendor');

/**
 * The pinned artifacts. A NEW VENDORED FILE MUST BE ADDED HERE — the last leg fails when a file appears that has
 * no pin, so a vendored script cannot arrive without its digest being recorded.
 */
const PINS = Object.freeze({
  'html-to-image-1.11.13.js': {
    sha256: 'abdfe5c7892cd049f6329c08a448e60191250e143a9b6207f0b643fb6e871728',
    licence: 'html-to-image-1.11.13.LICENSE.txt',
    package: 'html-to-image@1.11.13',
    // The global the UMD build exposes; the capture code depends on this name.
    exposes: 'htmlToImage',
  },
});

const results = [];
function check(name, run) {
  try {
    run();
    results.push([name, true, '']);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

check('1. every pinned vendored file matches its digest', () => {
  for (const [name, pin] of Object.entries(PINS)) {
    const file = path.join(VENDOR, name);
    assert.ok(statSync(file, { throwIfNoEntry: false })?.isFile(), `${name} is missing from public/assets/vendor`);
    const actual = sha256(file);
    assert.equal(actual, pin.sha256,
      `${name} changed: expected ${pin.sha256}, found ${actual}. Update the pin ONLY with the new artifact and its provenance in public/assets/vendor/README.md.`);
  }
});

check('2. each pinned artifact ships its licence text', () => {
  for (const [name, pin] of Object.entries(PINS)) {
    const licence = path.join(VENDOR, pin.licence);
    assert.ok(statSync(licence, { throwIfNoEntry: false })?.isFile(),
      `${name} has no ${pin.licence} beside it: attribution must travel with the artifact`);
    const text = readFileSync(licence, 'utf8');
    assert.ok(/MIT License/i.test(text), `${pin.licence} does not read as the MIT licence it is recorded as`);
    assert.ok(/Permission is hereby granted/i.test(text), `${pin.licence} is missing the grant paragraph`);
  }
});

check('3. every vendored file has a pin', () => {
  const present = readdirSync(VENDOR).filter((name) => name.endsWith('.js') || name.endsWith('.css'));
  const unpinned = present.filter((name) => !(name in PINS));
  assert.deepEqual(unpinned, [],
    `vendored file(s) with no digest pin: ${unpinned.join(', ')} — add them to PINS so a change cannot go unnoticed`);
});

check('4. the vendored capture library is the artifact the capture code expects', () => {
  for (const [name, pin] of Object.entries(PINS)) {
    const source = readFileSync(path.join(VENDOR, name), 'utf8');
    assert.ok(source.includes(pin.exposes), `${name} does not expose \`${pin.exposes}\`, so the capture code cannot use it`);
    // A vendored build must not reach the network: that would reintroduce the third-party origin vendoring exists
    // to avoid. Named hosts rather than a generic URL test, so a package's own error strings cannot false-positive.
    for (const cdn of ['unpkg.com', 'jsdelivr.net', 'cdnjs.cloudflare.com']) {
      assert.ok(!source.includes(cdn), `${name} references ${cdn}: a vendored asset must not fetch from a CDN`);
    }
    // The source-map reference was stripped on purpose; if it returns, the browser 404s for a file we do not ship.
    assert.ok(!source.includes('sourceMappingURL'), `${name} references a source map that is not vendored`);
  }
});

check('5. nothing in the shipped client reaches a CDN for this library', () => {
  const appDir = path.join(ROOT, 'public', 'app');
  const offenders = [];
  for (const entry of readdirSync(appDir)) {
    if (!/\.(js|html|css)$/.test(entry)) continue;
    const text = readFileSync(path.join(appDir, entry), 'utf8');
    if (text.includes('unpkg.com') || text.includes('jsdelivr.net') || text.includes('cdnjs.cloudflare.com')) {
      offenders.push(entry);
    }
  }
  assert.deepEqual(offenders, [], `the client references a CDN in: ${offenders.join(', ')}`);
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n---- vendor-integrity-check: ${results.length - failed.length}/${results.length} passed ----`);
if (failed.length) {
  for (const [name, , detail] of failed) console.log(`  FAIL  ${name}: ${detail}`);
  process.exit(1);
}
console.log('all legs passed');
