import { deflateSync } from 'node:zlib';
function chunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, bytes, tail]);
}
/** Genuine opaque RGB PNG, including CRCs and zlib scanlines. Synthetic test pixels only. */
export function feedbackPng(width = 1280, height = 720) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width,0); header.writeUInt32BE(height,4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width * 3 + 1) * height))),chunk('IEND',Buffer.alloc(0))]);
}
