/**
 * SESSION-BOUNDARY-01: the application session boundary, over real HTTP, against the real
 * server process (issue #63 S4).
 *
 * Follows tools/accounts-http-check.mjs: `node server.js` is spawned with `B1PREP_ACCOUNTS=1`
 * against a disposable PostgreSQL database, with a throwaway env file and progress file. The
 * code under test is the REAL `createSessionBoundary` from public/js/account.js driving the
 * REAL owned client and the REAL progress store (public/js/store.js). Each simulated
 * "browser" has its own cookie jar, its own localStorage and its own fresh instance of the
 * store module, and logs every storage read and every request, so the ORDER of what the
 * page does is asserted, not only its result.
 *
 * What it proves
 *   1. order: no learner record is read (storage or /api/progress) before /api/v1/account
 *      has answered;
 *   2. sign-out: the previous account's text, notebook entry and settings are unreadable
 *      afterwards - in the store, in the draft session, and in this browser's storage;
 *   3. account switch: account B never sees account A's record, and an in-flight response
 *      for A (progress AND owned settings) that resolves after the switch does not land;
 *   4. fresh browser: a clean profile that signs in resumes the account's notebook, ability
 *      record and settings from the server with no local file imported;
 *   5. expiry / a refused session fails closed to signed-out, not to the single-user record;
 *   6. the single-user path (accounts off, or never signed in) is unchanged.
 *
 * Safety: synthetic accounts only, no provider call (B1PREP_FORCE_OFFLINE=1), a disposable
 * database that may not be `postgres`, `template0` or `template1`. This is the synthetic
 * session port, NOT Better Auth, and it closes no production-security gate.
 *
 * Usage: node tools/session-boundary-check.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SESSION_BOUNDARY_ROOT lets the discrimination run point the same checker at a scratch copy.
const SUT = path.resolve(process.env.SESSION_BOUNDARY_ROOT || ROOT);
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const DATABASE = process.env.OWNAPI_PG_DATABASE || '';
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-session-boundary-'));
const realFetch = globalThis.fetch;

const MARK = Object.freeze({
  notebookA: `SYNTH-A-NOTEBOOK-${RUN_ID}`,
  draftA: `SYNTH-A-DRAFT-${RUN_ID}`,
  examDateA: '2031-03-14',
  legacy: `SYNTH-LEGACY-${RUN_ID}`,
  lateSettings: '2032-02-02',
});

const checks = [];
const check = (name, run) => checks.push({ name, run });
const email = (tag) => `${tag}-${RUN_ID}@session-boundary.example.invalid`;
const password = (tag) => `pw-${tag}-synthetic-1`;

/* ------------------------------------------------------------ server process */

async function startServer(port, { accounts }) {
  const env = {
    ...process.env,
    B1PREP_PORT: String(port),
    B1PREP_ENV_FILE: path.join(TEMP, `env-${port}`),
    // One progress file for every server in the run, so an accounts-off server sees the same
    // records the accounts-on server wrote (the "accounts turned off" case).
    B1PREP_PROGRESS_FILE: path.join(TEMP, 'progress.json'),
    B1PREP_FORCE_OFFLINE: '1',
  };
  if (accounts) env.B1PREP_ACCOUNTS = '1';
  else delete env.B1PREP_ACCOUNTS;
  const child = spawn(process.execPath, ['server.js'], { cwd: SUT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${out.slice(-400)}`);
    try {
      const response = await realFetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${port}: ${out.slice(-400)}`);
    await sleep(150);
  }
  if (accounts) {
    const until = Date.now() + 60000;
    while (!out.includes('Accounts: accounts: on')) {
      if (Date.now() > until) throw new Error(`accounts did not come up: ${out.slice(-300)}`);
      await sleep(200);
    }
  }
  return { port, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }) };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ------------------------------------------------------------ the "browser" */

let instance = 0;
/**
 * Every store instance a check opened. In a real browser each page has its own globals; here
 * the store modules share Node's, so a page left behind by one check could fire its debounce
 * timer into the NEXT check's storage. retirePages() cancels those timers between checks.
 */
const pages = [];

function retirePages() {
  globalThis.localStorage = memoryStorage([]);
  globalThis.fetch = realFetch;
  for (const store of pages.splice(0)) store.clearAccountScope();
}
const accountModule = await import(pathToFileURL(path.join(SUT, 'public/js/account.js')).href);
const ownedModule = await import(pathToFileURL(path.join(SUT, 'public/js/owned-client.js')).href);

/** A Map-backed localStorage that logs every read. */
function memoryStorage(log) {
  const data = new Map();
  return {
    data,
    getItem(key) { log.push({ kind: 'read', key: String(key) }); return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    clear() { data.clear(); },
    key(i) { return [...data.keys()][i] ?? null; },
    get length() { return data.size; },
  };
}

/**
 * One browser profile: cookie jar + storage + request log + response holds. `page()` is a
 * page load: a fresh store module instance and a fresh client and boundary, sharing the
 * profile's cookies and storage - exactly what a reload keeps.
 */
function createBrowser(port) {
  const jar = new Map();
  const log = [];
  const storage = memoryStorage(log);
  const holds = [];
  const base = `http://127.0.0.1:${port}`;

  async function fetchImpl(url, init = {}) {
    const href = String(url).startsWith('http') ? String(url) : `${base}${url}`;
    const pathname = new URL(href).pathname;
    const method = init.method || 'GET';
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    headers.origin = base;
    const entry = { kind: 'request', method, path: pathname, scope: headers['x-b1prep-account'] || null };
    log.push({ ...entry, at: 'start' });
    const response = await realFetch(href, { method, headers, body: init.body });
    for (const line of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    // A held response has reached the browser's network layer but is handed to the page late.
    for (const hold of holds) {
      if (!hold.used && hold.match(entry)) {
        hold.used = true;
        hold.reached();
        await hold.gate;
      }
    }
    log.push({ ...entry, at: 'end', status: response.status });
    return {
      status: response.status,
      ok: response.ok,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  /** Hold the next response matching `match` until release() is called. */
  function hold(match) {
    let release;
    let reached;
    const h = { match, used: false };
    h.gate = new Promise((resolve) => { release = resolve; });
    h.arrived = new Promise((resolve) => { reached = resolve; });
    h.reached = reached;
    h.release = release;
    holds.push(h);
    return h;
  }

  /** Make this profile the one the store's global fetch/localStorage see. */
  function activate() {
    globalThis.fetch = fetchImpl;
    globalThis.localStorage = storage;
  }

  async function page() {
    activate();
    instance += 1;
    const store = await import(`${pathToFileURL(path.join(SUT, 'public/js/store.js')).href}?page=${instance}`);
    pages.push(store);
    const client = ownedModule.createOwnedClient({ fetchImpl });
    const boundary = accountModule.createSessionBoundary({ client, store, pointers: accountModule.localPointerStore() });
    return { store, client, boundary };
  }

  return { jar, log, storage, hold, activate, page, fetchImpl };
}

/** Everything a store could expose about the learner, as one searchable string. */
function visible(store) {
  return JSON.stringify({ state: store.getState(), errors: store.listErrors({ includeResolved: true }) });
}

/** Seed account A through the boundary: a notebook entry, settings, and a saved draft. */
async function seedAccountA(port, tag) {
  const browser = createBrowser(port);
  const { store, boundary } = await browser.page();
  await boundary.resolve();
  const signedUp = await boundary.signUp({ name: 'A', email: email(tag), password: password(tag) });
  assert.equal(signedUp.phase, 'signed-in');
  store.recordAttempt({ partId: 'SB1', tags: ['praepositionen'], difficulty: 50, correct: false, detail: { prompt: MARK.notebookA, yourAnswer: 'x', correctAnswer: 'y' } });
  const settings = store.getState().settings;
  settings.examDate = MARK.examDateA;
  const saved = await boundary.saveSettings({ examDate: MARK.examDateA, dailyGoal: 35, language: 'en' });
  assert.equal(saved.saved, true, `settings save failed: ${JSON.stringify(saved)}`);
  assert.equal(await store.flushNow(), true, 'the progress record must reach the server');
  const draft = await boundary.openDraft('writing-b1-t1');
  const result = await draft.save(MARK.draftA);
  assert.equal(result.status, 'saved');
  return { browser, store, boundary, draft, account: signedUp.account };
}

/* =================================================================== checks */

check('order: identity resolves before any learner data is read', async () => {
  const server = await startServer(4481, { accounts: true });
  try {
    const seeded = await seedAccountA(4481, 'order');
    // A reload of the same profile: cookie and storage kept, fresh page.
    seeded.browser.log.length = 0;
    const { store, boundary } = await seeded.browser.page();
    const result = await boundary.resolve();
    assert.equal(result.phase, 'signed-in');
    const log = seeded.browser.log;
    const accountAnswered = log.findIndex((e) => e.kind === 'request' && e.at === 'end' && e.path === '/api/v1/account');
    assert.ok(accountAnswered >= 0, 'the account endpoint was never asked');
    const firstRecordRead = log.findIndex((e) => e.kind === 'read' && e.key.startsWith('b1prep.state.v1'));
    const firstProgress = log.findIndex((e) => e.kind === 'request' && e.path === '/api/progress');
    assert.ok(firstRecordRead > accountAnswered, `a learner record was read (index ${firstRecordRead}) before identity resolved (index ${accountAnswered})`);
    assert.ok(firstProgress > accountAnswered, `/api/progress was requested (index ${firstProgress}) before identity resolved (index ${accountAnswered})`);
    assert.equal(log[firstProgress].scope, seeded.account.id, 'the first progress request is scoped to the resolved account');
    assert.ok(visible(store).includes(MARK.notebookA), 'and the resolved account opens on its own record');
  } finally { await server.stop(); }
});

check('sign-out: the previous account text, notebook and settings are unreadable afterwards', async () => {
  const server = await startServer(4482, { accounts: true });
  try {
    const { browser, store, boundary, draft } = await seedAccountA(4482, 'signout');
    assert.ok(visible(store).includes(MARK.notebookA), 'precondition: the notebook entry is visible while signed in');
    assert.equal(draft.snapshot().text, MARK.draftA, 'precondition: the draft text is held while signed in');

    await boundary.signOut();
    assert.equal(boundary.phase, 'signed-out');
    assert.ok(!visible(store).includes(MARK.notebookA), 'the notebook entry is still readable after sign-out');
    assert.equal(store.listErrors().length, 0, 'the notebook is empty after sign-out');
    assert.notEqual(store.getState().settings.examDate, MARK.examDateA, 'the account exam date is still readable after sign-out');
    assert.equal(draft.snapshot(), null, 'the draft session still holds text after sign-out');
    assert.equal(boundary.openDrafts, 0, 'the boundary still tracks an open draft');
    await assert.rejects(draft.save('late'), (e) => e.code === 'not_open' || e.code === 'stale_session');
    const leaking = [...browser.storage.data.entries()]
      .filter(([, value]) => value.includes(MARK.notebookA) || value.includes(MARK.draftA)).map(([key]) => key);
    assert.deepEqual(leaking, [], `the account text is still in this browser storage under ${leaking.join(', ')}`);
    assert.equal(await boundary.saveSettings({ examDate: '2033-01-01' }).then((r) => r.reason), 'not_signed_in');

    // A reload after sign-out holds nothing either, and never falls back to the unscoped record.
    browser.log.length = 0;
    const reload = await browser.page();
    const result = await reload.boundary.resolve();
    assert.equal(result.phase, 'signed-out');
    assert.ok(!visible(reload.store).includes(MARK.notebookA), 'a reload after sign-out shows the account notebook');
    assert.ok(!browser.log.some((e) => e.kind === 'request' && e.path === '/api/progress'), 'a signed-out reload requested a progress record');
  } finally { await server.stop(); }
});

check('account switch: B never sees A, and late responses for A do not land', async () => {
  const server = await startServer(4483, { accounts: true });
  try {
    const seeded = await seedAccountA(4483, 'switch-a');
    const accountA = seeded.account.id;
    // Give A's server settings a distinctive date whose late arrival would be visible.
    const changed = await seeded.boundary.saveSettings({ examDate: MARK.lateSettings });
    assert.equal(changed.saved, true);
    await seeded.boundary.signOut();
    const b = createBrowser(4483);
    {
      const { boundary } = await b.page();
      await boundary.resolve();
      await boundary.signUp({ name: 'B', email: email('switch-b'), password: password('switch-b') });
      await boundary.signOut();
    }

    // (1) A's progress read is in flight when the page switches to B.
    const browser = seeded.browser;
    const { store, boundary } = await browser.page();
    await boundary.signIn({ email: email('switch-a'), password: password('switch-a') });
    assert.ok(visible(store).includes(MARK.notebookA), 'precondition: A is signed in and sees A');
    const lateProgress = browser.hold((e) => e.method === 'GET' && e.path === '/api/progress' && e.scope === accountA);
    const reloadA = await browser.page();
    const resolvingA = reloadA.boundary.resolve();
    await lateProgress.arrived;
    // The switch: same page, B signs in while A's record is still on its way.
    const switched = await reloadA.boundary.signIn({ email: email('switch-b'), password: password('switch-b') });
    assert.equal(switched.phase, 'signed-in');
    assert.notEqual(switched.account.id, accountA);
    lateProgress.release();
    const outcomeA = await resolvingA;
    assert.ok(outcomeA.superseded || outcomeA.account?.id !== accountA, 'the superseded resolution for A reported itself as current');
    await sleep(50);
    assert.equal(reloadA.store.getAccountScope().accountId, switched.account.id, 'the store is scoped to B');
    assert.ok(!visible(reloadA.store).includes(MARK.notebookA), "A's late progress response landed in B's record");
    assert.notEqual(reloadA.store.getState().settings.examDate, MARK.lateSettings, "A's settings are visible to B");

    // (2) A's owned settings read is in flight when the page switches to B.
    await reloadA.boundary.signOut();
    const page2 = await browser.page();
    await page2.boundary.resolve();
    const lateSettings = browser.hold((e) => e.method === 'GET' && e.path === '/api/v1/settings');
    const signingInA = page2.boundary.signIn({ email: email('switch-a'), password: password('switch-a') });
    await lateSettings.arrived;
    const toB = await page2.boundary.signIn({ email: email('switch-b'), password: password('switch-b') });
    lateSettings.release();
    await signingInA.catch(() => null);
    await sleep(50);
    assert.equal(page2.boundary.status().account.id, toB.account.id, 'the boundary ended on B');
    assert.notEqual(page2.store.getState().settings.examDate, MARK.lateSettings, "A's late settings response landed in B's record");
    assert.ok(!visible(page2.store).includes(MARK.notebookA), "B's record contains A's notebook");

    // (3) B cannot reach A's draft on the server either.
    const pointer = Object.values(JSON.parse(browser.storage.getItem('b1prep.draft-pointers.v1') || '{}'))[0];
    assert.ok(pointer && pointer.attemptId, 'precondition: A has a draft pointer in this profile');
    await assert.rejects(page2.client.readAttempt(pointer.attemptId), (e) => e.code === 'not_found');
  } finally { await server.stop(); }
});

check('fresh browser: a clean profile resumes the account from the server, importing nothing', async () => {
  const server = await startServer(4484, { accounts: true });
  try {
    const seeded = await seedAccountA(4484, 'fresh');
    await seeded.boundary.signOut();

    const fresh = createBrowser(4484);
    const { store, boundary } = await fresh.page();
    assert.equal(fresh.storage.length, 0, 'precondition: the fresh profile has no storage at all');
    // Never signed in here: the single-user path runs first, exactly as before.
    await boundary.resolve();
    const signInAt = fresh.log.length;
    const result = await boundary.signIn({ email: email('fresh'), password: password('fresh') });
    assert.equal(result.phase, 'signed-in');
    assert.ok(store.listErrors().some((e) => e.prompt === MARK.notebookA), 'the notebook entry was not resumed from the server');
    assert.ok(store.getState().history.length >= 1, 'the attempt history was not resumed');
    assert.equal(store.getState().settings.examDate, MARK.examDateA, 'the exam date was not resumed from the account settings');
    assert.equal(store.getState().settings.dailyGoal, 35, 'the daily goal was not resumed');
    assert.equal(store.accountScopeStatus().legacyAdopted, null, 'a local record was adopted');
    const progressReads = fresh.log.slice(signInAt).filter((e) => e.kind === 'request' && e.at === 'end' && e.path === '/api/progress');
    assert.ok(progressReads.length >= 1 && progressReads.every((e) => e.scope === result.account.id), 'the record did not come from the account-scoped server read');
  } finally { await server.stop(); }
});

check('expiry and a refused session fail closed to signed-out, not to the single-user record', async () => {
  const server = await startServer(4485, { accounts: true });
  let off = null;
  try {
    const browser = createBrowser(4485);
    // A single-user record exists in this browser and on the server.
    {
      const { store, boundary } = await browser.page();
      const result = await boundary.resolve();
      assert.equal(result.phase, 'single-user');
      store.recordAttempt({ partId: 'SB1', tags: [], difficulty: 50, correct: false, detail: { prompt: MARK.legacy, yourAnswer: 'a', correctAnswer: 'b' } });
      assert.equal(await store.flushNow(), true);
    }
    const { store, boundary } = await browser.page();
    await boundary.resolve();
    await boundary.signUp({ name: 'E', email: email('expiry'), password: password('expiry') });
    assert.ok(!visible(store).includes(MARK.legacy), 'the single-user record was assigned to the new account');

    // Expire the session on the server while this page still holds the cookie.
    const cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const killed = await realFetch('http://127.0.0.1:4485/api/auth/sign-out', {
      method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:4485', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(killed.status, 200);

    // A reload with the dead cookie while this profile is still scoped to the account:
    // signed-out, and the unscoped record is never requested.
    browser.log.length = 0;
    const reload = await browser.page();
    assert.equal(reload.store.getAccountScope().mode, 'scoped', 'precondition: the profile is still scoped');
    const result = await reload.boundary.resolve();
    assert.equal(result.phase, 'signed-out', `a refused session resolved to ${result.phase}`);
    assert.equal(result.reason, 'expired');
    assert.ok(!visible(reload.store).includes(MARK.legacy), 'the refused session shows the single-user record');
    assert.ok(!browser.log.some((e) => e.kind === 'request' && e.path === '/api/progress' && e.scope === null), 'the refused session read the unscoped record');

    // Mid-session, on the page that was open all along: the next account call is refused
    // and the page fails closed.
    browser.activate();
    const saved = await boundary.saveSettings({ dailyGoal: 40 });
    assert.equal(saved.reason, 'expired');
    assert.equal(boundary.phase, 'signed-out');
    assert.ok(!visible(store).includes(MARK.legacy), 'expiry fell back to the single-user record');

    // Accounts switched off under a browser that held an account: still signed-out.
    await server.stop();
    off = await startServer(4485, { accounts: false });
    const offPage = await browser.page();
    const offResult = await offPage.boundary.resolve();
    assert.equal(offResult.phase, 'signed-out', `accounts-off under a scoped browser resolved to ${offResult.phase}`);
    assert.ok(!visible(offPage.store).includes(MARK.legacy), 'accounts-off handed a scoped browser the single-user record');
  } finally {
    if (off) await off.stop();
    else await server.stop();
  }
});

check('single-user path: accounts off, or never signed in, behaves as before', async () => {
  const offServer = await startServer(4486, { accounts: false });
  try {
    const browser = createBrowser(4486);
    browser.storage.setItem('b1prep.state.v1', JSON.stringify({ version: 1, updatedAt: 1, nodes: {}, history: [], errors: [{ id: 'e1', t: 1, prompt: MARK.legacy, tags: [], resolved: false }], settings: {}, counters: { attempts: 1 } }));
    const { store, boundary } = await browser.page();
    const result = await boundary.resolve();
    assert.equal(result.phase, 'single-user');
    assert.equal(result.reason, 'accounts_off');
    assert.ok(visible(store).includes(MARK.legacy), 'the single-user record is not shown with accounts off');
    assert.equal(store.getAccountScope().mode, 'legacy');
    assert.ok(browser.log.some((e) => e.kind === 'request' && e.path === '/api/progress' && e.scope === null), 'the single-user record was not synced with the server');
    assert.ok(result.sync && result.sync.reachable, 'the single-user sync did not run');
  } finally { await offServer.stop(); }

  const onServer = await startServer(4487, { accounts: true });
  try {
    const browser = createBrowser(4487);
    browser.storage.setItem('b1prep.state.v1', JSON.stringify({ version: 1, updatedAt: 1, nodes: {}, history: [], errors: [{ id: 'e1', t: 1, prompt: MARK.legacy, tags: [], resolved: false }], settings: {}, counters: { attempts: 1 } }));
    const { store, boundary } = await browser.page();
    const result = await boundary.resolve();
    assert.equal(result.phase, 'single-user', 'a browser that never signed in left the single-user path');
    assert.ok(visible(store).includes(MARK.legacy));
  } finally { await onServer.stop(); }
});

/* ====================================================================== run */

export async function runSessionBoundaryChecks() {
  if (FORBIDDEN.has(DATABASE)) {
    throw new Error(`refusing to run against ${DATABASE}; set OWNAPI_PG_DATABASE to a disposable database`);
  }
  if (!DATABASE) throw new Error('OWNAPI_PG_DATABASE must name a disposable database');
  const results = [];
  const only = process.env.SESSION_BOUNDARY_ONLY || '';
  for (const { name, run } of checks.filter((c) => c.name.includes(only))) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error) });
    } finally {
      retirePages();
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('session-boundary-check.mjs');
if (invokedDirectly) {
  try {
    const report = await runSessionBoundaryChecks();
    for (const r of report.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
    const failed = report.results.filter((r) => !r.ok).length;
    console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
    console.log(`NOTE real server processes, real HTTP, real boundary/client/store modules (root ${SUT === ROOT ? 'repository' : SUT}).`);
    console.log('NOTE writing drafts resume in the SAME profile only: contract 0.1.0 has no owned list route, so a fresh browser cannot find a draft (issue #63 S6).');
    console.log('NOTE /api/progress is still the F-4 header-attributed path (issue #63 S1), not a session-authorised one.');
    process.exitCode = failed ? 1 : 0;
  } finally {
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
}
