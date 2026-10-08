/** Bounded PNG raster validation and WebP container/frame validation.
 * WebP entropy decoding remains the browser's responsibility; this is not an antivirus or codec decoder.
 * Metadata-only containers, bad lengths, corrupt PNG CRCs and decompression bombs are refused.
 */
import { inflateSync } from 'node:zlib';
const MAX_DIMENSION = 20000;
const MAX_RASTER = 64 * 1024 * 1024;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function readPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
  let offset = 8, header = null, palette = false, ended = false, afterData = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return null;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return null;
    if (type === 'IHDR') {
      if (header || offset !== 8 || length !== 13) return null;
      const width = body.readUInt32BE(0), height = body.readUInt32BE(4), depth = body[8], colour = body[9];
      const allowed = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION
        || !allowed[colour]?.includes(depth) || body[10] || body[11] || body[12] > 1) return null;
      header = { width, height, depth, colour, interlace: body[12] };
    } else if (!header) return null;
    else if (type === 'PLTE') {
      if (palette || data.length || !length || length > 768 || length % 3) return null;
      palette = true;
    } else if (type === 'IDAT') {
      if (afterData || (header.colour === 3 && !palette)) return null;
      data.push(body);
    } else if (type === 'IEND') {
      if (length || !data.length || offset + 12 !== bytes.length) return null;
      ended = true; break;
    } else {
      if (data.length) afterData = true;
      // Reject unknown critical chunks and animated PNGs.
      if (type[0] === type[0].toUpperCase() || ['acTL','fcTL','fdAT'].includes(type)) return null;
    }
    offset += 12 + length;
  }
  if (!ended || !header || !data.some(b => b.length)) return null;
  const channels = {0:1,2:3,3:1,4:2,6:4}[header.colour];
  const passes = header.interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.map(([x,y,dx,dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x) / dx));
    const height = Math.max(0, Math.ceil((header.height - y) / dy));
    return { height: width ? height : 0, stride: Math.ceil(width * channels * header.depth / 8) + 1 };
  });
  const size = rows.reduce((sum, p) => sum + p.height * p.stride, 0);
  if (size > MAX_RASTER) return null;
  let raster;
  try { raster = inflateSync(Buffer.concat(data), { maxOutputLength: size }); } catch { return null; }
  if (raster.length !== size) return null;
  let position = 0;
  for (const p of rows) for (let row = 0; row < p.height; row++) {
    if (raster[position] > 4) return null;
    position += p.stride;
  }
  return { mimeType: 'image/png', width: header.width, height: header.height };
}
function readWebp(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let offset = 12, canvas = null, frame = null;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii',offset,offset+4), size = bytes.readUInt32LE(offset+4);
    if (size > bytes.length - offset - 8) return null;
    const body = bytes.subarray(offset+8,offset+8+size);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length || (size % 2 && bytes[end - 1] !== 0)) return null;
    if (type === 'VP8X') {
      if (canvas || frame || offset !== 12 || size !== 10 || body[0] & 0xc3 || body[1] || body[2] || body[3]) return null;
      canvas = { width: body.readUIntLE(4,3)+1, height: body.readUIntLE(7,3)+1 };
    } else if (type === 'VP8 ') {
      if (frame || size < 11 || (body[0] & 1) || !(body[0] & 16)
        || body[3] !== 0x9d || body[4] !== 1 || body[5] !== 0x2a) return null;
      const partition = (body.readUIntLE(0,3) >>> 5);
      if (!partition || partition > size - 10) return null;
      frame = { width: body.readUInt16LE(6)&0x3fff, height: body.readUInt16LE(8)&0x3fff };
    } else if (type === 'VP8L') {
      if (frame || size <= 5 || body[0] !== 0x2f || body[4] & 0xe0) return null;
      const bits = body.readUInt32LE(1);
      frame = { width: (bits & 0x3fff)+1, height: ((bits >>> 14)&0x3fff)+1 };
    } else if (!['ALPH','ICCP','EXIF','XMP '].includes(type) || !canvas) return null;
    offset = end;
  }
  if (offset !== bytes.length || !frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))) return null;
  return { mimeType: 'image/webp', ...frame };
}
export function readImageHeader(bytes, declared = null) {
  try {
    if (!bytes || typeof bytes.length !== 'number' || bytes.length < 16) return null;
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const header = readPng(buffer) ?? readWebp(buffer);
    if (!header || (declared && declared !== header.mimeType) || header.width < 1 || header.height < 1
      || header.width > MAX_DIMENSION || header.height > MAX_DIMENSION) return null;
    return header;
  } catch { return null; }
}
