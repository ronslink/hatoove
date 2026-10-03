import { buildSignatureHeader } from './signature.mjs';
import { InvalidPayload, readEvent } from './events.mjs';
import { checkoutInput, checkoutReturn, paymentOrigin, requireWebhookSecret, verifiedEvent } from './boundary.mjs';

// Explicit synthetic adapter. It has no network capability and no default signing secret.
export function createStubPayments({ now = () => new Date(), webhookSecret, publicOrigin } = {}) {
  requireWebhookSecret(webhookSecret);
  const origin = paymentOrigin(publicOrigin);
  const sessions = new Map();
  return Object.freeze({
    configured: true,
    mode: 'stub',
    async createCheckoutSession(input) {
      const snapshot = checkoutInput(input);
      const providerSessionId = `cs_test_stub_${snapshot.orderId.replaceAll('-', '')}`;
      const previous = sessions.get(providerSessionId);
      if (previous && JSON.stringify(previous.snapshot) !== JSON.stringify(snapshot)) throw new InvalidPayload('order_snapshot_changed');
      if (previous) return { ...previous.result };
      const result = { url: `${checkoutReturn(origin, snapshot.orderId)}&checkout=stub`, providerSessionId,
        expiresAt: new Date(now().getTime() + 1800000).toISOString() };
      sessions.set(providerSessionId, { snapshot, result });
      return { ...result };
    },
    async verifyWebhook({ rawBody, signatureHeader }) {
      return verifiedEvent({ rawBody, signatureHeader, webhookSecret, now });
    },
    readEvent,
    signForTest(rawBody, timestamp = Math.floor(now().getTime() / 1000)) {
      return buildSignatureHeader({ rawBody, secret: webhookSecret, timestamp });
    },
    recordedSessions() { return structuredClone(sessions); },
  });
}
