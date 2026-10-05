/**
 * WORTSCHATZ — the vocabulary view (MIRROR-B1PREP-01 slice G, VOCAB-01).
 *
 * Two halves, in this order and never the other way round:
 *
 *   1. the **Prüfungskern** — the `core-grammar` and `core-phrases` corpora, browsable by block (one
 *      block is one served tier), presented as reference material, not as guide pages;
 *   2. the **word deck** — the 300-entry list from `GET /api/v1/vocab`, browsable by part of speech
 *      and searchable.
 *
 * BROWSE ONLY. No spaced repetition, no streak, no readiness, no study plan, no review schedule: the
 * slice's brief puts spaced repetition explicitly out of scope, the contract forbids readiness and
 * study-plan surfaces (D22), and this module invents neither. There is no per-item state at all,
 * because the server serves none.
 *
 * The shell (slice A) owns the route and the section; this module owns everything inside `#vocab-host`
 * and its own stylesheet. `ctx = { api, uiText, esc, language, examLanguage, navigate, state }`.
 *
 * TWO THINGS THE SERVED PAYLOADS DO NOT CARRY, recorded instead of invented:
 *   * the deck has no uk/ar/tr translation (slice F2 covers the guide sections and the noun lexicon);
 *     the authored `en` gloss is shown on the English page only, and a learner in another interface
 *     language sees the German list plus the one "not yet available in your language" note;
 *   * the Prüfungskern has translations for the item EXAMPLE sentences only, so the block titles,
 *     the German headwords and the notes stay German.
 */

import { getLocale, subscribeLocale, validLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
import { createReadAloud } from './read-aloud.js';
import { storedTranslationPath, NOUN_PAGE_SIZE as SERVER_LIST_PAGE, WORTSCHATZ_GUIDE_IDS } from './library.js';

/**
 * The two corpora this view owns. The list lives in `library.js` (which must NOT render them) and is
 * imported here, so the ownership boundary has exactly one definition.
 */
export const CORE_CORPORA = WORTSCHATZ_GUIDE_IDS;

/** The deck's filters. `value` is one of the closed `pos` values the route accepts. */
export const POS_FILTERS = Object.freeze([
  { value: null, key: 'vocabAll' },
  { value: 'noun', key: 'vocabPosNoun' },
  { value: 'verb', key: 'vocabPosVerb' },
  { value: 'adj', key: 'vocabPosAdj' },
  { value: 'adv', key: 'vocabPosAdv' },
  { value: 'phrase', key: 'vocabPosPhrase' },
]);

const text = value => String(value ?? '');
const dir = language => (language === 'ar' ? 'rtl' : 'ltr');
const posLabel = (pos, message) => {
  const match = POS_FILTERS.find(filter => filter.value === pos);
  return match ? message(match.key) : text(pos);
};

export function createVocabView(ctx = {}) {
  const esc = typeof ctx.esc === 'function' ? ctx.esc
    : (value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])));
  const uiText = typeof ctx.uiText === 'function' ? ctx.uiText : (() => '');
  const api = ctx.api || {};
  const schedule = typeof ctx.schedule === 'function' ? ctx.schedule : (run => setTimeout(run, 250));

  let host = null;
  let document_ = null;
  let readAloud = null;
  let unsubscribeLocale = null;
  let generation = 0;
  let coreRequest = 0;
  let deckRequest = 0;
  let searchTimer = null;
  let focusSearch = false;
  /** Elements the shell keeps in this section for its own interim dictionary; restored on unmount. */
  let coveredLegacy = [];

  const core = { documents: new Map(), loading: true, error: null, blocks: { 'core-grammar': null, 'core-phrases': null } };
  const deck = { entries: [], positions: [], pos: null, q: '', shown: 0, truncated: false, loading: true, error: null };

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
  const page = inner => `<section class="vocab" lang="${locale()}" dir="${dir(locale())}">${inner}</section>`;
  /**
   * The learner-language line and its marker use THIS module's class names, not the library's: the shell
   * injects a module's stylesheet only when that module loads, so a learner who opens Wortschatz first
   * must not depend on `library.css` being present.
   */
  const machineNote = machine => (machine ? `<span class="vocab-machine-note">${esc(message('libraryMachineTranslated'))}</span>` : '');
  const translationMarkup = (markup, machine) => `<div class="vocab-translation${machine ? ' vocab-machine' : ''}" lang="${locale()}" dir="${dir(locale())}">${markup}${machineNote(machine)}</div>`;
  const chunk = (head, body) => `<section class="vocab-chunk" id="vocab-${head}">${body}</section>`;

  /* ------------------------------------------------------------------- translations (as in E/F) */

  const bundleFor = doc => {
    const value = doc && typeof doc === 'object' ? doc.translations : null;
    if (!value || typeof value !== 'object') return null;
    return (value.strings || value.nouns) ? value : null;
  };
  const statusFor = (bundle, path) => {
    const direct = bundle?.stringStatus?.[path];
    if (typeof direct === 'string') return direct === 'machine_unreviewed' ? 'machine_unreviewed' : null;
    return bundle?.status === 'machine_unreviewed' ? 'machine_unreviewed' : null;
  };
  /** One item field, looked up by F2's stored key (`<guide>/<section>.payload.items[i].field`). */
  const itemTranslation = (bundle, guideId, section, index, field) => {
    if (!bundle) return null;
    const path = storedTranslationPath(guideId, section.section_id, `items.${index}.${field}`);
    const raw = path && Object.hasOwn(bundle.strings || {}, path) ? bundle.strings[path] : undefined;
    const value = typeof raw === 'string' ? raw : (raw && typeof raw.text === 'string' ? raw.text : null);
    return typeof value === 'string' && value.trim() ? { text: value, status: statusFor(bundle, path) } : null;
  };
  /** The English gloss is authored content: the English page shows it, no other page does. */
  const englishLine = value => (locale() === 'en' && value
    ? `<div class="vocab-translation" lang="en" dir="ltr">${esc(text(value))}</div>` : '');

  /* ------------------------------------------------------------------------- the Prüfungskern */

  const coreBlockMarkup = (guideId, doc) => {
    const bundle = bundleFor(doc);
    const sections = Array.isArray(doc.sections) ? doc.sections : [];
    const active = core.blocks[guideId];
    const visible = active === null ? sections : sections.filter((section, index) => `block-${index}` === active);
    const chips = [{ id: null, label: message('vocabAll'), count: sections.length }].concat(sections.map((section, index) => ({
      id: `block-${index}`,
      label: text(section.title),
      count: Array.isArray(section.payload?.items) ? section.payload.items.length : 0,
    })));
    const items = section => {
      const list = Array.isArray(section.payload?.items) ? section.payload.items : [];
      return list.map((item, index) => {
        const translation = itemTranslation(bundle, guideId, section, index, 'example');
        return '<li class="vocab-item">'
          + `<p class="vocab-term" lang="de" dir="ltr" data-vocab-speak>${esc(text(item.de))}</p>`
          + englishLine(item.en)
          + (item.example ? `<p class="vocab-example" lang="de" dir="ltr" data-vocab-speak>${esc(text(item.example))}</p>` : '')
          + (translation ? translationMarkup(`<p>${esc(translation.text)}</p>`, translation.status === 'machine_unreviewed') : '')
          + (item.note ? `<p class="small muted" lang="de" dir="ltr">${esc(text(item.note))}</p>` : '')
          + '</li>';
      }).join('');
    };
    const blocks = visible.map((section, position) => {
      const original = sections.indexOf(section);
      return `<article class="card vocab-block" id="vocab-block-${esc(guideId)}-${original}">`
        + `<div class="card-head"><h5 lang="de" dir="ltr">${esc(text(section.title))}</h5>`
        + `<span class="chip">${esc(message('libraryCountEntries', { count: (section.payload?.items || []).length }))}</span></div>`
        + (section.summary ? `<p class="muted" lang="de" dir="ltr">${esc(text(section.summary))}</p>` : '')
        + `<ul class="vocab-items">${items(section)}</ul></article>`;
    }).join('');
    return `<article class="card vocab-corpus" data-vocab-corpus="${esc(guideId)}">`
      + `<div class="card-head"><h4 lang="de" dir="ltr">${esc(text(doc.title))}</h4>`
      + `<span class="chip">${esc(message('libraryCountEntries', { count: sections.reduce((total, section) => total + (section.payload?.items || []).length, 0) }))}</span></div>`
      + `<p class="vocab-blocks-label small muted">${esc(message('vocabBlocks'))}</p>`
      + `<p class="vocab-chips">${chips.map(chip => `<button class="chip vocab-chip${(active === chip.id) ? ' vocab-chip-active' : ''}" type="button"`
        + ` data-vocab-block="${esc(guideId)}:${esc(chip.id ?? '')}" aria-pressed="${active === chip.id}">`
        + `${esc(chip.label)} <span class="vocab-chip-count">${esc(String(chip.count))}</span></button>`).join('')}</p>`
      + `<div class="vocab-block-list">${blocks}</div></article>`;
  };

  const coreMarkup = () => {
    const body = CORE_CORPORA.map(guideId => {
      const record = core.documents.get(guideId);
      if (core.loading && !record) return `<div class="card"><h3>${esc(uiText('m057'))}</h3></div>`;
      if (!record) return '';
      if (!record.ok) return `<p class="err">${esc(uiText('m069'))} ${esc(failure(record))}</p>`;
      const doc = record.data && typeof record.data === 'object' ? record.data : {};
      return coreBlockMarkup(guideId, doc);
    }).join('');
    return chunk('core', '<header class="vocab-head"><h3>'
      + `${esc(message('vocabCore'))}</h3><p class="muted">${esc(message('vocabCoreDesc'))}</p></header>`
      + (core.error ? `<p class="err">${esc(core.error)}</p>` : '')
      + body);
  };

  /* ------------------------------------------------------------------------------- the deck */

  const wordMarkup = entry => '<li class="card vocab-word">'
    + `<div class="card-head"><h4 lang="de" dir="ltr">${esc(text(entry.de))}</h4>`
    + `<span class="chip">${esc(posLabel(entry.pos, message))}</span></div>`
    + englishLine(entry.en)
    + (entry.plural ? `<p class="small muted">${esc(uiText('m283'))}: <span lang="de" dir="ltr">${esc(text(entry.plural))}</span></p>` : '')
    + (entry.example ? `<p class="vocab-example" lang="de" dir="ltr" data-vocab-speak>${esc(text(entry.example))}</p>` : '')
    + '</li>';

  const deckMarkup = () => {
    const language = locale();
    const tooShort = deck.q.trim().length === 1;
    const countLine = deck.loading ? uiText('m057')
      : deck.shown ? (deck.truncated ? message('libraryShown', { count: deck.shown }) : message('libraryCountEntries', { count: deck.shown }))
        : uiText('m070');
    // The chips are the parts of speech the served payload actually contains, plus "Alle": a filter that
    // can never match would be a dead control, and the label list is the closed `pos` set the route accepts.
    const filters = [{ value: null, key: 'vocabAll' }]
      .concat(deck.positions.map(pos => ({ value: pos, key: POS_FILTERS.find(filter => filter.value === pos)?.key ?? null, label: posLabel(pos, message) })))
      .map(filter => `<button class="chip vocab-chip${deck.pos === filter.value ? ' vocab-chip-active' : ''}" type="button"`
        + ` data-vocab-pos="${esc(filter.value ?? '')}" aria-pressed="${deck.pos === filter.value}">`
        + `${esc(filter.label ?? message(filter.key))}</button>`).join('');
    const words = deck.entries.map(wordMarkup).join('');
    return chunk('deck', '<header class="vocab-head"><h3>'
      + `${esc(message('vocabDeck'))}</h3><p class="muted">${esc(message('vocabDeckDesc'))}</p></header>`
      + `<div class="vocab-search"><label class="field-label" for="vocab-search-input">${esc(uiText('m337'))}</label>`
      + `<input id="vocab-search-input" class="vocab-search-input" type="search" data-vocab-search value="${esc(deck.q)}"`
      + ` placeholder="${esc(uiText('m385'))}" autocomplete="off"></div>`
      + (tooShort ? `<p class="small muted">${esc(uiText('m068'))}</p>` : '')
      + `<p class="vocab-chips"><span class="small muted">${esc(message('vocabPos'))}:</span> ${filters}</p>`
      + `<p class="vocab-count small muted" data-vocab-count>${esc(countLine)}</p>`
      + (language === 'de' || language === 'en' ? '' : `<p class="small vocab-note">${esc(uiText('m091'))}</p>`)
      + (deck.error ? `<p class="err">${esc(deck.error)}</p>` : '')
      + (deck.truncated ? `<p class="small muted">${esc(message('vocabPartial'))}</p>` : '')
      + `<ul class="vocab-results" data-vocab-results>${words || `<li class="muted">${esc(uiText('m071'))}</li>`}</ul>`);
  };

  /* ---------------------------------------------------------------------------------- rendering */

  const markup = () => page(`<header class="vocab-head"><h2>${esc(uiText('m395'))}</h2>`
    + `<p class="muted">${esc(message('vocabIntro'))}</p></header>`
    + coreMarkup() + deckMarkup());

  function render() {
    if (!host) return;
    readAloud?.clear(host);
    host.innerHTML = markup();
    host.onclick = onClick;
    host.oninput = onInput;
    if (typeof host.querySelectorAll === 'function' && readAloud && document_) {
      for (const node of host.querySelectorAll('[data-vocab-speak]') || []) readAloud.mount(node, { label: uiText('m087'), language: 'de' });
    }
    if (focusSearch) {
      focusSearch = false;
      const input = typeof host.querySelector === 'function' ? host.querySelector('[data-vocab-search]') : null;
      input?.focus?.();
      try { input?.setSelectionRange?.(text(input.value).length, text(input.value).length); } catch { /* selection is cosmetic */ }
    }
  }

  function onClick(event) {
    const target = event?.target;
    if (!target || typeof target.closest !== 'function') return;
    const block = target.closest('[data-vocab-block]');
    if (block) {
      const [guideId, id] = text(block.dataset?.vocabBlock).split(':');
      core.blocks[guideId] = id ? id : null;
      render();
      return;
    }
    const pos = target.closest('[data-vocab-pos]');
    if (pos) {
      loadDeck({ pos: pos.dataset?.vocabPos || null });
    }
  }

  function onInput(event) {
    const target = event?.target;
    if (!target || !target.dataset || !Object.hasOwn(target.dataset, 'vocabSearch')) return;
    deck.q = text(target.value);
    focusSearch = true;
    if (searchTimer) clearTimeout(searchTimer);
    if (deck.q.trim().length === 1) { render(); return; }
    searchTimer = schedule(() => { searchTimer = null; loadDeck(); });
  }

  /* ------------------------------------------------------------------------------ data loading */

  async function loadCore() {
    const life = generation;
    const ticket = ++coreRequest;
    core.loading = true;
    core.error = null;
    render();
    if (typeof api.guides?.read !== 'function') { core.error = uiText('m069') + ' ' + uiText('m021'); core.loading = false; render(); return; }
    const questions = CORE_CORPORA.map(guideId => api.guides.read(guideId, locale()).then(
      res => ({ guideId, record: res && res.ok ? { ok: true, data: res.data } : { ok: false, status: res?.status, error: res?.error } }),
      () => ({ guideId, record: { ok: false, status: 0 } })));
    const answers = await Promise.all(questions);
    if (life !== generation || ticket !== coreRequest) return;
    for (const answer of answers) core.documents.set(answer.guideId, answer.record);
    core.loading = false;
    render();
  }

  async function loadDeck(change = {}) {
    if (Object.hasOwn(change, 'pos')) deck.pos = change.pos;
    if (Object.hasOwn(change, 'q')) deck.q = change.q;
    if (typeof api.vocab?.list !== 'function') { deck.error = uiText('m069') + ' ' + uiText('m021'); render(); return; }
    const life = generation;
    const ticket = ++deckRequest;
    deck.loading = true;
    deck.error = null;
    render();
    const query = {};
    if (deck.pos) query.pos = deck.pos;
    if (deck.q.trim().length >= 2) query.q = deck.q.trim();
    let entries = [];
    let failed = null;
    try {
      const res = await api.vocab.list(query);
      if (!res || !res.ok) failed = uiText('m069') + ' ' + failure(res);
      else entries = Array.isArray(res.data) ? res.data : [];
    } catch {
      failed = uiText('m069') + ' ' + uiText('m021');
    }
    if (life !== generation || ticket !== deckRequest) return;
    deck.loading = false;
    deck.error = failed;
    deck.entries = entries;
    deck.shown = entries.length;
    // The filter chips are the parts of speech this corpus actually carries; the first load is
    // unfiltered, so the list is complete before any filter can narrow it.
    deck.positions = [...new Set([...deck.positions, ...entries.map(entry => text(entry.pos)).filter(Boolean)])].sort();
    // The datastore's own page size (`adapter.mjs` `listVocab` default). Exactly this many rows may have
    // been cut off, and the page says so rather than implying it has shown the whole deck.
    deck.truncated = entries.length === SERVER_LIST_PAGE;
    render();
  }

  /* ------------------------------------------------------------------------------------ lifecycle */

  function mount(nextHost) {
    host = nextHost || null;
    if (!host) return;
    generation++;
    document_ = host.ownerDocument || (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
    readAloud = createReadAloud({ doc: document_ });
    /**
     * The shell hides the nodes it knows about (`covers: ['dict-results']`). The interim dictionary also
     * puts an unlabelled heading and a search card in this section, and no id exists for them, so the
     * module hides the direct `.page-head` / `.card` siblings it supersedes and restores them on unmount
     * (a module that cannot be imported must leave the interim view intact). Reported to the Lead as a
     * shell-side cleanup: give those two nodes ids and extend `covers`.
     */
    const section = typeof host.closest === 'function' ? host.closest('section.view') : null;
    coveredLegacy = section ? [...section.children].filter(node => node !== host
      && (node.classList?.contains('page-head') || node.classList?.contains('card'))) : [];
    for (const node of coveredLegacy) node.hidden = true;
    unsubscribeLocale = subscribeLocale(() => {
      core.documents.clear();
      render();
      void loadCore();
    });
    render();
    void loadCore();
    void loadDeck();
  }

  function unmount() {
    generation++;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    readAloud?.destroy?.();
    readAloud = null;
    for (const node of coveredLegacy) node.hidden = false;
    coveredLegacy = [];
    if (host) host.innerHTML = '';
    host = null;
    document_ = null;
  }

  return { mount, unmount };
}
