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
 *      afterwards - in the store, in the draft session, and in this browser's storage -
 *      whether the final save confirmed, was held past the budget or could not leave
 *      (offline); expiry and an account switch also remove the copy (SESSION-BOUNDARY-02 F1);
 *   3. account switch: account B never sees account A's record, and an in-flight response
 *      for A (progress AND owned settings) that resolves after the switch does not land;
 *   4. fresh browser: a clean profile that signs in resumes the account's notebook, ability
 *      record and settings from the server with no local file imported;
 *   5. expiry / a refused session fails closed to signed-out, not to the single-user record;
 *   6. the single-user path (accounts off, or never signed in) reconciles once at boot as
 *      before; a tab return re-checks identity but does not reconcile again or replace the
 *      in-memory record, and still notices another tab signing in (SESSION-BOUNDARY-02 F3).
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
  newer: `SYNTH-NEWER-${RUN_ID}`,
  lateSettings: '2032-02-02',
  mockLate: `SYNTH-MOCK-LATE-${RUN_ID}`,
  mockLateOut: `SYNTH-MOCK-LATE-OUT-${RUN_ID}`,
  mockControl: `SYNTH-MOCK-CONTROL-${RUN_ID}`,
  speakLate: `SYNTH-SPEAK-LATE-${RUN_ID}`,
  speakLateOut: `SYNTH-SPEAK-LATE-OUT-${RUN_ID}`,
  speakControl: `SYNTH-SPEAK-CONTROL-${RUN_ID}`,
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
// The mock exam's outcome module carries the completion gate AND the identity-scope fence the
// three exam writers share (SESSION-FENCE-03 F-A). It is a NAMESPACE import on purpose: before
// the fix the guard does not exist yet, and a named import would abort the whole FILE instead of
// failing the individual checks that need it.
const outcomeModule = await import(pathToFileURL(path.join(SUT, 'public/js/mock-outcome.js')).href);

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
  // `profile.offline = true` makes every request fail the way a browser's fetch does offline.
  const profile = { offline: false };

  async function fetchImpl(url, init = {}) {
    const href = String(url).startsWith('http') ? String(url) : `${base}${url}`;
    const pathname = new URL(href).pathname;
    const method = init.method || 'GET';
    if (profile.offline) {
      log.push({ kind: 'request', method, path: pathname, at: 'offline' });
      throw new TypeError('Failed to fetch');
    }
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

  return { jar, log, storage, hold, activate, page, fetchImpl, profile };
}

/** The keys of this profile's storage whose value contains any of `markers`. */
function storageKeysHolding(browser, ...markers) {
  return [...browser.storage.data.entries()]
    .filter(([, value]) => markers.some((m) => value.includes(m))).map(([key]) => key);
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
    // Containment precondition (SESSION-FENCE-03, reviewer-named coverage gap): without it this
    // check asserts an absence and cannot tell "the forget worked" from "nothing was ever
    // written". The four later Node checks already have it - this one did not.
    assert.ok(storageKeysHolding(browser, MARK.notebookA).length > 0, 'precondition: the account copy is in this browser storage before the sign-out');

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

/*
 * SESSION-BOUNDARY-02 F1. The check above only covers a sign-out whose final save reached the
 * server. These cover the branches it does not: the browser's copy of the account must be gone
 * whether or not that save landed, and after expiry and an account switch too.
 */
check('sign-out while offline: the account copy is gone from this browser and the learner is told', async () => {
  const server = await startServer(4488, { accounts: true });
  try {
    const { browser, store, boundary } = await seedAccountA(4488, 'offline-signout');
    assert.ok(storageKeysHolding(browser, MARK.notebookA).length > 0, 'precondition: the account copy is in this browser storage');
    browser.profile.offline = true;
    const outcome = await boundary.signOut().then((r) => r, (e) => e);
    assert.equal(boundary.phase, 'signed-out');
    const leaking = storageKeysHolding(browser, MARK.notebookA, MARK.draftA);
    assert.deepEqual(leaking, [], `an offline sign-out left the account text in this browser storage under ${leaking.join(', ')}`);
    assert.ok(!visible(store).includes(MARK.notebookA), 'the notebook entry is still readable after an offline sign-out');
    assert.equal(outcome && outcome.lastSaveReached, false, 'the caller is not told that the last save did not reach the server');
  } finally { await server.stop(); }
});

check('sign-out with the final save held past the budget: the account copy is gone, before and after the answer lands', async () => {
  const server = await startServer(4489, { accounts: true });
  try {
    const { browser, store, boundary, account } = await seedAccountA(4489, 'held-signout');
    assert.ok(storageKeysHolding(browser, MARK.notebookA).length > 0, 'precondition: the account copy is in this browser storage');
    const held = browser.hold((e) => e.method === 'POST' && e.path === '/api/progress' && e.scope === account.id);
    const signingOut = boundary.signOut();
    await held.arrived;
    const outcome = await signingOut; // resolves only after the 4 s budget, the save still held
    assert.equal(boundary.phase, 'signed-out');
    let leaking = storageKeysHolding(browser, MARK.notebookA, MARK.draftA);
    assert.deepEqual(leaking, [], `a sign-out with the save held left the account text in this browser storage under ${leaking.join(', ')}`);
    assert.equal(outcome.lastSaveReached, false, 'the caller is not told that the last save did not reach the server');
    held.release();
    await sleep(300);
    leaking = storageKeysHolding(browser, MARK.notebookA, MARK.draftA);
    assert.deepEqual(leaking, [], `the held answer wrote the account text back under ${leaking.join(', ')}`);
    assert.ok(!visible(store).includes(MARK.notebookA), 'the held answer put the notebook entry back in the store');
  } finally { await server.stop(); }
});

check('expiry: a refused session forgets the account copy in this browser', async () => {
  const server = await startServer(4490, { accounts: true });
  try {
    const { browser, boundary } = await seedAccountA(4490, 'expiry-forget');
    assert.ok(storageKeysHolding(browser, MARK.notebookA).length > 0, 'precondition: the account copy is in this browser storage');
    // Expire the session on the server while this page still holds the cookie.
    const cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const killed = await realFetch('http://127.0.0.1:4490/api/auth/sign-out', {
      method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:4490', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(killed.status, 200);
    // Mid-session: the next account call is refused.
    const saved = await boundary.saveSettings({ dailyGoal: 41 });
    assert.equal(saved.reason, 'expired');
    assert.equal(boundary.phase, 'signed-out');
    const leaking = storageKeysHolding(browser, MARK.notebookA, MARK.draftA);
    assert.deepEqual(leaking, [], `expiry left the account text in this browser storage under ${leaking.join(', ')}`);
  } finally { await server.stop(); }
});

check('account switch: the previous account copy is gone from this browser', async () => {
  const server = await startServer(4491, { accounts: true });
  try {
    const { browser, boundary, account } = await seedAccountA(4491, 'switch-forget-a');
    assert.ok(storageKeysHolding(browser, MARK.notebookA).length > 0, 'precondition: the account copy is in this browser storage');
    // The switch: B signs up on the same page with no sign-out in between.
    const toB = await boundary.signUp({ name: 'B', email: email('switch-forget-b'), password: password('switch-forget-b') });
    assert.equal(toB.phase, 'signed-in');
    assert.notEqual(toB.account.id, account.id);
    const leaking = storageKeysHolding(browser, MARK.notebookA, MARK.draftA);
    assert.deepEqual(leaking, [], `a switch left the previous account text in this browser storage under ${leaking.join(', ')}`);
  } finally { await server.stop(); }
});

check('another page of the same browser cannot re-create the record after a sign-out, and the next sign-in still saves', async () => {
  // SESSION-BOUNDARY-04 (review finding N-1), the store half: the shared marker fences the
  // write path of a page that still holds the account in memory. The cross-tab NOTICE needs
  // a real browser's storage event and is proven in tools/session-boundary-browser-check.mjs.
  const server = await startServer(4494, { accounts: true });
  try {
    const { browser, store: tab1, boundary: b1, account } = await seedAccountA(4494, 'n1-a');
    const tab2 = await browser.page();
    const resolved = await tab2.boundary.resolve();
    assert.equal(resolved.account && resolved.account.id, account.id, 'precondition: the second page resolves to the same account');
    await b1.signOut();
    assert.deepEqual(storageKeysHolding(browser, MARK.notebookA), [], 'precondition: the sign-out forgot the account copy');
    // The second page still believes it is A: a learner action, a debounced save and the
    // flush its visibilitychange/pagehide handler makes.
    tab2.store.recordAttempt({ partId: 'SB1', tags: [], difficulty: 50, correct: false, detail: { prompt: `${MARK.notebookA}-TAB2`, yourAnswer: 'x', correctAnswer: 'y' } });
    tab2.store.saveNow();
    const flushed = await tab2.store.flushNow();
    await sleep(400);
    const leaking = storageKeysHolding(browser, MARK.notebookA);
    assert.deepEqual(leaking, [], `the second page re-created the account record under ${leaking.join(', ')}`);
    assert.equal(flushed, false, 'the second page still sent the account record to the server after the sign-out');
    // THE CONTROL: a fresh sign-in after the forget saves, locally and to the server.
    const again = await b1.signIn({ email: email('n1-a'), password: password('n1-a') });
    assert.equal(again.phase, 'signed-in');
    tab1.recordAttempt({ partId: 'SB1', tags: [], difficulty: 50, correct: false, detail: { prompt: `${MARK.notebookA}-AGAIN`, yourAnswer: 'x', correctAnswer: 'y' } });
    assert.equal(await tab1.flushNow(), true, 'a sign-in after the forget could not save to the server');
    assert.deepEqual(storageKeysHolding(browser, `${MARK.notebookA}-AGAIN`), [`b1prep.state.v1::${account.id}`], 'a sign-in after the forget could not save locally');
  } finally { await server.stop(); }
});

/*
 * N-2 follow-up (SESSION-FENCE-02 F-B). The discard notice on the EXPIRY path was a field, but
 * `enterSignedOut` RECOMPUTED it on every call - and the Konto view always performs one more
 * resolve after the tab return - so the learner was told nothing. This drives the REAL boundary
 * and the REAL store over real HTTP: a change is held on the wire so it is genuinely unsaved
 * ('pending'), the session is expired, the boundary resolves (the tab-return path), then resolves
 * AGAIN (exactly what the Konto view does). The notice and the reason must survive.
 */
check('expiry: the discard notice survives the Konto view\u2019s own second resolve', async () => {
  const server = await startServer(4495, { accounts: true });
  try {
    const { browser, store, boundary, account } = await seedAccountA(4495, 'expiry-notice');
    // Hold the account's progress POST so a change is genuinely unsaved when the session is
    // refused. The store's own 1200 ms debounce fires it; wait for the hold to be reached.
    const held = browser.hold((e) => e.method === 'POST' && e.path === '/api/progress' && e.scope === account.id);
    store.recordAttempt({ partId: 'SB1', tags: ['praepositionen'], difficulty: 50, correct: false, detail: { prompt: `${MARK.notebookA}-PENDING`, yourAnswer: 'x', correctAnswer: 'y' } });
    await held.arrived;
    assert.equal(store.syncStatus().state, 'pending', 'precondition: a change is genuinely unsaved');
    // Expire the session server-side while this page still holds the cookie.
    const cookie = [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const killed = await realFetch('http://127.0.0.1:4495/api/auth/sign-out', {
      method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:4495', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(killed.status, 200);
    // The tab-return resolve: the session is refused and the unsaved change is discarded.
    const first = await boundary.resolve();
    assert.equal(first.phase, 'signed-out');
    assert.equal(first.reason, 'expired');
    assert.equal(first.discardedUnsaved, true, 'the first resolve did not report the discarded change');
    // The Konto view resolves again - the resolve that used to erase the notice.
    const second = await boundary.resolve();
    assert.equal(second.phase, 'signed-out');
    assert.equal(second.discardedUnsaved, true, 'the Konto view\u2019s second resolve erased the discard notice');
    assert.equal(second.reason, 'expired', `the second resolve changed the reason to ${second.reason}`);
    held.release();
    await sleep(300);
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
    // Make A's server record the NEWEST one, so an unfenced late answer would be adopted
    // (an older record is ignored by the timestamp rule and would prove nothing).
    await sleep(20);
    store.recordAttempt({ partId: 'SB1', tags: [], difficulty: 50, correct: true });
    assert.equal(await store.flushNow(), true);
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

/*
 * SESSION-BOUNDARY-02 F3. A tab return calls resolve() again. On a single-user page that must
 * re-check identity (the hardening) WITHOUT re-reconciling the record: the old app reconciled
 * once, at boot, and never replaced the in-memory record mid-session.
 */
check('single-user: a second resolve (tab return) neither reconciles again nor replaces the in-memory record', async () => {
  const server = await startServer(4492, { accounts: false });
  try {
    const browser = createBrowser(4492);
    browser.storage.setItem('b1prep.state.v1', JSON.stringify({ version: 1, updatedAt: 1, nodes: {}, history: [], errors: [{ id: 'e1', t: 1, prompt: MARK.legacy, tags: [], resolved: false }], settings: {}, counters: { attempts: 1 } }));
    const { store, boundary } = await browser.page();
    const first = await boundary.resolve();
    assert.equal(first.phase, 'single-user');
    assert.ok(first.sync && first.sync.reachable, 'precondition: the boot-time reconcile ran');
    const before = store.getState();

    // Another browser saves a NEWER single-user record to the server meanwhile.
    const base = 'http://127.0.0.1:4492';
    const current = await (await realFetch(`${base}/api/progress`)).json();
    const newer = { version: 1, createdAt: 1, updatedAt: Date.now() + 1000, settings: {}, nodes: {}, history: [], srs: {}, days: {}, planDone: {},
      errors: [{ id: 'e-newer', t: Date.now(), prompt: MARK.newer, tags: [], resolved: false }], counters: { attempts: 2 } };
    const posted = await realFetch(`${base}/api/progress`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ state: newer, rev: current.rev }) });
    assert.equal(posted.status, 200, 'precondition: the newer record reached the server');

    const mark = browser.log.length;
    const second = await boundary.resolve();
    const after = browser.log.slice(mark);
    assert.equal(second.phase, 'single-user');
    assert.ok(after.some((e) => e.kind === 'request' && e.path === '/api/v1/account'), 'the tab return no longer re-checks identity');
    const progress = after.filter((e) => e.kind === 'request' && e.at === 'start' && e.path === '/api/progress').map((e) => e.method);
    assert.deepEqual(progress, [], `the tab return reconciled the single-user record again (${progress.join(', ')})`);
    assert.equal(store.getState(), before, 'the in-memory record was replaced mid-session');
    assert.ok(!visible(store).includes(MARK.newer), 'the newer server record was adopted mid-session');
  } finally { await server.stop(); }
});

check('single-user: a tab return still notices another tab signing in (the hardening is kept)', async () => {
  const server = await startServer(4493, { accounts: true });
  try {
    const browser = createBrowser(4493);
    const tab1 = await browser.page();
    assert.equal((await tab1.boundary.resolve()).phase, 'single-user', 'precondition: never signed in');
    // Another tab of the same browser (same cookies and storage) signs up.
    const tab2 = await browser.page();
    await tab2.boundary.resolve();
    const signedUp = await tab2.boundary.signUp({ name: 'T', email: email('tab-return'), password: password('tab-return') });
    // Back to the first tab.
    const back = await tab1.boundary.resolve();
    assert.equal(back.phase, 'signed-in', `the single-user tab stayed ${back.phase} after another tab signed in`);
    assert.equal(back.account.id, signedUp.account.id);
    assert.equal(tab1.store.getAccountScope().accountId, signedUp.account.id, 'the first tab still writes the single-user record');
  } finally { await server.stop(); }
});

/* ==================================================== SESSION-FENCE-03 F-A */
/*
 * A late mock-test or speaking answer crossing into the NEXT account's record.
 *
 * The exam writers write learner state AFTER an `await` (the grading round trip). Their guard
 * is the store's identity scope: take an opaque token with `store.scopeToken()` before the
 * await and re-test it with `store.isScopeCurrent()` after. The mock block gate's old guard
 * compared the resumed session to ITSELF (`mockState === session && ... session.blockIndex`),
 * so a sign-out or a same-page switch left it true and the gate committed into whatever
 * account was current by then. The fence is factored into `mock-outcome.js` once
 * (`mockBlockGuard`, `withinScope`) and shared by the writing, speaking and mock writers.
 *
 * These checks drive the REAL store over real HTTP and the REAL gate/guard modules. They assert
 * on the `mock` and `speaking` sources explicitly - the existing F-H check counts only
 * `source === 'writing'`, which is exactly how F-A stayed invisible.
 */

/** The shared scope fence, or a clear failure when the module does not export it yet. */
function scopeFenceGuard() {
  if (typeof outcomeModule.withinScope !== 'function') {
    throw new Error('mock-outcome.js exports no `withinScope`: the F-A identity-scope fence is not implemented');
  }
  return outcomeModule.withinScope;
}

/**
 * Drive ONE mock block's completion gate exactly as `exam.js` does: the shared `mockBlockGuard`
 * over the real store's scope, a `collect` held open to stand in for the writing grading round
 * trip, and the same two writes the real `commit` makes - a `source: 'mock'` notebook entry and
 * a `source: 'mock'` attempt.
 */
function startMockBlockGate(store, { marker, held }) {
  if (typeof outcomeModule.mockBlockGuard !== 'function') {
    throw new Error('mock-outcome.js exports no `mockBlockGuard`: the F-A mock gate fence is not implemented');
  }
  // The resumed session is the SAME object for the block and for "what is current" - the shape
  // the reviewer named: the old guard compared the session to itself.
  const session = { phase: 'exam', blockIndex: 0, blockResults: [] };
  const guard = outcomeModule.mockBlockGuard({
    token: store.scopeToken(),
    scopeCurrent: store.isScopeCurrent,
    session,
    currentSession: () => session,
    index: 0,
  });
  const gate = outcomeModule.createCompletionGate();
  return gate({
    isCurrent: guard,
    collect: async () => { await held; return marker; },
    commit: (m) => {
      store.addError({ partId: 'SA1', tags: ['sa_grammatik'], difficulty: 60, prompt: m, yourAnswer: m, correctAnswer: 'c', explanation: 'e', source: 'mock' });
      store.recordAttempt({ partId: 'SB1', tags: ['praepositionen'], difficulty: 50, correct: false, source: 'mock', detail: { prompt: m, yourAnswer: 'x', correctAnswer: 'y' } });
      session.blockResults.push(m);
    },
  });
}

/** The speaking writer's fence: the token is taken before the await and tested after it. */
async function runSpeakingWriter(store, { marker, held, withinScope }) {
  const token = store.scopeToken();
  await held;
  if (!withinScope(token, store.isScopeCurrent)) return false;
  store.recordAttempt({ partId: 'SB1', tags: ['sp_struktur'], difficulty: 50, correct: true, source: 'speaking', detail: { prompt: marker } });
  store.addError({ partId: 'SB1', tags: ['sp_wortschatz'], difficulty: 50, prompt: marker, yourAnswer: 'a', correctAnswer: 'b', explanation: 'e', source: 'speaking' });
  return true;
}

const held = () => { let release; const gate = new Promise((resolve) => { release = resolve; }); return { gate, release }; };
const mockAttempts = (store) => store.getState().history.filter((h) => h.source === 'mock').length;
const speakingAttempts = (store) => store.getState().history.filter((h) => h.source === 'speaking').length;

check('F-A mock gate: a held block write does not cross a SWITCH into the next account', async () => {
  const server = await startServer(4451, { accounts: true });
  try {
    const browser = createBrowser(4451);
    const { store, boundary } = await browser.page();
    await boundary.resolve();
    await boundary.signUp({ name: 'A', email: email('fa-mock-switch-a'), password: password('fa-mock-switch-a') });
    const h = held();
    const pending = startMockBlockGate(store, { marker: MARK.mockLate, held: h.gate });
    // The switch: B signs up on this page while A's mock grading is still on the wire.
    const b = await boundary.signUp({ name: 'B', email: email('fa-mock-switch-b'), password: password('fa-mock-switch-b') });
    assert.equal(b.phase, 'signed-in');
    h.release();
    const committed = await pending;
    assert.equal(committed, false, 'the mock gate committed a block that belonged to the previous account');
    assert.ok(!visible(store).includes(MARK.mockLate), "A's late mock writing is in B's notebook");
    assert.equal(mockAttempts(store), 0, "A's late mock attempt is in B's attempt history");
    assert.equal(await store.flushNow(), true, 'precondition: B can save its own record');
    assert.deepEqual(storageKeysHolding(browser, MARK.mockLate), [], `A's late mock text is in this browser storage under ${storageKeysHolding(browser, MARK.mockLate).join(', ')}`);
    const record = await (await realFetch('http://127.0.0.1:4451/api/progress', { headers: { 'x-b1prep-account': b.account.id, origin: 'http://127.0.0.1:4451' } })).text();
    assert.ok(!record.includes(MARK.mockLate), "A's late mock text reached B's server progress record");
  } finally { await server.stop(); }
});

check('F-A mock gate: a held block write does not cross a SIGN-OUT', async () => {
  const server = await startServer(4452, { accounts: true });
  try {
    const browser = createBrowser(4452);
    const { store, boundary } = await browser.page();
    await boundary.resolve();
    await boundary.signUp({ name: 'A', email: email('fa-mock-signout'), password: password('fa-mock-signout') });
    const h = held();
    const pending = startMockBlockGate(store, { marker: MARK.mockLateOut, held: h.gate });
    await boundary.signOut();
    assert.equal(boundary.phase, 'signed-out');
    h.release();
    const committed = await pending;
    assert.equal(committed, false, 'the mock gate committed a block that belonged to the signed-out account');
    // On a sign-out the store refuses the notebook entry and the storage write, but a
    // `recordAttempt` still grows the in-memory history (the reviewer's execution). So the
    // history is the discriminator here.
    assert.equal(mockAttempts(store), 0, "A's late mock attempt grew the signed-out attempt history");
    assert.equal(store.listErrors().length, 0, "A's late mock writing entered the signed-out notebook");
  } finally { await server.stop(); }
});

check('F-A speaking gate: a held write does not cross a SWITCH into the next account', async () => {
  const server = await startServer(4453, { accounts: true });
  try {
    const browser = createBrowser(4453);
    const { store, boundary } = await browser.page();
    await boundary.resolve();
    await boundary.signUp({ name: 'A', email: email('fa-speak-switch-a'), password: password('fa-speak-switch-a') });
    // Take the guard synchronously: a missing export must FAIL this check, never float a
    // rejected promise that Node would report as an unhandled rejection.
    const withinScope = scopeFenceGuard();
    const h = held();
    const pending = runSpeakingWriter(store, { marker: MARK.speakLate, held: h.gate, withinScope });
    const b = await boundary.signUp({ name: 'B', email: email('fa-speak-switch-b'), password: password('fa-speak-switch-b') });
    assert.equal(b.phase, 'signed-in');
    h.release();
    assert.equal(await pending, false, 'the speaking writer committed after the scope had switched');
    assert.ok(!visible(store).includes(MARK.speakLate), "A's late speaking text is in B's notebook");
    assert.equal(speakingAttempts(store), 0, "A's late speaking attempt is in B's history");
    assert.equal(await store.flushNow(), true, 'precondition: B can save its own record');
    assert.deepEqual(storageKeysHolding(browser, MARK.speakLate), [], `A's late speaking text is in this browser storage under ${storageKeysHolding(browser, MARK.speakLate).join(', ')}`);
    const record = await (await realFetch('http://127.0.0.1:4453/api/progress', { headers: { 'x-b1prep-account': b.account.id, origin: 'http://127.0.0.1:4453' } })).text();
    assert.ok(!record.includes(MARK.speakLate), "A's late speaking text reached B's server progress record");
  } finally { await server.stop(); }
});

check('F-A speaking gate: a held write does not cross a SIGN-OUT', async () => {
  const server = await startServer(4454, { accounts: true });
  try {
    const browser = createBrowser(4454);
    const { store, boundary } = await browser.page();
    await boundary.resolve();
    await boundary.signUp({ name: 'A', email: email('fa-speak-signout'), password: password('fa-speak-signout') });
    const withinScope = scopeFenceGuard();
    const h = held();
    const pending = runSpeakingWriter(store, { marker: MARK.speakLateOut, held: h.gate, withinScope });
    await boundary.signOut();
    h.release();
    assert.equal(await pending, false, 'the speaking writer committed after the sign-out');
    assert.equal(speakingAttempts(store), 0, "A's late speaking attempt grew the signed-out history");
    assert.equal(store.listErrors().length, 0, "A's late speaking text entered the signed-out notebook");
  } finally { await server.stop(); }
});

/*
 * The CONTROL. Without it every check above could pass because the write never ran at all -
 * the exact failure mode this programme has recorded repeatedly. Nothing changes while the
 * grading is held, so the SAME held write must commit.
 */
check('F-A control: a held block write DOES commit when nothing changes', async () => {
  const server = await startServer(4455, { accounts: true });
  try {
    const browser = createBrowser(4455);
    const { store, boundary } = await browser.page();
    await boundary.resolve();
    await boundary.signUp({ name: 'A', email: email('fa-control'), password: password('fa-control') });
    const h = held();
    const pending = startMockBlockGate(store, { marker: MARK.mockControl, held: h.gate });
    h.release();
    assert.equal(await pending, true, 'the mock gate did NOT commit with nothing changing');
    assert.ok(visible(store).includes(MARK.mockControl), 'the control mock write did not land');
    assert.equal(mockAttempts(store), 1, 'the control mock attempt did not land');
    const sh = held();
    const speaking = runSpeakingWriter(store, { marker: MARK.speakControl, held: sh.gate, withinScope: scopeFenceGuard() });
    sh.release();
    assert.equal(await speaking, true, 'the speaking writer did NOT commit with nothing changing');
    assert.equal(speakingAttempts(store), 1, 'the control speaking attempt did not land');
  } finally { await server.stop(); }
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
