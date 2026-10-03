/**
 * The provider event vocabulary (PAYMENTS-SLICE-01, contract §3).
 *
 * Stripe's event objects are large and move with the API version. The rest of the application must
 * never learn that shape: `readEvent()` reduces one provider event to a small, stable record — a
 * kind, the order it belongs to, the provider reference and the money — and everything downstream
 * (the activation decision, the database transaction) sees only that.
 */

/** A provider call that failed. Distinct from a refusal, so a route can answer 502 and be retried. */
export class ProviderError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ProviderError';
    this.reason = reason;
  }
}

/** A body that verified but is not a usable event. */
export class InvalidPayload extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'InvalidPayload';
    this.reason = reason;
  }
}

/**
 * The provider event types this application acts on. Anything else is `ignored`: an endpoint receives
 * every type it is subscribed to, so treating an unfamiliar one as an error would turn a dashboard
 * subscription change into a failing endpoint.
 *
 * `async_payment_succeeded`/`async_payment_failed` exist because some payment methods settle after
 * checkout completes; without them a SEPA-style payment would never activate a pass.
 */
export const EVENT_KINDS = Object.freeze({
  'checkout.session.completed': 'paid',
  'checkout.session.async_payment_succeeded': 'delayed_paid',
  'checkout.session.async_payment_failed': 'failed',
  'charge.refunded': 'refunded',
  'charge.dispute.created': 'disputed',
});

/** Money moves only on these kinds. One list, so a new kind cannot silently start granting. */
export const GRANTING_KINDS = Object.freeze(['paid', 'delayed_paid']);

/**
 * Reduce a provider event to the small record the application uses.
 *
 * `orderId` comes from `client_reference_id` first: it is set when the session is created and it is
 * the field that survives a metadata edit in the dashboard. Metadata is the fallback, never primary.
 */
export function readEvent(event) {
  if (!event || typeof event !== 'object') throw new InvalidPayload('not_an_event');
  const type = String(event.type || '');
  const kind = EVENT_KINDS[type] || 'ignored';
  const object = event.data && event.data.object ? event.data.object : {};
  const metadata = object.metadata && typeof object.metadata === 'object' ? object.metadata : {};

  const orderId = String(object.client_reference_id || metadata.order_id || '');
  const providerRef = String(object.id || '');
  const amountMinor = Number.isInteger(object.amount_total)
    ? object.amount_total
    : Number.isInteger(object.amount) ? object.amount : null;
  const currency = typeof object.currency === 'string' ? object.currency.toLowerCase() : null;

  return { id: String(event.id || ''), type, kind, orderId, providerRef, amountMinor, currency };
}
