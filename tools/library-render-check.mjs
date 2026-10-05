#!/usr/bin/env node
/**
 * LIBRARY-UI-01/02 — the Nachschlagen library check (MIRROR-B1PREP-01 slices E/F).
 *
 * OFFLINE AND DETERMINISTIC. No database, no browser, no server: the guide documents are built from
 * `data/*.json` with the same section mapping the two generators use
 * (`tools/build-guide-migration.mjs`, `tools/build-writing-speaking-migration.mjs`), served through a
 * recording fake api, and the module is mounted into a fake host whose `innerHTML` is the artefact
 * under test. The reviewer can therefore reproduce every claim with `node tools/library-render-check.mjs`.
 *
 * WHAT IT PROVES
 *   1. the hub renders the six contracted areas and their counts come from the served payload;
 *   2. each of the seven guides renders: title, pill, "← Nachschlagen" at top AND bottom, and a jump
 *      chip for EVERY section (plus the watch-out block where the guide has one);
 *   3. all eight case tables mark exactly the cells that differ from the Nominativ reference, with a
 *      legend only when something is marked, and a hand-derived expectation for two of them;
 *   4. an Arabic page is RTL with German islands kept LTR;
 *   5. with `translations: null` a non-German page shows the German source plus EXACTLY ONE
 *      "not available in your language" note, and a machine-translated line carries its marker;
 *   6. the noun lexicon filters by gender, searches server-side, reports its count from the payload,
 *      renders in the learner's language when a bundle exists, and says so when the served list may be
 *      truncated (the route's page size).
 *
 * MUTATION PROOF. `--mutate-proof` (always run) copies the shipped modules into a temporary directory,
 * breaks one rule at a time — the case-table comparison and the single-note rule — and asserts that a
 * runner written against the CORRECT rule then fails. A check that cannot fail is not a check.
 *
 * USAGE
 *   node tools/library-render-check.mjs                  run the check
 *   node tools/library-render-check.mjs --harness PATH   also write a standalone harness HTML
 *   node tools/library-render-check.mjs --serve PORT     also serve this worktree read-only (Ctrl-C to stop)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createLibraryView, caseHighlights, LIBRARY_AREAS, SECTION_LABELS, NOUN_PAGE_SIZE, storedTranslationPath, WORTSCHATZ_GUIDE_IDS, PENDING_TRANSLATIONS } from '../public/app/library.js';
import { guideContent } from '../public/app/guide-content.js';
import { setLocale, getLocale } from '../public/assets/i18n/core.js';
import { s } from '../public/app/locale-preference.js';
import { pt } from '../public/assets/i18n/practice-messages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = value => String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
/** The library's own interface strings live in the practice catalogue; shell labels come from `s`. */
const l = (key, parameters) => pt(key, parameters);
const count = (haystack, needle) => haystack.split(needle).length - 1;
const readData = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${name}.json`), 'utf8'));

/* --------------------------------------------------------------------------------------- fixtures */

const section = (kind, id, title, titleEn, summary, summaryEn, payload) => ({
  section_id: id, kind, title, title_en: titleEn, summary, summary_en: summaryEn, payload,
});
/**
 * Section ids exactly as the generators make them (`tools/lib/library-seed.mjs` `slug`/`makeIdFactory`),
 * because slice F2's translation keys are `<guide_id>/<section_id>.<field>` and the real bundle uses
 * these ids. The fixture has to speak production's id language for the translation leg to mean anything.
 */
const slug = term => String(term).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const storedSectionId = (guideId, headword) => `telc-deutsch-b1.${guideId}.${slug(headword)}`;
/** The same assignment the generators run, including their `-2`, `-3` collision suffixes. */
function sectionIdFactory(guideId) {
  const seen = new Map();
  return headword => {
    const base = storedSectionId(guideId, headword);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
}
const document_ = (guideId, family, title, intro, introEn, watchOut, watchOutEn, sections) => {
  const idFor = sectionIdFactory(guideId);
  return {
    guide_id: guideId, family, title, intro, intro_en: introEn,
    watch_out: watchOut || [], watch_out_en: watchOutEn || [],
    section_count: sections.length,
    sections: sections.map((entry, ordinal) => ({ ...entry, section_id: idFor(entry.section_id), ordinal })),
  };
};

/**
 * The seven guide documents, mapped exactly as the two generators map them. The expected section
 * counts are asserted below, so a data change that the fixture does not mirror is a failure here
 * rather than a silent difference between this check and production.
 */
function buildGuides() {
  const grammar = readData('grammar-guide');
  const coreGrammar = readData('core-grammar');
  const corePhrases = readData('core-phrases');
  const gender = readData('gender-rules');
  const cases = readData('cases-guide');
  const writing = readData('writing-guide');
  const speaking = readData('speaking-guide');
  return [
    document_('grammar-guide', 'grammar', 'Grammatik', grammar.intro, grammar.introEn, grammar.watchOut, grammar.watchOutEn,
      grammar.topics.map(topic => section('topic', topic.id, topic.title, topic.titleEn, topic.why, topic.whyEn, {
        rule: topic.rule, ruleEn: topic.ruleEn, pattern: topic.pattern, patternEn: topic.patternEn,
        examples: topic.examples, table: topic.table, traps: topic.traps, trapsEn: topic.trapsEn,
      }))),
    document_('core-grammar', 'core-grammar', 'Kerngrammatik', coreGrammar.intro, coreGrammar.introEn, null, null,
      coreGrammar.tiers.map(tier => section('tier', tier.id, tier.title, tier.titleEn, tier.why, tier.whyEn, { items: tier.items }))),
    document_('core-phrases', 'core-phrases', 'Redemittel', corePhrases.intro, corePhrases.introEn, null, null,
      corePhrases.tiers.map(tier => section('tier', tier.id, tier.title, tier.titleEn, tier.why, tier.whyEn, { items: tier.items }))),
    document_('gender-rules', 'gender', 'Genus: Regeln', gender.intro, gender.introEn, gender.watchOut, gender.watchOutEn, [
      ...gender.rules.map((rule, index) => section('gender_rule', `rule-${index + 1}-${rule.gender}`, rule.title, rule.titleEn, rule.note, rule.noteEn, {
        gender: rule.gender, kind: rule.kind, items: rule.items, examples: rule.examples,
      })),
      ...gender.exceptions.map(exception => section('exception', `exception-${exception.de}`, exception.de, null, exception.why, exception.whyEn, {
        en: exception.en, plural: exception.plural, looks: exception.looks,
      })),
      ...gender.doubleGender.map(double => section('double_gender', `double-${double.de}`, double.de, null, double.why, double.whyEn, {
        en: double.en, other: double.other, otherEn: double.otherEn,
      })),
    ]),
    document_('cases-guide', 'cases', 'Fälle und Artikel', cases.intro, cases.introEn, cases.watchOut, cases.watchOutEn, [
      ...cases.tables.map(table => section('table', table.id, table.title, table.titleEn, table.why, table.whyEn, {
        headers: table.headers, headersEn: table.headersEn, rows: table.rows, note: table.note, noteEn: table.noteEn,
      })),
      ...cases.triggers.map((trigger, index) => section('trigger', `trigger-${index + 1}-${trigger.case}`, trigger.kind, trigger.kindEn, trigger.example, trigger.en, {
        case: trigger.case, items: trigger.items,
      })),
      ...cases.examples.map((example, index) => section('example', `example-${index + 1}`, example.de, null, example.note, null, { en: example.en })),
    ]),
    document_('writing-guide', 'writing-guide', 'Briefe schreiben', writing.intro, writing.introEn, writing.watchOut, writing.watchOutEn, [
      ...writing.sections.map((step, index) => section('step', `step-${index + 1}`, step.title, step.titleEn, step.why, step.whyEn, { points: step.points })),
      ...writing.phrases.map((phrase, index) => section('phrase_group', `phrases-${index + 1}`, phrase.group, phrase.groupEn, phrase.hint, phrase.hintEn, { items: phrase.items })),
      ...writing.examples.map((example, index) => section('example_letter', `letter-${index + 1}`, example.type, example.typeEn, example.situation, example.situationEn, {
        leitpunkte: example.leitpunkte, leitpunkteEn: example.leitpunkteEn, text: example.text,
      })),
      section('checklist', 'checklist', 'Checkliste', 'Checklist', 'Vor dem Abgeben durchgehen.', 'Work through this before submitting.', { items: writing.checklist, itemsEn: writing.checklistEn }),
    ]),
    document_('speaking-guide', 'speaking-guide', 'Mündliche Prüfung', speaking.intro, speaking.introEn, speaking.watchOut, speaking.watchOutEn,
      speaking.parts.map(part => section('part', part.id, part.title, part.titleEn, part.summary, part.summaryEn, {
        minutes: part.minutes, approach: part.approach, phrases: part.phrases, examples: part.examples,
        watchOut: part.watchOut, watchOutEn: part.watchOutEn,
      }))),
  ];
}

function buildNouns() {
  // Ids exactly as `tools/build-noun-migration.mjs` makes them: one `makeIdFactory('telc-deutsch-b1.noun')`
  // over the whole file, so slice F2's `nouns[entry_id]` key space is the one production has.
  const seen = new Map();
  return readData('noun-lexicon').nouns.map((noun, index) => {
    const base = storedSectionId('noun', noun.de);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const entry_id = count === 1 ? base : `${base}-${count}`;
    return { entry_id, ...noun };
  });
}

const EXPECTED_SECTIONS = {
  'grammar-guide': 14, 'core-grammar': 4, 'core-phrases': 3, 'gender-rules': 60,
  'cases-guide': 20, 'writing-guide': 19, 'speaking-guide': 3,
};

/* ------------------------------------------------------------------------------- the fake server */

function fakeApi({ documents, nouns, limit = NOUN_PAGE_SIZE, translations = null }) {
  const calls = [];
  const byId = new Map(documents.map(entry => [entry.guide_id, entry]));
  return {
    calls,
    guides: {
      list: async () => {
        calls.push({ endpoint: 'guides.list' });
        return { ok: true, status: 200, data: documents.map(entry => ({
          guide_id: entry.guide_id, family: entry.family, title: entry.title, intro: entry.intro, section_count: entry.sections.length,
        })) };
      },
      read: async (guideId, locale) => {
        calls.push({ endpoint: 'guides.read', guideId, locale });
        const entry = byId.get(guideId);
        if (!entry) return { ok: false, status: 404, error: 'not_found' };
        return { ok: true, status: 200, data: { ...entry, translations: typeof translations === 'function' ? translations(guideId, locale) : (translations || null) } };
      },
    },
    nouns: {
      list: async (query = {}) => {
        calls.push({ endpoint: 'nouns.list', gender: query.gender ?? null, q: query.q ?? null });
        let rows = nouns;
        if (query.gender) rows = rows.filter(row => row.gender === query.gender);
        if (query.q) {
          const needle = String(query.q).toLowerCase();
          rows = rows.filter(row => row.de.toLowerCase().includes(needle) || String(row.en || '').toLowerCase().includes(needle));
        }
        return { ok: true, status: 200, data: rows.slice(0, limit) };
      },
    },
  };
}

/**
 * A fake host. `innerHTML` is the artefact; delegated handlers are exposed as properties so the check
 * can drive a click or a keystroke without a DOM. `querySelector` answers with a small stand-in for
 * the containers the module focuses or updates.
 */
function fakeHost() {
  const parts = new Map();
  const host = {
    innerHTML: '',
    onclick: null,
    oninput: null,
    querySelector(selector) {
      if (!parts.has(selector)) parts.set(selector, { innerHTML: '', value: '', focus() {}, setSelectionRange() {} });
      return parts.get(selector);
    },
    querySelectorAll() { return []; },
    contains() { return false; },
    addEventListener() {},
    removeEventListener() {},
  };
  return host;
}

const contextFor = (api, language, navigations = []) => ({
  api,
  esc,
  language,
  uiText: (key, parameters) => s(key, parameters),
  navigate: hash => navigations.push(hash),
  state: { settings: { language } },
  guideContent,
  schedule: run => { run(); return 0; }, // the debounce is not what is under test
});

const settle = async () => { for (let round = 0; round < 12; round++) await new Promise(resolve => setImmediate(resolve)); };

/**
 * Mount one view and let it settle. Only one view is ever live: a mounted view re-renders when the
 * interface language changes (that is the module's job), so leaving earlier views mounted would let a
 * later `setLocale` rewrite a page an earlier assertion already read.
 */
let live = null;
async function mounted({ documents, nouns, limit, translations = null, language = 'de', route = '#/nachschlagen' }) {
  if (live) live.unmount();
  setLocale(language);
  const api = fakeApi({ documents, nouns, limit, translations });
  const navigations = [];
  const host = fakeHost();
  const view = createLibraryView(contextFor(api, language, navigations));
  view.mount(host, { route });
  live = view;
  await settle();
  return { api, host, view, navigations, page: () => host.innerHTML };
}

/* --------------------------------------------------------------------------------- the assertions */

function assertHub(guides, nouns) {
  return mounted({ documents: guides, nouns }).then(({ page, api }) => {
    const html = page();
    assert.equal(count(html, 'data-library-card="'), LIBRARY_AREAS.length, 'the hub renders one card per contracted area');
    assert.ok(html.includes(l('libraryAreasCount', { count: LIBRARY_AREAS.length })), 'the header counts the areas');
    assert.ok(html.includes('6 Bereiche'), 'the German header reads as contracted');
    const cardIds = [...html.matchAll(/data-library-card="([a-z]+)"/g)].map(match => match[1]);
    assert.deepEqual(cardIds, ['speaking', 'writing', 'cases', 'gender', 'grammar', 'satzbau'], 'the six areas, in the contracted order');
    // Counts come from the served payload: every card with a guide shows that guide's section_count.
    const expectations = [['speaking', 'speaking-guide', 'libraryCountParts'], ['writing', 'writing-guide', 'libraryCountEntries'],
      ['cases', 'cases-guide', 'libraryCountEntries'], ['gender', 'gender-rules', 'libraryCountEntries'], ['grammar', 'grammar-guide', 'libraryCountTopics']];
    for (const [area, guideId, unit] of expectations) {
      const guide = guides.find(entry => entry.guide_id === guideId);
      const expected = l(unit, { count: guide.sections.length });
      assert.ok(html.includes(expected), `the ${area} card shows its payload count (${expected})`);
    }
    assert.ok(html.includes(l('libraryLexicon')), 'the Nomen & Genus card names the lexicon');
    assert.ok(html.includes('href="#/nachschlagen/satzbau"'), 'the Satzbau card links to the existing tool');
    // Kerngrammatik and the core phrases are NOT hub cards (they belong to Wortschatz, slice G).
    assert.ok(!html.includes('Kerngrammatik'), 'Kerngrammatik is not a hub card');
    assert.ok(!cardIds.includes('core-grammar') && !cardIds.includes('core-phrases'), 'the core documents are not hub cards');
    assert.ok(!html.includes('Übersetzung nicht verfügbar'), 'no label fell through to the unavailable message');
    assert.ok(api.calls.some(call => call.endpoint === 'guides.list'), 'the hub reads the guide index');
    assert.ok(!api.calls.some(call => call.endpoint === 'guides.read'), 'the hub does not download whole guides for counts');
    return true;
  });
}

function guideKindCounts(guide) {
  const kinds = new Map();
  for (const entry of guide.sections) kinds.set(entry.kind, (kinds.get(entry.kind) || 0) + 1);
  return kinds;
}

async function assertGuides(guides, nouns) {
  // Slice G owns Kerngrammatik and the core phrases; the library must not render them at all.
  const libraryGuides = guides.filter(guide => !WORTSCHATZ_GUIDE_IDS.includes(guide.guide_id));
  assert.equal(libraryGuides.length, guides.length - WORTSCHATZ_GUIDE_IDS.length, 'the two Wortschatz corpora are excluded from the library');
  for (const guide of guides.filter(guide => WORTSCHATZ_GUIDE_IDS.includes(guide.guide_id))) {
    const { page, api } = await mounted({ documents: guides, nouns, route: `#/nachschlagen/${guide.guide_id}` });
    const html = page();
    assert.ok(html.includes(l('libraryMovedToVocab')), `${guide.guide_id}: a deep link hands over to Wortschatz`);
    assert.ok(html.includes('href="#/wortschatz"'), `${guide.guide_id}: the hand-over links to the Wortschatz route`);
    const firstItem = guide.sections[0]?.payload?.items?.[0]?.de ?? '';
    assert.ok(firstItem && !html.includes(firstItem), `${guide.guide_id}: the library does not render the corpus items it no longer owns`);
    assert.ok(!api.calls.some(call => call.endpoint === 'guides.read' && call.guideId === guide.guide_id), `${guide.guide_id}: the corpus is not even fetched`);
  }
  for (const guide of libraryGuides) {
    const { page, api } = await mounted({ documents: guides, nouns, route: `#/nachschlagen/${guide.guide_id}` });
    const html = page();
    const label = guide.guide_id;
    assert.ok(html.includes(guide.title), `${label}: the document title is rendered`);
    assert.ok(html.includes(l('libraryPill')), `${label}: the reference-only pill is rendered`);
    assert.ok(html.includes(s('m090')), `${label}: the unreviewed-material note is rendered`);
    assert.equal(count(html, 'data-library-hub'), 2, `${label}: "back to Nachschlagen" appears at the top and the bottom`);
    assert.equal(count(html, 'data-library-jump="'), guide.sections.length + (guide.watch_out.length ? 1 : 0) + (guide.guide_id === 'gender-rules' ? 1 : 0),
      `${label}: every section has a jump chip`);
    guide.sections.forEach((entry, position) => {
      const anchor = `library-section-${entry.ordinal}`;
      assert.ok(html.includes(`id="${anchor}"`), `${label}: section ${position} has a jump target`);
      assert.ok(html.includes(`data-library-jump="${anchor}"`), `${label}: section ${position} has a jump chip`);
    });
    assert.ok(html.includes(`data-library-case-table=`) || guide.guide_id !== 'cases-guide', `${label}: case tables render through the library renderer`);
    for (const [kind, total] of guideKindCounts(guide)) {
      assert.ok(html.includes(`${s(SECTION_LABELS[kind] || 'm085')}: ${total}`),
        `${label}: the header counts its ${kind} sections from the payload`);
    }
    assert.ok(!html.includes('Übersetzung nicht verfügbar'), `${label}: no label fell through to the unavailable message`);
    assert.ok(api.calls.some(call => call.endpoint === 'guides.read' && call.guideId === guide.guide_id), `${label}: the document was read`);
    if (guide.guide_id === 'gender-rules') {
      assert.ok(api.calls.some(call => call.endpoint === 'nouns.list' && call.gender === null && call.q === null), `${label}: the lexicon is read`);
    }
    // The German line stays the source of truth: every authored example survives into the page.
    assert.ok(html.includes('lang="de" dir="ltr"'), `${label}: German content is marked as LTR German`);
  }
  return true;
}

/** A second, independent implementation of the documented highlight rule. */
function expectedHighlights(table) {
  const nominative = value => String(value ?? '').trim().toLowerCase() === 'nominativ';
  const marks = new Set();
  const rowReference = table.rows.findIndex(row => nominative(row[0]));
  const columnReference = table.headers.findIndex((header, index) => index > 0 && nominative(header));
  table.rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (c === 0) return;
      if (rowReference >= 0) {
        if (r === rowReference) return;
        if (String(cell) !== String(table.rows[rowReference][c])) marks.add(`${r}:${c}`);
      } else if (columnReference > 0 && c !== columnReference) {
        if (String(cell) !== String(row[columnReference])) marks.add(`${r}:${c}`);
      }
    });
  });
  return marks;
}

async function assertCaseTables(guides, nouns) {
  const cases = readData('cases-guide');
  const { page } = await mounted({ documents: guides, nouns, route: '#/nachschlagen/cases-guide' });
  const html = page();
  const blocks = [...html.matchAll(/data-library-case-table="([^"]+)"[\s\S]*?<\/table>/g)];
  assert.equal(blocks.length, cases.tables.length, `all ${cases.tables.length} case tables render`);
  for (const block of blocks) {
    const id = block[1];
    const table = cases.tables.find(entry => storedSectionId('cases-guide', entry.id) === id);
    assert.ok(table, `the rendered table ${id} exists in the source`);
    const marks = new Set([...block[0].matchAll(/data-library-case="(\d+):(\d+)"/g)].map(match => `${match[1]}:${match[2]}`));
    const expected = expectedHighlights(table);
    assert.deepEqual([...marks].sort(), [...expected].sort(), `${id}: the marked cells are exactly the non-Nominativ cells`);
    const legendAfter = html.slice(html.indexOf(`data-library-case-table="${id}"`));
    const hasLegend = legendAfter.slice(0, legendAfter.indexOf('</table>') + 400).includes(l('libraryCasesLegend'));
    assert.equal(hasLegend, expected.size > 0, `${id}: the legend appears exactly when something is marked`);
  }
  // Hand-derived expectations for two tables, so the algorithmic comparison has a second witness.
  const byId = localId => blocks.find(block => block[1] === storedSectionId('cases-guide', localId))[0];
  const marksOf = id => [...new Set([...byId(id).matchAll(/data-library-case="(\d+):(\d+)"/g)].map(match => `${match[1]}:${match[2]}`))].sort();
  assert.deepEqual(marksOf('bestimmter_artikel'), ['1:1', '2:1', '2:2', '2:3', '2:4', '3:1', '3:2', '3:3', '3:4'], 'bestimmter_artikel: hand-derived marks');
  assert.deepEqual(marksOf('adjektivendungen_bestimmt'), ['1:1', '2:1', '2:2', '2:3', '3:1', '3:2', '3:3'], 'adjektivendungen_bestimmt: hand-derived marks (the Plural column is -en in every row, so nothing there differs)');
  assert.deepEqual(marksOf('praepositionen_kasus'), [], 'a table with no Nominativ reference marks nothing');
  assert.deepEqual(caseHighlights({ headers: ['', 'A'], rows: [['Nominativ', 'x'], ['Genitiv', 'y']] }).marked, new Set(['1:1']), 'the exported helper marks the differing cell');
  assert.deepEqual([...caseHighlights({ headers: ['', 'A'], rows: [['Dativ', 'x']] }).marked], [], 'no reference, no mark');
  return true;
}

async function assertRtl(guides, nouns) {
  const arabic = await mounted({ documents: guides, nouns, language: 'ar', route: '#/nachschlagen/cases-guide' });
  const html = arabic.page();
  assert.ok(html.includes('<section class="library" lang="ar" dir="rtl"'), 'the Arabic page is RTL');
  assert.ok(count(html, 'lang="de" dir="ltr"') > 40, 'German fragments stay explicit LTR islands');
  assert.ok(!html.includes('lang="ar" dir="ltr"'), 'no Arabic content is marked LTR');
  const note = s('m091');
  assert.equal(count(html, note), 1, 'German-only mode shows exactly one "not available in your language" note');
  assert.ok(html.includes('Ich fahre mit dem Bus'), 'the German content is still rendered for an Arabic learner');

  const ukrainian = await mounted({ documents: guides, nouns, language: 'uk', route: '#/nachschlagen/grammar-guide' });
  assert.equal(count(ukrainian.page(), s('m091')), 1, 'Ukrainian German-only mode also shows exactly one note');

  const german = await mounted({ documents: guides, nouns, language: 'de', route: '#/nachschlagen/grammar-guide' });
  assert.equal(count(german.page(), s('m091')), 0, 'a German page shows no translation note');

  const english = await mounted({ documents: guides, nouns, language: 'en', route: '#/nachschlagen/cases-guide' });
  const englishPage = english.page();
  assert.equal(count(englishPage, s('m091')), 0, 'the authored English fields need no note');
  assert.ok(englishPage.includes('In German the article shows what role a noun plays'), 'the authored English intro is rendered readably');

  // Language purity: the authored `…En` fields belong to the English page and to no other. An Arabic
  // learner must not be handed an English paragraph under a German example (found in the harness).
  // Both pages are captured before the next mount, because mounting another view changes the language.
  const phrase = 'With a reflexive verb a small word belongs';
  const arabicGrammarPage = (await mounted({ documents: guides, nouns, language: 'ar', route: '#/nachschlagen/grammar-guide' })).page();
  const englishGrammarPage = (await mounted({ documents: guides, nouns, language: 'en', route: '#/nachschlagen/grammar-guide' })).page();
  assert.ok(!arabicGrammarPage.includes(phrase), 'an Arabic page shows the German source only, never the authored English line');
  assert.ok(englishGrammarPage.includes(phrase), 'an English page shows the authored English line');
  return true;
}

/**
 * A small fixture member in the STORED key form (`<guide>/<section_id>.<field>`), which is what
 * `server/library-translations.mjs` serves. It exists only to pin the per-line marker and the
 * fallback behaviour; the leg over the REAL bundle is `assertRealBundleTranslation` below.
 */
function machineBundle(guides, { legacyKeys = false, status = 'machine_unreviewed' } = {}) {
  const cases = guides.find(entry => entry.guide_id === 'cases-guide');
  const table = cases.sections.find(entry => entry.section_id.endsWith('.bestimmter-artikel'));
  const key = suffix => (legacyKeys ? `${table.section_id}.${suffix}` : `cases-guide/${table.section_id}.${suffix}`);
  const bundle = {
    locale: 'ar', guideVersion: 'telc-deutsch-b1.cases-guide@v1', status,
    strings: {
      [key('title')]: 'أداة التعريف المحددة',
      [key('payload.headers[1]')]: 'المذكّر',
    },
    stringStatus: {
      [key('title')]: status,
      [key('payload.headers[1]')]: status,
    },
    // The noun key space is the entry id, not a path — `nouns[entry_id]` per contract section 4.3.
    nouns: { 'telc-deutsch-b1.noun.der-nachbar': { meaning: 'الجار', example: 'جارنا يساعدنا', rule: 'لا قاعدة' } },
  };
  return () => JSON.parse(JSON.stringify(bundle));
}

async function assertTranslatedPath(guides, nouns) {
  const translated = await mounted({ documents: guides, nouns, language: 'ar', route: '#/nachschlagen/cases-guide', translations: machineBundle(guides) });
  const html = translated.page();
  assert.ok(html.includes('أداة التعريف المحددة'), 'a section title in the stored key form is resolved');
  assert.ok(html.includes('المذكّر'), 'a payload header in the stored key form is resolved');
  // Two resolved strings on this page, each with the marker once, and nothing else marked.
  assert.equal(count(html, l('libraryMachineTranslated')), 2, 'each machine-translated block carries the marker, and only those');
  assert.equal(count(html, s('m091')), 0, 'a page WITH a bundle shows no German-only note');
  assert.ok(html.includes('Bestimmter Artikel'), 'the German source is still present');

  // The pre-fix key forms are kept as secondary fallbacks, so an older or hand-written bundle still
  // resolves — this is the assertion that pins that promise.
  const legacy = await mounted({ documents: guides, nouns, language: 'ar', route: '#/nachschlagen/cases-guide', translations: machineBundle(guides, { legacyKeys: true }) });
  assert.ok(legacy.page().includes('أداة التعريف المحددة'), 'the legacy `<section_id>.<field>` key form still resolves as a fallback');

  // An approved member must NOT carry the marker even though lines are rendered (per-line status).
  const approved = await mounted({ documents: guides, nouns, language: 'ar', route: '#/nachschlagen/cases-guide', translations: machineBundle(guides, { status: 'approved' }) });
  assert.ok(approved.page().includes('أداة التعريف المحددة'), 'an approved bundle still renders its lines');
  assert.equal(count(approved.page(), l('libraryMachineTranslated')), 0, 'an approved line carries no marker');
  assert.ok(translated.api.calls.some(call => call.endpoint === 'guides.read' && call.locale === 'ar'), 'the read path was asked for the locale');
  return true;
}

/* ------------------------------------------- the served member, over the REAL bundle (F2 key space) */

const F2_BUNDLE_PATH = 'content/library-translations/hatoove-library-translations-uk-ar-tr.json';

/** The client's OLD key form (dotted, prefix-free) — used only to prove the new leg can fail. */
const dottedKey = (guideId, path) => {
  const rest = path.slice(guideId.length + 1);
  const sectionId = rest.split('.')[0];
  return `${sectionId}.${rest.slice(sectionId.length + 1).replace(/\[(\d+)\]/g, '.$1')}`;
};

/**
 * The additive `translations` member exactly as the merged server builds it
 * (`server/library-translations.mjs` `readGuideTranslations`: `strings[row.path] = text`,
 * `stringStatus[row.path] = review_status`, `nouns[entry_id] = { meaning, example, rule }`, and
 * `status` = machine while any served row is machine). The KEYS come from the real bundle, so a client
 * that invented its own key form cannot pass by construction — which is the defect this leg exists for:
 * before the fix the client's dotted, prefix-free keys matched 0 of 50 requested paths, so a learner saw
 * no translated line at all and could not tell that from "no translations were imported".
 *
 * `keyForm: 'dotted'` is the mutation: the same member with the server-side key form replaced by the
 * client's old form. The leg must fail against it.
 */
function servedMember(bundle, guideId, locale, { keyForm = 'stored', status = 'machine_unreviewed' } = {}) {
  const strings = {};
  const stringStatus = {};
  for (const [path, members] of Object.entries(bundle.guides[guideId] || {})) {
    const key = keyForm === 'stored' ? path : dottedKey(guideId, path);
    strings[key] = members[locale];
    stringStatus[key] = status;
  }
  const nouns = {};
  for (const [entryId, members] of Object.entries(bundle.nouns)) {
    const translated = members[locale];
    nouns[entryId] = { meaning: translated.meaning, example: translated.example, rule: translated.rule };
  }
  return { locale, guideVersion: `${guideId}@v1`, status, strings, stringStatus, nouns };
}

/** Every real path the caller names must appear in the rendered page. Returns nothing; throws if not. */
function assertResolved(html, expected, label) {
  const missing = expected.filter(([, value]) => !html.includes(value)).map(([path]) => path);
  assert.deepEqual(missing, [], `${label}: the client must resolve every real bundle path it renders`);
}

async function assertRealBundleTranslation(guides, nouns) {
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, F2_BUNDLE_PATH), 'utf8'));
  const speaking = bundle.guides['speaking-guide'];
  const text = path => speaking[path].uk;

  /*
   * REVIEW-LIBRARY-I18N-REPIN: the re-pin dropped ALL of SP1 (33 paths) because `0043` replaced the
   * presentation task, so the named paths come from SP2, which keeps its full set. A check that still
   * demanded the SP1 keys would be freezing the content the correction removed. The dropped paths are
   * asserted ABSENT below, so a re-introduction is a decision rather than an accident.
   */
  const named = [
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp2.title',
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp2.summary',
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp2.payload.phrases[0].group',
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp2.payload.approach[0].step',
  ];
  for (const path of named) assert.ok(speaking[path], `the real bundle carries ${path}`);
  for (const dropped of [
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp1.title',
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp1.payload.phrases[0].group',
    'speaking-guide/telc-deutsch-b1.speaking-guide.sp1.payload.approach[0].step',
  ]) {
    assert.ok(!speaking[dropped], `the re-pin dropped ${dropped}, which 0043 removed or rewrote`);
  }
  // The stored keys are per-locale members; a dropped path must be absent in EVERY locale, not just uk.
  for (const dropped of Object.keys(speaking).filter(key => key.includes('.sp1'))) {
    assert.fail(`the bundle still carries ${dropped}`);
  }
  // The exported key builder must reproduce the stored key byte for byte, brackets included.
  assert.equal(
    storedTranslationPath('speaking-guide', 'telc-deutsch-b1.speaking-guide.sp2', 'phrases.0.group'),
    named[2], 'the client builds the stored key for a bracket-indexed payload field');
  assert.equal(
    storedTranslationPath('cases-guide', 'telc-deutsch-b1.cases-guide.bestimmter-artikel', 'headers.1'),
    'cases-guide/telc-deutsch-b1.cases-guide.bestimmter-artikel.payload.headers[1]',
    'a header cell keeps its bracket index');
  assert.equal(
    storedTranslationPath('speaking-guide', 'telc-deutsch-b1.speaking-guide.sp2', 'title'),
    named[0], 'a section column is not given a payload prefix');
  const member = (guideId, options) => (id, locale) => servedMember(bundle, id || guideId, locale || 'uk', options);

  const speakingHtml = (await mounted({
    documents: guides, nouns, language: 'uk', route: '#/nachschlagen/speaking-guide',
    translations: (guideId, locale) => servedMember(bundle, guideId, locale, {}),
  })).page();
  assertResolved(speakingHtml, named.map(path => [path, text(path)]), 'speaking-guide, stored key form');
  assert.equal(count(speakingHtml, s('m091')), 0, 'a page with a real bundle shows no German-only note');
  assert.ok(count(speakingHtml, l('libraryMachineTranslated')) >= named.length, 'every real machine-translated line carries the marker');

  // A mutation of the SERVED key form (not of the server, not of the client) must fail the same leg.
  const mutatedHtml = (await mounted({
    documents: guides, nouns, language: 'uk', route: '#/nachschlagen/speaking-guide',
    translations: (guideId, locale) => servedMember(bundle, guideId, locale, { keyForm: 'dotted' }),
  })).page();
  assert.throws(
    () => assertResolved(mutatedHtml, named.map(path => [path, text(path)]), 'speaking-guide, dotted key form'),
    /the client must resolve every real bundle path it renders/,
    'the leg must fail when the served key form is the pre-fix dotted form');

  // A second guide, one plain payload field, one array element and a translated table header cell.
  const grammar = bundle.guides['grammar-guide'];
  const grammarPaths = Object.keys(grammar).filter(path => /\.payload\.rule$/.test(path) || /\.payload\.traps\[0\]$/.test(path)).slice(0, 2);
  const tableHeaderPath = Object.keys(grammar).find(path => /\.payload\.table\.headers\[1\]$/.test(path));
  assert.equal(grammarPaths.length, 2, 'the real bundle carries a grammar rule and a grammar trap');
  assert.ok(tableHeaderPath, 'the real bundle carries a translated grammar table header');
  const grammarHtml = (await mounted({
    documents: guides, nouns, language: 'uk', route: '#/nachschlagen/grammar-guide',
    translations: (guideId, locale) => servedMember(bundle, guideId, locale, {}),
  })).page();
  assertResolved(grammarHtml, [...grammarPaths, tableHeaderPath].map(path => [path, grammar[path].uk]), 'grammar-guide, stored key form');
  // German first: the German header cell is still on the page beside the translated table.
  assert.ok(grammarHtml.includes('Akkusativ'), 'the German table header survives beside the translated header table');
  assert.ok(count(grammarHtml, 'library-translation') >= 1, 'the translated header table is a learner line, not a substitution');

  // The eight case tables carry translated header cells, which the library renders as a dimmed table.
  const cases = bundle.guides['cases-guide'];
  const headerPath = Object.keys(cases).find(path => /\.payload\.headers\[1\]$/.test(path));
  assert.ok(headerPath, 'the real bundle carries a translated case-table header');
  const casesHtml = (await mounted({
    documents: guides, nouns, language: 'uk', route: '#/nachschlagen/cases-guide',
    translations: (guideId, locale) => servedMember(bundle, guideId, locale, {}),
  })).page();
  assertResolved(casesHtml, [[headerPath, cases[headerPath].uk]], 'cases-guide translated header');

  // The noun lexicon is a different key space: `nouns[entry_id]`, not a path.
  const nounId = 'telc-deutsch-b1.noun.die-moebel';
  const nounBundle = bundle.nouns[nounId];
  assert.ok(nounBundle && nounBundle.uk && nounBundle.uk.meaning, 'the real bundle carries the noun');
  const genderHtml = (await mounted({
    documents: guides, nouns, limit: 500, language: 'uk', route: '#/nachschlagen/gender-rules',
    translations: (guideId, locale) => servedMember(bundle, guideId, locale, {}),
  })).page();
  assertResolved(genderHtml, [[`nouns[${nounId}].meaning`, nounBundle.uk.meaning]], 'noun lexicon, entry_id key space');
  assert.ok(genderHtml.includes(nounBundle.uk.example), 'the noun example translation is rendered too');
  return true;
}

/* ------------------------------------------- the recorded pending list (LIBRARY-I18N-MARKER, task-30) */

const PENDING_RECORD_PATH = 'content/library-translations/README.md';
const PENDING_START = '<!-- library-translation-pending:start -->';
const PENDING_END = '<!-- library-translation-pending:end -->';

/** The README's machine-readable record, between its two markers. */
function readPendingRecord() {
  const markdown = fs.readFileSync(path.join(ROOT, PENDING_RECORD_PATH), 'utf8');
  const afterStart = markdown.split(PENDING_START)[1];
  assert.ok(afterStart, `the record carries the start marker ${PENDING_START}`);
  const fenced = /```json\s*([\s\S]*?)```/.exec(afterStart.split(PENDING_END)[0]);
  assert.ok(fenced, 'the record block carries a json fence');
  return JSON.parse(fenced[1]);
}

/** Both directions, and the message names which side holds what the other lacks. */
function assertSameList(recorded, mirrored, label) {
  const onlyRecord = recorded.filter(value => !mirrored.includes(value));
  const onlyMirror = mirrored.filter(value => !recorded.includes(value));
  assert.equal(onlyRecord.length + onlyMirror.length, 0,
    `${label}: the README record and the client mirror disagree — record-only ${JSON.stringify(onlyRecord)}, client-only ${JSON.stringify(onlyMirror)}`);
}

/** `payload.approach[0].step` against a document object. */
function atPath(root, relative) {
  return relative.split('.').reduce((node, token) => {
    const match = /^([A-Za-z_]+)((?:\[\d+\])*)$/.exec(token);
    if (!match || node === undefined || node === null) return undefined;
    let current = node[match[1]];
    for (const index of match[2].match(/\d+/g) || []) current = current === undefined || current === null ? undefined : current[Number(index)];
    return current;
  }, root);
}

async function assertPendingRecord(guides) {
  const record = readPendingRecord();
  // 1. The record's own arithmetic, as the README states it: 18 rendered + 15 removed = 33 paths.
  assert.equal(record.pending.length, 1, 'the record lists exactly one pending section today');
  const entry = record.pending[0];
  assert.equal(entry.guide_id, 'speaking-guide', 'the pending section is in the speaking guide');
  assert.equal(entry.section_id, 'telc-deutsch-b1.speaking-guide.sp1', 'the pending section is SP1');
  assert.equal(entry.rendered.length, 18, 'the record lists 18 rendered-but-untranslated paths');
  assert.equal(entry.removed.length, 15, 'the record lists 15 paths the correction deleted');
  assert.equal(entry.rendered.length + entry.removed.length, 33, 'the re-pin dropped 33 SP1 paths');
  assert.deepEqual(record.locales, ['uk', 'ar', 'tr'], 'the pending languages are the bundle languages');
  assert.equal((entry.rendered.length + entry.removed.length) * record.locales.length, 99,
    '33 paths × 3 locales = the 99-string native-review batch');
  // 2. The client mirror equals the record, entry by entry, naming the side that drifted.
  assert.deepEqual([...PENDING_TRANSLATIONS.locales], record.locales, 'record vs client mirror: the locale list differs');
  assert.equal(PENDING_TRANSLATIONS.pending.length, record.pending.length, 'record vs client mirror: the entry count differs');
  for (const [index, recorded] of record.pending.entries()) {
    const mirrored = PENDING_TRANSLATIONS.pending[index];
    assert.ok(mirrored, `record vs client mirror: the mirror has no entry ${index}`);
    assert.equal(mirrored.guide_id, recorded.guide_id, `record vs client mirror: guide_id differs at entry ${index}`);
    assert.equal(mirrored.section_id, recorded.section_id, `record vs client mirror: section_id differs at entry ${index}`);
    assertSameList(recorded.rendered, [...mirrored.rendered], `record vs client mirror, rendered paths of ${recorded.section_id}`);
    assertSameList(recorded.removed, [...mirrored.removed], `record vs client mirror, removed paths of ${recorded.section_id}`);
  }
  // 3. The two lists mean what they say against the served document: `rendered` German is there,
  //    `removed` German is gone.
  const guide = guides.find(candidate => candidate.guide_id === entry.guide_id);
  assert.ok(guide, 'the fixture serves the recorded guide');
  const section = guide.sections.find(candidate => candidate.section_id === entry.section_id);
  assert.ok(section, 'the fixture serves the recorded section');
  for (const relative of entry.rendered) {
    const value = atPath(section, relative);
    assert.ok(typeof value === 'string' && value.trim(),
      `the record says ${relative} still renders German, but the served section carries no value there`);
  }
  for (const relative of entry.removed) {
    assert.equal(atPath(section, relative), undefined,
      `the record says ${relative} was deleted by the correction, but the served section still carries a value`);
  }
  // 4. The record is not stale: a recorded path may not be served a translation — a re-translation has
  //    to come back THROUGH the record, by removing the entry.
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, F2_BUNDLE_PATH), 'utf8'));
  for (const relative of entry.rendered) {
    const stored = storedTranslationPath(entry.guide_id, entry.section_id, relative);
    assert.ok(stored, `a stored key exists for ${relative}`);
    assert.ok(!Object.hasOwn(bundle.guides[entry.guide_id] || {}, stored),
      `the record lists ${stored} as pending, but the bundle serves a translation again — remove the record entry`);
  }
  return record;
}

async function assertPendingMarkers(guides, nouns, record) {
  const entry = record.pending[0];
  const fixture = guides.find(candidate => candidate.guide_id === entry.guide_id);
  const section = fixture.sections.find(candidate => candidate.section_id === entry.section_id);
  const emptyMember = () => ({ locale: 'uk', status: 'machine_unreviewed', strings: {}, stringStatus: {} });
  for (const language of ['uk', 'ar', 'tr']) {
    const { page } = await mounted({
      documents: guides, nouns, language, route: `#/nachschlagen/${entry.guide_id}`,
      translations: () => emptyMember(),
    });
    const html = page();
    // A record entry owes exactly one marker, and it names the recorded section…
    assert.equal(count(html, 'data-library-pending="'), 1, `${language}: exactly one pending marker for the recorded section`);
    assert.ok(html.includes(`data-library-pending="${entry.section_id}"`), `${language}: the marker names the recorded section`);
    // …whose own sentence is the section-scoped one, not the whole-book note.
    assert.ok(html.includes(l('libraryPendingSection')), `${language}: the marker uses the section-scoped sentence`);
    assert.equal(count(html, s('m091')), 0, `${language}: a section marker must not claim the whole reference work is untranslated`);
    // …and it sits inside the recorded section's card, not at the top of the page.
    const markerAt = html.indexOf(`data-library-pending="${entry.section_id}"`);
    const article = html.slice(html.lastIndexOf('<article', markerAt), html.indexOf('</article>', markerAt));
    assert.ok(article.includes(esc(section.title)), `${language}: the marker sits in the recorded section's card`);
    // A marker with no record entry is as wrong as the reverse: every marker must be recorded.
    for (const [, id] of html.matchAll(/data-library-pending="([^"]*)"/g)) {
      assert.ok(record.pending.some(candidate => candidate.section_id === id), `${language}: the page marks ${id}, which the record does not list`);
    }
    // The member above carries NOTHING, so other sections are untranslated too — and stay unmarked,
    // because the record does not list them.
    assert.ok(count(html, 'data-library-section="') > 1, `${language}: the page really renders more than one section`);
  }
  for (const language of ['de', 'en']) {
    const { page } = await mounted({
      documents: guides, nouns, language, route: `#/nachschlagen/${entry.guide_id}`,
      translations: () => emptyMember(),
    });
    assert.equal(count(page(), 'data-library-pending="'), 0, `${language}: German and English learners see no pending marker`);
  }
  // A genuinely untranslated member keeps its own page-level note; the two states coexist and differ.
  const { page: noMember } = await mounted({ documents: guides, nouns, language: 'uk', route: `#/nachschlagen/${entry.guide_id}`, translations: () => null });
  assert.equal(count(noMember(), s('m091')), 1, 'a page with no translation member keeps its one whole-book note');
  assert.equal(count(noMember(), 'data-library-pending="'), 1, 'and the recorded section still carries its own marker');
  return true;
}

async function assertLexicon(guides, nouns) {
  // The route serves at most NOUN_PAGE_SIZE rows and publishes no total, so the page must not imply it
  // has shown the whole lexicon.
  const capped = await mounted({ documents: guides, nouns, limit: NOUN_PAGE_SIZE, route: '#/nachschlagen/gender' });
  const cappedPage = capped.page();
  assert.ok(cappedPage.includes(l('libraryLexicon')), 'the lexicon section is part of the Nomen & Genus page');
  assert.ok(cappedPage.includes(l('libraryShown', { count: NOUN_PAGE_SIZE })), 'the count comes from the served payload');
  assert.ok(cappedPage.includes(l('libraryPartial')), 'a list at the route page size says it may be truncated');
  assert.ok(cappedPage.includes('der Lehrling'), 'the first served noun is rendered');
  assert.equal(capped.api.calls.filter(call => call.endpoint === 'nouns.list').length, 1, 'opening the page asks once');

  // Filter by gender: a server-side query through the api's own closed filter. The witnesses are nouns
  // that exist ONLY in the lexicon, so a guide section cannot satisfy the assertion by accident.
  capped.host.onclick({ target: { closest: selector => (selector === '[data-library-gender]' ? { dataset: { libraryGender: 'die' } } : null) } });
  await settle();
  assert.ok(capped.api.calls.some(call => call.endpoint === 'nouns.list' && call.gender === 'die'), 'the gender filter queries the server');
  assert.ok(capped.page().includes('die Person'), 'the filtered page shows die nouns');
  assert.ok(!capped.page().includes('der Lehrling'), 'the filtered page drops the other genders');

  // Search: two characters or more reaches the server and composes with the gender filter.
  capped.host.oninput({ target: { dataset: { librarySearch: '' }, value: 'Lehrling' } });
  await settle();
  assert.ok(capped.api.calls.some(call => call.endpoint === 'nouns.list' && call.q === 'Lehrling' && call.gender === 'die'), 'the search keeps the active gender filter');
  assert.ok(!capped.page().includes('der Lehrling'), 'a der noun is not returned inside the die filter');
  capped.host.onclick({ target: { closest: selector => (selector === '[data-library-gender]' ? { dataset: { libraryGender: '' } } : null) } });
  await settle();
  assert.ok(capped.api.calls.some(call => call.endpoint === 'nouns.list' && call.gender === null && call.q === 'Lehrling'), 'clearing the filter keeps the search term');
  assert.ok(capped.page().includes('der Lehrling'), 'the search result is rendered');
  const beforeShort = capped.api.calls.length;
  capped.host.oninput({ target: { dataset: { librarySearch: '' }, value: 'W' } });
  await settle();
  assert.equal(capped.api.calls.length, beforeShort, 'a one-character search does not query the server');
  assert.ok(capped.page().includes(s('m068')), 'a one-character search explains the minimum');

  // A server that can serve the whole lexicon: the page shows the total and stops claiming truncation.
  const full = await mounted({ documents: guides, nouns, limit: 500, language: 'en', route: '#/nachschlagen/gender' });
  const fullPage = full.page();
  assert.ok(fullPage.includes(l('libraryCountNouns', { count: nouns.length })), `all ${nouns.length} nouns are counted from the payload`);
  assert.ok(!fullPage.includes(l('libraryPartial')), 'a complete list does not claim truncation');
  assert.ok(fullPage.includes('neighbour'), "each noun shows its meaning in the learner's language (authored English)");
  assert.ok(count(fullPage, 'data-library-speak') > 100, 'every example line is marked for the read-aloud control');

  // A bundle translates the meanings, and an unreviewed one is marked.
  const bundled = await mounted({ documents: guides, nouns, limit: 500, language: 'ar', route: '#/nachschlagen/gender', translations: machineBundle(guides) });
  const bundledPage = bundled.page();
  assert.ok(bundledPage.includes('الجار'), 'a noun meaning comes from the bundle');
  assert.ok(count(bundledPage, l('libraryMachineTranslated')) > 0, 'an unreviewed noun translation is marked');
  return true;
}

/* ------------------------------------------------------------------------------- mutation proof */

const COPY_FILES = [
  'public/app/library.js', 'public/app/guide-content.js', 'public/app/read-aloud.js', 'public/app/locale-preference.js',
  'public/assets/i18n/core.js', 'public/assets/i18n/practice-messages.js', 'public/assets/i18n/shell-messages.js',
  // The mirror-drift mutation needs the record itself in the copy: the two are checked against each other.
  'content/library-translations/README.md',
];

/** Copy the shipped modules into a temporary tree with one deliberate defect, and no more. */
function writeTempTree(mutation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'library-check-'));
  const source = fs.readFileSync(path.join(ROOT, 'public/app/library.js'), 'utf8');
  const mutated = mutation(source);
  assert.notEqual(mutated, source, 'the mutation must change the module');
  for (const file of COPY_FILES) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file === 'public/app/library.js' ? mutated : fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  writeSupport(directory);
  return directory;
}

/** The support module the runners share, generated next to the mutated copy. */
function writeSupport(directory) {
  const support = [
    "import { s } from './public/app/locale-preference.js';",
    "import { guideContent } from './public/app/guide-content.js';",
    "export function fakeHost() {",
    "  const parts = new Map();",
    "  return {",
    "    innerHTML: '', onclick: null, oninput: null,",
    "    querySelector(selector) { if (!parts.has(selector)) parts.set(selector, { innerHTML: '', value: '', focus() {}, setSelectionRange() {} }); return parts.get(selector); },",
    "    querySelectorAll() { return []; }, contains() { return false; }, addEventListener() {}, removeEventListener() {},",
    "  };",
    "}",
    "export const settle = async () => { for (let round = 0; round < 12; round++) await new Promise(resolve => setImmediate(resolve)); };",
    "export function contextFor(api, language) {",
    "  return {",
    "    api, language, esc: value => String(value ?? '').replace(/[&<>\\\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\\\"': '&quot;' }[character])),",
    "    uiText: (key, parameters) => s(key, parameters),",
    "    state: { settings: { language } },",
    "    guideContent, schedule: run => { run(); return 0; },",
    "  };",
    "}",
  ].join('\n');
  fs.writeFileSync(path.join(directory, 'support.mjs'), support);
}

const RUNNER_HIGHLIGHT = `
import assert from 'node:assert/strict';
import { caseHighlights } from './public/app/library.js';
const table = { headers: ['', 'maskulin', 'neutrum'], rows: [['Nominativ', 'der', 'das'], ['Akkusativ', 'den', 'das'], ['Dativ', 'dem', 'dem']] };
assert.deepEqual([...caseHighlights(table).marked].sort(), ['1:1', '2:1', '2:2'], 'the highlight must mark the cells that DIFFER from the Nominativ row');
`;

const RUNNER_NOTE = `
import assert from 'node:assert/strict';
import { createLibraryView } from './public/app/library.js';
import { setLocale } from './public/assets/i18n/core.js';
import { s } from './public/app/locale-preference.js';
import { fakeHost, contextFor, settle } from './support.mjs';
setLocale('ar');
const document_ = { guide_id: 'cases-guide', family: 'cases', title: 'Fälle', intro: '', watch_out: [], sections: [
  { section_id: 't', ordinal: 0, kind: 'table', title: 'Bestimmter Artikel', summary: '', payload: { headers: ['', 'A'], rows: [['Nominativ', 'x'], ['Genitiv', 'y']] } },
] };
const api = {
  guides: {
    list: async () => ({ ok: true, status: 200, data: [document_] }),
    read: async () => ({ ok: true, status: 200, data: { ...document_, translations: { locale: 'ar', status: 'machine_unreviewed', strings: { t: 'جدول' } } } }),
  },
  nouns: { list: async () => ({ ok: true, status: 200, data: [] }) },
};
const host = fakeHost();
createLibraryView(contextFor(api, 'ar')).mount(host, { route: '#/nachschlagen/cases-guide' });
await settle();
const note = s('m091');
assert.equal(host.innerHTML.split(note).length - 1, 0, 'a page WITH a translation bundle must not show the German-only note');
`;

/** The two marker directions and the mirror drift, each as a runner the mutation must break. */
const RUNNER_PENDING_OWED = `
import assert from 'node:assert/strict';
import { createLibraryView, PENDING_TRANSLATIONS } from './public/app/library.js';
import { setLocale } from './public/assets/i18n/core.js';
import { fakeHost, contextFor, settle } from './support.mjs';
setLocale('uk');
const entry = PENDING_TRANSLATIONS.pending[0];
const document_ = { guide_id: entry.guide_id, family: 'speaking', title: 'Sprechen', intro: '', watch_out: [], sections: [
  { section_id: entry.section_id, ordinal: 0, kind: 'approach', title: 'Teil 1', summary: '', payload: { approach: [{ step: 'a', detail: 'b' }] } },
  { section_id: entry.section_id + '-2', ordinal: 1, kind: 'approach', title: 'Teil 2', summary: '', payload: { approach: [{ step: 'c', detail: 'd' }] } },
] };
const api = {
  guides: { list: async () => ({ ok: true, status: 200, data: [document_] }),
    read: async () => ({ ok: true, status: 200, data: { ...document_, translations: { locale: 'uk', status: 'machine_unreviewed', strings: {}, stringStatus: {} } } }) },
  nouns: { list: async () => ({ ok: true, status: 200, data: [] }) },
};
const host = fakeHost();
createLibraryView(contextFor(api, 'uk')).mount(host, { route: '#/nachschlagen/speaking-guide' });
await settle();
assert.equal(host.innerHTML.split('data-library-pending').length - 1, 1, 'a record entry owes exactly one rendered marker');
`;

const RUNNER_PENDING_RECORDED = `
import assert from 'node:assert/strict';
import { createLibraryView, PENDING_TRANSLATIONS } from './public/app/library.js';
import { setLocale } from './public/assets/i18n/core.js';
import { fakeHost, contextFor, settle } from './support.mjs';
setLocale('uk');
const entry = PENDING_TRANSLATIONS.pending[0];
const document_ = { guide_id: entry.guide_id, family: 'speaking', title: 'Sprechen', intro: '', watch_out: [], sections: [
  { section_id: entry.section_id, ordinal: 0, kind: 'approach', title: 'Teil 1', summary: '', payload: { approach: [{ step: 'a', detail: 'b' }] } },
  { section_id: entry.section_id + '-2', ordinal: 1, kind: 'approach', title: 'Teil 2', summary: '', payload: { approach: [{ step: 'c', detail: 'd' }] } },
] };
const api = {
  guides: { list: async () => ({ ok: true, status: 200, data: [document_] }),
    read: async () => ({ ok: true, status: 200, data: { ...document_, translations: { locale: 'uk', status: 'machine_unreviewed', strings: {}, stringStatus: {} } } }) },
  nouns: { list: async () => ({ ok: true, status: 200, data: [] }) },
};
const host = fakeHost();
createLibraryView(contextFor(api, 'uk')).mount(host, { route: '#/nachschlagen/speaking-guide' });
await settle();
for (const [, id] of host.innerHTML.matchAll(/data-library-pending="([^"]*)"/g)) {
  assert.ok(PENDING_TRANSLATIONS.pending.some(candidate => candidate.section_id === id), 'the page marks ' + id + ', which the record does not list');
}
`;

const RUNNER_PENDING_MIRROR = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PENDING_TRANSLATIONS } from './public/app/library.js';
const markdown = fs.readFileSync('./content/library-translations/README.md', 'utf8');
const fenced = /\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\\`\\\`\\\`/.exec(markdown.split('<!-- library-translation-pending:start -->')[1].split('<!-- library-translation-pending:end -->')[0]);
const record = JSON.parse(fenced[1]);
const recorded = record.pending[0], mirrored = PENDING_TRANSLATIONS.pending[0];
const onlyRecord = recorded.rendered.filter(value => !mirrored.rendered.includes(value));
const onlyMirror = mirrored.rendered.filter(value => !recorded.rendered.includes(value));
assert.equal(onlyRecord.length + onlyMirror.length, 0, 'record and client mirror disagree: record-only ' + JSON.stringify(onlyRecord) + ', client-only ' + JSON.stringify(onlyMirror));
`;

function runIn(directory, script) {  const file = path.join(directory, 'runner.mjs');
  fs.writeFileSync(file, script);
  return spawnSync(process.execPath, [file], { encoding: 'utf8', cwd: directory, timeout: 30000 });
}

function assertMutationProof() {
  const highlight = writeTempTree(source => source.replace(
    'if (text(rows[row][column]) !== text(rows[nominativeRow][column])) marked.add',
    'if (text(rows[row][column]) === text(rows[nominativeRow][column])) marked.add'));
  const highlightResult = runIn(highlight, RUNNER_HIGHLIGHT);
  assert.notEqual(highlightResult.status, 0, 'breaking the highlight comparison must fail the highlight runner');
  // …and it must fail on the ASSERTION, not because the copy could not even load.
  assert.match(String(highlightResult.stderr), /the highlight must mark the cells that DIFFER/, 'the highlight runner must fail on its own assertion');
  fs.rmSync(highlight, { recursive: true, force: true });

  const note = writeTempTree(source => source.replace(
    "if (language === 'de' || language === 'en' || bundle) return '';",
    "if (language === 'de' || language === 'en') return '';"));
  const noteResult = runIn(note, RUNNER_NOTE);
  assert.notEqual(noteResult.status, 0, 'breaking the single-note rule must fail the note runner');
  assert.match(String(noteResult.stderr), /must not show the German-only note/, 'the note runner must fail on its own assertion');
  fs.rmSync(note, { recursive: true, force: true });

  // Direction 1: the record lists the section, the page owes the marker — silence must fail.
  const owed = writeTempTree(source => source.replace(
    'const owed = entry.rendered.filter',
    "return '';\n    const owed = entry.rendered.filter"));
  const owedResult = runIn(owed, RUNNER_PENDING_OWED);
  assert.notEqual(owedResult.status, 0, 'a record entry with no rendered marker must fail the pending runner');
  assert.match(String(owedResult.stderr), /a record entry owes exactly one rendered marker/,
    'the pending runner must fail on its own assertion, not on a broken copy');
  fs.rmSync(owed, { recursive: true, force: true });

  // Direction 2: a marker the record does not list must fail, even though the marker itself renders.
  const unrecorded = writeTempTree(source => source.replace(
    'const entry = pendingForSection(guideId, section);',
    "const entry = pendingForSection(guideId, section) ? pendingForSection(guideId, section) : { section_id: text(section?.section_id), rendered: ['title'] };"));
  const unrecordedResult = runIn(unrecorded, RUNNER_PENDING_RECORDED);
  assert.notEqual(unrecordedResult.status, 0, 'a rendered marker with no record entry must fail the pending runner');
  assert.match(String(unrecordedResult.stderr), /which the record does not list/,
    'the pending runner must fail on its own assertion, not on a broken copy');
  fs.rmSync(unrecorded, { recursive: true, force: true });

  // Direction 3: the README record and the client mirror must stay identical, and the failure must say
  // which side holds the path the other lacks.
  const drifted = writeTempTree(source => source.replace(/^ {8}'payload\.watchOut\[2\]',\r?\n/m, ''));
  const driftedResult = runIn(drifted, RUNNER_PENDING_MIRROR);
  assert.notEqual(driftedResult.status, 0, 'a mirror that dropped a recorded path must fail the mirror runner');
  assert.match(String(driftedResult.stderr), /record-only \["payload\.watchOut\[2\]"\]/,
    'the mirror runner must name the side that holds the unmirrored path');
  fs.rmSync(drifted, { recursive: true, force: true });
  console.log('     mutations reproduced: highlight comparison, single-note rule, a record entry with no marker,');
  console.log('     a marker with no record entry, and a client mirror that drifted from the README record');
  return true;
}

/* ------------------------------------------------------------------------- harness and static server */

/**
 * The harness renders dark mode by applying the PINNED dark block under `:root[data-theme=dark]`
 * instead of through `prefers-color-scheme`, because a headless session cannot emulate the media
 * feature here. The declarations are lifted verbatim from `hatoove.css`; only the selector changes.
 */
function darkThemeCss() {
  const pinned = fs.readFileSync(path.join(ROOT, 'public/assets/design/hatoove.css'), 'utf8');
  const block = /@media\s*\(prefers-color-scheme\s*:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(pinned);
  if (!block) throw new Error('the pinned stylesheet no longer carries a prefers-color-scheme: dark block');
  return block[1].replace(':root:not([data-theme=light])', ':root[data-theme=dark]')
    + '\n:root[data-theme=dark] { color-scheme: dark; }';
}

function harnessHtml(guides, nouns, prefix) {
  // The real bundle, served per guide and locale exactly as `readGuideTranslations` would, so the
  // harness renders actual uk/ar/tr lines with their markers instead of a placeholder string.
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, F2_BUNDLE_PATH), 'utf8'));
  const served = { de: null, en: null };
  for (const locale of ['uk', 'ar', 'tr']) {
    served[locale] = Object.fromEntries(guides.map(entry => [entry.guide_id, servedMember(bundle, entry.guide_id, locale)]));
  }
  const fixtures = JSON.stringify({ guides, nouns, served }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nachschlagen harness — LIBRARY-UI-01</title>
<link rel="stylesheet" href="${prefix}public/assets/design/hatoove.css">
<link rel="stylesheet" href="${prefix}public/app/app.css">
<link rel="stylesheet" href="${prefix}public/app/library.css">
<style>body { margin: 0; padding: 16px; background: var(--canvas); color: var(--ink); } .harness-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }</style>
<style id="harness-dark">${darkThemeCss()}</style>
</head>
<body>
<!-- Standalone reviewer harness. Serve the WORKTREE ROOT over HTTP (module imports and file:// do not mix):
     node tools/library-render-check.mjs --serve 4321
     then open http://127.0.0.1:4321/handoff/ron-agent/library-ui-01/library-harness.html
     Regenerate with: node tools/library-render-check.mjs --harness <path> -->
<div class="harness-bar">
  <label for="route">Route</label>
  <select id="route">
    <option value="#/nachschlagen">#/nachschlagen</option>
    <option value="#/nachschlagen/cases-guide">#/nachschlagen/cases-guide</option>
    <option value="#/nachschlagen/grammar-guide">#/nachschlagen/grammar-guide</option>
    <option value="#/nachschlagen/writing-guide">#/nachschlagen/writing-guide</option>
    <option value="#/nachschlagen/speaking-guide">#/nachschlagen/speaking-guide</option>
    <option value="#/nachschlagen/gender-rules">#/nachschlagen/gender-rules</option>
    <option value="#/nachschlagen/core-grammar">#/nachschlagen/core-grammar</option>
    <option value="#/nachschlagen/core-phrases">#/nachschlagen/core-phrases</option>
    <option value="#/nachschlagen/satzbau">#/nachschlagen/satzbau</option>
  </select>
  <label for="locale">Sprache</label>
  <select id="locale"><option>de</option><option>en</option><option>uk</option><option>ar</option><option>tr</option></select>
  <label for="nouns">Nomen-Seite</label>
  <select id="nouns"><option value="500">vollständig (240)</option><option value="${NOUN_PAGE_SIZE}">Servergrenze (${NOUN_PAGE_SIZE})</option></select>
  <button type="button" id="apply">Laden</button>
</div>
<main id="host"></main>
<p id="harness-error" class="err" hidden></p>
<script>
// The harness is a diagnostic: a failure has to be visible in the page, not only in a console.
function harnessFail(message) {
  const box = document.getElementById('harness-error');
  if (!box) return;
  box.hidden = false;
  box.textContent = 'HARNESS FAILURE: ' + message;
}
window.addEventListener('error', event => harnessFail((event.message || 'script error') + ' @ ' + (event.filename || '') + ':' + (event.lineno || 0)));
window.addEventListener('unhandledrejection', event => harnessFail('unhandled rejection: ' + (event.reason && event.reason.message ? event.reason.message : String(event.reason))));
</script>
<script type="application/json" id="fixtures">${fixtures}</script>
<script type="module">
window.__harnessStage = 'module-start';
import { createLibraryView } from '${prefix}public/app/library.js';
import { guideContent } from '${prefix}public/app/guide-content.js';
import { setLocale } from '${prefix}public/assets/i18n/core.js';
import { s } from '${prefix}public/app/locale-preference.js';
window.__harnessStage = 'imports-done';
const fixtures = JSON.parse(document.getElementById('fixtures').textContent);
window.__harnessStage = 'fixtures-parsed';
const esc = value => String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
function api(limit, wantsTranslations) {
  return {
    guides: {
      list: async () => ({ ok: true, status: 200, data: fixtures.guides.map(entry => ({ guide_id: entry.guide_id, family: entry.family, title: entry.title, intro: entry.intro, section_count: entry.sections.length })) }),
      read: async (guideId, locale) => {
        const entry = fixtures.guides.find(candidate => candidate.guide_id === guideId);
        if (!entry) return { ok: false, status: 404, error: 'not_found' };
        // Exactly the server's rule: de/en and an unimported locale answer null; uk/ar/tr carry the
        // member built from the real bundle (strings[storedPath], stringStatus[storedPath], nouns[entry_id]).
        const member = wantsTranslations && fixtures.served[locale] ? fixtures.served[locale][guideId] : null;
        return { ok: true, status: 200, data: { ...entry, translations: member || null } };
      },
    },
    nouns: {
      list: async (query = {}) => {
        let rows = fixtures.nouns;
        if (query.gender) rows = rows.filter(row => row.gender === query.gender);
        if (query.q) { const needle = String(query.q).toLowerCase(); rows = rows.filter(row => row.de.toLowerCase().includes(needle) || String(row.en || '').toLowerCase().includes(needle)); }
        return { ok: true, status: 200, data: rows.slice(0, limit) };
      },
    },
  };
}
let view = null;
const host = document.getElementById('host');
// ?route=cases-guide (or a full #/hash), ?locale=ar, ?nouns=50 preselect the controls, so a reviewer can
// link to one exact state and a screenshot run needs no clicking.
(function preselect() {
  const params = new URLSearchParams(location.search);
  const route = params.get('route');
  if (route) {
    const select = document.getElementById('route');
    const value = route.startsWith('#') ? route : '#/nachschlagen/' + route;
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value; option.textContent = value; select.append(option);
    }
    select.value = value;
  }
  const locale = params.get('locale');
  if (locale) document.getElementById('locale').value = locale;
  const nouns = params.get('nouns');
  if (nouns) document.getElementById('nouns').value = nouns;
  const theme = params.get('theme');
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
})();
function load() {
  try {
    const locale = document.getElementById('locale').value;
    const route = document.getElementById('route').value;
    const limit = Number(document.getElementById('nouns').value);
    // ?translations=0 exercises the German-only path: no bundle, so the page must show exactly one note.
    const wantsTranslations = new URLSearchParams(location.search).get('translations') !== '0';
    setLocale(locale);
    if (view) view.unmount();
    view = createLibraryView({ api: api(limit, wantsTranslations), esc, language: locale, uiText: (key, parameters) => s(key, parameters), navigate: hash => { location.hash = hash; },
      state: { settings: { language: locale } }, guideContent, schedule: run => { run(); return 0; } });
    view.mount(host, { route });
    window.__harnessStage = 'mounted:' + host.innerHTML.length;
  } catch (error) { window.__harnessStage = 'failed:' + ((error && error.message) || String(error)); harnessFail((error && error.message) || String(error)); }
}
document.getElementById('apply').addEventListener('click', load);
document.getElementById('route').addEventListener('change', load);
document.getElementById('locale').addEventListener('change', load);
document.getElementById('nouns').addEventListener('change', load);
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
    server.listen(port, '127.0.0.1', () => console.log(`harness server: http://127.0.0.1:${port}/handoff/ron-agent/library-ui-01/library-harness.html`));
  });
}

/* --------------------------------------------------------------------------------------------- main */

const args = process.argv.slice(2);
const option = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };

const guides = buildGuides();
const nouns = buildNouns();

for (const [guideId, expected] of Object.entries(EXPECTED_SECTIONS)) {
  const found = guides.find(entry => entry.guide_id === guideId);
  assert.equal(found.sections.length, expected, `fixture drift: ${guideId} should map to ${expected} sections`);
}
assert.equal(nouns.length, 240, 'the lexicon fixture carries the whole 240-noun source');

await assertHub(guides, nouns);
await assertGuides(guides, nouns);
await assertCaseTables(guides, nouns);
await assertRtl(guides, nouns);
await assertTranslatedPath(guides, nouns);
await assertRealBundleTranslation(guides, nouns);
const pendingRecord = await assertPendingRecord(guides);
await assertPendingMarkers(guides, nouns, pendingRecord);
await assertLexicon(guides, nouns);
assertMutationProof();

const harness = option('--harness');
if (harness) {
  const target = path.resolve(ROOT, harness);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The harness is written wherever the reviewer asks, so its links to public/ are computed, not assumed.
  const prefix = path.relative(path.dirname(target), ROOT).split(path.sep).join('/') + '/';
  fs.writeFileSync(target, harnessHtml(guides, nouns, prefix));
  console.log(`harness written: ${target} (links prefix "${prefix}")`);
}
const port = option('--serve');
if (port) await serve(Number(port));

console.log('PASS library render: 6 hub areas and their payload counts, 5 library guide pages with a jump chip per section,');
console.log('     8 case tables marked exactly off the Nominativ reference, Arabic RTL with LTR German islands,');
console.log('     one German-only note per page, the machine-translated marker, the lexicon filter/search path,');
console.log('     and the README\'s recorded pending list driving one section marker in every pending language.');
console.log(`     ${guideCount()} guide sections and ${nouns.length} nouns through the module; the ${WORTSCHATZ_GUIDE_IDS.length} Wortschatz corpora hand over; ${getLocale()} locale left set by the last case.`);

function guideCount() {
  return guides.reduce((total, entry) => total + entry.sections.length, 0);
}
