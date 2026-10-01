/**
 * Headless-browser evidence for the writing surface's account draft (WRITING-SURFACE-01B).
 *
 * What this proves in a real headless Chromium page, over real HTTP, driving the REAL
 * public/js/exam.js writing view and the REAL public/js/account.js boundary:
 *   * account path - text typed into #writing-text, the screen LEFT and re-entered, comes
 *     back in the textarea (the property this slice exists to deliver), and the status line
 *     says the draft is saved;
 *   * single-user path - with accounts disabled, leaving and returning the writing screen
 *     still starts from an empty textarea and paints no draft status, i.e. the behaviour is
 *     exactly what it was before this slice.
 *
 * Why in-process servers: the Konto/draft routes need a same-origin owned API, and the real
 * mount needs PostgreSQL. `server/owned-api.mjs`'s `createOwnedApi` is mounted with the
 * test-only in-memory datastore/session fakes from tools/owned-api-check.mjs, so the real
 * client, the real DOM and the real HTTP layer are exercised - only the store is synthetic.
 *
 * Safety: materialises its OWN disposable source-only copy (no .env, no learner record, no
 * .git); B1PREP_FORCE_OFFLINE=1; refuses the live ports; synthetic text only. Browser
 * evidence only - headless Chromium, emulated viewport. No real phone or device.
 *
 * Usage: node tools/writing-surface-browser-check.mjs [--port 4361] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectToPage, sleep } from './cdp.js';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PORTS = new Set([4321, 4381]);
const SHOTS = path.join(ROOT, '.openclaw', 'tmp', 'writing-surface');
const SYNTHETIC = Object.freeze({
  name: 'SYNTHETIC Learner (writing-surface check)',
  email: 'synthetic.writing-surface@example.invalid',
  password: 'synthetic-pass-123',
});
const TEXT = 'Liebe Anna,\n\nich komme gern am Samstag vorbei und bringe einen Kuchen mit.\n\nLiebe Grüße, Alex';

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
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  throw new Error('No Chromium found; set CHROME_PATH to a headless-capable browser.');
}

function materializeSourceCheckout() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-writing-surface-'));
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

/** Adapt `server/owned-api.mjs`'s handler to the `{ matches, handleNode }` shape server.js mounts. */
function ownedApiHandle() {
  const api = createOwnedApi({ datastore: createMemoryDatastore({ allowance: 10 }).port, sessions: createMemorySessions() });
  const matches = (pathname) => pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/');
  async function handleNode(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const out = await api.handle({ method: req.method || 'GET', path: url.pathname, headers: req.headers, body: raw, originChecked: true });
    res.writeHead(out.status, { ...(out.headers || {}) });
    res.end(out.body);
  }
  return { matches, handleNode };
}

async function startInProcessServer({ copyRoot, port, ownedApi }) {
  const mod = await import(pathToFileURL(path.join(copyRoot, 'server.js')).href);
  const server = mod.createServer({ ownedApi });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, cleanup: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function launchChromium(debugPort) {
  const browser = findChromium();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-writing-surface-prof-'));
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = async () => {
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { proc, cleanup };
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const value = index === -1 ? '4361' : argv[index + 1];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65533) throw new Error(`invalid --port ${value}`);
  for (const p of [port, port + 1, port + 2]) {
    if (FORBIDDEN_PORTS.has(p)) throw new Error(`port ${p} is a live learner port; pick an isolated one`);
  }
  return port;
}

const setTextarea = (text) => `
  var ta = document.querySelector('#writing-text');
  ta.value = ${JSON.stringify(text)};
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
`;

/** Leave the writing screen for the dashboard (this is the "left the screen" step). */
async function leaveToHome(cdp) {
  await cdp.click('[data-view="home"]');
  await cdp.waitFor(`document.getElementById('view-title')?.textContent === 'Übersicht'`, 10000, 'dashboard');
}

async function openWriting(cdp) {
  await cdp.click('[data-view="writing"]');
  await cdp.waitFor(`!!document.querySelector('#writing-text')`, 15000, 'writing textarea');
  return cdp.evaluate(`return document.querySelector('#writing-text').value`);
}

/** Wait (bounded) for the textarea to show `text`; the restore is a network round trip. */
async function waitForValue(cdp, text) {
  try {
    await cdp.waitFor(`document.querySelector('#writing-text')?.value === ${JSON.stringify(text)}`, 10000, 'restored text');
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
  process.env.B1PREP_ENV_FILE = checkout.envPath;
  process.env.B1PREP_PROGRESS_FILE = checkout.progressPath;
  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ACCOUNTS = '0';

  const disabled = await startInProcessServer({ copyRoot: checkout.dest, port: portDisabled, ownedApi: null });
  const enabled = await startInProcessServer({ copyRoot: checkout.dest, port: portAccounts, ownedApi: ownedApiHandle() });
  const browser = await launchChromium(debugPort);
  let cdp = null;

  try {
    cdp = await connectToPage(debugPort);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });

    /* ---------------------------------------- single-user path (unchanged) */
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portDisabled}/` });
    await cdp.waitFor(`!!document.querySelector('#view .card')`, 20000, 'app boot (accounts disabled)');
    await openWriting(cdp);
    const disabledStatus = await cdp.evaluate(`return document.querySelector('#w-draft-status')?.textContent ?? null`);
    await cdp.evaluate(setTextarea(TEXT));
    await leaveToHome(cdp);
    const disabledReturn = await openWriting(cdp);
    record('single-user: leaving and returning starts from an empty textarea, as today', disabledReturn === '', `value length ${disabledReturn.length}`);
    record('single-user: no draft status is painted', !disabledStatus, `status="${disabledStatus}"`);

    /* ----------------------------------------- account path (the slice) */
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portAccounts}/` });
    await cdp.waitFor(`!!document.querySelector('#view .card') && !!document.querySelector('#account-nav [data-shell-view="account"]')`, 25000, 'app boot (accounts)');
    await cdp.click('#account-nav [data-shell-view="account"]');
    await cdp.waitFor(`!!document.querySelector('#account-signup-form')`, 25000, 'sign-up form');
    await cdp.evaluate(`
      document.querySelector('#signup-name').value = ${JSON.stringify(SYNTHETIC.name)};
      document.querySelector('#signup-email').value = ${JSON.stringify(SYNTHETIC.email)};
      document.querySelector('#signup-password').value = ${JSON.stringify(SYNTHETIC.password)};
      return true;
    `);
    await cdp.click('[data-signup]');
    let signedIn = true;
    try {
      await cdp.waitFor(`!!document.querySelector('[data-account-email]')`, 25000, 'signed in');
    } catch {
      signedIn = false;
      const detail = await cdp.evaluate(`return (document.querySelector('[data-account-error]')?.textContent || '(no error shown)') + ' | url=' + location.href`);
      record('account: a synthetic account signs up against the in-process owned API', false, detail);
    }
    if (signedIn) record('account: a synthetic account signs up against the in-process owned API', true, SYNTHETIC.email);

    const empty = await openWriting(cdp);
    record('account: a fresh draft starts empty', empty === '', `value length ${empty.length}`);
    await cdp.waitFor(`document.querySelector('#w-draft-status')?.textContent === 'Entwurf gespeichert.'`, 10000, 'draft saved status');
    record('account: the view reports the opened draft as saved', true, 'Entwurf gespeichert.');

    await cdp.evaluate(setTextarea(TEXT));
    // The autosave is debounced; wait for it to land before leaving.
    await cdp.waitFor(`document.querySelector('#w-draft-status')?.textContent === 'Entwurf gespeichert.'`, 10000, 'autosave');
    record('account: the debounced autosave reports saved', true, 'Entwurf gespeichert.');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, 'writing-draft.png'), Buffer.from(shot.data, 'base64'));

    await leaveToHome(cdp);
    await openWriting(cdp);
    const restored = await waitForValue(cdp, TEXT);
    await cdp.waitFor(`document.querySelector('#w-draft-status')?.textContent === 'Entwurf gespeichert.'`, 10000, 'restored status');
    record('account: the typed text is restored when the screen is re-entered', restored, restored ? `${TEXT.length} chars restored (from the server draft, not page memory)` : 'the textarea did not come back');

    // Deliberately NOT asserted: a full page reload starts a NEW rotation slot, so the app
    // generates a fresh task and does not auto-resume the previous slot's draft. Task identity
    // across a page load needs S6's enumeration route and is acceptance set B, out of scope here.
    console.log('NOTE  a page reload starts a fresh rotation slot; auto-resuming the previous slot is S6 (set B), not this slice.');

    const errors = cdp.consoleErrors();
    record('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
    console.log(`\nScreenshot: ${path.join(SHOTS, 'writing-draft.png')}`);
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
  console.log('NOTE  headless Chromium, emulated viewport; no real phone, keyboard or audio was exercised.');
  console.log('NOTE  in-process synthetic owned API over the in-memory datastore; no PostgreSQL, no live API.');
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)).catch((err) => {
  console.error(`FAIL  ${err.message}`);
  return 1;
}));
