/**
 * Webhook signature verification, Stripe-compatible and dependency-free (PAYMENTS-SLICE-01).
 *
 * WHY THIS IS HAND-WRITTEN. The root package is deliberately dependency-free
 * (`"dependencies": {}`), and the Dockerfile depends on that property: the whole image is Node plus
 * `pg` in the one database scope. Adding a payment SDK to the root would break a stated invariant to
 * save about forty lines. The algorithm is HMAC-SHA256 over `${timestamp}.${rawBody}` — small, stable
 * and fully specified — so it is implemented here and proved by `tools/payment-path-check.mjs`
 * instead of being trusted to a package.
 *
 * WHAT THIS FILE DOES NOT DO. It does not fetch, log, or store anything, and it never compares
 * secrets with `===`: a signature comparison that short-circuits is a timing oracle. Every candidate
 * signature is compared with `timingSafeEqual`.
 *
 * The header format is Stripe's: `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`. Several `v1` values appear
 * while an endpoint secret is being rotated, and any one of them matching is a valid signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** A signature that is absent, malformed, stale or simply wrong. The caller maps this to a refusal. */
export class InvalidSignature extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'InvalidSignature';
    this.reason = reason;
  }
}

/**
 * How old a signed request may be, in seconds.
 *
 * Without this window a captured request stays valid forever, which is the whole reason Stripe puts a
 * timestamp in the header. Stripe's own default tolerance is five minutes; matching it means a
 * retried delivery (which Stripe stamps at delivery time) still verifies.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The signed payload is the timestamp, a dot, and the exact bytes received. */
export function signPayload({ rawBody, secret, timestamp }) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Parse a `Stripe-Signature` header. Returns `null` when the header cannot be read at all, so a
 * malformed header is a refusal rather than an exception escaping the request path.
 */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [rawKey, ...rest] = part.split('=');
    const key = (rawKey || '').trim();
    const value = rest.join('=').trim();
    if (!key || !value) continue;
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verify a webhook delivery.
 *
 * @param {{rawBody: string, signatureHeader: string, secret: string, now?: () => Date,
 *          toleranceSeconds?: number}} input
 *   `rawBody` must be the exact bytes received. Re-serialising parsed JSON changes the bytes and the
 *   signature will not match — which is why `server.js` hands the raw body to this function.
 * @returns {{timestamp: number}} the verified timestamp
 * @throws {InvalidSignature}
 */
export function verifySignature({
  rawBody,
  signatureHeader,
  secret,
  now = () => new Date(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}) {
  // Fail closed on missing configuration before anything else: an empty secret would otherwise make
  // an attacker-supplied signature verifiable.
  if (typeof secret !== 'string' || secret === '') throw new InvalidSignature('missing_secret');
  if (typeof rawBody !== 'string') throw new InvalidSignature('missing_body');

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) throw new InvalidSignature('malformed_signature');

  const timestamp = Number(parsed.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new InvalidSignature('malformed_signature');

  const skew = Math.abs(Math.floor(now().getTime() / 1000) - timestamp);
  if (skew > toleranceSeconds) throw new InvalidSignature('timestamp_out_of_tolerance');

  const expected = Buffer.from(signPayload({ rawBody, secret, timestamp }), 'hex');
  const matched = parsed.signatures.some((candidate) => {
    const bytes = Buffer.from(candidate, 'hex');
    // Length must be compared first: timingSafeEqual throws on a length mismatch, and a wrong-length
    // candidate is not a match either way.
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
  if (!matched) throw new InvalidSignature('signature_mismatch');

  return { timestamp };
}

/**
 * Build a valid `Stripe-Signature` value. Used by the stub adapter and by the check that proves the
 * verifier discriminates; never used to authenticate a real request.
 */
export function buildSignatureHeader({ rawBody, secret, timestamp }) {
  return `t=${timestamp},v1=${signPayload({ rawBody, secret, timestamp })}`;
}
