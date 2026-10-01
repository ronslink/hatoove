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
 *     localStorage holds none of its text;
 *   * NO LATE REPAINT: a progress response for the account that arrives AFTER the page signed
 *     out does not repaint the account's work (view, badge, Konto state or storage);
 *   * the single-user path is unchanged with accounts disabled (the record shows, 12 views);
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

import { connectToPage, sleep } from './cdp.js';

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
const LEGACY_MARKER = `SYNTH-SB-LEGACY-${RUN}`;

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
  server.on('request', (req, res) => {
    const pass = () => { for (const handler of handlers) handler.call(server, req, res); };
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

async function postProgress(port, accountId, marker) {
  const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` };
  if (accountId) headers['x-b1prep-account'] = accountId;
  const state = {
    version: 1, createdAt: 1, updatedAt: Date.now(), settings: {},
    nodes: { 'skill:SB1': { theta: 40, n: 1, correct: 0, last: Date.now(), streak: 0 } },
    history: [{ t: Date.now(), partId: 'SB1', tags: [], difficulty: 50, correct: false, source: 'drill', ms: 0, itemRef: null }],
    errors: [{ id: `e-${RUN}`, t: Date.now(), partId: 'SB1', tags: [], difficulty: 50, prompt: marker, yourAnswer: 'x', correctAnswer: 'y', explanation: '', reviewed: 0, resolved: false, source: 'drill' }],
    srs: {}, days: {}, planDone: {}, counters: { attempts: 1, correct: 0, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
  const response = await fetch(`http://127.0.0.1:${port}/api/progress`, { method: 'POST', headers, body: JSON.stringify({ state, rev: 0 }) });
  if (!response.ok) throw new Error(`seeding progress failed: HTTP ${response.status}`);
}

const viewText = (cdp) => cdp.evaluate(`return document.getElementById('view').innerText`);
const badge = (cdp) => cdp.evaluate(`return (document.querySelector('[data-badge="notebook"]') || {}).textContent || ''`);
const storageHas = (cdp, text) => cdp.evaluate(`
  for (let i = 0; i < localStorage.length; i++) { if ((localStorage.getItem(localStorage.key(i)) || '').includes(${JSON.stringify(text)})) return true; }
  return false;`);

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
    record('sign-out-leaves-no-account-text-in-storage', !(await storageHas(cdp, A.marker)), 'localStorage scanned for the account marker');

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

    /* ------------------------------------------------------- phone evidence */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await openView(cdp, 'account', 'Konto');
    await sleep(300);
    const phone = await cdp.evaluate(`return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }`);
    record('konto-no-overflow-at-390', phone.scrollWidth <= phone.clientWidth + 8, `scrollWidth ${phone.scrollWidth} vs clientWidth ${phone.clientWidth}`);
    shots.push(await screenshot(cdp, 'phone-konto-signed-out.png'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    shots.push(await screenshot(cdp, 'desktop-konto-signed-out.png'));

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
