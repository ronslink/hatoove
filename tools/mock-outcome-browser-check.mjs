/**
 * Focused offline browser evidence for the mock-writing outcome path (WRITING-OUTCOMES-02).
 *
 * What it proves in a real headless Chromium page:
 *   * when the provider is unavailable, the mock result shows the writing as explicitly
 *     `unbewertet` (unassessed) instead of a fabricated score;
 *   * the learner's submitted text stays accessible in the result;
 *   * the summary is objective-only and makes no "Bestanden?" / grade-band / readiness claim;
 *   * the desktop and phone layouts keep the learner cards without horizontal overflow.
 *
 * Safety:
 *   * It materializes its OWN disposable source-only copy (no .env, no learner progress,
 *     no data/), starts that copy on an isolated port, and refuses the live ports.
 *   * Provider is forced offline (B1PREP_FORCE_OFFLINE=1); nothing is sent anywhere.
 *   * All text is synthetic and marked as such.
 *
 * It is a browser proof only: headless Chromium, one viewport at a time, no real phone or
 * hardware keyboard. That is stated in the output rather than implied.
 *
 * Usage: node tools/mock-outcome-browser-check.mjs [--port 4329] [--keep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { connectToPage, waitForHttp, sleep } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PORTS = new Set([4321, 4381]);
const SYNTHETIC_MARKER = 'SYNTHETIC-WO02-BRIEF';
const SHOTS = path.join(ROOT, '.openclaw', 'tmp', 'wo02-ui');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-wo02-ui-'));
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

async function launchChromium(port) {
  const browser = findChromium();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-wo02-prof-'));
  const proc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
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

async function startServer(root, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root.dest,
    env: {
      ...process.env,
      B1PREP_ENV_FILE: root.envPath,
      B1PREP_PROGRESS_FILE: root.progressPath,
      B1PREP_FORCE_OFFLINE: '1',
      B1PREP_PORT: String(port),
    },
    stdio: 'ignore',
  });
  await waitForHttp(`http://127.0.0.1:${port}/api/config`, 20000);
  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(300);
  };
  return { child, cleanup };
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  return path.join(SHOTS, name);
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  const value = index === -1 ? '4329' : argv[index + 1];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid --port ${value}`);
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`port ${port} is a live learner port; pick an isolated one`);
  return port;
}

async function main(argv) {
  const port = parsePort(argv);
  const debugPort = port + 1;
  const keep = argv.includes('--keep');
  const port2 = undefined; // reserved

  const checkout = materializeSourceCheckout();
  const browser = await launchChromium(debugPort);
  const server = await startServer(checkout, port);
  let cdp = null;

  try {
    cdp = await connectToPage(debugPort);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    /*
 * CI FLAKE, fixed here rather than tolerated. This suite failed once with
 * "Timed out waiting for: mock intro" and passed on an immediate re-run of the SAME commit, so the
 * cause was a slow runner, not a defect - but a gate that fails for a reason unrelated to the change
 * is worse than no gate, because it teaches everyone to re-run instead of read.
 *
 * The shape of the problem: `cdp.waitFor` polls every 150 ms INSIDE its timeout budget, and a single
 * `evaluate` on an overloaded runner can cost hundreds of milliseconds, so a 15 s budget buys far
 * fewer attempts than it looks. The boot and navigation steps below are the ones that wait on the
 * whole SPA - app shell, then nav, then this view - so they are the ones a slow runner exhausts.
 *
 * Raised to 60 s for boot/navigation only. This does NOT hide real breakage: a genuinely broken page
 * never renders, so it still fails, and now fails with a clearer message after a longer wait. The
 * tighter waits further down are deliberate and stay as they are - a real assertion that a rendered
 * page is slow to react should still be a failure.
 */await cdp.waitFor(`!!document.querySelector('#view')`, 60000, 'app boot');

    // Reach the mock view and start it offline.
    await cdp.waitFor(`!!document.querySelector('[data-view="mock"]')`, 60000, 'nav ready');
    await cdp.click('[data-view="mock"]');
    await cdp.waitFor(`!!document.querySelector('[data-start-mock]')`, 60000, 'mock intro');
    await cdp.click('[data-start-mock]');
    await cdp.waitFor(`!!document.querySelector('#mock-parts')`, 40000, 'first mock block');

    // Block 1 is objective; submit and wait for the listening block.
    await cdp.click('[data-end-block]');
    await cdp.waitFor(`!!document.querySelector('#mock-parts') && document.body.innerText.includes('Hörverstehen')`, 25000, 'block 2');
    // Block 2 is objective too; submit and wait for the writing block.
    await cdp.click('[data-end-block]');
    await cdp.waitFor(`!!document.querySelector('#mock-writing')`, 25000, 'writing block');

    record('mock-start-offline-reaches-writing-block', true, 'blocks 1–2 submitted offline');

    // Block 3 is Schreiben: type a synthetic brief, then submit.
    const brief = [
      `${SYNTHETIC_MARKER} Hallo, vielen Dank für deine Nachricht.`,
      'Ich habe mich sehr über die Einladung gefreut und möchte dir ein paar Fragen stellen.',
      'Zuerst: Wann genau beginnt der Kurs am Montag, und wo findet er statt?',
      'Außerdem möchte ich wissen, ob ich die Materialien vorher bekomme.',
      'Ich kann an allen Terminen teilnehmen, weil ich meinen Urlaub schon verschoben habe.',
      'Bitte schick mir noch eine schriftliche Bestätigung mit der Adresse.',
      'Viele Grüße und bis bald',
    ].join(' ');

    await cdp.evaluate(`
      const ta = document.querySelector('#mock-writing');
      ta.focus();
      return true;
    `);
    await cdp.send('Input.insertText', { text: brief });
    const typed = await cdp.evaluate(`return document.querySelector('#mock-writing').value`);
    record('writing-text-is-kept-in-the-textarea', typed.includes(SYNTHETIC_MARKER), `${typed.length} chars typed`);

    await cdp.click('[data-end-block]');
    await cdp.waitFor(`!!document.querySelector('[data-new-mock]')`, 30000, 'mock result');
    await sleep(300);

    const state = await cdp.evaluate(`
      const text = document.body.innerText;
      const writCard = [...document.querySelectorAll('.card')].find((c) => /^Schreiben\\b/m.test(c.querySelector('h3')?.textContent || ''));
      return {
        text,
        hasUnassessed: /nicht bewertet/.test(text),
        hasBestanden: text.includes('Bestanden?'),
        hasObjective: /Objektive Punkte/i.test(text),
        hasBand: /sehr gut|nicht bestanden|befriedigend|ausreichend/.test(text) && !/keine Gesamtnote/.test(text),
        hasText: text.includes(${JSON.stringify(SYNTHETIC_MARKER)}),
        passageHasText: [...document.querySelectorAll('.passage')].some((p) => p.textContent.includes(${JSON.stringify(SYNTHETIC_MARKER)})),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    `);

    record('result-shows-writing-unassessed-not-zero', state.hasUnassessed, 'result labels writing as nicht bewertet');
    record('result-makes-no-bestanden-or-grade-band-claim', !state.hasBestanden && !state.hasBand, 'no Bestanden?/band wording');
    record('result-shows-objective-only-summary', state.hasObjective, 'objective summary present, no whole-exam total');
    record('result-keeps-the-learners-text-accessible', state.hasText && state.passageHasText, 'synthetic brief still shown in the result');
    record(
      'desktop-layout-has-no-horizontal-overflow',
      state.scrollWidth <= state.clientWidth + 8,
      `scrollWidth ${state.scrollWidth} vs clientWidth ${state.clientWidth}`
    );
    const desktopShot = await screenshot(cdp, 'desktop-result.png');

    // Phone viewport: the learner card must survive and stay inside the viewport.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    const phone = await cdp.evaluate(`
      return {
        hasUnassessed: /nicht bewertet/.test(document.body.innerText),
        hasText: document.body.innerText.includes(${JSON.stringify(SYNTHETIC_MARKER)}),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    `);
    record('phone-result-keeps-writing-card', phone.hasUnassessed && phone.hasText, 'writing status and text present at 390px');
    record(
      'phone-layout-has-no-horizontal-overflow',
      phone.scrollWidth <= phone.clientWidth + 8,
      `scrollWidth ${phone.scrollWidth} vs clientWidth ${phone.clientWidth}`
    );
    const phoneShot = await screenshot(cdp, 'phone-result.png');

    // The action-bar button lives outside #view; it must really restart the mock.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
    await cdp.click('[data-new-mock]');
    let restarted = false;
    try {
      await cdp.waitFor(`!!document.querySelector('[data-start-mock]')`, 12000, 'mock intro after restart');
      restarted = true;
    } catch {
      restarted = false;
    }
    record('new-mock-button-restarts-the-mock', restarted, 'Neuer Mocktest returns to the intro');
    const errors = cdp.consoleErrors();
    record('no-console-errors-during-the-run', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

    console.log(`\nScreenshots: ${desktopShot}, ${phoneShot}`);
  } finally {
    if (!keep) {
      await server.cleanup();
      await browser.cleanup();
      fs.rmSync(checkout.dest, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  console.log('NOTE  headless Chromium, emulated viewports: no real phone, keyboard or audio was exercised.');
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)).catch((err) => {
  console.error(`FAIL  ${err.message}`);
  return 1;
}));
