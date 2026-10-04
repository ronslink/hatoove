#!/usr/bin/env node
/**
 * SEO surface check — the front door must stay crawlable, canonical and honest.
 *
 * Two failures this exists to prevent, both of which were real before it was written:
 *
 *   1. CRAWLER FILES BEHIND THE GATE. `robots.txt` and `sitemap.xml` are new root files, and the
 *      static gate only serves files listed in `PUBLIC_FILES`. A `robots.txt` that answers 302/401
 *      is read by Google as "do not crawl this host" — the whole site disappears — and a sitemap it
 *      cannot fetch is never used. Leg S8 boots the server and asserts both files are served 200
 *      WITHOUT a session, exactly like liveness.
 *
 *   2. THE LANGUAGE GUESS ON A GERMAN PAGE. `core.js#initialLocale()` falls back to
 *      `navigator.languages`, and Googlebot reports `en-US`. Before the fix the landing page was
 *      therefore rendered — and indexed — as English with `<html lang="en">`, contradicting its
 *      German canonical URL and its German structured data. Leg S7 builds a real locale runtime with
 *      a browser that reports `en-US` and asserts `storedLocale()` still declines to guess, and it
 *      holds the companion rule that the read stays in `core.js` rather than in the public shell.
 *
 * The rest is metadata hygiene: one absolute canonical, complete Open Graph and Twitter cards whose
 * image files exist, a parseable JSON-LD graph whose FAQ answers are word-for-word the visible FAQ,
 * no rich-result types this product cannot back up, and a sitemap that lists exactly the canonical
 * URLs and nothing invented.
 *
 * Offline: no database, no provider call, no network. The child server is killed in `finally`.
 *
 * Usage: node tools/seo-check.mjs
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.SEOCHECK_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const APEX = 'https://hatoove.com';
const READY_DEADLINE_MS = 20000;

const results = [];
function record(id, title, outcome, detail) {
  results.push({ id, outcome });
  console.log(`${outcome.padEnd(4)} ${id.padEnd(4)} ${title}`);
  if (detail) console.log(`     ${detail}`);
}
const pass = (id, t, d) => record(id, t, 'PASS', d);
const fail = (id, t, d) => record(id, t, 'FAIL', d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip markup, decode the few entities these pages use, and normalise spacing around punctuation. */
function plain(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

async function exists(relPath) {
  try {
    const info = await stat(path.join(PUBLIC, relPath));
    return info.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- static surface

const html = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
const robots = await readFile(path.join(PUBLIC, 'robots.txt'), 'utf8').catch(() => null);
const sitemap = await readFile(path.join(PUBLIC, 'sitemap.xml'), 'utf8').catch(() => null);
const siteJs = await readFile(path.join(PUBLIC, 'site.js'), 'utf8');
const serverJs = await readFile(path.join(ROOT, 'server.js'), 'utf8');

console.log(`\n=== SEO surface check ===\n`);

/* S1 — robots.txt exists and lets crawlers reach the page and everything it renders with. */
{
  if (!robots) {
    fail('S1', 'robots.txt exists and allows the front door', 'public/robots.txt is missing');
  } else {
    const lines = robots.split('\n').map((line) => line.trim());
    const disallows = lines.filter((line) => /^disallow:/i.test(line)).map((line) => line.replace(/^disallow:\s*/i, ''));
    const blocksEverything = disallows.some((value) => value === '/');
    const blocksRendering = disallows.some((value) => /^\/(assets|site\.(css|js)|index\.html)/i.test(value));
    const sitemapLine = lines.find((line) => /^sitemap:/i.test(line)) || '';
    if (blocksEverything) fail('S1', 'robots.txt exists and allows the front door', 'a `Disallow: /` line blocks the whole site');
    else if (blocksRendering) fail('S1', 'robots.txt exists and allows the front door', `a disallow rule blocks rendering assets: ${disallows.join(', ')}`);
    else if (sitemapLine !== `Sitemap: ${APEX}/sitemap.xml`) fail('S1', 'robots.txt exists and allows the front door', `expected \`Sitemap: ${APEX}/sitemap.xml\`, found \`${sitemapLine || '(none)'}\``);
    else pass('S1', 'robots.txt exists and allows the front door', `disallows only: ${disallows.join(', ') || '(none)'}`);
  }
}

/* S2 — the sitemap lists exactly the canonical URLs, on the apex, over https. */
{
  if (!sitemap) {
    fail('S2', 'sitemap.xml lists exactly the canonical URLs', 'public/sitemap.xml is missing');
  } else {
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1].trim());
    const expected = [`${APEX}/`];
    const malformed = locs.filter((loc) => !loc.startsWith(`${APEX}/`) || loc !== loc.trim());
    if (!locs.length) fail('S2', 'sitemap.xml lists exactly the canonical URLs', 'no <loc> entries found');
    else if (malformed.length) fail('S2', 'sitemap.xml lists exactly the canonical URLs', `not absolute https apex URLs: ${malformed.join(', ')}`);
    else if (locs.length !== expected.length || locs.some((loc) => !expected.includes(loc))) {
      fail('S2', 'sitemap.xml lists exactly the canonical URLs', `sitemap has [${locs.join(', ')}], canonical set is [${expected.join(', ')}]`);
    } else pass('S2', 'sitemap.xml lists exactly the canonical URLs', locs.join(', '));
  }
}

/* S3 — exactly one canonical, absolute, on the apex, and it is the page itself. */
{
  const canonicals = [...html.matchAll(/<link[^>]+rel=["']canonical["'][^>]*>/gi)].map((match) => (match[0].match(/href=["']([^"']+)["']/i) || [])[1]);
  if (canonicals.length !== 1) fail('S3', 'exactly one absolute canonical', `found ${canonicals.length} canonical links`);
  else if (canonicals[0] !== `${APEX}/`) fail('S3', 'exactly one absolute canonical', `canonical is \`${canonicals[0]}\`, expected \`${APEX}/\``);
  else pass('S3', 'exactly one absolute canonical', canonicals[0]);
}

/* S4 — Open Graph and Twitter cards are complete, and the image they promise really exists. */
{
  const meta = (attr, key) => {
    const found = [...html.matchAll(new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*>`, 'gi'))][0];
    return found ? (found[0].match(/content=["']([^"']*)["']/i) || [])[1] : undefined;
  };
  const required = [
    ['property', 'og:type'], ['property', 'og:site_name'], ['property', 'og:locale'], ['property', 'og:url'],
    ['property', 'og:title'], ['property', 'og:description'], ['property', 'og:image'],
    ['property', 'og:image:width'], ['property', 'og:image:height'], ['property', 'og:image:alt'],
    ['name', 'twitter:card'], ['name', 'twitter:title'], ['name', 'twitter:description'], ['name', 'twitter:image'],
  ];
  const missing = required.filter(([attr, key]) => !meta(attr, key)).map(([, key]) => key);
  const ogImage = meta('property', 'og:image') || '';
  const twitterImage = meta('name', 'twitter:image') || '';
  const localImage = (url) => (url.startsWith(`${APEX}/`) ? url.slice(APEX.length + 1) : null);
  if (missing.length) fail('S4', 'Open Graph and Twitter cards are complete', `missing: ${missing.join(', ')}`);
  else if (!ogImage.startsWith('https://')) fail('S4', 'Open Graph and Twitter cards are complete', `og:image is not absolute: ${ogImage}`);
  else if (ogImage !== twitterImage) fail('S4', 'Open Graph and Twitter cards are complete', `og:image (${ogImage}) and twitter:image (${twitterImage}) differ`);
  else if (!(await exists(localImage(ogImage) || ''))) fail('S4', 'Open Graph and Twitter cards are complete', `og:image file does not exist in public/: ${ogImage}`);
  else {
    // The declared dimensions are checked against the actual PNG header: a wrong size here is what
    // makes a social card render cropped or letterboxed, and it is invisible in the markup alone.
    const w = Number(meta('property', 'og:image:width'));
    const h = Number(meta('property', 'og:image:height'));
    const bytes = await readFile(path.join(PUBLIC, localImage(ogImage)));
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const actualW = png ? bytes.readUInt32BE(16) : null;
    const actualH = png ? bytes.readUInt32BE(20) : null;
    if (!png || actualW !== w || actualH !== h) fail('S4', 'Open Graph and Twitter cards are complete', `${ogImage} is ${actualW}x${actualH} but the markup declares ${w}x${h}`);
    else pass('S4', 'Open Graph and Twitter cards are complete', `${ogImage} ${actualW}x${actualH}, card=${meta('name', 'twitter:card')}`);
  }
}

/* S5 — the JSON-LD graph parses, and its FAQ is word-for-word the visible FAQ. */
{
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const details = [...html.matchAll(/<details>([\s\S]*?)<\/details>/gi)].map((match) => match[1]);
  const fromPage = details.map((block) => {
    const summary = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '';
    const answer = block.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, '');
    return { name: plain(summary), text: plain(answer) };
  });
  if (!blocks.length) fail('S5', 'JSON-LD FAQ matches the visible FAQ', 'no application/ld+json block found');
  else {
    let graph = null;
    try {
      const parsed = blocks.map((block) => JSON.parse(block));
      graph = parsed.flatMap((doc) => (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc]));
    } catch (error) {
      fail('S5', 'JSON-LD FAQ matches the visible FAQ', `invalid JSON: ${error.message}`);
    }
    if (graph) {
      const faq = graph.find((node) => node['@type'] === 'FAQPage');
      if (!faq) fail('S5', 'JSON-LD FAQ matches the visible FAQ', 'no FAQPage node');
      else {
        const entries = Array.isArray(faq.mainEntity) ? faq.mainEntity : [];
        if (!fromPage.length) fail('S5', 'JSON-LD FAQ matches the visible FAQ', 'the page has no <details> FAQ to match');
        else if (entries.length !== fromPage.length) fail('S5', 'JSON-LD FAQ matches the visible FAQ', `JSON-LD has ${entries.length} questions, the page shows ${fromPage.length}`);
        else {
          const mismatched = fromPage
            .map((visible, index) => {
              const entry = entries[index] || {};
              const name = entry.name; const text = entry.acceptedAnswer && entry.acceptedAnswer.text;
              return name === visible.name && text === visible.text ? null : `#${index + 1} ${name === visible.name ? '' : `question differs: "${name}" vs "${visible.name}"`}${text === visible.text ? '' : ` answer differs: "${String(text).slice(0, 60)}…" vs "${visible.text.slice(0, 60)}…"`}`.trim();
            })
            .filter(Boolean);
          if (mismatched.length) fail('S5', 'JSON-LD FAQ matches the visible FAQ', mismatched.join(' | '));
          else {
            const types = graph.map((node) => node['@type']).filter(Boolean);
            if (!types.includes('WebSite') || !types.includes('Organization')) fail('S5', 'JSON-LD FAQ matches the visible FAQ', `graph lacks WebSite/Organization: ${types.join(', ')}`);
            else pass('S5', 'JSON-LD FAQ matches the visible FAQ', `${entries.length} entries word-for-word; graph: ${types.join(', ')}`);
          }
        }
      }
    }
  }
}

/* S6 — no rich-result type this product cannot substantiate (no course, ratings, reviews or prices). */
{
  const forbidden = ['"Course"', '"AggregateRating"', '"Review"', '"offers"', '"price"', '"EducationalOccupationalProgram"'];
  const found = forbidden.filter((token) => html.includes(token));
  if (found.length) fail('S6', 'no unsupportable rich-result types', `found: ${found.join(', ')}`);
  else pass('S6', 'no unsupportable rich-result types', 'no Course, ratings, reviews, offers or prices');
}

/* S7 — the front door starts in German even for a visitor whose browser says otherwise.
 *
 * The rule lives in core.js: `storedLocale()` returns the visitor's OWN stored choice or null and
 * never guesses. This leg builds a REAL locale runtime whose browser reports `en-US` and whose
 * storage it controls, so the property is tested against the shipped code rather than a copy. It also
 * holds the companion house rule that the public shell never touches storage itself — the read
 * belongs to the runtime, and `tools/public-locale-check.mjs` fails a shell that does its own. */
{
  const core = await import(pathToFileURL(path.join(PUBLIC, 'assets', 'i18n', 'core.js')).href);
  // Comments in `site.js` NAME `initialLocale()` while explaining why it is not used, so the source
  // tests below run against the code with comments removed.
  const code = siteJs.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const problems = [];
  if (typeof core.storedLocale !== 'function') problems.push('core.js does not export storedLocale()');
  if (/\blocalStorage\b/.test(code)) problems.push('public/site.js reaches storage itself instead of core.js storedLocale()');
  if (/initialLocale\s*\(/.test(code)) problems.push('public/site.js calls initialLocale(), which falls back to navigator.languages');
  // BOTH call sites, not merely one: the boot and the bfcache `pageshow` restore. Accepting a single
  // occurrence left the handler free to drift — changing it to `setLocale('de')` kept this leg green —
  // and that drift would silently drop a returning visitor's stored choice on every back-navigation.
  const bootCalls = code.match(/setLocale\(storedLocale\(\)\s*\?\?\s*'de'\)/g) || [];
  if (bootCalls.length !== 2) problems.push(`public/site.js has ${bootCalls.length} \`setLocale(storedLocale() ?? 'de')\` call(s); the boot and the bfcache restore must both use it`);
  if (core.LOCALES.join('|') !== 'de|en|uk|ar|tr') problems.push(`core.js LOCALES is "${core.LOCALES.join('|')}"`);

  if (problems.length) fail('S7', 'the landing page starts in German, not in the crawler language', problems.join(' | '));
  else {
    const runtimeFor = (getItem) => core.createLocaleRuntime({
      readStorage: () => ({ getItem }),
      readNavigator: () => ({ languages: ['en-US'] }),
      readDocument: () => null,
    }).storedLocale();
    const cases = [
      ['nothing stored (browser claims en-US)', () => null, null],
      ['stored German', () => 'de', 'de'],
      ['stored Ukrainian', () => 'uk', 'uk'],
      ['stored junk', () => 'klingon', null],
      ['storage denied', () => { throw new Error('denied'); }, null],
    ];
    const wrong = cases
      .filter(([, getItem, expected]) => runtimeFor(getItem) !== expected)
      .map(([label, getItem, expected]) => `${label}: got ${runtimeFor(getItem)}, expected ${expected}`);
    if (wrong.length) fail('S7', 'the landing page starts in German, not in the crawler language', wrong.join(' | '));
    else pass('S7', 'the landing page starts in German, not in the crawler language', `${cases.length} runtime cases with a browser reporting en-US; storage stays in core.js`);
  }
}

// ---------------------------------------------------------------- served surface

/** A GET that never follows redirects, so the gate's own answer is observable. */
async function probe(pathname, { accept = null } = {}) {
  const headers = {};
  if (accept) headers.accept = accept;
  const res = await fetch(`${BASE}${pathname}`, { headers, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type'), robots: res.headers.get('x-robots-tag'), body };
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    B1PREP_SAAS: '1',
    B1PREP_ACCOUNTS: '1',
    B1PREP_PORT: String(PORT),
    B1PREP_PUBLIC_ORIGIN: BASE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const NAVIGATION = 'text/html,application/xhtml+xml';

try {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let alive = false;
  while (Date.now() < deadline && !alive) {
    alive = await probe('/api/health').then((r) => r.status === 200).catch(() => false);
    if (!alive) await sleep(250);
  }

  if (!alive) {
    fail('S8', 'crawler files are public without a session', `server did not become live on ${BASE}; log tail: ${log.slice(-300)}`);
  } else {
    const robotsProbe = await probe('/robots.txt');
    const sitemapProbe = await probe('/sitemap.xml');
    const rootProbe = await probe('/', { accept: NAVIGATION });
    const appProbe = await probe('/app/', { accept: NAVIGATION });
    const problems = [];
    if (robotsProbe.status !== 200) problems.push(`/robots.txt answered ${robotsProbe.status}`);
    if (!String(robotsProbe.type || '').startsWith('text/plain')) problems.push(`/robots.txt content-type ${robotsProbe.type}`);
    if (sitemapProbe.status !== 200) problems.push(`/sitemap.xml answered ${sitemapProbe.status}`);
    if (!/xml/.test(String(sitemapProbe.type || ''))) problems.push(`/sitemap.xml content-type ${sitemapProbe.type}`);
    if (rootProbe.status !== 200) problems.push(`/ answered ${rootProbe.status}`);
    if (rootProbe.robots) problems.push(`/ carries X-Robots-Tag: ${rootProbe.robots}`);
    if (problems.length) fail('S8', 'crawler files are public without a session', problems.join(' | '));
    else pass('S8', 'crawler files are public without a session', `/robots.txt ${robotsProbe.type}, /sitemap.xml ${sitemapProbe.type}, / 200 with no noindex`);

    /* S9 — the gated app is not indexable even if a crawler follows a link into it. Without a
     * database the gate answers 503 (not ready) instead of 302 (redirect to sign-in): BOTH are
     * refusals to serve the shell, and both must carry `noindex`. */
    const appProblems = [];
    const gated = appProbe.status === 302 || appProbe.status === 503;
    if (!gated) appProblems.push(`/app/ answered ${appProbe.status}; a gated page answers 302 (ready) or 503 (not ready), never the shell`);
    if (!String(appProbe.robots || '').includes('noindex')) appProblems.push(`/app/ X-Robots-Tag is "${appProbe.robots}" — every gated response must be noindex`);
    if (/<title>Hatoove<\/title>/.test(appProbe.body)) appProblems.push('/app/ served the application shell');
    const signin = await probe('/signin', { accept: NAVIGATION });
    if (signin.status !== 200) appProblems.push(`/signin answered ${signin.status}`);
    if (!/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(signin.body)) appProblems.push('/signin has no noindex meta');
    // The 401 branch cannot be reached offline: with no database the gate answers 503 before it looks
    // at identity. This one STRUCTURAL assertion stands in for that branch — all three refusals must
    // set the header — because the alternative is no guard at all. The ready-path 401 behaviour was
    // verified out-of-band against a stub, and this is stated as structure, not as behaviour.
    const refusalHeaders = (serverJs.match(/['"]X-Robots-Tag['"]/g) || []).length;
    if (refusalHeaders !== 3) appProblems.push(`server.js sets X-Robots-Tag ${refusalHeaders} time(s); the 503, 302 and 401 refusals must each set it`);
    if (appProblems.length) fail('S9', 'the gated app stays out of the index', appProblems.join(' | '));
    else pass('S9', 'the gated app stays out of the index', `/app/ ${appProbe.status} + X-Robots-Tag noindex, /signin noindex, all three refusals carry the header`);
  }
} finally {
  child.kill('SIGTERM');
  await sleep(150);
  if (!child.killed) child.kill('SIGKILL');
}

const failed = results.filter((row) => row.outcome === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((row) => row.id).join(', ')}` : ''}\n`);
process.exitCode = failed.length ? 1 : 0;
