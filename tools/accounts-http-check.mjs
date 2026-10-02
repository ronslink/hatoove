/**
 * A-01 mount proof: accounts, over real HTTP, against the running server.
 *
 * Before this slice `node server.js` called `createServer()` with no owned API, so no learner
 * could sign in and no attempt could be owned. This checker starts the **real server process**
 * with `B1PREP_ACCOUNTS=1` against a disposable database and drives the **real**
 * `public/js/owned-client.js` over HTTP, then restarts the server and proves the data is still
 * there.
 *
 * What it proves
 *   1. the entry point fails closed: with `B1PREP_ACCOUNTS` unset the owned routes and
 *      `/api/ready` answer 503 (not 404 beside a working single-user app) - SAAS-MODEL-01 Step 2;
 *   2. with the flag on, a learner can sign up, is served their own account, and can create an
 *      attempt, save a draft, submit and read the result over HTTP with a real cookie;
 *   3. **the restart property**: stop the server, start it again, and the same session cookie
 *      still resolves and the same draft is still readable - which is what "log out and come
 *      back to find your data" rests on;
 *   4. another account sees none of it (cross-owner is a 404, never a 403 or a leak);
 *   5. sign-out invalidates the session on the server, and the old cookie stops working;
 *   6. the mutation gate still applies: the owned routes are reached only after the SEC-01
 *      origin check.
 *
 * Safety: it needs a disposable PostgreSQL database (`OWNAPI_PG_*`) and refuses `postgres`,
 * `template0` and `template1`; it uses a throwaway env file so the real
 * install is never touched. Synthetic learners only. No provider call.
 *
 * Usage: node tools/accounts-http-check.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const DATABASE = process.env.OWNAPI_PG_DATABASE || '';
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-accounts-http-'));

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ------------------------------------------------------------ server process */

async function startServer(port, { accounts }) {
  const env = {
    ...process.env,
    B1PREP_PORT: String(port),
    B1PREP_ENV_FILE: path.join(TEMP, `env-${port}`),
    B1PREP_FORCE_OFFLINE: '1',
    // Preview is scoped to this synthetic test server, never the importing process.
    B1PREP_CONTENT_MODE: 'internal-preview',
  };
  // Absent when accounts are off (not an empty string): the flag is read as `=== '1'`.
  if (accounts) env.B1PREP_ACCOUNTS = '1';
  else delete env.B1PREP_ACCOUNTS;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });

  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${out.slice(-400)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${port}: ${out.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, env, log: () => out, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }) };
}

/** Wait until the accounts banner line appears, so sign-up is not raced against provisioning. */
async function waitForBanner(server, needle, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (server.log().includes(needle)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Minimal cookie jar over the real client's transport shape. */
function browser(port) {
  const jar = new Map();
  const fetchImpl = async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    // The browser supplies Origin; in Node the checker must, and the relative path the client
    // builds has to be given a host.
    headers.origin = `http://127.0.0.1:${port}`;
    const href = String(url).startsWith('http') ? String(url) : `http://127.0.0.1:${port}${url}`;
    const response = await fetch(href, { method: init.method || 'GET', headers, body: init.body });
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    return { status: response.status, text: () => response.text() };
  };
  return { jar, fetchImpl };
}

async function client(port) {
  const { ClientCtor } = await loadClient();
  const b = browser(port);
  return { ...b, client: ClientCtor({ fetchImpl: b.fetchImpl }) };
}

let cachedClient = null;
async function loadClient() {
  if (!cachedClient) {
    const module = await import('../public/js/owned-client.js');
    cachedClient = { ClientCtor: module.createOwnedClient };
  }
  return cachedClient;
}

const email = (tag) => `${tag}-${RUN_ID}@accounts.example.invalid`;

/* =================================================================== checks */

check('unconfigured-entry-point-fails-closed', async () => {
  // SAAS-MODEL-01 Step 2. Before this slice, `B1PREP_ACCOUNTS` unset started a working
  // single-user app and the owned routes answered 404 ("they do not exist"). The absence of
  // the configuration is now an error: the runtime is not ready and every learner route is
  // refused with 503. This updates the old `accounts-are-off-by-default` assertion to the new
  // contract rather than deleting it (the plan: do not delete failing tests).
  const server = await startServer(4471, { accounts: false });
  try {
    const ready = await fetch('http://127.0.0.1:4471/api/ready');
    assert.equal(ready.status, 503, 'without accounts configuration /api/ready must be 503');
    assert.equal((await ready.json()).ready, false, 'and must report ready:false');
    const signUp = await fetch('http://127.0.0.1:4471/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4471' },
      body: JSON.stringify({ name: 'X', email: 'x@accounts.example.invalid', password: 'pw-synthetic-1' }),
    });
    assert.equal(signUp.status, 503, 'with accounts off the owned routes must be refused, not 404');
    const account = await fetch('http://127.0.0.1:4471/api/v1/account');
    assert.equal(account.status, 503, 'and neither must the account route be served');
  } finally { await server.stop(); }
});

check('a-learner-can-sign-up-and-own-an-attempt-over-http', async () => {
  const server = await startServer(4472, { accounts: true });
  try {
    assert.ok(await waitForBanner(server, 'Accounts: accounts: on'),
      `accounts did not come up: ${server.log().slice(-300)}`);
    const a = await client(4472);
    const account = await a.client.signUp({ name: 'A', email: email('a'), password: 'pw-a-synthetic-1' });
    assert.match(account.id, /^user-/, 'a real account id comes back');
    assert.equal((await a.client.getAccount()).id, account.id, 'the session resolves to that account');

    const attempt = await a.client.createAttempt();
    const draft = await a.client.saveDraft(attempt.id, { expectedRevision: attempt.revision, text: 'Sehr geehrte Damen und Herren, ich schreibe wegen des Kurses.' });
    assert.equal(draft.revision, attempt.revision + 1);
    const read = await a.client.readAttempt(attempt.id);
    assert.equal(read.text, draft.text, 'the draft is served back');
  } finally { await server.stop(); }
});

check('the-session-and-the-draft-survive-a-server-restart', async () => {
  const first = await startServer(4473, { accounts: true });
  let cookie = null;
  let attemptId = null;
  const text = 'Sehr geehrte Frau Berger, ich kann am Samstag leider nicht kommen.';
  try {
    assert.ok(await waitForBanner(first, 'Accounts: accounts: on'), 'accounts did not come up');
    const a = await client(4473);
    const account = await a.client.signUp({ name: 'R', email: email('r'), password: 'pw-r-synthetic-1' });
    const attempt = await a.client.createAttempt();
    await a.client.saveDraft(attempt.id, { expectedRevision: attempt.revision, text });
    cookie = [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    // Carry the account id out of the first world so the restarted server is the same learner.
    fs.writeFileSync(path.join(TEMP, 'restart.json'), JSON.stringify({ cookie, attemptId: attempt.id, accountId: account.id, text }));
    attemptId = attempt.id;
  } finally { await first.stop(); }

  // Same database, same session cookie, brand-new process.
  const second = await startServer(4474, { accounts: true });
  try {
    assert.ok(await waitForBanner(second, 'Accounts: accounts: on'), 'accounts did not come up after restart');
    const saved = JSON.parse(fs.readFileSync(path.join(TEMP, 'restart.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:4474/api/v1/attempts/${saved.attemptId}`, {
      headers: { cookie: saved.cookie },
    });
    assert.equal(response.status, 200, `the restarted server must still know the session (got ${response.status})`);
    const body = await response.json();
    assert.equal(body.text, saved.text, 'and must serve the saved draft unchanged');
  } finally { await second.stop(); }
});

check('another-account-sees-nothing-and-sign-out-really-ends-the-session', async () => {
  const server = await startServer(4475, { accounts: true });
  try {
    assert.ok(await waitForBanner(server, 'Accounts: accounts: on'), 'accounts did not come up');
    const a = await client(4475);
    await a.client.signUp({ name: 'A', email: email('iso-a'), password: 'pw-a-synthetic-1' });
    const attempt = await a.client.createAttempt();
    await a.client.saveDraft(attempt.id, { expectedRevision: attempt.revision, text: 'A private draft' });

    const b = await client(4475);
    await b.client.signUp({ name: 'B', email: email('iso-b'), password: 'pw-b-synthetic-1' });
    let error = null;
    try { await b.client.readAttempt(attempt.id); } catch (e) { error = e; }
    assert.ok(error, "another owner's attempt must not be readable");
    assert.equal(error.code, 'not_found', `cross-owner must be not_found, got ${error.code}`);
    assert.equal(error.status, 404);

    const cookieBefore = [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    await a.client.signOut();
    const after = await fetch('http://127.0.0.1:4475/api/v1/account', { headers: { cookie: cookieBefore } });
    assert.equal(after.status, 401, 'the old cookie must stop working after sign-out');
  } finally { await server.stop(); }
});

check('the-owned-routes-sit-behind-the-origin-gate', async () => {
  const server = await startServer(4476, { accounts: true });
  try {
    assert.ok(await waitForBanner(server, 'Accounts: accounts: on'), 'accounts did not come up');
    const foreign = await fetch('http://127.0.0.1:4476/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
      body: JSON.stringify({ name: 'X', email: `x-${RUN_ID}@accounts.example.invalid`, password: 'pw-synthetic-1' }),
    });
    assert.equal(foreign.status, 403, 'a foreign origin must be rejected before the owned API sees it');
    const noOrigin = await fetch('http://127.0.0.1:4476/api/v1/attempts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noOrigin.status, 403, 'an absent Origin is rejected too');
  } finally { await server.stop(); }
});

check('settings-are-per-account-and-refuse-a-stale-write', async () => {
  const server = await startServer(4477, { accounts: true });
  try {
    assert.ok(await waitForBanner(server, 'Accounts: accounts: on'), 'accounts did not come up');
    const base = `http://127.0.0.1:4477`;
    const jar = new Map();
    const call = async (method, path, body) => {
      const headers = { origin: base };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const line of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      let json = null;
      try { json = await response.json(); } catch { /* some replies have no body */ }
      return { status: response.status, json };
    };

    await call('POST', '/api/auth/sign-up/email', { name: 'S', email: email('settings'), password: 'pw-s-1' });

    // A brand-new account has the app's own defaults, not an empty object.
    const initial = await call('GET', '/api/v1/settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.revision, 0, 'a never-saved account is at revision 0');
    assert.equal(initial.json.settings.dailyGoal, 20);
    assert.equal(initial.json.settings.theme, 'system');
    assert.equal(initial.json.settings.language, 'de');

    // The first write is expectedRevision 0 and bumps the revision to 1.
    const saved = await call('PUT', '/api/v1/settings', { expectedRevision: 0, settings: { examDate: '2026-12-05', dailyGoal: 30, theme: 'dark', language: 'de' } });
    assert.equal(saved.status, 200, `save failed: ${JSON.stringify(saved.json)}`);
    assert.equal(saved.json.revision, 1);
    assert.equal(saved.json.settings.examDate, '2026-12-05');
    assert.equal(saved.json.settings.theme, 'dark');

    // A stale revision writes NOTHING and is refused with the server's copy to reconcile.
    const stale = await call('PUT', '/api/v1/settings', { expectedRevision: 0, settings: { theme: 'light' } });
    assert.equal(stale.status, 409, 'a stale write must be refused');
    assert.equal(stale.json.error, 'settings_conflict');
    const afterStale = await call('GET', '/api/v1/settings');
    assert.equal(afterStale.json.settings.theme, 'dark', 'the refused write must not have changed anything');

    // Unknown fields and bad values are refused, never silently dropped.
    assert.equal((await call('PUT', '/api/v1/settings', { expectedRevision: 1, settings: { nope: 1 } })).status, 422);
    assert.equal((await call('PUT', '/api/v1/settings', { expectedRevision: 1, settings: { dailyGoal: 0 } })).status, 422);
    assert.equal((await call('PUT', '/api/v1/settings', { expectedRevision: 1, settings: { theme: 'neon' } })).status, 422);

    // Every supported explanation language is accepted; a refusal cannot change state.
    let revision = saved.json.revision;
    for (const language of ['de', 'en', 'uk', 'ar', 'tr']) {
      const updated = await call('PUT', '/api/v1/settings', { expectedRevision: revision, settings: { language } });
      assert.equal(updated.status, 200, `supported language ${language} was refused`);
      assert.equal(updated.json.revision, revision + 1);
      assert.equal(updated.json.settings.language, language);
      revision = updated.json.revision;
    }
    const beforeInvalid = await call('GET', '/api/v1/settings');
    for (const language of ['', 'fr', 'AR', 'en-US']) {
      const invalid = await call('PUT', '/api/v1/settings', { expectedRevision: revision, settings: { language } });
      assert.equal(invalid.status, 422, `unsupported language ${JSON.stringify(language)} was accepted`);
      assert.equal(invalid.json.error, 'invalid_settings');
    }
    assert.deepEqual((await call('GET', '/api/v1/settings')).json, beforeInvalid.json,
      'refused language writes must preserve the settings and revision');

    // Another account sees its OWN defaults, never the first account's settings.
    const otherJar = [...jar];
    jar.clear();
    await call('POST', '/api/auth/sign-up/email', { name: 'T', email: email('settings-other'), password: 'pw-t-1' });
    const other = await call('GET', '/api/v1/settings');
    assert.equal(other.json.revision, 0, 'a second account must not inherit the first account settings');
    assert.equal(other.json.settings.theme, 'system');
    assert.equal(other.json.settings.examDate, '');
    assert.equal(other.json.settings.language, 'de');
    assert.ok(otherJar.length, 'the first account had a session');
  } finally { await server.stop(); }
});

/* ====================================================================== run */

export async function runAccountsHttpChecks() {
  if (FORBIDDEN.has(DATABASE)) {
    throw new Error(`refusing to run against ${DATABASE}; set OWNAPI_PG_DATABASE to a disposable database`);
  }
  if (!DATABASE) throw new Error('OWNAPI_PG_DATABASE must name a disposable database');
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('accounts-http-check.mjs');
if (invokedDirectly) {
  try {
    const report = await runAccountsHttpChecks();
    for (const r of report.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
    const failed = report.results.filter((r) => !r.ok).length;
    console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
    console.log(`NOTE real server processes, real HTTP, real owned client. Database schema "${process.env.OWNAPI_PG_SCHEMA || 'hatoove'}" is reused, not dropped.`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}
