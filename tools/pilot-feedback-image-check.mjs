/*
 * PILOT-FEEDBACK-01 (slice FB-E) — what counts as an image.
 *
 * WHY THIS IS ITS OWN CHECK. `server/image-header.mjs` is pure, and an independent reviewer broke its first
 * version with four inputs that a reader would never think to try. Being pure, they cost nothing to pin:
 *
 *   * A HEADER-ONLY PNG. Twenty-four bytes carrying the magic and an IHDR were read as a 1280×720 image; the row
 *     would have been stored and later served as an image that does not exist.
 *   * A `VP8X` CANVAS CLAIMING 1 × 16 777 216. `0050`'s only height constraint is `height > 0`, so the absurd
 *     height would have been accepted.
 *   * A RIFF CLAIMING MORE BYTES THAN IT HAS — the format declares its own length, so the claim can be checked
 *     against the file rather than trusted.
 *   * A PNG DECLARED AS `image/webp`, which must be refused or the browser is told the wrong type.
 *
 * Usage: node tools/pilot-feedback-image-check.mjs   (exit 0 when every leg passes)
 */

import assert from 'node:assert/strict';

import { readImageHeader } from '../server/image-header.mjs';

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

/** A PNG with a real IHDR — and IEND only when asked for. */
function png({ withIend = true, width = 1280, height = 720, ihdrLength = 13 } = {}) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(ihdrLength, 8);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  if (!withIend) return head;
  const tail = Buffer.alloc(12);
  tail.write('IEND', 4, 'latin1');
  return Buffer.concat([head, tail]);
}

/** A `VP8X` extended WebP whose canvas is `width-1` × `height-1`, 24-bit little-endian. */
function vp8x({ width = 1200, height = 800, riffClaim = null } = {}) {
  const buffer = Buffer.alloc(40);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(riffClaim ?? 32, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8X', 12, 'latin1');
  const w = width - 1; const h = height - 1;
  buffer[24] = w & 0xff; buffer[25] = (w >> 8) & 0xff; buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff; buffer[28] = (h >> 8) & 0xff; buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

check('1. a header-only PNG is not an image', () => {
  assert.equal(readImageHeader(png({ withIend: false }), 'image/png'), null,
    'a buffer with the magic bytes and an IHDR but no IEND must be refused');
});

check('2. a real-shaped PNG is read correctly', () => {
  assert.deepEqual(readImageHeader(png(), 'image/png'), { mimeType: 'image/png', width: 1280, height: 720 });
});

check('3. an IHDR that lies about its own length is refused', () => {
  // The 4-byte length at offset 8 must be 13 for IHDR; if it says something else the offsets below are not
  // IHDR's fields at all.
  assert.equal(readImageHeader(png({ ihdrLength: 99 }), 'image/png'), null);
});

check('4. a PNG declared as image/webp is refused', () => {
  assert.equal(readImageHeader(png(), 'image/webp'), null, 'the declared type must agree with the bytes');
});

check('5. an impossible canvas is refused', () => {
  assert.deepEqual(readImageHeader(vp8x(), 'image/webp'), { mimeType: 'image/webp', width: 1200, height: 800 });
  assert.equal(readImageHeader(vp8x({ height: 16777216 }), 'image/webp'), null,
    'a 16 777 216 px tall canvas is not a screenshot, and 0050 would have stored it');
});

check('6. a RIFF is checked against its own declared length', () => {
  assert.equal(readImageHeader(vp8x({ riffClaim: 9999 }), 'image/webp'), null,
    'a file claiming more bytes than it contains is a header, not an image');
});

check('7. binaries that are not images at all are refused', () => {
  for (const [label, bytes] of [
    ['empty', Buffer.alloc(0)],
    ['too short', Buffer.from('RIFF')],
    ['plain text', Buffer.from('this is not an image, it is a sentence')],
    ['PNG magic only', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ]) assert.equal(readImageHeader(bytes, null), null, `${label} must be refused`);
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n---- pilot-feedback-image-check: ${results.length - failed.length}/${results.length} passed ----`);
if (failed.length) {
  for (const [name, , detail] of failed) console.log(`  FAIL  ${name}: ${detail}`);
  process.exit(1);
}
console.log('all legs passed');
