/**
 * Headless-browser evidence for the Konto surface (ACCOUNT-UI-01).
 *
 * What it proves in a real headless Chromium page, served over real HTTP:
 *   * with accounts disabled, the app boots and the existing views (Übersicht, Lernplan,
 *     Einstellungen) still render, and the Konto page honestly says accounts are not
 *     activated instead of showing a broken or fake form;
 *   * with a synthetic account store mounted, signing up creates the account, the view then
 *     shows the account's e-mail and hides the forms, and signing out returns the view to
 *     the signed-out forms;
 *   * a REFUSED sign-in (wrong password) shows an error and does NOT show a signed-in state;
 *   * no console errors occur, and neither the Konto page nor the dashboard overflows
 *     horizontally at 390 px or 1440 px.
 *
 * Why the servers are started in-process rather than by spawning `server.js`: the Konto
 * page needs a same-origin account endpoint, and the entire point is that the browser
 * check must not require PostgreSQL (B1PREP_ACCOUNTS=1 needs a database). `createServer`
 * from the disposable copy is mounted with a synthetic owned API that speaks the same
 * `/api/auth/*` and `/api/v1/*` contract the real mount does, so the real client, the real
 * DOM and the real HTTP layer are exercised - only the account store is synthetic.
 *
 * Safety:
 *   * It materialises its OWN disposable source-only copy (no .env, no learner progress,
 *     no .git, no node_modules), and refuses the live ports.
 *   * B1PREP_FORCE_OFFLINE=1; the throwaway env file holds no provider key; nothing is
 *     sent anywhere. Everything is synthetic and marked as such.
 *   * It is browser evidence only: headless Chromium with emulated viewports. No real
 *     phone, hardware keyboard, camera or audio path was exercised, and this is NOT the
 *     Better Auth implementation behind production.
 *
 * Usage: node tools/account-ui-browser-check.mjs [--port 4331] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectToPage, sleep } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PORTS = new Set([4321, 4381]);
const SHOTS = path.join(ROOT, '.openclaw', 'tmp', 'account-ui');
const SYNTHETIC = Object.freeze({
  name: 'SYNTHETIC Learner (account-ui check)',
  email: 'synthetic.account-ui@example.invalid',
  password: 'synthetic-pass-123',
  wrongPassword: 'synthetic-wrong-pass',
});

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
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
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  throw new Error('No Chromium found; set CHROME_PATH to a headless-capable browser.');
}

/** Copy the source tree without git metadata, learner data, secrets or build output. */
function materializeSourceCheckout() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-account-ui-'));
  const skip = new Set(['.git', '.openclaw', 'node_modules', 'portable']);
  const skipNames = new Set(['.env', 'progress.json']);
  fs.cpSync(ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (skip.has(top)) return false;
      if (skipNames.has(path.basename(src))) return false;
      return true;
    },
  });
  const work = path.join(dest, '.openclaw', 'tmp');
  fs.mkdirSync(work, { recursive: true });
  const envPath = path.join(work, 'test.env');
  const progressPath = path.join(work, 'progress.json');
  fs.writeFileSync(envPath, '# isolated browser-check env: deliberately no provider key\n', 'utf8');
  fs.writeFileSync(progressPath, '{}\n', 'utf8');
  return { dest, envPath, progressPath };
}

/* --------------------------------------------------- synthetic account store */

const readRequestBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return resolve({});
    try { resolve(JSON.parse(text)); } catch { resolve(null); }
  });
  req.on('error', reject);
});

const reply = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
};

const errorReply = (res, status, code) => reply(res, status, { error: code });

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

/** An in-memory `/api/auth/*` + `/api/v1/account` handler with the real mount's contract. */
function createSyntheticOwnedApi() {
  const accounts = new Map(); // email -> { id, name, email, password }
  const sessions = new Map(); // token -> account id
  const COOKIE = 'b1prep_synthetic_session';

  const byId = (id) => [...accounts.values()].find((a) => a.id === id) || null;
  const currentAccount = (req) => {
    const token = parseCookie(req.headers.cookie, COOKIE);
    if (!token) return null;
    const id = sessions.get(token);
    return id ? byId(id) : null;
  };
  const issueSession = (res, account) => {
    const token = crypto.randomUUID();
    sessions.set(token, account.id);
    reply(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` });
  };

  async function handleNode(req, res) {
    const pathname = (() => {
      try { return new URL(req.url, 'http://127.0.0.1').pathname; } catch { return '/'; }
    })();
    const method = req.method || 'GET';
    const body = method === 'GET' || method === 'HEAD' ? {} : await readRequestBody(req);
    if (body === null) return errorReply(res, 400, 'invalid_request');

    if (method === 'POST' && pathname === '/api/auth/sign-up/email') {
      const { name, email, password } = body;
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        return errorReply(res, 400, 'invalid_request');
      }
      if (accounts.has(email)) return errorReply(res, 409, 'user_exists');
      const account = { id: crypto.randomUUID(), name, email, password };
      accounts.set(email, account);
      return issueSession(res, account);
    }

    if (method === 'POST' && pathname === '/api/auth/sign-in/email') {
      const { email, password } = body;
      const account = typeof email === 'string' ? accounts.get(email) : null;
      if (!account || account.password !== password) return errorReply(res, 401, 'invalid_credentials');
      return issueSession(res, account);
    }

    if (method === 'POST' && pathname === '/api/auth/sign-out') {
      const token = parseCookie(req.headers.cookie, COOKIE);
      if (token) sessions.delete(token);
      return reply(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
    }

    if (method === 'GET' && pathname === '/api/v1/account') {
      const account = currentAccount(req);
      if (!account) return errorReply(res, 401, 'unauthenticated');
      return reply(res, 200, { contractVersion: '0.1.0', id: account.id, email: account.email });
    }

    return errorReply(res, 404, 'not_found');
  }

  const matches = (pathname) => pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/');
  return Object.freeze({
    handleNode,
    matches,
    accountCount: () => accounts.size,
    hasAccount: (email) => accounts.has(email),
  });
}

/* ---------------------------------------------------------------- servers */

async function startInProcessServer({ copyRoot, port, ownedApi }) {
  const mod = await import(pathToFileURL(path.join(copyRoot, 'server.js')).href);
  const server = mod.createServer({ ownedApi });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const cleanup = () => new Promise((resolve) => server.close(() => resolve()));
  return { server, cleanup };
}

async function launchChromium(debugPort) {
  const browser = findChromium();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-account-ui-prof-'));
  const proc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = async () => {
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { proc, cleanup };
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  return path.join(SHOTS, name);
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const value = index === -1 ? '4331' : argv[index + 1];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65533) throw new Error(`invalid --port ${value}`);
  for (const p of [port, port + 1, port + 2]) {
    if (FORBIDDEN_PORTS.has(p)) throw new Error(`port ${p} is a live learner port; pick an isolated one`);
  }
  return port;
}

const overflow = async (cdp) => cdp.evaluate(`
  return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
`);

/** Wait for a condition, returning false instead of aborting, so both failure checks report. */
async function waitForOk(cdp, expression, timeoutMs) {
  try {
    await cdp.waitFor(expression, timeoutMs, expression);
    return true;
  } catch {
    return false;
  }
}

async function main(argv) {
  const portDisabled = parsePort(argv);
  const debugPort = portDisabled + 1;
  const portAccounts = portDisabled + 2;
  const keep = argv.includes('--keep');

  const checkout = materializeSourceCheckout();
  // B1PREP_ENV_FILE / B1PREP_PROGRESS_FILE are read when server.js is imported, so the env
  // must be set before the dynamic import below - never the learner's real .env or record.
  process.env.B1PREP_ENV_FILE = checkout.envPath;
  process.env.B1PREP_PROGRESS_FILE = checkout.progressPath;
  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ACCOUNTS = '0';

  const disabled = await startInProcessServer({ copyRoot: checkout.dest, port: portDisabled, ownedApi: null });
  const synthetic = createSyntheticOwnedApi();
  const enabled = await startInProcessServer({ copyRoot: checkout.dest, port: portAccounts, ownedApi: synthetic });
  const browser = await launchChromium(debugPort);
  let cdp = null;

  try {
    cdp = await connectToPage(debugPort);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });

    /* ---------------------------------------------- accounts disabled */
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portDisabled}/` });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot');
    const title = await cdp.evaluate(`return document.getElementById('view-title').textContent`);
    record('app-boots-with-accounts-disabled', title === 'Übersicht', `title="${title}"`);

    await cdp.click('[data-view="plan"]');
    await cdp.waitFor(`document.getElementById('view-title').textContent === 'Lernplan' && !!document.querySelector('#view .card')`, 15000, 'Lernplan');
    record('existing-view-lernplan-still-renders-accounts-disabled', true, 'Lernplan rendered');

    await cdp.click('[data-view="settings"]');
    await cdp.waitFor(`document.getElementById('view-title').textContent === 'Einstellungen' && !!document.querySelector('#view .card')`, 15000, 'Einstellungen');
    record('existing-view-einstellungen-still-renders-accounts-disabled', true, 'Einstellungen rendered');

    const navCount = await cdp.evaluate(`return document.querySelectorAll('#nav .nav-item').length`);
    record('legacy-navigation-still-has-its-12-views', navCount === 12, `#nav .nav-item = ${navCount}`);

    const accountEntry = await cdp.evaluate(`return !!document.querySelector('#account-nav [data-shell-view="account"]')`);
    record('konto-entry-is-reachable-from-the-navigation', accountEntry, 'sidebar Konto button present');
    await cdp.click('#account-nav [data-shell-view="account"]');
    await cdp.waitFor(`document.getElementById('view-title').textContent === 'Konto'`, 15000, 'Konto view');
    await cdp.waitFor(`/nicht aktiviert/.test(document.getElementById('view').innerText)`, 15000, 'unavailable message');
    const disabledForms = await cdp.evaluate(`return !!document.querySelector('#account-signin-form')`);
    record('accounts-disabled-shows-honest-unavailable-state', true, 'Konto page says accounts are not activated');
    record('accounts-disabled-offers-no-fake-sign-in-form', !disabledForms, 'no sign-in form without a server endpoint');
    const navActive = await cdp.evaluate(`
      return {
        accountActive: !!document.querySelector('#account-nav [data-shell-view="account"].active'),
        staleNavActive: document.querySelector('#nav .nav-item.active')?.dataset.view || null,
      };
    `);
    record('konto-entry-is-marked-active-on-its-own', navActive.accountActive && navActive.staleNavActive === null, `accountActive=${navActive.accountActive}, stale=${navActive.staleNavActive}`);
    const disabledShot = await screenshot(cdp, 'desktop-konto-unavailable.png');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const disabledPhone = await overflow(cdp);
    record('accounts-disabled-konto-no-overflow-at-390', disabledPhone.scrollWidth <= disabledPhone.clientWidth + 8, `scrollWidth ${disabledPhone.scrollWidth} vs clientWidth ${disabledPhone.clientWidth}`);

    /* --------------------------------------- synthetic accounts enabled */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portAccounts}/` });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot (accounts)');
    await cdp.click('#account-nav [data-shell-view="account"]');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form')`, 15000, 'signed-out forms');
    const bothForms = await cdp.evaluate(`return !!document.querySelector('#account-signin-form') && !!document.querySelector('#account-signup-form')`);
    record('signed-out-shows-sign-in-and-sign-up-forms', bothForms, 'both forms rendered');
    const signedOutShot = await screenshot(cdp, 'desktop-konto-signedout.png');

    await cdp.evaluate(`
      document.querySelector('#signup-name').value = ${JSON.stringify(SYNTHETIC.name)};
      document.querySelector('#signup-email').value = ${JSON.stringify(SYNTHETIC.email)};
      document.querySelector('#signup-password').value = ${JSON.stringify(SYNTHETIC.password)};
      return true;
    `);
    await cdp.click('[data-signup]');
    await cdp.waitFor(`!!document.querySelector('[data-account-email]')`, 15000, 'signed in after sign-up');
    const shownEmail = await cdp.evaluate(`return document.querySelector('[data-account-email]').textContent.trim()`);
    record('sign-up-creates-an-account-and-shows-its-email', shownEmail === SYNTHETIC.email, `view shows "${shownEmail}"`);
    const formsAfterSignUp = await cdp.evaluate(`return !!document.querySelector('#account-signin-form')`);
    record('signed-in-view-hides-the-forms', !formsAfterSignUp, 'sign-in form gone while signed in');
    record('synthetic-store-received-the-sign-up', synthetic.hasAccount(SYNTHETIC.email) && synthetic.accountCount() === 1, `store holds ${synthetic.accountCount()} account(s)`);
    const signedInShot = await screenshot(cdp, 'desktop-konto-signedin.png');

    await cdp.click('[data-signout]');
    await cdp.waitFor(`!!document.querySelector('#account-signin-form') && !document.querySelector('[data-account-email]')`, 15000, 'signed out');
    record('sign-out-returns-the-view-to-signed-out', true, 'forms back, no account email');

    await cdp.evaluate(`
      document.querySelector('#signin-email').value = ${JSON.stringify(SYNTHETIC.email)};
      document.querySelector('#signin-password').value = ${JSON.stringify(SYNTHETIC.wrongPassword)};
      return true;
    `);
    await cdp.click('[data-signin]');
    const errorAppeared = await waitForOk(cdp, `document.querySelector('[data-account-error]') && document.querySelector('[data-account-error]').textContent.trim().length > 0`, 15000);
    const errText = errorAppeared ? await cdp.evaluate(`return document.querySelector('[data-account-error]').textContent.trim()`) : '';
    record('failed-sign-in-shows-an-error-from-the-server', errorAppeared, errorAppeared ? `error shown: "${errText}"` : 'no error appeared');
    const signedInAfterFailure = await cdp.evaluate(`return !!document.querySelector('[data-account-email]')`);
    record('failed-sign-in-does-not-show-a-signed-in-state', !signedInAfterFailure, signedInAfterFailure ? 'a refused sign-in rendered as signed in' : 'no account email after a refused sign-in');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const enabledPhone = await overflow(cdp);
    record('konto-no-overflow-at-390', enabledPhone.scrollWidth <= enabledPhone.clientWidth + 8, `scrollWidth ${enabledPhone.scrollWidth} vs clientWidth ${enabledPhone.clientWidth}`);
    const phoneShot = await screenshot(cdp, 'phone-konto.png');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    await cdp.click('[data-view="home"]');
    await cdp.waitFor(`document.getElementById('view-title').textContent === 'Übersicht'`, 15000, 'dashboard');
    const desktopHome = await overflow(cdp);
    record('dashboard-no-overflow-at-1440', desktopHome.scrollWidth <= desktopHome.clientWidth + 8, `scrollWidth ${desktopHome.scrollWidth} vs clientWidth ${desktopHome.clientWidth}`);
    const desktopShot = await screenshot(cdp, 'desktop-dashboard.png');

    const errors = cdp.consoleErrors();
    record('no-console-errors-during-the-run', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

    console.log(`\nScreenshots: ${disabledShot}, ${signedOutShot}, ${signedInShot}, ${phoneShot}, ${desktopShot}`);
  } finally {
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
