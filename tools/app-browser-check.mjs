#!/usr/bin/env node
/**
 * APP-BROWSER-01 — the FIRST rendered evidence for the Hatoove learner app.
 *
 * WHY THIS EXISTS
 * Every visual claim in this repository until now was markup-and-endpoint evidence: the right classes
 * in the served HTML, the right JSON from the endpoint. Nothing had ever been RENDERED. That is a
 * different claim, and it is the one a learner experiences. Reading the source cannot tell you that a
 * script threw on boot, that `api.practice.progress()` does not exist, or that nine tabs are being laid
 * out in a five-column grid.
 *
 * WHAT IT DOES
 * Brings up a DISPOSABLE Compose stack (own project name, own volume, own free ports — never the
 * learner's stack), launches headless Chromium over the shared CDP harness in `tools/cdp.js`, and walks
 * the real journey in a real browser:
 *
 *   landing -> sign-in -> the app -> Heute -> Leseverstehen -> open a set -> answer it -> Fehler
 *
 * at desktop (1440x900) and phone (390x844) widths, in light and dark, writing screenshots to
 * `.qa/browser/<stamp>/` (gitignored). Assertions are about what is ON SCREEN: visible text, non-zero
 * boxes, no horizontal overflow, no console exception, and the DOM agreeing with the API.
 *
 * HONEST LIMITS, stated rather than implied: headless Chromium on a desktop OS is not an iPhone or an
 * Android device. It proves rendering and layout; it does not replace a real-device keyboard, audio or
 * Safari check, and it cannot see a font fallback that only that device has.
 *
 * Usage: node tools/app-browser-check.mjs [--keep] [--shots <dir>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { launchBrowser, connectToPage, sleep } from './cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const shotsArg = process.argv.indexOf('--shots');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const SHOTS = shotsArg === -1 ? path.join(ROOT, '.qa', 'browser', stamp) : path.resolve(process.argv[shotsArg + 1]);

/** A learner's plausible name for the synthetic account this run creates. */
const SYNTHETIC = { name: 'Browser Evidence', password: 'synthetic-browser-pass-1' };

const project = `hatoove-browser-${Date.now()}-${process.pid}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${project}-`));
const envFile = path.join(scratch, 'compose.env');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}
const note = (name, detail) => console.log(`NOTE  ${name}${detail ? `  [${detail}]` : ''}`);

/* ------------------------------------------------------------------ docker */

let appPort = 0;
let dbPort = 0;
let base = '';

function docker(args) {
  const r = spawnSync('docker', args, {
    cwd: ROOT,
    env: { ...process.env, HATOVE_APP_PORT: String(appPort), HATOVE_DB_PORT: String(dbPort), HATOVE_PUBLIC_ORIGIN: base },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`docker ${args[0]}: ${(r.error?.message || r.stderr || r.stdout || '').slice(-2000)}`);
  }
  return (r.stdout || '').trim();
}
const compose = (args) => docker(['compose', '--env-file', envFile, '-p', project, '-f', path.join(ROOT, 'compose.yaml'), ...args]);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

/* ------------------------------------------------------------------- page  */

/** Navigate and wait for the document to finish loading. */
async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor("document.readyState === 'complete'", 25000, url);
}

async function viewport(cdp, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  // `maxTouchPoints` must be 1..16, so touch emulation is switched on with a count and switched off
  // without one.
  await cdp.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
}

async function theme(cdp, value) {
  await cdp.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: value ? [{ name: 'prefers-color-scheme', value }] : [],
  });
}

/** A viewport screenshot (what the learner sees), not a full-page strip. */
async function shot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

function errorsSince(cdp, mark) {
  const out = [];
  for (const e of cdp.events.slice(mark)) {
    if (e.method === 'Runtime.exceptionThrown') {
      out.push(`exception: ${e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text}`);
    }
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      out.push(`console.error: ${e.params.args.map((a) => a.value ?? a.description ?? '?').join(' ')}`);
    }
  }
  return out;
}

/**
 * Same-origin requests the server REFUSED while the page was loading.
 *
 * This is the leg that would have caught the front door on its own: `/` served the brand site, whose
 * relative asset URLs resolved to `/styles.css`, `/app.js` and `/assets/hatoove-logo.svg` — two of
 * them auth-gated (401) and one absent (404). The page had text, an h1 and a font stack, so a
 * presence-only assertion passed while the browser drew unstyled HTML.
 */
function networkFailuresSince(cdp, mark) {
  const out = [];
  for (const e of cdp.events.slice(mark)) {
    if (e.method !== 'Network.responseReceived') continue;
    const { url, status } = e.params.response;
    if (status >= 400 && url.startsWith(base)) out.push(`${status} ${url.slice(base.length)}`);
  }
  return out;
}

/**
 * Elements that extend past the right edge of the VIEWPORT.
 *
 * An element inside a horizontal scroll container is SUPPOSED to be past the edge: the phone tabbar is
 * a scrollable row, so its later tabs are legitimately outside the viewport. The first version of this
 * helper reported all of them as overflow — 30 "offenders" on a page whose `scrollWidth` exactly
 * equalled `innerWidth`, i.e. a defect invented by looking in the wrong place. Anything with a
 * scrolling ancestor is skipped; what remains is real page overflow.
 */
async function overflow(cdp) {
  return cdp.evaluate(`
    const width = window.innerWidth;
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      }
      return false;
    };
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > width + 2 && !inScroller(el)) {
        offenders.push((el.tagName.toLowerCase()) + '.' + String(el.getAttribute('class') || '').split(' ')[0] + '@' + Math.round(r.right));
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: width,
      offenders: offenders.slice(0, 6),
      offenderCount: offenders.length,
    };
  `);
}

async function visible(cdp, selector) {
  return cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const opts = { display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
    return {
      present: true,
      shown: !el.hidden && opts.display !== 'none' && opts.visibility !== 'hidden' && Number(opts.opacity) > 0.05,
      width: Math.round(r.width), height: Math.round(r.height),
      text: (el.innerText || '').trim().slice(0, 200),
    };
  `);
}

async function setInputs(cdp, values) {
  return cdp.evaluate(`
    const values = ${JSON.stringify(values)};
    for (const [id, value] of Object.entries(values)) {
      const el = document.getElementById(id);
      if (!el) return 'missing:' + id;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return 'ok';
  `);
}

async function clickSel(cdp, selector) {
  return cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  `);
}

/**
 * Wait for an expression, and REPORT the timeout instead of throwing.
 *
 * One broken leg must not hide the rest of the journey: the first run of this check aborted at the
 * practice form and never reached Fehler, the mobile layout or the accessibility legs. A journey check
 * that stops at the first defect measures one thing per fix cycle.
 */
async function softWait(cdp, expression, timeoutMs, label) {
  try {
    await cdp.waitFor(expression, timeoutMs, label);
    return true;
  } catch {
    return false;
  }
}

/** The session cookie the BROWSER holds, so Node can ask the API the same question. */
async function browserCookie(cdp) {
  const { cookies } = await cdp.send('Network.getCookies', { urls: [base] });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function apiGet(cookie, route) {
  const res = await fetch(base + route, { headers: { cookie, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* a refusal may carry no JSON */
  }
  return { status: res.status, body };
}

/* ------------------------------------------------------------------- main  */

async function main() {
  appPort = await freePort();
  dbPort = await freePort();
  while (dbPort === appPort) dbPort = await freePort();
  base = `http://127.0.0.1:${appPort}`;
  const email = `browser-${Date.now()}@example.test`;
  const debugPort = await freePort();

  console.log(`\n=== APP-BROWSER-01: rendered evidence (${project}) ===`);
  console.log(`app ${base}   db 127.0.0.1:${dbPort}   screenshots ${SHOTS}\n`);

  if (appPort === 4300 || dbPort === 55440) throw new Error('refusing to run on a live learner port');
  fs.writeFileSync(envFile, `HATOVE_APP_PORT=${appPort}\nHATOVE_DB_PORT=${dbPort}\nHATOVE_PUBLIC_ORIGIN=${base}\n`);

  /*
   * TWO STATIC GUARDS, before anything is built.
   *
   * P0 — the design reference and the SERVED copy must both still match the pinned digests. This
   * project has already edited the pinned stylesheet once and re-pinned the manifest to match, which
   * defeats the pin; the second half of this leg (manifest == public/assets/design) is what catches
   * exactly that.
   *
   * P1 — the front door IS the brand site from `hatoove-site/dist`, copied to the ROOT of `public/`, so
   * an edit to one and not the other is silent drift between the site we ship and the site we serve.
   */
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'work/implementation/DESIGN-REFERENCE-MANIFEST.json'), 'utf8'));
  const referenceDrift = [];
  const servedDrift = [];
  for (const entry of manifest.files || []) {
    const reference = path.join(process.env.HATOOVE_DESIGN_ROOT || path.join(ROOT, 'design'), entry.path);
    if (!fs.existsSync(reference)) referenceDrift.push(`${entry.path}: absent`);
    else if (sha256(reference) !== entry.sha256) referenceDrift.push(`${entry.path}: digest changed`);
    if (!entry.path.startsWith('assets/')) continue;
    const served = path.join(ROOT, 'public', 'assets', 'design', entry.path.slice('assets/'.length));
    if (!fs.existsSync(served)) servedDrift.push(`${entry.path}: not served`);
    else if (sha256(served) !== entry.sha256) servedDrift.push(`${entry.path}: served copy differs from the pin`);
  }
  record('P0 the design reference still matches the pinned digests',
    referenceDrift.length === 0, referenceDrift.join('; ') || `${(manifest.files || []).length} files`);
  record('P0b the SERVED copy of every pinned design asset is byte-exact',
    servedDrift.length === 0, servedDrift.join('; ') || 'stylesheets, logos, mark and fonts all match');

  // The approved German learner entry supersedes the historical English marketing artifact.
  const landingSource = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  record('P1 the German front door has real sign-in and registration links',
    /lang="de"/.test(landingSource) && /href="\/signin"/.test(landingSource)
      && /href="\/signin\?mode=signup"/.test(landingSource), 'German entry contract; pinned design assets remain checked by P0b');
  record('P1b the retired SPA page is gone from the root',
    !fs.existsSync(path.join(ROOT, 'public', 'landing')) && !fs.existsSync(path.join(ROOT, 'public', 'studio.css'))
      && !/Certa/i.test(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')),
    'no public/landing/, no public/studio.css, and the root page carries no "Certa"');

  let browser = null;
  let cdp = null;
  let started = false;
  try {
    console.log('Building and starting the disposable stack ...');
    compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
    started = true;
    record('B1 disposable stack is ready', await waitForReady(`${base}/api/ready`, 60000), `${base}/api/ready`);
    console.log('  seeded: ' + compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'hatoove', '-tAc',
      "SELECT 'objective_sets=' || (SELECT count(*) FROM hatoove.objective_set) || ' keys=' || (SELECT count(*) FROM hatoove.objective_key) || ' vocab=' || (SELECT count(*) FROM hatoove.vocab_entry)"]));

    browser = await launchBrowser(debugPort);
    cdp = await connectToPage(debugPort);
    await cdp.send('Network.enable');

    /* ---------------------------------------------------------------- desktop */

    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');

    // L1 — the front door renders, in a browser, with its stylesheet applied.
    let mark = cdp.events.length;
    await nav(cdp, `${base}/`);
    const landingText = await cdp.evaluate('return document.body.innerText');
    const landingStyle = await cdp.evaluate(`
      const h1 = document.querySelector('h1, h2');
      const sheets = [...document.styleSheets].map((s) => {
        try { return { href: s.href, rules: s.cssRules.length }; } catch { return { href: s.href, rules: -1 }; }
      });
      const body = getComputedStyle(document.body);
      const btn = document.querySelector('.button');
      return {
        textLength: document.body.innerText.trim().length,
        title: document.title,
        path: location.pathname,
        h1: h1 ? h1.innerText.trim().slice(0, 80) : null,
        font: body.fontFamily,
        bodyBg: body.backgroundColor,
        sheets,
        styledButton: btn ? { radius: getComputedStyle(btn).borderRadius, bg: getComputedStyle(btn).backgroundColor } : null,
        brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')),
      };
    `);
    const landingFile = await shot(cdp, '01-landing-desktop-light');
    record('L1 the front door serves the landing page at / and it renders',
      landingStyle.path === '/' && landingStyle.textLength > 300 && landingStyle.h1 !== null,
      `served at ${landingStyle.path}: "${landingStyle.h1}" ${landingStyle.textLength} chars; ${path.basename(landingFile)}`);
    // RENDERED, not merely present: a stylesheet with actual rules, styled elements, no broken images.
    record('L1b the landing page is actually STYLED, and every asset it asks for loaded',
      landingStyle.sheets.some((s) => s.rules > 0) && landingStyle.styledButton !== null
        && landingStyle.brokenImages.length === 0,
      `${landingStyle.sheets.length} stylesheet(s) [${landingStyle.sheets.map((s) => `${(s.href || '').split('/').pop()}:${s.rules}`).join(', ')}]; `
        + `button ${JSON.stringify(landingStyle.styledButton)}; broken images ${JSON.stringify(landingStyle.brokenImages)}`);
    const landingFailures = networkFailuresSince(cdp, mark);
    record('L1c nothing the landing page requested was refused',
      landingFailures.length === 0, landingFailures.join('; ') || 'no 4xx/5xx from this origin');
    const landingErrors = errorsSince(cdp, mark);
    record('L2 the landing page runs without a console exception', landingErrors.length === 0, landingErrors[0] || 'clean');

    await theme(cdp, 'dark');
    await shot(cdp, '02-landing-desktop-dark');
    await theme(cdp, 'light');

    // L3 — THE FRONT DOOR MUST HAVE A DOOR. Is there any way from the landing page into the product?
    const doorways = await cdp.evaluate(`
      const links = [...document.querySelectorAll('a[href], button')].map((el) => ({
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute('href') || '',
        text: (el.innerText || '').trim().slice(0, 40),
      }));
      const into = links.filter((l) => /^\\/(app|signin)/.test(l.href) || /signin|anmeld|login|register|start|app/i.test(l.text));
      return { total: links.length, intos: into, hrefs: [...new Set(links.map((l) => l.href))].slice(0, 20) };
    `);
    record('L3 the landing page links into the application or the sign-in form',
      doorways.intos.some((l) => /^\/(app|signin)/.test(l.href)),
      doorways.intos.length ? JSON.stringify(doorways.intos) : `${doorways.total} links/buttons, none to /app or /signin: ${JSON.stringify(doorways.hrefs)}`);

    // L4 — a signed-out browser asking for the app is sent to a real sign-in form.
    mark = cdp.events.length;
    await nav(cdp, `${base}/app/`);
    await softWait(cdp, "location.pathname === '/signin'", 15000, 'redirect to /signin');
    const signinView = await cdp.evaluate(`
      const form = document.getElementById('form-signin');
      const email = document.getElementById('si-email');
      const pass = document.getElementById('si-password');
      const signup = document.getElementById('form-signup');
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      const r = box(signup);
      return {
        path: location.pathname,
        formShown: form ? !form.hidden : false,
        emailShown: email ? email.getBoundingClientRect().height > 0 : false,
        passType: pass ? pass.type : null,
        head: (document.querySelector('h2')?.innerText || '').trim(),
        // hidden= must actually HIDE. The pinned .stack{display:grid} used to beat it, which showed
        // both forms at once and made the tabs decorative.
        signupVisible: Boolean(r && r.height > 0 && r.width > 0),
        visibleFields: [...document.querySelectorAll('input')].filter((i) => i.getBoundingClientRect().height > 0).length,
        errStyled: (() => {
          const e = document.getElementById('error');
          if (!e) return null;
          const cs = getComputedStyle(e);
          return { color: cs.color, padding: cs.paddingTop, background: cs.backgroundColor };
        })(),
      };
    `);
    await shot(cdp, '03-signin-desktop-light');
    record('L4 a signed-out browser at /app/ lands on a real sign-in form',
      signinView.path === '/signin' && signinView.formShown && signinView.emailShown && signinView.passType === 'password',
      JSON.stringify(signinView));
    record('L4b the sign-in page shows ONE form: `hidden` beats the design system\'s `display:grid`',
      signinView.signupVisible === false && signinView.visibleFields === 2,
      `signup visible=${signinView.signupVisible}; ${signinView.visibleFields} visible input(s)`);
    record('L4c the alert area is styled as an alert, not as body text',
      Boolean(signinView.errStyled) && signinView.errStyled.padding !== '0px' && signinView.errStyled.color !== 'rgb(36, 35, 32)',
      JSON.stringify(signinView.errStyled));

    // The tabs must actually switch which form is shown.
    await clickSel(cdp, '#tab-signup');
    await sleep(250);
    const tabbed = await cdp.evaluate(`
      const shown = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.height > 0; };
      return { signin: shown('form-signin'), signup: shown('form-signup') };
    `);
    record('L4d the Anmelden/Registrieren tabs switch the visible form',
      tabbed.signin === false && tabbed.signup === true, JSON.stringify(tabbed));

    // L5/L6 — register THROUGH THE FORM, then see where the learner actually ends up.
    await clickSel(cdp, '#tab-signup');
    const filled = await setInputs(cdp, { 'su-name': SYNTHETIC.name, 'su-email': email, 'su-password': SYNTHETIC.password });
    record('L5 the registration form accepts input', filled === 'ok', filled);
    await clickSel(cdp, '#su-submit');
    await sleep(1500);
    await softWait(cdp, "location.pathname !== '/signin'", 15000, 'leaving the sign-in page');
    const afterSignup = await cdp.evaluate(`
      return {
        path: location.pathname,
        err: (document.getElementById('error')?.innerText || '').trim(),
        title: document.title,
        // NO brand-page fallback clause. The first version of this was
        //   shell = Boolean(document.querySelector('.side .nav')) || document.body.innerText.includes('Know the exam')
        // and that second clause is the MARKETING PAGE'S OWN HEADLINE — so the very defect this leg is
        // named for (sign-up dropping the learner back on the brand site) made it pass. A leg must not
        // accept the failure it exists to catch.
        shell: Boolean(document.querySelector('.side .nav')) && !document.body.innerText.includes('Know the exam'),
      };
    `);
    await shot(cdp, '04-after-signup-desktop-light');
    record('L6 registering lands the learner INSIDE the app, not back on the marketing page',
      afterSignup.path.startsWith('/app'),
      `ended on ${afterSignup.path} "${afterSignup.title}"${afterSignup.err ? ` err="${afterSignup.err}"` : ''}`);
    record('L6b the page the learner lands on is the application shell, not the brand site',
      afterSignup.shell === true, `shell markup present=${afterSignup.shell}`);

    // L7 — the app boots: Heute is the first view, and it is filled from the server.
    mark = cdp.events.length;
    await nav(cdp, `${base}/app/`);
    await softWait(cdp, "document.querySelector('#view-heute') && !document.querySelector('#view-heute').hidden", 15000, 'Heute view');
    await cdp.waitFor("!document.querySelector('#next-title').innerText.includes('Wird geladen')", 12000, 'the next-task card').catch(() => {});
    const heute = await cdp.evaluate(`
      const t = (id) => (document.getElementById(id)?.innerText || '').trim();
      return {
        path: location.href,
        greeting: t('greeting'), nextTitle: t('next-title'), nextDetail: t('next-detail'),
        nextKicker: t('next-kicker'), crumb: t('crumb-date'), pageTitle: t('page-title'),
        examPill: t('exam-countdown'), gauge: t('gauge-count'), gaugeFoot: t('gauge-foot'),
        countdown: t('countdown'), statAnswers: t('stat-answers'),
        heroBox: (() => { const r = document.querySelector('.hero-next')?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; })(),
      };
    `);
    const heuteFile = await shot(cdp, '05-heute-desktop-light');
    record('L7 Heute renders the server\'s real recommendation (not a placeholder)',
      Boolean(heute.nextTitle) && !heute.nextTitle.includes('Wird geladen') && heute.heroBox !== null && heute.heroBox.h > 60,
      `"${heute.nextTitle}" / "${heute.nextDetail}" ${path.basename(heuteFile)}`);
    record('L8 Heute is the open view and the chrome knows where we are',
      heute.pageTitle === 'Heute' && heute.crumb.length > 4 && heute.examPill.length > 4,
      `title="${heute.pageTitle}" crumb="${heute.crumb}" exam="${heute.examPill}"`);
    const bootErrors = errorsSince(cdp, mark);
    record('L9 the app boots with no console exception and no unhandled rejection',
      bootErrors.length === 0, bootErrors[0] || 'clean');

    // L10 — the sidebar identity is the signed-in account.
    const identity = await cdp.evaluate(`
      const t = (id) => (document.getElementById(id)?.innerText || '').trim();
      return { email: t('account-email'), avatar: t('avatar'), settingsEmail: t('account-email-2'), greeting: t('greeting') };
    `);
    record('L10 the shell shows the signed-in learner, not a placeholder',
      identity.email === email && identity.settingsEmail === email && identity.avatar === email[0].toUpperCase(),
      JSON.stringify(identity));
    record('L11 no horizontal overflow at 1440px',
      (await overflow(cdp)).offenderCount === 0, JSON.stringify(await overflow(cdp)));

    /* ------------------------------------------------------- the skill views */

    await clickSel(cdp, '[data-view="lesen"]');
    await softWait(cdp, "location.hash === '#/lesen'", 8000, 'the Leseverstehen route');
    await softWait(cdp, "document.querySelector('#skill-lesen .card h3') && !document.querySelector('#skill-lesen').innerText.includes('Wird geladen')", 12000, 'the set list');
    const lesen = await cdp.evaluate(`
      const box = document.getElementById('skill-lesen');
      const cards = [...box.querySelectorAll('.card')];
      return {
        shown: !document.getElementById('view-lesen').hidden,
        pageTitle: (document.getElementById('page-title')?.innerText || '').trim(),
        count: cards.length,
        titles: cards.slice(0, 4).map((c) => (c.querySelector('h3')?.innerText || '').trim()),
        buttons: box.querySelectorAll('button[data-open]').length,
        current: document.querySelectorAll('[data-view="lesen"][aria-current="page"]').length,
      };
    `);
    await shot(cdp, '06-lesen-desktop-light');
    record('L12 Leseverstehen lists real sets from the catalogue, from the server',
      lesen.shown && lesen.pageTitle === 'Leseverstehen' && lesen.buttons >= 3,
      `${lesen.count} cards, ${lesen.buttons} Üben buttons: ${JSON.stringify(lesen.titles)}`);
    record('L13 the navigation marks the current view', lesen.current >= 1, `${lesen.current} element(s) with aria-current=page`);
    // Nine seeded sets carry a generated placeholder title (`LV3 1`, `SB1 2`) because the corpus has no
    // authored one. A learner must not be shown a database convenience as the name of their task.
    record('L13b no set is titled with a seed placeholder',
      !lesen.titles.some((t) => /^(LV|SB|HV)\d+\s+\d+$/.test(t.trim())),
      JSON.stringify(lesen.titles));

    // The DOM must agree with the API, not merely be non-empty.
    const cookie = await browserCookie(cdp);
    const apiSets = await apiGet(cookie, '/api/v1/objective-sets');
    const apiLv = (Array.isArray(apiSets.body) ? apiSets.body : []).filter((s) => s.section === 'LV');
    record('L14 the rendered list is the API\'s own list (endpoint vs screen)',
      apiLv.length > 0 && lesen.titles.includes(apiLv[0].title),
      `API LV[0]="${apiLv[0]?.title}" screen=${JSON.stringify(lesen.titles.slice(0, 2))}`);

    /* --------------------------------------------------- open a set and answer */

    mark = cdp.events.length;
    const clickedOpen = await clickSel(cdp, '#skill-lesen button[data-open]');
    const openedForm = await softWait(cdp, "document.querySelector('#practice-items [data-item]')", 15000, 'the practice form');
    const form = await cdp.evaluate(`
      const box = document.querySelector('.view:not([hidden]) .skill-practice');
      if (!box) return { missing: true, pageError: (document.getElementById('error')?.innerText || '').trim() };
      const items = [...box.querySelectorAll('[data-item]')];
      return {
        hidden: box.hidden,
        items: items.length,
        choices: items.length ? items[0].querySelectorAll('button[data-answer]').length : 0,
        firstPrompt: (items[0]?.querySelector('p:not(.kicker)')?.innerText || '').trim().slice(0, 90),
        passage: (box.querySelector('section.card p')?.innerText || '').trim().slice(0, 60),
        pageError: (document.getElementById('error')?.innerText || '').trim(),
      };
    `);
    await shot(cdp, '07-set-open-desktop-light');
    record('L15 opening a set renders a real task form (passage + items + lettered choices)',
      clickedOpen && openedForm && form.hidden === false && form.items >= 1 && form.choices >= 2,
      `click handled=${clickedOpen}; ${form.items ?? 0} items, first has ${form.choices ?? 0} choices`
        + `; prompt "${form.firstPrompt || ''}"${form.pageError ? `; error on screen: "${form.pageError}"` : ''}`);

    /*
     * THE ASSERTION THE FIRST VERSION WAS MISSING.
     *
     * L15 passed while the task was invisible: the form was rendered after nine cards, below the
     * fold, so "Üben" LOOKED like it did nothing. "The elements are present" is not "the learner can
     * see them" — this leg asks where the form is on the screen, and whether the list moved out of
     * the way.
     */
    const placement = await cdp.evaluate(`
      const host = document.querySelector('.view:not([hidden]) .skill-practice');
      const list = document.querySelector('.view:not([hidden]) .stack[id^="skill-"]');
      const r = host.getBoundingClientRect();
      return {
        top: Math.round(r.top), height: Math.round(r.height),
        inViewport: r.top >= -4 && r.top < window.innerHeight * 0.75,
        listHidden: Boolean(list && list.hidden),
        listHeight: list ? Math.round(list.getBoundingClientRect().height) : null,
        scrollY: Math.round(window.scrollY),
      };
    `);
    record('L15b the opened task is ON SCREEN, and the list it came from is out of the way',
      placement.inViewport === true && placement.listHidden === true,
      `form top ${placement.top}px of ${844}px viewport; list hidden=${placement.listHidden} (height ${placement.listHeight})`);

    // Answer the first item's choices in turn until the SERVER says "Richtig." — which also exercises
    // the mistakes path, because every wrong answer must be recorded. The loop runs out here in Node
    // because `cdp.evaluate` does not admit `await` inside the page (it is not an async function).
    const choices = await cdp.evaluate(`
      return [...document.querySelectorAll('#practice-items [data-item] button[data-answer]')].map((b) => b.dataset.answer);
    `);
    const seen = [];
    let verdict = '';
    for (const choice of choices) {
      await cdp.evaluate(`
        const b = document.querySelector('#practice-items [data-item] button[data-answer=${JSON.stringify(choice)}]');
        if (!b) return false;
        b.click();
        return true;
      `);
      await cdp.waitFor("document.querySelector('#practice-items [data-item] .result').innerText.indexOf('Wird gepr') === -1", 10000, 'the server verdict').catch(() => {});
      verdict = await cdp.evaluate("return document.querySelector('#practice-items [data-item] .result').innerText.trim()");
      seen.push(`${choice}:${verdict}`);
      if (verdict === 'Richtig.') break;
    }
    const answerRun = await cdp.evaluate(`
      const item = document.querySelector('#practice-items [data-item]');
      return { pressed: item.querySelectorAll('[aria-pressed="true"]').length };
    `);
    await shot(cdp, '08-answered-desktop-light');
    record('L16 an answer is marked by the server and the verdict is shown on screen',
      /^(Richtig\.|Noch nicht richtig)/.test(verdict) && answerRun.pressed >= 1 && seen.length >= 1,
      `${JSON.stringify(seen)}`);
    const answerErrors = errorsSince(cdp, mark);
    record('L17 answering produces no console exception', answerErrors.length === 0, answerErrors[0] || 'clean');

    /*
     * Leave ONE mistake deliberately open, so the badge legs have something true to show. The badge is
     * a promise that the number is real, and the promise is only testable when the number is not zero.
     */
    const correctChoice = (seen.find((s) => s.endsWith(':Richtig.')) || '').split(':')[0];
    const wrongChoice = choices.find((c) => c !== correctChoice);
    if (wrongChoice) {
      await cdp.evaluate(`
        const b = document.querySelector('#practice-items [data-item] button[data-answer=${JSON.stringify(wrongChoice)}]');
        if (b) b.click();
        return true;
      `);
      await softWait(cdp, "document.querySelector('#practice-items [data-item] .result').innerText.indexOf('Wird gepr') === -1", 10000, 'the second verdict');
      await sleep(400);
    }
    /*
     * The badge exists twice and both copies must carry the same number. This runs at DESKTOP width, so
     * it can only assert the sidebar copy is visible: the tabbar's is `display:none` here and reporting
     * its zero width as a pass is the weak version of this leg. The phone copy is asserted where it can
     * actually be seen — see the mobile block's badge-height leg.
     */
    const badges = await cdp.evaluate(`
      const read = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: el.innerText.trim(), hidden: el.hidden, width: Math.round(r.width), background: getComputedStyle(el).backgroundColor };
      };
      return { side: read('mistake-count'), tab: read('mistake-count-tab') };
    `);
    record('L17b BOTH mistakes badges exist, are distinct ids, and show the same number',
      Boolean(badges.side) && Boolean(badges.tab) && badges.side.text === badges.tab.text
        && badges.side.hidden === false && badges.side.width > 0,
      JSON.stringify(badges));
    record('L17c both badges are styled as badges, not as bare text',
      Boolean(badges.side) && badges.side.background !== 'rgba(0, 0, 0, 0)'
        && Boolean(badges.tab) && badges.tab.background !== 'rgba(0, 0, 0, 0)',
      `sidebar ${badges.side && badges.side.background} / tabbar ${badges.tab && badges.tab.background}`);

    /*
     * A CONTROL STYLED AS A BUTTON MUST NOT BE PAINTED AS A LINK. `.lang-btn` is an `<a>` now (it
     * navigates to Einstellungen), and the pinned stylesheet only removes the underline for `.btn` — so
     * it rendered underlined until the shell's own layer said otherwise. Computed style, not markup.
     */
    const controls = await cdp.evaluate(`
      const read = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { decoration: cs.textDecorationLine, tag: el.tagName.toLowerCase(), height: Math.round(el.getBoundingClientRect().height) };
      };
      return { lang: read('#lang-btn'), gear: read('.icon-btn') };
    `);
    record('L17d the topbar controls are not underlined like links',
      Boolean(controls.lang) && controls.lang.decoration === 'none' && Boolean(controls.gear) && controls.gear.decoration === 'none',
      JSON.stringify(controls));

    /* ------------------------------------------------------------ mistakes  */

    await clickSel(cdp, '[data-view="fehler"]');
    await softWait(cdp, "location.hash === '#/fehler'", 8000, 'the Fehler route');
    await softWait(cdp, "!document.getElementById('mistake-list').innerText.includes('Wird geladen')", 12000, 'the mistakes list');
    const fehler = await cdp.evaluate(`
      const badge = document.getElementById('mistake-count');
      const rows = [...document.querySelectorAll('#mistake-list .list-item')];
      const list = document.querySelector('#mistake-list .list');
      return {
        badgeHidden: badge.hidden, badge: badge.innerText.trim(),
        rows: rows.length,
        listWrapper: Boolean(list),
        first: (rows[0]?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        empty: document.getElementById('mistake-list').innerText.includes('Nichts offen'),
        note: (document.getElementById('mistake-note')?.innerText || '').trim().slice(0, 80),
      };
    `);
    await shot(cdp, '09-fehler-desktop-light');
    const apiMistakes = await apiGet(cookie, '/api/v1/practice/mistakes');
    const apiCount = Number(apiMistakes.body?.count ?? -1);
    record('L18 Fehler shows exactly what the server recorded, and its badge agrees',
      fehler.badgeHidden === (apiCount === 0) && fehler.rows === apiCount,
      `screen badge=${fehler.badgeHidden ? 'hidden' : fehler.badge} rows=${fehler.rows}; API count=${apiCount}; "${fehler.note}"`);
    record('L19 a missed item is listed with the LEARNER\'s answer and no correct answer',
      apiCount === 0 || (fehler.first.length > 0 && !/richtig:/i.test(fehler.first)),
      fehler.first || 'no mistakes recorded yet');
    // The design puts the border and radius on `.list`; bare `.list-item` rows render as detached boxes.
    record('L19b the mistake rows sit inside the design\'s list wrapper',
      apiCount === 0 || fehler.listWrapper === true,
      `rows=${fehler.rows} wrapper=${fehler.listWrapper}`);

    /*
     * W13 — SITZUNGEN (D5), RENDERED.
     *
     * The security behaviours have their own six legs against a real database; this is the half a learner can
     * actually reach. A session list nobody can see is not a way to end a session you do not recognise.
     *
     * What is asserted here is what the screen must NOT do as much as what it must: the list must not print a
     * TOKEN (a bearer credential in a screenshot, a log or a support ticket), and the current session must not
     * offer a "Beenden" button — ending the session you are looking at belongs to the deliberate sidebar
     * action, not to a list that could do it by accident.
     */
    await clickSel(cdp, '[data-view="einstellungen"]');
    await softWait(cdp, "location.hash === '#/einstellungen'", 8000, 'Einstellungen');
    await softWait(cdp, "document.querySelectorAll('#session-list .session').length > 0 || document.getElementById('session-list').innerText.includes('Keine')",
      10000, 'the session list');
    const sessions = await cdp.evaluate(`
      const list = document.getElementById('session-list');
      const rows = [...list.querySelectorAll('.session')];
      return {
        rows: rows.length,
        text: list.innerText.replace(/\\s+/g, ' ').trim().slice(0, 240),
        // A token is 32 base64url characters or more with no spaces; the ids are UUIDs and the dates are not.
        looksLikeAToken: /[A-Za-z0-9_-]{32,}/.test(list.innerText),
        revokeButtons: list.querySelectorAll('[data-revoke]').length,
        currentRows: rows.filter((r) => r.innerText.includes('Dieses Gerät')).length,
      };
    `);
    // Scroll the card into view before capturing: a screenshot that does not show what the leg asserts is not
    // evidence, and the first version of these two shots caught the top of the page with the card below the fold.
    await cdp.evaluate(`const card = document.getElementById('session-list'); if (card) card.scrollIntoView({ block: 'center' }); return true;`);
    await sleep(250);
    await shot(cdp, '13n-sessions-desktop-light');
    record('W13 the settings view lists the sessions the server reports',
      sessions.rows >= 1 && sessions.currentRows === 1,
      `${sessions.rows} row(s), ${sessions.currentRows} marked as this device: "${sessions.text.slice(0, 120)}"`);
    record('W13b the session list never prints a token, and offers no way to end the current session',
      !sessions.looksLikeAToken && sessions.revokeButtons === sessions.rows - sessions.currentRows,
      `token-like string present=${sessions.looksLikeAToken}; ${sessions.revokeButtons} revoke button(s) for ${sessions.rows - sessions.currentRows} other row(s)`);

    /*
     * A SECOND SESSION, so the assertions below are about a real choice rather than a one-row list.
     *
     * `fetch` from the page does NOT store the response cookie, so this signs in a "second device" without
     * disturbing the browser's own session — which is exactly the situation the list exists for. Without it,
     * "0 revoke buttons for 0 other rows" would pass even if the button could never appear.
     */
    /*
     * NOTE ON THE WRAPPER: `cdp.evaluate` wraps its argument in a NON-async arrow and relies on
     * `awaitPromise: true`, so a `fetch` must be awaited inside its own async IIFE — top-level `await` in the
     * page body is a SyntaxError. And the comment here is OUTSIDE the template literal, because a backtick
     * inside it would end the string.
     */
    const secondSession = await cdp.evaluate(`
      return (async () => {
        const res = await fetch('/api/auth/sign-in/email', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          /*
           * credentials: 'omit' IS THE WHOLE POINT, and the first version of this leg proved why: a
           * same-origin fetch sends the page's own cookie by default, so the sign-in ROTATED the browser's
           * session (retiring it and issuing a replacement) instead of adding a second one — the list stayed
           * at one row, which is rotation working rather than a defect. Another device is precisely a caller
           * that presents no cookie.
           */
          credentials: 'omit',
          body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(SYNTHETIC.password)} }),
        });
        return { status: res.status };
      })();
    `);
    // Re-enter the view so the list is fetched again with the new session present.
    await clickSel(cdp, '[data-view="heute"]');
    await softWait(cdp, "location.hash === '#/heute'", 8000, 'Heute');
    await clickSel(cdp, '[data-view="einstellungen"]');
    await softWait(cdp, "document.querySelectorAll('#session-list .session').length >= 2", 12000, 'two sessions');
    const withTwo = await cdp.evaluate(`
      const list = document.getElementById('session-list');
      const rows = [...list.querySelectorAll('.session')];
      return {
        rows: rows.length,
        current: rows.filter((r) => r.innerText.includes('Dieses Gerät')).length,
        buttons: list.querySelectorAll('[data-revoke]').length,
      };
    `);
    record('W13c with two devices the list offers to end exactly the other one',
      withTwo.rows === 2 && withTwo.current === 1 && withTwo.buttons === 1,
      `the second sign-in answered ${secondSession.status}; ${withTwo.rows} row(s), ${withTwo.current} current, ${withTwo.buttons} revoke button(s)`);

    // END IT, and prove the list reflects the server rather than the click: one row remains.
    await clickSel(cdp, '#session-list [data-revoke]');
    await softWait(cdp, "document.querySelectorAll('#session-list .session').length === 1", 12000, 'the shortened list');
    const afterRevoke = await cdp.evaluate(`
      const list = document.getElementById('session-list');
      return {
        rows: list.querySelectorAll('.session').length,
        current: [...list.querySelectorAll('.session')].filter((r) => r.innerText.includes('Dieses Gerät')).length,
        state: (document.getElementById('session-state') || {}).innerText || '',
      };
    `);
    // Scroll the card into view before capturing: a screenshot that does not show what the leg asserts is not
    // evidence, and the first version of these two shots caught the top of the page with the card below the fold.
    await cdp.evaluate(`const card = document.getElementById('session-list'); if (card) card.scrollIntoView({ block: 'center' }); return true;`);
    await sleep(250);
    await shot(cdp, '13o-sessions-after-revoke-desktop-light');
    record('W13d ending the other session leaves this device signed in and the list correct',
      afterRevoke.rows === 1 && afterRevoke.current === 1 && /beendet/i.test(afterRevoke.state),
      `${afterRevoke.rows} row(s), ${afterRevoke.current} current; state "${afterRevoke.state.trim()}"`);

    /* --------------------------------------------------------- other views  */

    const viewChecks = [
      ['woerterbuch', '#/woerterbuch', '#dict-results', '10-woerterbuch'],
      ['nachschlagen', '#/nachschlagen', '#guide-index', '11-nachschlagen'],
      ['fortschritt', '#/fortschritt', '#view-fortschritt', '12-fortschritt'],
      ['einstellungen', '#/einstellungen', '#settings-form', '13-einstellungen'],
    ];
    for (const [view, hash, selector, name] of viewChecks) {
      await clickSel(cdp, `[data-view="${view}"]`);
      await softWait(cdp, `location.hash === '${hash}'`, 8000, hash);
      await softWait(cdp, `!document.querySelector('${selector}').innerText.includes('Wird geladen')`, 10000, selector);
      const state = await cdp.evaluate(`
        const view = document.getElementById('view-${view}');
        const box = document.querySelector('${selector}');
        const h = [...view.querySelectorAll('h1,h2,h3')].map((e) => e.innerText.trim()).slice(0, 3);
        return { shown: !view.hidden, text: box.innerText.trim().slice(0, 160), headings: h, height: Math.round(box.getBoundingClientRect().height) };
      `);
      await shot(cdp, `${name}-desktop-light`);
      record(`L20.${view} the ${view} view renders with content`, state.shown && state.height > 40 && state.text.length > 20,
        `${state.headings.join(' | ')}`);
    }

    /*
     * NACHSCHLAGEN — the index, then one document, then back.
     *
     * This is the leg that catches `hidden` losing to the design system's `display:grid`: before the
     * fix, `#guide-body` was on screen from the moment the view opened, "Öffnen" looked like it
     * appended a document below the index, and "Zurück" looked like it did nothing.
     */
    await clickSel(cdp, '[data-view="nachschlagen"]');
    await softWait(cdp, "location.hash === '#/nachschlagen'", 8000, 'Nachschlagen');
    await softWait(cdp, "document.querySelector('#guide-index button[data-guide]')", 12000, 'the guide index');
    const guidesBefore = await cdp.evaluate(`
      const body = document.getElementById('guide-body');
      const index = document.getElementById('guide-index');
      const h = (el) => Math.round(el.getBoundingClientRect().height);
      return { bodyHidden: body.hidden, bodyHeight: h(body), indexHidden: index.hidden, indexHeight: h(index) };
    `);
    await clickSel(cdp, '#guide-index button[data-guide]');
    await softWait(cdp, "document.querySelector('#guide-body .card h3') && !document.querySelector('#guide-body').innerText.includes('Wird geladen')", 12000, 'the guide document');
    const guidesAfter = await cdp.evaluate(`
      const body = document.getElementById('guide-body');
      const index = document.getElementById('guide-index');
      const h = (el) => Math.round(el.getBoundingClientRect().height);
      return { bodyHidden: body.hidden, bodyHeight: h(body), indexHidden: index.hidden, indexHeight: h(index),
        sections: body.querySelectorAll('.card').length, back: Boolean(document.getElementById('guide-back')) };
    `);
    await shot(cdp, '11b-guide-open-desktop-light');
    record('L20b one guide opens at a time: the body is hidden until it has something to show',
      guidesBefore.bodyHidden === true && guidesBefore.bodyHeight === 0 && guidesBefore.indexHeight > 0
        && guidesAfter.bodyHeight > 0 && guidesAfter.sections > 0 && guidesAfter.back,
      `before ${JSON.stringify(guidesBefore)} -> after ${JSON.stringify(guidesAfter)}`);
    record('L20c opening a guide hides the index (the design\'s one-document view)',
      guidesAfter.indexHidden === true && guidesAfter.indexHeight === 0,
      `index hidden=${guidesAfter.indexHidden} height=${guidesAfter.indexHeight}`);
    await clickSel(cdp, '#guide-back');
    await sleep(300);
    const guidesBack = await cdp.evaluate(`
      const h = (id) => Math.round(document.getElementById(id).getBoundingClientRect().height);
      return { body: h('guide-body'), index: h('guide-index') };
    `);
    record('L20d Zurück brings the index back and removes the document',
      guidesBack.index > 0 && guidesBack.body === 0, JSON.stringify(guidesBack));

    /*
     * UEBEN — reached from the dashboard's hero link, and the ONE view the first version of this check
     * never opened. That gap mattered: nine seeded sets carry the generator's placeholder title, and this
     * catalogue was the place where one still reached the screen after the skill views were fixed.
     */
    await nav(cdp, `${base}/app/#/ueben`);
    await softWait(cdp, "document.querySelector('#task-list') && !document.querySelector('#task-list').innerText.includes('Wird geladen')", 12000, 'the Üben catalogue');
    await sleep(300);
    const ueben = await cdp.evaluate(`
      const box = document.getElementById('task-list');
      return {
        shown: !document.getElementById('view-ueben').hidden,
        cards: box.querySelectorAll('.card').length,
        headings: [...box.querySelectorAll('h3')].map((h) => h.innerText.trim()).slice(0, 10),
        full: box.innerText.trim(),
        recommendation: (document.getElementById('practice-next')?.innerText || '').replace(/\\\\s+/g, ' ').trim().slice(0, 140),
      };
    `);
    await shot(cdp, '13b-ueben-desktop-light');
    record('L20h Üben renders the whole catalogue, from the server',
      ueben.shown && ueben.cards >= 2 && ueben.full.length > 40,
      `${ueben.cards} cards; recommendation "${ueben.recommendation}"; headings ${JSON.stringify(ueben.headings.slice(0, 4))}`);
    record('L20i no catalogue entry is titled with a seed placeholder',
      !ueben.headings.some((t) => /^(LV|SB|HV)\d+\s+\d+$/.test(t)) && !/^(LV|SB|HV)\d+\s+\d+$/.test(ueben.full),
      JSON.stringify(ueben.headings));

    /* ---------------------------------------------------------------- SCHREIBEN */

    /*
     * THE WRITING JOURNEY — the gap that had a NAME but no screen.
     *
     * Four ledger rows recorded writing as UNPROVEN: `draft-session`, `writing-surface`, the writing
     * result screen and the mock-outcome view were deleted with the SPA, and `public/app/` had no writing
     * view at all — the Schreiben section listed the six seeded prompts and nothing could open one. These
     * legs are the rendered half of PILOT-05; the API half (an attempt bound to the task the learner
     * opened, and `task_not_servable` for anything else) is `owned-api-check` leg
     * `attempt-binds-the-servable-task-the-learner-opened`.
     *
     * What is asserted is what the learner must SEE, and the last leg is the one that matters most: an
     * assessment that has not happened must never appear as a score. That is the property the deleted
     * `mock-outcome-browser-check` held, tested there against the mock view and here against the real
     * submission path.
     */
    await nav(cdp, `${base}/app/#/schreiben`);
    await softWait(cdp, "document.querySelector('#skill-schreiben [data-write]')", 12000, 'the Schreiben catalogue');
    await sleep(250);
    const schreiben = await cdp.evaluate(`
      const box = document.getElementById('skill-schreiben');
      const button = box.querySelector('[data-write]');
      return {
        shown: !document.getElementById('view-schreiben').hidden,
        tasks: box.querySelectorAll('[data-write]').length,
        binding: button ? { task: button.dataset.write, version: button.dataset.version, rubric: button.dataset.rubric } : null,
        rubrics: [...box.querySelectorAll('[data-write]')].map((b) => b.dataset.rubric),
        versions: [...box.querySelectorAll('[data-write]')].map((b) => b.dataset.version),
        text: box.innerText.trim().slice(0, 200),
      };
    `);
    await shot(cdp, '13c-schreiben-catalogue-desktop-light');
    /*
     * THE BINDING IS THE CONTRACT, NOT A DECORATION. Each card carries the task, its VERSION and the rubric
     * it declares, and the view binds all four when it creates an attempt. Since D4/R11 the rubric must be
     * the CURRENT one (telc B1's three criteria) — the retired four-criterion rubric is still in the
     * catalogue for old attempts, so a card offering it would be a real regression rather than a detail.
     * The version matters for the same reason: task v1 is bound to the retired rubric, v2 to the current one.
     */
    record('W1 Schreiben lists writing tasks, each carrying its own task binding',
      schreiben.shown && schreiben.tasks >= 1 && Boolean(schreiben.binding?.task) && Boolean(schreiben.binding?.version),
      `${schreiben.tasks} task(s); first binding ${JSON.stringify(schreiben.binding)}`);
    record('W1b every writing card binds the CURRENT rubric, and never the retired one',
      schreiben.rubrics.length > 0
        && schreiben.rubrics.every((r) => r === 'writing.telc-b1')
        && schreiben.versions.every((v) => v === 'v2'),
      `rubrics ${JSON.stringify([...new Set(schreiben.rubrics)])}; versions ${JSON.stringify([...new Set(schreiben.versions)])}`);
    record('W2 no placeholder is shown as a writing task title',
      !/^(LV|SB|HV)\d+\s+\d+$/.test(schreiben.text) && !/writing\.\w+@/.test(schreiben.text),
      schreiben.text.slice(0, 90));

    const openedWriting = await cdp.evaluate(`
      const box = document.getElementById('skill-schreiben');
      box.querySelector('[data-write]').click();
      return true;
    `);
    await softWait(cdp, "document.querySelector('#writing-text')", 12000, 'the writing view');
    await sleep(200);
    const writingView = await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      const state = document.getElementById('writing-state');
      return {
        clicked: ${openedWriting},
        area: Boolean(area) && area.getBoundingClientRect().height > 40,
        leitpunkte: document.querySelectorAll('.leitpunkte li').length,
        state: state ? state.innerText.trim() : null,
        submit: Boolean(document.getElementById('writing-submit')),
      };
    `);
    await shot(cdp, '13d-writing-open-desktop-light');
    record('W3 opening a writing task renders the task, its Leitpunkte and a text field',
      writingView.area && writingView.leitpunkte >= 3 && writingView.submit,
      `${writingView.leitpunkte} Leitpunkt(e); textarea visible=${writingView.area}; submit=${writingView.submit}`);

    // Type a real text, then submit it. `setInputs`-style assignment so the input event fires and the
    // view's autosave path is exercised rather than bypassed.
    const typedText = 'Liebe Anna, ich freue mich sehr über deinen Besuch. Am Samstag habe ich Zeit.';
    await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      area.value = ${JSON.stringify(typedText)};
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return area.value.length;
    `);
    // Wait past the debounce so the draft is saved against a revision before submitting.
    await sleep(1400);
    /*
     * W4 ASKS THE SERVER. The first version asserted only that a HINT existed, and it passed while the
     * autosave never landed at all — a draft at revision 1 with an empty text, discovered two legs later
     * when the reload could not restore anything. A save is only a save if the server agrees.
     */
    const afterType = await cdp.evaluate(`return (async () => {
      const index = await fetch('/api/v1/attempts?open=1').then((r) => r.json()).catch(() => null);
      const first = index && Array.isArray(index.attempts) ? index.attempts[0] : null;
      const loaded = first ? await fetch('/api/v1/attempts/' + first.id).then((r) => r.json()).catch(() => null) : null;
      return {
        hint: document.getElementById('writing-hint')?.innerText || '',
        state: document.getElementById('writing-state')?.innerText || '',
        serverText: loaded && typeof loaded.text === 'string' ? loaded.text : null,
        serverRevision: first ? first.revision : null,
      };
    })();`);
    record('W4 the text reaches the SERVER while typing, at a new revision',
      typeof afterType.serverText === 'string' && afterType.serverText === typedText && afterType.serverRevision >= 2,
      `server holds ${afterType.serverText === null ? 'nothing' : afterType.serverText.length + ' char(s)'} at revision ${afterType.serverRevision}; hint "${afterType.hint.trim().slice(0, 40)}"`);

    await cdp.evaluate(`document.getElementById('writing-submit').click(); return true;`);
    await softWait(cdp, "document.getElementById('writing-state') && !/Noch nichts abgegeben/.test(document.getElementById('writing-state').innerText)", 15000, 'the submitted state');
    await sleep(400);
    const afterSubmit = await cdp.evaluate(`
      const state = document.getElementById('writing-state');
      const text = state ? state.innerText : '';
      const rect = state ? state.getBoundingClientRect() : null;
      return {
        state: text.trim().slice(0, 300),
        bodyText: document.body.innerText,
        submittedVisible: Boolean(document.querySelector('.submitted-text, .submitted')),
        /*
         * ON SCREEN, not merely in the DOM. The first version of this leg asserted only that the state
         * had TEXT — and the screenshot showed it sitting BELOW THE FOLD, so the learner pressed Abgeben
         * and saw nothing happen. "The element exists" is not "the learner can see it"; this project has
         * that lesson recorded twice already, and it was learned a third time here.
         */
        onScreen: Boolean(rect) && rect.top < window.innerHeight && rect.bottom > 0,
        rectTop: rect ? Math.round(rect.top) : null,
        viewport: window.innerHeight,
      };
    `);
    await shot(cdp, '13e-writing-submitted-desktop-light');
    /*
     * THE LEG THAT MATTERS. A queued or failed assessment must read as "wird geprüft" / "unbewertet" and
     * NEVER as a number, a fraction or a verdict. The patterns are the ones a fabricated score would
     * have to use, so this fails on the defect rather than on a spelling.
     */
    const fabricated = afterSubmit.bodyText.match(/(\b\d{1,2}\s*\/\s*45\b)|(\b\d{1,2}\s*\/\s*15\b)|(Bestanden)|(Nicht bestanden)|(Note\s*[:=]\s*\d)/i);
    record('W5 a submitted text shows an unassessed state, never a score or a pass line',
      afterSubmit.state.length > 0 && !fabricated,
      `state "${afterSubmit.state.slice(0, 110)}"${fabricated ? `; FABRICATED: ${fabricated[0]}` : '; no score, no fraction, no pass line'}`);
    record('W6 the submitted state is ON SCREEN, not below the fold',
      afterSubmit.onScreen,
      `state top=${afterSubmit.rectTop}px of ${afterSubmit.viewport}px viewport`);
    record('W6b the submitted text stays readable by the learner',
      afterSubmit.submittedVisible || afterSubmit.bodyText.includes(typedText.slice(0, 30)),
      `submitted text on screen=${afterSubmit.submittedVisible}`);

    await viewport(cdp, 390, 844, true);
    await sleep(250);
    const writingPhone = await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      const submit = document.getElementById('writing-submit');
      const rect = area ? area.getBoundingClientRect() : null;
      return {
        areaWidth: rect ? Math.round(rect.width) : 0,
        overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
        submitVisible: Boolean(submit) && submit.getBoundingClientRect().width > 0,
      };
    `);
    await shot(cdp, '13f-writing-submitted-phone-light');
    record('W7 the writing view fits a phone without horizontal overflow',
      writingPhone.areaWidth > 100 && !writingPhone.overflows && writingPhone.submitVisible,
      `textarea ${writingPhone.areaWidth}px wide; page overflow=${writingPhone.overflows}; submit visible=${writingPhone.submitVisible}`);
    await viewport(cdp, 1440, 900, false);
    await sleep(150);

    /*
     * W8 — AN UNFINISHED LETTER SURVIVES A RELOAD.
     *
     * This is the gap that had a name and no vehicle: reload mid-letter and the textarea came back EMPTY,
     * attached to a brand-new attempt, while the learner's writing sat in the database with nothing
     * pointing at it. The rendered proof is the only one that counts here — the API leg
     * (`an-unfinished-attempt-is-resumable-and-a-submitted-one-is-not`) proves the route, and this proves
     * the VIEW uses it.
     *
     * A SECOND TASK is opened deliberately: the first one is already submitted, and a submitted attempt
     * must NOT be resumable. Resuming the submitted task would also pass a naive "text is there" check
     * while being the wrong behaviour, so the leg asserts both directions:
     *   * an unfinished draft comes back after a real page reload;
     *   * the submitted task does NOT offer its snapshot as resumable text.
     */
    const secondDraftText = 'Sehr geehrte Damen und Herren, ich schreibe wegen des Umzugs.';
    /*
     * A HELPER, BECAUSE THE INLINE VERSION FAILED OPAQUELY. The first attempt polled for "more than one
     * writing button" and then clicked index 1, and the browser answered
     * `TypeError: Cannot read properties of undefined (reading 'click')` — a failure with no count, no
     * view state and no way to tell whether the catalogue had not rendered, had rendered one card, or the
     * old document was still being evaluated. This helper reports what it SAW when it cannot proceed.
     */
    const openWritingTask = async (cdp, index, label, { reload = false } = {}) => {
      if (reload) {
        /*
         * A REAL RELOAD, because `Page.navigate` to the SAME url (hash included) does not re-route: the
         * diagnostic this helper prints showed the previously opened writing view still on screen with
         * zero catalogue buttons, which is correct SPA behaviour and useless as a reload test.
         */
        await cdp.send('Page.reload', { ignoreCache: false });
      } else {
        // A DIFFERENT hash first: `#/schreiben` → `#/schreiben` is not a route change, so the writing view
        // opened earlier would stay. Two navigations make the router render the catalogue again.
        await nav(cdp, `${base}/app/#/heute`);
        await sleep(150);
        await nav(cdp, `${base}/app/#/schreiben`);
      }
      let seen = null;
      for (let i = 0; i < 60; i += 1) {
        seen = await cdp.evaluate(`
          const box = document.getElementById('skill-schreiben');
          const buttons = box ? box.querySelectorAll('[data-write]') : [];
          return {
            shown: Boolean(document.getElementById('view-schreiben')) && !document.getElementById('view-schreiben').hidden,
            count: buttons.length,
            tasks: [...buttons].map((b) => b.dataset.write),
            text: (box ? box.innerText : '').trim().slice(0, 80),
          };
        `);
        if (seen.count > index) break;
        await sleep(250);
      }
      if (!seen || seen.count <= index) {
        throw new Error(`${label}: expected at least ${index + 1} writing task(s), saw ${seen ? seen.count : 'nothing'}`
          + ` (view shown=${seen?.shown}; tasks=${JSON.stringify(seen?.tasks || [])}; text "${seen?.text || ''}")`);
      }
      await cdp.evaluate(`
        document.querySelectorAll('#skill-schreiben [data-write]')[${index}].click();
        return true;
      `);
      await softWait(cdp, "document.querySelector('#writing-text')", 12000, `${label}: the writing view`);
      return seen;
    };

    await openWritingTask(cdp, 1, 'W8 second task (unfinished draft)');
    await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      area.value = ${JSON.stringify(secondDraftText)};
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(1400); // past the autosave debounce
    const beforeReload = await cdp.evaluate(`
      // Ask the SERVER what it holds, not just the textarea: a draft that exists only on screen is the
      // defect this leg is about, and the DOM cannot tell the two apart. The harness wraps this body in a
      // plain function, so the fetch calls need their own async wrapper (it awaits the returned promise).
      return (async () => {
        const index = await fetch('/api/v1/attempts?open=1').then((r) => r.json()).catch(() => null);
        const first = index && Array.isArray(index.attempts) ? index.attempts[0] : null;
        const loaded = first ? await fetch('/api/v1/attempts/' + first.id).then((r) => r.json()).catch(() => null) : null;
        return {
          state: document.getElementById('writing-state')?.innerText || '',
          value: document.getElementById('writing-text')?.value || '',
          server: index ? index.attempts.map((a) => ({ id: a.id.slice(0, 8), task: a.task_id, rev: a.revision })) : null,
          serverText: loaded && typeof loaded.text === 'string' ? loaded.text.length : null,
        };
      })();
    `);
    await shot(cdp, '13g-writing-draft-before-reload-desktop-light');

    await openWritingTask(cdp, 1, 'W8 after reload', { reload: true });
    await softWait(cdp, "document.querySelector('#writing-text')", 12000, 'the resuming writing view');
    await sleep(600);
    const afterReload = await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      const state = document.getElementById('writing-state');
      return {
        value: area ? area.value : null,
        state: state ? state.innerText.trim().slice(0, 160) : null,
        newAttemptHint: /Noch nichts abgegeben/.test(state ? state.innerText : ''),
      };
    `);
    await shot(cdp, '13h-writing-draft-after-reload-desktop-light');
    record('W8 an unfinished draft comes back after a reload',
      afterReload.value === secondDraftText,
      `before reload DOM=${beforeReload.value.length} server=${beforeReload.serverText} ${JSON.stringify(beforeReload.server)}; after reload DOM=${(afterReload.value || '').length} char(s); state "${afterReload.state}"`);

    // The submitted task keeps its snapshot: opening it again must NOT resume it as editable text.
    await openWritingTask(cdp, 0, 'W8b submitted task again');
    await softWait(cdp, "document.querySelector('#writing-text')", 12000, 'the first writing view again');
    await sleep(400);
    const submittedAgain = await cdp.evaluate(`return { value: document.getElementById('writing-text')?.value ?? null };`);
    record('W8b a SUBMITTED letter is not offered as a resumable draft',
      submittedAgain.value === '' || submittedAgain.value === null,
      `text area after reopening the submitted task: ${JSON.stringify((submittedAgain.value || '').slice(0, 40))}`);

    /*
     * W9 — A RESUMED DRAFT CAN BE ABANDONED.
     *
     * Automatic resume is a trap on its own: a learner who wants to start the letter again cannot, because
     * the old text always comes back and the only way out is to overwrite it and submit. The affordance is
     * small and the assertions are specific, because "a button exists" would be worthless here:
     *   * the button is offered ONLY when a draft was resumed (a blank new attempt has nothing to abandon);
     *   * pressing it empties the field;
     *   * and the SERVER agrees: the abandoned attempt is gone from the open index and the fresh one is at
     *     revision 1 with no text. A UI that only cleared the textarea would leave the old letter waiting
     *     to be resumed again on the next reload — which is the bug, not the fix.
     */
    await openWritingTask(cdp, 1, 'W9 resumable draft again', { reload: true });
    await sleep(400);
    const beforeNew = await cdp.evaluate(`
      const button = document.getElementById('writing-new');
      return {
        value: document.getElementById('writing-text')?.value || '',
        offered: Boolean(button) && !button.hidden && button.getBoundingClientRect().width > 0,
      };
    `);
    record('W9 a resumed draft offers a way to start over',
      beforeNew.offered && beforeNew.value.length > 0,
      `button offered=${beforeNew.offered} with ${beforeNew.value.length} char(s) resumed`);

    const discardClick = cdp.evaluate(`document.getElementById('writing-new').click(); return true;`);
    for (let n = 0; n < 40 && !cdp.events.some(e => e.method === 'Page.javascriptDialogOpening'); n++) await sleep(50);
    await cdp.send('Page.handleJavaScriptDialog', { accept: true });
    await discardClick;
    await softWait(cdp, "document.getElementById('writing-text') && document.getElementById('writing-text').value === ''", 12000, 'the cleared field');
    await sleep(900); // let the create land and the state settle
    const afterNew = await cdp.evaluate(`
      return (async () => {
        const index = await fetch('/api/v1/attempts?open=1').then((r) => r.json()).catch(() => null);
        const mine = index && Array.isArray(index.attempts)
          ? index.attempts.filter((a) => a.task_id === 'writing.du.geburtstag-eines-freundes') : [];
        const loaded = mine.length ? await fetch('/api/v1/attempts/' + mine[0].id).then((r) => r.json()).catch(() => null) : null;
        return {
          value: document.getElementById('writing-text')?.value || '',
          state: document.getElementById('writing-state')?.innerText.trim().slice(0, 120) || '',
          openForTask: mine.length,
          serverText: loaded && typeof loaded.text === 'string' ? loaded.text : null,
          serverRevision: mine.length ? mine[0].revision : null,
        };
      })();
    `);
    await shot(cdp, '13i-writing-start-fresh-desktop-light');
    record('W9b starting over leaves the OLD letter unreachable on the server',
      afterNew.value === '' && afterNew.serverText === '' && afterNew.openForTask === 1,
      `field empty=${afterNew.value === ''}; server text=${JSON.stringify(afterNew.serverText)} at revision ${afterNew.serverRevision}; `
        + `${afterNew.openForTask} open attempt(s) for the task; state "${afterNew.state}"`);

    /*
     * W11 — A GRADED LETTER SHOWS THE telc BANDS, THE REQUIRED LABEL, AND NO TOTAL.
     *
     * The worker's band contract landed in this slice; this is the half a learner actually sees. The stack's
     * worker is RUNNING here (unlike W10, which stops it to arrange a failure), so the job is graded within
     * the view's polling window.
     *
     * The assertions are the decision's own words: three criteria with a band each, evidence that appears in
     * the letter the learner wrote, the label that says this is practice feedback and NOT an official
     * assessment — and no total of 45 anywhere, because R15 is still open and the server stores nothing
     * numeric so that this screen cannot settle it by accident.
     */
    await openWritingTask(cdp, 2, 'W11 a fourth task, graded');
    await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      area.value = ${JSON.stringify('Liebe Frau Berger, ich bedanke mich für den Kurs. Leider konnte ich zweimal nicht teilnehmen, weil ich krank war. Können Sie mir die Unterlagen schicken?')};
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(1400);
    await cdp.evaluate(`document.getElementById('writing-submit').click(); return true;`);
    // The view polls for the result; wait for the graded state rather than a fixed sleep.
    await softWait(cdp, "/Übungsfeedback nach den telc-Kriterien/.test(document.getElementById('writing-state').innerText)",
      30000, 'the graded band result');
    await sleep(300);
    const graded = await cdp.evaluate(`
      const state = document.getElementById('writing-state');
      const text = state ? state.innerText : '';
      return {
        state: text.replace(/\\s+/g, ' ').trim().slice(0, 400),
        bands: [...document.querySelectorAll('#writing-state .band')].map((b) => b.innerText.trim()),
        criteria: [...document.querySelectorAll('#writing-state .criterion')].length,
        evidence: [...document.querySelectorAll('#writing-state .evidence')].map((e) => e.innerText.trim()),
        body: document.body.innerText,
      };
    `);
    await shot(cdp, '13l-writing-graded-bands-desktop-light');
    record('W11 a graded letter renders one band per telc criterion, with the required label',
      graded.criteria === 3 && graded.bands.length === 3
        && graded.bands.every((b) => ['A', 'B', 'C', 'D'].includes(b))
        && graded.state.includes('Übungsfeedback nach den telc-Kriterien – keine offizielle Bewertung'),
      `${graded.criteria} criterion row(s), bands ${JSON.stringify(graded.bands)}; state "${graded.state.slice(0, 120)}"`);
    record('W11b the evidence shown is the learner own sentence, quoted back',
      graded.evidence.length === 3 && graded.evidence.every((quote) => quote.length > 0 && graded.body.includes(quote)),
      `${graded.evidence.length} quote(s), first ${JSON.stringify((graded.evidence[0] || '').slice(0, 60))}`);
    const fabricatedTotal = graded.body.match(/(\b\d{1,2}\s*\/\s*45\b)|(Bestanden)|(Nicht bestanden)|(\b\d{1,2}\s*von\s*15\b)/i);
    record('W11c no total, no fraction and no pass line appears with the bands',
      !fabricatedTotal,
      fabricatedTotal ? `FABRICATED: ${fabricatedTotal[0]}` : 'no score, no fraction, no pass line');

    /*
     * W12 — A BAND IS EXPLAINED, AND THE EXPLANATION SAYS WHAT IT IS.
     *
     * A bare "B" is not feedback a learner can act on. The descriptors come from the RUBRIC through the API —
     * not from a copy in this client, which would be a second text free to drift from the one the grader was
     * validated against.
     *
     * The second assertion is the one that matters for honesty: the wording is provisional and UNREVIEWED
     * (E-01 has not happened), and the note that says so — including that these are not the examination
     * provider's official words — must travel WITH the text, because a screen cannot label what it was not
     * told.
     */
    const rubricPanel = await cdp.evaluate(`
      const details = document.getElementById('writing-rubric');
      if (details) details.open = true;
      const body = document.getElementById('writing-rubric-body');
      const full = body ? body.innerText : '';
      return {
        present: Boolean(details),
        rows: body ? body.querySelectorAll('.rubric-criteria > li').length : 0,
        bands: body ? [...body.querySelectorAll('.rubric-bands > li')].length : 0,
        // Read the status from the FULL text and log an excerpt: truncating first made the status line fall
        // outside the captured slice, so the leg failed on its own logging rather than on the screen.
        status: (full.match(/Prüfstatus:\\s*(\\S+)/) || [])[1] || null,
        provisional: /vorläufig/i.test(full) && /nicht die offizielle Formulierung/i.test(full),
        text: full.replace(/\\s+/g, ' ').trim().slice(0, 200),
      };
    `);
    await cdp.evaluate(`
      const details = document.getElementById('writing-rubric');
      if (details) details.scrollIntoView({ block: 'center' });
      return true;
    `);
    await sleep(250);
    await shot(cdp, '13m-writing-rubric-panel-desktop-light');
    record('W12 the marking scheme is available and explains every band',
      rubricPanel.present && rubricPanel.rows === 3 && rubricPanel.bands === 12,
      `${rubricPanel.rows} criterion row(s), ${rubricPanel.bands} band explanation(s); panel "${rubricPanel.text.slice(0, 90)}"`);
    record('W12b the wording is labelled provisional and not the provider\'s own',
      rubricPanel.provisional && rubricPanel.status === 'unreviewed',
      `provisional note present=${rubricPanel.provisional}; review status "${rubricPanel.status}"`);

    /*
     * W10 — THE FAILED ASSESSMENT, RENDERED. The property the deleted `mock-outcome-browser-check` held, on
     * the real submission path — and it had never been SEEN: the view renders "Unbewertet" with the failure
     * code, keeps the text and offers a retry, while every previous leg ran against a stub grader that always
     * SUCCEEDS. Written, reviewed by eye, unproven.
     *
     * IT IS MADE DETERMINISTIC BY STOPPING THE WORKER FIRST. Otherwise the claim race decides the outcome:
     * the worker could claim and grade the job while the check is arranging the failure, and the leg would
     * flake in exactly the way that teaches people to distrust a suite. With the worker stopped the job stays
     * `queued`, the database update is the only thing that can change it, and then the retry is queued and
     * stays queued for the same reason.
     *
     * The submission is identified through the DOM (`data-submission-id` on the state element) rather than by
     * guessing from the database: a check that guesses is a check that lies when the guess is close.
     */
    compose(['stop', 'worker']);
    try {
      await openWritingTask(cdp, 2, 'W10 third task (failed assessment)');
      await cdp.evaluate(`
        const area = document.getElementById('writing-text');
        area.value = ${JSON.stringify('Sehr geehrte Damen und Herren, hiermit kündige ich meinen Vertrag.')};
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `);
      await sleep(1400); // past the autosave debounce so there is a revision to submit
      await cdp.evaluate(`document.getElementById('writing-submit').click(); return true;`);
      await softWait(cdp, "document.getElementById('writing-state')?.dataset.submissionId", 15000, 'a submission receipt');
      const queuedState = await cdp.evaluate(`
        const state = document.getElementById('writing-state');
        return { submissionId: state ? state.dataset.submissionId : null, text: state ? state.innerText.trim().slice(0, 120) : '' };
      `);
      record('W10 a submission is named while it waits for assessment',
        Boolean(queuedState.submissionId) && /läuft|geprüft|Abgegeben/i.test(queuedState.text),
        `submission ${String(queuedState.submissionId).slice(0, 8)}…; state "${queuedState.text}"`);

      // Arrange the failure in the database the stack itself uses.
      compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'hatoove', '-c',
        `UPDATE hatoove.jobs SET status = 'failed', failure_code = 'grader_unavailable' WHERE submission_id = '${queuedState.submissionId}';`,
        '-c',
        `DELETE FROM hatoove.assessments WHERE submission_id = '${queuedState.submissionId}';`]);
      // The view polls; give it one or two cycles to read the new state.
      await softWait(cdp, "/Unbewertet/.test(document.getElementById('writing-state').innerText)", 20000, 'the unassessed state');
      await sleep(300);
      const failedState = await cdp.evaluate(`
        const state = document.getElementById('writing-state');
        const retry = document.getElementById('writing-retry');
        return {
          text: state ? state.innerText.trim() : '',
          body: document.body.innerText,
          retryOffered: Boolean(retry) && retry.getBoundingClientRect().width > 0,
          submittedVisible: Boolean(document.querySelector('.submitted-text, .submitted')),
        };
      `);
      await shot(cdp, '13j-writing-unbewertet-desktop-light');
      const fabricatedFail = failedState.body.match(/(\b\d{1,2}\s*\/\s*45\b)|(\b\d{1,2}\s*\/\s*15\b)|(Bestanden)|(Nicht bestanden)|(Note\s*[:=]\s*\d)/i);
      record('W10b a failed assessment renders UNBEWERTET, with the code and the text, and never a score',
        /Unbewertet/.test(failedState.text) && /grader_unavailable/.test(failedState.text) && !fabricatedFail,
        `state "${failedState.text.replace(/\s+/g, ' ').slice(0, 130)}"${fabricatedFail ? `; FABRICATED: ${fabricatedFail[0]}` : '; no score, no fraction, no pass line'}`);
      record('W10c the failed assessment offers a retry and keeps the letter readable',
        failedState.retryOffered && failedState.submittedVisible,
        `retry button visible=${failedState.retryOffered}; submitted text visible=${failedState.submittedVisible}`);

      // The retry re-queues: with the worker still stopped it must settle on "waiting", not on a verdict.
      await cdp.evaluate(`document.getElementById('writing-retry').click(); return true;`);
      await sleep(2500);
      const afterRetry = await cdp.evaluate(`return { text: document.getElementById('writing-state')?.innerText.trim().slice(0, 140) || '' };`);
      record('W10d retrying re-queues the assessment rather than inventing a result',
        /läuft|geprüft|Abgegeben/i.test(afterRetry.text) && !/Unbewertet/.test(afterRetry.text) && !/\/\s*45/.test(afterRetry.text),
        `state "${afterRetry.text.replace(/\s+/g, ' ')}"`);
      await shot(cdp, '13k-writing-retry-desktop-light');
    } finally {
      // Leave the stack as it was found: a later leg must not inherit a stopped worker.
      compose(['start', 'worker']);
    }

    /* ------------------------------------------- no learner state in the browser */

    /*
     * THE REPLACEMENT VEHICLE for `progress-scope-check`, which tested that the retired FILE blob was
     * account-scoped and is deleted with the route it drove (see RETIRED-CHECKS.md). In the new
     * architecture the property to hold is different and stronger: the client keeps NO learner state in
     * the browser at all, so there is no blob left to scope, to leak between accounts, or to disagree
     * with the database. Checked here, at the END of the journey, after a registration, a sign-in, an
     * answered item and several view changes — the point where a caching client would have written
     * something. `indexedDB` cannot be enumerated synchronously and is NOT inspected; the shell names
     * no web-storage API at all — the retired SPA's `app-shell-check.mjs` S4 asserted that from the
     * source side, and S4 is gone with the SPA, so this leg is now the only vehicle for the property.
     */
    const storage = await cdp.evaluate(`
      const dump = (store) => {
        const out = {};
        for (let i = 0; i < store.length; i++) { const k = store.key(i); out[k] = String(store.getItem(k)).slice(0, 40); }
        return out;
      };
      return { local: dump(localStorage), session: dump(sessionStorage), localCount: localStorage.length, sessionCount: sessionStorage.length };
    `);
    await shot(cdp, '19-heute-desktop-light-after-journey');
    record('L30 the client kept NOTHING in web storage across the whole journey',
      storage.localCount === 0 && storage.sessionCount === 0,
      JSON.stringify(storage));

    /* --------------------------------------------------- the design components */

    /*
     * TWO REPLACEMENTS FOR THE RETIRED SPA BROWSER CHECKS, written BEFORE those checks are deleted —
     * the ledger forbids deleting a check whose property has no new vehicle.
     *
     * (1) `provider-config-browser-check` asserted "the Settings view offers no provider field". The
     *     property survives the SPA; the vehicle is the shell's own settings screen.
     * (2) `account-ui-browser-check` asserted "the explanation-language setting does not translate the
     *     German menu". Same property, new screen — and it is asserted where it can actually break: the
     *     nav labels are read before and after a real change through the real form, and the shell must
     *     stay LTR even when Arabic is chosen.
     */
    await clickSel(cdp, '[data-view="einstellungen"]');
    await softWait(cdp, "location.hash === '#/einstellungen'", 8000, 'Einstellungen');
    await sleep(400);
    const providerField = await cdp.evaluate(`
      const view = document.getElementById('view-einstellungen');
      const fields = [...view.querySelectorAll('input, select, textarea')].map((el) => ({
        id: el.id, name: el.getAttribute('name') || '', type: el.type,
        label: (view.querySelector('label[for="' + el.id + '"]')?.innerText || '').trim(),
        placeholder: el.getAttribute('placeholder') || '',
      }));
      const text = view.innerText.toLowerCase();
      const banned = ['provider', 'api-key', 'api key', 'apiKey', 'schlüssel', 'model', 'modell'];
      return {
        fields,
        offenders: fields.filter((f) => banned.some((b) => (f.id + ' ' + f.name + ' ' + f.label + ' ' + f.placeholder + ' ' + f.type).toLowerCase().includes(b.toLowerCase()))),
        textOffenders: banned.filter((b) => text.includes(b.toLowerCase())),
      };
    `);
    record('L31 the settings screen offers no provider, key or model field',
      providerField.offenders.length === 0 && providerField.textOffenders.length === 0,
      `${providerField.fields.length} field(s): ${JSON.stringify(providerField.fields.map((f) => f.id))}; offenders ${JSON.stringify(providerField.offenders)} ${JSON.stringify(providerField.textOffenders)}`);

    const navBefore = await cdp.evaluate(`
      return [...document.querySelectorAll('.side .nav a, .tabbar a')].map((a) => a.innerText.trim());
    `);
    await cdp.evaluate(`
      const sel = document.getElementById('language');
      sel.value = 'ar';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await clickSel(cdp, '#save-settings');
    await softWait(cdp, "document.getElementById('settings-state').innerText.includes('Gespeichert')", 10000, 'the settings save');
    await sleep(400);
    const afterLanguage = await cdp.evaluate(`
      const sel = document.getElementById('language');
      const arOption = [...sel.options].find((o) => o.value === 'ar');
      return {
        saved: sel.value,
        htmlDir: document.documentElement.getAttribute('dir'),
        bodyDir: getComputedStyle(document.body).direction,
        nav: [...document.querySelectorAll('.side .nav a, .tabbar a')].map((a) => a.innerText.trim()),
        langLabel: (document.getElementById('lang-label')?.innerText || '').trim(),
        optionLang: arOption ? arOption.getAttribute('lang') : null,
        optionDir: arOption ? arOption.getAttribute('dir') : null,
      };
    `);
    await shot(cdp, '20-einstellungen-arabic-desktop-light');
    record('L32 choosing Arabic changes the EXPLANATION language and leaves the German menu alone',
      afterLanguage.saved === 'ar' && JSON.stringify(afterLanguage.nav) === JSON.stringify(navBefore)
        && afterLanguage.bodyDir === 'ltr' && afterLanguage.htmlDir === null
        && afterLanguage.optionLang === 'ar' && afterLanguage.optionDir === 'rtl'
        // ...and the topbar says so, without waiting for a navigation: the label is the learner's only
        // confirmation that the change took effect. It did NOT update, which this leg caught.
        && afterLanguage.langLabel.includes('العربية'),
      `saved=${afterLanguage.saved}; nav identical=${JSON.stringify(afterLanguage.nav) === JSON.stringify(navBefore)}; `
        + `body direction=${afterLanguage.bodyDir}; html dir=${afterLanguage.htmlDir}; ar option lang/dir=${afterLanguage.optionLang}/${afterLanguage.optionDir}; lang-label="${afterLanguage.langLabel}"`);
    // Put it back, so the dark-mode and mobile legs below see the default German explanation language.
    await cdp.evaluate(`
      const sel = document.getElementById('language');
      sel.value = 'de';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await clickSel(cdp, '#save-settings');
    await sleep(600);

    await clickSel(cdp, '[data-view="heute"]');
    await softWait(cdp, "location.hash === '#/heute'", 8000, 'Heute');
    const components = await cdp.evaluate(`
      const stats = [...document.querySelectorAll('#view-heute .stat-row .stat')];
      const tops = new Set(stats.map((s) => Math.round(s.getBoundingClientRect().top)));
      const gauge = document.querySelector('#view-heute .gauge .bar');
      return {
        statCount: stats.length,
        statRows: tops.size,
        statRowClass: Boolean(document.querySelector('#view-heute .stat-row')),
        // The design's pass-line/band markers must NOT be present: no pass prediction.
        band: Boolean(document.querySelector('.bar.band, .bar s')),
        warn: Boolean(document.querySelector('.mini.warn')),
        heroKicker: (document.getElementById('next-kicker')?.innerText || '').trim(),
      };
    `);
    record('L20e the answer tiles use the design\'s stat row (side by side, not stacked)',
      components.statRowClass && components.statCount === 2 && components.statRows === 1,
      JSON.stringify(components));
    record('L20f nothing renders a pass line, a band or a warn threshold',
      components.band === false && components.warn === false, JSON.stringify(components));
    record('L20g the section chip is German, not the database code',
      !/\\b(LV|SB|HV)\\b/.test(components.heroKicker), `kicker="${components.heroKicker}"`);

    /* --------------------------------------------------------------- mobile */

    await viewport(cdp, 390, 844, true);
    mark = cdp.events.length;
    await nav(cdp, `${base}/app/`);
    await softWait(cdp, "document.querySelector('#view-heute') && !document.querySelector('#view-heute').hidden", 15000, 'Heute on mobile');
    await sleep(600);
    const mobile = await cdp.evaluate(`
      const side = document.querySelector('.side');
      const tabbar = document.querySelector('.tabbar');
      const links = [...tabbar.querySelectorAll('a')];
      const rows = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
      const tb = tabbar.getBoundingClientRect();
      const style = getComputedStyle(tabbar);
      const content = document.querySelector('.content').getBoundingClientRect();
      const badge = document.getElementById('mistake-count-tab');
      return {
        sideShown: side.getBoundingClientRect().width > 0,
        tabbarShown: style.display !== 'none' && tb.height > 0,
        tabbarHeight: Math.round(tb.height),
        tabbarLinks: links.length,
        tabbarRows: rows.size,
        display: style.display,
        scrollable: style.overflowX === 'auto' || style.overflowX === 'scroll',
        scrollWidth: Math.round(tabbar.scrollWidth),
        clientWidth: Math.round(tabbar.clientWidth),
        // A fixed bar must not sit on top of the content it is meant to leave room for.
        contentBottom: Math.round(content.bottom + window.scrollY),
        barTop: Math.round(tb.top + window.scrollY),
        // Every tab needs a real tap target and a label that is not clipped away.
        minTapHeight: Math.min(...links.map((a) => Math.round(a.getBoundingClientRect().height))),
        clippedLabels: links.filter((a) => a.scrollWidth > a.clientWidth + 1).map((a) => a.innerText.trim()),
        badgeHeight: badge ? Math.round(badge.getBoundingClientRect().height) : null,
        hrefs: links.map((a) => a.getAttribute('href')),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        viewport: window.innerWidth + 'x' + window.innerHeight,
      };
    `);
    await shot(cdp, '14-heute-mobile-light');
    record('L21 on a phone the sidebar is replaced by the bottom tabbar',
      mobile.sideShown === false && mobile.tabbarShown === true, JSON.stringify(mobile));
    record('L22 the phone tabbar has four primary destinations and Mehr without clipping',
      mobile.tabbarRows === 1 && mobile.tabbarHeight <= 80 && mobile.tabbarLinks === 5
        && new Set(mobile.hrefs).size === 5 && mobile.hrefs.includes('#/mehr') && mobile.clippedLabels.length === 0,
      `${mobile.tabbarLinks} links in ${mobile.tabbarRows} row(s), ${mobile.tabbarHeight}px tall, ${mobile.display}`
        + `${mobile.scrollable ? ' scrollable' : ''} (${mobile.scrollWidth}/${mobile.clientWidth}px); `
        + `min tap height ${mobile.minTapHeight}px; clipped labels ${JSON.stringify(mobile.clippedLabels)}`);
    /*
     * A FIXED bar always sits "inside" the content's document box, so comparing the two document
     * rectangles proves nothing (the first version of this leg did exactly that and failed on a
     * correct layout). What matters is whether the END of the content can be reached: scroll to the
     * bottom and check that the last visible block stops above the bar.
     */
    await cdp.evaluate('window.scrollTo(0, document.body.scrollHeight); return true;');
    await sleep(400);
    const barOverlap = await cdp.evaluate(`
      const bar = document.querySelector('.tabbar').getBoundingClientRect();
      const kids = [...document.querySelector('.content').children].filter((el) => el.getBoundingClientRect().height > 0);
      const last = kids[kids.length - 1];
      const box = last ? last.getBoundingClientRect() : null;
      return {
        barTop: Math.round(bar.top), barHeight: Math.round(bar.height),
        lastBlock: last ? (last.id || last.getAttribute('class') || last.tagName) : null,
        lastBottom: box ? Math.round(box.bottom) : null,
        scrolledToEnd: Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight) < 4,
      };
    `);
    record('L22b the end of the content is not hidden behind the fixed bar',
      barOverlap.lastBottom !== null && barOverlap.lastBottom <= barOverlap.barTop,
      `last block ${barOverlap.lastBlock} ends at ${barOverlap.lastBottom}px, bar starts at ${barOverlap.barTop}px (${barOverlap.barHeight}px tall)`);
    await clickSel(cdp, '.tabbar [data-view="mehr"]');
    await softWait(cdp, "!document.querySelector('#view-mehr').hidden", 8000, 'mobile Mehr');
    const moreBadge = await visible(cdp, '#mistake-count-tab');
    record('L22c Mehr makes the additional destinations and mistakes count reachable',
      moreBadge.height > 0 && (await cdp.evaluate("return document.querySelectorAll('#view-mehr [data-view]').length")) >= 5,
      JSON.stringify(moreBadge));
    await shot(cdp, '14b-mehr-mobile-light');
    const mobileOverflow = await overflow(cdp);
    record('L23 no horizontal overflow at 390px', mobileOverflow.offenderCount === 0 && mobileOverflow.scrollWidth <= mobileOverflow.innerWidth + 1,
      JSON.stringify(mobileOverflow));

    await clickSel(cdp, '#view-mehr [data-view="lesen"]');
    await softWait(cdp, "location.hash === '#/lesen'", 8000, 'mobile Leseverstehen');
    await sleep(900);
    await shot(cdp, '15-lesen-mobile-light');
    const mobileLesen = await overflow(cdp);
    record('L24 the Leseverstehen list does not overflow a phone screen', mobileLesen.offenderCount === 0, JSON.stringify(mobileLesen));

    await clickSel(cdp, '.tabbar [data-view="mehr"]');
    await softWait(cdp, "!document.querySelector('#view-mehr').hidden", 8000, 'mobile Mehr again');
    await clickSel(cdp, '#view-mehr [data-view="fehler"]');
    await softWait(cdp, "location.hash === '#/fehler'", 8000, 'mobile Fehler');
    await sleep(900);
    await shot(cdp, '16-fehler-mobile-light');
    const mobileErrors = errorsSince(cdp, mark);
    record('L25 the mobile walk raises no console exception', mobileErrors.length === 0, mobileErrors[0] || 'clean');

    /* ------------------------------- the newest surfaces on a phone, dark */

    /*
     * W14 — THE THREE SURFACES THIS RUN ADDED, AT 390×844, IN DARK.
     *
     * This block exists because of a gap I should have caught when I wrote them: W11 (the telc bands), W12 (the
     * marking-scheme panel) and W13 (the sessions list) asserted their properties in the DOM but captured only
     * DESKTOP-LIGHT screenshots. The standing priority for this run is "desktop and mobile, light and dark" —
     * and the desktop pass is exactly where three real client defects were found, two of which were visible
     * only in an image. A surface asserted but never SEEN at phone width is not evidenced.
     *
     * Each leg asserts a property rather than the existence of a screenshot: the surface fits the screen
     * (`overflow` finds nothing past the viewport), the text that matters is the text that renders, and the
     * revoke control is a measured TAP TARGET rather than an assumption.
     */
    await viewport(cdp, 390, 844, true);
    await theme(cdp, 'dark');
    await sleep(300);
    /*
     * A REAL PHONE-WIDTH RUN OF THE WHOLE SURFACE, not a revisit of an old result.
     *
     * The first version of this block reopened the task W11 had graded and found ZERO band rows — correctly,
     * because that submission was finished and opening the task again starts a NEW attempt with nothing
     * submitted yet. The check was wrong, not the screen; and the honest evidence is the flow end to end at
     * this width: open a task, write, submit, wait for the worker, and look at what the learner sees.
     */
    await openWritingTask(cdp, 3, 'W14 a task on a phone');
    await cdp.evaluate(`
      const area = document.getElementById('writing-text');
      area.value = ${JSON.stringify('Liebe Frau Neumann, ich möchte am Ausflug teilnehmen. Bitte sagen Sie mir den Treffpunkt und die Abfahrtszeit.')};
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(1200);
    await cdp.evaluate(`document.getElementById('writing-submit').click(); return true;`);
    await softWait(cdp, "document.querySelectorAll('#writing-state .criterion').length === 3", 30000, 'the graded bands');
    const phoneBands = await cdp.evaluate(`
      const state = document.getElementById('writing-state');
      const rows = [...state.querySelectorAll('.criterion')];
      const details = document.getElementById('writing-rubric');
      if (details) details.open = true;
      const body = document.getElementById('writing-rubric-body');
      const rect = (el) => { const r = el.getBoundingClientRect(); return { right: Math.round(r.right), width: Math.round(r.width) }; };
      const bandLine = body ? body.querySelector('.rubric-bands li') : null;
      const tabbar = document.querySelector('.tabbar');
      const barTop = tabbar && tabbar.getBoundingClientRect().height > 0 ? Math.round(tabbar.getBoundingClientRect().top) : null;
      return {
        rows: rows.length,
        widths: rows.map((r) => rect(r).width),
        label: /Übungsfeedback nach den telc-Kriterien/.test(state.innerText),
        rubricRows: body ? body.querySelectorAll('.rubric-criteria > li').length : 0,
        rubricRight: bandLine ? rect(bandLine).right : null,
        innerWidth: window.innerWidth,
        stateBottom: Math.round(state.getBoundingClientRect().bottom),
        barTop,
        state: state.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160),
      };
    `);
    await cdp.evaluate(`document.getElementById('writing-state').scrollIntoView({ block: 'center' }); return true;`);
    await sleep(250);
    await shot(cdp, '13p-writing-bands-mobile-dark');
    const phoneOverflow = await overflow(cdp);
    record('W14 the bands and the marking scheme render on a phone in dark, without overflowing it',
      phoneBands.rows === 3 && phoneBands.rubricRows === 3 && phoneBands.label && phoneOverflow.offenderCount === 0,
      `${phoneBands.rows} band row(s), ${phoneBands.rubricRows} criterion row(s) at ${phoneBands.innerWidth}px; `
        + `offenders=${JSON.stringify(phoneOverflow.offenders)}`);
    record('W14b the band cards and the rubric text fit the phone width',
      // `widths.length === 3` FIRST: `[].every(...)` is vacuously TRUE, so the first version of this leg passed
      // while measuring nothing at all — a false pass is worse than a failure, and only reading the output
      // ("criterion widths []") showed it.
      phoneBands.widths.length === 3
        && phoneBands.widths.every((w) => w > 0 && w <= phoneBands.innerWidth)
        && phoneBands.rubricRight !== null && phoneBands.rubricRight <= phoneBands.innerWidth + 2,
      `criterion widths ${JSON.stringify(phoneBands.widths)} at ${phoneBands.innerWidth}px; rubric text ends at ${phoneBands.rubricRight}px`);

    /*
     * AND THE RESULT CAN BE SCROLLED CLEAR OF THE PHONE'S FIXED BAR.
     *
     * The first version of this leg compared the whole `#writing-state` container's bottom to the bar's top and
     * failed — "result ends at 844px, the bar starts at 768px". That was the CHECK being wrong: a result taller
     * than the viewport always has part of itself below the fold, which is what scrolling is for, so an
     * absolute comparison measures nothing. The real property is the one L22b already asserts for another
     * view: at the END of the scroll, the last thing that matters sits ABOVE the bar rather than under it.
     */
    const cleared = await cdp.evaluate(`
      // An async IIFE, because \`evaluate\` wraps the body in a NON-async arrow: a top-level \`await\` here is a
      // SyntaxError. I documented this trap in W13c and then walked straight back into it two rounds later.
      return (async () => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((r) => setTimeout(r, 150));
        const rows = [...document.querySelectorAll('#writing-state .criterion')];
        const last = rows[rows.length - 1];
        const tabbar = document.querySelector('.tabbar');
        const barTop = tabbar && tabbar.getBoundingClientRect().height > 0 ? Math.round(tabbar.getBoundingClientRect().top) : null;
        return {
          lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
          barTop,
          atEnd: Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight) < 4,
        };
      })();
    `);
    record('W14d the graded result can be scrolled clear of the phone tabbar',
      cleared.atEnd && cleared.lastBottom !== null
        && (cleared.barTop === null || cleared.lastBottom <= cleared.barTop + 2),
      cleared.barTop === null
        ? `no fixed bar at this width; scrolled to end=${cleared.atEnd}`
        : `at the end of the scroll the last criterion ends at ${cleared.lastBottom}px and the bar starts at ${cleared.barTop}px`);

    /*
     * THE SESSIONS LIST ON A PHONE, where the revoke control becomes a thumb target rather than a mouse target.
     *
     * A SECOND DEVICE IS CREATED FIRST, because the run's earlier leg (W13d) REVOKED the one it had made: with
     * only the browser's own session there is no revoke button to measure, which is what the first version of
     * this leg reported (`revoke nullpx tall`). Again the check was wrong rather than the screen.
     */
    await cdp.evaluate(`
      return (async () => {
        const res = await fetch('/api/auth/sign-in/email', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
          body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(SYNTHETIC.password)} }),
        });
        return { status: res.status };
      })();
    `);
    await nav(cdp, `${base}/app/#/einstellungen`);
    await softWait(cdp, "document.querySelectorAll('#session-list .session').length >= 2", 12000, 'two sessions');
    await sleep(300);
    /*
     * THE LABEL MUST BE LEGIBLE, which is not the same as the button existing. In dark mode the first version of
     * the sessions button rendered as a BLANK WHITE BOX: it carried class "btn btn-small" with no variant
     * class, and the pinned design defines .btn as LAYOUT ONLY (display, padding, radius) with the colours
     * living in .btn-primary/.btn-dark/.btn-ghost/.btn-danger — so a bare .btn fell back to the browser's
     * default button styling, which is a light box that does not follow the dark theme.
     *
     * EVERY DOM ASSERTION PASSED WHILE THE CONTROL WAS INVISIBLE. That is the whole argument for looking at the
     * image, and it is why the property is now measured instead of trusted: the text colour and the background
     * must actually differ. The delete-account button is read as a CONTROL, so the bar is calibrated to what
     * this design system already renders rather than to my opinion.
     *
     * (This comment lives OUTSIDE the template literal below: the first version of it sat inside and contained
     * backticks around the class attribute, which terminated the string. Third time in this session that a
     * backtick has done that.)
     */
    const phoneSessions = await cdp.evaluate(`
      const list = document.getElementById('session-list');
      const rows = [...list.querySelectorAll('.session')];
      const button = list.querySelector('[data-revoke]');
      const r = button ? button.getBoundingClientRect() : null;
      const luminance = (value) => {
        const [r0, g0, b0] = (value.match(/[\\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
        const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * channel(r0) + 0.7152 * channel(g0) + 0.0722 * channel(b0);
      };
      const read = (el) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        const bg = style.backgroundColor;
        const opaque = !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg);
        return {
          text: style.color,
          background: bg,
          border: style.borderTopColor,
          // A transparent background means the card shows through, so the text colour alone must be visible
          // against the card; a solid one must be distinguishable from the text ON it.
          contrast: opaque ? Math.abs(luminance(style.color) - luminance(bg)) : null,
          opaque,
          label: (el.innerText || '').trim(),
        };
      };
      return {
        rows: rows.length,
        buttonHeight: r ? Math.round(r.height) : null,
        buttonRight: r ? Math.round(r.right) : null,
        innerWidth: window.innerWidth,
        revoke: read(button),
        control: read(document.getElementById('delete-account')),
        text: list.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140),
      };
    `);
    await cdp.evaluate(`document.getElementById('session-list').scrollIntoView({ block: 'center' }); return true;`);
    await sleep(250);
    await shot(cdp, '13r-sessions-mobile-dark');
    const sessionsOverflow = await overflow(cdp);
    record('W14c the sessions list fits a phone and its revoke control is a reachable tap target',
      phoneSessions.rows >= 1 && phoneSessions.buttonHeight !== null && phoneSessions.buttonHeight >= 24
        && phoneSessions.buttonRight !== null && phoneSessions.buttonRight <= phoneSessions.innerWidth + 2
        && sessionsOverflow.offenderCount === 0,
      `${phoneSessions.rows} row(s); revoke ${phoneSessions.buttonHeight}px tall ending at ${phoneSessions.buttonRight}px `
        + `of ${phoneSessions.innerWidth}px; text "${phoneSessions.text.slice(0, 60)}"`);
    /*
     * W14e — AND THE LABEL IS READABLE, which is the property the screenshot caught and the DOM did not.
     *
     * A button that exists, is 44px tall and sits inside the viewport can still be invisible. The rule: a
     * button with a SOLID background must have text that differs from it by a real margin, and its label must
     * not be empty. The control is the account-deletion button, which this design system already renders
     * correctly — so the assertion is calibrated against the product's own appearance rather than a constant I
     * chose.
     */
    const revokeLegible = phoneSessions.revoke
      && phoneSessions.revoke.label.length > 0
      && (!phoneSessions.revoke.opaque || phoneSessions.revoke.contrast >= 0.2);
    record('W14e the revoke control\'s label is legible against its own background',
      Boolean(revokeLegible),
      `revoke text ${phoneSessions.revoke && phoneSessions.revoke.text} on ${phoneSessions.revoke && phoneSessions.revoke.background} `
        + `(solid=${phoneSessions.revoke && phoneSessions.revoke.opaque}, contrast=${phoneSessions.revoke && phoneSessions.revoke.contrast}); `
        + `control "Konto löschen" text ${phoneSessions.control && phoneSessions.control.text} on ${phoneSessions.control && phoneSessions.control.background}`);

    await viewport(cdp, 1440, 900, false);
    await theme(cdp, null);
    await sleep(200);

    /* ----------------------------------------------------------- dark mode  */

    await theme(cdp, 'dark');
    await sleep(400);
    const dark = await cdp.evaluate(`
      const body = getComputedStyle(document.body);
      const card = document.querySelector('.card');
      const text = card ? getComputedStyle(card).color : null;
      return { bg: body.backgroundColor, color: body.color, cardColor: text };
    `);
    await shot(cdp, '17-heute-mobile-dark');
    await viewport(cdp, 1440, 900, false);
    await clickSel(cdp, '[data-view="heute"]');
    await sleep(700);
    const darkDesktop = await cdp.evaluate(`
      const body = getComputedStyle(document.body);
      return { bg: body.backgroundColor, color: body.color, canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() };
    `);
    await shot(cdp, '18-heute-desktop-dark');
    const darkLogo = await cdp.evaluate(`
      const read = (sel) => {
        const img = document.querySelector(sel);
        return img ? { current: img.currentSrc.split('/').pop(), visible: img.getBoundingClientRect().width > 0 } : null;
      };
      return { side: read('.side .logo img'), bar: read('.mobile-bar img') };
    `);
    await theme(cdp, 'light');
    record('L26 dark mode is a real theme, not the light one relabelled',
      dark.bg !== 'rgb(255, 255, 255)' && dark.bg !== 'rgba(0, 0, 0, 0)' && darkDesktop.bg !== 'rgb(255, 255, 255)',
      `mobile bg=${dark.bg} color=${dark.color}; desktop bg=${darkDesktop.bg}`);
    /*
     * THE DARK SURFACE NEEDS THE LIGHT LOGO. The pinned stylesheet has one rule for `.side .logo img` and
     * no dark variant, so the ink logo was all but invisible on the dark background — visible in the
     * screenshot, invisible to every markup assertion. This asserts the browser CHOSE the white file.
     */
    record('L26b the sidebar logo switches to its dark-surface variant in dark mode',
      Boolean(darkLogo.side) && darkLogo.side.visible && darkLogo.side.current.includes('white'),
      JSON.stringify(darkLogo));

    /* --------------------------------------------------------- legibility   */

    const a11y = await cdp.evaluate(`
      const ids = {};
      const dupes = [];
      for (const el of document.querySelectorAll('[id]')) {
        if (ids[el.id]) dupes.push(el.id);
        ids[el.id] = true;
      }
      const unlabelled = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
        .filter((el) => !el.labels || el.labels.length === 0)
        .map((el) => el.id || el.name || el.tagName);
      const noAlt = [...document.querySelectorAll('img')].filter((img) => !img.hasAttribute('alt')).map((img) => img.getAttribute('src'));
      const tiny = [...document.querySelectorAll('p, span, a, button, label, li')]
        .filter((el) => el.innerText && el.innerText.trim().length > 3 && el.getBoundingClientRect().height > 0)
        .map((el) => parseFloat(getComputedStyle(el).fontSize))
        .filter((px) => px < 11).length;
      return { dupes: [...new Set(dupes)], unlabelled, noAlt, tinyText: tiny };
    `);
    record('L27 no duplicate element ids in the rendered document', a11y.dupes.length === 0, JSON.stringify(a11y.dupes));
    record('L28 every input has a label and every image has alt text',
      a11y.unlabelled.length === 0 && a11y.noAlt.length === 0,
      `unlabelled=${JSON.stringify(a11y.unlabelled)} noAlt=${JSON.stringify(a11y.noAlt)}`);
    record('L29 no visible text below 11px', a11y.tinyText === 0, `${a11y.tinyText} element(s)`);

    /*
     * THE DARK SWEEP — EVERY REMAINING VIEW, WITH THE LEGIBILITY RULE AS THE ASSERTION.
     *
     * The previous pass proved what light-only coverage hides: in dark mode an un-variant `.btn` fell through
     * to the BROWSER'S DEFAULT face, so the sessions list's "Beenden" was near-white on near-white — contrast
     * 0.0012 — while every DOM assertion about it passed. Every screenshot taken before that pass was
     * light-mode, so the same class of defect could sit anywhere the dark theme had never been rendered.
     *
     * Rather than take N screenshots nobody reads, this walks the remaining views IN DARK and runs the same
     * measurement over every interactive control on each one. The assertion is the audit being empty; the
     * screenshot is the evidence a human can check afterwards.
     *
     * The rule is deliberately restricted to CONTROLS (button / a.btn / role=button): muted body text on a dark
     * background is a design decision, while a control whose label cannot be read is a defect.
     */
    const contrastAudit = `
      const luminance = (value) => {
        const parts = (String(value).match(/[\\d.]+/g) || [0, 0, 0]).map(Number);
        const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2]);
      };
      const offenders = [];
      const controls = [...document.querySelectorAll('button, a.btn, [role=button], .btn')];
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;         // not rendered on this view
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const label = (el.innerText || el.getAttribute('aria-label') || '').trim();
        if (!label) { offenders.push('unlabelled ' + el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]); continue; }
        const bg = style.backgroundColor;
        const opaque = !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg);
        // A transparent control shows the surface through it, so its own text colour is what must be legible;
        // that is the design's ghost treatment and it is checked by the fallback below rather than skipped.
        const contrast = Math.abs(luminance(style.color) - luminance(opaque ? bg : getComputedStyle(el.parentElement).backgroundColor));
        if (contrast < 0.2) {
          offenders.push(label.slice(0, 24) + ' [text ' + style.color + ' on ' + (opaque ? bg : 'parent') + ' contrast ' + contrast.toFixed(3) + ']');
        }
      }
      return { count: controls.length, offenders: offenders.slice(0, 8) };
    `;
    /*
     * SET THE THEME HERE AND PROVE IT, because the first version of this sweep did not and was therefore
     * measuring NOTHING.
     *
     * The dark-mode section above ends by returning the page to light (line ~1893, before the accessibility
     * legs), so by the time this block ran, `prefers-color-scheme` was LIGHT — while every leg below claimed to
     * test dark. The symptom was a wall of "unreadable control" failures on controls whose computed colour was
     * the LIGHT theme's ink, contradicted by a screenshot taken minutes earlier in which the same control was
     * white and perfectly legible. A leg that depends on ambient state has to establish that state and assert
     * it, or it is testing whatever the last section left behind.
     */
    await theme(cdp, 'dark');
    await sleep(350);
    const themeState = await cdp.evaluate(`
      const luminance = (value) => {
        const parts = (String(value).match(/[\\d.]+/g) || [0, 0, 0]).map(Number);
        const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2]);
      };
      const body = getComputedStyle(document.body);
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
      return { bodyBg: body.backgroundColor, bodyLuminance: luminance(body.backgroundColor), ink };
    `);
    const themeIsDark = themeState.bodyLuminance < 0.2;
    record('L30 the dark sweep runs in the dark theme, asserted rather than assumed',
      themeIsDark,
      `body ${themeState.bodyBg} (luminance ${themeState.bodyLuminance.toFixed(3)}), --ink ${themeState.ink}`);
    const darkViews = [
      ['lesen', '#/lesen', '#view-lesen', '19-lesen-desktop-dark'],
      ['woerterbuch', '#/woerterbuch', '#dict-results', '20-woerterbuch-desktop-dark'],
      ['nachschlagen', '#/nachschlagen', '#guide-index', '21-nachschlagen-desktop-dark'],
      ['fehler', '#/fehler', '#view-fehler', '22-fehler-desktop-dark'],
      ['fortschritt', '#/fortschritt', '#view-fortschritt', '23-fortschritt-desktop-dark'],
    ];
    for (const [view, hash, selector, name] of darkViews) {
      await clickSel(cdp, `[data-view="${view}"]`);
      await softWait(cdp, `location.hash === '${hash}'`, 8000, hash);
      await softWait(cdp, `document.querySelector('${selector}')`, 10000, selector);
      await sleep(500);
      const audit = await cdp.evaluate(contrastAudit);
      await shot(cdp, name);
      record(`L30.${view} every control on the ${view} view is legible in dark mode`,
        audit.offenders.length === 0,
        `${audit.count} control(s); offenders=${JSON.stringify(audit.offenders)}`);
    }

    /*
     * THE OPENED SET IS THE ONE THAT MATTERS MOST: its answer tiles are un-variant `.btn`s, which is exactly
     * the shape that was invisible before this pass — and it is the surface a learner uses to answer.
     */
    await clickSel(cdp, '[data-view="lesen"]');
    await softWait(cdp, "document.querySelector('#view-lesen [data-open]')", 12000, 'the reading catalogue');
    await clickSel(cdp, '#view-lesen [data-open]');
    await softWait(cdp, "document.querySelector('#view-lesen [data-answer]')", 12000, 'the answer tiles');
    await sleep(400);
    const openSetAudit = await cdp.evaluate(contrastAudit);
    const tiles = await cdp.evaluate(`return document.querySelectorAll('#view-lesen [data-answer]').length;`);
    await shot(cdp, '24-set-open-desktop-dark');
    record('L31 the answer tiles are legible in dark mode, where the same un-variant button shape was invisible',
      openSetAudit.offenders.length === 0 && tiles > 0,
      `${tiles} tile(s), ${openSetAudit.count} control(s); offenders=${JSON.stringify(openSetAudit.offenders)}`);

    note('screenshots', SHOTS);
    note('device honesty', 'headless Chromium on desktop is not iPhone Safari or Android Chrome; the real-device gate stays open');
    void landingText;
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch { /* ignore */ } }
    if (browser) await browser.cleanup();
    if (started && !KEEP) {
      try {
        compose(['down', '-v', '--remove-orphans']);
        console.log(`Removed disposable project ${project}`);
      } catch (err) {
        console.log(`WARNING: could not remove ${project}: ${err.message}`);
      }
    } else if (started) {
      console.log(`Kept ${project} running on ${base} (--keep)`);
    }
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} legs`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nAPP-BROWSER-01 could not complete: ${err.stack || err.message}`);
  process.exit(2);
});
