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
import net from 'node:net';

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

export async function waitForHttp(url, timeoutMs = 15000, { check = () => {}, accept = () => true } = {}) {
  const start = Date.now();
  let lastFailure = 'no response';
  while (Date.now() - start < timeoutMs) {
    check();
    let value;
    try {
      // A socket that accepts but never answers must not bypass the total readiness budget.
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, timeoutMs - (Date.now() - start)))) });
      if (res.ok) value = await res.json();
      else { lastFailure = `HTTP ${res.status}`; await res.body?.cancel(); }
    } catch (error) {
      lastFailure = error.cause?.code || error.name || 'request failed';
    }
    check();
    if (value !== undefined && accept(value)) return value;
    await sleep(Math.min(200, Math.max(0, timeoutMs - (Date.now() - start))));
  }
  throw new Error(`Timed out waiting for ${url} after ${Date.now() - start}ms (${lastFailure})`);
}

const launches = new Map();
// One bounded launch-to-CDP budget; retain the earlier cutoff as an observation, never a relaunch.
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_MILESTONE_MS = 15000;
const STDERR_LIMIT = 16384;

async function assertAvailablePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser debugging port');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(`Browser debugging port ${port} unavailable: ${error.code}`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

/**
 * Launch Chromium with a throwaway profile.
 * @param {number} port remote debugging port
 * @param {{headless?:boolean, muteAudio?:boolean, autoPlay?:boolean, extraArgs?:string[]}} [opts]
 *   Headless has no audio stack and reports no speech voices, so the TTS probe
 *   needs headless:false (it parks the window off-screen).
 */
export async function launchBrowser(port, opts = {}, { spawnProcess = spawn } = {}) {
  const { headless = true, muteAudio = true, autoPlay = false, extraArgs = [] } = opts;
  if (launches.has(port)) throw new Error(`Browser debugging port ${port} already belongs to a harness launch`);
  await assertAvailablePort(port);
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

  // A private POSIX process group contains only this launch, including Chrome's wrapper/crashpad
  // descendants. Keep Windows launch semantics and never target unrelated browser processes.
  const grouped = process.platform !== 'win32';
  const startedAt = Date.now();
  let proc;
  try { proc = spawnProcess(browser, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: grouped, windowsHide: true }); }
  catch (error) { fs.rmSync(profile, { recursive: true, force: true }); throw error; }
  let startupBytes = Buffer.alloc(0), announcedDebugger = null, spawnError = null, startupComplete = false, cleanupPromise, processClosed = false;
  let startupPhase = 'spawned', startupMilestone = null, milestoneTimer;
  const phaseTimings = { spawned: Date.now() - startedAt };
  const markStartupPhase = phase => { startupPhase = phase; phaseTimings[phase] = Date.now() - startedAt; };
  proc.once('close', () => { processClosed = true; });
  proc.on('error', error => { spawnError = error.code || error.message; });
  proc.stderr?.on('data', chunk => {
    if (startupComplete) return; // Never retain later application console output.
    startupBytes = Buffer.concat([startupBytes, chunk]).subarray(-STDERR_LIMIT);
    const match = startupBytes.toString('utf8').match(/DevTools listening on (ws:\/\/[^\r\n]+)\r?\n/);
    if (match) announcedDebugger = match[1];
  });
  const diagnostics = () => ({ executable: browser, pid: proc.pid ?? null, port,
    elapsedMs: Date.now() - startedAt, exitCode: proc.exitCode, signalCode: proc.signalCode,
    spawnError, announcedDebugger, startupComplete, startupPhase, phaseTimings: { ...phaseTimings },
    startupMilestone, stderrTail: startupBytes.toString('utf8') });
  milestoneTimer = setTimeout(() => {
    startupMilestone = { pid: proc.pid ?? null, elapsedMs: Date.now() - startedAt, startupPhase,
      exitCode: proc.exitCode, signalCode: proc.signalCode, spawnError,
      announcedDebugger: Boolean(announcedDebugger), stderrBytes: startupBytes.length,
      stderrTail: startupBytes.subarray(-2048).toString('utf8') };
    console.error('Chrome startup still pending: ' + JSON.stringify(startupMilestone));
  }, Math.max(1, STARTUP_MILESTONE_MS - (Date.now() - startedAt)));
  const check = () => {
    if (spawnError) throw new Error(`Chrome spawn failed: ${spawnError}`);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Chrome exited before connection: code=${proc.exitCode}, signal=${proc.signalCode}`);
  };
  const groupAlive = () => {
    if (process.platform === 'linux') {
      // An exited orphan can remain a zombie until its new parent reaps it. It is not a running
      // Chrome process; match the private process-group id, never a process name or other profile.
      return fs.readdirSync('/proc').some(name => {
        if (!/^\d+$/.test(name)) return false;
        try {
          const fields = fs.readFileSync(`/proc/${name}/stat`, 'utf8').split(/\) /).at(-1).split(' ');
          return Number(fields[2]) === proc.pid && !['Z', 'X'].includes(fields[0]);
        } catch { return false; }
      });
    }
    try { process.kill(-proc.pid, 0); return true; } catch { return false; }
  };
  const waitUntil = async (predicate, milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (!predicate() && Date.now() < deadline) await sleep(50);
    return predicate();
  };
  const cleanup = async () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearTimeout(milestoneTimer);
      startupComplete = true;
      const receipt = { processClosed: false, profileRemoved: false, errors: [] };
      if (proc.pid) {
        try { if (grouped) process.kill(-proc.pid, 'SIGTERM'); else proc.kill(); } catch { /* already exited */ }
        await waitUntil(() => processClosed && (!grouped || !groupAlive()), 2000);
        if (grouped && groupAlive()) {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already exited */ }
          await waitUntil(() => processClosed && !groupAlive(), 2000);
        } else if (!grouped && proc.exitCode === null && proc.signalCode === null) {
          // Exact owned PID only, with a hidden helper; never kill all Chrome processes by name.
          await new Promise(resolve => {
            const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
            killer.once('error', resolve); killer.once('close', resolve);
          });
          await waitUntil(() => processClosed, 2000);
        }
        if (!processClosed || grouped && groupAlive()) receipt.errors.push('Owned browser process did not fully close');
      }
      receipt.processClosed = processClosed;
      proc.stderr?.destroy();
      if (launches.get(port)?.proc === proc) launches.delete(port);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); receipt.profileRemoved = true; }
      catch (error) { receipt.errors.push(`Profile cleanup: ${error.code || error.message}`); }
      // A profile cleanup error must not skip the caller's disposable database/Compose cleanup.
      if (receipt.errors.length) console.error('Chrome cleanup incomplete: '+JSON.stringify({pid:proc.pid,port,...receipt}));
      return receipt;
    })();
    return cleanupPromise;
  };
  const handle = { proc, profile, cleanup, diagnostics, check, markStartupPhase,
    startupDeadline: startedAt + STARTUP_TIMEOUT_MS,
    connected: () => { markStartupPhase('connected'); clearTimeout(milestoneTimer); },
    acceptVersion: value => {
      if (!announcedDebugger) return false;
      if (value.webSocketDebuggerUrl !== announcedDebugger) throw new Error('Debugging endpoint does not belong to the spawned Chrome');
      const endpoint = new URL(announcedDebugger);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port
        || !endpoint.pathname.startsWith('/devtools/browser/')) throw new Error('Chrome announced an unexpected debugging endpoint');
      startupComplete = true;
      return true;
    },
  };
  launches.set(port, handle);
  return handle;
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
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
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
  const launch = launches.get(port);
  if (!launch) throw new Error(`No harness-owned Chrome launch for debugging port ${port}`);
  const deadline = launch.startupDeadline;
  const remaining = () => {
    launch.check();
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error('Chrome startup exceeded its single 30-second deadline');
    return milliseconds;
  };
  let ws;
  try {
    launch.markStartupPhase('version');
    await waitForHttp(`http://127.0.0.1:${port}/json/version`, remaining(), { check: launch.check, accept: launch.acceptVersion });
    launch.markStartupPhase('page-target');
    const targets = await waitForHttp(`http://127.0.0.1:${port}/json/list`, remaining(), {
      check: launch.check, accept: value => Array.isArray(value) && value.some(target => target.type === 'page'),
    });
    const page = targets.find((t) => t.type === 'page');
    const endpoint = new URL(page.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || Number(endpoint.port) !== port) throw new Error('Unexpected page debugging endpoint');

    launch.markStartupPhase('websocket');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), remaining());
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true });
    });

    const cdp = new CDP(ws);
    launch.markStartupPhase('Runtime.enable');
    await cdp.send('Runtime.enable', {}, remaining());
    launch.markStartupPhase('Page.enable');
    await cdp.send('Page.enable', {}, remaining());
    launch.markStartupPhase('Log.enable');
    await cdp.send('Log.enable', {}, remaining());
    remaining();
    launch.connected();
    return cdp;
  } catch (error) {
    try { ws?.close(); } catch { /* not connected */ }
    const diagnostic = launch.diagnostics();
    try { diagnostic.cleanup = await launch.cleanup(); } catch (cleanupError) { diagnostic.cleanupError = cleanupError.message; }
    const failure = new Error(`${error.message}\nChrome startup: ${JSON.stringify(diagnostic)}`, { cause: error });
    failure.browserDiagnostics = diagnostic;
    throw failure;
  }
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
