/**
 * PRACTICE-UI-01 (MIRROR-B1PREP-01 slice B) — Prüfungsteile and Hören tiles.
 *
 * WHAT THIS IS. One index of the written examination: a card per subtest with its points and time, and ONE
 * TILE PER PART with released content — official label, items, points, the listening play rule for the
 * hearing parts, and the learner's OWN count "x Aufgaben geübt · y richtig". No per-set cards: the section
 * pages that list every set and version as its own card are what this slice replaces.
 *
 * HÖREN IS THE SAME VIEW, FILTERED. The module reads the host it was mounted into (`part-index-host` = all
 * parts, `hoeren-host` = HV only). One implementation, two entry points; no second renderer.
 *
 * WHAT IT REFUSES TO DO. It never turns a count into a probability, a forecast or a readiness figure (D22):
 * the own-count is `attempts` and `correct` from the practice evidence and nothing else. It never invents an
 * exam fact: every number on a tile comes from `readExamParts()`, and a fact that source cannot answer
 * renders as "Angabe folgt" — never as a plausible-looking value, and never as zero.
 *
 * THE ONE DATA SEAM. `readExamParts(api)` is the ONLY place that decides where the per-part facts come from:
 *   - `api.examParts.list()` — the normalised payload slice B asks the server for (per part: family,
 *     section, part, itemCount/items, points, playback {practice, mock}).
 *   - `EXAM_PARTS` — the documented fallback, transcribed from the two authoritative files in this
 *     repository and cited line by line below. It carries no learner data.
 * The surface above the seam (model, markup, view) is identical either way, so repointing it is one function.
 *
 * COUNTS. `readPracticeCounts(api)` prefers `progress.parts[]` (per part, from `item_evidence.family`).
 * Without it, the per-section counts are used for the SUBTEST CARDS only. A per-section number is never
 * attributed to a part: `buildIndexModel` leaves that tile's own-count UNKNOWN ("Angabe folgt"), which is a
 * different statement from "not practised yet" and is kept different on purpose.
 *
 * THE TILE OPENS THE PART (slice C). Each tile carries ONE control, `Teil üben`, which dynamic-imports
 * `./part-runner.js` and mounts it into the SAME host — the index is not a route and the runner is not a
 * second route, so the shell, its route table and its ctx are untouched. The runner's "Zur Auswahl" calls
 * back into this view's `mount`, so the index returns with fresh counts. The tile stays a per-PART
 * control: no set id, no version and no per-set card appears anywhere (the check pins that).
 */
import { getLocale, subscribeLocale } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';

/** Shell keys for the four subtests — the same mapping the shell uses (app.js SECTION_NAMES). */
const SECTION_KEYS = Object.freeze({ LV: 'm002', SB: 'm003', HV: 'm004', writing: 'm005' });
/** The written examination's four subtests with their official points and the timed block they run in. */
export const SUBTESTS = Object.freeze([
  Object.freeze({ id: 'LV', points: 75, block: 'lv-sb-90' }),
  Object.freeze({ id: 'SB', points: 30, block: 'lv-sb-90' }),
  Object.freeze({ id: 'HV', points: 75, block: 'hv-30' }),
  Object.freeze({ id: 'writing', points: 45, block: 'writing-30' }),
]);
/** Minutes per timed block: the canonical `timeGroups` plus the writing task's own 30 minutes. */
export const BLOCK_MINUTES = Object.freeze({ 'lv-sb-90': 90, 'hv-30': 30, 'writing-30': 30 });
/** The listening play rule as the package states it, per part. */
export const PLAYBACK = Object.freeze({
  HV1: Object.freeze({ practice: 1, mock: 1 }),
  HV2: Object.freeze({ practice: 1, mock: 2 }),
  HV3: Object.freeze({ practice: 1, mock: 2 }),
});
/** The eight parts, in examination order. */
export const PART_ORDER = Object.freeze(['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3']);

/**
 * The documented fallback for `api.examParts.list()`.
 *
 * SOURCES, per fact:
 *  - items — `content/exams/telc-deutsch-b1/listening-package.json`, blueprint.sections[].parts[].itemCount
 *    (LV1 5, LV2 5, LV3 10, SB1 10, SB2 10, HV1 5, HV2 10, HV3 5). The same payload is what
 *    `server/owned-postgres/packages.mjs` reads out of `exam_blueprint.payload` to validate a form.
 *  - points per part — `docs/exam/telc-b1-written-draft.json`, sections[].parts[].points, with
 *    `section.points.rawIsPerPart` true (lv-t1..lv-t3 = 25, sb-t1/sb-t2 = 15, hv-t1..hv-t3 = 25).
 *    Corroborated by `docs/exam/TELC-B1-SOURCES.md` §4.
 *  - playback — the same listening package, parts[].playback {practice, mock}.
 * This table is the ONLY duplication of exam facts in this module, it is cited, and it is meant to be
 * deleted the moment the server serves the same numbers (see the implementation note, "unverified").
 */
export const EXAM_PARTS = Object.freeze([
  Object.freeze({ family: 'LV1', section: 'LV', part: 1, itemCount: 5, points: 25, playback: null }),
  Object.freeze({ family: 'LV2', section: 'LV', part: 2, itemCount: 5, points: 25, playback: null }),
  Object.freeze({ family: 'LV3', section: 'LV', part: 3, itemCount: 10, points: 25, playback: null }),
  Object.freeze({ family: 'SB1', section: 'SB', part: 1, itemCount: 10, points: 15, playback: null }),
  Object.freeze({ family: 'SB2', section: 'SB', part: 2, itemCount: 10, points: 15, playback: null }),
  Object.freeze({ family: 'HV1', section: 'HV', part: 1, itemCount: 5, points: 25, playback: PLAYBACK.HV1 }),
  Object.freeze({ family: 'HV2', section: 'HV', part: 2, itemCount: 10, points: 25, playback: PLAYBACK.HV2 }),
  Object.freeze({ family: 'HV3', section: 'HV', part: 3, itemCount: 5, points: 25, playback: PLAYBACK.HV3 }),
]);

/** Where each section's practice lives today; slice C replaces the destination with the part runner. */
export const SECTION_ROUTES = Object.freeze({ LV: '#/lesen', SB: '#/sprachbausteine', HV: '#/hoeren', writing: '#/schreiben' });

const defaultEsc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const countOrNull = value => (Number.isInteger(value) && value >= 0 ? value : null);
const itemCountOf = part => countOrNull(part?.itemCount ?? part?.item_count ?? part?.items);
const playbackOf = part => {
  const playback = part?.playback;
  const practice = countOrNull(playback?.practice);
  if (!practice) return null;
  return { practice, mock: countOrNull(playback?.mock) };
};

/** Which parts this host shows: `hoeren-host` filters to HV; any other host shows every released part. */
export function partFilterForHost(host) {
  const id = typeof host?.id === 'string' ? host.id : '';
  return id === 'hoeren-host' ? 'HV' : null;
}

/** The per-part facts: the server payload when it exists, the cited table otherwise. */
export async function readExamParts(api) {
  if (typeof api?.examParts?.list === 'function') {
    let response;
    try { response = await api.examParts.list(); } catch { response = { ok: false, status: 0 }; }
    const parts = Array.isArray(response?.data?.parts) ? response.data.parts.filter(part => typeof part?.family === 'string') : [];
    if (response?.ok && parts.length) {
      /*
       * REVIEW-PRACTICE-UI-01 F1. The published blueprint carries family, itemCount, interaction and
       * mediaRequired — it has no `part` number and no `points`, so those arrive as null. Replacing the
       * cited table with that shape would drop "Teil 1" from a heading and print "Angabe folgt" where the
       * documented source has a number. A served value therefore wins only where it is actually non-null,
       * and every field it cannot answer keeps the cited one. This is what makes amendment A6's upgrade
       * path ("move the numbers into the blueprint later, no client edit") true.
       */
      const documented = new Map(EXAM_PARTS.map(part => [part.family, part]));
      const merged = parts.map((part) => {
        const fallback = documented.get(part.family) || {};
        const pref = (key) => (part[key] === null || part[key] === undefined ? (fallback[key] ?? null) : part[key]);
        return { ...part, part: pref('part'), itemCount: pref('itemCount'), points: pref('points'), playback: pref('playback') };
      });
      return { source: 'payload', parts: merged, error: null };
    }
    return { source: 'unavailable', parts: [], error: response?.error ?? 'exam_parts_unavailable' };
  }
  return { source: 'documented', parts: EXAM_PARTS.map(part => ({ ...part })), error: null };
}

/** The learner's own counts, per part when the server can attribute them, otherwise per section. */
export async function readPracticeCounts(api) {
  if (typeof api?.practice?.progress !== 'function') return { source: 'unavailable', parts: null, sections: null };
  let response;
  try { response = await api.practice.progress(); } catch { response = { ok: false, status: 0 }; }
  if (!response?.ok) return { source: 'unavailable', parts: null, sections: null };
  const rows = (value, key) => (Array.isArray(value)
    ? new Map(value.filter(row => typeof row?.[key] === 'string')
      .map(row => [row[key], { attempts: countOrNull(row.attempts) ?? 0, correct: countOrNull(row.correct) ?? 0 }]))
    : null);
  const parts = rows(response.data?.parts, 'family');
  const sections = rows(response.data?.sections, 'section');
  return { source: parts ? 'parts' : sections ? 'sections' : 'unavailable', parts, sections };
}

/** Join both sources into the model the markup renders. Pure, so the check needs no api at all. */
export function buildIndexModel({ parts = [], partsSource = null, counts = { source: 'unavailable', parts: null, sections: null }, filter = null, error = null } = {}) {
  const byFamily = new Map(parts.filter(part => typeof part?.family === 'string').map(part => [part.family, part]));
  const tiles = PART_ORDER
    .map(family => byFamily.get(family))
    .filter(part => Boolean(part))
    .filter(part => !filter || part.section === filter)
    .map(part => ({
      family: part.family,
      section: part.section,
      part: countOrNull(part.part) ?? null,
      items: itemCountOf(part),
      points: countOrNull(part.points),
      playback: playbackOf(part),
      /* Per part or unknown — never a section number on a part tile. */
      own: counts.parts?.get(part.family) ?? null,
    }));
  const sections = SUBTESTS
    .filter(subtest => !filter || subtest.id === filter)
    .map(subtest => ({ ...subtest, minutes: BLOCK_MINUTES[subtest.block] ?? null, own: counts.sections?.get(subtest.id) ?? null }));
  return { error, filter, tiles, sections, countsSource: counts.source, partsSource: partsSource ?? (tiles.length ? 'payload' : 'unavailable') };
}

/* --------------------------------------------------------------------------------- markup */

function languageAttributes(examLanguage) {
  return ' lang="' + defaultEsc(examLanguage || 'und') + '" dir="' + (examLanguage === 'ar' ? 'rtl' : 'ltr') + '"';
}

/** Shared by the view and the check, so the check reads exactly the text the learner will read. */
export function indexMarkup({ esc = defaultEsc, uiText = key => key, examLanguage = 'und', model = {} } = {}) {
  const locale = getLocale();
  const t = (key, parameters = {}) => esc(pt(key, parameters, locale));
  const shell = key => esc(uiText(key));
  const rtl = locale === 'ar';
  const sectionName = code => (SECTION_KEYS[code] ? shell(SECTION_KEYS[code]) : esc(String(code ?? '')));
  const source = model.partsSource ?? 'unavailable';

  const cards = (model.sections ?? []).map(section => '<article class="card stack part-index-card" data-subtest="' + esc(section.id) + '">'
    + '<div class="card-head"><h2>' + sectionName(section.id) + '</h2>'
    + '<span class="chip">' + (section.points === null ? t('partIndexPending') : t('partIndexPoints') + ' ' + esc(String(section.points))) + '</span></div>'
    + '<p class="small muted">' + (section.minutes === null ? t('partIndexPending')
      : t('minutes', { minutes: section.minutes }) + (section.block === 'lv-sb-90' ? ' · ' + t('partIndexSharedBlock') : '')) + '</p>'
    + (section.own ? '<p class="small muted" data-subtest-count="' + section.own.attempts + '/' + section.own.correct + '">' + t('partPractised', { practised: section.own.attempts, correct: section.own.correct }) + '</p>' : '')
    + '<p><a class="btn" href="' + esc(SECTION_ROUTES[section.id] ?? '#/pruefungsteile') + '" data-subtest-route="' + esc(SECTION_ROUTES[section.id] ?? '') + '">' + t('partIndexOpen') + '</a></p>'
    + '</article>').join('');

  const tiles = (model.tiles ?? []).map(tile => {
    const facts = [
      tile.items === null ? t('partIndexPending') : t('tasks', { count: tile.items }),
      tile.points === null ? t('partIndexPending') : t('partIndexPoints') + ' ' + esc(String(tile.points)),
    ];
    if (tile.playback) facts.push(t('partPlays', { plays: tile.playback.practice }));
    const own = tile.own === null
      /* Unknown is not zero: without per-part evidence the tile says so rather than claiming "not practised". */
      ? '<p class="part-index-own muted" data-own-count="unknown">' + t('partIndexPending') + '</p>'
      : tile.own.attempts === 0
        ? '<p class="part-index-own muted" data-own-count="none" data-attempts="0" data-correct="0">' + t('partNotPractised') + '</p>'
        : '<p class="part-index-own" data-own-count="' + tile.own.attempts + '/' + tile.own.correct + '" data-attempts="' + tile.own.attempts + '" data-correct="' + tile.own.correct + '">'
          + t('partPractised', { practised: tile.own.attempts, correct: tile.own.correct }) + '</p>';
    return '<li class="part-index-tile" data-part="' + esc(tile.family) + '" data-section="' + esc(tile.section) + '" data-part-number="' + esc(String(tile.part)) + '"'
      + (tile.playback ? ' data-plays="' + esc(String(tile.playback.practice)) + '"' : '')
      + ' data-items="' + esc(tile.items === null ? '' : String(tile.items)) + '" data-points="' + esc(tile.points === null ? '' : String(tile.points)) + '">'
      + '<p class="kicker">' + esc(tile.family) + '</p>'
      + '<h3' + languageAttributes(examLanguage) + '>' + sectionName(tile.section) + ' · ' + t('part', { part: tile.part }) + '</h3>'
      + '<p class="small muted part-index-facts">' + facts.join(' · ') + '</p>'
      + own
      + '<p class="part-index-open-row"><button type="button" class="btn" data-part-open="' + esc(tile.family) + '">' + t('partRunnerOpen') + '</button></p>'
      + '</li>';
  }).join('');

  return '<section class="part-index" data-part-index data-parts-source="' + esc(source) + '" data-counts-source="' + esc(model.countsSource ?? 'unavailable') + '"'
    + ' lang="' + defaultEsc(locale) + '" dir="' + (rtl ? 'rtl' : 'ltr') + '" aria-labelledby="part-index-title">'
    + '<header class="page-head"><div><h1 id="part-index-title">' + (model.filter === 'HV' ? t('partIndexListeningTitle') : t('partIndexTitle')) + '</h1>'
    + '<p class="part-index-lead">' + t('partIndexLead') + '</p></div></header>'
    + '<section class="part-index-subtests" aria-label="' + t('partIndexSubtests') + '">' + cards + '</section>'
    + (model.error ? '<p class="err" role="alert" data-load-error>' + t('partIndexFailed') + '</p>' : '')
    + '<section class="stack part-index-parts" aria-labelledby="part-index-parts-title">'
    + '<h2 id="part-index-parts-title">' + (model.filter === 'HV' ? t('partIndexListeningParts') : t('partIndexParts')) + '</h2>'
    + (tiles ? '<ul class="part-index-grid">' + tiles + '</ul>' : '<p class="card" data-parts-empty>' + t('partIndexEmpty') + '</p>')
    + '</section></section>';
}

/* ----------------------------------------------------------------------------------- view */

/**
 * The frozen §4.2 interface: `createPartIndexView(ctx)` → `{ mount(host), unmount() }`.
 * `ctx` is `{ api, uiText, esc, language, navigate, state, examLanguage }`. `mount` returns a promise the
 * shell may ignore and never throws — an unreachable payload degrades inside the host.
 */
export function createPartIndexView(ctx = {}) {
  const esc = typeof ctx.esc === 'function' ? ctx.esc : defaultEsc;
  const uiText = typeof ctx.uiText === 'function' ? ctx.uiText : key => key;
  let host = null;
  let unsubscribe = null;
  let generation = 0;
  let model = { error: null, filter: null, tiles: [], sections: [], countsSource: 'unavailable', partsSource: 'unavailable' };
  let failed = false;
  /* The served per-part facts are kept so the runner does not have to read `/api/v1/exam-parts` again. */
  let parts = [];
  /* The open part runner, when a tile has been opened; the index is composed out, not navigated away. */
  let runner = null;
  function render() {
    /* While a part is open, the runner owns these bytes — including on a locale change. */
    if (!host || runner) return;
    host.innerHTML = indexMarkup({ esc, uiText, examLanguage: ctx.examLanguage || 'und', model: { ...model, error: failed ? 'failed' : null } });
  }
  async function load() {
    const ticket = ++generation;
    const filter = partFilterForHost(host);
    const [partsResult, countsResult] = await Promise.all([readExamParts(ctx.api), readPracticeCounts(ctx.api)]);
    if (ticket !== generation) return false;
    failed = partsResult.source === 'unavailable';
    parts = Array.isArray(partsResult.parts) ? partsResult.parts : [];
    model = buildIndexModel({ parts, partsSource: partsResult.source, counts: countsResult, filter, error: partsResult.error });
    render();
    return true;
  }
  /** Close the open runner, if any. Idempotent. */
  function closeRunner() {
    const open = runner;
    runner = null;
    if (open) { try { open.unmount(); } catch { /* a failed teardown must not block the index */ } }
  }
  /**
   * Open one part in THIS host: dynamic import (the shell's own degradation pattern), then compose.
   * Returns false when the module cannot be loaded or mounted, so the index stays on screen instead of
   * blank — the same rule the shell applies to every §4.2 module.
   */
  async function openPart(family, target = host) {
    if (!target || typeof family !== 'string' || !family) return false;
    closeRunner();
    let module;
    try { module = await import('./part-runner.js'); } catch { return false; }
    if (typeof module.createPartRunnerView !== 'function') return false;
    const view = module.createPartRunnerView({
      ...ctx,
      family,
      examParts: parts,
      /* "Zur Auswahl": the runner clears the host, then the index re-mounts into it. */
      onBack: () => { closeRunner(); return view$self.mount(target); },
    });
    runner = view;
    try {
      await view.mount(target);
    } catch {
      closeRunner();
      render();
      return false;
    }
    return true;
  }
  const view$self = {
    async mount(target) {
      if (!target) return false;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      host = target;
      generation++;
      closeRunner();
      model = { ...model, filter: partFilterForHost(host), error: null };
      render();
      host.onclick = (event) => {
        const button = event.target.closest?.('[data-part-open]');
        if (button) void openPart(button.dataset.partOpen);
      };
      unsubscribe = typeof subscribeLocale === 'function' ? subscribeLocale(() => render()) : null;
      return load();
    },
    unmount() {
      generation++;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      closeRunner();
      if (host) { host.onclick = null; host.innerHTML = ''; }
      host = null;
    },
  };
  /* §4.2 is frozen: the factory returns `{ mount, unmount }` and nothing else — `part-index-check` leg 8
     pins exactly that. The tile's open action is therefore reachable through the rendered control
     (`[data-part-open]`), which is the path the learner takes anyway. */
  return view$self;
}
