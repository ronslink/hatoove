/** Private, bounded PCM media access shared by publication and authenticated transport. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
export const MAX_MEDIA_DURATION_MS = 3600000;
const REPO_ROOT = fileURLToPath(new URL('../content/exams/', import.meta.url));

/**
 * MEDIA-MOUNT-01 — WHERE THE RECORDINGS COME FROM IS CONFIGURABLE.
 *
 * The recordings are ~46 MB of generated audio that is NOT tracked in git (Ron is deciding between tracking,
 * a documented deployment prerequisite and object storage), so the root must not be hard-wired to a path that
 * only exists in a developer's checkout or in an image layer. `B1PREP_MEDIA_ROOT` names the directory that
 * holds the exam trees (`<root>/telc-deutsch-b1/audio/hv1.01-v1.wav`); `compose.yaml` mounts the host's
 * `./media` there read-only and sets the variable, so a local run and a deployment can serve the same bytes
 * from a durable location instead of from the image.
 *
 * Resolved PER CALL, not at module load: `server.js` reads `.env` after its static imports are evaluated, so a
 * value captured at import time would miss `.env` and silently fall back to the repo path.
 */
export function defaultMediaRoot() {
  const configured = process.env.B1PREP_MEDIA_ROOT;
  return configured && configured.trim() ? path.resolve(configured.trim()) : REPO_ROOT;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const VERSION = /^v[0-9]{1,4}$/;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const demand = (ok, message) => { if (!ok) fail('invalid_package', message); };
const safePath = value => typeof value === 'string' && value.length <= 500 && value.startsWith('content/exams/') &&
  value.slice(14).split('/').length >= 2 && value.slice(14).split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) &&
    !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

/** Manifest-only metadata validation. New import never grants review or rights approval. */
export function validateMediaDescriptor(media, examId) {
  const allowed = ['mediaId','version','examId','path','sha256','byteLength','durationMs','mimeType','reviewStatus','rightsStatus','source'];
  demand(media && typeof media === 'object' && !Array.isArray(media) && Object.keys(media).every(key => allowed.includes(key)), 'invalid media fields');
  demand(typeof media.mediaId === 'string' && ID.test(media.mediaId) && typeof media.version === 'string' && VERSION.test(media.version) && media.examId === examId, 'invalid media identity');
  demand(safePath(media.path), 'invalid private media path');
  demand(typeof media.sha256 === 'string' && /^[a-f0-9]{64}$/.test(media.sha256), 'invalid media checksum');
  demand(Number.isSafeInteger(media.byteLength) && media.byteLength >= 44 && media.byteLength <= MAX_MEDIA_BYTES, 'invalid media byte length');
  demand(Number.isSafeInteger(media.durationMs) && media.durationMs > 0 && media.durationMs <= MAX_MEDIA_DURATION_MS && media.mimeType === 'audio/wav', 'unsupported media duration/type');
  demand(media.reviewStatus === 'unreviewed' && media.rightsStatus === 'generated' && typeof media.source === 'string' && media.source.trim().length > 0 && media.source.length <= 1000, 'new media needs separate review/rights approval');
  return media;
}

/** Parse RIFF chunks, including padding; neither filename nor authored duration is trusted. */
export function parsePcmWav(bytes) {
  const bad = () => fail('media_integrity', 'Invalid PCM WAV media');
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_MEDIA_BYTES || bytes.toString('ascii',0,4) !== 'RIFF' ||
      bytes.toString('ascii',8,12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) bad();
  let format, dataLength, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) bad();
    const type = bytes.toString('ascii',offset,offset+4), size = bytes.readUInt32LE(offset+4), begin = offset+8;
    const end = begin + size, next = end + (size % 2);
    if (end > bytes.length || next > bytes.length) bad();
    if (type === 'fmt ') {
      if (format || size !== 16 || bytes.readUInt16LE(begin) !== 1) bad();
      const channels = bytes.readUInt16LE(begin+2), sampleRate = bytes.readUInt32LE(begin+4), byteRate = bytes.readUInt32LE(begin+8);
      const blockAlign = bytes.readUInt16LE(begin+12), bits = bytes.readUInt16LE(begin+14);
      if (![1,2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || ![8,16,24,32].includes(bits) ||
          blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) bad();
      format = {channels,sampleRate,byteRate,blockAlign,bits};
    }
    if (type === 'data') { if (dataLength !== undefined || size === 0) bad(); dataLength = size; }
    offset = next;
  }
  if (!format || dataLength === undefined || dataLength % format.blockAlign !== 0) bad();
  const durationMs = Math.round(dataLength * 1000 / format.byteRate);
  if (durationMs < 1 || durationMs > MAX_MEDIA_DURATION_MS) bad();
  return {byteLength:bytes.length,durationMs,mimeType:'audio/wav'};
}

/** Reads exact immutable bytes. Errors intentionally omit physical paths and OS messages. */
export async function readMediaBytes(media, { mediaRoot } = {}) {
  mediaRoot = mediaRoot ?? defaultMediaRoot();
  if (!media || !safePath(media.path) || typeof mediaRoot !== 'string' || !path.isAbsolute(mediaRoot)) fail('media_unavailable','Private media unavailable');
  const byteLength = media.byte_length ?? media.byteLength, durationMs = media.duration_ms ?? media.durationMs, mimeType = media.mime_type ?? media.mimeType;
  if (!Number.isSafeInteger(byteLength) || byteLength < 44 || byteLength > MAX_MEDIA_BYTES || !Number.isSafeInteger(durationMs) ||
      durationMs < 1 || durationMs > MAX_MEDIA_DURATION_MS || mimeType !== 'audio/wav' || !/^[a-f0-9]{64}$/.test(media.sha256 ?? '')) fail('media_integrity','Invalid media metadata');
  let handle;
  try {
    if ((await lstat(mediaRoot)).isSymbolicLink()) fail('media_unavailable','Private media unavailable');
    const root = await realpath(mediaRoot);
    let location = root;
    const parts = media.path.slice(14).split('/');
    for (const [index,part] of parts.entries()) {
      location = path.join(location,part);
      const info = await lstat(location);
      if (info.isSymbolicLink() || (index < parts.length-1 ? !info.isDirectory() : !info.isFile())) fail('media_unavailable','Private media unavailable');
    }
    const physical = await realpath(location), relative = path.relative(root,physical);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('media_unavailable','Private media unavailable');
    handle = await open(location,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size !== byteLength) fail('media_integrity','Media byte length mismatch');
    const bytes = Buffer.alloc(byteLength+1);
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes,length,bytes.length-length,length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length !== byteLength || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('media_integrity','Media changed during read');
    const exact = bytes.subarray(0,byteLength);
    if (createHash('sha256').update(exact).digest('hex') !== media.sha256 || parsePcmWav(exact).durationMs !== durationMs) fail('media_integrity','Media checksum or duration mismatch');
    return exact;
  } catch (error) {
    if (['media_unavailable','media_integrity'].includes(error.code)) throw error;
    fail('media_unavailable','Private media unavailable');
  } finally { await handle?.close().catch(()=>{}); }
}
