/**
 * Rendered-browser evidence for PROVIDER-CONFIG-01 D1: on a real page, the Settings view
 * offers NO provider field at all, and the app still works with no provider key configured.
 *
 * This is a sibling of tools/account-ui-browser-check.mjs (the file is not rewritten). It
 * reuses that pattern: materialise a disposable source-only copy, start server.js in-process
 * over real HTTP with a throwaway env file that holds NO key, drive real headless Chromium
 * over the DevTools Protocol, and assert on the rendered DOM.
 *
 * What it proves:
 *   * the Settings view renders and contains no API-key input, no model chooser, no "test
 *     key" button, no "remove key" button, and no provider copy;
 *   * GET /api/config, fetched from the page, reports no provider field;
 *   * the app still boots and produces an offline writing task with no key, so the AI
 *     feature degrades instead of breaking;
 *   * no console errors, no horizontal overflow of the Settings view at 390 px or of the
 *     dashboard at 1440 px;
 *   * both-theme screenshots at 1440 px are captured for the typography comparison.
 *
 * Scope and honesty: headless Chromium with emulated viewports. No real phone, hardware
 * keyboard, camera or audio was exercised, and this is NOT a real-device proof. Only a
 * local in-process server is used; B1PREP_FORCE_OFFLINE=1 and the throwaway env holds no
 * key, so no provider is ever contacted.
 *
 * Usage: node tools/provider-config-browser-check.mjs [--port 4341] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectToPage, sleep } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PORTS = new Set([4321, 4381]);
const SHOTS = path.join(ROOT, '.openclaw', 'tmp', 'provider-config');

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
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-provider-config-'));
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

async function startInProcessServer({ copyRoot, port }) {
  const mod = await import(pathToFileURL(path.join(copyRoot, 'server.js')).href);
  const server = mod.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, cleanup: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function launchChromium(debugPort) {
  const browser = findChromium();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-provider-config-prof-'));
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
  return { proc, cleanup, binary: browser };
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const value = index === -1 ? '4341' : argv[index + 1];
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

async function waitForOk(cdp, expression, timeoutMs) {
  try {
    await cdp.waitFor(expression, timeoutMs, expression);
    return true;
  } catch {
    return false;
  }
}

async function main(argv) {
  const port = parsePort(argv);
  const debugPort = port + 1;
  const keep = argv.includes('--keep');

  const checkout = materializeSourceCheckout();
  process.env.B1PREP_ENV_FILE = checkout.envPath;
  process.env.B1PREP_PROGRESS_FILE = checkout.progressPath;
  process.env.B1PREP_FORCE_OFFLINE = '1';
  delete process.env.DEEPSEEK_API_KEY;

  const server = await startInProcessServer({ copyRoot: checkout.dest, port });
  const browser = await launchChromium(debugPort);
  let cdp = null;

  try {
    cdp = await connectToPage(debugPort);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });

    /* --------------------------------------------------------------- boot */
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    const booted = await waitForOk(cdp, `!!document.querySelector('#view .card')`, 20000);
    const title = booted ? await cdp.evaluate(`return document.getElementById('view-title').textContent`) : '';
    record('app-boots-with-no-provider-key', booted && title === 'Übersicht', `title="${title}"`);

    /* ------------------------------------------------------- the settings view */
    await cdp.click('[data-view="settings"]');
    const settingsReady = await waitForOk(
      cdp,
      `document.getElementById('view-title').textContent === 'Einstellungen' && !!document.querySelector('#view .card')`,
      15000
    );
    record('settings-view-still-renders', settingsReady, settingsReady ? 'Einstellungen rendered' : 'settings did not render');

    const settingsProbe = await cdp.evaluate(`
      const view = document.getElementById('view');
      const card = view.querySelector('.card');
      return {
        keyInput: !!view.querySelector('#api-key'),
        modelInput: !!view.querySelector('#model'),
        saveButton: !!view.querySelector('[data-save-key]'),
        testButton: !!view.querySelector('[data-test-key]'),
        clearButton: !!view.querySelector('[data-clear-key]'),
        keyHeading: /DeepSeek-Schlüssel|API-Schlüssel/.test(view.innerText),
        providerCopy: /(DeepSeek-Schlüssel|API-Schlüssel|Modell:|Verbunden)/.test(view.innerText),
        modelSelect: !!view.querySelector('select#model, input#model'),
        learnerDate: !!view.querySelector('#exam-date'),
        firstCardText: card ? card.innerText.slice(0, 80) : '',
      };
    `);
    record('settings-offers-no-key-input', !settingsProbe.keyInput, settingsProbe.keyInput ? 'an #api-key input is present' : 'no #api-key');
    record('settings-offers-no-model-chooser', !settingsProbe.modelInput && !settingsProbe.modelSelect, settingsProbe.modelInput ? 'a model control is present' : 'no model control');
    record('settings-offers-no-provider-buttons', !settingsProbe.saveButton && !settingsProbe.testButton && !settingsProbe.clearButton, `save=${settingsProbe.saveButton} test=${settingsProbe.testButton} clear=${settingsProbe.clearButton}`);
    record('settings-copy-mentions-no-provider', !settingsProbe.keyHeading && !settingsProbe.providerCopy, settingsProbe.providerCopy ? `provider copy present: "${settingsProbe.firstCardText}"` : 'no provider copy in the view');
    record('settings-still-offers-learner-fields', settingsProbe.learnerDate, settingsProbe.learnerDate ? 'exam date control present' : 'learner settings missing');

    /* ------------------------------------------- the read route from the page */
    const configProbe = await cdp.evaluate(`
      return fetch('/api/config').then((r) => r.json()).then((json) => Object.keys(json).sort());
    `);
    record('api-config-reports-no-provider-field', JSON.stringify(configProbe) === JSON.stringify(['examDate']), `fields ${JSON.stringify(configProbe)}`);

    /* ------------------------------------- the app still works without a key */
    const offlineTask = await cdp.evaluate(`
      return import('/js/ai.js').then((ai) => ai.refreshStatus().then(() => ai.nextWritingTask())).then((task) => ({
        source: task.source,
        points: Array.isArray(task.leitpunkte) ? task.leitpunkte.length : 0,
      }));
    `);
    record('app-still-produces-an-offline-task-with-no-key', offlineTask.source === 'offline' && offlineTask.points === 4, `source=${offlineTask.source}, leitpunkte=${offlineTask.points}`);

    /* --------------------------------------------------- overflow + shots */
    const desktop = await overflow(cdp);
    record('settings-no-overflow-at-1440', desktop.scrollWidth <= desktop.clientWidth + 8, `scrollWidth ${desktop.scrollWidth} vs clientWidth ${desktop.clientWidth}`);
    const settingsShot = await screenshot(cdp, 'settings-1440.png');

    await cdp.click('[data-view="home"]');
    await waitForOk(cdp, `document.getElementById('view-title').textContent === 'Übersicht'`, 15000);
    const dashboard = await overflow(cdp);
    record('dashboard-no-overflow-at-1440', dashboard.scrollWidth <= dashboard.clientWidth + 8, `scrollWidth ${dashboard.scrollWidth} vs clientWidth ${dashboard.clientWidth}`);

    // Both themes at 1440 px, for the Part 2.2 typography comparison.
    await cdp.evaluate(`document.documentElement.setAttribute('data-theme', 'light'); return true;`);
    await sleep(200);
    const lightShot = await screenshot(cdp, 'dashboard-1440-light.png');
    await cdp.evaluate(`document.documentElement.setAttribute('data-theme', 'dark'); return true;`);
    await sleep(200);
    const darkShot = await screenshot(cdp, 'dashboard-1440-dark.png');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await cdp.click('[data-view="settings"]');
    await waitForOk(cdp, `document.getElementById('view-title').textContent === 'Einstellungen'`, 15000);
    const phone = await overflow(cdp);
    record('settings-no-overflow-at-390', phone.scrollWidth <= phone.clientWidth + 8, `scrollWidth ${phone.scrollWidth} vs clientWidth ${phone.clientWidth}`);
    const phoneShot = await screenshot(cdp, 'settings-390.png');

    const errors = cdp.consoleErrors();
    record('no-console-errors-during-the-run', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

    console.log(`\nScreenshots: ${settingsShot}, ${lightShot}, ${darkShot}, ${phoneShot}`);
    console.log(`Chromium: ${browser.binary}`);
    console.log('NOTE  headless Chromium, emulated viewports: no real phone, keyboard or audio was exercised.');
    console.log('NOTE  offline in-process server, throwaway env with no key; no provider was contacted.');
  } finally {
    if (!keep) {
      await server.cleanup();
      await browser.cleanup();
      fs.rmSync(checkout.dest, { recursive: true, force: true });
    } else {
      console.log(`Kept disposable copy at ${checkout.dest}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)).catch((err) => {
  console.error(`FAIL  ${err.message}`);
  return 1;
}));
