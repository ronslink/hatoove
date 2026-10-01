#!/usr/bin/env node
/**
 * PILOT-01c — the page-surface auth gate check.
 *
 * Ron, 1 October 2026: "the pages should be auth gated so only authenticated users are allowed".
 *
 * Before this slice the runtime served the whole application to anyone: `GET /` returned the app,
 * and `GET /data/seed.json` returned **180 answer keys**. The API was gated; the pages were not.
 * A gate that only covers the API is not a gate, because the content is on the page surface.
 *
 * WHAT IS PUBLIC, AND WHY
 *   `/signin`                you cannot sign in from behind a sign-in gate
 *   `/assets/design/**`      the design system the sign-in page needs; holds no learner data
 *   `/api/auth/**`           the auth endpoints themselves
 *   `/api/health`, `/api/ready`   liveness, for the container healthcheck and a supervisor
 *
 * EVERYTHING ELSE REQUIRES A VERIFIED SESSION, including the app page, its scripts, its styles and
 * `data/**`.
 *
 * DISCRIMINATION (X1): on the pre-gate base, legs A1 and A3 return 200 and MUST fail here. A gate
 * check that cannot fail is not a check.
 *
 * Safety: disposable PostgreSQL only (`OWNAPI_PG_*`, refuses the default databases), synthetic
 * learners, no provider call, and the child server is killed in `finally`.
 *
 * Usage: OWNAPI_PG_DATABASE=<disposable> node tools/page-auth-check.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PILOT01C_PORT || 4397);
const BASE = `http://127.0.0.1:${PORT}`;
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const READY_DEADLINE_MS = 30000;

const results = [];
function record(id, title, outcome, detail) {
  results.push({ id, outcome });
  console.log(`${outcome.padEnd(4)} ${id.padEnd(34)} ${title}`);
  if (detail) console.log(`     ${detail}`);
}
const pass = (id, t, d) => record(id, t, 'PASS', d);
const fail = (id, t, d) => record(id, t, 'FAIL', d);
const skip = (id, t, d) => record(id, t, 'SKIP', d);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A GET that never follows redirects, so the gate's actual answer is observable. */
async function probe(pathname, { cookie = null, accept = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (accept) headers.accept = accept;
  const res = await fetch(`${BASE}${pathname}`, { headers, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), body, res };
}

async function until(probeFn, deadlineMs, intervalMs = 250) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probeFn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

const database = process.env.OWNAPI_PG_DATABASE || '';
if (!database) {
  console.error('page-auth-check: OWNAPI_PG_DATABASE must name a disposable database');
  process.exit(2);
}
if (FORBIDDEN.has(database)) {
  console.error(`page-auth-check: refusing to run against ${database}`);
  process.exit(2);
}

console.log(`\n=== PILOT-01C page auth gate check (port ${PORT}) ===\n`);

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    B1PREP_SAAS: '1',
    B1PREP_ACCOUNTS: '1',
    B1PREP_PORT: String(PORT),
    B1PREP_PUBLIC_ORIGIN: BASE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

let cookie = null;
try {
  const health = await until(async () => {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok ? r : null;
  }, READY_DEADLINE_MS);
  if (!health) throw new Error(`the runtime did not answer /api/health within ${READY_DEADLINE_MS}ms\n${log.slice(-400)}`);

  // A1 — the app page itself is not public. This is the leg X1 must be able to break.
  const root = await probe('/', { accept: 'text/html,application/xhtml+xml' });
  if (root.status === 200) {
    fail('A1-app-page-gated', 'an unauthenticated request for / does NOT receive the app',
      `answered 200 with ${root.body.length} bytes — the app is public`);
  } else if (root.status === 302 && (root.location || '').startsWith('/signin')) {
    pass('A1-app-page-gated', 'an unauthenticated request for / does NOT receive the app', `302 -> ${root.location}`);
  } else if (root.status === 401) {
    pass('A1-app-page-gated', 'an unauthenticated request for / does NOT receive the app', '401 unauthenticated');
  } else {
    fail('A1-app-page-gated', 'an unauthenticated request for / does NOT receive the app', `unexpected ${root.status}`);
  }

  // A2 — a fetch (not a navigation) is refused as JSON, not handed a login page.
  const asFetch = await probe('/', { accept: 'application/json' });
  if (asFetch.status === 401) pass('A2-fetch-is-401-not-html', 'a non-navigation fetch is refused as 401', '401 (no login page served as content)');
  else if (asFetch.status === 302) fail('A2-fetch-is-401-not-html', 'a non-navigation fetch is refused as 401', '302 to /signin: a fetch would follow it and treat HTML as data');
  else fail('A2-fetch-is-401-not-html', 'a non-navigation fetch is refused as 401', `unexpected ${asFetch.status}`);

  // A3 — the answer keys are the sharp end of this: 180 of them live in data/seed.json.
  const seed = await probe('/data/seed.json', { accept: 'application/json' });
  if (seed.status === 200) {
    fail('A3-answer-keys-gated', 'data/seed.json (180 answer keys) is not public',
      `answered 200 with ${seed.body.length} bytes — the answer keys are downloadable by anyone`);
  } else if ([401, 403, 404].includes(seed.status)) {
    pass('A3-answer-keys-gated', 'data/seed.json (180 answer keys) is not public', `${seed.status}`);
  } else {
    // A 5xx is a broken server, NOT a refusal. Without this branch a crashed static handler would
    // have "passed" this leg, which is how a check stops meaning anything.
    fail('A3-answer-keys-gated', 'data/seed.json (180 answer keys) is not public',
      `${seed.status} is not a refusal — a server error must not read as "gated"`);
  }

  // A4 — the shell needed to sign in must be reachable, or nobody can ever authenticate.
  const signin = await probe('/signin', { accept: 'text/html' });
  if (signin.status === 200 && /<form|sign-in|anmelden|Anmeld/i.test(signin.body)) {
    pass('A4-signin-is-public', '/signin is public and renders a form', `${signin.status}, ${signin.body.length} bytes`);
  } else {
    fail('A4-signin-is-public', '/signin is public and renders a form', `${signin.status}`);
  }

  // A5 — the design system the sign-in page needs, and nothing else under assets.
  const css = await probe('/assets/design/hatoove.css');
  if (css.status === 200) pass('A5-design-assets-public', 'the design system is public (it holds no learner data)', `hatoove.css ${css.status}`);
  else fail('A5-design-assets-public', 'the design system is public (it holds no learner data)', `hatoove.css ${css.status}`);

  // A6 — liveness stays public for the container healthcheck and any supervisor.
  const ready = await probe('/api/ready');
  if (ready.status === 200) pass('A6-liveness-public', '/api/health and /api/ready stay public', `/api/ready ${ready.status}`);
  else fail('A6-liveness-public', '/api/health and /api/ready stay public', `/api/ready ${ready.status}`);

  // A7 — a real session opens the gate.
  const email = `gate-${Date.now()}@example.test`;
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: 'Gate Learner', email, password: 'synthetic-password-1' }),
  });
  const setCookie = signup.headers.getSetCookie?.() || [];
  cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (signup.status !== 200 || !cookie) {
    fail('A7-session-opens-gate', 'an authenticated session receives the app', `sign-up ${signup.status}, cookie ${cookie ? 'set' : 'MISSING'}`);
  } else {
    const authed = await probe('/', { cookie, accept: 'text/html' });
    if (authed.status === 200) pass('A7-session-opens-gate', 'an authenticated session receives the app', `sign-up 200, then / -> 200 (${authed.body.length} bytes)`);
    else fail('A7-session-opens-gate', 'an authenticated session receives the app', `/ answered ${authed.status} with a valid session`);
  }

  // A8 — signing out closes it again. A gate that only opens is a lock that only unlocks.
  if (!cookie) {
    skip('A8-signout-closes-gate', 'sign-out closes the gate again', 'no session to sign out');
  } else {
    const out = await fetch(`${BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: '{}',
    });
    // Sign-out clears the cookie server-side; re-send the OLD cookie to prove it no longer works.
    const stale = await probe('/', { cookie, accept: 'text/html' });
    if (out.status === 200 && stale.status !== 200) {
      pass('A8-signout-closes-gate', 'sign-out closes the gate again', `sign-out ${out.status}, the old cookie now gets ${stale.status}`);
    } else {
      fail('A8-signout-closes-gate', 'sign-out closes the gate again', `sign-out ${out.status}, stale cookie got ${stale.status}`);
    }
  }
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const passed = results.filter((r) => r.outcome === 'PASS').length;
const skipped = results.filter((r) => r.outcome === 'SKIP').length;
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
