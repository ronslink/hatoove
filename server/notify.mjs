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
 * WHERE A LINK SENDS THE LEARNER, per kind of message.
 *
 * The first version had a single `resetLink`, which is fine until a second kind exists — and then a
 * verification link would quietly point at the reset page, where the learner would type a new password to
 * "verify" an address. A link's destination belongs with the kind of message that carries it.
 */
import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';

const LINK_PATHS = Object.freeze({
  'password-reset': '/reset-password',
  'email-verification': '/verify-email',
});

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const DEFAULT_RESEND_FROM = 'Hatoove <noreply@hatoove.com>';
const RESEND_KEY_RE = /^re_[A-Za-z0-9_-]{8,256}$/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The link a learner would follow. Built HERE, by the delivery channel, because the origin belongs to the
 * deployment's configuration and the auth port has no business knowing it.
 *
 * An unknown kind is a programming error rather than something to guess at: a link that goes somewhere
 * unintended is worse than a failure to send.
 */
export function linkFor({ publicOrigin, kind, token }) {
  const page = LINK_PATHS[kind];
  if (!page) throw new TypeError(`no link page is defined for message kind "${kind}"`);
  const base = String(publicOrigin || '').replace(/\/+$/, '');
  return `${base}${page}?token=${encodeURIComponent(token)}`;
}

/**
 * Build the learner-facing transactional email subject, plain-text body and HTML body for a verification or
 * password-reset link. Contains only what the caller passed (`kind` and `link`), never tokens from another
 * account or external tracking assets.
 */
export function emailPayloadFor({ kind, link }) {
  const safeHref = escapeHtml(link);
  if (kind === 'email-verification') {
    return {
      subject: 'E-Mail-Adresse bestätigen · Hatoove',
      text: [
        'Willkommen bei Hatoove!',
        '',
        'Bitte bestätigen Sie Ihre E-Mail-Adresse über den folgenden Link:',
        link,
        '',
        'Nach dem Öffnen des Links bestätigen Sie Ihre Adresse auf der Seite. Falls Sie kein Konto bei Hatoove erstellt haben, können Sie diese E-Mail ignorieren.',
        '',
        '---',
        '',
        'Please verify your email address for your Hatoove account using the link above. If you did not create a Hatoove account, you can safely ignore this email.',
      ].join('\n'),
      html: [
        '<div style="font-family:sans-serif;line-height:1.5;color:#242320;max-width:560px">',
        '<p><strong>Willkommen bei Hatoove!</strong></p>',
        '<p>Bitte bestätigen Sie Ihre E-Mail-Adresse über den folgenden Link:</p>',
        `<p><a href="${safeHref}" style="color:#ff6b2b;font-weight:600">${safeHref}</a></p>`,
        '<p style="color:#5c5852;font-size:14px">Nach dem Öffnen des Links bestätigen Sie Ihre Adresse auf der Seite. Falls Sie kein Konto bei Hatoove erstellt haben, können Sie diese E-Mail ignorieren.</p>',
        '<hr style="border:none;border-top:1px solid #e5e0d8;margin:20px 0">',
        '<p style="color:#5c5852;font-size:14px">Please verify your email address for your Hatoove account using the link above. If you did not create a Hatoove account, you can safely ignore this email.</p>',
        '</div>',
      ].join(''),
    };
  }
  if (kind === 'password-reset') {
    return {
      subject: 'Neues Passwort festlegen · Hatoove',
      text: [
        'Sie haben einen Link zum Zurücksetzen Ihres Passworts bei Hatoove angefordert:',
        link,
        '',
        'Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren. Ihr bestehendes Passwort bleibt unverändert.',
        '',
        '---',
        '',
        'You requested a link to reset your Hatoove password. If you did not request this, you can safely ignore this email.',
      ].join('\n'),
      html: [
        '<div style="font-family:sans-serif;line-height:1.5;color:#242320;max-width:560px">',
        '<p>Sie haben einen Link zum Zurücksetzen Ihres Passworts bei Hatoove angefordert:</p>',
        `<p><a href="${safeHref}" style="color:#ff6b2b;font-weight:600">${safeHref}</a></p>`,
        '<p style="color:#5c5852;font-size:14px">Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren. Ihr bestehendes Passwort bleibt unverändert.</p>',
        '<hr style="border:none;border-top:1px solid #e5e0d8;margin:20px 0">',
        '<p style="color:#5c5852;font-size:14px">You requested a link to reset your Hatoove password. If you did not request this, you can safely ignore this email.</p>',
        '</div>',
      ].join(''),
    };
  }
  throw new TypeError(`no email template is defined for message kind "${kind}"`);
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
 * @param {{deliver: Function, publicOrigin?: string, channel?: string, sendOnSignUp?: boolean}} options
 */
export function createNotifier({ deliver, publicOrigin = null, channel = 'operator-console', sendOnSignUp = false } = {}) {
  if (typeof deliver !== 'function') throw new TypeError('createNotifier requires a deliver function');
  return {
    channel,
    sendOnSignUp: Boolean(sendOnSignUp),
    /**
     * @param {{to: string, kind: string, token: string, expiresAt?: string}} message the token, not the link:
     *   the link is this channel's business, and a caller that cannot build one cannot build it wrong.
     */
    async send(message) {
      const link = linkFor({ publicOrigin, kind: message.kind, token: message.token });
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
    sendOnSignUp: false,
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

function readSecretFile(filePath) {
  let fd;
  try {
    if (typeof filePath !== 'string' || !filePath) throw new Error('resend_secret_invalid');
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4098) throw new Error('resend_secret_invalid');
    const bytes = Buffer.alloc(4099);
    let count = 0, size;
    while (count < bytes.length && (size = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += size;
    if (count > 4098) throw new Error('resend_secret_invalid');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)).replace(/\r?\n$/, '');
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore close error */ }
  }
}

export function readResendApiKey(env = {}) {
  const hasLiteral = Object.hasOwn(env, 'RESEND_API_KEY') && env.RESEND_API_KEY !== undefined && env.RESEND_API_KEY !== '';
  const hasFile = Object.hasOwn(env, 'RESEND_API_KEY_FILE') && env.RESEND_API_KEY_FILE !== undefined && env.RESEND_API_KEY_FILE !== '';
  if (hasLiteral && hasFile) {
    const error = new Error('resend_secret_conflict');
    error.code = 'resend_secret_conflict';
    throw error;
  }
  const raw = hasFile ? readSecretFile(env.RESEND_API_KEY_FILE) : hasLiteral ? env.RESEND_API_KEY : null;
  if (typeof raw !== 'string' || !RESEND_KEY_RE.test(raw)) {
    const error = new Error('resend_api_key_invalid');
    error.code = 'resend_api_key_invalid';
    throw error;
  }
  return raw;
}

/**
 * Transactional email delivery through Resend (`POST https://api.resend.com/emails`).
 *
 * Keeps the three invariants declared at the top of this file:
 *   1. Never logs the verification/reset link, token, recipient address or API key;
 *   2. Never throws into the caller's response (returns `{delivered: false, channel: 'resend'}` on error);
 *   3. Includes only what the caller passed (`to`, `kind`, `link`), and marks `sendOnSignUp: true` so new
 *      registrations automatically dispatch an address-verification email without blocking `/app/` entry.
 */
export function createResendNotifier({
  apiKey,
  from = DEFAULT_RESEND_FROM,
  publicOrigin = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  logError = console.error,
} = {}) {
  if (typeof apiKey !== 'string' || !RESEND_KEY_RE.test(apiKey)) {
    const error = new Error('resend_api_key_invalid');
    error.code = 'resend_api_key_invalid';
    throw error;
  }
  if (typeof from !== 'string' || !from.trim() || from.length > 320 || /[\r\n\0]/.test(from)) {
    const error = new Error('resend_from_invalid');
    error.code = 'resend_from_invalid';
    throw error;
  }
  if (publicOrigin !== null) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      const error = new Error('resend_origin_invalid');
      error.code = 'resend_origin_invalid';
      throw error;
    }
  }
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    const error = new Error('resend_configuration_invalid');
    error.code = 'resend_configuration_invalid';
    throw error;
  }
  return createNotifier({
    publicOrigin,
    channel: 'resend',
    sendOnSignUp: true,
    async deliver(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { subject, text, html } = emailPayloadFor(message);
        const response = await fetchImpl(RESEND_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject,
            text,
            html,
          }),
        });
        if (response && response.status >= 200 && response.status < 300) {
          return { delivered: true, channel: 'resend' };
        }
        if (typeof logError === 'function') {
          logError(`[notify] resend delivery failed (${message.kind}, status ${response ? response.status : 'unknown'})`);
        }
        return { delivered: false, channel: 'resend' };
      } catch {
        if (typeof logError === 'function') {
          logError(`[notify] resend delivery failed (${message && message.kind ? message.kind : 'unknown'})`);
        }
        return { delivered: false, channel: 'resend' };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/**
 * Select the configured delivery channel for the running server.
 *
 * Uses Resend when `NOTIFY_MODE=resend` or when `RESEND_API_KEY` / `RESEND_API_KEY_FILE` is supplied;
 * falls back to `createConsoleNotifier` when `NOTIFY_MODE=console`, when no key is configured, or when
 * optional provider configuration is invalid (so bad email configuration cannot take down the server).
 */
export function createConfiguredNotifier({
  env = process.env,
  log = console.log,
  logError = console.error,
  publicOrigin = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = publicOrigin ?? (env.B1PREP_PUBLIC_ORIGIN || env.HATOVE_PUBLIC_ORIGIN || null);
  const hasResendInput = Boolean(
    (typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.trim() !== '')
    || (typeof env.RESEND_API_KEY_FILE === 'string' && env.RESEND_API_KEY_FILE.trim() !== ''),
  );
  const mode = env.NOTIFY_MODE || (hasResendInput ? 'resend' : 'console');
  if (mode === 'console') {
    return createConsoleNotifier({ log, publicOrigin: origin });
  }
  if (mode === 'resend') {
    try {
      const apiKey = readResendApiKey(env);
      const from = (typeof env.RESEND_FROM === 'string' && env.RESEND_FROM.trim() !== '')
        ? env.RESEND_FROM.trim()
        : DEFAULT_RESEND_FROM;
      return createResendNotifier({ apiKey, from, publicOrigin: origin, fetchImpl, logError });
    } catch {
      if (typeof logError === 'function') {
        logError('  Notifications unavailable: invalid Resend configuration; falling back to operator-console.');
      }
      return createConsoleNotifier({ log, publicOrigin: origin });
    }
  }
  if (typeof logError === 'function') {
    logError('  Notifications unavailable: unsupported NOTIFY_MODE; falling back to operator-console.');
  }
  return createConsoleNotifier({ log, publicOrigin: origin });
}
