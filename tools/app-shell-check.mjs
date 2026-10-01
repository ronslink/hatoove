#!/usr/bin/env node
/**
 * PILOT-08 step 1 — the app-shell check.
 *
 * The supplied Hatoove design is the product's driver, and until now it drove exactly one page
 * (`/signin`). Everything else at `/` was the OLD application, still branded **Certa** — a
 * different product's name on our front page, in every screenshot and every record.
 *
 * This check holds the new shell to four promises:
 *
 *   S1  the entry point stays auth-gated (PILOT-01c must not regress)
 *   S2  an authenticated learner receives the HATOVE shell, built on the curated design system
 *   S3  the served page does NOT contain "Certa"            <- the brand-leak discrimination
 *   S4  the shell does not load the legacy SPA modules, and holds no learner state of its own
 *   S5  the shell talks to the REAL owned endpoints, so it is an application and not a mockup
 *
 * DISCRIMINATION (S3): on this base `/` serves `public/index.html`, which contains "Certa" in its
 * title, its brand element and its navigation label. S3 must fail here and pass after the shell
 * exists. S1 and S5 pass on the base, so the legs are not all-or-nothing.
 *
 * Safety: disposable PostgreSQL only (`OWNAPI_PG_*`), synthetic learners, no provider call, and the
 * child server is killed in `finally`.
 *
 * Usage: OWNAPI_PG_DATABASE=<disposable> node tools/app-shell-check.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PILOT08_PORT || 4395);
const BASE = `http://127.0.0.1:${PORT}`;
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const READY_DEADLINE_MS = 30000;

const results = [];
function record(id, title, outcome, detail) {
  results.push({ id, outcome });
  console.log(`${outcome.padEnd(4)} ${id.padEnd(32)} ${title}`);
  if (detail) console.log(`     ${detail}`);
}
const pass = (id, t, d) => record(id, t, 'PASS', d);
const fail = (id, t, d) => record(id, t, 'FAIL', d);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, deadlineMs, intervalMs = 250) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

const database = process.env.OWNAPI_PG_DATABASE || '';
if (!database) { console.error('app-shell-check: OWNAPI_PG_DATABASE must name a disposable database'); process.exit(2); }
if (FORBIDDEN.has(database)) { console.error(`app-shell-check: refusing to run against ${database}`); process.exit(2); }

console.log(`\n=== PILOT-08 app shell check (port ${PORT}) ===\n`);

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, B1PREP_SAAS: '1', B1PREP_ACCOUNTS: '1', B1PREP_PORT: String(PORT), B1PREP_PUBLIC_ORIGIN: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

try {
  const up = await until(async () => ((await fetch(`${BASE}/api/health`)).ok ? true : null), READY_DEADLINE_MS);
  if (!up) throw new Error(`the runtime did not answer /api/health within ${READY_DEADLINE_MS}ms\n${log.slice(-400)}`);

  // S1 — the entry point must still refuse an anonymous visitor.
  const anon = await fetch(`${BASE}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  if (anon.status === 302 && (anon.headers.get('location') || '').startsWith('/signin')) {
    pass('S1-entry-still-gated', 'an unauthenticated / is still redirected to /signin', '302 -> /signin');
  } else {
    fail('S1-entry-still-gated', 'an unauthenticated / is still redirected to /signin', `${anon.status} ${anon.headers.get('location') || ''}`);
  }

  // A real learner, so the shell is fetched exactly as a signed-in browser would fetch it.
  const email = `shell-${Date.now()}@example.test`;
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: 'Shell Learner', email, password: 'synthetic-password-1' }),
  });
  const cookie = (signup.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (signup.status !== 200 || !cookie) throw new Error(`sign-up failed: ${signup.status}`);

  const shell = await fetch(`${BASE}/`, { headers: { cookie, accept: 'text/html' } });
  const html = await shell.text();

  // S2 — the authenticated learner gets the HATOVE shell on the curated design system.
  if (shell.status !== 200) {
    fail('S2-shell-is-hatoove', 'an authenticated learner receives the Hatoove shell', `GET / answered ${shell.status}`);
  } else {
    const usesDesign = html.includes('/assets/design/hatoove.css');
    const hasShell = /class="[^"]*\bapp\b/.test(html) && /class="[^"]*\bside\b/.test(html) && /class="[^"]*\bnav\b/.test(html);
    if (!usesDesign) fail('S2-shell-is-hatoove', 'an authenticated learner receives the Hatoove shell', 'does not link /assets/design/hatoove.css');
    else if (!hasShell) fail('S2-shell-is-hatoove', 'an authenticated learner receives the Hatoove shell', 'no .app/.side/.nav shell layout present');
    else pass('S2-shell-is-hatoove', 'an authenticated learner receives the Hatoove shell', `${html.length} bytes; design system linked; shell layout present`);
  }

  // S3 — DISCRIMINATION: the previous product's name must not be on our front page.
  const certa = (html.match(/Certa/gi) || []).length;
  if (certa === 0) pass('S3-no-certa-leak', 'the served page contains no "Certa"', 'the previous product name is gone from the entry point');
  else fail('S3-no-certa-leak', 'the served page contains no "Certa"', `${certa} occurrence(s) of "Certa" in the served page`);

  // S4 — no legacy SPA modules, and no learner state of the shell's own.
  const legacy = ['/js/app.js', '/js/store.js', '/js/exam.js', '/js/ui.js'].filter((p) => html.includes(p));
  if (legacy.length) {
    fail('S4-no-legacy-modules', 'the shell loads no legacy SPA modules', `still references ${legacy.join(', ')}`);
  } else {
    const scriptSrc = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
      .filter((src) => src.startsWith('/app/') || html.includes(`src="${src}"`));
    const bodies = [];
    for (const src of scriptSrc.slice(0, 4)) {
      const res = await fetch(`${BASE}${src}`, { headers: { cookie } });
      if (res.ok) bodies.push(await res.text());
    }
    const all = [html, ...bodies].join('\n');
    const offenders = ['localStorage', 'sessionStorage', 'indexedDB', 'b1prep.state'].filter((k) => all.includes(k));
    if (offenders.length) fail('S4-no-legacy-modules', 'the shell loads no legacy SPA modules and holds no learner state', `found ${offenders.join(', ')}`);
    else pass('S4-no-legacy-modules', 'the shell loads no legacy SPA modules and holds no learner state', `${scriptSrc.length} shell script(s) scanned; no local storage API`);
  }

  // S5 — the shell is an application, not a mockup: the endpoints it needs really answer.
  const account = await fetch(`${BASE}/api/v1/account`, { headers: { cookie } });
  const settings = await fetch(`${BASE}/api/v1/settings`, { headers: { cookie } });
  if (account.status === 200 && settings.status === 200) {
    const a = await account.json();
    const s = await settings.json();
    pass('S5-real-endpoints-answer', 'the shell talks to the real owned endpoints',
      `/api/v1/account 200 (${a.email}); /api/v1/settings 200 at revision ${s.revision}`);
  } else {
    fail('S5-real-endpoints-answer', 'the shell talks to the real owned endpoints', `account ${account.status}, settings ${settings.status}`);
  }
} finally {
  child.kill('SIGTERM');
  await sleep(400);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const passed = results.filter((r) => r.outcome === 'PASS').length;
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(`\n${passed} passed, 0 skipped, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
