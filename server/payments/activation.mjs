/**
 * The activation decision (PAYMENTS-SLICE-01, contract §4).
 *
 * PURE ON PURPOSE. It takes an event, the order it claims to be for, the learner's current
 * entitlement and a clock, and returns what should happen. No database, no network, no `Date.now()`.
 * That is what makes "exactly once" provable offline, before PostgreSQL is involved: the same
 * function the running server calls is the one `tools/payment-path-check.mjs` drives, so the check
 * cannot pass while the server behaves differently.
 *
 * WHY THE ORDER CARRIES THE TERMS. The allowance and the term come from the ORDER's snapshot, not
 * from the current catalogue and not from the event. A pass sold as ten assessments for eight weeks
 * must still grant ten for eight weeks after a price change, and an event that disagrees with the
 * order about the amount is refused rather than honoured.
 */
import { GRANTING_KINDS } from './events.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every outcome this decision can produce. `refuse` means "do not grant and tell the caller"; the
 * webhook route records a refused-but-authentic event for an operator instead of asking the provider
 * to retry something that will never match.
 */
export const ACTIVATION_ACTIONS = Object.freeze([
  'grant', 'extend', 'ignore_duplicate', 'ignore', 'fail_order', 'refund', 'dispute', 'refuse',
]);

/**
 * @param {{event: object, order: object|null, entitlement?: object|null, now?: () => Date}} input
 *   `order` is the stored purchase: `{ id, status, amountMinor, currency, allowance, termDays,
 *   expiresAt? , providerRef? }`. `entitlement` is the learner's current balance for that exam:
 *   `{ allowance, used, reserved, expiresAt }` or null.
 * @returns {{action: string, reason: string, grant: {allowance: number, termDays: number,
 *   expiresAt: string}|null}}
 */
export function decideActivation({ event, order, entitlement = null, now = () => new Date() } = {}) {
  const refuse = (reason) => ({ action: 'refuse', reason, grant: null });
  const settle = (action, reason) => ({ action, reason, grant: null });

  if (!event || typeof event !== 'object') return refuse('event_missing');
  // The event id is the idempotency key. Without it, once-only cannot be proved, so it is refused
  // rather than granted and hoped about.
  if (typeof event.id !== 'string' || event.id === '') return refuse('event_without_id');
  if (event.kind === 'ignored' || !event.kind) return settle('ignore', 'event_not_relevant');

  if (!order || typeof order !== 'object') return refuse('unknown_order');

  // An event that disagrees with the order about the money never activates it. This is the check that
  // makes a mismatched provider reference, a currency mistake or a stale price an explicit refusal.
  if (Number.isInteger(event.amountMinor) && Number.isInteger(order.amountMinor) && event.amountMinor !== order.amountMinor) {
    return refuse('amount_mismatch');
  }
  if (event.currency && order.currency && event.currency !== order.currency) return refuse('currency_mismatch');

  if (GRANTING_KINDS.includes(event.kind)) {
    // Already settled: a redelivery, a manual resend, or two deliveries racing. Nothing may change.
    if (order.status === 'paid') return settle('ignore_duplicate', 'order_already_paid');
    if (order.status === 'refunded' || order.status === 'disputed') return settle('ignore_duplicate', `order_${order.status}`);
    if (order.status !== 'pending') return settle('ignore_duplicate', `order_${order.status}`);
    // A provider reference already recorded for a different event is the same purchase seen twice.
    if (order.providerRef && event.providerRef && order.providerRef === event.providerRef) {
      return settle('ignore_duplicate', 'provider_reference_reused');
    }

    // The terms come from the snapshot. An order without them cannot be granted, and this is refused
    // rather than defaulted so a half-written order can never quietly sell the wrong allowance.
    const allowance = Number.isInteger(order.allowance) ? order.allowance : null;
    const termDays = Number.isInteger(order.termDays) ? order.termDays : null;
    if (allowance === null || allowance < 0) return refuse('order_missing_allowance');
    if (termDays === null || termDays <= 0) return refuse('order_missing_term');

    // Extending starts from the remaining time, so buying twice in a row adds time rather than
    // discarding what is left.
    const nowMs = now().getTime();
    const current = entitlement && typeof entitlement.expiresAt === 'string' ? Date.parse(entitlement.expiresAt) : NaN;
    const extending = Number.isFinite(current) && current > nowMs;
    const base = extending ? current : nowMs;

    return {
      action: extending ? 'extend' : 'grant',
      reason: extending ? 'entitlement_active' : 'order_paid',
      grant: { allowance, termDays, expiresAt: new Date(base + termDays * DAY_MS).toISOString() },
    };
  }

  if (event.kind === 'failed') {
    // A delayed payment that failed only fails an order that is still waiting. A paid order is never
    // un-paid by a later failure event; that is what refunds and disputes are for.
    if (order.status !== 'pending') return settle('ignore_duplicate', `order_${order.status}`);
    return settle('fail_order', 'delayed_payment_failed');
  }

  // Refunds and disputes set state and never grant. What they do to an already-spent allowance is a
  // policy decision that is still open (STRIPE-PAYMENT-PATH-01 §7), so the decision stops here and
  // records the fact rather than inventing a clawback.
  if (event.kind === 'refunded') return settle('refund', 'provider_refund');
  if (event.kind === 'disputed') return settle('dispute', 'provider_dispute');

  return settle('ignore', 'event_not_relevant');
}
