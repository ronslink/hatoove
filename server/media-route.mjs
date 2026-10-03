/** Private fixed media response framing. The caller authorizes and verifies ALL bytes first. */
import { Fault } from './owned-api.mjs';

export function mediaResponse(bytes, media, { range, method = 'GET' } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Fault(409, 'media_integrity');
  const headers = {
    'content-type': media.mime_type ?? media.mimeType,
    'cache-control': 'private, no-store',
    'accept-ranges': 'bytes',
    'etag': `"sha256-${media.sha256}"`,
    'x-content-type-options': 'nosniff',
    'vary': 'Cookie, X-Hatoove-Account',
  };
  let start = 0; let end = bytes.length - 1; let status = 200;
  if (range !== undefined) {
    const match = typeof range === 'string' && /^bytes=(\d*)-(\d*)$/.exec(range);
    let valid = Boolean(match && (match[1] || match[2]));
    if (valid && match[1]) {
      start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
      valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < bytes.length;
      end = Math.min(end, bytes.length - 1);
    } else if (valid) {
      const suffix = Number(match[2]);
      valid = Number.isSafeInteger(suffix) && suffix > 0;
      start = Math.max(0, bytes.length - suffix);
    }
    if (!valid) return { status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}`, 'content-length': '0' }, body: Buffer.alloc(0) };
    status = 206; headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
  }
  headers['content-length'] = String(end - start + 1);
  return { status, headers, body: method === 'HEAD' ? Buffer.alloc(0) : bytes.subarray(start, end + 1) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const VERSION = /^v[0-9]{1,4}$/;
const invalid = () => { throw new Fault(422, 'invalid_playback_request'); };

/** Shared by HTTP and the datastore: no client-supplied allowance, owner or duration. */
export function validatePlaybackEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => !['eventId', 'mediaId', 'mediaVersion', 'expectedRevision', 'action', 'positionMs', 'playbackId'].includes(k))) invalid();
  if (typeof body.eventId !== 'string' || !UUID.test(body.eventId) || typeof body.mediaId !== 'string' || !TOKEN.test(body.mediaId)
    || typeof body.mediaVersion !== 'string' || !VERSION.test(body.mediaVersion)
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision >= 2147483647
    || !['begin', 'checkpoint', 'pause', 'complete', 'recover'].includes(body.action)) invalid();
  if (body.positionMs !== undefined && (!Number.isSafeInteger(body.positionMs) || body.positionMs < 0 || body.positionMs > 3600000)) invalid();
  if (body.action === 'begin') {
    if (body.playbackId !== undefined || (body.positionMs !== undefined && body.positionMs !== 0)) invalid();
  } else if (typeof body.playbackId !== 'string' || !UUID.test(body.playbackId)) invalid();
  if (['checkpoint', 'pause', 'complete'].includes(body.action) && body.positionMs === undefined) invalid();
  if (body.action === 'recover' && body.positionMs !== undefined) invalid();
  return { eventId: body.eventId.toLowerCase(), mediaId: body.mediaId, mediaVersion: body.mediaVersion,
    expectedRevision: body.expectedRevision, action: body.action,
    ...(body.positionMs !== undefined ? { positionMs: body.positionMs } : {}),
    ...(body.playbackId !== undefined ? { playbackId: body.playbackId.toLowerCase() } : {}) };
}
