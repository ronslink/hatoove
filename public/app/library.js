/**
 * NACHSCHLAGEN — the reference library (MIRROR-B1PREP-01, slices E and F).
 *
 * The hub of six areas and the guide pages behind them. The module owns every byte inside its own
 * section and its own stylesheet (`library.css`); the shell owns the route, the topbar and the mount.
 *
 *   export function createLibraryView(ctx) { return { mount(host, options?), unmount() }; }
 *   ctx = { api, uiText, esc, language, navigate, state, guideContent }   (contract section 4.2)
 *
 * THREE THINGS THIS MODULE DELIBERATELY DOES NOT DO.
 *
 *   * It does not invent content. Counts, titles, sections and examples come from the served payload
 *     (`GET /api/v1/guides`, `…/guides/:id`, `GET /api/v1/nouns`). Nothing is hard-coded except the
 *     six areas' interface labels, which live in the five-locale catalogue.
 *   * It does not write a second read-aloud implementation: German example lines are marked and the
 *     existing `read-aloud.js` mounts its own control on them.
 *   * It does not render a prediction, a readiness claim or a score. "Nachschlagen, nicht abgefragt".
 *
 * TRANSLATIONS (contract section 4.3, slice F2). The additive `translations` member of the guide
 * document is consumed when present:
 *   { locale, guideVersion, status, strings: { "<path>": "<text>" }, nouns: { "<entry_id>": { meaning, example, rule } } }
 * `strings` is looked up by a documented path set (section id first, then section ordinal, then the
 * payload-relative path), and every hit inherits the per-string status when the bundle carries one and
 * the bundle status otherwise. A bundle whose status is `machine_unreviewed` renders the marker
 * "maschinell übersetzt · Prüfung ausstehend" on each translated line. When there is no bundle, the
 * page renders the German source plus exactly ONE "not available in your language" note; `en` needs no
 * note because the authored `…En` fields are the translation.
 */

import { getLocale, subscribeLocale, validLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
import { guideContent as defaultGuideContent } from './guide-content.js';
import { createReadAloud } from './read-aloud.js';

/**
 * The server's page size for the noun lexicon: `listNouns` defaults to `limit = 50` and the route
 * passes none (`server/owned-postgres/adapter.mjs`, `server/owned-api.mjs`). A list that comes back at
 * exactly this size may be truncated, and the page says so instead of implying it is the whole lexicon.
 */
export const NOUN_PAGE_SIZE = 50;

/**
 * The two guide documents this module does NOT own: Kerngrammatik and the core phrases are Wortschatz
 * material (contract section 5 E/F). Slice G renders them in `vocab.js`, which imports this constant so
 * the boundary has exactly one definition; a deep link here hands over instead of rendering them.
 */
export const WORTSCHATZ_GUIDE_IDS = Object.freeze(['core-grammar', 'core-phrases']);

/** The six areas, in the contract's order. `unit` names the catalogue key holding the count pattern. */
export const LIBRARY_AREAS = Object.freeze([
  { id: 'speaking', guideId: 'speaking-guide', icon: '🗣', title: 'libraryAreaSpeaking', description: 'libraryDescSpeaking', unit: 'libraryCountParts' },
  { id: 'writing', guideId: 'writing-guide', icon: '✉', title: 'libraryAreaWriting', description: 'libraryDescWriting', unit: 'libraryCountEntries' },
  { id: 'cases', guideId: 'cases-guide', icon: '🧩', title: 'libraryAreaCases', description: 'libraryDescCases', unit: 'libraryCountEntries' },
  { id: 'gender', guideId: 'gender-rules', icon: '🔤', title: 'libraryAreaGender', description: 'libraryDescGender', unit: 'libraryCountEntries', lexicon: true },
  { id: 'grammar', guideId: 'grammar-guide', icon: '📘', title: 'libraryAreaGrammar', description: 'libraryDescGrammar', unit: 'libraryCountTopics' },
  { id: 'satzbau', navigate: '#/nachschlagen/satzbau', icon: '🧱', title: 'libraryAreaSatzbau', description: 'libraryDescSatzbau' },
]);

/** Section kinds to the shell label that names them. Every key already exists in the catalogue. */
export const SECTION_LABELS = Object.freeze({
  step: 'm079', topic: 'm080', tier: 'm081', gender_rule: 'm082', exception: 'm083',
  double_gender: 'm084', table: 'm085', trigger: 'm086', example: 'm087', phrase_group: 'm088',
  phrases: 'm088', checklist: 'm089', part: 'm061', example_letter: 'm087',
});
/** Kinds whose German line IS the content (an example sentence), so it can be read aloud. */
const SPEAKING_KINDS = new Set(['example', 'exception', 'double_gender']);
const dir = language => (language === 'ar' ? 'rtl' : 'ltr');
const text = value => String(value ?? '');

/**
 * The path a served translation is keyed by, exactly as slice F2 stores it.
 *
 * `guide_translation.path` is the bundle key verbatim and `readGuideTranslations` serves
 * `strings[row.path]` (`server/library-translations.mjs`, store `planGuideStrings` and read
 * `readGuideTranslations`; contract section 4.3 as amended by A2). The shape is
 * `<guide_id>/<section_id>.<field path>`, where a payload field keeps the store's own syntax:
 * `title` / `summary` for the two section columns, and `payload.` plus BRACKET indices for anything
 * inside the payload — `payload.phrases[0].hint`, `payload.table.headers[1]`, `payload.items[3].example`.
 *
 * Exported so `tools/library-render-check.mjs` can assert the client builds the key the real bundle
 * uses rather than a form it invented. That was the defect this fixes: the client's dotted,
 * prefix-free keys matched 0 of 50 requested paths, which renders as "German only" and is
 * indistinguishable from "no translations were imported".
 */
export function storedTranslationPath(guideId, sectionId, relative) {
  if (!guideId || !sectionId || !relative) return '';
  const bracketed = String(relative).split('.').reduce((accumulated, token) => (
    /^\d+$/.test(token) && accumulated ? `${accumulated}[${token}]` : (accumulated ? `${accumulated}.${token}` : token)
  ), '');
  const field = (relative === 'title' || relative === 'summary') ? relative : `payload.${bracketed}`;
  return `${guideId}/${sectionId}.${field}`;
}

/**
 * Which cells of a case table differ from the Nominativ reference, and where that reference is.
 *
 * A table either LABELS its rows with the case (`bestimmter_artikel`: the Nominativ row is the
 * reference and every other row is compared cell by cell) or NAMES its columns after the case
 * (`personalpronomen`, `n_deklination`: the Nominativ column is the reference). The first column is
 * always the row label and is never marked. A table with no Nominativ reference — the preposition
 * table lists Dativ/Akkusativ/Genitiv — marks nothing rather than inventing a baseline.
 *
 * Exported so `tools/library-render-check.mjs` can compare the marks in the rendered table with an
 * independent expectation.
 */
export function caseHighlights(table) {
  const headers = Array.isArray(table?.headers) ? table.headers : [];
  const rows = (Array.isArray(table?.rows) ? table.rows : []).map(row => (Array.isArray(row) ? row : []));
  const normalise = value => text(value).trim().toLowerCase();
  const nominativeRow = rows.findIndex(row => normalise(row?.[0]) === 'nominativ');
  const nominativeColumn = headers.findIndex((header, index) => index > 0 && normalise(header) === 'nominativ');
  const marked = new Set();
  const reference = nominativeRow >= 0 ? 'row' : (nominativeColumn > 0 ? 'column' : null);
  if (reference === 'row') {
    for (let row = 0; row < rows.length; row++) {
      if (row === nominativeRow) continue;
      for (let column = 1; column < rows[row].length; column++) {
        if (text(rows[row][column]) !== text(rows[nominativeRow][column])) marked.add(`${row}:${column}`);
      }
    }
  } else if (reference === 'column') {
    for (let row = 0; row < rows.length; row++) {
      for (let column = 1; column < rows[row].length; column++) {
        if (column === nominativeColumn) continue;
        if (text(rows[row][column]) !== text(rows[row][nominativeColumn])) marked.add(`${row}:${column}`);
      }
    }
  }
  return { reference, nominativeRow, nominativeColumn, marked };
}

export function createLibraryView(ctx = {}) {
  const esc = typeof ctx.esc === 'function' ? ctx.esc
    : (value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])));
  const uiText = typeof ctx.uiText === 'function' ? ctx.uiText : (() => '');
  const renderContent = typeof ctx.guideContent === 'function' ? ctx.guideContent : defaultGuideContent;
  const api = ctx.api || {};
  const navigate = typeof ctx.navigate === 'function' ? ctx.navigate : null;
  /** 250 ms is a compromise: a request per keystroke is wasteful, a long wait feels broken. */
  const schedule = typeof ctx.schedule === 'function' ? ctx.schedule : (run => setTimeout(run, 250));

  let host = null;
  let document_ = null;
  let readAloud = null;
  let unsubscribeLocale = null;
  let generation = 0;
  let guideRequest = 0;
  let lexiconRequest = 0;
  let searchTimer = null;
  let focusSearch = false;

  const index = { rows: null, loading: false, error: null };
  const documents = new Map();
  const lexicon = { entries: [], gender: null, q: '', loading: false, error: null, shown: 0, truncated: false, opened: false };
  let view = { name: 'hub', guideId: null, area: null };

  const locale = () => {
    const live = getLocale();
    if (validLocale(live)) return live;
    const fromState = ctx.state?.settings?.language;
    if (validLocale(fromState)) return fromState;
    return validLocale(ctx.language) ? ctx.language : 'de';
  };
  const message = (key, parameters) => pt(key, parameters, locale());
  const failure = res => {
    if (!res || res.status === 0) return uiText('m021');
    return uiText('m011') + ' ' + res.status + (res.error ? ' (' + res.error + ')' : '');
  };
  const machineNote = machine => (machine ? `<span class="library-machine-note">${esc(message('libraryMachineTranslated'))}</span>` : '');
  const translationMarkup = (markup, language, machine) => `<div class="library-translation${machine ? ' library-machine' : ''}" lang="${language}" dir="${dir(language)}">${markup}${machineNote(machine)}</div>`;
  /** One learner-language line from a resolved bundle string (or from an authored `…En` field). */
  const learnerLine = source => {
    if (!source || typeof source.text !== 'string' || !source.text.trim()) return '';
    return translationMarkup(esc(source.text), locale(), source.status === 'machine_unreviewed');
  };
  const authoredLine = source => (locale() === 'en' && source ? translationMarkup(esc(source), 'en', false) : '');
  const page = inner => `<section class="library" lang="${locale()}" dir="${dir(locale())}">${inner}</section>`;
  const backLink = () => `<p class="library-back"><button class="btn btn-small" type="button" data-library-hub><span class="library-arrow" aria-hidden="true">←</span> ${esc(uiText('m010'))}</button></p>`;
  const sectionLabel = kind => (SECTION_LABELS[kind] ? uiText(SECTION_LABELS[kind]) : uiText('m085'));
  const countChip = (label, count) => `<span class="chip">${esc(label)}: ${esc(text(count))}</span>`;

  /* ------------------------------------------------------------------ translations (section 4.3) */

  const bundleFor = doc => {
    const value = doc && typeof doc === 'object' ? doc.translations : null;
    if (!value || typeof value !== 'object') return null;
    return (value.strings || value.nouns) ? value : null;
  };
  const statusFor = (bundle, path, raw) => {
    const perString = raw && typeof raw === 'object' && typeof raw.status === 'string' ? raw.status : null;
    const candidates = [perString, bundle?.statuses?.[path], bundle?.stringStatus?.[path], bundle?.review?.[path]];
    const direct = candidates.find(value => typeof value === 'string');
    if (direct) return direct === 'machine_unreviewed' ? 'machine_unreviewed' : null;
    return bundle?.status === 'machine_unreviewed' ? 'machine_unreviewed' : null;
  };
  const resolveString = (bundle, paths) => {
    if (!bundle || !bundle.strings || typeof bundle.strings !== 'object') return null;
    for (const path of paths) {
      if (!path) continue;
      const raw = Object.hasOwn(bundle.strings, path) ? bundle.strings[path] : undefined;
      const value = typeof raw === 'string' ? raw : (raw && typeof raw.text === 'string' ? raw.text : null);
      if (typeof value === 'string' && value.trim()) return { text: value, status: statusFor(bundle, path, raw) };
    }
    return null;
  };
  /**
   * The path set for one section member, F2's stored key first (see `storedTranslationPath`) and the
   * older, prefix-free forms after it so a hand-written or future-normalised bundle still resolves.
   */
  const columnPaths = (guideId, section, column) => {
    const id = section?.section_id ? text(section.section_id) : '';
    const ordinal = Number.isInteger(section?.ordinal) ? section.ordinal : null;
    // F2's key space is `<guide>/<section_id>.<field>`; a bare `title` is never a section member's key.
    const stored = storedTranslationPath(guideId, id, column);
    const paths = [];
    if (stored) paths.push(stored);
    if (id) paths.push(`${id}.${column}`, `sections.${id}.${column}`);
    if (ordinal !== null) paths.push(`sections.${ordinal}.${column}`);
    return paths;
  };
  const payloadPaths = (guideId, section, relative) => {
    const id = section?.section_id ? text(section.section_id) : '';
    const ordinal = Number.isInteger(section?.ordinal) ? section.ordinal : null;
    const bracketed = String(relative).split('.').reduce((accumulated, token) => (
      /^\d+$/.test(token) && accumulated ? `${accumulated}[${token}]` : (accumulated ? `${accumulated}.${token}` : token)
    ), '');
    const stored = storedTranslationPath(guideId, id, relative);
    const paths = [];
    if (stored) paths.push(stored);
    if (id) paths.push(`${id}.payload.${bracketed}`, `${id}.${bracketed}`, `sections.${id}.payload.${bracketed}`);
    if (ordinal !== null) paths.push(`sections.${ordinal}.payload.${bracketed}`);
    if (!relative.startsWith('payload.')) paths.push(`payload.${bracketed}`);
    return paths;
  };
  const sectionResolver = (guideId, section, bundle) => (relative) => resolveString(bundle, payloadPaths(guideId, section, relative));
  /** Strings that belong to the guide document rather than a section: F2 has no key space for them. */
  const documentPaths = (guideId, member) => [
    `${guideId}/${member}`, `${guideId}.${member}`, `guide.${guideId}.${member}`, member,
  ];
  /** The ONE note a page shows when the learner's language has no translation at all. */
  const translationNote = bundle => {
    const language = locale();
    if (language === 'de' || language === 'en' || bundle) return '';
    return `<p class="small library-note">${esc(uiText('m091'))}</p>`;
  };

  /* ------------------------------------------------------------------------------------ the hub */

  const hubMarkup = () => {
    const rows = Array.isArray(index.rows) ? index.rows : [];
    const rowFor = guideId => rows.find(row => row && row.guide_id === guideId) || null;
    const cards = LIBRARY_AREAS.map(area => {
      const row = area.guideId ? rowFor(area.guideId) : null;
      const count = row && Number.isFinite(Number(row.section_count)) ? message(area.unit, { count: Number(row.section_count) }) : '';
      const extra = area.id === 'gender' ? `<span class="chip">${esc(message('libraryLexicon'))}</span>`
        : area.id === 'satzbau' ? `<span class="chip">${esc(message('libraryTool'))}</span>` : '';
      const action = area.navigate
        ? `<a class="btn" href="${esc(area.navigate)}" data-library-area="${area.id}">${esc(uiText('m077'))}</a>`
        : `<button class="btn" type="button" data-library-open="${area.id}">${esc(uiText('m077'))}</button>`;
      return `<article class="card library-card" data-library-card="${area.id}">`
        + `<span class="library-icon" aria-hidden="true">${esc(area.icon)}</span>`
        + '<div class="library-card-body">'
        + `<h3>${esc(message(area.title))}</h3>`
        + `<p class="muted">${esc(message(area.description))}</p>`
        + `<p class="library-counts">${count ? `<span class="chip">${esc(count)}</span>` : ''}${extra}</p>`
        + '</div>' + action + '</article>';
    }).join('');
    const body = index.loading && !index.rows ? `<div class="card"><h3>${esc(uiText('m057'))}</h3></div>`
      : index.error ? `<p class="err">${esc(index.error)}</p>`
        : rows.length ? `<div class="library-cards">${cards}</div>`
          : `<div class="card"><h3>${esc(uiText('m075'))}</h3><p class="muted">${esc(uiText('m076'))}</p></div>`;
    return page('<header class="library-head">'
      + `<h2 class="library-title">${esc(message('libraryAreasCount', { count: LIBRARY_AREAS.length }))}</h2>`
      + `<p class="muted">${esc(uiText('m340'))}</p></header>${body}`);
  };

  /* ------------------------------------------------------------------------------- guide pages */

  /**
   * A deep link to a corpus slice G owns. The library does not render it: it points at Wortschatz, where
   * the same corpus is presented by its one owner. The link is a plain hash anchor, so it works with or
   * without this module's JavaScript.
   */
  const handoverMarkup = () => page(backLink()
    + '<div class="card"><h2>' + esc(uiText('m395')) + '</h2>'
    + '<p>' + esc(message('libraryMovedToVocab')) + '</p>'
    + '<a class="btn" href="#/wortschatz">' + esc(uiText('m395')) + '</a></div>'
    + backLink());

  const jumpMarkup = jumps => (jumps.length
    ? `<nav class="library-jump" aria-label="${esc(message('libraryJump'))}">`
      + `<p class="library-jump-label small muted">${esc(message('libraryJump'))}</p>`
      + `<span class="library-chips">${jumps.map(jump => `<button class="chip library-chip" type="button" data-library-jump="${esc(jump.id)}">${esc(jump.label)}</button>`).join('')}</span></nav>`
    : '');

  const caseTableMarkup = (section, bundle, guideId) => {
    const payload = section.payload && typeof section.payload === 'object' ? section.payload : {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!headers.length || !rows.length) return '';
    const highlight = caseHighlights(payload);
    const table = (headerRow, english, language = 'de') => '<div class="guide-table" tabindex="0" role="region" aria-label="Grammatiktabelle"'
      + ` data-library-case-table="${esc(text(section.section_id || section.ordinal))}">`
      + '<table lang="de" dir="ltr"><thead><tr>'
      + headerRow.map(header => `<th scope="col" lang="${english ? 'en' : language}" dir="ltr">${esc(text(header))}</th>`).join('')
      + '</tr></thead><tbody>'
      + rows.map((row, r) => `<tr>${row.map((cell, c) => {
        const marked = highlight.marked.has(`${r}:${c}`);
        return `<td lang="de" dir="ltr"${marked ? ` class="library-case-marked" data-library-case="${r}:${c}"` : ''}>${esc(text(cell))}</td>`;
      }).join('')}</tr>`).join('')
      + '</tbody></table></div>';
    const englishHeaders = Array.isArray(payload.headersEn) ? payload.headersEn : null;
    const english = englishHeaders && englishHeaders.length ? authoredLine(table(englishHeaders, true)) : '';
    // F2 translates the eight tables' header cells (`<section>.payload.headers[i]`), so the German table
    // is followed by a dimmed learner-language table with the same body cells. One marker covers the
    // block: the headers are the machine-translated part, and the cells are the German forms themselves.
    const resolve = sectionResolver(guideId, section, bundle);
    const headerHits = headers.map((header, index) => resolve(`headers.${index}`));
    const translated = headerHits.some(Boolean)
      ? translationMarkup(
        table(headers.map((header, index) => (headerHits[index] ? headerHits[index].text : header)), false, locale()),
        locale(),
        headerHits.some(hit => hit && hit.status === 'machine_unreviewed'))
      : '';
    const legend = highlight.marked.size ? `<p class="library-legend small muted">${esc(message('libraryCasesLegend'))}</p>` : '';
    return table(headers, false) + english + translated + legend;
  };

  const sectionMarkup = (section, bundle, guideId) => {
    const kind = text(section.kind);
    const ordinal = Number.isInteger(section.ordinal) ? section.ordinal : 0;
    const anchor = `library-section-${ordinal}`;
    const headingId = `${anchor}-heading`;
    const speak = SPEAKING_KINDS.has(kind) && text(section.title).trim().length > 0;
    const payload = section.payload && typeof section.payload === 'object' ? section.payload : {};
    const titleTranslation = resolveString(bundle, columnPaths(guideId, section, 'title'))
      || (locale() === 'en' ? { text: section.title_en || payload.en || '' } : null);
    const summaryTranslation = resolveString(bundle, columnPaths(guideId, section, 'summary'))
      || (locale() === 'en' ? { text: section.summary_en || '' } : null);
    const resolve = sectionResolver(guideId, section, bundle);
    const content = kind === 'table'
      ? (caseTableMarkup(section, bundle, guideId) || '<div class="guide-content">' + renderContent(payload, esc, locale(), { library: true, speaker: true, resolve, machineMarker: message('libraryMachineTranslated') }) + '</div>')
      : '<div class="guide-content">' + renderContent(payload, esc, locale(), { library: true, speaker: true, resolve, machineMarker: message('libraryMachineTranslated') }) + '</div>';
    return `<article class="card library-section" id="${anchor}" data-library-section="${esc(kind)}">`
      + '<div class="card-head">'
      + `<h3 id="${headingId}" tabindex="-1" lang="de" dir="ltr"${speak ? ' data-library-speak' : ''}>${esc(text(section.title))}</h3>`
      + `<span class="chip">${esc(sectionLabel(kind))}</span></div>`
      + learnerLine(titleTranslation)
      + (section.summary ? `<p class="muted" lang="de" dir="ltr">${esc(text(section.summary))}</p>` : '')
      + learnerLine(summaryTranslation)
      + content
      + (payload.note ? `<p class="small muted" lang="de" dir="ltr">${esc(text(payload.note))}</p>` : '')
      + learnerLine(resolve('note'))
      + '</article>';
  };

  /**
   * The guide-level watch-out block. It lives on the `guide` row, not on a `guide_section`, so F2's key
   * space (`<guide>/<section_id>.<field>`) has no slot for it and the block stays German-only today.
   * The lookups are kept for a bundle that chooses to carry the list; nothing here invents a key.
   */
  const watchOutMarkup = (doc, ordinal, guideId) => {
    const items = Array.isArray(doc.watch_out) ? doc.watch_out : [];
    if (!items.length) return '';
    const anchor = `library-section-${ordinal}`;
    const english = Array.isArray(doc.watch_out_en) ? doc.watch_out_en : [];
    return `<article class="card library-section" id="${anchor}" data-library-section="watch_out">`
      + `<div class="card-head"><h3 id="${anchor}-heading" tabindex="-1">${esc(uiText('m272'))}</h3><span class="chip">${esc(uiText('m272'))}</span></div>`
      + `<ul class="guide-list" lang="de" dir="ltr">${items.map(item => `<li>${esc(text(item))}</li>`).join('')}</ul>`
      + (english.length
        ? learnerLine(locale() === 'en'
          ? { text: english.join(' · ') }
          : resolveString(bundleFor(doc), [...documentPaths(guideId, 'watch_out'), 'watchOut', 'watch_out']))
        : '')
      + '</article>';
  };

  const lexiconMarkup = bundle => {
    const language = locale();
    const filters = [null, 'der', 'die', 'das'].map(gender => {
      const active = lexicon.gender === gender;
      const label = gender || message('libraryAllGenders');
      return `<button class="chip library-chip${active ? ' library-chip-active' : ''}" type="button"`
        + ` data-library-gender="${esc(gender || '')}" aria-pressed="${active}"${gender ? ' lang="de" dir="ltr"' : ''}>${esc(label)}</button>`;
    }).join('');
    const tooShort = lexicon.q.trim().length === 1;
    const countLine = lexicon.loading ? uiText('m057')
      : lexicon.shown ? (lexicon.truncated ? message('libraryShown', { count: lexicon.shown }) : message('libraryCountNouns', { count: lexicon.shown }))
        : uiText('m070');
    const rows = lexicon.entries.map(entry => {
      const id = text(entry.entry_id || entry.de);
      const noun = bundle && bundle.nouns && typeof bundle.nouns === 'object' ? bundle.nouns[id] : null;
      const machine = (noun && typeof noun.status === 'string' ? noun.status : bundle?.status) === 'machine_unreviewed';
      const meaning = (noun && typeof noun.meaning === 'string' ? noun.meaning : '') || (language === 'en' ? text(entry.en) : '');
      const rule = (noun && typeof noun.rule === 'string' ? noun.rule : '') || (language === 'en' ? text(entry.rule_en) : '');
      const example = (noun && typeof noun.example === 'string' ? noun.example : '') || (language === 'en' ? text(entry.example_en) : '');
      return '<article class="card library-noun">'
        + `<div class="card-head"><h3 lang="de" dir="ltr">${esc(text(entry.de))}</h3><span class="chip" lang="de" dir="ltr">${esc(text(entry.gender))}</span></div>`
        + (meaning ? translationMarkup(esc(meaning), language, machine) : '')
        + (entry.plural ? `<p class="small muted">${esc(uiText('m283'))}: <span lang="de" dir="ltr">${esc(text(entry.plural))}</span></p>` : '')
        + (entry.rule ? `<p class="small muted">${esc(uiText('m267'))}: <span lang="de" dir="ltr">${esc(text(entry.rule))}</span></p>` : '')
        + (rule ? translationMarkup(esc(rule), language, machine) : '')
        + (entry.example ? `<p class="small" lang="de" dir="ltr" data-library-speak>${esc(text(entry.example))}</p>` : '')
        + (example ? translationMarkup(esc(example), language, machine) : '')
        + '</article>';
    }).join('');
    return `<article class="card library-section library-lexicon" id="library-section-lexicon" data-library-section="lexicon">`
      + `<div class="card-head"><h3 id="library-section-lexicon-heading" tabindex="-1">${esc(message('libraryLexicon'))}</h3><span class="chip">${esc(countLine)}</span></div>`
      + `<div class="library-search"><label class="field-label" for="library-search-input">${esc(uiText('m337'))}</label>`
      + `<input id="library-search-input" class="library-search-input" type="search" data-library-search value="${esc(lexicon.q)}" placeholder="${esc(uiText('m337'))}" autocomplete="off"></div>`
      + (tooShort ? `<p class="small muted">${esc(uiText('m068'))}</p>` : '')
      + `<p class="library-filters"><span class="small muted">${esc(uiText('m282'))}:</span> ${filters}</p>`
      + (lexicon.error ? `<p class="err">${esc(lexicon.error)}</p>` : '')
      + (lexicon.truncated ? `<p class="small muted">${esc(message('libraryPartial'))}</p>` : '')
      + `<div class="library-results" data-library-results>${rows || `<p class="muted">${esc(uiText('m071'))}</p>`}</div>`
      + '</article>';
  };

  const guidePageMarkup = () => {
    const area = LIBRARY_AREAS.find(candidate => candidate.guideId === view.guideId) || null;
    const record = documents.get(view.guideId);
    if (!record || record.loading) return page(backLink() + `<div class="card"><h3>${esc(uiText('m057'))}</h3></div>`);
    if (!record.ok) return page(backLink() + `<p class="err">${esc(uiText('m069'))} ${esc(failure(record))}</p>` + backLink());
    const doc = record.data && typeof record.data === 'object' ? record.data : {};
    const bundle = bundleFor(doc);
    /**
     * The guide id F2's keys are prefixed with. Taken from the SERVED document (falling back to the
     * route) because that is the id the server stored the translation rows against.
     */
    const guideId = text(doc.guide_id || view.guideId);
    const sections = Array.isArray(doc.sections) ? doc.sections : [];
    const watchOut = Array.isArray(doc.watch_out) ? doc.watch_out : [];
    const kinds = new Map();
    for (const section of sections) kinds.set(section.kind, (kinds.get(section.kind) || 0) + 1);
    const counts = [...kinds.entries()].map(([kind, count]) => countChip(sectionLabel(kind), count)).join('')
      + (watchOut.length ? countChip(uiText('m272'), watchOut.length) : '');
    const jumps = [
      ...sections.map((section, position) => ({
        id: `library-section-${Number.isInteger(section.ordinal) ? section.ordinal : position}`,
        label: text(section.title) || sectionLabel(section.kind),
      })),
      ...(watchOut.length ? [{ id: `library-section-${sections.length}`, label: uiText('m272') }] : []),
      ...(area && area.lexicon ? [{ id: 'library-section-lexicon', label: message('libraryLexicon') }] : []),
    ];
    const title = text(doc.title);
    // F2's key space is the section (`<guide>/<section>.<field>`); the document title and intro have no
    // key there, so these two lookups can only succeed for a bundle that chose to carry them, and the
    // German source stands otherwise. Recorded rather than invented.
    const titleTranslation = resolveString(bundle, documentPaths(guideId, 'title')) || (locale() === 'en' ? { text: doc.title_en || '' } : null);
    const introTranslation = resolveString(bundle, documentPaths(guideId, 'intro')) || (locale() === 'en' ? { text: doc.intro_en || '' } : null);
    return page(backLink()
      + '<header class="library-head">'
      + `<h2 class="library-title" lang="de" dir="ltr">${esc(title)}</h2>`
      + learnerLine(titleTranslation)
      + `<p class="library-counts"><span class="chip library-pill">${esc(message('libraryPill'))}</span>${counts}</p>`
      + (doc.intro ? `<p class="muted" lang="de" dir="ltr">${esc(text(doc.intro))}</p>` : '')
      + learnerLine(introTranslation)
      + `<p class="small muted">${esc(uiText('m090'))}</p>`
      + translationNote(bundle)
      + '</header>'
      + jumpMarkup(jumps)
      + sections.map(section => sectionMarkup(section, bundle, guideId)).join('')
      + watchOutMarkup(doc, sections.length, guideId)
      + (area && area.lexicon ? lexiconMarkup(bundle) : '')
      + backLink());
  };

  /* ------------------------------------------------------------------------------- data loading */

  const readHash = () => (typeof globalThis.location?.hash === 'string' ? globalThis.location.hash : '');
  const targetForRoute = route => {
    const match = /(?:^|[#/])nachschlagen(?:\/([a-z][a-z0-9-]*))?(?:[?#]|$)/.exec(text(route));
    const slug = match && match[1] ? match[1] : null;
    if (!slug) return { name: 'hub', guideId: null, area: null };
    const area = LIBRARY_AREAS.find(candidate => candidate.id === slug) || LIBRARY_AREAS.find(candidate => candidate.guideId === slug);
    if (area?.navigate) return { name: 'hub', guideId: null, area: null };
    const guideId = area ? area.guideId : slug;
    /**
     * Kerngrammatik and the core phrases are WORTSCHATZ material (contract section 5 E/F: they "leave
     * this hub for Wortschatz"), and slice G owns them now. A deep link to one of those documents hands
     * over instead of rendering it: two owners of one corpus would let the two presentations drift.
     */
    if (WORTSCHATZ_GUIDE_IDS.includes(guideId)) return { name: 'handover', guideId, area: null };
    return { name: 'guide', guideId, area: area ? area.id : null };
  };

  async function loadIndex() {
    if (typeof api.guides?.list !== 'function') { index.error = uiText('m069'); return; }
    const life = generation;
    index.loading = true;
    try {
      const res = await api.guides.list();
      if (life !== generation) return;
      if (!res || !res.ok) { index.error = uiText('m069') + ' ' + failure(res); index.rows = null; }
      else index.rows = Array.isArray(res.data) ? res.data : [];
    } catch {
      if (life === generation) index.error = uiText('m069') + ' ' + uiText('m021');
    }
    if (life === generation) index.loading = false;
  }

  async function loadGuide(guideId) {
    const cached = documents.get(guideId);
    if (cached && cached.ok) return;
    const life = generation;
    const ticket = ++guideRequest;
    documents.set(guideId, { loading: true });
    render();
    if (typeof api.guides?.read !== 'function') { documents.set(guideId, { ok: false, status: 0 }); render(); return; }
    let record;
    try {
      // The locale is passed for the additive `translations` member (section 4.3). An api that does
      // not accept it yet simply answers without translations, which is the German-only path.
      const res = await api.guides.read(guideId, locale());
      record = res && res.ok ? { ok: true, data: res.data } : { ok: false, status: res?.status, error: res?.error };
    } catch {
      record = { ok: false, status: 0 };
    }
    if (life !== generation || ticket !== guideRequest) return;
    documents.set(guideId, record);
    render();
  }

  async function loadLexicon(change = {}) {
    if (Object.hasOwn(change, 'gender')) lexicon.gender = change.gender;
    if (Object.hasOwn(change, 'q')) lexicon.q = change.q;
    if (typeof api.nouns?.list !== 'function') { lexicon.error = uiText('m069') + ' ' + uiText('m021'); render(); return; }
    const life = generation;
    const ticket = ++lexiconRequest;
    lexicon.loading = true;
    lexicon.error = null;
    render();
    const query = {};
    if (lexicon.gender) query.gender = lexicon.gender;
    if (lexicon.q.trim().length >= 2) query.q = lexicon.q.trim();
    let entries = [];
    let failed = null;
    try {
      const res = await api.nouns.list(query);
      if (!res || !res.ok) failed = uiText('m069') + ' ' + failure(res);
      else entries = Array.isArray(res.data) ? res.data : [];
    } catch {
      failed = uiText('m069') + ' ' + uiText('m021');
    }
    if (life !== generation || ticket !== lexiconRequest) return;
    lexicon.loading = false;
    lexicon.error = failed;
    lexicon.entries = entries;
    lexicon.shown = entries.length;
    // Exactly the route's page size is the only honest signal available: a smaller list is complete,
    // a larger one could not have come from a capped route, and this one may have been cut off.
    lexicon.truncated = entries.length === NOUN_PAGE_SIZE;
    render();
  }

  /* ---------------------------------------------------------------------------------- rendering */

  function render() {
    if (!host) return;
    readAloud?.clear(host);
    host.innerHTML = view.name === 'guide' ? guidePageMarkup()
      : view.name === 'handover' ? handoverMarkup()
        : hubMarkup();
    host.onclick = onClick;
    host.oninput = onInput;
    if (typeof host.querySelectorAll === 'function' && readAloud && document_) {
      for (const node of host.querySelectorAll('[data-library-speak]') || []) readAloud.mount(node, { label: uiText('m087'), language: 'de' });
    }
    if (focusSearch) {
      focusSearch = false;
      const input = typeof host.querySelector === 'function' ? host.querySelector('[data-library-search]') : null;
      input?.focus?.();
      try { input?.setSelectionRange?.(text(input.value).length, text(input.value).length); } catch { /* selection is cosmetic */ }
    }
  }

  function onClick(event) {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-library-hub]')) { goHub(); return; }
    const open = target.closest('[data-library-open]');
    if (open) { openArea(open.dataset?.libraryOpen); return; }
    const jump = target.closest('[data-library-jump]');
    if (jump) {
      const id = text(jump.dataset?.libraryJump);
      const heading = document_?.getElementById?.(`${id}-heading`);
      const section = document_?.getElementById?.(id);
      (heading || section)?.scrollIntoView?.({ block: 'start' });
      heading?.focus?.();
      return;
    }
    const gender = target.closest('[data-library-gender]');
    if (gender) { loadLexicon({ gender: gender.dataset?.libraryGender || null }); return; }
  }

  function onInput(event) {
    const target = event?.target;
    if (!target || !target.dataset || !Object.hasOwn(target.dataset, 'librarySearch')) return;
    lexicon.q = text(target.value);
    focusSearch = true;
    if (searchTimer) clearTimeout(searchTimer);
    if (lexicon.q.trim().length === 1) { render(); return; }
    searchTimer = schedule(() => { searchTimer = null; loadLexicon(); });
  }

  function goHub() {
    if (view.name === 'hub') return;
    view = { name: 'hub', guideId: null, area: null };
    render();
  }

  function openArea(id) {
    const area = LIBRARY_AREAS.find(candidate => candidate.id === id);
    if (!area) return;
    if (area.navigate) { if (navigate) navigate(area.navigate); else if (globalThis.location) globalThis.location.hash = area.navigate; return; }
    view = { name: 'guide', guideId: area.guideId, area: area.id };
    render();
    void loadGuide(area.guideId);
    if (area.lexicon && !lexicon.entries.length) void loadLexicon();
  }

  function onHashChange() {
    const next = targetForRoute(readHash());
    if (next.name === view.name && next.guideId === view.guideId) return;
    view = next;
    render();
    if (view.name === 'guide') {
      void loadGuide(view.guideId);
      if (view.guideId === 'gender-rules' && !lexicon.entries.length) void loadLexicon();
    }
  }

  /* ------------------------------------------------------------------------------------ lifecycle */

  function mount(nextHost, options = {}) {
    host = nextHost || null;
    if (!host) return;
    generation++;
    document_ = host.ownerDocument || (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
    readAloud = createReadAloud({ doc: document_ });
    view = targetForRoute(typeof options.route === 'string' ? options.route : readHash());
    // A translation bundle belongs to one locale, so a language change drops the cached documents and
    // re-reads the open one by its own id; every interface label is re-rendered from the catalogue.
    unsubscribeLocale = subscribeLocale(() => {
      documents.clear();
      render();
      if (view.name === 'guide') void loadGuide(view.guideId);
    });
    globalThis.addEventListener?.('hashchange', onHashChange);
    render();
    void loadIndex().then(() => { if (host) render(); });
    if (view.name === 'guide') {
      void loadGuide(view.guideId);
      if (view.guideId === 'gender-rules') void loadLexicon();
    }
  }

  function unmount() {
    generation++;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    globalThis.removeEventListener?.('hashchange', onHashChange);
    readAloud?.destroy?.();
    readAloud = null;
    if (host) host.innerHTML = '';
    host = null;
    document_ = null;
  }

  return { mount, unmount };
}
