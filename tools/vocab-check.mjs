#!/usr/bin/env node
/**
 * VOCAB-01 — the Wortschatz check (MIRROR-B1PREP-01 slice G).
 *
 * OFFLINE, NO DATABASE, NO BROWSER. Every fixture is built from the payload the server actually serves,
 * not from this check's idea of it:
 *
 *   * the Prüfungskern documents are built from `data/core-grammar.json` and `data/core-phrases.json`
 *     with the same tier→section mapping the guide seed generator uses (`tools/build-guide-migration.mjs`),
 *     so section ids are the stored ids the translation keys are built from;
 *   * the deck rows come from `data/vocab.json` with the same entry-id and column mapping as
 *     `tools/build-vocab-migration.mjs`;
 *   * the `translations` member is built from the REAL bundle
 *     (`content/library-translations/hatoove-library-translations-uk-ar-tr.json`) in the shape
 *     `server/library-translations.mjs` `readGuideTranslations` produces.
 *
 * MEASURED, NOT ASSUMED (disposable PostgreSQL, 5 October 2026):
 *   * `GET /api/v1/vocab` passes no `limit`, and `adapter.listVocab` defaults to 50 → the route returns
 *     **50 of the 300 rows**; with `limit: 1000` the same call returns all 300. `GET /api/v1/guides`
 *     is NOT capped (7 rows).
 *   * the two core corpora carry what a browse-by-block view needs (tier title, tier why, item de/en,
 *     part of speech, note, German example); the only thing the payload does not carry is a uk/ar/tr
 *     translation except for the item EXAMPLES, which the bundle does cover.
 *
 * MUTATION PROOF: `--root=<dir>` runs every leg against a copied tree, so the ORDER leg, the BLOCK-LEG
 * and the D22 leg can each be broken in a `%TEMP%` copy and must fail there.
 *
 * Usage: node tools/vocab-check.mjs [--root=<dir>] [--harness <path>] [--serve <port>]
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const rootFlag = args.find(value => value.startsWith('--root='));
const ROOT = rootFlag ? path.resolve(rootFlag.slice('--root='.length)) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromRoot = relative => pathToFileURL(path.join(ROOT, relative)).href;
const readData = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${name}.json`), 'utf8'));

const { createVocabView, POS_FILTERS, CORE_CORPORA } = await import(fromRoot('public/app/vocab.js'));
const { WORTSCHATZ_GUIDE_IDS, storedTranslationPath } = await import(fromRoot('public/app/library.js'));
const { setLocale, getLocale } = await import(fromRoot('public/assets/i18n/core.js'));
const { s } = await import(fromRoot('public/app/locale-preference.js'));
const { pt } = await import(fromRoot('public/assets/i18n/practice-messages.js'));

const esc = value => String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
/** The library's own strings live in the practice catalogue; shell labels come from `s`. */
const l = (key, parameters) => pt(key, parameters);
const count = (haystack, needle) => haystack.split(needle).length - 1;
const slug = term => String(term).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const EXAM = 'telc-deutsch-b1';
const F2_BUNDLE_PATH = 'content/library-translations/hatoove-library-translations-uk-ar-tr.json';

/* --------------------------------------------------------------------------------------- fixtures */

/** One served `guide_section` per tier, exactly as `tools/build-guide-migration.mjs` maps them. */
function coreDocument(guideId, title, tiers) {
  const seen = new Map();
  const sectionId = headword => {
    const base = `${EXAM}.${guideId}.${slug(headword)}`;
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return occurrence === 1 ? base : `${base}-${occurrence}`;
  };
  return {
    guide_id: guideId, family: guideId, title, intro: null, intro_en: null,
    watch_out: [], watch_out_en: [],
    sections: tiers.map((tier, ordinal) => ({
      section_id: sectionId(tier.id ?? tier.title), ordinal, kind: 'tier',
      title: tier.title, title_en: tier.titleEn ?? null, summary: tier.why, summary_en: tier.whyEn ?? null,
      payload: { items: tier.items },
    })),
  };
}

function buildCoreGuides() {
  const grammar = readData('core-grammar');
  const phrases = readData('core-phrases');
  return [
    coreDocument('core-grammar', 'Kerngrammatik', grammar.tiers),
    coreDocument('core-phrases', 'Redemittel', phrases.tiers),
  ];
}

/** Served `vocab_entry` rows, exactly as `tools/build-vocab-migration.mjs` maps `data/vocab.json`. */
function buildDeck() {
  const seen = new Map();
  return readData('vocab').words.map((word, ordinal) => {
    const base = `${EXAM}.vocab.${slug(word.de)}`;
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return {
      entry_id: occurrence === 1 ? base : `${base}-${occurrence}`,
      exam_id: EXAM, ordinal,
      de: word.de, en: word.en, pos: word.pos,
      plural: word.plural ?? null, example: word.example ?? null, example_en: word.exampleEn ?? null,
      review_status: 'unreviewed', rights_basis: null, rights_status: 'generated',
    };
  });
}

/** The `translations` member `readGuideTranslations` builds, from the real bundle. */
function servedTranslations(bundle, guideId, locale = 'uk', status = 'machine_unreviewed') {
  const strings = {};
  const stringStatus = {};
  for (const [storedPath, members] of Object.entries(bundle.guides[guideId] || {})) {
    strings[storedPath] = members[locale];
    stringStatus[storedPath] = status;
  }
  return { locale, guideVersion: `${EXAM}.${guideId}@v1`, status, strings, stringStatus, nouns: {} };
}

/* ------------------------------------------------------------------------------- the fake server */

function fakeApi({ guides, deck, bundle, limit = 50, translations = true, status = 'machine_unreviewed', fail = null }) {
  const calls = [];
  const byId = new Map(guides.map(entry => [entry.guide_id, entry]));
  return {
    calls,
    guides: {
      read: async (guideId, locale) => {
        calls.push({ endpoint: 'guides.read', guideId, locale });
        if (fail === guideId) return { ok: false, status: 503, error: 'catalogue_unavailable' };
        const entry = byId.get(guideId);
        if (!entry) return { ok: false, status: 404, error: 'not_found' };
        // `readGuideTranslations` returns null for de/en and for an unimported locale: this fake mirrors
        // that rule rather than handing every page a bundle.
        const member = translations && bundle && locale !== 'de' && locale !== 'en'
          ? servedTranslations(bundle, guideId, locale, status) : null;
        return { ok: true, status: 200, data: { ...entry, translations: member } };
      },
    },
    vocab: {
      list: async (query = {}) => {
        calls.push({ endpoint: 'vocab.list', pos: query.pos ?? null, q: query.q ?? null });
        let rows = deck;
        // The route's own filter: pos is exact, q is a bounded case-insensitive substring on de/en.
        if (query.pos) rows = rows.filter(row => row.pos === query.pos);
        if (query.q) {
          const needle = String(query.q).toLowerCase();
          rows = rows.filter(row => row.de.toLowerCase().includes(needle) || String(row.en || '').toLowerCase().includes(needle));
        }
        return { ok: true, status: 200, data: rows.slice(0, limit) };
      },
    },
  };
}

/** A fake host. `closest` answers null so the module's legacy-hiding path is a no-op here. */
function fakeHost() {
  const parts = new Map();
  return {
    innerHTML: '', onclick: null, oninput: null,
    closest() { return null; },
    querySelector(selector) {
      if (!parts.has(selector)) parts.set(selector, { innerHTML: '', value: '', focus() {}, setSelectionRange() {} });
      return parts.get(selector);
    },
    querySelectorAll() { return []; },
    contains() { return false; },
    addEventListener() {},
    removeEventListener() {},
  };
}

const contextFor = (api, language) => ({
  api, esc, language, examLanguage: 'de',
  uiText: (key, parameters) => s(key, parameters),
  navigate: () => {},
  state: { settings: { language } },
  schedule: run => { run(); return 0; }, // the debounce is not what is under test
});

const settle = async () => { for (let round = 0; round < 12; round++) await new Promise(resolve => setImmediate(resolve)); };

/** Mount one view and let it settle. Only one view is live: a mounted view re-renders on locale change. */
let live = null;
async function mounted({ guides, deck, bundle = null, limit = 50, translations = true, status = 'machine_unreviewed', fail = null, language = 'de' }) {
  if (live) live.unmount();
  setLocale(language);
  const api = fakeApi({ guides, deck, bundle, limit, translations, status, fail });
  const host = fakeHost();
  const view = createVocabView(contextFor(api, language));
  view.mount(host);
  live = view;
  await settle();
  return { api, host, view, page: () => host.innerHTML };
}

/* --------------------------------------------------------------------------------- the assertions */

/** The item terms of one corpus card, in render order. */
const termsOf = (html, guideId) => {
  const start = html.indexOf(`data-vocab-corpus="${guideId}"`);
  if (start < 0) return [];
  const rest = html.slice(start + 1);
  const next = rest.indexOf('data-vocab-corpus="');
  const card = next < 0 ? rest : rest.slice(0, next);
  return [...card.matchAll(/<p class="vocab-term"[^>]*>([^<]*)<\/p>/g)].map(match => match[1]);
};
/** The deck's rendered headwords, in render order. */
const deckWords = html => {
  const start = html.indexOf('data-vocab-results');
  const card = start < 0 ? '' : html.slice(start);
  return [...card.matchAll(/<h4 lang="de" dir="ltr">([^<]*)<\/h4>/g)].map(match => match[1]);
};
const CLICK_BLOCK = (guideId, id) => ({ target: { closest: selector => (selector === '[data-vocab-block]' ? { dataset: { vocabBlock: `${guideId}:${id}` } } : null) } });
const CLICK_POS = value => ({ target: { closest: selector => (selector === '[data-vocab-pos]' ? { dataset: { vocabPos: value ?? '' } } : null) } });

async function assertOrderAndCounts(guides, bundle) {
  const { page } = await mounted({ guides, deck: allRows, bundle });
  const html = page();
  // 1. Prüfungskern first, deck second, and the two corpora in the contract's order.
  const coreAt = html.indexOf('id="vocab-core"');
  const deckAt = html.indexOf('id="vocab-deck"');
  assert.ok(coreAt >= 0 && deckAt >= 0, 'both chunks render');
  assert.ok(coreAt < deckAt, 'the Prüfungskern comes first in DOM order');
  assert.ok(html.indexOf('data-vocab-corpus="core-grammar"') < html.indexOf('data-vocab-corpus="core-phrases"'), 'the corpora keep their order');
  // 2. Counts come from the payload: one chip per tier with that tier's item count, plus the corpus total.
  for (const guide of guides) {
    const total = guide.sections.reduce((sum, section) => sum + section.payload.items.length, 0);
    assert.ok(html.includes(l('libraryCountEntries', { count: total })), `${guide.guide_id}: the corpus count is its payload total (${total})`);
    for (const section of guide.sections) {
      assert.ok(html.includes(`${esc(section.title)} <span class="vocab-chip-count">${section.payload.items.length}</span>`),
        `${guide.guide_id}: block "${section.title}" shows its own item count`);
    }
    assert.deepEqual(termsOf(html, guide.guide_id), guide.sections.flatMap(section => section.payload.items.map(item => esc(item.de))),
      `${guide.guide_id}: every payload item renders in payload order`);
  }
  // 3. The deck count and the truncation note are the served payload's, not the corpus's.
  assert.ok(html.includes(l('libraryShown', { count: servedRows.length })), 'the deck count is the served row count');
  assert.ok(html.includes(l('vocabPartial')), 'a list at the route page size says it may be truncated');
  assert.ok(!html.includes(l('libraryCountEntries', { count: allRows.length })), 'the page does not claim to show all 300 while the route caps at 50');
  assert.deepEqual(deckWords(html), servedRows.map(entry => esc(entry.de)), 'the deck renders exactly the served rows, in order');
  // 4. The part-of-speech chips are the ones the payload carries, not a hardcoded list.
  const servedPositions = [...new Set(servedRows.map(entry => entry.pos))].sort();
  for (const position of servedPositions) assert.ok(html.includes(l(`vocabPos${position[0].toUpperCase()}${position.slice(1)}`)) || html.includes(position), `the ${position} chip renders`);
  assert.equal(count(html, 'data-vocab-pos="'), servedPositions.length + 1, 'one chip per served part of speech, plus "Alle"');
  return true;
}

async function assertBlockBrowsing(guides, bundle) {
  const { host, page } = await mounted({ guides, deck: allRows, bundle });
  const grammar = guides.find(guide => guide.guide_id === 'core-grammar');
  // One block: exactly that tier's items, in order.
  host.onclick(CLICK_BLOCK('core-grammar', 'block-1'));
  await settle();
  assert.deepEqual(termsOf(page(), 'core-grammar'), grammar.sections[1].payload.items.map(item => esc(item.de)), 'block browsing shows exactly the chosen tier');
  assert.ok(!page().includes(esc(grammar.sections[0].payload.items[0].de)), 'the other tiers are not rendered while a block is chosen');
  // …and the other corpus is untouched by a choice made in this one.
  assert.deepEqual(termsOf(page(), 'core-phrases'), guides.find(guide => guide.guide_id === 'core-phrases').sections.flatMap(s => s.payload.items.map(i => esc(i.de))), 'the other corpus keeps all of its blocks');
  // Back to all blocks.
  host.onclick(CLICK_BLOCK('core-grammar', ''));
  await settle();
  assert.equal(termsOf(page(), 'core-grammar').length, grammar.sections.reduce((sum, s) => sum + s.payload.items.length, 0), '"Alle" restores every block');
  return true;
}

async function assertDeckFilters(guides, bundle) {
  const { host, api, page } = await mounted({ guides, deck: allRows, bundle });
  // Gender-style exact browse: the noun bucket, capped by the route's own page size.
  host.onclick(CLICK_POS('noun'));
  await settle();
  assert.ok(api.calls.some(call => call.endpoint === 'vocab.list' && call.pos === 'noun'), 'the part-of-speech filter queries the server');
  const nouns = allRows.filter(entry => entry.pos === 'noun').slice(0, 50);
  assert.deepEqual(deckWords(page()), nouns.map(entry => esc(entry.de)), 'the filter renders exactly the payload rows it asked for');
  assert.ok(page().includes(l('libraryShown', { count: nouns.length })), 'the count follows the filtered payload');
  // A bucket below the cap arrives complete.
  host.onclick(CLICK_POS('verb'));
  await settle();
  const verbs = allRows.filter(entry => entry.pos === 'verb');
  assert.ok(verbs.length < 50, 'the verb bucket is below the route page size');
  assert.deepEqual(deckWords(page()), verbs.map(entry => esc(entry.de)), 'a complete bucket renders every row');
  assert.ok(page().includes(l('libraryCountEntries', { count: verbs.length })), 'a complete list is counted as complete');
  assert.ok(!page().includes(l('vocabPartial')), 'a complete list does not claim truncation');
  // Search: two characters or more reaches the server, composes with the filter, and renders exactly
  // the rows the route would return.
  host.oninput({ target: { dataset: { vocabSearch: '' }, value: 'Arbeit' } });
  await settle();
  assert.ok(api.calls.some(call => call.endpoint === 'vocab.list' && call.q === 'Arbeit' && call.pos === 'verb'), 'the search keeps the active part-of-speech filter');
  const composed = allRows.filter(entry => entry.pos === 'verb' && `${entry.de} ${entry.en}`.toLowerCase().includes('arbeit')).slice(0, 50);
  assert.deepEqual(deckWords(page()), composed.map(entry => esc(entry.de)), 'the search composes with the part-of-speech filter');
  host.onclick(CLICK_POS(''));
  await settle();
  assert.ok(api.calls.some(call => call.endpoint === 'vocab.list' && call.q === 'Arbeit' && call.pos === null), 'clearing the filter keeps the search term');
  const matches = allRows.filter(entry => `${entry.de} ${entry.en}`.toLowerCase().includes('arbeit')).slice(0, 50);
  assert.ok(matches.length > 0, 'the corpus holds a match for the search term');
  assert.deepEqual(deckWords(page()), matches.map(entry => esc(entry.de)), 'the search renders exactly the matching rows');
  // One character is refused client-side, exactly as the route refuses a short query.
  const before = api.calls.length;
  host.oninput({ target: { dataset: { vocabSearch: '' }, value: 'A' } });
  await settle();
  assert.equal(api.calls.length, before, 'a one-character search does not query the server');
  assert.ok(page().includes(s('m068')), 'a one-character search explains the minimum');
  return true;
}

async function assertCompleteDeck(guides, bundle) {
  const { page } = await mounted({ guides, deck: allRows, bundle, limit: 1000 });
  const html = page();
  assert.deepEqual(deckWords(html), allRows.map(entry => esc(entry.de)), 'all 300 rows render when the route can serve them');
  assert.ok(html.includes(l('libraryCountEntries', { count: allRows.length })), 'the count is the payload total');
  assert.ok(!html.includes(l('vocabPartial')), 'a complete deck does not claim truncation');
  return true;
}

async function assertTranslations(guides, bundle) {
  const grammar = guides.find(guide => guide.guide_id === 'core-grammar');
  const ukrainian = await mounted({ guides, deck: allRows, bundle, language: 'uk' });
  const html = ukrainian.page();
  const section = grammar.sections[0];
  const path = storedTranslationPath('core-grammar', section.section_id, 'items.0.example');
  const expected = bundle.guides['core-grammar'][path].uk;
  assert.ok(expected, `the real bundle carries ${path}`);
  assert.ok(html.includes(esc(expected)), 'the real bundle example translation renders');
  assert.ok(count(html, l('libraryMachineTranslated')) >= 1, 'a machine-translated line carries the marker');
  assert.equal(count(html, s('m091')), 1, 'the deck shows exactly one "not yet available in your language" note');
  assert.equal(count(html, 'lang="en"'), 0, 'a Ukrainian page renders no authored English line at all');
  const approved = await mounted({ guides, deck: allRows, bundle, language: 'uk', status: 'approved' });
  assert.ok(approved.page().includes(esc(expected)), 'an approved bundle still renders its lines');
  assert.equal(count(approved.page(), l('libraryMachineTranslated')), 0, 'an approved line carries no marker');
  const english = await mounted({ guides, deck: allRows, bundle, language: 'en' });
  const englishPage = english.page();
  const distinctiveGloss = servedRows.map(entry => entry.en).filter(value => value && value.length >= 8).sort((a, b) => b.length - a.length)[0];
  assert.ok(distinctiveGloss && englishPage.includes(esc(distinctiveGloss)), 'the English page shows the authored gloss');
  assert.ok(count(englishPage, 'lang="en"') > 0, 'the English page marks the authored English content');
  assert.equal(count(englishPage, s('m091')), 0, 'the English page needs no note');
  assert.equal(count(englishPage, l('libraryMachineTranslated')), 0, 'the English page carries no machine marker for authored content');
  const german = await mounted({ guides, deck: allRows, bundle, language: 'de' });
  assert.equal(count(german.page(), s('m091')), 0, 'a German page shows no translation note');
  return true;
}

/** D22 and the slice's own scope: no spaced repetition, streak, readiness or study-plan surface. */
const BANNED = ['Spaced', 'spaced', 'SRS', 'Streak', 'streak', 'Serie', 'Lernplan', 'study plan', 'Study plan',
  'readiness', 'Readiness', 'Prognose', 'prognosis', 'Bestehenswahrscheinlichkeit', 'Tagesziel',
  'Wiederholungsplan', 'Wiederholung', 'review queue', 'fällig', 'due cards'];

async function assertNoDrillSurface(guides, bundle) {
  // Comments are stripped: the module's own header explains that spaced repetition is OUT of scope, and
  // that sentence must not fail the leg that enforces it. What is scanned is code and rendered chrome.
  const source = fs.readFileSync(path.join(ROOT, 'public/app/vocab.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const term of BANNED) assert.ok(!source.includes(term), `the module must not carry "${term}"`);
  // A word the CORPUS legitimately quotes (an exam word can be "Wiederholung") cannot discriminate a
  // drill surface from content, so it is excluded from the page scan — and the exclusion is printed,
  // because a silently shrinking scan is how a check stops checking.
  const corpus = [
    ...allRows.flatMap(entry => [entry.de, entry.en, entry.plural, entry.example]),
    ...guides.flatMap(guide => guide.sections.flatMap(section => section.payload.items.flatMap(item => [item.de, item.en, item.note, item.example]))),
  ].filter(Boolean).join(' ');
  const quoted = BANNED.filter(term => corpus.includes(term));
  const pageTerms = BANNED.filter(term => !quoted.includes(term));
  if (quoted.length) console.log(`     page scan excludes ${quoted.length} term(s) the corpus itself quotes: ${quoted.join(', ')}`);
  assert.ok(pageTerms.length >= 8, 'the page scan must keep enough discriminating terms');
  for (const language of ['de', 'en', 'uk', 'ar', 'tr']) {
    const { page } = await mounted({ guides, deck: allRows, bundle, language });
    const html = page();
    for (const term of pageTerms) assert.ok(!html.includes(term), `the ${language} page must not carry "${term}"`);
  }
  // No drill affordance either: nothing to tick, rate, repeat or schedule.
  const { page } = await mounted({ guides, deck: allRows, bundle });
  assert.equal(count(page(), '<input type="checkbox"'), 0, 'no per-item tick control');
  assert.equal(count(page(), 'data-vocab-drill'), 0, 'no drill control');
  assert.equal(count(page(), 'data-vocab-review'), 0, 'no review control');
  return true;
}

/* ------------------------------------------------------------------------------- mutation proof */

const COPY_FILES = [
  'public/app/vocab.js', 'public/app/vocab.css', 'public/app/library.js', 'public/app/guide-content.js',
  'public/app/read-aloud.js', 'public/app/locale-preference.js',
  'public/assets/i18n/core.js', 'public/assets/i18n/practice-messages.js', 'public/assets/i18n/shell-messages.js',
  'data/core-grammar.json', 'data/core-phrases.json', 'data/vocab.json',
  'content/library-translations/hatoove-library-translations-uk-ar-tr.json',
  'work/implementation/VOCAB-01.md', 'tools/vocab-check.mjs',
];

function copyTree(mutate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-check-'));
  for (const file of COPY_FILES) {
    const source = path.join(ROOT, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const vocabPath = path.join(directory, 'public/app/vocab.js');
  const before = fs.readFileSync(vocabPath, 'utf8');
  const after = mutate(before);
  assert.notEqual(after, before, 'the mutation must change the module');
  fs.writeFileSync(vocabPath, after);
  return directory;
}

function runCheckAgainst(directory) {
  return spawnSync(process.execPath, [path.join(ROOT, 'tools/vocab-check.mjs'), `--root=${directory}`],
    { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
}

function assertMutationProof() {
  const cases = [
    {
      name: 'M1 the deck before the Prüfungskern',
      mutate: source => source.replace('+ coreMarkup() + deckMarkup());', '+ deckMarkup() + coreMarkup());'),
      expected: /Prüfungskern comes first in DOM order/,
    },
    {
      name: 'M2 a block chip that ignores the chosen block',
      mutate: source => source.replace('const visible = active === null ? sections : sections.filter((section, index) => `block-${index}` === active);',
        'const visible = sections;'),
      expected: /block browsing shows exactly the chosen tier/,
    },
    {
      name: 'M3 a streak surface in the header',
      mutate: source => source.replace('<p class="muted">${esc(message(\'vocabIntro\'))}</p>', '<p class="muted">${esc(message(\'vocabIntro\'))} Streak: 3</p>'),
      expected: /must not carry "Streak"/,
    },
  ];
  for (const entry of cases) {
    const directory = copyTree(entry.mutate);
    const result = runCheckAgainst(directory);
    assert.notEqual(result.status, 0, `${entry.name}: the check must fail on the mutated copy`);
    assert.match(String(result.stdout) + String(result.stderr), entry.expected, `${entry.name}: it must fail on its own leg`);
    fs.rmSync(directory, { recursive: true, force: true });
    console.log(`     mutation ${entry.name}: failed as required`);
  }
  return true;
}

/* ------------------------------------------------------------------------- harness and static server */

function harnessHtml(guides, deck, bundle, prefix) {
  const fixtures = JSON.stringify({ guides, deck }).replace(/</g, '\\u003c');
  const served = { de: null, en: null };
  for (const language of ['uk', 'ar', 'tr']) {
    served[language] = Object.fromEntries(guides.map(entry => [entry.guide_id, servedTranslations(bundle, entry.guide_id, language)]));
  }
  const servedJson = JSON.stringify(served).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wortschatz harness — VOCAB-01</title>
<link rel="stylesheet" href="${prefix}public/assets/design/hatoove.css">
<link rel="stylesheet" href="${prefix}public/app/app.css">
<link rel="stylesheet" href="${prefix}public/app/vocab.css">
<style>body { margin: 0; padding: 16px; background: var(--canvas); color: var(--ink); } .harness-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }</style>
</head>
<body>
<!-- Standalone reviewer harness. Serve the WORKTREE ROOT over HTTP (module imports and file:// do not mix):
     node tools/vocab-check.mjs --harness handoff/ron-agent/vocab-01/vocab-harness.html --serve 4321
     then open http://127.0.0.1:4321/handoff/ron-agent/vocab-01/vocab-harness.html
     ?locale=uk&limit=50&theme=dark preselect a state. -->
<div class="harness-bar">
  <label for="locale">Sprache</label>
  <select id="locale"><option>de</option><option>en</option><option>uk</option><option>ar</option><option>tr</option></select>
  <label for="limit">Deck-Grenze</label>
  <select id="limit"><option value="50">50 (Server wie gemessen)</option><option value="1000">1000 (ganzer Katalog)</option></select>
  <button type="button" id="apply">Laden</button>
</div>
<p id="harness-error" class="err" hidden></p>
<main id="host"></main>
<script type="application/json" id="fixtures">${fixtures}</script>
<script type="application/json" id="served">${servedJson}</script>
<script type="module">
import { createVocabView } from '${prefix}public/app/vocab.js';
import { setLocale } from '${prefix}public/assets/i18n/core.js';
import { s } from '${prefix}public/app/locale-preference.js';
const fixtures = JSON.parse(document.getElementById('fixtures').textContent);
const served = JSON.parse(document.getElementById('served').textContent);
const esc = value => String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
const params = new URLSearchParams(location.search);
if (params.get('locale')) document.getElementById('locale').value = params.get('locale');
if (params.get('limit')) document.getElementById('limit').value = params.get('limit');
if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
function api(limit, language) {
  return {
    guides: { read: async guideId => {
      const entry = fixtures.guides.find(candidate => candidate.guide_id === guideId);
      if (!entry) return { ok: false, status: 404, error: 'not_found' };
      return { ok: true, status: 200, data: { ...entry, translations: served[language] ? served[language][guideId] : null } };
    } },
    vocab: { list: async (query = {}) => {
      let rows = fixtures.deck;
      if (query.pos) rows = rows.filter(row => row.pos === query.pos);
      if (query.q) { const needle = String(query.q).toLowerCase(); rows = rows.filter(row => row.de.toLowerCase().includes(needle) || String(row.en || '').toLowerCase().includes(needle)); }
      return { ok: true, status: 200, data: rows.slice(0, limit) };
    } },
  };
}
const host = document.getElementById('host');
let view = null;
function load() {
  try {
    const language = document.getElementById('locale').value;
    const limit = Number(document.getElementById('limit').value);
    setLocale(language);
    if (view) view.unmount();
    view = createVocabView({ api: api(limit, language), esc, language, examLanguage: 'de', uiText: (key, parameters) => s(key, parameters),
      navigate: hash => { location.hash = hash; }, state: { settings: { language } }, schedule: run => { run(); return 0; } });
    view.mount(host);
  } catch (error) {
    const box = document.getElementById('harness-error');
    box.hidden = false; box.textContent = 'HARNESS FAILURE: ' + ((error && error.message) || error);
  }
}
document.getElementById('apply').addEventListener('click', load);
document.getElementById('locale').addEventListener('change', load);
document.getElementById('limit').addEventListener('change', load);
load();
</script>
</body>
</html>
`;
}

function serve(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  return import('node:http').then(({ default: http }) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const target = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
      if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) { response.writeHead(404); response.end('not found'); return; }
      response.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(target).pipe(response);
    });
    server.listen(port, '127.0.0.1', () => console.log(`harness server: http://127.0.0.1:${port}/handoff/ron-agent/vocab-01/vocab-harness.html`));
  });
}

/* --------------------------------------------------------------------------------------------- main */

const guides = buildCoreGuides();
const allRows = buildDeck();
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, F2_BUNDLE_PATH), 'utf8'));
// The route's own page size: `adapter.listVocab` defaults to 50 and `/api/v1/vocab` passes no limit.
const servedRows = allRows.slice(0, 50);
assert.equal(allRows.length, 300, 'the vocab source still holds 300 entries');
assert.equal(guides.find(guide => guide.guide_id === 'core-grammar').sections.length, 4, 'core-grammar still maps to 4 tiers');
assert.equal(guides.find(guide => guide.guide_id === 'core-phrases').sections.length, 3, 'core-phrases still maps to 3 tiers');
assert.deepEqual([...CORE_CORPORA], [...WORTSCHATZ_GUIDE_IDS], 'the module and the library agree on the corpus boundary');
assert.ok(POS_FILTERS.some(filter => filter.value === 'verb'), 'the filter list mirrors the route\'s closed pos set');

await assertOrderAndCounts(guides, bundle);
await assertBlockBrowsing(guides, bundle);
await assertDeckFilters(guides, bundle);
await assertCompleteDeck(guides, bundle);
await assertTranslations(guides, bundle);
await assertNoDrillSurface(guides, bundle);
assertMutationProof();
if (live) live.unmount();

const harness = option('--harness');
if (harness) {
  const target = path.resolve(ROOT, harness);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const prefix = path.relative(path.dirname(target), ROOT).split(path.sep).join('/') + '/';
  fs.writeFileSync(target, harnessHtml(guides, allRows, bundle, prefix));
  console.log(`harness written: ${target}`);
}
const port = option('--serve');
if (port) await serve(Number(port));

console.log('PASS vocab render: Prüfungskern before the deck, block browsing and deck browse/search exact against the payload,');
console.log('     counts from the payload on both halves, the real bundle\'s example translations with their marker, and no');
console.log(`     spaced-repetition, streak, readiness or study-plan surface. root=${path.relative(process.cwd(), ROOT) || '.'}`);
