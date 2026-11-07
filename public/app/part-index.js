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
 *   - `EXAM_PARTS` — a cited telc-only point/part-label supplement. It never creates a tile, a time or a
 *     playback rule, and is never applied to another exam or to an unavailable response.
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
const SECTION_KEYS = Object.freeze({ LV: 'm002', SB: 'm003', HV: 'm004', writing: 'm005', SA: 'm005' });
/** Cited telc Deutsch B1 points only; section membership and times always come from the served package. */
export const SUBTESTS = Object.freeze([
  Object.freeze({ id: 'LV', points: 75, block: 'lv-sb-90' }),
  Object.freeze({ id: 'SB', points: 30, block: 'lv-sb-90' }),
  Object.freeze({ id: 'HV', points: 75, block: 'hv-30' }),
  Object.freeze({ id: 'writing', points: 45, block: 'writing-30' }),
]);
/** The listening play rule as the package states it, per part. */
export const PLAYBACK = Object.freeze({
  HV1: Object.freeze({ practice: 1, mock: 1 }),
  HV2: Object.freeze({ practice: 1, mock: 2 }),
  HV3: Object.freeze({ practice: 1, mock: 2 }),
});
/** The telc families with cited skill labels. This never determines rendered part order. */
export const PART_ORDER = Object.freeze(['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3']);

/**
 * The documented telc-only supplement to a successful, identified `api.examParts.list()` payload.
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
export const SECTION_ROUTES = Object.freeze({ LV: '#/lesen', SB: '#/sprachbausteine', HV: '#/hoeren', writing: '#/schreiben', SA: '#/schreiben' });

const defaultEsc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const countOrNull = value => (Number.isInteger(value) && value >= 0 ? value : null);
const itemCountOf = part => countOrNull(part?.itemCount ?? part?.item_count ?? part?.items);
/*
 * REVIEW-PRACTICE-MEDIA F2, decided by the Lead. The tile must show the rule the EXAM applies, not the
 * `practice` allowance, because Ron's decision 3 makes practice listening follow the exam play rule and
 * that is what the runner enforces and displays. On HV2/HV3 the two numbers differ (practice 1, exam 2),
 * so showing `practice` told the learner one play while the server allowed two. `exam` is the number the
 * tile renders, `practice` is kept because it is part of the served payload and a future practice-specific
 * rule would have to come from the blueprint, not be invented here.
 */
const playbackOf = part => {
  const playback = part?.playback;
  const exam = countOrNull(playback?.mock);
  const practice = countOrNull(playback?.practice);
  if (!exam && !practice) return null;
  return { exam: exam ?? practice, practice };
};

/** Which parts this host shows: `hoeren-host` filters to HV; any other host shows every released part. */
export function partFilterForHost(host) {
  const id = typeof host?.id === 'string' ? host.id : '';
  return ({ 'hoeren-host': 'HV', 'lesen-host': 'LV', 'sprachbausteine-host': 'SB' })[id] ?? null;
}

/** Read one preparation-scoped release. Missing data never selects a default exam. */
export async function readExamParts(api, expectedExamId = null) {
  if (typeof api?.examParts?.list === 'function') {
    let response;
    try { response = await api.examParts.list(); } catch { response = { ok: false, status: 0 }; }
    const parts = Array.isArray(response?.data?.parts) ? response.data.parts.filter(part => typeof part?.family === 'string') : [];
    const examId = typeof response?.data?.exam_id === 'string' ? response.data.exam_id : null;
    if (response?.ok && Array.isArray(response?.data?.parts)
      && (!expectedExamId || examId === expectedExamId) && (examId || parts.length === 0)) {
      const documented = new Map((examId === 'telc-deutsch-b1' ? EXAM_PARTS : []).map(part => [part.family, part]));
      const merged = parts.map((part) => {
        const fallback = documented.get(part.family) || {};
        const pref = (key) => (part[key] === null || part[key] === undefined ? (fallback[key] ?? null) : part[key]);
        return { ...part, part: pref('part'), points: pref('points') };
      });
      return { source: 'payload', examId, parts: merged,
        sections: examId && Array.isArray(response.data.sections) ? response.data.sections : [],
        timeGroups: examId && Array.isArray(response.data.time_groups) ? response.data.time_groups : [], error: null };
    }
    return { source: 'unavailable', parts: [], error: response?.error ?? 'exam_parts_unavailable' };
  }
  return { source: 'unavailable', parts: [], error: 'exam_parts_unavailable' };
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
export function buildIndexModel({ examId = null, parts = [], sections: declaredSections = [], timeGroups = [], partsSource = null, counts = { source: 'unavailable', parts: null, sections: null }, filter = null, error = null } = {}) {
  const tiles = parts.filter(part => typeof part?.family === 'string')
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
  const sectionFacts = declaredSections.length ? declaredSections : [...new Set(parts.map(part => part.section))].map(id => ({ id }));
  const sections = sectionFacts
    .filter(subtest => !filter || subtest.id === filter)
    .map(subtest => {
      const group = timeGroups.find(group => group.id === subtest.timeGroup && group.sections?.includes(subtest.id));
      const seconds = countOrNull(group?.seconds);
      const supplement = examId === 'telc-deutsch-b1' ? SUBTESTS.find(value => value.id === subtest.id) : null;
      return { ...subtest, points: countOrNull(subtest.points) ?? supplement?.points ?? null,
        minutes: seconds > 0 ? seconds / 60 : null, shared: group?.sections?.length > 1,
        own: counts.sections?.get(subtest.id) ?? null };
    });
  return { examId, error, filter, tiles, sections, countsSource: counts.source, partsSource: partsSource ?? (tiles.length ? 'payload' : 'unavailable') };
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
      : t('minutes', { minutes: section.minutes }) + (section.shared ? ' · ' + t('partIndexSharedBlock') : '')) + '</p>'
    + (section.own ? '<p class="small muted" data-subtest-count="' + section.own.attempts + '/' + section.own.correct + '">' + t('partPractised', { practised: section.own.attempts, correct: section.own.correct }) + '</p>' : '')
    + '<p><a class="btn" href="' + esc(SECTION_ROUTES[section.id] ?? '#/pruefungsteile') + '" data-subtest-route="' + esc(SECTION_ROUTES[section.id] ?? '') + '">' + t('partIndexOpen') + '</a></p>'
    + '</article>').join('');

  const tiles = (model.tiles ?? []).map(tile => {
    const facts = [
      tile.items === null ? t('partIndexPending') : t('tasks', { count: tile.items }),
      tile.points === null ? t('partIndexPending') : t('partIndexPoints') + ' ' + esc(String(tile.points)),
    ];
    if (tile.playback) facts.push(t('partPlays', { plays: tile.playback.exam }));
    const own = tile.own === null
      /* Unknown is not zero: without per-part evidence the tile says so rather than claiming "not practised". */
      ? '<p class="part-index-own muted" data-own-count="unknown">' + t('partIndexPending') + '</p>'
      : tile.own.attempts === 0
        ? '<p class="part-index-own muted" data-own-count="none" data-attempts="0" data-correct="0">' + t('partNotPractised') + '</p>'
        : '<p class="part-index-own" data-own-count="' + tile.own.attempts + '/' + tile.own.correct + '" data-attempts="' + tile.own.attempts + '" data-correct="' + tile.own.correct + '">'
          + t('partPractised', { practised: tile.own.attempts, correct: tile.own.correct }) + '</p>';
    return '<li class="part-index-tile" data-part="' + esc(tile.family) + '" data-section="' + esc(tile.section) + '" data-part-number="' + esc(String(tile.part)) + '"'
      + (tile.playback ? ' data-plays="' + esc(String(tile.playback.exam)) + '"' : '')
      + ' data-items="' + esc(tile.items === null ? '' : String(tile.items)) + '" data-points="' + esc(tile.points === null ? '' : String(tile.points)) + '">'
      + '<h3>' + (tile.part === null ? t('partIndexPending') : t('part', { part: tile.part })) + ' · '
      + (model.examId === 'telc-deutsch-b1' && PART_ORDER.includes(tile.family) ? t('partSkill' + tile.family) : sectionName(tile.section)) + '</h3>'
      + '<p class="small muted part-index-facts">' + facts.join(' · ') + '</p>'
      + own
      + '<p class="part-index-open-row"><button type="button" class="btn" data-part-open="' + esc(tile.family) + '">' + t('partRunnerOpen') + '</button></p>'
      + '</li>';
  }).join('');

  return '<section class="part-index" data-part-index data-parts-source="' + esc(source) + '" data-counts-source="' + esc(model.countsSource ?? 'unavailable') + '"'
    + ' lang="' + defaultEsc(locale) + '" dir="' + (rtl ? 'rtl' : 'ltr') + '" aria-labelledby="part-index-title">'
    + '<header class="page-head"><div><h1 id="part-index-title">' + (model.filter ? sectionName(model.filter) : t('partIndexTitle')) + '</h1>'
    + '<p class="part-index-lead">' + t('partIndexLead') + '</p></div></header>'
    + (model.filter ? '' : '<section class="part-index-subtests" aria-label="' + t('partIndexSubtests') + '">' + cards + '</section>')
    + (model.error ? '<p class="err" role="alert" data-load-error>' + t('partIndexFailed') + '</p>'
      + '<p><button type="button" class="btn" data-part-reload>' + t('ui64') + '</button></p>' : '')
    + '<section class="stack part-index-parts" aria-labelledby="part-index-parts-title">'
    + '<h2 id="part-index-parts-title">' + t('partIndexParts') + '</h2>'
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
  let opening = 0;
  function render() {
    /* While a part is open, the runner owns these bytes — including on a locale change. */
    if (!host || runner) return;
    ctx.onPartIdentity?.(null, null);
    host.innerHTML = indexMarkup({ esc, uiText, examLanguage: ctx.examLanguage || 'und', model: { ...model, error: failed ? 'failed' : null } });
  }
  async function load() {
    const ticket = ++generation;
    const preparationId = ctx.state?.preparation?.id;
    const examId = ctx.state?.preparation?.exam_id ?? null;
    const filter = partFilterForHost(host);
    const [partsResult, countsResult] = await Promise.all([readExamParts(ctx.api, examId), readPracticeCounts(ctx.api)]);
    if (ticket !== generation || preparationId !== ctx.state?.preparation?.id || examId !== (ctx.state?.preparation?.exam_id ?? null)) return false;
    failed = partsResult.source === 'unavailable';
    parts = Array.isArray(partsResult.parts) ? partsResult.parts : [];
    model = buildIndexModel({ ...partsResult, parts, partsSource: partsResult.source, counts: countsResult, filter });
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
    const ticket = ++opening;
    closeRunner();
    let module;
    try { module = await import('./part-runner.js'); } catch { return false; }
    if (ticket !== opening || target !== host) return false;
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
      if (runner === view) { closeRunner(); render(); }
      return false;
    }
    return ticket === opening && runner === view;
  }
  const view$self = {
    canLeave() { return runner?.canLeave?.() ?? true; },
    async mount(target) {
      if (!target) return false;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      host = target;
      opening++;
      generation++;
      closeRunner();
      model = { filter: partFilterForHost(host), error: null, tiles: [], sections: [], countsSource: 'unavailable', partsSource: 'unavailable' };
      failed = false;
      render();
      host.onclick = (event) => {
        if (event.target.closest?.('[data-part-reload]')) { void load(); return; }
        const button = event.target.closest?.('[data-part-open]');
        if (button) void openPart(button.dataset.partOpen);
      };
      unsubscribe = typeof subscribeLocale === 'function' ? subscribeLocale(() => render()) : null;
      return load();
    },
    unmount() {
      opening++;
      generation++;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      closeRunner();
      if (host) { host.onclick = null; host.innerHTML = ''; }
      host = null;
    },
  };
  /* The additive canLeave contract delegates dirty-pick protection to the currently mounted runner.
     Part opening remains reachable through the learner's rendered control. */
  return view$self;
}
