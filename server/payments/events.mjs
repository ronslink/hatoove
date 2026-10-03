// Only sanitized reasons cross this boundary; never attach provider response bodies or keys.
export class ProviderError extends Error {
  constructor(reason) { super(reason); this.name = 'ProviderError'; this.reason = reason; }
}
export class InvalidPayload extends Error {
  constructor(reason) { super(reason); this.name = 'InvalidPayload'; this.reason = reason; }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const currencyCode = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
export const money = value => Number.isSafeInteger(value) && value > 0;
export const reference = (value, prefix) => typeof value === 'string' && value.length <= 255
  && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
const objectRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const intentRef = value => typeof value === 'string' ? value : objectRecord(value) ? value.id : null;

export const EVENT_KINDS = Object.freeze({
  'checkout.session.completed': 'paid',
  'checkout.session.async_payment_succeeded': 'delayed_paid',
  'checkout.session.async_payment_failed': 'failed',
  'charge.refunded': 'refunded',
  'charge.dispute.created': 'disputed',
});
export const GRANTING_KINDS = Object.freeze(['paid', 'delayed_paid']);

export function readEvent(event) {
  if (!objectRecord(event) || !reference(event.id, 'evt') || typeof event.type !== 'string'
    || !/^[a-z][a-z0-9_.]{0,127}$/.test(event.type)) throw new InvalidPayload('invalid_event');
  const kind = EVENT_KINDS[event.type] || 'ignored';
  const object = objectRecord(event.data?.object) ? event.data.object : {};
  const result = { id: event.id, type: event.type, kind, orderId: '', providerRef: '',
    paymentIntentRef: null, amountMinor: null, currency: null, paymentStatus: null,
    livemode: event.livemode === false && (kind === 'ignored' || object.livemode === false) ? false : null,
    amountRefunded: null, fullRefund: null };
  if (event.livemode === true || object.livemode === true) result.livemode = true;
  if (kind === 'ignored') return result;

  const checkout = ['paid', 'delayed_paid', 'failed'].includes(kind);
  const expectedObject = checkout ? 'checkout.session' : kind === 'refunded' ? 'charge' : 'dispute';
  const prefix = checkout ? 'cs_test' : kind === 'refunded' ? 'ch' : 'du';
  if (object.object !== expectedObject || !reference(object.id, prefix)) throw new InvalidPayload('invalid_provider_object');
  const metadataOrder = object.metadata?.order_id;
  if (metadataOrder !== undefined && !UUID.test(String(metadataOrder))) throw new InvalidPayload('invalid_order_reference');
  if (checkout && (!UUID.test(String(object.client_reference_id || ''))
    || (metadataOrder !== undefined && object.client_reference_id !== metadataOrder))) {
    throw new InvalidPayload('order_reference_mismatch');
  }
  result.orderId = checkout ? object.client_reference_id : metadataOrder || '';
  // On reversals this is a charge/dispute reference, never a Checkout Session reference.
  result.providerRef = object.id;
  const paymentIntentRef = intentRef(object.payment_intent);
  if (paymentIntentRef !== null && paymentIntentRef !== undefined && !reference(paymentIntentRef, 'pi')) {
    throw new InvalidPayload('invalid_payment_intent');
  }
  result.paymentIntentRef = paymentIntentRef || null;
  result.amountMinor = checkout ? object.amount_total ?? null : object.amount ?? null;
  // Stripe uses lowercase; the database contract uses uppercase ISO currency codes.
  result.currency = typeof object.currency === 'string' && /^[a-z]{3}$/.test(object.currency)
    ? object.currency.toUpperCase() : null;
  result.paymentStatus = checkout ? object.payment_status ?? null : null;
  if (kind === 'refunded') {
    result.amountRefunded = object.amount_refunded ?? null;
    result.fullRefund = money(result.amountMinor) && money(result.amountRefunded)
      ? result.amountRefunded === result.amountMinor : null;
  }
  return result;
}
