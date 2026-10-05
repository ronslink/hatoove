/**
 * MOCK-01 (MIRROR-B1PREP-01 slice D) — the Probeprüfung intro page.
 *
 * WHAT IT IS. One page: what the written mock exam contains, the official pass rule stated as a FACT, the
 * note that speaking is not part of it, ONE button that starts the existing `complete_supported_written`
 * run through the existing api client, and the saved runs below it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *  - It predicts nothing (D22). No readiness, no forecast, no probability, no chance-of-passing card. The
 *    official threshold is quoted as a fact about the exam; whether THIS learner passes is not a claim
 *    this page may make, and the pilot cannot make it at all: the oral part is unassessed, so no overall
 *    verdict exists (`docs/exam/TELC-B1-SOURCES.md` §4.1, the limitation recorded for this pilot).
 *  - It does not build a second run engine. It calls `api.mock.forms()` and `api.mock.start()` exactly as
 *    `public/app/mock.js` does, with the same idempotent `eventId` reuse on retry, and hands the created
 *    run to the shell as `#/lauf/<id>` — the route `mock.showRun` already owns.
 *  - It does not invent a second history surface. It reads `api.mock.list()` (GET /api/v1/mock-runs) and
 *    labels every row with the exported `mockScopeLabel` / `mockReviewLabel` / `mockWritingStatus` helpers
 *    of `public/app/mock.js` and `reviewHistoryNotice` of `public/app/review-labels.js`.
 *
 * LOCALE. All interface text comes from the practice catalogue, and the two label helpers of `mock.js`
 * resolve the locale themselves, so this module renders from the locale runtime (`getLocale()`) and
 * re-renders on `subscribeLocale`. `ctx.language` is the shell's copy of that same value.
 *
 * HEADING. The shell's topbar and sidebar already label the route "Probeprüfung" (NAV-01 shell key m400),
 * so this module does not repeat that word: its own `h1` names the subject these facts belong to — the
 * WRITTEN mock exam — and every other heading on the page is an `h2` beneath it.
 *
 * SUBTOTALS are the verified telc B1 written weighting (Leseverstehen 75 + Sprachbausteine 30 = 105,
 * Hörverstehen 75, Schriftlicher Ausdruck 45 → 225 of 300) and the canonical `timeGroups` of
 * `content/exams/telc-deutsch-b1` (90 + 30 + 30 minutes). Nothing here is computed from the learner.
 */
import { getLocale, subscribeLocale, formatDate } from '../assets/i18n/core.js';
import { pt } from '../assets/i18n/practice-messages.js';
import { mockReviewLabel, mockScopeLabel, mockWritingStatus } from './mock.js';
import { reviewHistoryNotice } from './review-labels.js';

/** The only scope this page starts: today's `complete_supported_written` form. */
export const MOCK_INTRO_SCOPE = 'complete_supported_written';
/** The written blocks of telc Deutsch B1, in exam order, with their official minutes and points. */
export const MOCK_INTRO_BLOCKS = Object.freeze([
  Object.freeze({ id: 'written', label: 'mockIntroBlockWritten', minutes: 90, points: 105 }),
  Object.freeze({ id: 'listening', label: 'mockIntroBlockListening', minutes: 30, points: 75 }),
  Object.freeze({ id: 'writing', label: 'mockIntroBlockWriting', minutes: 30, points: 45 }),
]);
export const MOCK_INTRO_MINUTES = 150;
export const MOCK_INTRO_WRITTEN_POINTS = 225;
export const MOCK_INTRO_ORAL_POINTS = 75;
export const MOCK_INTRO_TOTAL_POINTS = 300;
/** Selectors the shell does not need to know about, but the click handler and the checks do. */
const START_ATTRIBUTE = 'data-mock-intro-start';
const RELOAD_ATTRIBUTE = 'data-mock-intro-reload';
const START_STATUS_ID = 'mock-intro-start-state';
const START_NOTE_ID = 'mock-intro-start-note';

const defaultEsc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const defaultEventId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'mock-intro-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The one form this page may start, or null. Pure, so the rule is testable without a server. */
export function completeForm(forms, scope = MOCK_INTRO_SCOPE) {
  return (Array.isArray(forms) ? forms : []).find(form => form?.scope === scope) || null;
}

/**
 * One start control, and the request behind it is today's unchanged one:
 * `POST /api/v1/mock-runs` `{ formId, formVersion, releaseVersion, eventId }`.
 *
 * The `eventId` is minted once per form binding and reused until the server confirms the run, so a lost
 * acknowledgement can never create a second run — the same rule `mock.js` applies to its start controls.
 */
export function createMockStarter({ api = null, navigate = null, eventId = defaultEventId, scope = MOCK_INTRO_SCOPE } = {}) {
  let operation = null;
  async function forms() {
    if (typeof api?.mock?.forms !== 'function') return { ok: false, reason: 'unavailable', status: 0, form: null };
    let response;
    try { response = await api.mock.forms(); } catch { response = { ok: false, status: 0 }; }
    if (!response?.ok) return { ok: false, reason: 'forms', status: response?.status ?? 0, form: null };
    return { ok: true, reason: null, status: response.status, form: completeForm(response.data?.forms, scope) };
  }
  async function history() {
    if (typeof api?.mock?.list !== 'function') return { ok: false, reason: 'unavailable', status: 0, runs: null };
    let response;
    try { response = await api.mock.list(); } catch { response = { ok: false, status: 0 }; }
    if (!response?.ok) return { ok: false, reason: 'history', status: response?.status ?? 0, runs: null };
    return { ok: true, reason: null, status: response.status, runs: Array.isArray(response.data?.runs) ? response.data.runs : [] };
  }
  async function start(form) {
    if (!form) return { ok: false, reason: 'no_form' };
    if (typeof api?.mock?.start !== 'function') return { ok: false, reason: 'unavailable' };
    const binding = { formId: form.form_id, formVersion: form.version, releaseVersion: form.release_version };
    if (!operation || !equal(operation.binding, binding)) operation = { binding, body: { ...binding, eventId: eventId() } };
    let response;
    try { response = await api.mock.start(operation.body); } catch { response = { ok: false, status: 0 }; }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : 0;
      const code = response?.error;
      const reason = status === 401 || ['session_expired', 'account_changed', 'stale_session'].includes(code) ? 'session'
        : code === 'preparation_archived' ? 'archived' : 'failed';
      return { ok: false, reason, status, error: code ?? null };
    }
    operation = null;
    const runId = typeof response.data?.id === 'string' && response.data.id ? response.data.id : null;
    if (runId) {
      const href = '#/lauf/' + encodeURIComponent(runId);
      if (typeof navigate === 'function') navigate(href);
      else if (typeof location !== 'undefined' && location) location.hash = href;
    }
    return { ok: true, reason: null, status: response.status, runId, run: response.data ?? null };
  }
  return { forms, history, start };
}

/** German exam content inside a possibly RTL interface stays an explicit LTR island. */
function examAttributes(examLanguage) {
  return ' lang="' + defaultEsc(examLanguage || 'und') + '" dir="' + (examLanguage === 'ar' ? 'rtl' : 'ltr') + '"';
}

function statusKey(startPhase) {
  return ({ starting: 'startingRun', failed: 'mockIntroStartFailed', session: 'mockIntroStartSession' })[startPhase] || '';
}

/**
 * The whole page as one string. `model` is the load/start state, so the markup stays a pure function of
 * what the module knows — which is why the rendered-text check needs no DOM.
 */
export function introMarkup({ esc = defaultEsc, uiText = key => key, examLanguage = 'und', model = {} } = {}) {
  const locale = getLocale();
  const t = (key, parameters = {}) => esc(pt(key, parameters, locale));
  const rtl = locale === 'ar';
  const rows = MOCK_INTRO_BLOCKS.map(block => '<tr data-mock-intro-block="' + block.id + '" data-minutes="' + block.minutes + '" data-points="' + block.points + '">'
    + '<th scope="row">' + t(block.label) + '</th>'
    + '<td data-mock-intro-time>' + t('minutes', { minutes: block.minutes }) + '</td>'
    + '<td class="mock-intro-points" data-mock-intro-points>' + esc(String(block.points)) + '</td></tr>').join('');
  const blocks = '<section class="card stack mock-intro-blocks" aria-labelledby="mock-intro-blocks-title">'
    + '<h2 id="mock-intro-blocks-title">' + t('mockIntroBlocks') + '</h2>'
    + '<div class="mock-intro-table"><table class="t"><caption class="sr-only">' + t('mockIntroBlocks') + '</caption>'
    + '<thead><tr><th scope="col">' + t('mockIntroColPart') + '</th><th scope="col">' + t('mockIntroColTime') + '</th><th scope="col">' + t('mockIntroColPoints') + '</th></tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '<tfoot><tr data-mock-intro-block="total" data-minutes="' + MOCK_INTRO_MINUTES + '" data-points="' + MOCK_INTRO_WRITTEN_POINTS + '">'
    + '<th scope="row">' + t('mockIntroBlockTotal') + '</th>'
    + '<td data-mock-intro-time>' + t('minutes', { minutes: MOCK_INTRO_MINUTES }) + '</td>'
    + '<td class="mock-intro-points" data-mock-intro-points>' + esc(String(MOCK_INTRO_WRITTEN_POINTS)) + '</td></tr></tfoot>'
    + '</table></div>'
    + '<p class="small muted" data-mock-intro-total-note>' + t('mockIntroTotalNote', { written: MOCK_INTRO_WRITTEN_POINTS, total: MOCK_INTRO_TOTAL_POINTS, oral: MOCK_INTRO_ORAL_POINTS }) + '</p>'
    + '</section>';
  const rule = '<section class="card-peach stack mock-intro-rule" aria-labelledby="mock-intro-rule-title">'
    + '<h2 id="mock-intro-rule-title">' + t('mockIntroRuleTitle') + '</h2>'
    + '<p data-mock-intro-rule>' + t('mockIntroRule') + '</p>'
    + '<p data-mock-intro-oral>' + t('mockIntroOral') + '</p>'
    + '</section>';
  const startBody = model.archived ? '<p class="hint">' + t('ui60') + '</p>'
    : model.formsFailed ? '<p class="err" role="alert">' + t('ui61') + '</p>' + reloadControl(t)
    : !model.form ? '<p>' + t('ui62') + '</p>' + reloadControl(t)
    : formIdentity(t, model.form, examLanguage) + '<p class="hint" id="' + START_NOTE_ID + '">' + t('ui63') + '</p>'
      + '<div class="row"><button type="button" class="btn btn-primary" ' + START_ATTRIBUTE + '="1" aria-describedby="' + START_NOTE_ID + '"'
      + (model.startPhase === 'starting' ? ' disabled' : '') + '>' + t('startComplete') + '</button></div>';
  const status = statusKey(model.startPhase);
  const start = '<section class="card stack mock-intro-start" aria-labelledby="mock-intro-start-title">'
    + '<h2 id="mock-intro-start-title">' + t('ui59') + '</h2>'
    + startBody
    + '<p class="small" id="' + START_STATUS_ID + '" role="status" aria-live="polite">' + (status ? t(status) : '') + '</p>'
    + '</section>';
  return '<section class="mock-intro" data-mock-intro lang="' + defaultEsc(locale) + '" dir="' + (rtl ? 'rtl' : 'ltr') + '" aria-labelledby="mock-intro-title">'
    + '<header class="page-head"><div>'
    + '<h1 id="mock-intro-title">' + t('mockIntroTitle') + '</h1>'
    + '<p class="mock-intro-lead">' + t('mockIntroLead') + '</p></div></header>'
    + blocks + rule + start + historyMarkup({ esc, uiText, examLanguage, model })
    + '</section>';
}

/** What is being started, in the same shape the existing run list shows it. */
function formIdentity(t, form, examLanguage) {
  const parts = [];
  if (typeof form?.title === 'string' && form.title.trim()) parts.push('<span' + examAttributes(examLanguage) + '>' + defaultEsc(form.title) + '</span>');
  if (Number.isInteger(form?.item_count) && form.item_count > 0) parts.push(t('tasks', { count: form.item_count }));
  if (form?.mode === 'untimed') parts.push(t('untimed'));
  else if (Number.isFinite(form?.time_limit_seconds)) parts.push(t('minutes', { minutes: Math.round(form.time_limit_seconds / 60) }));
  else parts.push(t('timed'));
  if (typeof form?.version === 'string' && typeof form?.release_version === 'string') parts.push(t('formRelease', { form: form.version, release: form.release_version }));
  return '<p class="small muted">' + parts.join(' · ') + '</p>';
}

function reloadControl(t) {
  return '<div class="row"><button type="button" class="btn" ' + RELOAD_ATTRIBUTE + '="1">' + t('ui64') + '</button></div>';
}

/** The saved runs, labelled with the same helpers the existing Prüfungsläufe history uses. */
export function historyMarkup({ esc = defaultEsc, uiText = key => key, examLanguage = 'und', model = {} } = {}) {
  const locale = getLocale();
  const t = (key, parameters = {}) => esc(pt(key, parameters, locale));
  let body;
  if (model.historyFailed) body = '<p class="err" role="alert">' + t('ui66') + '</p>';
  else if (!Array.isArray(model.runs)) body = '<p class="muted" role="status">' + t('serverLoading') + '</p>';
  else if (!model.runs.length) body = '<article class="card"><p>' + t('ui67') + '</p></article>';
  else body = model.runs.map(run => runMarkup(run, { esc, locale, t, examLanguage, readOnly: Boolean(model.archived) })).join('');
  return '<section class="stack mock-intro-history" aria-labelledby="mock-intro-history-title">'
    + '<h2 id="mock-intro-history-title">' + esc(uiText('m006')) + '</h2>'
    + '<div class="mock-intro-runs" data-mock-intro-runs>' + body + '</div>'
    + '</section>';
}

function runMarkup(run, { esc, locale, t, examLanguage, readOnly }) {
  const id = typeof run?.id === 'string' && run.id ? run.id : '';
  const isFinished = run?.state === 'finalised';
  const stamp = typeof run?.updated_at === 'string' && run.updated_at ? run.updated_at
    : typeof run?.created_at === 'string' ? run.created_at : '';
  const form = typeof run?.form_version === 'string' ? t('form', { form: run.form_version }) : '';
  // A saved run without an id cannot be opened, so it gets no link rather than a route that resolves nowhere.
  const open = id
    ? '<a class="btn" href="' + esc('#/lauf/' + encodeURIComponent(id)) + '">' + esc(pt(isFinished || readOnly ? 'view' : 'resume', {}, locale)) + '</a>'
    : '';
  return '<article class="card mock-intro-run" data-mock-intro-run="' + esc(isFinished ? 'finalised' : 'open') + '">'
    + '<p class="kicker">' + esc(String(run?.exam_id ?? '')) + ' · ' + esc(mockScopeLabel(run)) + '</p>'
    + '<h3' + examAttributes(examLanguage) + '>' + esc(String(run?.title ?? '')) + '</h3>'
    + '<p class="small muted">' + form + (stamp ? (form ? ' · ' : '') + '<span data-practice-date="' + esc(stamp) + '">' + esc(formatDate(stamp, { dateStyle: 'medium', timeStyle: 'short' }, locale)) + '</span>' : '') + '</p>'
    + '<p class="small muted">' + esc(mockReviewLabel(run, locale)) + '</p>'
    + '<p>' + esc(pt(isFinished ? 'finished' : 'openRun', {}, locale)) + '</p>'
    + (run?.writing ? '<p class="small muted">' + esc(mockWritingStatus(run.writing)) + '</p>' : '')
    + (run?.review_withdrawn ? '<p class="hint" data-review-withdrawn>' + esc(reviewHistoryNotice(run, locale)) + '</p>' : '')
    + open
    + '</article>';
}

/**
 * The frozen module interface: `{ mount(host), unmount() }`, with `ctx = { api, uiText, esc, language,
 * navigate, state }`. NAV-01 mounts this module into `#mock-intro-host` inside `#view-probepruefung` and
 * injects `mock-intro.css` after the `import()` succeeds, so `mount` may assume its stylesheet is loaded.
 * It owns every byte inside that host and never reaches outside it.
 *
 * `mount` returns a promise for the first load; the shell may ignore it. It never throws: a missing api or
 * a refused request degrades to a message inside the host, which is what keeps the route useful when the
 * shell cannot import the real module and falls back to the interim saved-runs renderer.
 *
 * Optional additive hook the shell may pass (not part of the frozen ctx): `ctx.examLanguage` (e.g. 'de')
 * marks the exam-language islands — the form title and the saved-run titles — with lang/dir. Without it
 * they render `lang="und"`, the same fallback `mock.js` uses when the exam language is unknown.
 */
export function createMockIntroView(ctx = {}) {
  const esc = typeof ctx.esc === 'function' ? ctx.esc : defaultEsc;
  const uiText = typeof ctx.uiText === 'function' ? ctx.uiText : key => key;
  const starter = createMockStarter({ api: ctx.api, navigate: ctx.navigate });
  let host = null;
  let unsubscribe = null;
  let generation = 0;
  let model = blank();
  function archived() {
    const preparation = ctx.state?.preparation;
    return Boolean(preparation && typeof preparation.state === 'string' && preparation.state !== 'active');
  }
  function blank() {
    return { form: null, formsFailed: false, runs: null, historyFailed: false, startPhase: 'idle', archived: archived() };
  }
  function render() {
    if (!host) return;
    host.innerHTML = introMarkup({ esc, uiText, examLanguage: ctx.examLanguage || 'und', model });
    const trigger = host.querySelector?.('[' + START_ATTRIBUTE + ']');
    if (trigger) trigger.disabled = model.startPhase === 'starting';
  }
  async function load() {
    const ticket = ++generation;
    if (typeof ctx.api?.mock?.forms !== 'function') {
      model = { ...blank(), formsFailed: true, historyFailed: true };
      render();
      return false;
    }
    const [formOutcome, historyOutcome] = await Promise.all([starter.forms(), starter.history()]);
    if (ticket !== generation) return false;
    model = {
      ...blank(),
      form: formOutcome.ok ? formOutcome.form : null,
      formsFailed: !formOutcome.ok,
      runs: historyOutcome.ok ? historyOutcome.runs : null,
      historyFailed: !historyOutcome.ok,
    };
    render();
    return true;
  }
  async function onClick(event) {
    const target = event?.target;
    const closest = selector => (typeof target?.closest === 'function' ? target.closest(selector) : null);
    if (closest('[' + RELOAD_ATTRIBUTE + ']')) { await load(); return; }
    const trigger = closest('[' + START_ATTRIBUTE + ']');
    if (!trigger || trigger.disabled || model.startPhase === 'starting' || !model.form) return;
    const ticket = generation;
    model.startPhase = 'starting';
    render();
    const outcome = await starter.start(model.form);
    if (ticket !== generation) return;
    if (outcome.ok) { model.startPhase = 'idle'; render(); return; }
    if (outcome.reason === 'archived') { model.archived = true; model.startPhase = 'idle'; render(); return; }
    model.startPhase = outcome.reason === 'session' ? 'session' : 'failed';
    render();
  }
  function dropLocaleListener() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }
  return {
    async mount(target) {
      if (!target) return false;
      dropLocaleListener();
      host = target;
      model = blank();
      generation++;
      render();
      host.onclick = onClick;
      unsubscribe = typeof subscribeLocale === 'function' ? subscribeLocale(() => render()) : null;
      return load();
    },
    unmount() {
      generation++;
      dropLocaleListener();
      if (host) {
        host.onclick = null;
        host.innerHTML = '';
      }
      host = null;
      model = blank();
    },
  };
}
