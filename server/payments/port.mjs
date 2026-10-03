import { createStubPayments } from './stub.mjs';
import { createStripeTestPayments } from './stripe.mjs';
import { ProviderError, readEvent } from './events.mjs';

export { InvalidSignature } from './signature.mjs';
export { ProviderError, InvalidPayload, EVENT_KINDS, GRANTING_KINDS, readEvent } from './events.mjs';

// Payments are optional: bad or absent payment configuration must not break the rest of the app.
export function createPaymentsPort(options = {}) {
  const mode = options.mode || 'off';
  if (mode === 'off') return unconfiguredPort('payments_off');
  try {
    if (mode === 'stub') return createStubPayments(options);
    if (mode === 'stripe-test') return createStripeTestPayments(options);
    return unconfiguredPort('unsupported_payment_mode');
  } catch (error) {
    if (error instanceof ProviderError) return unconfiguredPort(error.reason);
    throw error;
  }
}

function unconfiguredPort(reason) {
  const refuse = () => { throw new ProviderError('payments_unavailable'); };
  return Object.freeze({ configured: false, mode: 'off', reason,
    createCheckoutSession: refuse, verifyWebhook: refuse, readEvent });
}
