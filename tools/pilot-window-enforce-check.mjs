#!/usr/bin/env node
/**
 * PILOT-WINDOW-01 enforcement — the window decides access, and decides it explicitly.
 *
 * `tools/pilot-window-check.mjs` covers the ACCESSOR (\`readPilotFreeUntil\`) and `tools/seo-check.mjs\` leg S10
 * covers the COPY. Neither covers the DECISION, which is what actually gates a learner. This check does.
 *
 * It is deterministic and offline: every instant is passed in, so a leg can stand on either side of
 * 2027-01-14 without waiting for it or freezing the machine clock. No database, no port, no provider.
 *
 * The legs that matter are the ones that can fail:
 *   W2  the D1 boundary is exact — the configured day is INCLUSIVE and the next day is closed.
 *   W3  an unconfigured window never throws and names why.
 *   W4  the access table of contract §4 — including that an unconfigured window does NOT grant the paid
 *       surface without a purchase (the D2 resolution, which is the whole point of the decision).
 *   W6  once the window is closed, a free test must actually be designated in content (D5). While the window
 *       is open this leg reports the fact instead of failing, so it becomes a hard gate exactly when it
 *       starts to matter.
 *
 * Usage: node tools/pilot-window-enforce-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FREE_SURFACE, PILOT_FREE, PILOT_FULL, ROUTE_FREE, ROUTE_OPEN, ROUTE_PAID, classifyRoute, matchedRouteRule, pilotWindowRefusal, pilotWindowState, resolvePilotAccess } from '../server/pilot-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + detail);
};

/* The configured value, read once from the file the deployment actually sets. */
const compose = fs.readFileSync(path.join(ROOT, 'compose.production.yaml'), 'utf8');
const declared = (compose.match(/^\s*PILOT_FREE_UNTIL:\s*"?([^"#\r\n]*)"?\s*$/m) || [])[1]?.trim();
const configured = declared === undefined ? null : declared;

/* W1 — the configured value produces an open window on its own day and a closed one after. */
{
  if (configured === null) {
    record('W1', false, 'compose.production.yaml declares no PILOT_FREE_UNTIL');
  } else {
    const start = pilotWindowState({ PILOT_FREE_UNTIL: configured }, new Date(configured + 'T00:00:00.000Z'));
    const end = pilotWindowState({ PILOT_FREE_UNTIL: configured }, new Date(configured + 'T23:59:59.999Z'));
    if (start.state !== 'open' || start.freeUntil !== configured) {
      record('W1', false, 'at the start of the configured day the window is ' + JSON.stringify(start) + ', expected open');
    } else if (end.state !== 'open') {
      record('W1', false, 'at the end of the configured day the window is ' + JSON.stringify(end) + ', expected open (the day is inclusive)');
    } else {
      record('W1', true, configured + ' is open for the whole of its own UTC day');
    }
  }
}

/* W2 — D1: the last free day is inclusive; the next UTC day is the first closed one. */
{
  const problems = [];
  const at = (day) => new Date(day + 'T12:00:00.000Z');
  if (pilotWindowState({ PILOT_FREE_UNTIL: '2027-01-14' }, at('2027-01-13')).state !== 'open') problems.push('2027-01-13 should be open');
  if (pilotWindowState({ PILOT_FREE_UNTIL: '2027-01-14' }, at('2027-01-14')).state !== 'open') problems.push('2027-01-14 should be open (inclusive)');
  if (pilotWindowState({ PILOT_FREE_UNTIL: '2027-01-14' }, at('2027-01-15')).state !== 'closed') problems.push('2027-01-15 should be closed');
  if (pilotWindowState({ PILOT_FREE_UNTIL: '2027-01-14' }, at('2026-10-04')).state !== 'open') problems.push('a day before the window should be open');
  // A day boundary is a UTC day boundary: 23:59 UTC on 14 January is still the open day, and 00:00 on the 15th is not.
  if (pilotWindowState({ PILOT_FREE_UNTIL: '2027-01-14' }, new Date('2027-01-14T23:59:59.999Z')).state !== 'open') problems.push('23:59:59.999Z on 2027-01-14 should be open');
  if (pilotWindowState({ PILOT_FREE_UNTIL: '2027-01-14' }, new Date('2027-01-15T00:00:00.000Z')).state !== 'closed') problems.push('00:00:00.000Z on 2027-01-15 should be closed');
  if (problems.length) record('W2', false, problems.join(' | '));
  else record('W2', true, 'the configured day is inclusive in UTC and the next day is closed (both instants exact)');
}

/* W3 — an unconfigured window never throws, and the reason distinguishes absent from malformed. */
{
  const cases = [
    [undefined, 'not_configured'],
    ['', 'not_configured'],
    ['  ', 'not_configured'],
    ['14.01.2027', 'malformed'],
    ['2027-02-30', 'impossible_date'],
  ];
  const problems = [];
  for (const [value, reason] of cases) {
    let state;
    try {
      state = pilotWindowState({ PILOT_FREE_UNTIL: value }, new Date('2026-10-04T00:00:00.000Z'));
    } catch (error) {
      problems.push(JSON.stringify(value) + ' threw ' + error.message);
      continue;
    }
    if (state.state !== 'unconfigured' || state.freeUntil !== null || state.reason !== reason) {
      problems.push(JSON.stringify(value) + ' -> ' + JSON.stringify(state) + ', expected unconfigured/' + reason);
    }
  }
  if (problems.length) record('W3', false, problems.join(' | '));
  else record('W3', true, cases.length + ' absent/malformed configuration(s) resolve to unconfigured without throwing');
}

/* W4 — contract §4, the whole access table. */
{
  const open = { state: 'open' };
  const closed = { state: 'closed' };
  const unconfigured = { state: 'unconfigured' };
  const rows = [
    [open, false, PILOT_FULL, 'pilot_window_open'],
    [open, true, PILOT_FULL, 'purchased_pass'],
    [closed, true, PILOT_FULL, 'purchased_pass'],
    [closed, false, PILOT_FREE, 'pilot_window_closed'],
    [unconfigured, true, PILOT_FULL, 'purchased_pass'],
    [unconfigured, false, PILOT_FREE, 'pilot_window_unconfigured'],
  ];
  const problems = [];
  for (const [state, purchasedPass, access, reason] of rows) {
    const got = resolvePilotAccess({ window: state, purchasedPass });
    if (got.access !== access || got.reason !== reason) {
      problems.push(state.state + '/' + purchasedPass + ' -> ' + JSON.stringify(got) + ', expected ' + access + '/' + reason);
    }
  }
  // The D2 property stated as an inequality rather than a table row: an unconfigured window is never FULL
  // for an account without a purchase. A table can be edited to agree with a regression; this cannot.
  if (resolvePilotAccess({ window: unconfigured, purchasedPass: false }).access === PILOT_FULL) {
    problems.push('an unconfigured window granted the paid surface without a purchase');
  }
  if (problems.length) record('W4', false, problems.join(' | '));
  else record('W4', true, rows.length + ' access resolutions agree with the contract, and D2 holds as an inequality');
}

/* W5 — the free surface is the one the shipped copy promises, in the language the promise is made in. */
{
  const cataloguePath = path.join(ROOT, 'public', 'assets', 'i18n', 'public-messages.js');
  const catalogue = fs.existsSync(cataloguePath) ? fs.readFileSync(cataloguePath, 'utf8') : null;
  const problems = [];
  const sections = [...FREE_SURFACE.sections].sort().join('+');
  if (sections !== 'LV+SB') problems.push('FREE_SURFACE.sections is ' + sections + ', expected LV+SB');
  if (FREE_SURFACE.completeTests !== 1) problems.push('FREE_SURFACE.completeTests is ' + FREE_SURFACE.completeTests + ', expected 1');
  if (FREE_SURFACE.writingFeedback !== false) problems.push('FREE_SURFACE.writingFeedback is not false');
  if (catalogue === null) {
    problems.push('public/assets/i18n/public-messages.js is missing');
  } else {
    const german = (catalogue.match(/faqFreeAnswer:\s*\['([^']*)'/) || [])[1] || '';
    if (!/Lesen und Sprachbausteinen/.test(german)) problems.push('the German free FAQ does not name reading and language elements');
    if (!/vollst(ä|a)ndige[rn]? Test/.test(german)) problems.push('the German free FAQ does not promise one complete test');
    if (!/ohne R(ü|u)ckmeldung zum Schreiben/.test(german)) problems.push('the German free FAQ does not state that writing feedback is excluded');
  }
  if (problems.length) record('W5', false, problems.join(' | '));
  else record('W5', true, 'FREE_SURFACE matches the German free-test promise (LV+SB, one complete test, no writing feedback)');
}

/* W6 — D5: if the window is closed as of now, a free test must be designated in content. While it is open,
 * this records the fact rather than failing, so it turns into a hard gate exactly when it starts to matter. */
{
  const now = new Date();
  const state = configured === null
    ? { state: 'unconfigured', freeUntil: null }
    : pilotWindowState({ PILOT_FREE_UNTIL: configured }, now);
  const manifests = fs.existsSync(path.join(ROOT, 'content', 'exams'))
    ? fs.readdirSync(path.join(ROOT, 'content', 'exams'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(ROOT, 'content', 'exams', entry.name, 'manifest.json'))
      .filter((file) => fs.existsSync(file))
    : [];
  const designated = [];
  for (const file of manifests) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const form of Array.isArray(manifest.forms) ? manifest.forms : []) {
      if (form && form.pilotFree === true) designated.push(manifest.exam?.id + ':' + form.id);
    }
  }
  if (state.state === 'open') {
    record('W6', true, 'the window is open until ' + state.freeUntil + '; a pilotFree designation is not required yet (' + designated.length + ' designated)');
  } else if (designated.length !== FREE_SURFACE.completeTests) {
    record('W6', false, 'the window is ' + state.state + ' and ' + designated.length + ' form(s) carry pilotFree, expected exactly ' + FREE_SURFACE.completeTests + ' — the promised free test would not be reachable');
  } else {
    record('W6', true, 'the window is ' + state.state + ' and ' + designated.join(', ') + ' is the designated free test');
  }
}

/* W7 — contract §6: the class of every route family. The mock-run family is asserted as a FAMILY — index,
 * start, detail, saves, playback and media — because §6's own note ("only runs of the designated free form")
 * presupposes that a free account HAS runs it can start and resume; the free-surface filter decides what is
 * visible inside the family, and that is the next checkpoint. */
{
  const table = [
    ['GET', '/api/auth/sign-in/email', ROUTE_OPEN],
    ['GET', '/api/v1/account', ROUTE_OPEN],
    ['PUT', '/api/v1/account/password', ROUTE_OPEN],
    ['DELETE', '/api/v1/sessions', ROUTE_OPEN],
    ['GET', '/api/v1/export', ROUTE_OPEN],
    ['PUT', '/api/v1/settings', ROUTE_OPEN],
    ['GET', '/api/v1/exams', ROUTE_OPEN],
    ['GET', '/api/v1/preparations', ROUTE_OPEN],
    ['GET', '/api/v1/tasks', ROUTE_OPEN],
    ['GET', '/api/v1/checkout/offer', ROUTE_OPEN],
    ['POST', '/api/v1/checkout/session', ROUTE_OPEN],
    ['GET', '/api/v1/orders/abc', ROUTE_OPEN],
    ['POST', '/api/v1/payments/stripe/webhook', ROUTE_OPEN],
    ['GET', '/api/v1/mock-forms', ROUTE_FREE],
    ['GET', '/api/v1/mock-runs', ROUTE_FREE],
    ['POST', '/api/v1/mock-runs', ROUTE_FREE],
    ['GET', '/api/v1/mock-runs/abc', ROUTE_FREE],
    ['PUT', '/api/v1/mock-runs/abc', ROUTE_FREE],
    ['POST', '/api/v1/mock-runs/abc/finalise', ROUTE_FREE],
    ['GET', '/api/v1/mock-runs/abc/playback', ROUTE_FREE],
    ['GET', '/api/v1/mock-runs/abc/media/telc-deutsch-b1.hv2.01.audio/v1', ROUTE_FREE],
    ['GET', '/api/v1/attempts', ROUTE_FREE],
    ['POST', '/api/v1/attempts', ROUTE_FREE],
    ['GET', '/api/v1/objective-sets', ROUTE_FREE],
    ['GET', '/api/v1/practice/next', ROUTE_PAID],
    ['GET', '/api/v1/vocab', ROUTE_PAID],
    ['GET', '/api/v1/nouns', ROUTE_PAID],
    ['GET', '/api/v1/guides', ROUTE_PAID],
    ['POST', '/api/v1/sentence-check', ROUTE_PAID],
  ];
  const wrong = table
    .filter(([method, route, expected]) => classifyRoute(method, route) !== expected)
    .map(([method, route, expected]) => `${method} ${route} is ${classifyRoute(method, route)}, expected ${expected}`);
  if (wrong.length) record('W7', false, wrong.join(' | '));
  else record('W7', true, table.length + ' route cases match contract §6');
}

/* W8 — D6: a route no rule covers is PAID, and "uncovered" stays observable instead of invisible. */
{
  const unknown = ['/api/v1/invented', '/api/v2/thing', '/api/v1/mock-forms/x', '/', '/api/auth', '/api/v1'];
  const notPaid = unknown.filter((route) => classifyRoute('GET', route) !== ROUTE_PAID);
  const claimed = unknown.filter((route) => matchedRouteRule('GET', route) !== null);
  if (notPaid.length) record('W8', false, 'unclassified routes are not ' + ROUTE_PAID + ': ' + notPaid.join(', '));
  else if (claimed.length) record('W8', false, 'no rule covers these, yet they are reported as classified: ' + claimed.join(', '));
  else record('W8', true, unknown.length + ' unclassified routes fail closed to ' + ROUTE_PAID + ' without claiming a rule');
}

/* W9 — the refusal contract (§7): only a PAID route, and only without a purchase and without an open window,
 * is refused. The resolution is fed straight into the refusal so the two halves cannot drift. */
{
  const closed = { access: PILOT_FREE, reason: 'pilot_window_closed' };
  const unconfigured = { access: PILOT_FREE, reason: 'pilot_window_unconfigured' };
  const open = { access: PILOT_FULL, reason: 'pilot_window_open' };
  const bought = { access: PILOT_FULL, reason: 'purchased_pass' };
  const cases = [
    ['closed + paid', pilotWindowRefusal(closed, ROUTE_PAID), { status: 402, code: 'pilot_window_closed' }],
    ['unconfigured + paid', pilotWindowRefusal(unconfigured, ROUTE_PAID), { status: 402, code: 'pilot_window_unconfigured' }],
    ['closed + free route', pilotWindowRefusal(closed, ROUTE_FREE), null],
    ['closed + open route', pilotWindowRefusal(closed, ROUTE_OPEN), null],
    ['open window + paid', pilotWindowRefusal(open, ROUTE_PAID), null],
    ['purchase + closed + paid', pilotWindowRefusal(bought, ROUTE_PAID), null],
  ];
  const wrong = cases
    .filter(([, actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected))
    .map(([label, actual]) => label + ': got ' + JSON.stringify(actual));
  // Composed end to end: a real closed window must refuse a paid route with exactly the JSON §7 prints.
  const live = pilotWindowRefusal(resolvePilotAccess({ window: { state: 'closed' } }), ROUTE_PAID);
  if (live?.status !== 402 || live.code !== 'pilot_window_closed') {
    wrong.push('a closed window does not refuse a paid route with 402 pilot_window_closed');
  }
  if (wrong.length) record('W9', false, wrong.join(' | '));
  else record('W9', true, cases.length + 1 + ' refusal cases, including the §7 JSON exactly');
}

/* W10 — acceptance 3: every route literal the owned API actually serves matched a rule, so a new route cannot
 * be unclassified by accident, and a leg that finds nothing cannot pass by being vacuous. This reads literals
 * only: a path built inside a regular expression is covered by D6 rather than enumerated here. */
{
  const api = fs.readFileSync(path.join(ROOT, 'server', 'owned-api.mjs'), 'utf8');
  // `/api/v1` and its trailing-slash form are the mount prefix the gate recognises, not product routes: the
  // literal appears only because `isOwnedPath` tests `startsWith`, and a request for the bare prefix has no
  // handler to protect.
  const literals = [...new Set([...api.matchAll(/'(\/api\/(?:v1|auth)[^']*)'/g)].map((match) => match[1]))]
    .filter((route) => route !== '/api/v1' && route !== '/api/v1/');
  const unclassified = literals.filter((route) => !['GET', 'POST', 'PUT', 'DELETE']
    .some((method) => matchedRouteRule(method, route) !== null));
  if (!literals.length) record('W10', false, 'no route literals found in server/owned-api.mjs — this leg would be vacuous');
  else if (unclassified.length) record('W10', false, unclassified.length + ' served route(s) match no rule: ' + unclassified.join(', '));
  else record('W10', true, 'all ' + literals.length + ' route literals in server/owned-api.mjs are classified');
}

const failed = results.filter((row) => !row.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed' + (failed.length ? ' — FAILED: ' + failed.map((row) => row.id).join(', ') : '') + '\n');
process.exitCode = failed.length ? 1 : 0;
