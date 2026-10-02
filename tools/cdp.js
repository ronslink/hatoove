/**
 * Shared headless-browser harness for the end-to-end tests.
 *
 * Talks the Chrome DevTools Protocol over Node's built-in WebSocket, so the tests
 * need no npm packages. Used by tools/app-browser-check.mjs (the rendered-evidence check, SPA-RETIRE
 * era) and by the retired SPA end-to-end runners `tools/e2e.js` and `tools/e2e-ai.js`, which were
 * deleted with the client they drove — this harness stayed because it drives a BROWSER, not the SPA.
 * (AI path against the mock DeepSeek server).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/**
 * Where the browser is, with an explicit override.
 *
 * THE OVERRIDE IS WHAT MAKES THIS RUNNABLE OFF THIS MACHINE. The candidate list already covers the usual
 * Windows installs and `/usr/bin/google-chrome`, but "the usual place" is not a plan: a CI runner image, a
 * snap, a Flatpak, a Chromium build or a test-only copy all live somewhere else, and the previous behaviour
 * was to return `null` and let the caller report something generic — which is how a gate stops being run
 * because nobody can tell what it wanted.
 *
 * `CHROME_PATH` (and `CHROME_BIN`, the name the Puppeteer/Chromium tooling uses) is checked FIRST, and a
 * wrong value is an error naming the variable rather than a silent fall-through to a search that will not
 * find it. When nothing is found, the error lists what was tried, so the fix is obvious from the log.
 */
export function findBrowser() {
  const override = process.env.CHROME_PATH || process.env.CHROME_BIN;
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new Error(`CHROME_PATH/CHROME_BIN is set to "${override}", which does not exist. `
      + 'Point it at a Chrome or Chromium executable, or unset it to let the search run.');
  }
  for (const c of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** The same search, but the failure explains itself — for the callers that cannot continue without a browser. */
export function requireBrowser() {
  const found = findBrowser();
  if (found) return found;
  throw new Error('no Chrome or Chromium found. Set CHROME_PATH to an executable; these were tried: '
    + CHROME_CANDIDATES.join(', '));
}

export async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/**
 * Launch Chromium with a throwaway profile.
 * @param {number} port remote debugging port
 * @param {{headless?:boolean, muteAudio?:boolean, autoPlay?:boolean, extraArgs?:string[]}} [opts]
 *   Headless has no audio stack and reports no speech voices, so the TTS probe
 *   needs headless:false (it parks the window off-screen).
 */
export async function launchBrowser(port, opts = {}) {
  const { headless = true, muteAudio = true, autoPlay = false, extraArgs = [] } = opts;
  const browser = requireBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-e2e-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...extraArgs,
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');
  if (muteAudio) args.push('--mute-audio');
  if (autoPlay) args.push('--autoplay-policy=no-user-gesture-required');
  args.push('about:blank');

  const proc = spawn(browser, args, { stdio: 'ignore', detached: false });
  const cleanup = async () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return { proc, profile, cleanup };
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`JS error in page: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async waitFor(expression, timeoutMs = 12000, label = expression) {
    // Accept both "expr" and "return expr" so call sites stay readable.
    const expr = String(expression).replace(/^\s*return\s+/, '');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await this.evaluate(`return ${expr}`)) return true;
      } catch {
        /* page mid-navigation */
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }

  /** Click the first element matching a selector; returns false if absent. */
  async click(selector) {
    return this.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    `);
  }

  async text() {
    return this.evaluate(`return document.body.innerText`);
  }

  consoleErrors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        out.push(`exception: ${e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text}`);
      }
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push(`console.error: ${e.params.args.map((a) => a.value ?? a.description ?? '?').join(' ')}`);
      }
    }
    return out;
  }
}

/** Connect to the first page target and enable the domains the tests need. */
export async function connectToPage(port) {
  await waitForHttp(`http://127.0.0.1:${port}/json/version`);
  const targets = await waitForHttp(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  return cdp;
}

export function makeRecorder() {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  };
  const summary = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
    return failed.length;
  };
  return { results, record, summary };
}
