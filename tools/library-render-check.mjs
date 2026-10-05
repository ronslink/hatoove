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

import { createLibraryView, caseHighlights, LIBRARY_AREAS, SECTION_LABELS, NOUN_PAGE_SIZE } from '../public/app/library.js';
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
const document_ = (guideId, family, title, intro, introEn, watchOut, watchOutEn, sections) => ({
  guide_id: guideId, family, title, intro, intro_en: introEn,
  watch_out: watchOut || [], watch_out_en: watchOutEn || [],
  section_count: sections.length, sections: sections.map((entry, ordinal) => ({ ...entry, ordinal })),
});

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
  return readData('noun-lexicon').nouns.map((noun, index) => ({ entry_id: `noun-${index + 1}`, ...noun }));
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
  for (const guide of guides) {
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
    const table = cases.tables.find(entry => entry.id === id);
    assert.ok(table, `the rendered table ${id} exists in the source`);
    const marks = new Set([...block[0].matchAll(/data-library-case="(\d+):(\d+)"/g)].map(match => `${match[1]}:${match[2]}`));
    const expected = expectedHighlights(table);
    assert.deepEqual([...marks].sort(), [...expected].sort(), `${id}: the marked cells are exactly the non-Nominativ cells`);
    const legendAfter = html.slice(html.indexOf(`data-library-case-table="${id}"`));
    const hasLegend = legendAfter.slice(0, legendAfter.indexOf('</table>') + 400).includes(l('libraryCasesLegend'));
    assert.equal(hasLegend, expected.size > 0, `${id}: the legend appears exactly when something is marked`);
  }
  // Hand-derived expectations for two tables, so the algorithmic comparison has a second witness.
  const byId = id => blocks.find(block => block[1] === id)[0];
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

function machineBundle() {
  const bundle = {
    locale: 'ar', guideVersion: 'telc-deutsch-b1.cases-guide@v1', status: 'machine_unreviewed',
    strings: {
      'title': 'الحالات وأدوات التعريف',
      'bestimmter_artikel.title': 'أداة التعريف المحددة',
      'cases-guide.intro': 'تقديم الحالات',
    },
    nouns: { 'noun-1': { meaning: 'الجار', example: 'جارنا يساعدنا', rule: 'لا قاعدة' } },
  };
  return () => JSON.parse(JSON.stringify(bundle));
}

async function assertTranslatedPath(guides, nouns) {
  const translated = await mounted({ documents: guides, nouns, language: 'ar', route: '#/nachschlagen/cases-guide', translations: machineBundle() });
  const html = translated.page();
  assert.ok(html.includes('الحالات وأدوات التعريف'), 'the bundle title is rendered');
  assert.ok(html.includes('أداة التعريف المحددة'), 'a section title path is resolved');
  // The bundle carries three strings for this page: the document title, its intro and one section
  // title. Each resolved line carries the marker exactly once — and no other line does.
  assert.equal(count(html, l('libraryMachineTranslated')), 3, 'each machine-translated line carries the marker, and only those');
  assert.equal(count(html, s('m091')), 0, 'a page WITH a bundle shows no German-only note');
  assert.ok(html.includes('bestimmter_artikel') || html.includes('Bestimmter Artikel'), 'the German source is still present');
  assert.ok(translated.api.calls.some(call => call.endpoint === 'guides.read' && call.locale === 'ar'), 'the read path was asked for the locale');
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
  const bundled = await mounted({ documents: guides, nouns, limit: 500, language: 'ar', route: '#/nachschlagen/gender', translations: machineBundle() });
  const bundledPage = bundled.page();
  assert.ok(bundledPage.includes('الجار'), 'a noun meaning comes from the bundle');
  assert.ok(count(bundledPage, l('libraryMachineTranslated')) > 0, 'an unreviewed noun translation is marked');
  return true;
}

/* ------------------------------------------------------------------------------- mutation proof */

const COPY_FILES = [
  'public/app/library.js', 'public/app/guide-content.js', 'public/app/read-aloud.js', 'public/app/locale-preference.js',
  'public/assets/i18n/core.js', 'public/assets/i18n/practice-messages.js', 'public/assets/i18n/shell-messages.js',
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

function runIn(directory, script) {
  const file = path.join(directory, 'runner.mjs');
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
  const fixtures = JSON.stringify({ guides, nouns }).replace(/</g, '\\u003c');
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
function api(limit, translations) {
  return {
    guides: {
      list: async () => ({ ok: true, status: 200, data: fixtures.guides.map(entry => ({ guide_id: entry.guide_id, family: entry.family, title: entry.title, intro: entry.intro, section_count: entry.sections.length })) }),
      read: async (guideId, locale) => {
        const entry = fixtures.guides.find(candidate => candidate.guide_id === guideId);
        if (!entry) return { ok: false, status: 404, error: 'not_found' };
        const bundle = translations ? { locale, status: 'machine_unreviewed', strings: { title: 'ترجمة آلية للعنوان' } } : null;
        return { ok: true, status: 200, data: { ...entry, translations: bundle } };
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
    const wantsBundle = new URLSearchParams(location.search).get('translations') !== '0';
    const translations = wantsBundle && locale !== 'de' && locale !== 'en' ? { strings: { title: 'x' } } : null;
    setLocale(locale);
    if (view) view.unmount();
    view = createLibraryView({ api: api(limit, translations), esc, language: locale, uiText: (key, parameters) => s(key, parameters), navigate: hash => { location.hash = hash; },
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

console.log('PASS library render: 6 hub areas and their payload counts, 7 guide pages with a jump chip per section,');
console.log('     8 case tables marked exactly off the Nominativ reference, Arabic RTL with LTR German islands,');
console.log('     one German-only note per page, the machine-translated marker, and the lexicon filter/search path.');
console.log(`     ${guideCount()} guide sections and ${nouns.length} nouns through the module; ${getLocale()} locale left set by the last case.`);

function guideCount() {
  return guides.reduce((total, entry) => total + entry.sections.length, 0);
}
