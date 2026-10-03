import { InvalidPayload, ProviderError, UUID, currencyCode, money } from './events.mjs';
import { verifySignature } from './signature.mjs';

export function paymentOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('invalid_public_origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new ProviderError('invalid_public_origin');
  return url.origin;
}

export function requireWebhookSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9_]+$/.test(secret)) throw new ProviderError('invalid_webhook_configuration');
}

export function checkoutInput({ orderId, ownerId, examId, market, price } = {}) {
  if (!UUID.test(String(orderId || ''))) throw new InvalidPayload('invalid_order');
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 255) throw new InvalidPayload('invalid_owner');
  if (typeof examId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(examId)) throw new InvalidPayload('invalid_exam');
  if (typeof market !== 'string' || !/^[A-Z]{2}$/.test(market)) throw new InvalidPayload('invalid_market');
  if (!price || !money(price.amountMinor) || !currencyCode(price.currency)
    || typeof price.stripePriceId !== 'string' || !/^price_[A-Za-z0-9_]+$/.test(price.stripePriceId)) {
    throw new InvalidPayload('invalid_price_snapshot');
  }
  return { orderId, ownerId, examId, market, price: {
    stripePriceId: price.stripePriceId, amountMinor: price.amountMinor, currency: price.currency,
  } };
}

export const checkoutReturn = (origin, orderId) => `${origin}/app/#/checkout?order=${orderId}`;

export function verifiedEvent({ rawBody, signatureHeader, webhookSecret, now }) {
  verifySignature({ rawBody, signatureHeader, secret: webhookSecret, now });
  let event;
  try {
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    event = JSON.parse(text);
  } catch { throw new InvalidPayload('invalid_json_utf8'); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new InvalidPayload('invalid_event');
  return event;
}
