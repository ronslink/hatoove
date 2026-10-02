/**
 * THE DELIVERY SEAM — where a message to a learner would leave the application.
 *
 * This file exists because of a decision, not a preference. D6 (the email provider) is unanswered: the
 * provider is a data processor whose terms a human has to accept, and nothing here may pretend that has
 * happened. So the pilot's implementation is **operator-assisted**: the link is written to the operator
 * console, an operator passes it to the learner by whatever channel is agreed, and **no message leaves the
 * building**.
 *
 * THE POINT OF PUTTING IT BEHIND ONE MODULE is that adopting a provider is then one file and one dependency,
 * and the privacy audit gains one processor instead of a redesign. Every caller passes a `{to, kind, link}`
 * message and knows nothing about how it travels — which is also why the checks inject their own `send` and
 * can assert what the operator received without a mail server existing.
 *
 * WHAT THE CONSOLE IMPLEMENTATION DELIBERATELY DOES NOT DO:
 *
 *   * it never logs a password, a session token or a password hash — only the link, which is single-use,
 *     time-bounded and useless to anyone who cannot also reach the learner;
 *   * it does not print the recipient's address into the message body beyond the `to` field it was given, so
 *     an operator log stays a log of deliveries rather than a list of who is recovering an account;
 *   * it never throws for a delivery that merely failed. The caller's answer must not depend on delivery, or
 *     a broken console would become a way to learn which addresses exist.
 *
 * A REAL PROVIDER REPLACES THIS FILE and must keep three properties: never log the link, never throw into the
 * caller's response, and never include anything but what the caller passed.
 */

/**
 * The link a learner would follow. Built HERE, by the delivery channel, because the origin belongs to the
 * deployment's configuration and the auth port has no business knowing it.
 */
export function resetLink({ publicOrigin, token }) {
  const base = String(publicOrigin || '').replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * A delivery channel, given a way to deliver.
 *
 * THE LINK IS BUILT HERE AND NOWHERE ELSE. The first version of this file let the auth port build the link
 * from a `notifyOrigin` the port had been given separately, while the notifier held the same origin unused —
 * two places for one value, and they disagreed: the running container logged a link with **no origin at all**,
 * and only the real-stack check noticed, because the disposable fixture happened to pass the origin to the
 * port. One value, one builder.
 *
 * @param {{deliver: Function, publicOrigin?: string, channel?: string}} options
 */
export function createNotifier({ deliver, publicOrigin = null, channel = 'operator-console' } = {}) {
  if (typeof deliver !== 'function') throw new TypeError('createNotifier requires a deliver function');
  return {
    channel,
    /**
     * @param {{to: string, kind: string, token: string, expiresAt?: string}} message the token, not the link:
     *   the link is this channel's business, and a caller that cannot build one cannot build it wrong.
     */
    async send(message) {
      const link = resetLink({ publicOrigin, token: message.token });
      return deliver({ ...message, link });
    },
  };
}

/**
 * @param {{log?: Function, publicOrigin?: string}} options `log` is injectable so a check can capture
 *   deliveries instead of printing them; `publicOrigin` is where the learner-facing link points, which is a
 *   deployment value rather than something to guess from a request header.
 */
export function createConsoleNotifier({ log = console.log, publicOrigin = null } = {}) {
  return createNotifier({
    publicOrigin,
    channel: 'operator-console',
    async deliver(message) {
      try {
        const at = message.expiresAt ? ` (valid until ${message.expiresAt})` : '';
        log(`[notify] ${message.kind} for ${message.to}${at}: ${message.link}`);
        return { delivered: true, channel: 'operator-console' };
      } catch {
        // A logging failure is not an authentication failure. The caller must answer the same either way.
        return { delivered: false, channel: 'operator-console' };
      }
    },
  });
}
