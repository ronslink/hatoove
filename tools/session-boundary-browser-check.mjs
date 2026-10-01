/**
 * Headless-browser evidence for the application session boundary (SESSION-BOUNDARY-01,
 * issue #63 S4). Follows tools/account-ui-browser-check.mjs.
 *
 * What it proves in a real headless Chromium page, served over real HTTP:
 *   * ORDER: on a page load, no learner record is read from localStorage and no
 *     /api/progress request is made before /api/v1/account has answered - recorded by an
 *     instrumentation script installed before any page script runs;
 *   * SIGN-OUT CLEARS: after signing out through the Konto page, the notebook view, the
 *     notebook badge and the dashboard no longer show the account's work, and this browser's
 *     localStorage holds none of its text - on all three branches: the final save confirmed,
 *     the final save held past the sign-out budget (before and after it lands), and offline;
 *     on the two unconfirmed branches the learner is told (SESSION-BOUNDARY-02 F1);
 *   * NO LATE REPAINT: a progress response for the account that arrives AFTER the page signed
 *     out does not repaint the account's work (view, badge, Konto state or storage);
 *   * NO LATE WRITING FEEDBACK: with a STUBBED AI provider, a writing grading held across a
 *     sign-out or an account switch puts no text in the notebook, records no attempt and
 *     reaches no storage; a signed-out page refuses a notebook entry (SESSION-BOUNDARY-02 F2);
 *   * ANOTHER TAB (SESSION-BOUNDARY-04, review finding N-1): with two REAL pages of one browser
 *     profile, a sign-out in one tab is followed by the other - it does not re-create the
 *     account's record in localStorage (S17: a later answer and flush; S7b: a 250 ms save
 *     already queued) and it stops showing the account's data. Controls: a sign-in after the
 *     forget still saves, locally and to the server, in either tab;
 *   * the single-user path with accounts disabled: the record shows, 12 views; a tab return
 *     re-checks identity but does not reconcile again or replace the record (F3);
 *   * no console errors; desktop 1440 px and phone 390 px screenshots.
 *
 * The server is the disposable copy's real `createServer` (so /api/progress is the real
 * route), mounted in-process with a SYNTHETIC owned API that speaks the `/api/auth/*`,
 * `/api/v1/account` and `/api/v1/settings` contract - no PostgreSQL. A response gate in front
 * of the real request handler lets the check hold one /api/progress answer.
 *
 * Safety: its OWN disposable source-only copy (no .env, no learner progress, no .git), live
 * ports refused, B1PREP_FORCE_OFFLINE=1, synthetic accounts only, no provider call. Headless
 * Chromium with emulated viewports: no real phone, keyboard or audio path. NOT Better Auth.
 *
 * Usage: node tools/session-boundary-browser-check.mjs [--port 4341] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CDP, connectToPage, sleep } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SESSION_BOUNDARY_ROOT lets the discrimination run copy a scratch tree instead.
const SOURCE = path.resolve(process.env.SESSION_BOUNDARY_ROOT || ROOT);
const FORBIDDEN_PORTS = new Set([4321, 4381]);
const SHOTS = path.join(ROOT, '.openclaw', 'tmp', 'session-boundary');
const RUN = crypto.randomUUID().slice(0, 8);
const A = Object.freeze({
  name: 'SYNTHETIC A (session-boundary check)',
  email: `synthetic.sb-a.${RUN}@example.invalid`,
  password: 'synthetic-pass-a-123',
  marker: `SYNTH-SB-NOTEBOOK-${RUN}`,
});
const B = Object.freeze({
  email: `synthetic.sb-b.${RUN}@example.invalid`,
  password: 'synthetic-pass-b-123',
});
const LEGACY_MARKER = `SYNTH-SB-LEGACY-${RUN}`;
const NEWER_MARKER = `SYNTH-SB-NEWER-${RUN}`;
// The learner's own text as the stubbed grading's correction quotes it (F2).
const W_MARKER = `SYNTH-SB-WRITING-${RUN}`;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

function findChromium() {
  for (const candidate of CHROME_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  throw new Error('No Chromium found; set CHROME_PATH to a headless-capable browser.');
}

/** Copy the source tree without git metadata, learner data, secrets or build output. */
function materializeSourceCheckout() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-session-boundary-'));
  const skip = new Set(['.git', '.openclaw', 'node_modules', 'portable']);
  const skipNames = new Set(['.env', 'progress.json']);
  fs.cpSync(SOURCE, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SOURCE, src);
      if (!rel) return true;
      if (skip.has(rel.split(path.sep)[0])) return false;
      if (rel.split(path.sep).includes('node_modules')) return false;
      return !skipNames.has(path.basename(src));
    },
  });
  const work = path.join(dest, '.openclaw', 'tmp');
  fs.mkdirSync(work, { recursive: true });
  const envPath = path.join(work, 'test.env');
  const progressPath = path.join(work, 'progress.json');
  fs.writeFileSync(envPath, '# isolated browser-check env: deliberately no provider key\n', 'utf8');
  return { dest, envPath, progressPath };
}

/* --------------------------------------------------- synthetic account store */

const readRequestBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return resolve({});
    try { resolve(JSON.parse(text)); } catch { resolve(null); }
  });
  req.on('error', reject);
});

const reply = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};

function parseCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

/** `/api/auth/*`, `/api/v1/account` and `/api/v1/settings`, in memory, same contract as the real mount. */
function createSyntheticOwnedApi() {
  const accounts = new Map();
  const sessions = new Map();
  const settings = new Map();
  const COOKIE = 'b1prep_synthetic_session';
  const current = (req) => {
    const id = sessions.get(parseCookie(req.headers.cookie, COOKIE));
    return [...accounts.values()].find((a) => a.id === id) || null;
  };
  const issue = (res, account) => {
    const token = crypto.randomUUID();
    sessions.set(token, account.id);
    reply(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` });
  };
  async function handleNode(req, res) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const method = req.method || 'GET';
    const body = method === 'GET' ? {} : await readRequestBody(req);
    if (body === null) return reply(res, 400, { error: 'invalid_request' });
    if (method === 'POST' && pathname === '/api/auth/sign-up/email') {
      if (accounts.has(body.email)) return reply(res, 409, { error: 'user_exists' });
      const account = { id: crypto.randomUUID(), email: body.email, password: body.password };
      accounts.set(body.email, account);
      return issue(res, account);
    }
    if (method === 'POST' && pathname === '/api/auth/sign-in/email') {
      const account = accounts.get(body.email);
      if (!account || account.password !== body.password) return reply(res, 401, { error: 'invalid_credentials' });
      return issue(res, account);
    }
    if (method === 'POST' && pathname === '/api/auth/sign-out') {
      sessions.delete(parseCookie(req.headers.cookie, COOKIE));
      return reply(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
    }
    const account = current(req);
    if (pathname === '/api/v1/account' && method === 'GET') {
      if (!account) return reply(res, 401, { error: 'unauthenticated' });
      return reply(res, 200, { contractVersion: '0.1.0', id: account.id, email: account.email });
    }
    if (pathname === '/api/v1/settings') {
      if (!account) return reply(res, 401, { error: 'unauthenticated' });
      const record = settings.get(account.id) || { revision: 0, settings: { examDate: '', dailyGoal: 20, model: '', theme: 'system', language: '' } };
      if (method === 'GET') return reply(res, 200, record);
      if (method === 'PUT') {
        if (body.expectedRevision !== record.revision) return reply(res, 409, { error: 'settings_conflict' });
        const next = { revision: record.revision + 1, settings: { ...record.settings, ...body.settings } };
        settings.set(account.id, next);
        return reply(res, 200, next);
      }
    }
    return reply(res, 404, { error: 'not_found' });
  }
  return Object.freeze({
    handleNode,
    matches: (pathname) => pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/'),
    idOf: (email) => accounts.get(email)?.id || null,
  });
}

/* ---------------------------------------------------------------- servers */

/** The real server, with a gate that can hold ONE matching response until released. */
async function startInProcessServer({ copyRoot, port, ownedApi }) {
  const mod = await import(pathToFileURL(path.join(copyRoot, 'server.js')).href);
  const server = mod.createServer({ ownedApi });
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  const gate = { match: null, held: null, release: null };
  // Synthetic answers that replace the real handler while set (the stubbed AI provider).
  const stubs = [];
  server.on('request', (req, res) => {
    const stub = stubs.find((s) => s.match(req));
    const pass = stub
      ? () => stub.answer(req, res)
      : () => { for (const handler of handlers) handler.call(server, req, res); };
    if (gate.match && gate.match(req)) {
      gate.match = null;
      // Hold the RESPONSE: let the real handler compute it, delay delivering it.
      const write = res.end.bind(res);
      let release;
      gate.held = new Promise((resolve) => { release = resolve; });
      gate.release = release;
      gate.reached = true;
      res.end = (...args) => { gate.held.then(() => write(...args)); return res; };
    }
    pass();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    gate,
    holdNext(match) { gate.reached = false; gate.match = match; },
    stub(match, answer) { stubs.push({ match, answer }); },
    clearStubs() { stubs.length = 0; },
    cleanup: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

async function launchChromium(debugPort) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-session-boundary-prof-'));
  const proc = spawn(findChromium(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  return {
    cleanup: async () => {
      try { proc.kill(); } catch { /* ignore */ }
      await sleep(500);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Open a SECOND real page in the same headless browser - same profile, so the same cookie jar
 * and the same localStorage, exactly what another tab of the learner's browser shares.
 */
async function openSecondTab(debugPort, url) {
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('second tab: WebSocket connection failed')), { once: true });
  });
  const tab = new CDP(ws);
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
  await tab.send('Page.navigate', { url });
  tab.close = async () => {
    try { ws.close(); } catch { /* ignore */ }
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => {});
  };
  return tab;
}

/** The account-namespace keys (`b1prep.state.v1::<id>`) whose value contains `text`. */
const accountKeysHolding = (cdp, text) => cdp.evaluate(`return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
  .filter((k) => k && k.startsWith('b1prep.state.v1::') && (localStorage.getItem(k) || '').includes(${JSON.stringify(text)}))`);

/** Record one wrong answer carrying `marker` as a notebook entry, as a learner action would. */
const recordMarkedAttempt = (cdp, marker) => cdp.evaluate(`return import('/js/store.js').then((m) => {
  m.recordAttempt({ partId: 'SB1', tags: [], difficulty: 50, correct: false, detail: { prompt: ${JSON.stringify(marker)}, yourAnswer: 'x', correctAnswer: 'y' } });
  return Date.now();
})`);

const scopeOf = (cdp) => cdp.evaluate(`return import('/js/store.js').then((m) => m.getAccountScope())`);

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  return path.join(SHOTS, name);
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const port = Number(index === -1 ? '4341' : argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65533) throw new Error(`invalid --port ${port}`);
  for (const p of [port, port + 1, port + 2]) {
    if (FORBIDDEN_PORTS.has(p)) throw new Error(`port ${p} is a live learner port; pick an isolated one`);
  }
  return port;
}

/** Installed before any page script: logs learner-record reads and request start/end. */
const INSTRUMENT = `
  window.__sb = [];
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) { window.__sb.push({ kind: 'read', key: String(key) }); return getItem.call(this, key); };
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const headers = (init && init.headers) || {};
    const scope = headers['X-B1Prep-Account'] || headers['x-b1prep-account'] || null;
    const entry = { kind: 'request', path: url.pathname, method: (init && init.method) || 'GET', scope };
    window.__sb.push({ ...entry, at: 'start' });
    return realFetch(input, init).then((res) => { window.__sb.push({ ...entry, at: 'end', status: res.status }); return res; });
  };
`;

async function postProgress(port, accountId, marker, rev = 0) {
  const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` };
  if (accountId) headers['x-b1prep-account'] = accountId;
  const state = {
    version: 1, createdAt: 1, updatedAt: Date.now(), settings: {},
    nodes: { 'skill:SB1': { theta: 40, n: 1, correct: 0, last: Date.now(), streak: 0 } },
    history: [{ t: Date.now(), partId: 'SB1', tags: [], difficulty: 50, correct: false, source: 'drill', ms: 0, itemRef: null }],
    errors: [{ id: `e-${marker}`, t: Date.now(), partId: 'SB1', tags: [], difficulty: 50, prompt: marker, yourAnswer: 'x', correctAnswer: 'y', explanation: '', reviewed: 0, resolved: false, source: 'drill' }],
    srs: {}, days: {}, planDone: {}, counters: { attempts: 1, correct: 0, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
  const response = await fetch(`http://127.0.0.1:${port}/api/progress`, { method: 'POST', headers, body: JSON.stringify({ state, rev }) });
  if (!response.ok) throw new Error(`seeding progress failed: HTTP ${response.status}`);
}

const viewText = (cdp) => cdp.evaluate(`return document.getElementById('view').innerText`);
const badge = (cdp) => cdp.evaluate(`return (document.querySelector('[data-badge="notebook"]') || {}).textContent || ''`);
const storageHasExpr = (text) => `Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)) || '').some((v) => v.includes(${JSON.stringify(text)}))`;
const storageHas = (cdp, text) => cdp.evaluate(`return ${storageHasExpr(text)}`);

/**
 * A stubbed AI provider for the writing view: `/api/config` says an operator key exists and
 * `/api/ai` answers a fixed grading whose correction carries `marker` as the learner's own
 * text. No provider is called.
 */
function stubWritingProvider(server, markerOf) {
  server.stub((req) => req.method === 'GET' && req.url.startsWith('/api/config'), (req, res) => reply(res, 200, { configured: true, examDate: '' }));
  const grading = {
    criteria: [
      { key: 'aufgabe', score: 60, points: 9, comment: 'synthetic' },
      { key: 'kommunikation', score: 60, points: 6, comment: 'synthetic' },
      { key: 'richtigkeit', score: 50, points: 6, comment: 'synthetic' },
      { key: 'ausdruck', score: 50, points: 4, comment: 'synthetic' },
    ],
    total: 25, band: 'ausreichend', leitpunkteCovered: [true, true, false, false],
    corrections: [{ original: '', corrected: 'synthetic correction', explanation: 'synthetic' }],
    strengths: ['synthetic'], priorities: ['synthetic'], modelAnswer: 'synthetic model answer',
  };
  server.stub((req) => req.method === 'POST' && req.url.startsWith('/api/ai'), (req, res) => {
    req.resume();
    req.on('end', () => {
      const answer = { ...grading, corrections: [{ ...grading.corrections[0], original: markerOf() }] };
      reply(res, 200, { ok: true, content: JSON.stringify(answer), finishReason: 'stop' });
    });
  });
}

/** Open the writing view as the current learner, ask for a grading and hold its answer. */
async function startHeldWritingGrade(cdp, server, marker) {
  await openView(cdp, 'writing', 'Schreiben');
  await cdp.waitFor(`!!document.querySelector('#writing-text')`, 15000, 'writing view');
  await cdp.evaluate(`return import('/js/ai.js').then((m) => m.refreshStatus()).then((s) => s.configured === true)`);
  server.holdNext((req) => req.method === 'POST' && req.url.startsWith('/api/ai'));
  const text = Array.from({ length: 12 }, (_, i) => `Ich schreibe dir heute Satz ${i + 1} ${marker}.`).join(' ');
  await cdp.evaluate(`
    const t = document.querySelector('#writing-text');
    t.value = ${JSON.stringify(text)};
    t.dispatchEvent(new Event('input'));
    document.querySelector('[data-grade]').click(); return true;`);
  const deadline = Date.now() + 15000;
  while (!server.gate.reached && Date.now() < deadline) await sleep(100);
  return server.gate.reached === true;
}

/** What the page's store holds from the writing feedback path. */
const writingTrace = (cdp, marker) => cdp.evaluate(`return import('/js/store.js').then((m) => ({
  notebook: m.listErrors({ includeResolved: true }).some((e) => JSON.stringify(e).includes(${JSON.stringify(marker)})),
  writingAttempts: m.getState().history.filter((h) => h.source === 'writing').length,
}))`);

/** Wait until no debounced progress save is still queued in the page. */
async function saveSettled(cdp) {
  await sleep(300);
  await cdp.waitFor(`import('/js/store.js').then((m) => m.syncStatus().state !== 'pending')`, 15000, 'queued save settled');
}

/** Sign in through the Konto form and wait for the signed-in Konto. */
async function signInThroughKonto(cdp, who) {
  await openView(cdp, 'account', 'Konto');
  await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 15000, 'sign-in form');
  await cdp.evaluate(`
    document.querySelector('#signin-email').value = ${JSON.stringify(who.email)};
    document.querySelector('#signin-password').value = ${JSON.stringify(who.password)};
    document.querySelector('[data-signin]').click(); return true;`);
  await cdp.waitFor(`!!document.querySelector('[data-account-email]')`, 15000, `signed in as ${who.email}`);
}

async function openView(cdp, id, title) {
  await cdp.evaluate(`document.querySelector('[data-view="${id}"], [data-shell-view="${id}"]').click(); return true`);
  await cdp.waitFor(`document.getElementById('view-title').textContent === ${JSON.stringify(title)} && !!document.querySelector('#view .card, #view .empty, #view p')`, 15000, title);
  await sleep(200);
}

async function main(argv) {
  const portDisabled = parsePort(argv);
  const debugPort = portDisabled + 1;
  const portAccounts = portDisabled + 2;
  const keep = argv.includes('--keep');

  const checkout = materializeSourceCheckout();
  process.env.B1PREP_ENV_FILE = checkout.envPath;
  process.env.B1PREP_PROGRESS_FILE = checkout.progressPath;
  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ACCOUNTS = '0';

  const disabled = await startInProcessServer({ copyRoot: checkout.dest, port: portDisabled, ownedApi: null });
  const synthetic = createSyntheticOwnedApi();
  const enabled = await startInProcessServer({ copyRoot: checkout.dest, port: portAccounts, ownedApi: synthetic });
  const browser = await launchChromium(debugPort);
  const shots = [];
  let cdp = null;

  try {
    cdp = await connectToPage(debugPort);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });

    /* ------------------------------------------ single-user, accounts disabled */
    await postProgress(portDisabled, null, LEGACY_MARKER);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portDisabled}/` });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot (accounts off)');
    const title = await cdp.evaluate(`return document.getElementById('view-title').textContent`);
    const navCount = await cdp.evaluate(`return document.querySelectorAll('#nav .nav-item').length`);
    record('single-user-boots-unchanged-with-accounts-off', title === 'Übersicht' && navCount === 12, `title="${title}", #nav items=${navCount}`);
    await openView(cdp, 'notebook', 'Fehlerheft');
    record('single-user-record-still-shows-with-accounts-off', (await viewText(cdp)).includes(LEGACY_MARKER), 'the unscoped record is shown');

    /* ------------- TAB RETURN ON THE SINGLE-USER PATH (SESSION-BOUNDARY-02 F3) */
    // Another browser saves a newer single-user record; then this tab becomes visible again.
    // The app's own visibilitychange handler must re-check identity but must not reconcile
    // the record again or replace the in-memory state mid-session.
    const current = await (await fetch(`http://127.0.0.1:${portDisabled}/api/progress`)).json();
    await postProgress(portDisabled, null, NEWER_MARKER, current.rev);
    const sinceTabReturn = (await cdp.evaluate(`return window.__sb.length`));
    await cdp.evaluate(`document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState`);
    await sleep(2000);
    const tabReturn = (await cdp.evaluate(`return window.__sb`)).slice(sinceTabReturn).filter((e) => e.kind === 'request' && e.at === 'start');
    const reconciled = tabReturn.filter((e) => e.path === '/api/progress').map((e) => e.method);
    const adopted = await cdp.evaluate(`return import('/js/store.js').then((m) => JSON.stringify(m.getState()).includes(${JSON.stringify(NEWER_MARKER)}))`);
    record('single-user-tab-return-rechecks-identity', tabReturn.some((e) => e.path === '/api/v1/account'), `requests: ${tabReturn.map((e) => `${e.method} ${e.path}`).join(', ')}`);
    record('single-user-tab-return-does-not-replace-the-record', reconciled.length === 0 && !adopted, `/api/progress on tab return: [${reconciled.join(', ')}], newer record adopted: ${adopted}`);

    /* ---------------------------------------------- accounts on: sign in as A */
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portAccounts}/` });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot (accounts on)');
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('#account-signup-form')`, 15000, 'sign-up form');
    await cdp.evaluate(`
      document.querySelector('#signup-name').value = ${JSON.stringify(A.name)};
      document.querySelector('#signup-email').value = ${JSON.stringify(A.email)};
      document.querySelector('#signup-password').value = ${JSON.stringify(A.password)};
      document.querySelector('[data-signup]').click(); return true;`);
    await cdp.waitFor(`!!document.querySelector('[data-account-email]')`, 15000, 'signed in as A');
    const accountId = synthetic.idOf(A.email);
    // The single-user record was synced into this origin before sign-up (never signed in);
    // the new account must not adopt it (issue #63: no automatic assignment).
    const scopedCopy = await cdp.evaluate(`return localStorage.getItem(${JSON.stringify(`b1prep.state.v1::${accountId}`)}) || ''`);
    record('a-new-account-does-not-inherit-the-single-user-record', !scopedCopy.includes(LEGACY_MARKER), `account cache holds the single-user marker: ${scopedCopy.includes(LEGACY_MARKER)}`);
    // A's saved work lives on the server, as it would after studying on another device.
    await postProgress(portAccounts, accountId, A.marker);

    /* --------------------------------------------------------------- ORDER */
    await cdp.send('Page.reload', {});
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'reload as A');
    const log = await cdp.evaluate(`return window.__sb`);
    const answered = log.findIndex((e) => e.kind === 'request' && e.at === 'end' && e.path === '/api/v1/account');
    const firstRead = log.findIndex((e) => e.kind === 'read' && e.key.startsWith('b1prep.state.v1'));
    const firstProgress = log.findIndex((e) => e.kind === 'request' && e.path === '/api/progress');
    record('order-identity-answers-before-any-learner-record-is-read', answered >= 0 && firstRead > answered, `account answered at #${answered}, first record read at #${firstRead}`);
    record('order-identity-answers-before-any-progress-request', answered >= 0 && firstProgress > answered && log[firstProgress].scope === accountId, `account answered at #${answered}, first /api/progress at #${firstProgress} scope=${log[firstProgress]?.scope === accountId ? 'A' : log[firstProgress]?.scope}`);
    await openView(cdp, 'notebook', 'Fehlerheft');
    const signedInNotebook = await viewText(cdp);
    record('signed-in-page-opens-on-the-accounts-own-record', signedInNotebook.includes(A.marker) && !signedInNotebook.includes(LEGACY_MARKER), `A marker shown: ${signedInNotebook.includes(A.marker)}, legacy shown: ${signedInNotebook.includes(LEGACY_MARKER)}`);
    record('notebook-badge-counts-the-accounts-entry', (await badge(cdp)) === '1', `badge="${await badge(cdp)}"`);
    shots.push(await screenshot(cdp, 'desktop-notebook-signed-in.png'));

    /* ------------------------------------------------------------ SIGN-OUT */
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('[data-signout]')`, 15000, 'sign-out button');
    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form') && !document.querySelector('[data-account-email]')`, 15000, 'signed out');
    record('sign-out-badge-is-cleared', (await badge(cdp)) === '', `badge="${await badge(cdp)}"`);
    await openView(cdp, 'notebook', 'Fehlerheft');
    const afterSignOut = await viewText(cdp);
    record('sign-out-clears-the-visible-notebook', !afterSignOut.includes(A.marker) && !afterSignOut.includes(LEGACY_MARKER), `A marker shown: ${afterSignOut.includes(A.marker)}`);
    shots.push(await screenshot(cdp, 'desktop-notebook-signed-out.png'));
    await openView(cdp, 'home', 'Übersicht');
    record('sign-out-confirmed-save-leaves-no-account-text-in-storage', !(await storageHas(cdp, A.marker)), 'final save reached the server; localStorage scanned for the account marker');

    /* --------------------------------------------- LATE RESPONSE AFTER SIGN-OUT */
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 15000, 'sign-in form');
    enabled.holdNext((req) => req.method === 'GET' && req.url.startsWith('/api/progress') && req.headers['x-b1prep-account'] === accountId);
    await cdp.evaluate(`
      document.querySelector('#signin-email').value = ${JSON.stringify(A.email)};
      document.querySelector('#signin-password').value = ${JSON.stringify(A.password)};
      document.querySelector('[data-signin]').click(); return true;`);
    const deadline = Date.now() + 15000;
    while (!enabled.gate.reached && Date.now() < deadline) await sleep(100);
    record('late-response-scenario-holds-the-accounts-progress-read', enabled.gate.reached === true, 'A progress GET is in flight');
    // The page signs out while A's record is still on the wire - the same call the Konto button makes.
    await cdp.evaluate(`return import('/js/account.js').then((m) => m.session().signOut()).then(() => true)`);
    enabled.gate.release?.();
    await sleep(1500);
    const kontoAfterLate = await cdp.evaluate(`return { signedIn: !!document.querySelector('[data-account-email]'), form: !!document.querySelector('#account-signin-form') }`);
    record('late-response-does-not-repaint-a-signed-in-konto', !kontoAfterLate.signedIn && kontoAfterLate.form, JSON.stringify(kontoAfterLate));
    record('late-response-does-not-repaint-the-badge', (await badge(cdp)) === '', `badge="${await badge(cdp)}"`);
    await openView(cdp, 'notebook', 'Fehlerheft');
    const afterLate = await viewText(cdp);
    record('late-response-does-not-repaint-the-notebook', !afterLate.includes(A.marker), `A marker shown: ${afterLate.includes(A.marker)}`);
    record('late-response-does-not-reach-storage', !(await storageHas(cdp, A.marker)), 'localStorage scanned after the late answer');

    /* ------- SIGN-OUT WHEN THE FINAL SAVE DOES NOT LAND (SESSION-BOUNDARY-02 F1) */
    // The confirmed branch is above. These are the two ordinary branches it does not cover:
    // the final save held past the sign-out budget, and a sign-out while offline. The account
    // copy must be gone from localStorage either way, and the learner must be told.
    await signInThroughKonto(cdp, A);
    await cdp.waitFor(storageHasExpr(A.marker), 15000, 'A copy back in localStorage (held-save precondition)');
    record('held-save-precondition-the-account-copy-is-in-storage', await storageHas(cdp, A.marker), 'signed in as A, record synced');
    await saveSettled(cdp); // so the held POST is the sign-out's own final save, not a queued one
    enabled.holdNext((req) => req.method === 'POST' && req.url.startsWith('/api/progress') && req.headers['x-b1prep-account'] === accountId);
    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 20000, 'signed out with the save held');
    const heldReached = enabled.gate.reached === true;
    record('held-save-sign-out-leaves-no-account-text-in-storage', heldReached && !(await storageHas(cdp, A.marker)), `final save held: ${heldReached}; localStorage scanned`);
    const heldNotice = await cdp.evaluate(`const e = document.querySelector('[data-account-error]'); return e && !e.hidden ? e.textContent : ''`);
    record('held-save-sign-out-tells-the-learner', heldNotice.includes('nicht erreicht'), `notice="${heldNotice.slice(0, 80)}"`);
    enabled.gate.release?.();
    await sleep(1500);
    record('held-save-still-no-account-text-after-the-answer-lands', !(await storageHas(cdp, A.marker)), 'localStorage scanned after the held answer');

    await signInThroughKonto(cdp, A);
    await cdp.waitFor(storageHasExpr(A.marker), 15000, 'A copy back in localStorage (offline precondition)');
    record('offline-precondition-the-account-copy-is-in-storage', await storageHas(cdp, A.marker), 'signed in as A, record synced');
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 20000, 'signed out offline');
    record('offline-sign-out-leaves-no-account-text-in-storage', !(await storageHas(cdp, A.marker)), 'localStorage scanned while still offline');
    const offlineNotice = await cdp.evaluate(`const e = document.querySelector('[data-account-error]'); return e && !e.hidden ? e.textContent : ''`);
    record('offline-sign-out-tells-the-learner', offlineNotice.includes('nicht erreicht'), `notice="${offlineNotice.slice(0, 80)}"`);
    shots.push(await screenshot(cdp, 'desktop-konto-signed-out-offline.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const phoneNotice = await cdp.evaluate(`return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }`);
    record('offline-sign-out-notice-no-overflow-at-390', phoneNotice.scrollWidth <= phoneNotice.clientWidth + 8, `scrollWidth ${phoneNotice.scrollWidth} vs clientWidth ${phoneNotice.clientWidth}`);
    shots.push(await screenshot(cdp, 'phone-konto-signed-out-offline.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.send('Network.disable');
    // The server never heard that sign-out, and the HttpOnly session cookie cannot be dropped
    // by the page, so back online the Konto resolves to A again. Sign out for real.
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('[data-signout]')`, 15000, 'A resolved again once online');
    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signup-form')`, 15000, 'signed out online');

    /* ------------------- LATE WRITING FEEDBACK (SESSION-BOUNDARY-02 F2) */
    // The writing view writes learner state after an AI round trip. With a stubbed provider,
    // its answer is held across a sign-out and across a switch; neither may land.
    let writingMarker = `${W_MARKER}-control`;
    stubWritingProvider(enabled, () => writingMarker);
    await signInThroughKonto(cdp, A);
    // Control: with nothing changing while it is held, the same stubbed grading DOES land -
    // so the checks below cannot pass merely because the stub or the view failed.
    const controlHeld = await startHeldWritingGrade(cdp, enabled, writingMarker);
    enabled.gate.release?.();
    await sleep(1500);
    const control = await writingTrace(cdp, writingMarker);
    record('late-writing-control-feedback-lands-when-nothing-changes', controlHeld && control.notebook && control.writingAttempts > 0, JSON.stringify(control));
    writingMarker = W_MARKER;
    record('late-writing-scenario-holds-the-grading-before-sign-out', await startHeldWritingGrade(cdp, enabled, W_MARKER), 'stubbed /api/ai answer held, A signed in');
    await cdp.evaluate(`return import('/js/account.js').then((m) => m.session().signOut()).then(() => true)`);
    enabled.gate.release?.();
    await sleep(1500);
    const afterSignOutWriting = await writingTrace(cdp, W_MARKER);
    record('late-writing-feedback-puts-no-text-in-the-notebook-after-sign-out', !afterSignOutWriting.notebook, JSON.stringify(afterSignOutWriting));
    record('late-writing-feedback-records-no-attempt-after-sign-out', afterSignOutWriting.writingAttempts === 0, JSON.stringify(afterSignOutWriting));
    await openView(cdp, 'notebook', 'Fehlerheft');
    record('late-writing-feedback-is-not-painted-in-the-signed-out-notebook', !(await viewText(cdp)).includes(W_MARKER), 'notebook view text scanned');
    // Defence in depth: the store itself refuses a notebook entry on a signed-out page.
    const refused = await cdp.evaluate(`return import('/js/store.js').then((m) => { m.addError({ prompt: ${JSON.stringify(`${W_MARKER}-direct`)}, source: 'writing' }); return m.listErrors({ includeResolved: true }).length; })`);
    record('a-signed-out-page-refuses-a-notebook-entry', refused === 0, `notebook entries after a direct addError: ${refused}`);

    await signInThroughKonto(cdp, A);
    record('late-writing-scenario-holds-the-grading-before-a-switch', await startHeldWritingGrade(cdp, enabled, W_MARKER), 'stubbed /api/ai answer held, A signed in');
    // The switch: B signs up on the same page while A's grading is still on the wire.
    await cdp.evaluate(`return import('/js/account.js').then((m) => m.session().signUp({ name: 'SYNTHETIC B', email: ${JSON.stringify(B.email)}, password: ${JSON.stringify(B.password)} })).then(() => true)`);
    enabled.gate.release?.();
    await sleep(1500);
    const afterSwitchWriting = await writingTrace(cdp, W_MARKER);
    const nowB = await cdp.evaluate(`return import('/js/store.js').then((m) => m.getAccountScope().accountId)`);
    record('late-writing-feedback-for-a-does-not-land-in-b', nowB === synthetic.idOf(B.email) && !afterSwitchWriting.notebook && afterSwitchWriting.writingAttempts === 0, `scope is B: ${nowB === synthetic.idOf(B.email)}; ${JSON.stringify(afterSwitchWriting)}`);
    await saveSettled(cdp);
    record('late-writing-feedback-for-a-does-not-reach-storage', !(await storageHas(cdp, W_MARKER)), 'localStorage scanned after the switch');
    enabled.clearStubs();
    await cdp.evaluate(`return import('/js/ai.js').then((m) => m.refreshStatus()).then(() => true)`);
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('[data-signout]')`, 15000, 'sign-out (B)');
    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signup-form')`, 15000, 'signed out (B)');

    /* ------------------------- the single-user exam date never reaches an account */
    const sharedDate = '2030-05-05';
    const configured = await fetch(`http://127.0.0.1:${portAccounts}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${portAccounts}` }, body: JSON.stringify({ examDate: sharedDate }),
    });
    record('shared-exam-date-scenario-is-set-on-the-server', configured.ok, `POST /api/config -> ${configured.status}`);
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('#account-signup-form')`, 15000, 'sign-up form (C)');
    await cdp.evaluate(`
      document.querySelector('#signup-name').value = 'SYNTHETIC C';
      document.querySelector('#signup-email').value = ${JSON.stringify(`synthetic.sb-c.${RUN}@example.invalid`)};
      document.querySelector('#signup-password').value = 'synthetic-pass-c-123';
      document.querySelector('[data-signup]').click(); return true;`);
    await cdp.waitFor(`!!document.querySelector('[data-account-email]')`, 15000, 'signed in as C');
    await cdp.send('Page.reload', {});
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'reload as C');
    const examDateC = await cdp.evaluate(`return import('/js/store.js').then((m) => m.getState().settings.examDate)`);
    record('an-account-does-not-inherit-the-single-user-exam-date', examDateC !== sharedDate, `account exam date="${examDateC}"`);
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('[data-signout]')`, 15000, 'sign-out (C)');
    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 15000, 'signed out (C)');

    /* ------- N-1: ANOTHER TAB OF THE SAME BROWSER AFTER A SIGN-OUT (SESSION-BOUNDARY-04) */
    // The review's S17 and S7b, with two REAL pages of one browser profile: one cookie jar, one
    // localStorage. Tab 1 signs out and forgets; tab 2 still holds A's record in memory. Before
    // the fix, tab 2's ordinary write path re-created A's key with A's text in it, and tab 2
    // went on showing A's notebook.
    const accountKey = `b1prep.state.v1::${accountId}`;
    const bId = synthetic.idOf(B.email);
    const NEXT_MARKER = `SYNTH-SB-NEXT-${RUN}`;
    await signInThroughKonto(cdp, A);
    await cdp.waitFor(storageHasExpr(A.marker), 15000, 'A copy in localStorage (N-1 precondition)');
    const tab2 = await openSecondTab(debugPort, `http://127.0.0.1:${portAccounts}/`);
    try {
      await tab2.waitFor(`!!document.querySelector('#view .card')`, 20000, 'tab 2 boot');
      await tab2.waitFor(`import('/js/store.js').then((m) => m.getAccountScope().accountId === ${JSON.stringify(accountId)})`, 15000, 'tab 2 resolved as A');
      await openView(tab2, 'notebook', 'Fehlerheft');
      const tab2Before = await viewText(tab2);
      record('n1-precondition-a-second-real-tab-shows-the-accounts-notebook', tab2Before.includes(A.marker), `tab 2 notebook shows A: ${tab2Before.includes(A.marker)}`);
      await saveSettled(cdp);
      await saveSettled(tab2);

      // S17: tab 1 signs out through the Konto button. Then tab 2 records an answer and
      // flushes - what its next learner action and its visibilitychange/pagehide handler do.
      await openView(cdp, 'account', 'Konto');
      await cdp.click('[data-signout]');
      await cdp.waitFor(`!!document.querySelector('#account-signin-form') && !document.querySelector('[data-account-email]')`, 15000, 'tab 1 signed out');
      const rightAfter = await accountKeysHolding(cdp, A.marker);
      await recordMarkedAttempt(tab2, `${A.marker}-TAB2`);
      await tab2.evaluate(`return import('/js/store.js').then((m) => { m.saveNow(); m.flushNow(); return true; })`);
      await sleep(1500);
      const afterTab2 = await accountKeysHolding(cdp, A.marker);
      record('n1-s17-the-second-tab-does-not-re-create-the-account-record', rightAfter.length === 0 && afterTab2.length === 0, `account keys holding A's text right after the sign-out: [${rightAfter}]; after tab 2 wrote: [${afterTab2}]`);
      record('n1-s17-no-account-text-anywhere-in-storage', !(await storageHas(cdp, A.marker)), 'every localStorage key scanned for A\'s marker');

      // The other half: tab 2 must not go on DISPLAYING A's data. Read what is on screen
      // without navigating, then the store and the Konto view.
      const tab2Scope = await scopeOf(tab2);
      record('n1-the-second-tab-goes-to-the-signed-out-state', tab2Scope.mode === 'signed-out' && tab2Scope.accountId === null, JSON.stringify(tab2Scope));
      const tab2Screen = await viewText(tab2);
      record('n1-the-second-tab-no-longer-shows-the-accounts-notebook', !tab2Screen.includes(A.marker), `A marker on tab 2's screen: ${tab2Screen.includes(A.marker)}`);
      record('n1-the-second-tab-badge-is-cleared', (await badge(tab2)) === '', `badge="${await badge(tab2)}"`);
      await openView(tab2, 'account', 'Konto');
      await sleep(500);
      const tab2Konto = await tab2.evaluate(`return { signedIn: !!document.querySelector('[data-account-email]'), form: !!document.querySelector('#account-signin-form') }`);
      record('n1-the-second-tab-konto-is-signed-out', !tab2Konto.signedIn && tab2Konto.form, JSON.stringify(tab2Konto));

      // S7b: tab 2 holds A again, and its 250 ms local save is still QUEUED when tab 1 signs out.
      await signInThroughKonto(cdp, A);
      await tab2.send('Page.reload', {});
      await tab2.waitFor(`!!document.querySelector('#view .card')`, 20000, 'tab 2 reload');
      await tab2.waitFor(`import('/js/store.js').then((m) => m.getAccountScope().accountId === ${JSON.stringify(accountId)})`, 15000, 'tab 2 resolved as A again');
      await saveSettled(cdp);
      await saveSettled(tab2);
      const queuedAt = await recordMarkedAttempt(tab2, `${A.marker}-QUEUED`);
      const forgotAt = await cdp.evaluate(`return import('/js/account.js').then((m) => m.session().signOut()).then(() => Date.now())`);
      await sleep(2000);
      const afterQueued = await accountKeysHolding(cdp, A.marker);
      record('n1-s7b-a-queued-save-in-the-second-tab-does-not-re-create-the-account-record', forgotAt - queuedAt < 250 && afterQueued.length === 0, `sign-out finished ${forgotAt - queuedAt} ms after tab 2 queued its 250 ms save; account keys holding A's text afterwards: [${afterQueued}]`);
      record('n1-s7b-the-second-tab-is-signed-out', (await scopeOf(tab2)).mode === 'signed-out', JSON.stringify(await scopeOf(tab2)));

      // THE CONTROL THAT MATTERS MOST: after those forgets, a fresh sign-in must still SAVE -
      // locally and to the server. A fix that blocks every write is worse than the bug.
      await signInThroughKonto(cdp, A);
      await recordMarkedAttempt(cdp, `${NEXT_MARKER}-A`);
      const savedA = await cdp.evaluate(`return import('/js/store.js').then((m) => m.flushNow())`);
      const localA = await accountKeysHolding(cdp, `${NEXT_MARKER}-A`);
      const serverA = await (await fetch(`http://127.0.0.1:${portAccounts}/api/progress`, { headers: { 'x-b1prep-account': accountId } })).text();
      record('n1-control-a-sign-in-after-the-forget-saves-locally-and-to-the-server', savedA === true && localA.length === 1 && localA[0] === accountKey && serverA.includes(`${NEXT_MARKER}-A`), `flushNow=${savedA}; local keys: [${localA}]; server record holds it: ${serverA.includes(`${NEXT_MARKER}-A`)}`);

      // The next learner, in the tab that only HEARD about the sign-out: B signs in on tab 2.
      // Tab 1 is A, with one more answer of A's still queued as that happens.
      // Through the boundary's own signIn (what the Konto form calls), so the step does not
      // depend on which phase tab 2 is showing.
      await recordMarkedAttempt(cdp, `${A.marker}-LATE`);
      await tab2.evaluate(`return import('/js/account.js').then((m) => m.session().signIn({ email: ${JSON.stringify(B.email)}, password: ${JSON.stringify(B.password)} })).then((r) => r.phase)`);
      await recordMarkedAttempt(tab2, `${NEXT_MARKER}-B`);
      const savedB = await tab2.evaluate(`return import('/js/store.js').then((m) => m.flushNow())`);
      const localB = await accountKeysHolding(tab2, `${NEXT_MARKER}-B`);
      const serverB = await (await fetch(`http://127.0.0.1:${portAccounts}/api/progress`, { headers: { 'x-b1prep-account': bId } })).text();
      record('n1-control-the-next-learner-in-the-other-tab-saves-locally-and-to-the-server', savedB === true && localB.length === 1 && localB[0] === `b1prep.state.v1::${bId}` && serverB.includes(`${NEXT_MARKER}-B`), `flushNow=${savedB}; local keys: [${localB}]; server record holds it: ${serverB.includes(`${NEXT_MARKER}-B`)}`);

      // That sign-in switched the browser to B, so tab 1 (still A in memory, A's answer queued)
      // must leave A too, and A's text must not come back under any key.
      await cdp.waitFor(`import('/js/store.js').then((m) => m.getAccountScope().accountId !== ${JSON.stringify(accountId)})`, 8000, 'tab 1 leaves A').catch(() => false);
      await sleep(1500);
      const tab1After = await scopeOf(cdp);
      const aKeys = await accountKeysHolding(cdp, A.marker);
      const aSecondKeys = await accountKeysHolding(cdp, `${NEXT_MARKER}-A`);
      record('n1-a-switch-in-the-other-tab-the-first-tab-leaves-the-previous-account', tab1After.accountId === bId && aKeys.length === 0 && aSecondKeys.length === 0, `tab 1 scope ${JSON.stringify(tab1After)}; keys holding A's text: [${[...aKeys, ...aSecondKeys]}]`);

      // B signs out on tab 2; tab 1 must not put B's text back either.
      await openView(tab2, 'account', 'Konto');
      await tab2.click('[data-signout]');
      await tab2.waitFor(`!!document.querySelector('#account-signin-form')`, 15000, 'tab 2 signed out (B)');
      await recordMarkedAttempt(cdp, `${NEXT_MARKER}-B-LATE`);
      await cdp.evaluate(`return import('/js/store.js').then((m) => { m.flushNow(); return true; })`);
      await sleep(1500);
      const bKeys = await accountKeysHolding(cdp, NEXT_MARKER);
      record('n1-the-reverse-direction-tab-1-does-not-re-create-the-next-learners-record', bKeys.length === 0 && (await scopeOf(cdp)).mode === 'signed-out', `keys holding B's text: [${bKeys}]; tab 1 scope ${JSON.stringify(await scopeOf(cdp))}`);
      const tab2Errors = tab2.consoleErrors();
      record('n1-no-console-errors-in-the-second-tab', tab2Errors.length === 0, tab2Errors.slice(0, 2).join(' | ') || 'clean');
    } finally {
      await tab2.close();
    }
    await openView(cdp, 'account', 'Konto');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 15000, 'signed out after N-1');

    /* ------------------------------------------------------- phone evidence */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await openView(cdp, 'account', 'Konto');
    await sleep(300);
    const phone = await cdp.evaluate(`return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }`);
    record('konto-no-overflow-at-390', phone.scrollWidth <= phone.clientWidth + 8, `scrollWidth ${phone.scrollWidth} vs clientWidth ${phone.clientWidth}`);
    shots.push(await screenshot(cdp, 'phone-konto-signed-out.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    shots.push(await screenshot(cdp, 'desktop-konto-signed-out.png'));

    /* --- F-C: A BROWSER THAT NEVER SIGNED IN KEEPS ITS RECORD ON A 500 (SESSION-FENCE-02) --- */
    // The reviewer's F-C: a browser with NO account history that gets a 500 (or a malformed body)
    // from /api/v1/account was moved to signed-out permanently. Its single-user record stayed on
    // disk but was never shown again - not even after a reload - and signing up did not restore
    // it. The fix is a coordinator product decision: a browser with no account history is never
    // failed closed, because the local single-user learner is the population that cannot recover.
    // The origin is cleared first so the page really starts with no account marker (`legacy`).
    const FC_MARKER = `SYNTH-SB-FC-${RUN}`;
    await cdp.evaluate(`localStorage.clear(); return true`);
    await cdp.send('Page.reload', {});
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot (F-C, cleared browser)');
    await cdp.waitFor(`import('/js/store.js').then((m) => m.getAccountScope().mode === 'legacy')`, 15000, 'F-C precondition: no account marker');
    const fcPhase = await cdp.evaluate(`return import('/js/account.js').then((m) => m.session().phase)`);
    record('f-c-precondition-the-browser-never-signed-in', (await scopeOf(cdp)).mode === 'legacy' && fcPhase === 'single-user', `scope mode=legacy, boundary phase=${fcPhase}`);
    await recordMarkedAttempt(cdp, FC_MARKER);
    await cdp.evaluate(`return import('/js/store.js').then((m) => m.flushNow())`);
    await openView(cdp, 'notebook', 'Fehlerheft');
    record('f-c-precondition-the-local-record-is-shown', (await viewText(cdp)).includes(FC_MARKER), 'the single-user notebook shows its own entry');
    // A transient deploy failure: the account endpoint answers 500 (mapped to `server_error`).
    enabled.stub((req) => req.method === 'GET' && new URL(req.url, 'http://x').pathname === '/api/v1/account',
      (req, res) => reply(res, 500, { error: 'internal_error' }));
    await cdp.send('Page.reload', {});
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot (F-C, account endpoint 500)');
    await openView(cdp, 'notebook', 'Fehlerheft');
    const fcNotebook = await viewText(cdp);
    record('f-c-a-500-does-not-hide-the-never-signed-in-record', fcNotebook.includes(FC_MARKER), `the notebook shows the entry after a 500: ${fcNotebook.includes(FC_MARKER)}`);
    record('f-c-a-500-does-not-move-the-browser-to-signed-out', (await scopeOf(cdp)).mode === 'legacy', `scope mode: ${(await scopeOf(cdp)).mode}`);
    record('f-c-the-record-is-still-in-storage', await storageHas(cdp, FC_MARKER), 'localStorage scanned for the marker after a 500');
    enabled.clearStubs();

    const errors = cdp.consoleErrors();
    record('no-console-errors-during-the-run', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');
    console.log(`\nScreenshots: ${shots.join(', ')}`);
  } finally {
    enabled.gate.release?.();
    if (!keep) {
      await disabled.cleanup();
      await enabled.cleanup();
      await browser.cleanup();
      fs.rmSync(checkout.dest, { recursive: true, force: true });
    } else {
      console.log(`Kept disposable copy at ${checkout.dest}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log('NOTE  headless Chromium, emulated viewports: no real phone, keyboard or audio was exercised.');
  console.log('NOTE  synthetic in-process account store; no PostgreSQL, no Better Auth, no provider call.');
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)).catch((err) => {
  console.error(`FAIL  ${err.message}`);
  return 1;
}));
