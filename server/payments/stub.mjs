/**
 * The deterministic stub payment adapter (PAYMENTS-SLICE-01, contract §3).
 *
 * WHAT IT IS FOR. INTEGRATIONS-01 requires that every external integration be built and checked
 * against a stub first, because "that is the only way to prove the allowance, ledger and isolation
 * behaviour before money moves". This adapter is that stub: it signs and verifies real HMAC
 * signatures, produces deterministic session ids from the order id, and makes **no network call at
 * all** — there is no `fetch` reference in this file, and the check runs the whole path with
 * `globalThis.fetch` replaced by a throwing stub to prove it.
 *
 * WHAT IT MUST NOT DO. It must not invent a price. `createCheckoutSession` takes the price the
 * SERVER resolved from its own catalogue and refuses the call when that price is missing or
 * malformed, so a caller cannot smuggle a client-supplied amount through the stub and discover the
 * mistake only in production.
 */
import { buildSignatureHeader, verifySignature } from './signature.mjs';
import { InvalidPayload, readEvent } from './events.mjs';

/** A Checkout Session lives for 30 minutes in the stub, mirroring Stripe's hosted-page behaviour. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * @param {{now?: () => Date, webhookSecret?: string, publicOrigin?: string, termDays?: number,
 *          allowance?: number, market?: string}} [options]
 */
export function createStubPayments({
  now = () => new Date(),
  webhookSecret = 'whsec_stub_local',
  publicOrigin = 'http://localhost:4300',
  termDays = 56,
  allowance = 10,
  market = 'DE',
} = {}) {
  /** providerSessionId -> the record a real provider would hold. Introspection for checks only. */
  const sessions = new Map();

  function requirePrice(price) {
    if (!price || typeof price !== 'object') throw new InvalidPayload('price_required');
    if (!Number.isInteger(price.amountMinor) || price.amountMinor < 0) throw new InvalidPayload('price_amount_invalid');
    if (typeof price.currency !== 'string' || price.currency.length !== 3) throw new InvalidPayload('price_currency_invalid');
  }

  return Object.freeze({
    configured: true,
    mode: 'stub',
    webhookSecret,
    termDays,
    allowance,
    market,

    /**
     * Create a checkout session. The learner is redirected to `url`; the provider reference travels
     * as `client_reference_id` in a real adapter, which is why the stub encodes the order id too.
     */
    async createCheckoutSession({ orderId, ownerId = '', examId = '', market: sessionMarket = market, price } = {}) {
      if (typeof orderId !== 'string' || orderId === '') throw new InvalidPayload('order_required');
      requirePrice(price);

      const providerSessionId = `cs_stub_${orderId}`;
      const expiresAt = new Date(now().getTime() + SESSION_TTL_MS).toISOString();
      sessions.set(providerSessionId, {
        orderId,
        ownerId,
        examId,
        market: sessionMarket,
        amountMinor: price.amountMinor,
        currency: price.currency,
        clientReferenceId: orderId,
      });
      // The stub sends the learner back to the fragment route the client already serves, so no new
      // public URL is invented for development.
      return { url: `${publicOrigin}/#/checkout?order=${orderId}&checkout=stub`, providerSessionId, expiresAt };
    },

    /**
     * Verify a delivery. Signature first, parse second: an unverified body must never reach
     * `JSON.parse` in a way that lets malformed input look like an authorisation decision.
     */
    async verifyWebhook({ rawBody, signatureHeader }) {
      verifySignature({ rawBody, signatureHeader, secret: webhookSecret, now });
      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        throw new InvalidPayload('not_json');
      }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new InvalidPayload('not_an_event');
      return event;
    },

    readEvent,

    /** Build a valid signature. For the check and for local development; never for a real request. */
    signForTest(rawBody, timestamp = Math.floor(now().getTime() / 1000)) {
      return buildSignatureHeader({ rawBody, secret: webhookSecret, timestamp });
    },

    /** The provider-side records, for assertions. A copy, so a caller cannot mutate the stub's state. */
    recordedSessions() {
      return new Map(sessions);
    },
  });
}
