/**
 * A minimal read-only sfnt reader: enough to list a font's tables, read its `name` records and read
 * the codepoints its `cmap` maps.
 *
 * It handles both a raw TTF/OTF and a WOFF2 file. WOFF2 keeps every table in one Brotli stream, so
 * reading `cmap` means parsing the table directory and decompressing that stream. The WOFF2
 * glyf/loca/hmtx pre-processing transforms are deliberately NOT reversed: nothing here needs
 * outlines, and `cmap`, `name` and `head` are never transformed.
 *
 * WHY THIS EXISTS
 *   Leg D7 of `tools/design-assets-check.mjs` has to answer "can this font actually show Ukrainian,
 *   Arabic and Turkish?" from the shipped bytes. Asking the operating system, or asserting that a
 *   file exists, answers a different question. So the check reads the font's own `cmap` table.
 *
 * This proves which codepoints a font declares a glyph for. It does NOT prove that any of them
 * render, that Arabic joins correctly, or that a layout is right-to-left: a cmap is a lookup table,
 * not a rendering.
 */

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

/** WOFF2 §4.1 "Known Table Tags", index 0..62. Index 63 means an explicit 4-byte tag follows. */
export const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

/** WOFF2 §4.1: transform version 3 is the null transform for glyf/loca, version 0 for everything else. */
export function isNullTransform(tag, version) {
  return tag === 'glyf' || tag === 'loca' ? version === 3 : version === 0;
}

function readUIntBase128(buf, pos) {
  let accum = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf[pos.o];
    pos.o += 1;
    if (i === 0 && byte === 0x80) throw new Error('UIntBase128 with a leading zero byte');
    if (accum > 0x1ffffff) throw new Error('UIntBase128 overflow');
    accum = accum * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return accum;
  }
  throw new Error('UIntBase128 longer than 5 bytes');
}

/**
 * Read a font file's tables.
 * `tables` maps a 4-character tag to its bytes, or to `null` for a table WOFF2 stored in a
 * transformed form this reader does not reverse.
 */
export function readFontTables(file) {
  const buf = readFileSync(file);
  if (buf.length < 12) throw new Error(`${file}: too short to be a font`);
  const magic = buf.toString('latin1', 0, 4);
  if (magic === 'wOF2') return { ...readWoff2Tables(buf, file), container: 'woff2' };
  if (magic === 'ttcf') throw new Error(`${file}: font collections are not supported`);
  return { tables: readSfntTables(buf, file), flavor: buf.readUInt32BE(0), container: 'sfnt' };
}

function readSfntTables(buf, file) {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) throw new Error(`${file}: sfnt table directory is truncated`);
    const tag = buf.toString('latin1', rec, rec + 4);
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + length > buf.length) throw new Error(`${file}: table ${JSON.stringify(tag)} extends past the end of the file`);
    tables.set(tag, buf.subarray(offset, offset + length));
  }
  return tables;
}

function readWoff2Tables(buf, file) {
  if (buf.length < 48) throw new Error(`${file}: too short to be a WOFF2 file`);
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  const pos = { o: 48 };
  const dir = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = buf[pos.o];
    pos.o += 1;
    const tagIndex = flags & 0x3f;
    const tag = tagIndex === 0x3f
      ? buf.toString('latin1', pos.o, (pos.o += 4))
      : KNOWN_TAGS[tagIndex];
    if (tag === undefined) throw new Error(`${file}: unknown known-tag index ${tagIndex}`);
    const version = flags >> 6;
    const nullTransform = isNullTransform(tag, version);
    // The directory always records origLength first. Only a transformed table adds a second count,
    // its transformLength, which is how many bytes the Brotli stream holds for it. For a
    // null-transform table the two are the same number, so it is written once.
    const origLength = readUIntBase128(buf, pos);
    const storedLength = nullTransform ? origLength : readUIntBase128(buf, pos);
    dir.push({ tag, version, origLength, storedLength, nullTransform });
  }
  const directoryEnd = pos.o;
  if (buf.length - directoryEnd < totalCompressedSize) {
    throw new Error(`${file}: the compressed block is shorter than the declared totalCompressedSize`);
  }
  const raw = zlib.brotliDecompressSync(buf.subarray(directoryEnd, directoryEnd + totalCompressedSize));
  const tables = new Map();
  let offset = 0;
  for (const entry of dir) {
    const bytes = raw.subarray(offset, offset + entry.storedLength);
    offset += entry.storedLength;
    if (entry.nullTransform && bytes.length !== entry.origLength) {
      throw new Error(`${file}: ${entry.tag} is ${bytes.length} bytes, the directory declares ${entry.origLength}`);
    }
    tables.set(entry.tag, entry.nullTransform ? bytes : null);
  }
  if (offset !== raw.length) {
    throw new Error(`${file}: the table lengths describe ${offset} of ${raw.length} decompressed bytes`);
  }
  return { tables, flavor: buf.readUInt32BE(4) };
}

/** `name` records by nameID. The first record wins, which is the platform-3 English one in practice. */
export function readNameRecords(nameTable) {
  if (!nameTable) return new Map();
  const count = nameTable.readUInt16BE(2);
  const stringOffset = nameTable.readUInt16BE(4);
  const records = new Map();
  for (let i = 0; i < count; i += 1) {
    const rec = 6 + i * 12;
    if (rec + 12 > nameTable.length) break;
    const platformId = nameTable.readUInt16BE(rec);
    const nameId = nameTable.readUInt16BE(rec + 6);
    const length = nameTable.readUInt16BE(rec + 8);
    const offset = nameTable.readUInt16BE(rec + 10);
    const start = stringOffset + offset;
    if (start + length > nameTable.length) continue;
    const bytes = nameTable.subarray(start, start + length);
    let value = '';
    if (platformId === 3 || platformId === 0) {
      if (bytes.length % 2 === 0) value = Buffer.from(bytes).swap16().toString('utf16le');
    } else {
      value = bytes.toString('latin1');
    }
    if (!records.has(nameId)) records.set(nameId, value);
  }
  return records;
}

/**
 * Every codepoint a `cmap` table maps to a non-zero glyph, plus the subtables it was read from.
 * Supports formats 0, 4, 6 and 12 — between them that is every `cmap` a shipping web font uses.
 */
export function readCmapCodePoints(cmapTable) {
  if (!cmapTable) throw new Error('the font has no cmap table');
  const b = cmapTable;
  const numTables = b.readUInt16BE(2);
  const codePoints = new Set();
  const subtables = [];
  for (let i = 0; i < numTables; i += 1) {
    const rec = 4 + i * 8;
    if (rec + 8 > b.length) break;
    const platformId = b.readUInt16BE(rec);
    const encodingId = b.readUInt16BE(rec + 2);
    const offset = b.readUInt32BE(rec + 4);
    if (offset + 2 > b.length) continue;
    const format = b.readUInt16BE(offset);
    subtables.push({ platformId, encodingId, format });
    if (format === 4) {
      const segCountX2 = b.readUInt16BE(offset + 6);
      const segCount = segCountX2 / 2;
      const endBase = offset + 14;
      const startBase = endBase + segCountX2 + 2;
      const deltaBase = startBase + segCountX2;
      const rangeBase = deltaBase + segCountX2;
      for (let s = 0; s < segCount; s += 1) {
        const end = b.readUInt16BE(endBase + s * 2);
        const start = b.readUInt16BE(startBase + s * 2);
        const delta = b.readInt16BE(deltaBase + s * 2);
        const rangeOffset = b.readUInt16BE(rangeBase + s * 2);
        if (start > end || start === 0xffff) continue;
        for (let c = start; c <= end && c <= 0xfffe; c += 1) {
          let glyph;
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
          else {
            const at = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
            if (at + 1 >= b.length) continue;
            glyph = b.readUInt16BE(at);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) codePoints.add(c);
        }
      }
    } else if (format === 6) {
      const first = b.readUInt16BE(offset + 6);
      const count = b.readUInt16BE(offset + 8);
      for (let j = 0; j < count; j += 1) {
        if (b.readUInt16BE(offset + 10 + j * 2) !== 0) codePoints.add(first + j);
      }
    } else if (format === 12) {
      const nGroups = b.readUInt32BE(offset + 12);
      for (let g = 0; g < nGroups; g += 1) {
        const group = offset + 16 + g * 12;
        const start = b.readUInt32BE(group);
        const end = b.readUInt32BE(group + 4);
        for (let c = start; c <= end; c += 1) codePoints.add(c);
      }
    } else if (format === 0) {
      for (let c = 0; c < 256; c += 1) if (b[offset + 6 + c] !== 0) codePoints.add(c);
    }
  }
  return { codePoints, subtables };
}

/** Collapse a codepoint set into a compact CSS `unicode-range` value. */
export function toUnicodeRange(codePoints) {
  const sorted = [...codePoints].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const c = sorted[i];
    if (c === prev + 1) { prev = c; continue; }
    ranges.push([start, prev]);
    start = c;
    prev = c;
  }
  ranges.push([start, prev]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] - last[1] <= 2) last[1] = range[1];
    else merged.push([...range]);
  }
  const hex = (n) => n.toString(16).toUpperCase();
  return merged.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(',');
}
