/**
 * The payments port (PAYMENTS-SLICE-01, contract §3).
 *
 * ONE PORT, A STUB FOR DEVELOPMENT, A REAL ADAPTER LATER — the rule INTEGRATIONS-01 already set for
 * email, inference and storage. This module owns the mode switch and the fail-closed shape; the
 * adapters live beside it. Nothing here reaches the network.
 *
 * WHY THE MODE IS EXPLICIT. An installation with no payment configuration must refuse to sell rather
 * than half-sell. `off` is the pilot's default and returns a port whose every call throws
 * `payments_unavailable`, so the route answers 503 and the client renders no buy button. `stripe`
 * throws at construction: the real adapter is deliberately not part of this slice, and a port that
 * pretended to be Stripe would be worse than no port at all.
 */
import { createStubPayments } from './stub.mjs';
import { ProviderError, readEvent } from './events.mjs';

export { InvalidSignature } from './signature.mjs';
export { ProviderError, InvalidPayload, EVENT_KINDS, GRANTING_KINDS, readEvent } from './events.mjs';

/**
 * Build the payments port.
 *
 * @param {{mode?: 'off'|'stub', now?: () => Date, webhookSecret?: string, publicOrigin?: string,
 *          termDays?: number, allowance?: number, market?: string}} [options]
 * @returns {object} the port; always carries `configured`, and a `reason` when it is not configured
 */
export function createPaymentsPort(options = {}) {
  const mode = options.mode || 'off';

  if (mode === 'stripe') {
    throw new ProviderError('stripe_adapter_not_built',
      'the Stripe adapter is not part of PAYMENTS-SLICE-01; see work/implementation/PAYMENTS-SLICE-01.md §5');
  }
  if (mode === 'stub') return createStubPayments(options);
  return unconfiguredPort(mode === 'off' ? 'payments_off' : `unknown_mode:${mode}`);
}

/**
 * The fail-closed shape.
 *
 * It exposes the same method names as a working port and throws on every one of them, so a caller
 * that forgets to check `configured` fails loudly instead of silently doing nothing. `readEvent`
 * stays usable because it is pure: it is needed to decide what an inbound event *would* mean, and it
 * grants nothing.
 */
function unconfiguredPort(reason) {
  const refuse = () => { throw new ProviderError('payments_unavailable', reason); };
  return Object.freeze({
    configured: false,
    mode: 'off',
    reason,
    createCheckoutSession: refuse,
    verifyWebhook: refuse,
    readEvent,
  });
}
