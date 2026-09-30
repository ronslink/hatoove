/**
 * Optional browser evidence for WRITING-OUTCOMES-02.
 *
 * Drives the real mock flow in a real browser against an *isolated* dev server:
 * start the mock, end all three blocks, submit a synthetic writing text, then
 * assert the result view does NOT claim a whole-exam verdict, keeps the
 * submitted text visible, and shows the objective denominator only.
 *
 * It deliberately uses its own Chromium launch (this host exposes
 * `chromium-browser`, which tools/cdp.js's fixed candidate list does not cover)
 * and reuses cdp.js for the CDP client.
 *
 * This is emulated viewport geometry, not a phone or tablet: it does not
 * exercise a real soft keyboard, audio or touch. Emulated viewports do not
 * replace iPhone/Android checks.
 *
 * Usage: node tools/mock-outcome-browser-check.mjs http://127.0.0.1:4399
 * The caller must have started server.js with B1PREP_FORCE_OFFLINE=1 and
 * B1PREP_PROGRESS_FILE pointing at a throwaway file. Live ports are refused.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectToPage, makeRecorder, sleep } from './cdp.js';

const base = new URL(process.argv[2] || '');
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)
    || !base.port || ['4321', '4381'].includes(base.port)) {
  throw new Error('Pass an isolated local test URL, e.g. http://127.0.0.1:4399 (live ports 4321/4381 are forbidden).');
}

const EVIDENCE_DIR = process.env.B1PREP_EVIDENCE_DIR || os.tmpdir();
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const WRITING_TEXT = [
  'Sehr geehrte Frau Berger,',
  'ich schreibe Ihnen, weil ich am Samstag leider nicht am Deutschkurs teilnehmen kann.',
  'Meine Schwester heiratet an diesem Tag und die Feier dauert bis in den späten Abend.',
  'Deshalb möchte ich Sie fragen, ob ich die Aufgaben per E-Mail bekommen kann.',
  'Außerdem würde ich gern wissen, ob es in der nächsten Woche einen Ersatztermin gibt.',
  'Vielen Dank für Ihre Hilfe und freundliche Grüße, Ana',
].join(' ');

function findChromium() {
  const candidates = [
    process.env.B1PREP_CHROME,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  throw new Error('No Chromium found; set B1PREP_CHROME.');
}

async function launchChromium(port) {
  const exe = findChromium();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-wo02-browser-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--mute-audio', '--no-zygote',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore' });
  const cleanup = async () => {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { proc, cleanup };
}

const { record, summary } = makeRecorder();
let cdp;
let browser;
let debugPort;

try {
  debugPort = 9700 + (Number(base.port) % 200);
  browser = await launchChromium(debugPort);
  cdp = await connectToPage(debugPort);

  await cdp.send('Page.navigate', { url: base.href });
  await cdp.waitFor(`!!document.querySelector('[data-view="mock"]')`, 15000, 'app shell');

  /* ---- intro must not promise a prognosis any more ---- */
  await cdp.click('[data-view="mock"]');
  await cdp.waitFor(`!!document.querySelector('[data-start-mock]')`, 12000, 'mock intro');
  const intro = await cdp.evaluate(`return document.querySelector('#view').textContent`);
  const stalePrognosis = /Aktuelle Prognose/i.test(intro) || /bestanden ab 135/i.test(intro);
  record('intro-drops-readiness-prognosis', !stalePrognosis,
    stalePrognosis ? 'intro still shows the old readiness prognosis' : 'no readiness prognosis on the intro card');

  /* ---- run the three blocks ---- */
  await cdp.click('[data-start-mock]');
  await cdp.waitFor(`!!document.querySelector('#mock-timer')`, 15000, 'block 1');

  for (const [blockNo, next] of [[1, 'Block 2 / 3'], [2, 'Block 3 / 3']]) {
    await cdp.click('[data-end-block]');
    await cdp.waitFor(`document.querySelector('#view-actions')?.textContent.includes(${JSON.stringify(next)})`, 20000, `${next}`);
    record(`block-${blockNo}-completes-once`, true, 'advanced to the next block');
  }

  // Block 3 is the writing block: type synthetic text before submitting.
  await cdp.waitFor(`!!document.querySelector('#mock-writing')`, 12000, 'writing textarea');
  await cdp.evaluate(`
    const ta = document.querySelector('#mock-writing');
    ta.value = ${JSON.stringify(WRITING_TEXT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  `);
  await cdp.click('[data-end-block]');
  await cdp.waitFor(`document.querySelector('.card h2')?.textContent.includes('Mocktest-Ergebnis')`, 25000, 'mock result');

  const result = await cdp.evaluate(`return {
    text: document.body.textContent,
    hasWriting: /Bestanden/i.test(document.body.textContent),
    passages: [...document.querySelectorAll('.passage')].map((p) => p.textContent),
  }`);

  record('result-view-shows-no-pass-claim', !result.hasWriting, result.hasWriting ? 'still claims "Bestanden"' : 'no "Bestanden" claim');
  record('result-view-shows-no-grade-band', !/sehr gut|befriedigend|ausreichend|nicht bestanden/i.test(result.text));
  record('result-view-shows-objective-denominator', result.text.includes('/ 180') && !/\/\s*225/.test(result.text));
  record('result-view-keeps-unassessed-writing-visible',
    result.passages.some((t) => t.includes('Meine Schwester heiratet')) && /nicht bewertet/i.test(result.text));
  record('result-view-labels-objective-only', /Objektive Aufgaben/.test(result.text) && /Richtige Antworten/.test(result.text));

  /* ---- layout evidence: desktop and emulated phone ---- */
  const shots = [];
  for (const [name, width, height] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'phone' });
    await sleep(250);
    const overflow = await cdp.evaluate(`return document.documentElement.scrollWidth - window.innerWidth`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(EVIDENCE_DIR, `wo02-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    shots.push({ name, width, height, overflow, file });
    record(`layout-${name}-no-horizontal-overflow`, overflow <= 1, `scrollWidth-innerWidth=${overflow}`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  const errors = cdp.consoleErrors();
  record('no-console-errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\nScreenshots (not committed; allowed paths are limited):');
  for (const s of shots) console.log(`  ${s.name} ${s.width}x${s.height} -> ${s.file}`);
  console.log(`\nWriting text preserved in ${result.passages.length} passage block(s).`);
} finally {
  if (browser) await browser.cleanup();
}

process.exitCode = summary() ? 1 : 0;
