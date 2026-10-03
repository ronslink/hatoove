import { EVENT_KINDS, GRANTING_KINDS, UUID, currencyCode, money, reference } from './events.mjs';

export const ACTIVATION_ACTIONS = Object.freeze([
  'grant', 'extend', 'ignore_duplicate', 'ignore', 'fail_order', 'refund', 'dispute', 'refuse',
]);
const DAY_MS = 86400000;

// Pure policy only. The caller's transaction, event receipt and unique order grant enforce once-only.
export function decideActivation({ event, order, entitlement = null, now = () => new Date() } = {}) {
  const settle = (action, reason) => ({ action, reason, grant: null });
  const refuse = reason => settle('refuse', reason);
  if (!event || !reference(event.id, 'evt')) return refuse('invalid_event');
  if (event.livemode !== false) return refuse('non_test_event');
  if (event.kind === 'ignored' && !EVENT_KINDS[event.type]) return settle('ignore', 'event_not_relevant');
  if (EVENT_KINDS[event.type] !== event.kind) return refuse('invalid_event_kind');
  if (!order || !UUID.test(String(order.id || ''))) return refuse('unknown_order');
  const reversal = ['refunded', 'disputed'].includes(event.kind);
  if ((!reversal || event.orderId) && event.orderId !== order.id) return refuse('order_mismatch');
  if (!money(event.amountMinor) || !money(order.amountMinor)) return refuse('invalid_amount');
  if (!currencyCode(event.currency) || !currencyCode(order.currency) || event.currency !== order.currency) {
    return refuse('currency_mismatch');
  }
  if (event.kind === 'disputed' ? event.amountMinor > order.amountMinor : event.amountMinor !== order.amountMinor) {
    return refuse('amount_mismatch');
  }
  if (reversal) {
    if (!reference(event.providerRef, event.kind === 'refunded' ? 'ch' : 'dp')) return refuse('invalid_provider_reference');
    if (!reference(event.paymentIntentRef, 'pi') || !reference(order.paymentIntentRef, 'pi')) return refuse('payment_intent_unbound');
    if (event.paymentIntentRef !== order.paymentIntentRef) return refuse('payment_intent_mismatch');
    if (event.kind === 'refunded') {
      if (!money(event.amountRefunded) || event.amountRefunded > event.amountMinor
        || event.fullRefund !== (event.amountRefunded === event.amountMinor)) return refuse('invalid_refund_amount');
      if (!event.fullRefund) return settle('ignore', 'partial_refund');
      if (order.status === 'refunded') return settle('ignore_duplicate', 'order_refunded');
      return settle('refund', 'provider_refund');
    }
    if (order.status === 'disputed') return settle('ignore_duplicate', 'order_disputed');
    return settle('dispute', 'provider_dispute');
  }
  if (!reference(event.providerRef, 'cs_test') || !reference(order.providerRef, 'cs_test')
    || event.providerRef !== order.providerRef) return refuse('session_mismatch');
  if (order.paymentIntentRef && order.paymentIntentRef !== event.paymentIntentRef) return refuse('payment_intent_mismatch');
  if (event.kind === 'failed') return order.status === 'pending'
    ? settle('fail_order', 'delayed_payment_failed') : settle('ignore_duplicate', `order_${order.status}`);
  if (!GRANTING_KINDS.includes(event.kind)) return refuse('invalid_event_kind');
  if (event.paymentStatus !== 'paid') return refuse('payment_not_settled');
  if (!reference(event.paymentIntentRef, 'pi')) return refuse('missing_payment_intent');
  if (order.status !== 'pending') return settle('ignore_duplicate', `order_${order.status}`);
  if (!money(order.allowance) || !Number.isSafeInteger(order.termDays) || order.termDays < 1) return refuse('invalid_order_terms');
  const nowMs = now().getTime();
  const currentExpiry = entitlement?.expiresAt == null ? null : Date.parse(entitlement.expiresAt);
  if (!Number.isFinite(nowMs) || (currentExpiry !== null && !Number.isFinite(currentExpiry))) return refuse('invalid_expiry');
  const extending = currentExpiry !== null && currentExpiry > nowMs;
  const expiry = new Date((extending ? currentExpiry : nowMs) + order.termDays * DAY_MS);
  if (!Number.isFinite(expiry.getTime())) return refuse('invalid_order_terms');
  return { action: extending ? 'extend' : 'grant', reason: extending ? 'entitlement_active' : 'order_paid',
    grant: { allowance: order.allowance, termDays: order.termDays, expiresAt: expiry.toISOString() } };
}
