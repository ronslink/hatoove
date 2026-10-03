import { createHmac, timingSafeEqual } from 'node:crypto';

export class InvalidSignature extends Error {
  constructor(reason) { super(reason); this.name = 'InvalidSignature'; this.reason = reason; }
}

export const DEFAULT_TOLERANCE_SECONDS = 300;

// HTTP callers pass a Buffer. Strings are retained for authored offline fixtures.
function bodyBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new InvalidSignature('missing_body');
}

export function signPayload({ rawBody, secret, timestamp }) {
  if (typeof secret !== 'string' || !secret.trim()) throw new InvalidSignature('missing_secret');
  return createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(bodyBytes(rawBody)).digest('hex');
}

export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || !header || header.length > 8192) return null;
  let timestamp;
  const signatures = [];
  const parts = header.split(',');
  if (parts.length > 64) return null;
  for (const part of parts) {
    const match = /^([^=]+)=(.*)$/.exec(part.trim());
    if (!match) return null;
    const [, key, value] = match;
    if (key === 't') {
      if (timestamp !== undefined || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
      timestamp = value;
    } else if (key === 'v1') {
      // Buffer.from(hex) silently truncates malformed suffixes; validate before decoding.
      if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
      signatures.push(value);
    }
  }
  if (!timestamp || !Number.isSafeInteger(Number(timestamp)) || !signatures.length) return null;
  return { timestamp, signatures };
}

export function verifySignature({ rawBody, signatureHeader, secret, now = () => new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS }) {
  if (typeof secret !== 'string' || !secret.trim()) throw new InvalidSignature('missing_secret');
  bodyBytes(rawBody);
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > DEFAULT_TOLERANCE_SECONDS) {
    throw new InvalidSignature('invalid_tolerance');
  }
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) throw new InvalidSignature('malformed_signature');
  const timestamp = Number(parsed.timestamp);
  const nowSeconds = Math.floor(now().getTime() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new InvalidSignature('timestamp_out_of_tolerance');
  }
  const expected = Buffer.from(signPayload({ rawBody, secret, timestamp: parsed.timestamp }), 'hex');
  let matched = false;
  for (const candidate of parsed.signatures) matched = timingSafeEqual(Buffer.from(candidate, 'hex'), expected) || matched;
  if (!matched) throw new InvalidSignature('signature_mismatch');
  return { timestamp };
}

// Explicit fixture helper; no HTTP route exposes signing or synthetic payment completion.
export function buildSignatureHeader({ rawBody, secret, timestamp }) {
  return `t=${timestamp},v1=${signPayload({ rawBody, secret, timestamp })}`;
}
