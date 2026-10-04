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

/* ---------------------------------------------------------------------------------------------------------
 * ROUTE CLASSIFICATION (contract §6, D6)
 *
 * The window only means something if a request can be classified. §6 is a table of route families, so it is
 * transcribed here as data rather than as a chain of `if`s: a leg can then assert that every route the API
 * actually serves matched a rule, and a NEW route that matches none is `paid` by the default (D6 fail closed).
 *
 * WHY THE MOCK-RUN FAMILY IS `free` AND NOT MERELY THE INDEX. §6 lists `GET /api/v1/mock-runs` as free and
 * notes "Only runs of the designated free form", which presupposes that a free account HAS runs: the promise is
 * one complete reading + language-elements test, and a test that cannot be started, saved, resumed or played
 * is not a test. So the whole family — index, detail, saves, finalise, playback and media — is reachable, and
 * WHAT a free account may see inside it is the free-surface filter (D4/D5), which is the next checkpoint.
 * Until that filter lands, enforcement must not be turned on by moving the boundary: a free account would be
 * reachable to every form. The window opens on 2027-01-15; that filter is due before it.
 * ------------------------------------------------------------------------------------------------------- */

/** The three classes of contract §6. */
export const ROUTE_OPEN = 'open';
export const ROUTE_FREE = 'free';
export const ROUTE_PAID = 'paid';

/** `/api/v1/mock-runs/<id>` and its sub-resources, without matching the index itself. */
const MOCK_RUN_DETAIL = /^\/api\/v1\/mock-runs\/[^/]+(?:\/.*)?$/;

/** A route family: the collection path itself and everything below it. */
const under = (base) => (method, path) => path === base || path.startsWith(base + '/');

/**
 * The table of §6, in order. `match` receives the method and pathname; the first match wins. Keeping it as
 * data is what lets a leg walk the API's own route literals and prove none of them silently fell through.
 */
export const ROUTE_RULES = Object.freeze([
  // OPEN — never gated by the window. Sign-in, the learner's own data rights, navigation metadata and the
  // purchase path itself: a closed window is exactly when checkout must work.
  { id: 'auth', access: ROUTE_OPEN, match: (method, path) => path.startsWith('/api/auth/') },
  { id: 'account', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/account' || path === '/api/v1/account/password' },
  { id: 'sessions', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/sessions' },
  { id: 'export', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/export' },
  { id: 'settings', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/settings' },
  { id: 'catalogue', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/exams' || path === '/api/v1/preparations' },
  { id: 'tasks', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/tasks' },
  { id: 'checkout', access: ROUTE_OPEN, match: (method, path) => path === '/api/v1/checkout/offer' || path === '/api/v1/checkout/session' },
  { id: 'orders', access: ROUTE_OPEN, match: under('/api/v1/orders') },
  { id: 'payments', access: ROUTE_OPEN, match: under('/api/v1/payments') },

  // FREE — the purchase-free baseline: the designated complete test and the learner's own history.
  { id: 'mock-forms', access: ROUTE_FREE, match: (method, path) => method === 'GET' && path === '/api/v1/mock-forms' },
  { id: 'mock-runs', access: ROUTE_FREE, match: (method, path) => path === '/api/v1/mock-runs' || MOCK_RUN_DETAIL.test(path) },
  { id: 'attempts', access: ROUTE_FREE, match: (method, path) => path === '/api/v1/attempts' },
  { id: 'objective-sets', access: ROUTE_FREE, match: (method, path) => method === 'GET' && path === '/api/v1/objective-sets' },

  // PAID — everything the copy sells. Listed explicitly so the table reads as the contract, not as its absence.
  { id: 'practice', access: ROUTE_PAID, match: under('/api/v1/practice') },
  { id: 'reference', access: ROUTE_PAID, match: (method, path) => ['/api/v1/vocab', '/api/v1/nouns', '/api/v1/guides'].includes(path) },
  { id: 'sentence-check', access: ROUTE_PAID, match: (method, path) => method === 'POST' && path === '/api/v1/sentence-check' },
]);

/** The rule a request matched, or null. Exported so a check can prove no served route falls through. */
export function matchedRouteRule(method, pathname) {
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  const path = typeof pathname === 'string' ? pathname : '';
  return ROUTE_RULES.find((rule) => rule.match(verb, path)) ?? null;
}

/**
 * The class of a request. D6: an unclassified route is `paid`, so a new route is never free by accident.
 *
 * @param {string} method HTTP method
 * @param {string} pathname request path
 * @returns {'open'|'free'|'paid'}
 */
export function classifyRoute(method, pathname) {
  return matchedRouteRule(method, pathname)?.access ?? ROUTE_PAID;
}

/**
 * The refusal a gated request receives, or null when the request may proceed.
 *
 * This is the ONE place the decision and the classification meet, so the gate itself stays a call and a
 * branch. `code` is the resolution reason, which is exactly `pilot_window_closed` in the case contract §7
 * shows; the unconfigured window names itself rather than claiming the window is closed, because an operator
 * typo must be diagnosable from the answer.
 *
 * @param {{access: string, reason: string}} resolution as returned by resolvePilotAccess()
 * @param {'open'|'free'|'paid'} routeClass
 * @returns {{status: number, code: string}|null}
 */
export function pilotWindowRefusal(resolution, routeClass) {
  if (!resolution || typeof resolution.access !== 'string') {
    throw new TypeError('pilotWindowRefusal(): resolution is required, as returned by resolvePilotAccess()');
  }
  if (routeClass === ROUTE_OPEN || routeClass === ROUTE_FREE) return null;
  if (resolution.access === PILOT_FULL) return null;
  return Object.freeze({ status: 402, code: resolution.reason });
}
