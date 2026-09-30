/**
 * Regression checks for the academy dashboard and keyboard-accessible navigation.
 * Run only against a dedicated offline server with an isolated progress file:
 *   node tools/redesign-check.js http://127.0.0.1:4323
 * Screenshots and test output belong in the ignored .qa directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, connectToPage, makeRecorder } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:4323';
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4321' || !url.port) {
  throw new Error('Use an explicitly isolated local test server; the live port 4321 is forbidden.');
}
const health = await fetch(`${BASE}/api/health`).then(r => r.json());
if (health.configured) throw new Error('The redesign checks require a server with B1PREP_FORCE_OFFLINE=1.');

const { record, summary } = makeRecorder();
const { cleanup } = await launchBrowser(9323);
const out = path.resolve('.qa');
fs.mkdirSync(out, { recursive: true });
let cdp;
let previousState;

async function viewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate('return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function key(key, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers });
}
async function home() {
  await cdp.evaluate(`return import('/js/shell.js').then(s => {s.navigate('home', {}); return new Promise(resolve => requestAnimationFrame(resolve));})`);
  await cdp.waitFor(`!!document.querySelector('.academy-dashboard')`);
}
async function screenshot(name) {
  await cdp.waitFor(`document.querySelectorAll('#toasts .toast').length === 0`, 6000, 'temporary notifications to finish');
  await cdp.evaluate(`return document.fonts.ready.then(() => Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getTiming().iterations)).map(a => a.finished.catch(() => {}))))`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64'));
}
async function fits(label) {
  const size = await cdp.evaluate(`return {width: innerWidth, page: document.documentElement.scrollWidth}`);
  record(`${label} has no horizontal page overflow`, size.page <= size.width + 1, `${size.page}px / ${size.width}px`);
}

try {
  cdp = await connectToPage(9323);
  await viewport(1440, 1000);
  await cdp.send('Page.navigate', { url: BASE });
  await cdp.waitFor(`!!document.querySelector('.academy-dashboard')`, 15000, 'academy dashboard');
  previousState = await cdp.evaluate(`return import('/js/store.js').then(s => s.exportJSON())`);
  await cdp.evaluate(`return import('/js/store.js').then(s => {s.resetAll(); return true})`);
  await home();

  const empty = await cdp.evaluate(`return {
    score: document.querySelector('.forecast-total > span').textContent,
    evidence: document.querySelector('.evidence-label').textContent,
    skills: [...document.querySelectorAll('.skill-card')].map(b => b.textContent),
    sections: [...document.querySelectorAll('.readiness-label')].map(b => b.textContent),
    note: document.querySelector('.forecast-note').textContent,
    date: document.querySelector('.exam-date').textContent
  }`);
  record('a new learner receives no invented forecast score', empty.score === '–' && empty.evidence.includes('Noch keine Daten'));
  record('all five skill areas communicate the empty state', empty.skills.length === 5 && empty.skills.every(s => s.includes('Noch nicht geübt')));
  record('written and oral forecasts each require learner evidence', empty.sections.length === 2 && empty.sections.every(s => s.includes('Noch keine Daten')));
  record('the dashboard explains the separate written and oral pass requirement', empty.note.includes('Beide Bereiche müssen separat bestanden werden'));
  record('an unset exam date has an actionable prompt', empty.date.includes('Kein Prüfungsdatum'));
  await fits('Desktop dashboard');
  await screenshot('dashboard-empty-desktop.png');

  await cdp.evaluate(`return import('/js/store.js').then(s => {
    for(let i=0;i<3;i++) s.recordAttempt({partId:'LV2', tags:['lv_detail'], difficulty:55, correct:i>0});
    return true;
  })`);
  await home();
  const partial = await cdp.evaluate(`return {
    score: document.querySelector('.forecast-total > span').textContent,
    evidence: document.querySelector('.evidence-label').textContent,
    oral: document.querySelectorAll('.readiness-label')[1].textContent,
    caption: document.querySelector('.forecast-caption').textContent,
    note: document.querySelector('.forecast-note').textContent
  }`);
  record('partial practice is labelled as an incomplete, provisional estimate', /^\d+$/.test(partial.score) && partial.evidence.includes('Unvollständige') && partial.caption.includes('vorläufig') && partial.note.includes('Modellannahmen'));
  record('reading practice does not invent oral evidence', partial.oral.includes('Noch keine Daten'));
  await screenshot('dashboard-progress-desktop.png');

  for (const [skill, route] of [['LV','paper'], ['SB','paper'], ['HV','listening'], ['SA','writing'], ['SP','speaking']]) {
    if (skill === 'LV') {
      await cdp.evaluate(`const button = document.querySelector('[data-skill="LV"]'); button.scrollIntoView(); button.focus(); return true`);
    }
    await cdp.click(`[data-skill="${skill}"]`);
    await cdp.waitFor(`document.querySelector('#main').dataset.view === '${route}'`, 10000, `${skill} training`);
    const routed = await cdp.evaluate(`return document.querySelector('#nav [aria-current="page"]')?.dataset.view === '${route}' && !document.querySelector('#view').textContent.includes('Ansicht konnte nicht')`);
    record(`${skill} dashboard card opens its training area with active navigation`, routed);
    if (skill === 'LV') {
      const focus = await cdp.evaluate(`return scrollY === 0 && document.activeElement.id === 'view-title'`);
      record('desktop navigation resets the scroll position and focuses the new heading', focus);
    }
    await home();
  }

  await viewport(390, 844);
  await fits('Mobile dashboard');
  const closed = await cdp.evaluate(`return document.querySelector('#sidebar').inert && document.querySelector('#sidebar').getAttribute('aria-hidden') === 'true' && document.querySelector('#nav-toggle').getAttribute('aria-expanded') === 'false' && !document.querySelector('#main').inert`);
  record('the closed mobile drawer is hidden from keyboard and assistive technology', closed);
  await screenshot('dashboard-mobile.png');
  await cdp.click('#nav-toggle');
  await screenshot('navigation-mobile.png');
  const opened = await cdp.evaluate(`return { sidebarInert: document.querySelector('#sidebar').inert, mainInert: document.querySelector('#main').inert, expanded: document.querySelector('#nav-toggle').getAttribute('aria-expanded'), focus: document.activeElement.id }`);
  record('opening mobile navigation moves focus inside and disables background controls', !opened.sidebarInert && opened.mainInert && opened.expanded === 'true' && opened.focus === 'nav-close', JSON.stringify(opened));
  await cdp.evaluate(`document.querySelector('#sidebar button').focus(); return true`);
  await key('Tab', 8);
  const wrapsBack = await cdp.evaluate(`return document.activeElement === [...document.querySelectorAll('#sidebar button:not(:disabled), #sidebar a[href], #sidebar [tabindex="0"]')].at(-1)`);
  await key('Tab');
  const wrapsForward = await cdp.evaluate(`return document.activeElement === document.querySelector('#sidebar button')`);
  record('Tab and Shift+Tab keep keyboard focus inside the open drawer', wrapsBack && wrapsForward);
  await key('Escape');
  const escaped = await cdp.evaluate(`return !document.body.classList.contains('nav-open') && document.activeElement.id === 'nav-toggle' && !document.querySelector('#main').inert`);
  record('Escape closes the drawer and restores focus to its trigger', escaped);

  await cdp.click('#nav-toggle');
  await cdp.click('#nav-scrim');
  const dismissed = await cdp.evaluate(`return !document.body.classList.contains('nav-open') && document.activeElement.id === 'nav-toggle'`);
  record('the mobile backdrop closes the drawer and restores trigger focus', dismissed);

  await cdp.click('#nav-toggle');
  await cdp.click('#nav [data-view="drill"]');
  await cdp.waitFor(`!!document.querySelector('.drill-prompt')`, 12000, 'mobile adaptive exercise');
  const navigated = await cdp.evaluate(`return !document.body.classList.contains('nav-open') && document.activeElement.id === 'view-title' && !document.querySelector('#main').inert && document.querySelector('#nav [data-view="drill"]').getAttribute('aria-current') === 'page'`);
  record('choosing a mobile route closes navigation and focuses the new heading', navigated);
  await fits('Mobile exercise');
  await screenshot('exercise-mobile.png');
  await home();

  await cdp.click('#nav-toggle');
  await viewport(1440, 1000);
  const resized = await cdp.evaluate(`return !document.querySelector('#sidebar').inert && !document.querySelector('#main').inert && !document.body.classList.contains('nav-open')`);
  record('resizing an open mobile drawer to desktop leaves both areas interactive', resized);
  await cdp.click('#theme-toggle [data-theme="dark"]');
  await screenshot('dashboard-dark-desktop.png');
  await cdp.send('Page.navigate', { url: BASE });
  await cdp.waitFor(`!!document.querySelector('.academy-dashboard')`, 15000, 'reload with saved theme');
  const theme = await cdp.evaluate(`return document.documentElement.dataset.theme === 'dark' && document.querySelector('#theme-toggle [data-theme="dark"]').getAttribute('aria-pressed') === 'true'`);
  record('the chosen theme survives reload and remains accessible', theme);
  await cdp.click('#theme-toggle [data-theme="light"]');
  await viewport(375, 812);
  await fits('Narrow mobile dashboard');
  await screenshot('dashboard-small-mobile.png');
  const errors = cdp.consoleErrors();
  record('the redesigned flows produce no console errors', errors.length === 0, errors.slice(0,3).join(' | '));
} catch (err) {
  record('redesign checks completed without a harness error', false, err.stack || err.message);
} finally {
  if (cdp && previousState) {
    try { await cdp.evaluate(`return import('/js/store.js').then(s => {s.importJSON(${JSON.stringify(previousState)}); return s.flushNow()})`); } catch { /* dedicated test state only */ }
  }
  try { cdp?.ws.close(); } catch { /* browser may have exited */ }
  await cleanup();
}
process.exit(summary() ? 1 : 0);
