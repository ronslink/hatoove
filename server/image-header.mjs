/**
 * PILOT-FEEDBACK-01 (slice FB-E) — read an image's type and dimensions from its own bytes.
 *
 * WHY THIS EXISTS RATHER THAN TRUSTING THE REQUEST. §2 requires the server to check the magic bytes against the
 * declared `Content-Type` and to read the dimensions itself, refusing anything wider than 1600 px. A client-supplied
 * width is not a check, and a `Content-Type` header is a claim: a file named `.webp` that is really a 4000 px PNG
 * would otherwise be stored and later handed to an operator as an image the browser decodes differently than the
 * type suggests.
 *
 * It is pure — bytes in, numbers out, no imports — because the alternative is dimension parsing buried inside the
 * request handler where only an HTTP test can reach it.
 *
 * PNG and WebP only: those are the two types §2 accepts, and a format nobody uploads is a parser nobody exercises.
 *
 * @returns {{mimeType: string, width: number, height: number} | null} null when the bytes are neither, or are
 *   truncated. A null is a refusal at the call site, never a default.
 */

/** PNG signature, then the IHDR chunk: width and height as big-endian uint32 at offsets 16 and 20. */
function readPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (const [index, byte] of signature.entries()) if (bytes[index] !== byte) return null;
  // The first chunk must be IHDR, or the offsets below mean something else.
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** `RIFF....WEBP`, then whichever of the three chunk layouts the encoder chose. */
function readWebp(bytes) {
  if (bytes.length < 30) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte frame tag, the 3-byte start code, then 14-bit dimensions as little-endian uint16.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      mimeType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    // Lossless: signature byte, then 14 bits of width-1 and 14 bits of height-1, packed across four bytes.
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return {
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    // Extended: canvas dimensions minus one, as 24-bit little-endian, after four flag/reserved bytes.
    const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return { mimeType: 'image/webp', width: width + 1, height: height + 1 };
  }
  return null;
}

export function readImageHeader(bytes, declared = null) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 16) return null;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = readPng(buffer) ?? readWebp(buffer);
  if (!header) return null;
  /*
   * THE DECLARED TYPE MUST MATCH THE BYTES. This is the check that stops a PNG being stored as `image/webp` and
   * later served with a type the browser will not decode — and it is why the comparison is here rather than at
   * the call site, where it would be easy to compare the wrong pair.
   */
  if (declared && declared !== header.mimeType) return null;
  if (!Number.isInteger(header.width) || !Number.isInteger(header.height) || header.width < 1 || header.height < 1) return null;
  return header;
}
