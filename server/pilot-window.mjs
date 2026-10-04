/**
 * PILOT-WINDOW-01 — the pilot free window as a decision, not a read-only date.
 *
 * WHY THIS MODULE EXISTS
 * `server.js#readPilotFreeUntil()` parses `PILOT_FREE_UNTIL` and decides nothing, on purpose: the value, the
 * copy and the access rule were separated so each could be reviewed alone. The landing page shipped in PR #139
 * already states the commercial rule to learners, so this module is the runtime half of that promise.
 * `docs/contracts/PILOT-WINDOW-01.md` is the contract; this file is the pure decision and owns no I/O, no
 * database, no session and no clock of its own — `now` is always passed in, so every leg of the check is
 * deterministic and a test can stand on either side of the boundary without waiting for 2027.
 *
 * THE RULE, VERBATIM FROM THE SHIPPED COPY (`public-messages.js#faqFreeAnswer`):
 *   "Without a purchase the free test remains: the practice sample on this page and one complete test in
 *    reading and language elements on your account, with no writing feedback."
 *
 * THE THREE DECISIONS THIS FILE MAKES (D1–D3 in the contract):
 *
 *   D1 — THE LAST FREE DAY IS THE CONFIGURED DAY, IN UTC. "bis zum 14. Januar 2027" includes 14 January, so
 *        the window is OPEN while the current UTC calendar day is `<= freeUntil`. Comparing ISO days as
 *        strings is exact and needs no Date arithmetic; a Date would acquire the host's timezone, and this is
 *        one calendar day in every market. A commercial boundary must be deterministic rather than local.
 *
 *   D2 — AN UNCONFIGURED WINDOW NEVER GRANTS THE PAID SURFACE AND NEVER REMOVES THE FREE TEST. The accessor
 *        refuses a hard-coded fallback, so the consumer must decide; resolving to FREE for an account without
 *        a purchase is the only reading that is wrong in neither direction. An operator typo can never hand
 *        over the paid surface, and can never take away the baseline the page promises.
 *
 *   D3 — A PURCHASED PASS IS A `payment_grant`, NOT A NON-EMPTY ALLOWANCE. Registration may provision an
 *        allowance (`hatoove.registration_allowance`, migration 0023); that is a grant, not a purchase, and
 *        the rule keys on purchase. The database predicate lives in the adapter; this module only consumes the
 *        boolean so the decision stays pure and testable.
 */

import { readPilotFreeUntil } from '../server.js';

/** The two access tiers the window can resolve to. */
export const PILOT_FULL = 'full';
export const PILOT_FREE = 'free';

/**
 * The purchase-free baseline as ONE frozen value, so the gate, the check and the copy cannot drift apart.
 * `sections` is the reading + language-elements pair the copy promises; `completeTests` is "one complete
 * test"; `writingFeedback` is false because feedback is sold.
 */
export const FREE_SURFACE = Object.freeze({
  sections: Object.freeze(['LV', 'SB']),
  completeTests: 1,
  writingFeedback: false,
});

/** The UTC calendar day of an instant, as the `YYYY-MM-DD` string the comparison uses. */
function isoDay(now) {
  // A bad `now` is a PROGRAMMER error, not operator configuration: the env path never throws (D2), but a
  // caller passing `new Date('nonsense')` must not silently be treated as "the window is open".
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('pilotWindowState(env, now): now must be a valid Date');
  }
  return now.toISOString().slice(0, 10);
}

/**
 * Resolve the configured window at an instant.
 *
 * @param {Record<string, unknown>} [env] environment carrying `PILOT_FREE_UNTIL`
 * @param {Date} [now] the instant to resolve for; always passed in tests
 * @returns {{state: 'open'|'closed'|'unconfigured', freeUntil: string|null, reason: string|null}}
 */
export function pilotWindowState(env = process.env, now = new Date()) {
  const read = readPilotFreeUntil(env);
  if (!read.valid) {
    // `reason` is carried through unchanged so a caller can name the exact configuration fault and a
    // malformed value can never be mistaken for an absent one.
    return Object.freeze({ state: 'unconfigured', freeUntil: null, reason: read.reason });
  }
  // D1: ISO day strings compare lexicographically in calendar order. Equal days are still open.
  return Object.freeze({
    state: isoDay(now) > read.freeUntil ? 'closed' : 'open',
    freeUntil: read.freeUntil,
    reason: null,
  });
}

/**
 * Resolve the access tier for an account.
 *
 * The purchase is tested first: it is a durable entitlement rather than a calendar, so `reason` names it even
 * while the window is open. The resolved tier is identical either way in that case.
 *
 * @param {{window: {state: string}, purchasedPass?: boolean}} input
 * @returns {{access: 'full'|'free', reason: string}}
 */
export function resolvePilotAccess({ window: state, purchasedPass = false } = {}) {
  if (!state || typeof state.state !== 'string') {
    throw new TypeError('resolvePilotAccess(): window is required, as returned by pilotWindowState()');
  }
  if (purchasedPass === true) return Object.freeze({ access: PILOT_FULL, reason: 'purchased_pass' });
  if (state.state === 'open') return Object.freeze({ access: PILOT_FULL, reason: 'pilot_window_open' });
  // D2: closed and unconfigured both yield the free baseline — and never the paid surface.
  return Object.freeze({
    access: PILOT_FREE,
    reason: state.state === 'closed' ? 'pilot_window_closed' : 'pilot_window_unconfigured',
  });
}
