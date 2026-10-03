import { ProviderError, readEvent, reference } from './events.mjs';
import { checkoutInput, checkoutReturn, paymentOrigin, requireWebhookSecret, verifiedEvent } from './boundary.mjs';

// Pinned against Stripe's published release record on 2026-10-03:
// https://docs.stripe.com/api/versioning
export const STRIPE_API_VERSION = '2026-09-30.endive';
const ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';
const MAX_RESPONSE_BYTES = 65536;

async function responseJson(response) {
  if (!response || response.status !== 200 || !response.body?.getReader) throw new ProviderError('provider_request_failed');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderError('invalid_provider_response');
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new ProviderError('invalid_provider_response'); }
  finally { reader.releaseLock(); }
}

function sessionResult(session, snapshot, now) {
  if (!session || session.object !== 'checkout.session' || session.livemode !== false
    || !reference(session.id, 'cs_test') || session.mode !== 'payment'
    || session.client_reference_id !== snapshot.orderId || session.metadata?.order_id !== snapshot.orderId
    || session.amount_total !== snapshot.price.amountMinor || session.currency !== snapshot.price.currency.toLowerCase()
    || !['open', 'complete'].includes(session.status)
    || !['paid', 'unpaid'].includes(session.payment_status)) throw new ProviderError('invalid_provider_session');
  let url;
  try { url = new URL(session.url); } catch { throw new ProviderError('invalid_checkout_url'); }
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port || url.username || url.password) {
    throw new ProviderError('invalid_checkout_url');
  }
  if (!Number.isSafeInteger(session.expires_at) || session.expires_at * 1000 <= now().getTime()
    || !Number.isFinite(new Date(session.expires_at * 1000).getTime())) throw new ProviderError('invalid_provider_expiry');
  return { url: url.href, providerSessionId: session.id, expiresAt: new Date(session.expires_at * 1000).toISOString() };
}

export function createStripeTestPayments({ secretKey, webhookSecret, publicOrigin,
  now = () => new Date(), fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof secretKey !== 'string' || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secretKey)) throw new ProviderError('test_key_required');
  requireWebhookSecret(webhookSecret);
  const origin = paymentOrigin(publicOrigin);
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new ProviderError('invalid_provider_configuration');
  }
  return Object.freeze({
    configured: true,
    mode: 'stripe-test',
    async createCheckoutSession(input) {
      const snapshot = checkoutInput(input);
      const returnUrl = checkoutReturn(origin, snapshot.orderId);
      // The provider page is learner-facing and follows the stipulated German interface.
      const body = new URLSearchParams({ mode: 'payment', locale: 'de',
        client_reference_id: snapshot.orderId, success_url: returnUrl, cancel_url: returnUrl,
        // This slice settles the exact stored price; dynamic conversions/discounts/taxes are not configured.
        'adaptive_pricing[enabled]': 'false', 'automatic_tax[enabled]': 'false', allow_promotion_codes: 'false',
        'line_items[0][price]': snapshot.price.stripePriceId, 'line_items[0][quantity]': '1' });
      for (const [key, value] of Object.entries({ order_id: snapshot.orderId, owner_id: snapshot.ownerId,
        exam_id: snapshot.examId, market: snapshot.market })) {
        body.set(`metadata[${key}]`, value);
        body.set(`payment_intent_data[metadata][${key}]`, value);
      }
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ProviderError('provider_timeout')); }, timeoutMs);
      });
      try {
        // Reusing an order always reuses this key; no automatic second session after uncertainty.
        const request = (async () => {
          const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded',
              'Stripe-Version': STRIPE_API_VERSION, 'Idempotency-Key': `hatoove-checkout-${snapshot.orderId}` }, body: body.toString() });
          return sessionResult(await responseJson(response), snapshot, now);
        })();
        return await Promise.race([request, timeout]);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('provider_request_failed');
      } finally { clearTimeout(timer); }
    },
    async verifyWebhook({ rawBody, signatureHeader }) {
      return verifiedEvent({ rawBody, signatureHeader, webhookSecret, now });
    },
    readEvent,
  });
}
