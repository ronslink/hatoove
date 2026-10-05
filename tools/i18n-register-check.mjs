#!/usr/bin/env node
/**
 * REDESIGN-01 copy register — offline, deterministic, no database, no browser.
 *
 * Why this exists: branch codex/redesign-01-studio-look converted the `du` -> `Sie` register in the i18n
 * CATALOGUES but never converted the German defaults written inline in the shipped client. It put
 * "Du hast Deutsch gelernt. Jetzt üben Sie, es in Prüfungsaufgaben anzuwenden." on the public front door,
 * left 14 strings welding an informal imperative to a formal pronoun, left the whole sign-in journey
 * informal, left the <noscript> text informal, and left 129 inline defaults disagreeing with the catalogue
 * value that replaces them at runtime. Every leg below fails on that tree.
 *
 * Coverage notes, so the next author knows the boundary:
 *  - Catalogues scanned: shell, practice, public, auth AND instructions (the curated direction registry,
 *    whose German "original" is what a German learner reads).
 *  - Inline defaults scanned: `data-i18n`, `data-practice-key`, and the attribute family
 *    `data-i18n-aria-label` / `-title` / `-placeholder` / `-alt`, in plain HTML and in the escaped form the
 *    JS modules build markup with. A JavaScript expression (not a literal) is not an inline default.
 *  - <noscript> German is static text with no binding, so it is scanned separately.
 *  - The one allowlisted exception is public.checklist2, which quotes the word „du" while describing how a
 *    person was addressed; R4 pins the allowlist to exactly that entry.
 *  - public/site.js carries an authored writing stimulus whose "du" is EXAM LANGUAGE, not interface copy;
 *    R7 asserts that sentence is unchanged. `server/` has no German interface copy of its own.
 *  - The informal word list (R1) is curated; R8 is the safety net for the 2nd-person-singular family, and
 *    its non-verb allowlist is deliberately small. A brand-new informal form outside both lists would still
 *    pass, which is the honest limit of a deterministic checker.
 *
 * Usage: node tools/i18n-register-check.mjs [--list]
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shellMessages } from '../public/assets/i18n/shell-messages.js';
import { PRACTICE_MESSAGES } from '../public/assets/i18n/practice-messages.js';
import { publicMessages } from '../public/assets/i18n/public-messages.js';
import { authMessages } from '../public/assets/i18n/auth-messages.js';
import { INSTRUCTIONS } from '../public/assets/i18n/instructions.js';

const root = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');
const LOCALES = ['de', 'en', 'uk', 'ar', 'tr'];
const listOnly = process.argv.includes('--list');

/** German informal address (R1) — pronouns, possessives, 2nd-person verb forms and informal imperatives.
 *  Formal forms (wählen, versuchen, melden, tragen, prüfen, speichern, verwenden, warten, beginnen,
 *  hören, schließen, laden, fordern, füllen, lassen, aktivieren) are deliberately absent. */
const INFORMAL = new RegExp('(?<![\\p{L}\\p{N}])(' + [
  'du', 'dich', 'dir', 'dein', 'deine', 'deinem', 'deinen', 'deiner', 'deines',
  'kannst', 'musst', 'willst', 'hast', 'bist', 'wirst', 'weißt', 'weisst', 'siehst', 'sollst', 'darfst',
  'magst', 'findest', 'kennst', 'hattest', 'warst', 'bleibst', 'gehst', 'kommst', 'nimmst', 'gibst',
  'machst', 'brauchst', 'möchtest', 'moechtest',
  'wähle', 'waehle', 'trage', 'prüfe', 'pruefe', 'speichere', 'verwende', 'versuche', 'melde', 'beginne',
  'schließe', 'schliesse', 'höre', 'hoere', 'lade', 'lies', 'fordere', 'fülle', 'fuelle', 'lass', 'laß',
  'aktiviere', 'gib', 'nutze', 'warte', 'nimm', 'lege', 'stelle', 'achte', 'öffne', 'oeffne', 'klicke',
  'rufe', 'sende', 'schau', 'bleib', 'geh', 'komm', 'mach', 'brauch', 'zeig', 'sag', 'denk', 'merk',
  'wende', 'besuche', 'probiere',
].join('|') + ')(?![\\p{L}\\p{N}])', 'iu');

/** R8 — words ending in -st that are NOT 2nd-person verb forms, so the heuristic stays quiet on them. */
const NOT_A_VERB_ST = new Set([
  'erst', 'zuerst', 'sonst', 'selbst', 'meist', 'nächst', 'naechst', 'letzt', 'zuletzt', 'größt', 'groesst',
  'best', 'fest', 'rest', 'test', 'text', 'kontext', 'dienst', 'passt', 'bewusst', 'bewußt', 'prost',
]);
/** …and compound nouns built on those, e.g. Bewertungsdienst. */
const NOT_A_VERB_SUFFIX = ['dienst', 'text', 'test', 'fest', 'rest', 'erst', 'sonst', 'selbst', 'meist',
  'nächst', 'naechst', 'letzt', 'passt', 'bewusst', 'bewußt', 'prost'];

const ALLOWED = new Map([
  ['public.checklist2', 'quotes the word „du" while describing how a person was addressed, so it is not address'],
]);

/** Files whose German is exam-language content or authored material, never interface copy. */
const CONTENT_ONLY = ['public/assets/i18n/', 'public/site-data/'];

/** A file whose only inline declarations are JavaScript expressions cannot be checked as literals. Each
 *  exception is asserted below, so a NEW file the parser cannot read is still caught by R6. */
const DYNAMIC_ONLY = new Map([
  ['public/app/checkout.js', 'the market <option> default is built with esc(uiText("m263")) and is rewritten by translateDom'],
  ['public/site.js', 'its only bound default is the dictionary placeholder, built with escape(text("placeholder"))'],
]);

const decode = text => text
  .replace(/&(mdash|ndash|hellip|nbsp|amp|lt|gt|quot|#39|apos|bdquo|ldquo|rdquo|szlig);/g,
    (_, key) => ({ mdash: '—', ndash: '–', hellip: '…', nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", bdquo: '„', ldquo: '“', rdquo: '”', szlig: 'ß' }[key]));
const normalise = text => decode(text).replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
/** A JavaScript concatenation or call is not a literal default. */
const isLiteral = text => !/['"`+]|\$\{|\besc\(|\buiText\(|\bpl\(|\bm\(/.test(text);

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
const instructionCatalogue = Object.fromEntries(LOCALES.map(locale => [locale,
  Object.fromEntries(Object.entries(INSTRUCTIONS).map(([id, entry]) => [id, entry.translations[locale]]))]));

const namespaces = {
  shell: localeMap(shellMessages),
  practice: localeMap(PRACTICE_MESSAGES),
  public: localeMap(publicMessages),
  auth: localeMap(authMessages),
  instructions: instructionCatalogue,
};
const catalogueValue = (qualified) => {
  const [namespace, ...rest] = qualified.split('.');
  return namespaces[namespace]?.de ? namespaces[namespace].de[rest.join('.')] : undefined;
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) { walk(`${path}/`, out); continue; }
    if (!/\.(html|js|svg)$/.test(entry.name)) continue;
    if (CONTENT_ONLY.some(prefix => path.startsWith(prefix))) continue;
    out.push(path);
  }
  return out;
}

const TEXT_PATTERNS = [
  [/data-i18n="([A-Za-z0-9_.]+)"[^>]*>([^<]*)</g, key => key],
  [/data-i18n=\\"([A-Za-z0-9_.]+)\\"[^>]*>([^<]*)</g, key => key],
  [/data-practice-key="([A-Za-z0-9_.]+)"[^>]*>([^<]*)</g, key => `practice.${key}`],
  [/data-practice-key=\\"([A-Za-z0-9_.]+)\\"[^>]*>([^<]*)</g, key => `practice.${key}`],
];
const ATTR_PATTERN = /<[^>]*data-i18n-(aria-label|title|placeholder|alt)="([A-Za-z0-9_.]+)"[^>]*>/g;
const ATTR_PATTERN_ESCAPED = /<[^>]*data-i18n-(aria-label|title|placeholder|alt)=\\"([A-Za-z0-9_.]+)\\"[^>]*>/g;

/** Inline German defaults that ship before the catalogue replaces them. */
function inlineDefaults(file) {
  const text = read(file);
  const found = [];
  for (const [pattern, qualify] of TEXT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!isLiteral(match[2])) continue;
      const value = normalise(match[2]);
      if (value) found.push({ key: qualify(match[1]), value, index: match.index, how: 'text' });
    }
  }
  for (const [pattern, escaped] of [[ATTR_PATTERN, false], [ATTR_PATTERN_ESCAPED, true]]) {
    for (const match of text.matchAll(pattern)) {
      const attribute = match[1];
      const key = match[2];
      const quote = escaped ? '\\\\"' : '"';
      const value = new RegExp(`(?:^|\\s)${attribute}=${quote}([^"\\\\]*)`).exec(match[0]);
      if (!value || !isLiteral(value[1])) continue;
      const normalised = normalise(value[1]);
      if (normalised) found.push({ key, value: normalised, index: match.index, how: `data-i18n-${attribute}` });
    }
  }
  return found;
}

/** <noscript> German is static text with no binding at all. */
function noscriptDefaults(file) {
  if (!file.endsWith('.html')) return [];
  const text = read(file);
  const found = [];
  for (const block of text.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)) {
    for (const german of block[1].matchAll(/<p[^>]*lang="de"[^>]*>([^<]*)</g)) {
      const value = normalise(german[1]);
      if (value) found.push({ file, key: `${file} <noscript lang="de">`, value, index: block.index });
    }
  }
  return found;
}

/** <text> content in a shipped SVG is interface copy baked into the artwork. */
function svgTextEntries(file) {
  if (!file.endsWith('.svg')) return [];
  const found = [];
  for (const match of read(file).matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)) {
    const value = normalise(match[1]);
    if (value) found.push({ file, key: `${file} <text>`, value, index: match.index });
  }
  return found;
}

const shipped = walk('public/').filter(file => inlineDefaults(file).length > 0).sort();

const failures = [];
const fail = (leg, detail) => failures.push({ leg, detail });

// R1 — no shipped German string uses the informal address.
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
const informalNoscript = [];
for (const file of walk('public/')) {
  for (const entry of noscriptDefaults(file)) if (INFORMAL.test(entry.value)) informalNoscript.push(entry);
}
const jsonLd = [];
for (const file of walk('public/').filter(f => f.endsWith('.html'))) {
  for (const block of read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    for (const value of block[1].matchAll(/"((?:[^"\\]|\\.){10,})"/g)) {
      const string = value[1].replace(/\\"/g, '"');
      if (INFORMAL.test(string)) jsonLd.push({ file, value: string });
    }
  }
}
const informalSvg = [];
for (const file of walk('public/').filter(f => f.endsWith('.svg'))) {
  for (const entry of svgTextEntries(file)) if (INFORMAL.test(entry.value)) informalSvg.push(entry);
}
for (const entry of [...informalCatalogue, ...informalInline, ...informalNoscript, ...jsonLd, ...informalSvg]) {
  if (ALLOWED.has(entry.key)) continue;
  fail('R1', `${entry.key || entry.file} uses the informal address: ${String(entry.value).slice(0, 110)}`);
}

// R2 — every inline default agrees with the catalogue value that replaces it at runtime.
const drift = [];
for (const file of shipped) {
  for (const entry of inlineDefaults(file)) {
    const catalogue = catalogueValue(entry.key);
    if (typeof catalogue !== 'string') { drift.push({ file, key: entry.key, value: entry.value, catalogue: null, how: entry.how }); continue; }
    if (normalise(catalogue) !== entry.value) drift.push({ file, key: entry.key, value: entry.value, catalogue: normalise(catalogue), how: entry.how });
  }
}
for (const entry of drift) {
  fail('R2', `${entry.file} [${entry.how}] ${entry.key}: inline "${entry.value.slice(0, 80)}" != catalogue "${String(entry.catalogue).slice(0, 80)}"`);
}

// R3 — the hero pair is the exact regression that reached production: pin both halves.
for (const key of ['intro1', 'intro2']) {
  const value = namespaces.public.de[key];
  if (!value || INFORMAL.test(value)) fail('R3', `public.${key} must address the reader formally, reads: ${value}`);
}

// R4 — the allowlist stays exactly the documented quotation, and cannot grow silently.
if (ALLOWED.size !== 1) fail('R4', `the allowlist must hold exactly one entry, holds ${ALLOWED.size}: ${[...ALLOWED.keys()].join(', ')}`);
for (const key of ALLOWED.keys()) {
  if (key !== 'public.checklist2') fail('R4', `unexpected allowlist entry ${key}`);
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

// R6 — every shipped file that declares an inline default must be scanned by R1 and R2, or be a
// documented dynamic-only exception.
const declared = [];
for (const file of walk('public/')) {
  const text = read(file);
  if (/data-i18n[-\w]*="/.test(text) || /data-i18n[-\w]*=\\"/.test(text) || /data-practice-key[-\w]*=/.test(text)) declared.push(file);
}
for (const file of declared.filter(f => !shipped.includes(f))) {
  if (!DYNAMIC_ONLY.has(file)) fail('R6', `shipped file declares inline defaults but is not scanned: ${file}`);
}
for (const file of DYNAMIC_ONLY.keys()) {
  if (shipped.includes(file)) fail('R6', `${file} is allowlisted as dynamic-only but has literal defaults; remove the exception`);
  else if (!declared.includes(file)) fail('R6', `${file} is allowlisted as dynamic-only but declares no inline default; remove the exception`);
}

// R7 — the authored writing stimulus is exam language: "du" there is content, not interface copy.
const stimulus = read('public/site.js');
if (!/Hast du Zeit, uns zu helfen\?/.test(stimulus)) fail('R7', 'the authored writing stimulus in public/site.js changed; it is exam content, not interface copy');

// R8 — safety net for the 2nd-person-singular family the curated list may not know yet.
const suspected = [];
const germanStrings = [
  ...Object.entries(namespaces).flatMap(([namespace, catalogue]) => Object.entries(catalogue.de || {}).map(([key, value]) => ({ key: `${namespace}.${key}`, value }))),
  ...shipped.flatMap(file => inlineDefaults(file).map(entry => ({ key: `${file} ${entry.key}`, value: entry.value }))),
  ...walk('public/').flatMap(file => noscriptDefaults(file).map(entry => ({ key: entry.key, value: entry.value }))),
  ...walk('public/').flatMap(file => svgTextEntries(file)),
];
for (const entry of germanStrings) {
  if (typeof entry.value !== 'string') continue;
  for (const word of entry.value.match(/(?<![\p{L}\p{N}])[A-Za-zÄÖÜäöüß]{3,}st(?![\p{L}\p{N}])/gu) || []) {
    const lower = word.toLowerCase();
    if (NOT_A_VERB_ST.has(lower)) continue;
    if (NOT_A_VERB_SUFFIX.some(suffix => lower.endsWith(suffix))) continue;
    if (INFORMAL.test(word)) continue;
    suspected.push({ key: entry.key, word, value: entry.value.slice(0, 100) });
  }
}
for (const entry of suspected) fail('R8', `${entry.key}: "${entry.word}" looks like a 2nd-person singular verb: ${entry.value}`);

// R9 — an SVG loaded through <img> runs in secure static mode and never fetches external resources, so a
// font it names by URL silently falls back to system metrics and the artwork lays out wrongly. That is the
// production landing defect of 5 October 2026; this leg is the gate that would have caught it.
const externalFonts = [];
for (const file of walk('public/').filter(f => f.endsWith('.svg'))) {
  for (const match of read(file).matchAll(/@font-face\{[^}]*?src:\s*url\((["']?)([^"')]+)/g)) {
    if (!match[2].startsWith('data:')) externalFonts.push({ file, url: match[2] });
  }
}
for (const entry of externalFonts) {
  fail('R9', `${entry.file} names a font by URL (${entry.url.slice(0, 70)}); an <img>-loaded SVG never fetches it, so the artwork falls back to system metrics`);
}

// R10 — a direction whose registry entry declares parameters must be rendered with them, or the learner
// sees the raw "{maxPlays}" token and the "translation unavailable" line instead of the sentence.
const missingParameters = [];
for (const file of walk('public/').filter(f => f.endsWith('.js'))) {
  const text = read(file);
  for (const match of text.matchAll(/instructionMarkup\(\{/g)) {
    const call = text.slice(match.index, match.index + 600);
    for (const idMatch of call.matchAll(/\bid:\s*'([A-Za-z0-9_.]+)'|\bid:\s*"([A-Za-z0-9_.]+)"/g)) {
      const id = idMatch[1] || idMatch[2];
      const entry = INSTRUCTIONS[id];
      if (entry && Object.keys(entry.parameters).length && !/parameters\s*:/.test(call)) missingParameters.push({ file, id });
    }
  }
}
for (const entry of missingParameters) {
  fail('R10', `${entry.file} renders ${entry.id} without its declared parameters, so a raw {token} would reach the learner`);
}

const summary = () => `${informalCatalogue.filter(e => !ALLOWED.has(e.key)).length + informalInline.filter(e => !ALLOWED.has(e.key)).length + informalNoscript.length + jsonLd.length + informalSvg.length} informal, ${drift.length} drifts, ${suspected.length} suspected, ${externalFonts.length} external font(s), ${missingParameters.length} unparameterised direction(s), ${shipped.length} shipped files`;

if (listOnly) {
  console.log('KLARTEXT — German interface register\n');
  console.log(`catalogue values still informal (${informalCatalogue.length}):`);
  for (const entry of informalCatalogue) console.log(`  ${ALLOWED.has(entry.key) ? '[allowed]' : '         '} ${entry.key}\n      ${entry.value}`);
  console.log(`\ninline defaults still informal (${informalInline.length}):`);
  for (const entry of informalInline) console.log(`  ${entry.file} [${entry.how}] ${entry.key}\n      ${entry.value}`);
  console.log(`\nnoscript German still informal (${informalNoscript.length}):`);
  for (const entry of informalNoscript) console.log(`  ${entry.key}\n      ${entry.value}`);
  console.log(`\nJSON-LD strings still informal (${jsonLd.length}):`);
  for (const entry of jsonLd) console.log(`  ${entry.file}\n      ${entry.value}`);
  console.log(`\nSVG artwork text still informal (${informalSvg.length}):`);
  for (const entry of informalSvg) console.log(`  ${entry.file}\n      ${entry.value}`);
  console.log(`\nSVG fonts loaded by URL instead of embedded (${externalFonts.length}):`);
  for (const entry of externalFonts) console.log(`  ${entry.file}\n      ${entry.url}`);
  console.log(`\nparameterised directions rendered without parameters (${missingParameters.length}):`);
  for (const entry of missingParameters) console.log(`  ${entry.file} -> ${entry.id}`);
  console.log(`\ninline defaults disagreeing with the catalogue (${drift.length}):`);
  for (const entry of drift) console.log(`  ${entry.file} [${entry.how}] ${entry.key}\n      inline    : ${entry.value}\n      catalogue : ${entry.catalogue}`);
  console.log(`\nsuspected 2nd-person forms (${suspected.length}):`);
  for (const entry of suspected) console.log(`  ${entry.key}: ${entry.word}\n      ${entry.value}`);
  console.log(`\nshipped files with inline defaults (${shipped.length}): ${shipped.join(', ')}`);
  process.exit(failures.length ? 1 : 0);
}

const legs = [
  ['R1 no shipped German string uses the informal address', informalCatalogue.filter(e => !ALLOWED.has(e.key)).length + informalInline.filter(e => !ALLOWED.has(e.key)).length + informalNoscript.length + jsonLd.length + informalSvg.length],
  ['R2 every inline German default equals the catalogue value', drift.length],
  ['R3 the public hero pair addresses the reader formally', failures.filter(f => f.leg === 'R3').length],
  ['R4 the allowlist is exactly the documented quotation', failures.filter(f => f.leg === 'R4').length],
  ['R5 every locale still carries every key, non-empty', failures.filter(f => f.leg === 'R5').length],
  ['R6 the scan covers every shipped declaration, attributes and noscript included', failures.filter(f => f.leg === 'R6').length],
  ['R7 the authored writing stimulus is untouched', failures.filter(f => f.leg === 'R7').length],
  ['R8 no unexplained 2nd-person singular verb form', failures.filter(f => f.leg === 'R8').length],
  ['R9 every shipped SVG embeds the fonts it names', failures.filter(f => f.leg === 'R9').length],
  ['R10 parameterised directions are rendered with their parameters', failures.filter(f => f.leg === 'R10').length],
];
for (const [name, count] of legs) console.log(`${count === 0 ? 'PASS' : 'FAIL'}  ${name}${count === 0 ? '' : `  [${count}]`}`);

if (failures.length) {
  console.log(`\n${failures.length} finding(s): ${summary()}`);
  for (const entry of failures.slice(0, 40)) console.log(`  ${entry.leg}  ${entry.detail}`);
  console.log('\nRun with --list for the full worklist.');
  process.exit(1);
}
console.log(`\nGerman register: 0 findings — ${summary()}.`);
