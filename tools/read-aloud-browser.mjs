/** Isolated source-only UI fixture. Synthetic API/voices; never uses the learner app, DB or real audio. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, connectToPage } from './cdp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hatoove-read-aloud-'));
const shots = path.join(root, '.qa', 'read-aloud');
await fs.mkdir(shots, { recursive: true });
await fs.cp(path.join(root, 'public'), path.join(scratch, 'public'), { recursive: true });
const examples = [
  { de: 'der Termin', en: 'appointment', pos: 'Nomen', example: 'Ich habe morgen einen Termin beim Arzt.' },
  { de: 'pünktlich', en: 'on time', pos: 'Adjektiv', example: 'Bitte kommen Sie morgen pünktlich.' },
];
const task = { task_id: 'synthetic-writing', version: 'v1', rubric_id: 'synthetic-rubric', rubric_version: 'v1', topic: 'Eine Einladung', situation: 'Schreibe eine Einladung.', leitpunkte: ['Anlass', 'Zeit', 'Ort'] };
const rows = ['english', 'fallback'].map((name, index) => ({ id: name, task_id: task.task_id, task_version: 'v1', rubric_id: task.rubric_id, rubric_version: 'v1', topic: index ? 'Gespeicherte Rückmeldung ohne Sprachmetadaten' : 'Gespeicherte Rückmeldung auf Englisch', created_at: '2026-10-02T10:00:00Z', submission_id: name, status: 'assessed' }));
const requests = [];
function api(route, req) {
  if (route === '/api/auth/get-session') return { user: { id: 'synthetic-read-aloud' } };
  if (route === '/api/v1/account') return { id: 'synthetic-read-aloud', email: 'read-aloud@example.invalid' };
  if (route === '/api/v1/settings') return { revision: 1, settings: { language: 'ar', theme: 'light' } };
  if (route === '/api/v1/sessions') return { sessions: [] };
  if (route === '/api/v1/vocab' || route === '/api/v1/nouns') return examples;
  if (route === '/api/v1/practice/mistakes') return { items: [] };
  if (route === '/api/v1/practice/progress') return { totals: { attempts: 0, correct: 0 }, sections: [] };
  if (route === '/api/v1/attempts') return { attempts: rows };
  if (route.startsWith('/api/v1/rubrics/')) return { review_status: 'unreviewed', criteria: [] };
  if (route.startsWith('/api/v1/submissions/')) {
    const english = route.endsWith('/english');
    return { task, rubric: { review_status: 'unreviewed', criteria: [] }, job: { status: 'succeeded' }, submission: { text: 'Mein gespeicherter deutscher Brief.' }, assessment: { feedback: {
      kind: 'telc-b1-bands', ...(english ? { language: 'en' } : {}), criteria: ['aufgabe', 'kommunikation', 'richtigkeit'].map(key => ({ key, band: 'B', comment: english ? 'Your invitation explains the place clearly. Add the date so your reader can plan the visit.' : 'Deine Einladung nennt den Ort klar. Ergänze noch das Datum.', evidence: 'Mein deutscher Beispielsatz.' })),
    } } };
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
  requests.push({ method: req.method, pathname });
  if (pathname.startsWith('/api/')) {
    const data = api(pathname, req); res.writeHead(data ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify(data || { error: 'synthetic_unavailable' })); return;
  }
  try {
    const relative = pathname === '/app/' ? '/app/index.html' : pathname;
    const source = path.resolve(scratch, 'public', '.' + relative);
    assert.ok(source.startsWith(path.join(scratch, 'public') + path.sep));
    const data = await fs.readFile(source);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' }[path.extname(source)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const browser = await launchBrowser(port);
let cdp;
const results = [];
const record = (name, ok) => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
try {
  cdp = await connectToPage(port);
  await cdp.send('Network.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const probe = window.__readProbe = { voices: [], spoken: [], cancelled: 0, active: null };
    const synth = new EventTarget();
    synth.getVoices = () => probe.voices;
    synth.speak = utterance => { probe.active = utterance; probe.spoken.push({text:utterance.text,lang:utterance.lang,local:utterance.voice.localService}); utterance.onstart?.(); };
    synth.cancel = () => { probe.cancelled++; const old=probe.active; probe.active=null; old?.onerror?.({error:'canceled'}); };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text){this.text=text;} }, configurable: true });
  ` });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: base + '/app/#/woerterbuch' });
  await cdp.waitFor("document.querySelectorAll('#dict-results .read-aloud').length === 2");
  record('dictionary renders explicit controls without autoplay', await cdp.evaluate('return __readProbe.spoken.length === 0'));
  await cdp.click('#dict-results .read-aloud button');
  record('missing local voice is honest and does not fall back', await cdp.evaluate("return __readProbe.spoken.length === 0 && document.querySelector('.read-aloud-status').textContent.includes('keine lokale Stimme')"));
  await cdp.evaluate("__readProbe.voices=[{lang:'de-DE',localService:true},{lang:'en-GB',localService:true},{lang:'ar-SA',localService:false}]; speechSynthesis.dispatchEvent(new Event('voiceschanged')); return true");
  record('delayed voices require another explicit click', await cdp.evaluate("return __readProbe.spoken.length === 0 && document.querySelector('.read-aloud-status').textContent.includes('zum Starten')"));
  await cdp.click('#dict-results .read-aloud button');
  record('German example speaks only its rendered text with a local voice', await cdp.evaluate("const said=__readProbe.spoken.at(-1); return said.local === true && said.lang === 'de-DE' && said.text === document.querySelector('[data-read-example]').innerText && document.querySelector('.read-aloud button').textContent === 'Stoppen'"));
  await cdp.click('#dict-results .card:nth-child(2) .read-aloud button');
  record('selecting another example stops the old example', await cdp.evaluate('return __readProbe.cancelled === 1 && __readProbe.spoken.length === 2'));
  await cdp.evaluate("document.querySelector('#dict-q').value='Termin'; document.querySelector('#dict-q').dispatchEvent(new Event('input')); return true");
  await cdp.waitFor("document.querySelectorAll('#dict-results .read-aloud').length === 2");
  record('search replacement cancels the previous example', await cdp.evaluate('return __readProbe.cancelled === 2 && !__readProbe.active'));
  async function screenshot(name, width, height, theme) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await cdp.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; return true`);
    await cdp.waitFor('[...document.images].every(image => image.complete)');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(shots, name + '.png'), Buffer.from(shot.data, 'base64'));
    record(name + ' fits viewport and touch controls', await cdp.evaluate("return document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.view:not([hidden]) .read-aloud button')].every(button => button.getBoundingClientRect().height >= 44)"));
  }
  await cdp.click('#dict-results .read-aloud button');
  await screenshot('dictionary-desktop-light', 1440, 1000, 'light');
  await screenshot('dictionary-desktop-dark', 1440, 1000, 'dark');
  await screenshot('dictionary-mobile-light', 390, 844, 'light');
  await screenshot('dictionary-mobile-dark', 390, 844, 'dark');
  await cdp.evaluate("location.hash='#/fortschritt'; return true");
  await cdp.waitFor("document.querySelector('[data-attempt=english]')");
  record('navigation stops speech', await cdp.evaluate('return !__readProbe.active'));
  await cdp.click('[data-attempt=english]');
  await cdp.waitFor("document.querySelectorAll('#history-detail .read-aloud').length === 3");
  await cdp.click('#history-detail .read-aloud button');
  record('saved English comment follows rendered language despite Arabic preference', await cdp.evaluate("const said=__readProbe.spoken.at(-1), paragraph=document.querySelector('[data-read-comment]'); return document.querySelector('#language').value === 'ar' && paragraph.lang === 'en' && said.lang === 'en-GB' && said.text === paragraph.innerText && !said.text.includes('deutscher')"));
  await screenshot('comments-mobile-dark', 390, 844, 'dark');
  await screenshot('comments-mobile-light', 390, 844, 'light');
  await screenshot('comments-desktop-dark', 1440, 1000, 'dark');
  await screenshot('comments-desktop-light', 1440, 1000, 'light');
  await cdp.click('[data-attempt=fallback]');
  await cdp.waitFor("document.querySelector('[data-read-comment]')?.lang === 'de'");
  record('result replacement stops the previous comment', await cdp.evaluate('return !__readProbe.active'));
  await cdp.click('#history-detail .read-aloud button');
  record('rendered German fallback is read in German', await cdp.evaluate("return __readProbe.spoken.at(-1).lang === 'de-DE'"));
  await cdp.evaluate("__readProbe.active.onerror({error:'audio-busy'}); return true");
  record('playback error offers honest retry', await cdp.evaluate("return document.querySelector('#history-detail .read-aloud-status').textContent.includes('fehlgeschlagen') && document.querySelector('#history-detail .read-aloud button').textContent === 'Vorlesen'"));
  await cdp.click('#history-detail .read-aloud button');
  await cdp.click('#signout');
  await cdp.waitFor("document.querySelector('#error').textContent.includes('Abmelden fehlgeschlagen')");
  record('sign-out attempt stops speech even when sign-out fails', await cdp.evaluate('return !__readProbe.active'));
  await cdp.click('[data-attempt=fallback]');
  await cdp.waitFor("document.querySelector('[data-read-comment]')?.lang === 'de'");
  await cdp.click('#history-detail .read-aloud button');
  await cdp.evaluate("window.dispatchEvent(new CustomEvent('hatoove:session-expired',{detail:{reason:'account_changed'}})); return true");
  record('session/account expiry stops speech without removing saved comments', await cdp.evaluate("return !__readProbe.active && Boolean(document.querySelector('[data-read-comment]'))"));
  record('frozen account keeps the recovery message and stops further playback', await cdp.evaluate("return document.querySelector('#history-detail .read-aloud button').disabled && document.querySelector('#error').textContent.includes('Konto wurde')"));
  record('no new API route, text upload or provider call', requests.every(request => request.method === 'GET' || request.pathname === '/api/auth/sign-out'));
  record('no uncaught browser exceptions', cdp.consoleErrors().filter(error => error.startsWith('exception:')).length === 0);
} finally {
  cdp?.ws.close(); await browser.cleanup(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir())); assert.ok(path.basename(scratch).startsWith('hatoove-read-aloud-'));
  await fs.rm(scratch, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} browser checks passed. Synthetic voices; real device/audio acceptance remains open.\nScreenshots: ${shots}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
