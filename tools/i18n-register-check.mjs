#!/usr/bin/env node
/**
 * REDESIGN-01 copy register — offline, deterministic, no database, no browser.
 *
 * Why this exists: branch codex/redesign-01-studio-look converted the `du` -> `Sie` register in the i18n
 * CATALOGUES but never converted the German defaults written inline in the shipped client. The result was
 * a public front door reading "Du hast Deutsch gelernt. Jetzt üben Sie, es in Prüfungsaufgaben
 * anzuwenden.", 14 strings that welded an informal imperative to a formal pronoun ("Bitte melde sich
 * erneut an."), 40 places where the pre-JavaScript German disagreed with the catalogue that replaces it,
 * and a JSON-LD FAQ answer that still addressed the reader informally. Every leg below fails on that tree.
 *
 * The allowlist is deliberately one entry: `public.checklist2`, which quotes the word „du" while
 * describing how a person was addressed. It is a quotation, not address, and leg R4 stops the list growing
 * silently. `public/site.js` carries an authored reading passage that uses "du" as EXAM LANGUAGE; it is
 * content, not interface copy, and is out of scope here.
 *
 * Usage: node tools/i18n-register-check.mjs [--list]
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shellMessages } from '../public/assets/i18n/shell-messages.js';
import { PRACTICE_MESSAGES } from '../public/assets/i18n/practice-messages.js';
import { publicMessages } from '../public/assets/i18n/public-messages.js';
import { authMessages } from '../public/assets/i18n/auth-messages.js';

const root = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');
const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];
const listOnly = process.argv.includes('--list');

/** German informal address and informal imperative forms. The formal forms (wählen, versuchen, melden,
 *  tragen, prüfen, speichern, verwenden, warten, beginnen, hören, schließen, laden) are absent. */
const INFORMAL = /\b(du|dich|dir|dein|deine|deinem|deinen|deiner|deines|kannst|musst|willst|hast|bist|wirst|weißt|weisst|siehst|öffne|klicke|wähle|gib|nutze|versuche|melde|trage|beginne|prüfe|speichere|verwende|warte|nimm|lege|stelle|achte|schließe|schliesse|höre|lade|lies)\b/iu;

const ALLOWED = new Map([
  ['public.checklist2', 'quotes the word „du" while describing how a person was addressed, so it is not address'],
]);

/** Files whose German is exam-language content or authored material, never interface copy. */
const CONTENT_ONLY = new Set(['public/assets/i18n/**', 'public/site-data/**']);

const decode = text => text
  .replace(/&(mdash|ndash|hellip|nbsp|amp|lt|gt|quot|#39|apos|bdquo|ldquo|rdquo|szlig);/g,
    (_, key) => ({ mdash: '—', ndash: '–', hellip: '…', nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", bdquo: '„', ldquo: '“', rdquo: '”', szlig: 'ß' }[key]));
const normalise = text => decode(text).replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

/** The catalogues use two shapes: per-locale blocks, and flat rows of [de,en,uk,ar,tr]. */
function localeMap(catalogue) {
  const keys = Object.keys(catalogue);
  if (LOCALES.every(locale => keys.includes(locale))) return catalogue;
  const out = Object.fromEntries(LOCALES.map(locale => [locale, {}]));
  for (const [key, value] of Object.entries(catalogue)) {
    if (Array.isArray(value)) LOCALES.forEach((locale, index) => { out[locale][key] = value[index]; });
    else if (value && typeof value === 'object') LOCALES.forEach(locale => { out[locale][key] = value[locale]; });
  }
  return out;
}
const namespaces = {
  shell: localeMap(shellMessages),
  practice: localeMap(PRACTICE_MESSAGES),
  public: localeMap(publicMessages),
  auth: localeMap(authMessages),
};
const catalogueValue = (qualified) => {
  const [namespace, ...rest] = qualified.split('.');
  const catalogue = namespaces[namespace];
  return catalogue?.de ? catalogue.de[rest.join('.')] : undefined;
};

/** Every shipped client file that writes a German default inline, and the defaults it writes. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) { walk(`${path}/`, out); continue; }
    if (!/\.(html|js)$/.test(entry.name)) continue;
    if ([...CONTENT_ONLY].some(pattern => path.startsWith(pattern.replace('/**', '/')))) continue;
    out.push(path);
  }
  return out;
}
function inlineDefaults(file) {
  const text = read(file);
  const found = [];
  const patterns = [
    // data-i18n / data-practice-key, plain HTML and the JS-escaped form app.js and mock.js build markup with.
    [/data-i18n="([A-Za-z0-9_.]+)"[^>]*>([^<]*)</g, key => key],
    [/data-i18n=\\"([A-Za-z0-9_.]+)\\"[^>]*>([^<]*)</g, key => key],
    [/data-practice-key="([A-Za-z0-9_.]+)"[^>]*>([^<]*)</g, key => `practice.${key}`],
    [/data-practice-key=\\"([A-Za-z0-9_.]+)\\"[^>]*>([^<]*)</g, key => `practice.${key}`],
  ];
  for (const [pattern, qualify] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalise(match[2]);
      if (value) found.push({ key: qualify(match[1]), value, index: match.index });
    }
  }
  return found;
}
const shipped = walk('public/').filter(file => inlineDefaults(file).length > 0).sort();

const failures = [];
const fail = (leg, detail) => failures.push({ leg, detail });

// R1 — no shipped German string uses the informal address (catalogue + inline defaults + JSON-LD).
const informalCatalogue = [];
for (const [namespace, catalogue] of Object.entries(namespaces)) {
  for (const [key, value] of Object.entries(catalogue.de || {})) {
    if (typeof value === 'string' && INFORMAL.test(value)) informalCatalogue.push({ key: `${namespace}.${key}`, value });
  }
}
const informalInline = [];
for (const file of shipped) {
  for (const entry of inlineDefaults(file)) if (INFORMAL.test(entry.value)) informalInline.push({ file, ...entry });
}
const jsonLd = [];
for (const file of shipped.filter(f => f.endsWith('.html'))) {
  const text = read(file);
  for (const block of text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    for (const value of block[1].matchAll(/"((?:[^"\\]|\\.){10,})"/g)) {
      const string = value[1].replace(/\\"/g, '"');
      if (INFORMAL.test(string)) jsonLd.push({ file, value: string });
    }
  }
}
for (const entry of [...informalCatalogue, ...informalInline, ...jsonLd]) {
  if (ALLOWED.has(entry.key)) continue;
  fail('R1', `${entry.key || entry.file} uses the informal address: ${String(entry.value).slice(0, 110)}`);
}

// R2 — every inline default agrees with the catalogue value that replaces it at runtime.
const drift = [];
for (const file of shipped) {
  for (const entry of inlineDefaults(file)) {
    const catalogue = catalogueValue(entry.key);
    if (typeof catalogue !== 'string') { drift.push({ file, key: entry.key, value: entry.value, catalogue: null }); continue; }
    if (normalise(catalogue) !== entry.value) drift.push({ file, key: entry.key, value: entry.value, catalogue: normalise(catalogue) });
  }
}
for (const entry of drift) {
  fail('R2', `${entry.file} ${entry.key}: inline "${entry.value.slice(0, 90)}" != catalogue "${String(entry.catalogue).slice(0, 90)}"`);
}

// R3 — the hero pair is the exact regression that reached production: pin both halves.
for (const key of ['intro1', 'intro2']) {
  const value = namespaces.public.de[key];
  if (!value || INFORMAL.test(value)) fail('R3', `public.${key} must address the reader formally, reads: ${value}`);
}

// R4 — the allowlist stays exactly as documented.
for (const key of ALLOWED.keys()) {
  const [namespace, ...rest] = key.split('.');
  const value = namespaces[namespace]?.de?.[rest.join('.')];
  if (typeof value !== 'string') fail('R4', `allowlisted ${key} no longer exists; remove it from ALLOWED`);
  else if (!INFORMAL.test(value)) fail('R4', `allowlisted ${key} no longer contains an informal form; remove it from ALLOWED`);
}

// R5 — the conversion must not have dropped or emptied any locale of any namespace.
for (const [namespace, catalogue] of Object.entries(namespaces)) {
  const de = Object.keys(catalogue.de || {});
  for (const locale of LOCALES) {
    const other = Object.keys(catalogue[locale] || {});
    if (other.length !== de.length) fail('R5', `${namespace}.${locale} has ${other.length} keys, de has ${de.length}`);
    for (const key of de) {
      const value = catalogue[locale][key];
      if (typeof value !== 'string' || value.trim() === '') fail('R5', `${namespace}.${locale}.${key} is missing or empty`);
    }
  }
}

// R6 — every shipped file that declares an inline default must be scanned by R1 and R2.
const declared = [];
for (const file of walk('public/')) {
  const text = read(file);
  if (/data-i18n="[A-Za-z0-9_.]+"[^>]*>[^<]/.test(text) || /data-i18n=\\"/.test(text)
    || /data-practice-key="[A-Za-z0-9_.]+"[^>]*>[^<]/.test(text) || /data-practice-key=\\"/.test(text)) declared.push(file);
}
const unscanned = declared.filter(file => !shipped.includes(file));
if (unscanned.length) fail('R6', `shipped file(s) declare inline defaults but are not scanned: ${unscanned.join(', ')}`);

// R7 — the exam-language reading passage is untouched: "du" there is authored content, not interface copy.
const passage = read('public/site.js');
if (!/Hast du Zeit, uns zu helfen\?/.test(passage)) fail('R7', 'the authored reading passage in public/site.js changed; it is exam content, not interface copy');

const summary = () => `${informalCatalogue.filter(e => !ALLOWED.has(e.key)).length + informalInline.filter(e => !ALLOWED.has(e.key)).length + jsonLd.length} informal, ${drift.length} inline/catalogue drifts, ${shipped.length} shipped files`;

if (listOnly) {
  console.log('KLARTEXT — German interface register\n');
  console.log(`catalogue values still informal (${informalCatalogue.length}):`);
  for (const entry of informalCatalogue) console.log(`  ${ALLOWED.has(entry.key) ? '[allowed]' : '         '} ${entry.key}\n      ${entry.value}`);
  console.log(`\ninline defaults still informal (${informalInline.length}):`);
  for (const entry of informalInline) console.log(`  ${entry.file} ${entry.key}\n      ${entry.value}`);
  console.log(`\nJSON-LD strings still informal (${jsonLd.length}):`);
  for (const entry of jsonLd) console.log(`  ${entry.file}\n      ${entry.value}`);
  console.log(`\ninline defaults disagreeing with the catalogue (${drift.length}):`);
  for (const entry of drift) console.log(`  ${entry.file} ${entry.key}\n      inline    : ${entry.value}\n      catalogue : ${entry.catalogue}`);
  console.log(`\nshipped files with inline defaults (${shipped.length}): ${shipped.join(', ')}`);
  process.exit(failures.length ? 1 : 0);
}

const legs = [
  ['R1 no shipped German string uses the informal address', informalCatalogue.filter(e => !ALLOWED.has(e.key)).length + informalInline.filter(e => !ALLOWED.has(e.key)).length + jsonLd.length],
  ['R2 every inline German default equals the catalogue value', drift.length],
  ['R3 the public hero pair addresses the reader formally', failures.filter(f => f.leg === 'R3').length],
  ['R4 the allowlist is exactly the documented quotation', failures.filter(f => f.leg === 'R4').length],
  ['R5 every locale still carries every key, non-empty', failures.filter(f => f.leg === 'R5').length],
  ['R6 the inline-default scan covers every shipped declaration', failures.filter(f => f.leg === 'R6').length],
  ['R7 the authored reading passage is untouched', failures.filter(f => f.leg === 'R7').length],
];
for (const [name, count] of legs) console.log(`${count === 0 ? 'PASS' : 'FAIL'}  ${name}${count === 0 ? '' : `  [${count}]`}`);

if (failures.length) {
  console.log(`\n${failures.length} finding(s): ${summary()}`);
  for (const entry of failures.slice(0, 40)) console.log(`  ${entry.leg}  ${entry.detail}`);
  console.log('\nRun with --list for the full worklist.');
  process.exit(1);
}
console.log(`\nGerman register: 0 findings — ${summary()}.`);
