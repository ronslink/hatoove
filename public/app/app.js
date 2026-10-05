import { getLocale, initialLocale, setLocale, subscribeLocale, validLocale } from '../assets/i18n/core.js';
import { INSTRUCTIONS, instructionMarkup, translateInstructions } from '../assets/i18n/instructions.js';
import { updatePracticeLocale } from '../assets/i18n/practice-messages.js';
import { s as uiText, messageMarkup, bindShellText, setShellHTML, updateShellMessages, createLocalePreference } from './locale-preference.js';
import { initialPreparation, preparationChoices } from './preparation.js';
import { createMockController, mockMember } from './mock.js';
import { createWritingController, writingCriterion, writingFeedbackState, writingExplanationLabels } from './writing.js';
import { createExplanationManager } from './explanations.js';
import { createCheckoutController, checkoutRoute, checkoutReturnPath } from './checkout.js';
import { guideContent } from './guide-content.js';
import { bindSentenceCheck } from './sentence-check.js';
import { createReadAloud } from './read-aloud.js';
import { contentReviewLabel, reviewHistoryNotice } from './review-labels.js';
/**
 * The Hatoove app shell (PILOT-08).
 *
 * Three rules shape this file:
 *
 *   1. THE SERVER IS THE AUTHORITY. Nothing here computes a score, decides a grade or keeps a
 *      copy of learner state. It reads the owned API and renders what it is told.
 *   2. Account and practice state remain server-owned. Only an explicit guest locale scalar
 *      may be retained by the shared public locale module.
 *   3. SAY WHAT IS TRUE. Where a route does not exist yet (the task catalogue), the shell says so
 *      rather than filling the space with sample data that would read as a working product.
 */

import { api } from './api.js';

const el = (id) => document.getElementById(id);

/** Escape text before it is concatenated into markup. */
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sentenceCheck = bindSentenceCheck({ api, esc });
const readAloud = createReadAloud();

/**
 * The explanation languages the shell offers. It is the same list as the `<option>` elements in
 * index.html and it is enforced here too: a stored value outside it is not silently displayed as
 * the learner's choice. All five render — `noto-sans-latin-ext`, `noto-sans-cyrillic` and
 * `noto-sans-arabic` carry the scripts the branding faces do not (tools/design-assets-check.mjs D7).
 */
const EXPLANATION_LANGUAGES = ['de', 'en', 'uk', 'ar', 'tr'];
const RTL_LANGUAGES = ['ar'];
/**
 * The exam's own section codes, in the interface's language.
 *
 * `item_evidence.section` and the catalogue carry `LV`/`SB`/`HV`/`writing`. Those are identifiers, not
 * German words, and printing them at a learner puts the database's vocabulary on the screen: measured
 * on the overview and in the per-section tally. These operational labels follow the interface.
 */
const SECTION_NAMES = { LV: 'm002', SB: 'm003', HV: 'm004', writing: 'm005', SA: 'm005' };
const sectionName = (code) => SECTION_NAMES[code] ? uiText(SECTION_NAMES[code]) : String(code ?? '');
const sectionMarkup = code => SECTION_NAMES[code] ? messageMarkup(SECTION_NAMES[code]) : esc(code);

/**
 * What to CALL a set on screen.
 *
 * Nine of the twenty-four seeded sets carry no authored title, so the seed generator wrote a
 * placeholder (`LV3 1`, `SB1 2`, …) into `objective_set.title`. A learner must not be shown a
 * database convenience as if it were the name of their task, so a placeholder becomes the section and
 * its part instead — true, and readable. The missing authored titles are recorded for Ron: they are
 * content, and content is not mine to invent.
 */
const hasAuthoredSetTitle = set => { const title = String(set?.title ?? '').trim(); return Boolean(title && !/^(LV|SB|HV)\d+\s+\d+$/.test(title)); };
const setLabel = (set) => {
  const title = String(set?.title ?? '').trim();
  if (hasAuthoredSetTitle(set)) return title;
  const part = set?.part === undefined || set?.part === null ? '' : ' · ' + uiText('part', {part: set.part});
  return `${sectionName(set?.section)}${part}`;
};
const setLabelMarkup = set => {
  const title = String(set?.title ?? '').trim();
  if (hasAuthoredSetTitle(set)) return '<span ' + examTextAttributes() + '>' + esc(title) + '</span>';
  return sectionMarkup(set?.section) + (set?.part == null ? '' : ' · ' + messageMarkup('part', {part: set.part}));
};
const VIEW_TITLES = {
  // The sidebar mirrors B1_Prep's navigation — ten entries in three groups, plus the views reached from them.
  heute: 'm007', ueben: 'm394', wortschatz: 'm395', fehler: 'm396',
  pruefungsteile: 'm398', hoeren: 'm399', schreiben: 'm005', probepruefung: 'm400',
  nachschlagen: 'm010', einstellungen: 'm013',
  // Reached from a group rather than listed in it, then the deep links that keep resolving.
  verlauf: 'm379', satzbau: 'm015', mehr: 'm014', checkout: 'm016', lesen: 'm002', sprachbausteine: 'm003', abschnitt: 'm006',
};

/*
 * NAV-01 — the redirect and alias layer.
 *
 * The sidebar lists ten entries; a URL that was saved, bookmarked or shared before the mirror must still
 * land on a real screen. VIEW_ALIAS keeps the retired view names as first-class routes, DEEP_LINKS keeps
 * the two-segment links that are no longer sidebar entries, and NAV_GROUP drives the breadcrumb group in
 * the topbar. Every view owns #view-<view> itself; nothing here renders, route() reads it.
 */
const VIEW_ALIAS = { woerterbuch: 'wortschatz', fortschritt: 'verlauf' };
/* A view's section is #view-<view> directly; the alias layer above only redirects retired routes. */
const NAV_GROUP = {
  heute: 'lernweg', ueben: 'lernweg', wortschatz: 'lernweg', fehler: 'lernweg',
  pruefungsteile: 'pruefungstraining', hoeren: 'pruefungstraining', schreiben: 'pruefungstraining', probepruefung: 'pruefungstraining',
  nachschlagen: 'werkzeuge', einstellungen: 'werkzeuge', satzbau: 'werkzeuge',
  verlauf: 'lernweg', lesen: 'pruefungstraining', sprachbausteine: 'pruefungstraining', abschnitt: 'pruefungstraining',
};
const GROUP_LABEL = { lernweg: 'm393', pruefungstraining: 'm397', werkzeuge: 'm401' };
/* Satzbau is a Werkzeug now: Nachschlagen links to it, so the two-segment deep link keeps resolving. */
const DEEP_LINKS = { 'nachschlagen/satzbau': 'satzbau' };

/** Resolve a parsed route to the view that renders it, following aliases and the deep links. */
function resolveView(info) {
  const direct = DEEP_LINKS[info.view];
  if (direct) return { ...info, view: direct, runId: null };
  if (info.view === 'nachschlagen' && info.runId === 'satzbau') return { ...info, view: 'satzbau', runId: null };
  /* The bare saved-runs list is the mock history now; a run URL keeps its own view. */
  if (info.view === 'abschnitt' && !info.runId) return { ...info, view: 'probepruefung' };
  const alias = VIEW_ALIAS[info.view];
  return alias ? { ...info, view: alias } : info;
}

/** Server state, held in memory only. */
const state = { account: null, settings: null, revision: null, exams: [], preparations: [], preparation: null, credits: null };

/** The view currently on screen, so a late failure from the previous one is not painted over it. */
let currentView = 'heute';
let sessionProblem = null;
let bootReady = false;
let bootLoading = false;
let objectiveRequest = 0;
let preparationGeneration = 0;
let preparationSwitching = false;
let pendingPreparationNavigation = null;
let settingsSaving = false;
let accountGeneration = 0;
const activePreparation = () => state.preparation?.state === 'active';
const getExamLanguage = () => state.preparation?.exam_language || state.exams.find(exam => exam.exam_id === state.preparation?.exam_id)?.exam_language || null;
const examTextAttributes = () => 'lang="' + esc(getExamLanguage() || 'und') + '" dir="' + (getExamLanguage() === 'ar' ? 'rtl' : 'ltr') + '"';
const contextTicket = () => preparationGeneration;
const currentContext = ticket => ticket === preparationGeneration && !sessionProblem;
let explanationContext = 0, archivedRequest = 0;
const answerRequests = new WeakMap();
function reviewMarkup(value, history = false) {
  const facts = { review_status:value?.review_status, review_basis:value?.review_basis, review_withdrawn:Boolean(value?.review_withdrawn) };
  return '<span data-shell-review="' + (history ? 'history' : 'label') + '" data-review-facts="' + esc(JSON.stringify(facts)) + '">' + esc(history ? reviewHistoryNotice(facts) : contentReviewLabel(facts)) + '</span>';
}
const explanations = createExplanationManager({ readAloud, getLanguage: () => state.settings?.language || 'de',
  getContext: () => [state.account?.id, state.preparation?.id, preparationGeneration, explanationContext, sessionProblem].join('|') });

// ---------------------------------------------------------------- plumbing

function showError(message) {
  const box = el('error');
  if (sessionProblem) {
    bindShellText(box, () => (sessionProblem === 'account_changed'
      ? uiText("m017")
      : uiText("m018"))
      + " " + uiText("m019"));
    const signIn = document.createElement('a');
    signIn.href = checkoutSignInPath(); signIn.className = 'btn'; bindShellText(signIn, () => uiText("m020"));
    box.append(' ', signIn); box.hidden = false;
    return;
  }
  const read = typeof message === 'function' ? message : () => message || '';
  bindShellText(box, read);
  box.hidden = !read();
}

window.addEventListener('hatoove:session-expired', (event) => {
  accountGeneration++;
  localePreference.cancel();
  sessionProblem ||= event.detail?.reason || 'session_expired';
  explanations.dispose();
  mock.refresh();
  checkout.dispose();
  showError();
});
// A focus check gives early feedback; every individual request also carries the server-side
// precondition, so a cookie change between this check and a write is still refused atomically.
const checkSession = () => { if (state.account && !sessionProblem && !document.hidden) void api.session(); };
window.addEventListener('focus', checkSession);
document.addEventListener('visibilitychange', checkSession);

/**
 * How to describe a failed call to a learner.
 *
 * `status === 0` means the response was not received; a write may already have reached the server.
 * dropped connection tells the learner nothing — every message that used to interpolate the raw status
 * goes through here instead.
 */
function failure(res) {
  if (!res) return uiText("m021");
  if (res.status === 0) return uiText("m021");
  return uiText("m011") + " " + res.status + (res.error ? ' (' + res.error + ')' : '');
}

/**
 * Run a promise and SURFACE a failure rather than discarding it.
 *
 * `void someAsync()` is a promise whose rejection nobody handles: the learner sees a control that did
 * nothing and the console sees an exception. Every fire-and-forget call goes through here instead.
 */
function guard(promise) {
  promise.catch((err) => showError(() => (uiText("m022") + " " + (err && err.message ? err.message : err))));
}

function preparationRoute() {
  const returned = checkoutRoute(location.hash);
  if (returned.isCheckout) return { id: null, view: 'checkout', runId: null, ...returned };
  const path = (location.hash || '#/heute').replace(/^#\/?/, '');
  const saved = /^lauf\/([^/]+)$/.exec(path);
  const match = /^prep\/([^/]+)\/([a-z]+)(?:\/([^/]+))?$/.exec(path);
  return { id: match?.[1] || null, view: saved ? 'abschnitt' : (match ? match[2] : path) || 'heute', runId: saved?.[1] || match?.[3] || null };
}

function checkoutSignInPath() {
  const path = checkoutReturnPath('/app/' + location.hash);
  return path ? '/signin?returnTo=' + encodeURIComponent(path) : '/signin';
}

function rememberPreparation(value) {
  if (!value?.id || !value.exam_id || !['active', 'archived'].includes(value.state)
      || !Number.isInteger(value.revision)) throw new Error(uiText("m023"));
  const index = state.preparations.findIndex(p => p.id === value.id);
  if (index < 0) state.preparations.push(value);
  else state.preparations[index] = value;
}

function selectPreparation(value) {
  rememberPreparation(value);
  if (!api.preparations.select(value)) throw new Error(uiText("m024"));
  state.preparation = value;
  state.credits = null;
  bindShellText(el('preparation-credits'), () => uiText("m025"));
  preparationGeneration++;
  // Recovery controls belong to the preparation/form that created them. An explicit successful
  // context switch renders the newly selected form and retires any old recovery action with it.
  el('settings-state').replaceChildren();
  for (const link of document.querySelectorAll('[data-view="sprachbausteine"]')) link.hidden = false;
  guard(refreshSectionNavigation());
}

async function refreshSectionNavigation() {
  const ticket = contextTicket();
  const response = await api.objectiveSets.list();
  if (!currentContext(ticket) || !response?.ok || !Array.isArray(response.data)) return null;
  const hasLanguageSection = response.data.some(set => set.section === 'SB');
  for (const link of document.querySelectorAll('[data-view="sprachbausteine"]')) link.hidden = !hasLanguageSection;
  bindShellText(el('view-satzbau').querySelector('.kicker'), () => uiText("m026"));
  return hasLanguageSection;
}

function renderPreparation() {
  const prep = state.preparation;
  if (!prep) return;
  const label = prep.exam || state.exams.find(e => e.exam_id === prep.exam_id)?.exam || prep.exam_id;
  /*
   * REDESIGN-01 B — THE LARGE LEVEL MARK ON THE EXAM CARD.
   *
   * `level` is authored, not parsed: `exam_package.level` has carried it since migration 0009, and the
   * server already returns it in the exams list. Reading the id for "b1" would have worked for exactly one
   * exam package and broken the moment a second one arrives, which the multi-exam decision says it will.
   * The badge is hidden rather than invented when the server supplies no level.
   */
  const level = state.exams.find(e => e.exam_id === prep.exam_id)?.level || null;
  bindShellText(el('sidebar-exam'), () => label);
  bindShellText(el('preparation-exam'), () => label);
  const mark = el('preparation-level');
  if (mark) {
    mark.hidden = !level;
    bindShellText(mark, () => level || '');
  }
  bindShellText(el('preparation-scope'), () => prep.state === 'archived'
    ? uiText("m027")
    : uiText("m028"));
  el('preparation-continue').href = '#/prep/' + prep.id + '/verlauf';
  el('preparation-start').hidden = !activePreparation();
  el('preparation-start').href = '#/prep/' + prep.id + '/ueben';
  const picker = el('preparation-picker');
  const choices = preparationChoices(state.exams, state.preparations);
  setShellHTML(picker, choices.map(choice => '<option value="' + esc(choice.id) + '">' + esc(choice.label) + '</option>').join(''));
  picker.value = prep.id;
  picker.disabled = preparationSwitching || settingsSaving;
  el('preparation-choice').hidden = choices.length < 2;
  el('examDate').disabled = !activePreparation();
}

async function refreshCredits() {
  const ticket = contextTicket(), prep = state.preparation;
  if (!prep || sessionProblem) return;
  el('credits-retry').hidden = true;
  const response = await api.preparations.credits(prep.id);
  if (!currentContext(ticket)) return;
  const value = response?.data;
  if (!response?.ok || value?.examId !== prep.exam_id
      || !['allowance', 'used', 'reserved', 'available'].every(key => Number.isInteger(value?.[key]) && value[key] >= 0)) {
    state.credits = null;
    bindShellText(el('preparation-credits'), () => uiText("m029"));
    el('credits-retry').hidden = false;
    return;
  }
  state.credits = value;
  bindShellText(el('preparation-credits'), () => uiText('credits', {exam: prep.exam || prep.exam_id, available: value.available, reserved: value.reserved, used: value.used})
    + (value.expiresAt && Number.isFinite(Date.parse(value.expiresAt)) ? " " + uiText("m030") + " " + new Date(value.expiresAt).toLocaleDateString(getLocale()) + '.' : '')
    + (value.available === 0 ? " " + uiText("m031") : ''));
}

function clearPreparationViews() {
  explanationContext++; archivedRequest++; explanations.dispose();
  objectiveRequest++;
  dictionaryRequest++;
  readAloud.stop();
  writing.dispose();
  mock.dispose();
  checkout.dispose();
  for (const node of document.querySelectorAll('.skill-practice')) { node.replaceChildren(); node.hidden = true; }
  for (const id of ['history-detail', 'history-list', 'mock-history', 'mock-host', 'mistake-list', 'practice-next', 'task-list', 'dict-results', 'guide-body']) el(id)?.replaceChildren();
  for (const id of ['mistake-count', 'mistake-count-tab']) el(id).hidden = true;
}

async function switchPreparation(selection, view = currentView, runId = null) {
  if (!bootReady || sessionProblem || preparationSwitching || settingsSaving) return false;
  preparationSwitching = true;
  routing++; // Invalidate a same-preparation route that may still be waiting for an autosave.
  let completed = false;
  let destination = { selection, view, runId };
  el('preparation-picker').disabled = true;
  el('preparation-picker').value = state.preparation.id;
  bindShellText(el('preparation-state'), () => uiText("m032"));
  try {
    if (!(await writing.flush()) || !(await mock.flush())) {
      bindShellText(el('preparation-state'), () => uiText("m033"));
      return false;
    }
    while (!sessionProblem) {
      if (pendingPreparationNavigation) {
        destination = pendingPreparationNavigation;
        pendingPreparationNavigation = null;
      }
      const response = destination.selection === state.preparation.id
        ? { ok: true, data: state.preparation }
        : destination.selection.startsWith('new:')
          ? await api.preparations.create(destination.selection.slice(4))
          : await api.preparations.read(destination.selection);
      if (sessionProblem) return false;
      // A later hash/back-forward choice supersedes this response, including a failed read. Do not
      // paint the intermediate context or let it replace the latest requested destination.
      if (pendingPreparationNavigation) continue;
      if (!response?.ok) { bindShellText(el('preparation-state'), () => uiText("m034") + " " + failure(response)); return false; }
      if (!(await writing.flush()) || !(await mock.flush())) { bindShellText(el('preparation-state'), () => uiText("m035")); return false; }
      if (pendingPreparationNavigation) continue;
      clearPreparationViews();
      selectPreparation(response.data);
      renderSettings(); renderChrome();
      const target = activePreparation() || destination.runId ? destination.view : 'verlauf';
      history.replaceState(null, '', destination.checkoutPath || '#/prep/' + state.preparation.id + '/' + target + (destination.runId ? '/' + destination.runId : ''));
      bindShellText(el('preparation-state'), () => '');
      completed = true;
      break;
    }
  } finally {
    preparationSwitching = false;
    // A failed save leaves the editor in place. Discard the queued request so a refusal cannot
    // trigger an automatic retry loop; the learner can explicitly retry once their text is safe.
    pendingPreparationNavigation = null;
    if (!completed && state.preparation) history.replaceState(null, '', '#/prep/' + state.preparation.id + '/' + currentView + (mock.runId ? '/' + mock.runId : ''));
    renderPreparation();
  }
  if (completed) await route();
  return completed;
}

async function loadPreparations() {
  const [exams, preparations] = await Promise.all([api.exams.list(), api.preparations.list()]);
  if (!exams?.ok || !preparations?.ok || !Array.isArray(exams.data?.exams) || !Array.isArray(preparations.data?.preparations)) {
    throw new Error(uiText("m036"));
  }
  state.exams = exams.data.exams;
  state.preparations = [];
  for (const prep of preparations.data.preparations) rememberPreparation(prep);
  const routeInfo = preparationRoute();
  let requested = routeInfo.id;
  if (routeInfo.runId) {
    const saved = await api.mock.read(routeInfo.runId);
    if (!saved?.ok) throw new Error(uiText("m037"));
    requested = saved.data.preparation_id;
  }
  if (requested) {
    const response = await api.preparations.read(requested);
    if (!response?.ok) throw new Error(uiText("m038"));
    selectPreparation(response.data);
    return true;
  }
  const initial = initialPreparation(state.exams, state.preparations);
  if (initial.kind === 'select' && initial.preparation.state === 'active') { selectPreparation(initial.preparation); return true; }
  if (initial.kind === 'select') {
    selectPreparation(initial.preparation);
    if (routeInfo.view !== 'checkout') history.replaceState(null, '', '#/prep/' + state.preparation.id + '/verlauf');
    return true;
  }
  if (initial.kind === 'create') {
    const created = await api.preparations.create(initial.examId);
    if (!created?.ok) throw new Error(uiText("m039"));
    selectPreparation(created.data);
    return true;
  }
  const choices = el('boot-choices');
  bindShellText(el('boot-message'), () => state.preparations.length || state.exams.length
    ? uiText("m040")
    : uiText("m041"));
  setShellHTML(choices, preparationChoices(state.exams, state.preparations).map(choice => '<button class="btn' + (choice.isNew ? ' btn-primary' : '') + '" type="button" data-preparation="' + esc(choice.id) + '">' + esc(choice.label) + '</button>').join(''));
  choices.hidden = false;
  el('boot-retry').hidden = choices.childElementCount > 0;
  choices.onclick = event => {
    const button = event.target.closest('[data-preparation]');
    if (!button || bootLoading) return;
    guard((async () => {
      bootLoading = true;
      for (const item of choices.querySelectorAll('button')) item.disabled = true;
      try {
        const choice = button.dataset.preparation;
        const response = choice.startsWith('new:') ? await api.preparations.create(choice.slice(4)) : await api.preparations.read(choice);
        if (!response?.ok) throw new Error(uiText("m042") + " " + failure(response));
        selectPreparation(response.data);
        await unlockPreparation();
      } catch (error) { bindShellText(el('boot-message'), () => error.message); }
      finally { bootLoading = false; for (const item of choices.querySelectorAll('button')) item.disabled = false; }
    })());
  };
  return false;
}

async function unlockPreparation() {
  if (sessionProblem || !state.preparation) throw new Error(uiText("m043"));
  renderSettings(); renderChrome(); renderPreparation();
  const info = preparationRoute();
  if (info.view !== 'checkout') history.replaceState(null, '', '#/prep/' + state.preparation.id + '/' + (activePreparation() || info.runId ? info.view : 'verlauf') + (info.runId ? '/' + info.runId : ''));
  bootReady = true;
  el('app-shell').inert = false;
  el('app-shell').hidden = false;
  el('app-shell').setAttribute('aria-busy', 'false');
  el('boot-state').hidden = true;
  await route();
  guard(renderMistakes());
}

el('preparation-picker').addEventListener('change', event => guard(switchPreparation(event.target.value)));
el('credits-retry').addEventListener('click', () => guard(refreshCredits()));

// ---------------------------------------------------------------- rendering

/**
 * Tag every explanation-language `<option>` with its own `lang`, and with `dir=rtl` for Arabic.
 *
 * The tags matter for two reasons. `lang` is what `hatoove.css` keys its font stacks on, so
 * `[lang=ar]` is what puts the Arabic face on Arabic text; and `dir` is what stops a right-to-left
 * language from being laid out as if it were left-to-right. The interface root follows the selected
 * locale; original exam material declares its own language independently.
 */
function applyExplanationDirection() {
  for (const option of el('language').options) {
    const code = option.value;
    option.setAttribute('lang', code);
    option.setAttribute('dir', RTL_LANGUAGES.includes(code) ? 'rtl' : 'ltr');
  }
}

function renderAccount() {
  const email = state.account?.email || '–';
  bindShellText(el('account-email'), () => email);
  bindShellText(el('account-email-2'), () => email);
  bindShellText(el('avatar'), () => (email[0] || '?').toUpperCase());
  bindShellText(el('greeting'), () => email.startsWith('–') ? uiText("m044") : uiText('welcomeName', {name: email.split('@')[0]}));
}

/**
 * SITZUNGEN (D5), rendered from the server.
 *
 * THREE THINGS THIS DELIBERATELY DOES:
 *   * shows what the SERVER says, never a list assembled here — a session list the client invented would
 *     show sessions that do not exist and hide ones that do;
 *   * never renders a token, because the server does not send one and a session id is enough to end it;
 *   * says what "end" means (only that device), because "Sitzung beenden" that secretly ends everything is
 *     the kind of label that teaches a learner not to trust the screen.
 *
 * A 503 is reported as its own state rather than as an empty list: an installation without the lifecycle
 * capability has no sessions to show, and "keine Sitzungen" would be a lie about a server that cannot answer.
 */
async function renderSessions() {
  const into = el('session-list');
  const state = el('session-state');
  if (!into) return;
  const res = await api.sessions.list();
  if (!res || !res.ok) {
    setShellHTML(into, '');
    if (state) {
      bindShellText(state, () => res && res.status === 503
        ? uiText("m045")
        : uiText("m046") + " " + failure(res));
    }
    return;
  }
  const sessions = (res.data && res.data.sessions) || [];
  if (state) bindShellText(state, () => '');
  if (!sessions.length) {
    setShellHTML(into, "<li class=\"muted small\"><span data-i18n=\"shell.m047\">Keine weiteren Sitzungen.</span></li>");
    return;
  }
  setShellHTML(into, sessions.map((session) => '<li class="session">'
    + '<div><strong>' + (session.current ? messageMarkup("m048") : messageMarkup("m049")) + '</strong>'
    + "<span class=\"small muted\"> <span data-i18n=\"shell.m050\">seit</span> " + esc(shortDate(session.created_at)) + '</span></div>'
    + (session.current
      ? '<span class="small muted">' + messageMarkup('active') + '</span>'
      : '<button type="button" class="btn btn-small" data-revoke="' + esc(String(session.id)) + '">' + messageMarkup('end') + '</button>')
    + '</li>').join(''));
  for (const button of into.querySelectorAll('[data-revoke]')) {
    /*
     * `guard` TAKES A PROMISE, NOT A FUNCTION — it is `promise.catch(...)`, so passing an arrow function made
     * `guard` call `.catch` on a function and the listener died before making a request. The browser leg is
     * what caught it: the button rendered, nothing happened, and the status line stayed empty. So the async
     * function is INVOKED here and its promise handed over.
     */
    button.addEventListener('click', () => guard((async () => {
      const res = await api.sessions.revoke(button.dataset.revoke);
      /*
       * RE-RENDER FIRST, MESSAGE SECOND. `renderSessions` clears the status line when it succeeds (there is
       * nothing to report about a list that loaded), so setting the message before it wiped the confirmation
       * the learner had just earned — which the browser leg showed as a click that worked with an empty
       * status line.
       */
      await renderSessions();
      if (state) bindShellText(state, () => res && res.ok ? uiText("m051") : uiText("m052") + " " + failure(res));
    })()));
  }
}

/** A local date, without a time nobody needs on a session list. */
function shortDate(value) {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? uiText('unknown')
    : date.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderSettings() {
  const settings = state.settings || {};
  const examDate = state.preparation?.exam_date || '';
  const language = settings.language || 'de';

  el('examDate').value = examDate;
  el('language').value = EXPLANATION_LANGUAGES.includes(language) ? language : 'de';

  bindShellText(el('account-exam'), () => examDate ? uiText('examOn', {date: examDate}) : uiText("m053"));

  // Native language names retain their own direction inside either interface direction.
  applyExplanationDirection();

  // The countdown is arithmetic on a date the learner typed. It is not a study plan, a forecast or
  // a readiness estimate, and it must never be presented as one.
  if (!examDate) {
    bindShellText(el('countdown'), () => uiText("m054"));
    bindShellText(el('countdown-note'), () => uiText("m055"));
    return;
  }
  const days = Math.ceil((new Date(`${examDate}T00:00:00`) - new Date()) / 86400000);
  const when = () => new Date(`${examDate}T00:00:00`).toLocaleDateString(getLocale(), { day: '2-digit', month: 'long', year: 'numeric' });
  bindShellText(el('countdown'), () => days > 1 ? uiText('days', {count: days, date: when()})
    : days === 1 ? uiText('tomorrow', {date: when()})
      : days === 0 ? uiText('todayDate', {date: when()}) : uiText('pastDate', {date: when()}));
  bindShellText(el('countdown-note'), () => uiText("m056"));
}


/**
 * UEBEN -- the real catalogue, from the API. No sample data and no placeholder card: this lists what
 * the server is willing to serve, and every row carries its ACTUAL review_status, so a learner is
 * told the truth about the content instead of being shown an implied approval.
 *
 * AND A CATALOGUE HAS TO BE USABLE. Until REVIEW-UX this view only DESCRIBED its entries: a writing
 * card named the topic and nothing could open it, and an objective card said how many items a set has
 * with no way into them. A catalogue a learner cannot start from is a list of things that exist, not
 * practice. Every card now carries the one control that opens THAT entry -- "Üben" for an objective
 * set, "Schreiben" for a writing task -- and the binding travels with the button (set_id + version, or
 * task_id + version + rubric_id + rubric_version), so opening task B can never mark task A.
 */
async function renderTasks() {
  const ticket = contextTicket();
  const box = el('task-list');
  if (!box) return;
  /*
   * ENTERING ÜBEN STARTS AT THE CATALOGUE. The host is the SIBLING the open set/letter is rendered
   * into; leaving it populated would put last visit's task above this visit's catalogue.
   */
  const host = uebenPracticeHost();
  if (host) { host.hidden = true; setShellHTML(host, ''); }
  if (el('skill-ueben-catalogue')) el('skill-ueben-catalogue').hidden = false;
  box.hidden = false;
  if (!activePreparation()) { setShellHTML(box, archivedPracticeNotice()); return; }
  setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m057\">Wird geladen ...</span></h3></div>");
  const [writing, objective] = await Promise.all([
    api.tasks.list({ family: 'writing' }),
    api.objectiveSets.list(),
  ]);
  if (!currentContext(ticket)) return;
  if (!writing || !objective) return; // a 401 already redirected us to the sign-in page
  if (!writing.ok || !objective.ok) {
    setShellHTML(box, '');
    showError(() => (uiText("m058") + " " + failure(writing.ok ? objective : writing) + '.'));
    return;
  }
  const tasks = Array.isArray(writing.data) ? writing.data : [];
  const sets = Array.isArray(objective.data) ? objective.data : [];
  const card = (title, chip, line, meta, action) => '<div class="card"><div class="card-head"><h3>'
    + title + '</h3><span class="chip">' + chip + '</span></div>'
    + '<p class="muted">' + line + '</p>'
    + '<p class="small muted">' + meta + '</p>'
    + action + '</div>';
  const groups = [];
  if (tasks.length) {
    groups.push("<h3 class=\"section-head\"><span data-i18n=\"shell.m005\">Schreiben</span></h3>" + tasks.map((t) => card(
      '<span ' + examTextAttributes() + '>' + esc(t.topic) + '</span>', messageMarkup('m005'), '<span ' + examTextAttributes() + '>' + esc(t.situation) + '</span>',
      messageMarkup("m059") + ' <span ' + examTextAttributes() + '>' + esc(t.adressat) + '</span> &middot; ' + messageMarkup('register') + ': <span ' + examTextAttributes() + '>' + esc(t.register) + '</span>'
        + ' &middot; ' + messageMarkup('version') + ' ' + esc(t.version) + ' &middot; ' + reviewMarkup(t),
      // The four-part binding, exactly as the Schreiben view binds it; the controller resumes an open
      // draft for this task+version instead of creating a second one.
      '<div class="row"><button class="btn btn-primary" type="button" data-write="' + esc(t.task_id) + '"'
        + ' data-version="' + esc(t.version) + '" data-rubric="' + esc(t.rubric_id) + '"'
        + ' data-rubric-version="' + esc(t.rubric_version) + '">' + messageMarkup('m005') + '</button></div>',
    )).join(''));
  }
  if (sets.length) {
    // setLabel(), not s.title: nine seeded sets have no authored title and the generator wrote
    // `LV3 1` into the column. This view was the one place it still reached the screen.
    groups.push('<h3 class="section-head">' + [...new Set(sets.map(set => set.section))].map(sectionMarkup).join(" " + messageMarkup("m060") + " ") + '</h3>' + sets.map((s) => card(
      setLabelMarkup(s), esc(s.family), messageMarkup('tasks', {count: s.item_count}),
      messageMarkup("part", {part:s.part}) + ' &middot; ' + messageMarkup('version') + ' ' + esc(s.version) + ' &middot; ' + reviewMarkup(s),
      // The version is the second half of the identity: the read below refuses a mismatch rather than
      // rendering the wrong fassung of the task the learner chose.
      '<div class="row"><button class="btn btn-primary" type="button" data-open="' + esc(s.set_id) + '"'
        + ' data-version="' + esc(s.version) + "\"><span data-i18n=\"shell.m062\">Üben</span></button></div>",
    )).join(''));
  }
  if (!groups.length) {
    setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m063\">Zurzeit keine Aufgaben freigegeben</span></h3>"
      + "<p class=\"muted\"><span data-i18n=\"shell.m064\">Der Server hat für dieses Angebot gerade nichts Servierbares. Das ist eine</span> "
      + "<span data-i18n=\"shell.m065\">Aussage des Servers, keine leere Seite.</span></p></div>");
    return;
  }
  setShellHTML(box, groups.join(''));
  box.onclick = (event) => {
    const button = event.target?.closest?.('[data-open], [data-write]');
    if (button) guard(launchCatalogueEntry(host, button, tasks));
  };
}

/**
 * The Üben host the open set/letter is rendered into, created once as a SIBLING of the catalogue.
 *
 * IT MUST BE A SIBLING: `renderTasks` assigns `#task-list`'s innerHTML, which deletes a nested host —
 * the failure the skill views already met ("Üben" appeared to do nothing).
 *
 * AND THE CATALOGUE MUST BE FINDABLE BY THE CONTROLLERS. Both the objective and the writing controller
 * restore the catalogue they were opened from by looking for `.stack[id^="skill-"]` among the open
 * host's siblings; `#task-list` does not carry that prefix, so a task opened from Üben would have left
 * its catalogue on screen above it and closing would have restored nothing. `#task-list` keeps its id
 * (the browser checks read it) but is placed inside ONE element the controllers can recognise, and
 * that is this wrapper's only job. It is not a layout change: one `.stack` around a single `.stack`.
 */
function uebenPracticeHost() {
  const view = el('view-ueben');
  const list = el('task-list');
  if (!view || !list) return null;
  const existing = el('ueben-practice');
  if (existing) return existing;
  const catalogue = document.createElement('div');
  catalogue.className = 'stack';
  catalogue.id = 'skill-ueben-catalogue';
  view.insertBefore(catalogue, list);
  catalogue.appendChild(list);
  const host = document.createElement('div');
  host.className = 'stack skill-practice';
  host.id = 'ueben-practice';
  host.hidden = true;
  view.insertBefore(host, catalogue.nextSibling);
  return host;
}

/** One launch at a time, so two clicks on the same card cannot race into two creates. */
let catalogueOpening = false;

/**
 * Open ONE catalogue entry, from the exact identity its card was rendered with.
 *
 * IT CANNOT CREATE TWO ATTEMPTS FROM TWO CLICKS. The writing controller reuses the open draft for the
 * same task+version, but two clicks dispatched before the first has resolved would both read "no open
 * draft" and both create one — so the launch is serialised here. `openSet` carries its own guard (a
 * request token) and both controllers refuse while the session is blocked or the boot gate is closed;
 * neither is reimplemented here.
 */
async function launchCatalogueEntry(host, button, tasks) {
  if (!host || catalogueOpening || !bootReady || sessionProblem) return;
  catalogueOpening = true;
  try {
    if (button.dataset.write) {
      const task = tasks.find((t) => t.task_id === button.dataset.write
        && String(t.version) === String(button.dataset.version));
      if (!task) {
        showError(() => (uiText("m066")));
        return;
      }
      await openWriting(host, task);
      return;
    }
    if (!button.dataset.open) return;
    const version = button.dataset.version;
    if (!version) {
      // Same refusal `openSet` makes, said before the request rather than after it.
      showError(() => (uiText("m067")));
      return;
    }
    await openSet(button.dataset.open, version);
  } finally {
    catalogueOpening = false;
  }
}


/**
 * WOERTERBUCH -- the 300-word list and the 240-noun lexicon, from the API.
 *
 * Two corpora in one view because they answer one question ("what does this word mean and how do I use
 * it"), and because a learner does not care which table a word lives in. The server bounds the response
 * and refuses a one-character search, so the view must not fire one either.
 */
let dictMode = 'vocab';
let dictionaryRequest = 0;
function materialNotice() {
  return '<p class="small muted">' + messageMarkup('material') + '</p><p class="small muted" data-material-unavailable' + (['de','en'].includes(getLocale()) ? ' hidden' : '') + '>' + messageMarkup('translationUnavailable') + '</p>';
}
async function renderDictionary() {
  const box = el('dict-results');
  if (!box) return;
  const request = ++dictionaryRequest, mode = dictMode;
  readAloud.clear(box);
  const q = (el('dict-q')?.value || '').trim();
  if (q.length === 1) { setShellHTML(box, "<div class=\"card\"><p class=\"muted\"><span data-i18n=\"shell.m068\">Mindestens zwei Buchstaben.</span></p></div>"); return; }
  setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m057\">Wird geladen ...</span></h3></div>");
  const res = mode === 'nouns' ? await api.nouns.list({ q: q || null }) : await api.vocab.list({ q: q || null });
  if (request !== dictionaryRequest) return;
  if (!res) return; // a 401 already redirected
  if (!res.ok) { setShellHTML(box, ''); showError(() => (uiText("m069") + " " + failure(res) + '.')); return; }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) {
    setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m070\">Nichts gefunden</span></h3><p class=\"muted\"><span data-i18n=\"shell.m071\">Der Server hat zu dieser Suche keinen Eintrag.</span></p></div>");
    return;
  }
  readAloud.clear(box);
  setShellHTML(box, materialNotice() + rows.map((w) => (mode === 'nouns'
    ? '<div class="card"><div class="card-head"><h3 lang="de" dir="ltr">' + esc(w.de) + '</h3><span class="chip" lang="de" dir="ltr">' + esc(w.gender) + '</span></div>'
      + (w.en ? '<p class="muted" lang="en" dir="ltr" data-authored-alternative="en"' + (getLocale() === 'en' ? '' : ' hidden') + '>' + esc(w.en) + '</p>' : '')
      + '<p class="small muted"><span data-i18n="shell.m072">Plural:</span> <span lang="de" dir="ltr">' + esc(w.plural) + '</span> &middot; ' + messageMarkup('topic') + ': <span lang="de" dir="ltr">' + esc(w.theme) + '</span></p>'
      + '<p class="small muted"><span data-i18n="shell.m073">Regel:</span> <span lang="de" dir="ltr">' + esc(w.rule) + '</span></p>'
      + (w.example ? '<p class="small" lang="de" dir="ltr" data-read-example>' + esc(w.example) + '</p>' : '') + '</div>'
    : '<div class="card"><div class="card-head"><h3 lang="de" dir="ltr">' + esc(w.de) + '</h3><span class="chip" lang="de" dir="ltr">' + esc(w.pos) + '</span></div>'
      + (w.en ? '<p class="muted" lang="en" dir="ltr" data-authored-alternative="en"' + (getLocale() === 'en' ? '' : ' hidden') + '>' + esc(w.en) + '</p>' : '')
      + (w.plural ? '<p class="small muted"><span data-i18n="shell.m072">Plural:</span> <span lang="de" dir="ltr">' + esc(w.plural) + '</span></p>' : '')
      + (w.example ? '<p class="small" lang="de" dir="ltr" data-read-example>' + esc(w.example) + '</p>' : '') + '</div>')).join(''));
  for (const example of box.querySelectorAll('[data-read-example]')) readAloud.mount(example, { label: uiText("m074"), language: example.lang });
}

/*
 * EINZELÜBUNGEN — slice H ships the one-item-at-a-time drill as public/app/drill.js. Until that module is
 * present this falls back to today's view: the adaptive recommendation plus the task catalogue.
 */
async function renderUeben() {
  if (await mountModule('ueben')) return;
  await renderPracticeNext();
  await renderTasks();
}

/*
 * WORTSCHATZ — slice G ships the Prüfungskern blocks and the word deck as public/app/vocab.js. Until that
 * module is present this falls back to today's dictionary, which still serves search and the noun lexicon.
 */
async function renderWortschatz() {
  if (await mountModule('wortschatz')) return;
  await renderDictionary();
}

/*
 * HÖREN — slice B mounts the same part-index module here with an HV filter, keyed off the host it is given
 * (#hoeren-host), so "Hören is Prüfungsteile filtered to HV" is one implementation with two entry points.
 * Until the module is present this falls back to today's skill view, which shows the saved HV runs.
 */
async function renderHoerenIndex() {
  if (await mountModule('hoeren')) return;
  await renderSkill('hoeren');
}

/*
 * PRÜFUNGSTEILE (interim) — slice B replaces this with one tile per released part, each carrying the
 * official label, items, points, the listening play rule and the learner's own count. Until then the entry
 * lists the four subtests and opens the skill view, so the group entry is never a dead link.
 */
async function renderPartIndex() {
  const host = el('part-index-host');
  if (!host) return;
  /* Slice B's module replaces the interim list the moment it is present; absent, this stays. */
  if (await mountModule('pruefungsteile')) return;
  const parts = [
    { view: 'lesen', label: 'm002', note: 'm346' },
    { view: 'sprachbausteine', label: 'm003', note: 'm347' },
    { view: 'hoeren', label: 'm004', note: 'm348' },
    { view: 'schreiben', label: 'm005', note: null },
  ];
  setShellHTML(host, '<div class="more-grid">' + parts.map((part) => '<a class="card more-link" href="#/' + part.view + '" data-view="' + part.view + '"><strong>'
    + esc(uiText(part.label)) + '</strong>' + (part.note ? '<span class="muted">' + esc(uiText(part.note)) + '</span>' : '')).join('') + '</div>');
}

/*
 * PROBEPRÜFUNG — slice D ships the intro page, its block table and its start button as its own module
 * (mock-intro.js). Until that module is present this renders today's saved-runs list, which is the history
 * the intro carries below its start button anyway, so the entry is honest rather than empty.
 */
async function renderProbepruefung() {
  const host = el('mock-intro-host');
  if (!host) return;
  if (await mountModule('probepruefung')) return;
  await mock.list(host);
}

/*
 * NACHSCHLAGEN — slices E/F ship the six-card hub and the guide pages as library.js. Until that module is
 * present the existing index and document renderer stay, so the hub works today and the module swaps in
 * without a route change.
 */
async function renderNachschlagen() {
  if (await mountModule('nachschlagen')) return;
  await renderGuides();
}

/** NACHSCHLAGEN -- the guide index, then one document's sections. */
async function renderGuides() {
  const box = el('guide-index');
  if (!box) return;
  box.hidden = false;
  el('guide-body').hidden = true;
  setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m057\">Wird geladen ...</span></h3></div>");
  const res = await api.guides.list();
  if (!res) return;
  if (!res.ok) { setShellHTML(box, ''); showError(() => (uiText("m069") + " " + failure(res) + '.')); return; }
  const guides = Array.isArray(res.data) ? res.data : [];
  if (!guides.length) {
    setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m075\">Zurzeit keine Nachschlagewerke</span></h3><p class=\"muted\"><span data-i18n=\"shell.m076\">Der Server hat gerade nichts Servierbares.</span></p></div>");
    return;
  }
  setShellHTML(box, materialNotice() + guides.map((g) => '<div class="card"><div class="card-head"><h3 lang="de" dir="ltr">' + esc(g.title)
    + '</h3><span class="chip">' + g.section_count + ' ' + messageMarkup('sections') + '</span></div>'
    + (g.intro ? '<p class="muted" lang="de" dir="ltr">' + esc(g.intro) + '</p>' : '')
    + '<button class="btn" type="button" data-guide="' + esc(g.guide_id) + "\"><span data-i18n=\"shell.m077\">Öffnen</span></button></div>").join(''));
}

/** One guide, rendered. */
async function openGuide(guideId) {
  const box = el('guide-body');
  const index = el('guide-index');
  if (!box || !index) return;
  index.hidden = true;
  box.hidden = false;
  setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m057\">Wird geladen ...</span></h3></div>");
  const res = await api.guides.read(guideId);
  if (!res) return;
  if (!res.ok) { box.hidden = true; index.hidden = false; showError(() => (uiText("m078") + " " + failure(res) + '.')); return; }
  const g = res.data;
  const sections = Array.isArray(g.sections) ? g.sections : [];
  const sectionKinds = { step: uiText("m079"), topic: uiText("m080"), tier: uiText("m081"), gender_rule: uiText("m082"), exception: uiText("m083"), double_gender: uiText("m084"), table: uiText("m085"), trigger: uiText("m086"), example: uiText("m087"), phrases: uiText("m088"), phrase_group: uiText("m088"), checklist: uiText("m089") };
  setShellHTML(box, '<div class="card"><div class="card-head"><h3 lang="de" dir="ltr">' + esc(g.title)
    + '</h3><span class="chip">' + sections.length + '</span></div>'
    + "<p class=\"small muted\"><span data-i18n=\"shell.m090\">Übungsmaterial – noch nicht fachlich geprüft.</span></p>" + materialNotice() + "<button class=\"btn\" type=\"button\" id=\"guide-back\"><span data-i18n=\"shell.m092\">Zurück</span></button></div>"
    + sections.map((s) => '<div class="card"><div class="card-head"><h3 lang="de" dir="ltr">' + esc(s.title)
      + '</h3><span class="chip">' + messageMarkup(sectionKinds[s.kind] || uiText('m010')) + '</span></div>'
      + (s.summary ? '<p class="muted" lang="de" dir="ltr">' + esc(s.summary) + '</p>' : '')
      + '<div class="guide-content">' + guideContent(s.payload, esc, state.settings?.language || 'de') + '</div></div>').join(''));
  el('guide-back').addEventListener('click', () => { box.hidden = true; index.hidden = false; });
}

/** UEBEN's adaptive recommendation, above the catalogue. */
async function renderPracticeNext() {
  const ticket = contextTicket();
  const box = el('practice-next');
  if (!box) return;
  if (!activePreparation()) { setShellHTML(box, ''); return; }
  const res = await api.practice.next();
  if (!currentContext(ticket)) return;
  if (!res) return;
  if (!res.ok) return; // the catalogue below still renders; a failed suggestion is not an error page
  const data = res.data || {};
  if (!data.set) { setShellHTML(box, ''); return; }
  const e = data.evidence || {};
  const why = () => data.reason === 'section_not_started'
    ? uiText("m093")
    : (e.attempts ? e.correct + " " + uiText("m094") + " " + e.attempts + " " + uiText("m095") + Math.round((e.accuracy || 0) * 100) + '%).' : '');
  setShellHTML(box, "<div class=\"card\"><div class=\"card-head\"><h3><span data-i18n=\"shell.m096\">Ihre nächste Aufgabe</span></h3><span class=\"chip\">"
    + sectionMarkup(data.section) + '</span></div>'
    + '<p><strong>' + setLabelMarkup(data.set) + '</strong> &middot; ' + messageMarkup('tasks', {count: data.set.item_count}) + '</p>'
    + (why() ? '<p class="muted" data-practice-reason></p>' : '')
    + "<p class=\"small muted\"><span data-i18n=\"shell.m097\">Vom Server gewählt aus Ihren bisherigen Antworten — nicht geraten.</span></p></div>");
  bindShellText(box.querySelector('[data-practice-reason]'), why);
}


/**
 * The design's chrome: the exam countdown pill, the crumb date, and the explanation-language button.
 * All three are facts the server already stores -- nothing here is invented to fill a space, and a
 * missing exam date says so rather than showing a plausible-looking countdown.
 */
function renderChrome() {
  const settings = state.settings || {};
  const examDate = state.preparation?.exam_date;
  const crumb = el('crumb-date');
  if (crumb) bindShellText(crumb, () => new Date().toLocaleDateString(getLocale(), { weekday: 'long', day: 'numeric', month: 'long' }));
  const countdown = el('exam-countdown');
  if (countdown) {
    if (examDate) {
      const exam = new Date(examDate + 'T00:00:00');
      const today = new Date(new Date().toDateString());
      const days = Math.round((exam - today) / 86400000);
      bindShellText(countdown, () => days >= 0
        ? uiText("m098") + " " + exam.toLocaleDateString(getLocale(), { day: 'numeric', month: 'short' }) + ' · ' + uiText('daysShort', {count:days})
        : uiText("m099"));
    } else {
      bindShellText(countdown, () => uiText("m054"));
    }
  }
  const lang = el('lang-label');
  if (lang) bindShellText(lang, () => uiText('locale'));
}


/**
 * HEUTE -- the design's dashboard, filled with FACTS.
 *
 * THREE DEVIATIONS FROM THE SUPPLIED SCREEN, all deliberate and all recorded in
 * work/implementation/DESIGN-CONFORMANCE.md:
 *   1. NO SCORE ESTIMATE. The design shows "Written estimate 152 / 225". The product forbids calibrated
 *      readiness scores, so the gauge counts ANSWERED ITEMS instead of projecting a mark.
 *   2. NO PASS LINE and no range. The design draws a "pass line 135" and a "Range 142-162". Both are
 *      pass prediction, which is explicitly out of scope.
 *   3. NO STREAK and NO "mistakes due". Streaks are excluded by AGENTS.md; "due" implies a scheduling
 *      claim nothing here makes.
 * The layout, the components and the hierarchy are the design's. The numbers are the learner's own.
 */
function bindDashboardTitle(read, readLanguage = () => getLocale()) {
  const node = el('next-title');
  bindShellText(node, () => {
    const language = readLanguage() || 'und';
    node.lang = language; node.dir = language === 'ar' ? 'rtl' : 'ltr';
    return read();
  });
}
async function renderDashboard() {
  const ticket = contextTicket();
  const pct = (value) => Math.round((value || 0) * 100) + '%';
  const [next, progress, savedRuns] = await Promise.all([api.practice.next(), api.practice.progress(), api.mock.list()]);
  if (!currentContext(ticket)) return;
  if (!next || !progress) return; // a 401 already redirected
  const start = document.querySelector('.hero-next a');
  if (start) { start.href = activePreparation() ? '#/ueben' : '#/verlauf'; bindShellText(start, () => activePreparation() ? uiText("m389") : uiText("m101")); }

  if (next.ok && next.data && next.data.set) {
    const d = next.data;
    const e = d.evidence || {};
    bindShellText(el('next-kicker'), () => uiText("m102") + " " + sectionName(d.section));
    bindDashboardTitle(() => setLabel(d.set), () => hasAuthoredSetTitle(d.set) ? getExamLanguage() || 'und' : getLocale());
    bindShellText(el('next-detail'), () => uiText('tasks', {count: d.set.item_count})
      + (d.reason === 'section_not_started'
        ? " " + uiText("m103")
        : (e.attempts ? ' · ' + e.correct + " " + uiText("m094") + " " + e.attempts + " " + uiText("m104") : '')));
  } else {
    bindShellText(el('next-kicker'), () => uiText("m105"));
    bindDashboardTitle(() => uiText("m106"));
    bindShellText(el('next-detail'), () => uiText("m107"));
  }
  const savedRun = savedRuns?.ok && savedRuns.data?.runs?.find(run => run.state === 'active');
  if (savedRun && activePreparation()) {
    bindShellText(el('next-kicker'), () => uiText("m108"));
    bindDashboardTitle(() => savedRun.title, () => savedRun.exam_language || getExamLanguage() || 'und');
    bindShellText(el('next-detail'), () => uiText("m109"));
    if (start) { start.href = '#/lauf/' + savedRun.id; bindShellText(start, () => uiText("m110")); }
  }
  if (!activePreparation()) {
    bindDashboardTitle(() => uiText("m111"));
    bindShellText(el('next-detail'), () => uiText("m112"));
  }

  const totals = (progress.ok && progress.data && progress.data.totals) || { attempts: 0, correct: 0, accuracy: null };
  bindShellText(el('gauge-count'), () => String(totals.attempts));
  el('gauge-bar').style.width = pct(totals.accuracy);
  bindShellText(el('gauge-foot'), () => totals.attempts
    ? uiText('answers', { count: totals.attempts })
    : uiText("m114"));
  bindShellText(el('gauge-acc'), () => totals.accuracy === null ? '–' : totals.correct + " " + uiText("m094") + " " + totals.attempts + " " + uiText("m104"));
  bindShellText(el('stat-answers'), () => String(totals.attempts));
  bindShellText(el('stat-correct'), () => String(totals.correct));

  // No `warn` class: the design uses it against a 60% PASS THRESHOLD, and importing that threshold
  // would smuggle the pass line back in through a colour.
  const sections = (progress.ok && Array.isArray(progress.data.sections)) ? progress.data.sections : [];
  setShellHTML(el('parts'), sections.length
    ? sections.map((s) => '<div class="part"><span>' + sectionMarkup(s.section) + '</span>'
      + '<div class="mini"><i style="width:' + pct(s.accuracy) + '"></i></div>'
      + '<b>' + s.correct + ' / ' + s.attempts + '</b></div>').join('')
    : "<p class=\"small muted\"><span data-i18n=\"shell.m115\">Sobald Sie Aufgaben beantworten, erscheint hier Ihre Bilanz je Bereich.</span></p>");

  const examDate = state.preparation?.exam_date;
  if (examDate) {
    const exam = new Date(examDate + 'T00:00:00');
    const days = Math.round((exam - new Date(new Date().toDateString())) / 86400000);
    bindShellText(el('countdown'), () => days >= 0
      ? exam.toLocaleDateString(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' + uiText('daysShort', { count: days })
      : exam.toLocaleDateString(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) + " " + uiText("m116"));
  } else {
    bindShellText(el('countdown'), () => uiText("m054"));
  }
}


/**
 * FEHLER -- the design's "Mistakes" screen, over item_evidence.
 *
 * THE COUNT IS THE POINT: the design puts a badge in the navigation ("Mistakes 14"), and a badge is a
 * promise that the number is real. It comes from the server, and it is HIDDEN at zero rather than
 * showing a "0" that looks like a claim about the learner.
 *
 * NO CORRECT ANSWER IS SHOWN, because the client cannot obtain one: the key is not readable by the
 * learner's database role. Each row shows what the LEARNER answered, which is what makes a retry
 * meaningful.
 */
async function renderMistakes() {
  const ticket = contextTicket();
  // TWO badges, ONE truth: the sidebar and the phone tabbar each carry the count, and the ids are
  // distinct. The first version repeated `id="mistake-count"`, so `getElementById` only ever found the
  // sidebar one: at <=860px the sidebar is `display:none`, and the badge a phone learner needs was the
  // one that never updated.
  const badges = [el('mistake-count'), el('mistake-count-tab')].filter(Boolean);
  const box = el('mistake-list');
  const res = await api.practice.mistakes();
  if (!currentContext(ticket)) return;
  if (!res) return; // a 401 already redirected
  if (!res.ok) {
    if (box) { setShellHTML(box, ''); showError(() => (uiText("m117") + " " + failure(res) + '.')); }
    return;
  }
  const data = res.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const count = Number.isInteger(data.count) ? data.count : items.length;

  for (const badge of badges) {
    bindShellText(badge, () => String(count));
    // A badge reading 0 is noise, and it is also the one number a learner does not need told.
    badge.hidden = count === 0;
  }
  if (el('mistake-heading')) bindShellText(el('mistake-heading'), () => uiText("m118"));
  if (el('mistake-note')) {
    bindShellText(el('mistake-note'), () => count === 0
      ? uiText("m119")
      : uiText("m120"));
  }
  if (!box) return;
  if (!items.length) {
    setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m121\">Nichts offen</span></h3><p class=\"muted\"><span data-i18n=\"shell.m122\">Das ist eine Aussage des</span> "
      + "<span data-i18n=\"shell.m123\">Servers über Ihre eigenen Antworten, keine leere Seite.</span></p></div>");
    return;
  }
  // The design's `.list` carries the border and the radius, and only `.list-item:first-child` drops its
  // top border; bare `.list-item` rows therefore rendered as detached, separately bordered boxes.
  //
  // TWO LINES, TWO JOBS: the title is the SET, the sub-line says which SECTION and which item. They both
  // printed the title for a moment (setLabel returns an authored title unchanged), which duplicated it
  // and dropped the section.
  setShellHTML(box, '<div class="list">' + items.map((m) => '<div class="list-item"><div><strong>'
    + setLabelMarkup({ title: m.set_title, section: m.section, part: null })
    + '</strong><span class="sub">' + sectionMarkup(m.section) + ' &middot; ' + messageMarkup('version') + ' ' + esc(m.version) + ' &middot; ' + (/^g_/.test(m.item_id) ? messageMarkup("m124") : messageMarkup("m125") + " " + esc(m.item_id) + " " + messageMarkup("m094") + " " + m.set_item_count) + '</span></div>'
    + "<span class=\"chip chip-orange\"><span data-i18n=\"shell.m126\">Ihre Antwort:</span> " + esc(JSON.stringify(m.your_answer)) + '</span>'
    /*
     * REDESIGN-01 A/C: the server reveals the correct answer for an item this learner has already
     * answered (migration 0041, `reveal_objective_answer`). The key table stays unreadable; this is the
     * one item's answer, and only because this learner's own answer to it is on record. A row that
     * predates the field, or a backend that does not supply it, renders exactly as before.
     */
    + (m.correct_answer === undefined || m.correct_answer === null ? ''
      : "<span class=\"chip\"><span data-i18n=\"shell.m388\">richtige Antwort:</span> " + esc(JSON.stringify(m.correct_answer)) + '</span>')
    + '</div>').join('') + '</div>');
}


/** The skill views, and the section each one asks the server for. */
const SKILL_SECTIONS = { lesen: 'LV', sprachbausteine: 'SB', hoeren: 'HV', schreiben: 'writing' };

/**
 * One skill's practice, from the catalogue.
 *
 * Listening uses saved section runs so audio allowance and recovery have a durable attempt identity.
 * The stateless objective catalogue remains reading/language practice only.
 */
async function renderSkill(view) {
  const ticket = contextTicket();
  const section = SKILL_SECTIONS[view];
  const box = el('skill-' + view);
  if (!box || !section) return;
  /*
   * Entering a skill view starts at the LIST, and a set opened earlier is closed. Without this the
   * practice host kept the previous set on screen while the list re-rendered underneath it, so a
   * learner who switched skill saw the wrong task above the right catalogue.
   */
  const host = practiceHost(box);
  if (host) { host.hidden = true; setShellHTML(host, ''); }
  box.hidden = false;
  if (!activePreparation()) { setShellHTML(box, archivedPracticeNotice()); return; }
  setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m057\">Wird geladen ...</span></h3></div>");

  if (section === 'HV') { await mock.list(box, { section: 'HV' }); return; }

  if (section === 'writing') {
    const res = await api.tasks.list({ family: 'writing' });
    if (!currentContext(ticket)) return;
    if (!res) return;
    if (!res.ok) { setShellHTML(box, ''); showError(() => (uiText("m058") + " " + failure(res) + '.')); return; }
    const tasks = Array.isArray(res.data) ? res.data : [];
    setShellHTML(box, tasks.length
      ? tasks.map((t) => '<div class="card"><div class="card-head"><h3 ' + examTextAttributes() + '>' + esc(t.topic)
        + '</h3><span class="chip">' + messageMarkup('m005') + '</span></div>'
        + '<p class="muted" ' + examTextAttributes() + '>' + esc(t.situation) + '</p>'
        + '<p class="small muted"><span data-i18n="shell.m059">Anrede:</span> <span ' + examTextAttributes() + '>' + esc(t.adressat) + '</span> &middot; ' + reviewMarkup(t) + '</p>'
        /*
         * The binding travels WITH the button. A writing view that creates an attempt without it is bound
         * to the canonical default task, so the learner would read task B and have task A marked — the
         * failure mode where the screen is right and the record belongs to something else.
         */
        + '<button class="btn btn-primary" type="button" data-write="' + esc(t.task_id) + '"'
        + ' data-version="' + esc(t.version) + '" data-rubric="' + esc(t.rubric_id) + '"'
        + ' data-rubric-version="' + esc(t.rubric_version) + '">' + messageMarkup('m005') + '</button></div>').join('')
      : "<div class=\"card\"><h3><span data-i18n=\"shell.m127\">Zurzeit keine Schreibaufgaben</span></h3><p class=\"muted\"><span data-i18n=\"shell.m076\">Der Server hat gerade nichts Servierbares.</span></p></div>");
    box.onclick = (event) => {
      const button = event.target?.closest?.('[data-write]');
      if (!button) return;
      guard(openWriting(box, tasks.find((t) => t.task_id === button.dataset.write)));
    };
    return;
  }

  const res = await api.objectiveSets.list();
  if (!currentContext(ticket)) return;
  if (!res) return;
  if (!res.ok) { setShellHTML(box, ''); showError(() => (uiText("m058") + " " + failure(res) + '.')); return; }
  const sets = (Array.isArray(res.data) ? res.data : []).filter((s) => s.section === section);
  if (!sets.length) {
    setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m128\">Zurzeit keine Aufgaben</span></h3><p class=\"muted\"><span data-i18n=\"shell.m129\">Der Server hat für diesen</span> "
        + "<span data-i18n=\"shell.m130\">Bereich gerade nichts Servierbares.</span></p></div>");
    return;
  }
  setShellHTML(box, sets.map((s) => '<div class="card"><div class="card-head"><h3>' + setLabelMarkup(s)
    + '</h3><span class="chip">' + esc(s.family) + '</span></div>'
    + '<p class="muted">' + messageMarkup('tasks', {count:s.item_count}) + ' &middot; ' + messageMarkup('part', {part:s.part}) + ' &middot; ' + messageMarkup('version') + ' ' + esc(s.version) + '</p>'
    + '<p class="small muted">' + reviewMarkup(s) + '</p>'
    + '<button class="btn btn-primary" type="button" data-open="' + esc(s.set_id) + '" data-version="' + esc(s.version) + "\"><span data-i18n=\"shell.m062\">Üben</span></button></div>").join(''));
  box.onclick = (event) => {
    const button = event.target?.closest?.('[data-open]');
    if (button) guard(openSet(button.dataset.open, button.dataset.version));
  };
}


/**
 * PRACTICE -- answer one item at a time, marked by the server.
 *
 * The exact server interaction defines the form. Section/family labels do not select executable
 * behaviour: the same reading family can be a different shape in another exam package. Saved and
 * standalone practice share the item adapter, including each grouped question's own passage.
 *
 * THE CLIENT NEVER MARKS ANYTHING. It posts the answer and shows the boolean the server returns, which
 * comes from a SECURITY DEFINER function the learner's own database role could not replace.
 */
function objectiveForm(set) {
  const form = mockMember(set);
  if (!form) return null;
  return {
    interaction: set.interaction,
    passages: form.passage ? [{ label: uiText("m131"), lines: [form.passage] }] : [],
    options: form.options,
    items: form.items.map(item => ({ ...item, prompt: item.text })),
  };
}

/** Render the set, with a lettered choice per item. */
function renderObjectiveForm(set, host) {
  const form = objectiveForm(set);
  if (!form) {
    setShellHTML(host, "<div class=\"card\"><h3><span data-i18n=\"shell.m132\">Diese Aufgabenart wird noch nicht angezeigt</span></h3>"
      + "<p class=\"muted\"><span data-i18n=\"shell.m133\">Der Inhalt ist vorhanden; die Ansicht für diese Familie fehlt noch.</span></p></div>");
    return;
  }
  const instruction = INSTRUCTIONS[form.interaction];
  setShellHTML(host, (instruction ? instructionMarkup({ id: form.interaction, examLanguage: getExamLanguage() || 'und', original: instruction.examLanguage === getExamLanguage() ? instruction.original : '' }) : '') + (form.passages || []).map((passage) => '<section class="card"><div class="card-head"><h3>'
      + messageMarkup(passage.label) + '</h3></div>' + passage.lines.map((l) => '<p ' + examTextAttributes() + '>' + esc(l) + '</p>').join('') + '</section>').join('')
    + form.items.map((item, index) => {
      const options = item.options || form.options || [];
      return '<section class="card" data-item="' + esc(item.id) + "\"><p class=\"kicker\"><span data-i18n=\"shell.m125\">Aufgabe</span> "
        + (set.payload?.practice_kind === 'grammar-drill' ? index + 1 : esc(item.id)) + '</p>'
        + (item.passage ? '<div class="stimulus mock-passage" ' + examTextAttributes() + '>' + esc(item.passage) + '</div>' : '') + '<p ' + examTextAttributes() + '>' + esc(item.prompt) + '</p><div class="row">'
        /*
         * THE WHOLE OPTION, ON THE SCREEN.
         *
         * This rendered `o.label.slice(0, 40)` with the full text in `title=`, so the twelve ads of an
         * LV3 situation reached the learner as twelve fragments cut at the same column ("Möbeltransport
         * und Umzugshilfe: Zwei sta") and the only way to read one was to HOVER it — an affordance a
         * phone does not have, on the one screen where the learner has to compare the options to choose
         * between them. The label is authored content and is now rendered in full, as the text of the
         * button itself, with `.answer-option` (app.css) making it wrap inside the card instead of
         * widening the page. The letter (`o.id`) stays in the same text run, so scoring, `data-answer`
         * and the server key are untouched.
         *
         * REDESIGN-01 C: the tile carries its own state slots. `data-state` is set from the SERVER's
         * `correct` for the one option the learner picked, and the letter badge plus the verdict glyph are a
         * second, non-colour cue — colour alone is never the signal. The letter still opens the visible text
         * of the option and `data-answer` still holds the bare id, so scoring is unchanged.
         */
        + options.map((o) => '<button class="btn answer-option" ' + examTextAttributes() + ' type="button" data-answer="' + esc(o.id) + '"><span class="answer-letter" aria-hidden="true">' + esc(o.id) + ') </span>'
          + '<span class="answer-label">' + esc(o.label) + '</span><span class="answer-verdict" aria-hidden="true"></span></button>').join('')
        + '</div><p class="small muted result"></p></section>';
    }).join(''));
}

/** Post one answer and show what the SERVER said, not what the client guessed. */
async function answerItem(set, card, itemId, answer) {
  if (!bootReady || sessionProblem || !activePreparation() || preparationSwitching) return;
  const ticket = contextTicket();
  const request = (answerRequests.get(card) || 0) + 1, viewTicket = explanationContext;
  answerRequests.set(card, request); explanations.dispose(card);
  card.querySelector('[data-objective-explanation]')?.remove();
  const out = card.querySelector('.result');
  bindShellText(out, () => uiText("m134"));
  const res = await api.practice.answer(set.set_id, { version: set.version, itemId, answer });
  if (!currentContext(ticket) || !card.isConnected || viewTicket !== explanationContext || answerRequests.get(card) !== request) return;
  if (!res) return;
  if (!res.ok) {
    bindShellText(out, () => res.status === 422 && res.error === 'unknown_item'
      ? uiText("m135")
      : uiText("m136") + " " + failure(res) + '.');
    return;
  }
  const correct = res.data && res.data.correct === true;
  bindShellText(out, () => correct ? uiText("m137") : uiText("m138"));
  /*
   * REDESIGN-01 C/D — the navigator counts only what the server accepted: this runs after `res.ok`, so a
   * request that never answered increases nothing. The set id is checked so a response that arrives after
   * the learner opened a DIFFERENT set cannot move the new set's counter. The summary appears on the last
   * item and is guarded by `partSummaryRendered`, because answering the last item again must not stack a
   * second summary under the first.
   */
  if (res.ok && setProgress.setId === set.set_id) {
    setProgress.answered += 1;
    if (correct) setProgress.correct += 1;
    const box = card.closest('.skill-practice') || card.parentElement;
    renderNavigator(box);
    if (setProgress.answered >= setProgress.total) renderPartResult(box);
  }
  /*
   * REDESIGN-01 C — THE TILE STATES, FROM THE SERVER'S ANSWER ONLY.
   *
   * Every state below comes from `res`: `data.correct` is the server's mark for the option the learner
   * picked, and `data.correct_answer` is the option the key holds. The client guesses nothing and marks
   * nothing on its own; before a response the tiles carry no `data-state` at all. The row gets
   * `data-answered` so the stylesheet can dim the options that were not part of this answer without
   * hiding any of them.
   */
  const revealed = res.data ? res.data.correct_answer : undefined;
  const tiles = [...card.querySelectorAll('.answer-option')];
  if (tiles.length) card.querySelector('.row')?.setAttribute('data-answered', 'true');
  for (const tile of tiles) {
    const id = tile.getAttribute('data-answer');
    const isPicked = id === String(answer);
    const isRight = revealed !== undefined && revealed !== null && id === String(revealed);
    tile.setAttribute('aria-pressed', String(isPicked && correct));
    if (isPicked && correct) tile.dataset.state = 'correct';
    else if (isPicked) tile.dataset.state = 'wrong';
    else if (isRight) tile.dataset.state = 'was-correct';
  }
  /*
   * REDESIGN-01 A/C — THE VERDICT BOX SHOWS WHAT WAS RIGHT.
   *
   * "Noch nicht richtig" alone left the learner with the question and no answer, which is the one thing
   * the practice loop could not tell them (the key is not readable by this role). The server now returns
   * `correct_answer` for the item just answered, through `reveal_objective_answer` (migration 0041), so
   * the verdict can say what the right option was. Absent field -> the old markup, exactly as before.
   */
  const revealedLine = revealed;
  if (revealedLine !== undefined && revealedLine !== null) {
    const line = document.createElement('p');
    line.className = 'revealed-answer';
    // One binding owns the whole line, so a locale change re-reads both the label and the value rather
    // than leaving a stale label inside markup (bindShellText replaces the node's single text node).
    bindShellText(line, () => uiText("m388") + ' ' + JSON.stringify(revealedLine));
    out.after(line);
  }
  if (res.data?.evidence_id) {
    const target = document.createElement('div'); target.dataset.objectiveExplanation = res.data.evidence_id; out.after(target);
    explanations.mount(target, { read: language => api.practice.explanation(res.data.evidence_id, language),
      isCurrent: () => answerRequests.get(card) === request && currentContext(ticket) && viewTicket === explanationContext });
  }
  // The badge is a promise; refresh it so it stays true after every answer.
  guard(renderMistakes());
}

/**
 * The practice host of a skill view — a SIBLING of the list, so `renderSkill`'s innerHTML cannot
 * delete it, and per-view, so a set opened in Leseverstehen can never render into Schreiben.
 */
function practiceHost(box) {
  return box?.parentElement?.querySelector('.skill-practice') || null;
}

/*
 * REDESIGN-01 C/D — THE RUN NAVIGATOR AND THE PART RESULT.
 *
 * One small state object per OPEN SET, cleared by `openSet`, so a set that is closed and reopened never
 * inherits a count. It counts what the SERVER accepted: an answer whose response did not arrive is not
 * counted, because the screen must not claim progress the record does not have. `partSummaryRendered`
 * keeps the summary from being re-appended when a learner answers the last item twice.
 */
let setProgress = { setId: null, answered: 0, correct: 0, total: 0, partSummaryRendered: false };

function renderNavigator(host) {
  const line = host?.querySelector('#practice-progress');
  if (!line) return;
  bindShellText(line, () => uiText('m390', { answered: setProgress.answered, total: setProgress.total }));
}

function renderPartResult(host) {
  const target = host?.querySelector('#practice-part-result');
  if (!target || setProgress.partSummaryRendered) return;
  setProgress.partSummaryRendered = true;
  target.hidden = false;
  setShellHTML(target, '<div class="card card-peach part-result"><p class="kicker">' + messageMarkup('m392') + '</p>'
    + '<p class="part-result-count">' + messageMarkup('m391', { correct: setProgress.correct, total: setProgress.total }) + '</p>'
    + '<a class="btn btn-primary" href="#/ueben">' + messageMarkup('m389') + '</a></div>');
}

/** Open one set of the skill currently on screen. */
async function openSet(setId, version) {
  if (!activePreparation() || preparationSwitching) return;
  if (!bootReady || sessionProblem) return;
  if (typeof version !== 'string' || !version.trim()) {
    showError(() => (uiText("m067")));
    return;
  }
  const request = ++objectiveRequest;
  const navigation = routing;
  // The container belongs to the VIEW THAT IS OPEN, not to one shared id. A single id put the form
  // inside whichever section happened to contain it last, so a set opened from Leseverstehen rendered
  // into the HIDDEN Schreiben section -- a form nobody could see, and a bug no class-name check would
  // have caught.
  const box = document.querySelector('.view:not([hidden]) .skill-practice');
  if (!box) return;
  /*
   * ONE THING AT A TIME, as the design does: the list is REPLACED by the set, not followed by it.
   *
   * The form was rendered after the list, so a learner who pressed "Üben" saw nothing happen: the task
   * was below nine cards, off the bottom of the screen. The DOM was correct and every class-name
   * assertion passed — the SCREENSHOT is what showed it.
   */
  const list = box.parentElement?.querySelector('.stack[id^="skill-"]');
  if (list) list.hidden = true;
  box.hidden = false;
  explanations.dispose(box);
  setShellHTML(box, "<div class=\"card\"><h3><span data-i18n=\"shell.m057\">Wird geladen ...</span></h3></div>");
  window.scrollTo(0, 0);
  const res = await api.objectiveSets.read(setId, version);
  if (!res || request !== objectiveRequest || navigation !== routing || sessionProblem) return;
  if (!res.ok) {
    setShellHTML(box, '');
    if (list) list.hidden = false;
    showError(() => (uiText("m139") + " " + failure(res) + '.'));
    return;
  }
  const set = res.data;
  if (set?.set_id !== setId || set?.version !== version) {
    setShellHTML(box, '');
    if (list) list.hidden = false;
    showError(() => (uiText("m140")));
    return;
  }
  /*
   * REDESIGN-01 C/D — the run navigator lives in the set's own head, and the part result is a sibling of
   * the items so it can be revealed without touching them.
   */
  setProgress = { setId: set.set_id, answered: 0, correct: 0, total: set.item_count, partSummaryRendered: false };
  setShellHTML(box, '<div class="card"><div class="card-head"><h3>' + setLabelMarkup(set)
    + '</h3><span class="chip">' + esc(set.family) + ' · ' + messageMarkup('version') + ' ' + esc(set.version) + '</span></div>'
    + '<p class="small muted" id="practice-progress" role="status" aria-live="polite"></p>'
    + "<button class=\"btn\" type=\"button\" id=\"practice-close\"><span data-i18n=\"shell.m141\">Schließen</span></button></div>"
    + '<div class="stack" id="practice-items"></div>'
    + '<div id="practice-part-result" hidden></div>');
  renderObjectiveForm(set, box.querySelector('#practice-items'));
  renderNavigator(box);
  /*
   * ASSIGNMENT, not addEventListener. `box` is the same element for the whole life of the view, so an
   * added listener accumulated one per set opened: opening a second set made one answer POST twice,
   * and the evidence table would record the learner answering once and being charged twice.
   */
  box.onclick = (event) => {
    const answer = event.target?.dataset?.answer;
    const card = event.target?.closest('[data-item]');
    if (answer && card) guard(answerItem(set, card, card.dataset.item, answer));
  };
  box.querySelector('#practice-close')?.addEventListener('click', () => {
    objectiveRequest++;
    explanations.dispose(box);
    box.hidden = true;
    setShellHTML(box, '');
    if (list) list.hidden = false;
    // The run is over: a reopened set must start at zero rather than inherit this run's count.
    setProgress = { setId: null, answered: 0, correct: 0, total: 0, partSummaryRendered: false };
  });
}

/*
 * THE LABEL AND THE CRITERION NAMES, in the interface language.
 *
 * The label is required by the decision that defined the band contract: this is practice feedback against
 * telc's criteria and is NOT an official assessment. The criterion NAMES are the published structure's own
 * names; the descriptors behind them are this product's own wording (see the rubric in
 * `server/owned-postgres/content-seed.mjs`) and are deliberately not rendered here as if they were telc's.
 *
 * A key with no label falls back to the RAW KEY on screen: an unknown criterion must be VISIBLE rather than
 * silently dropped, because a missing row looks like a criterion nobody marked.
 */
const TELC_FEEDBACK_LABEL = uiText("m142");
const CRITERION_LABELS = Object.freeze({
  aufgabe: uiText("m143"),
  kommunikation: uiText("m144"),
  richtigkeit: uiText("m145"),
});

/*
 * ============================================================ writing (PILOT-05)
 *
 * THE FIRST SCREEN IN THIS CLIENT THAT CAN SUBMIT LEARNER TEXT. It exists because the gap was recorded
 * and measurable: the Schreiben view listed the six seeded prompts and NOTHING could open one, so
 * draft → submission → result had no UI at all. Four properties are the reason this function is written
 * the way it is, and each is a defect this programme has already met once:
 *
 *   1. THE DRAFT IS SAVED AGAINST A REVISION. The API has no "submit text" route — a submission freezes
 *      the revision it is given — so the view must save first and carry the revision it was told. A 409
 *      means another device (or a stale tab) moved the draft: the learner is told, and their text is NOT
 *      thrown away.
 *   2. NOTHING IS INVENTED WHILE THE ASSESSMENT IS MISSING. A queued or failed job renders as
 *      "unbewertet" or "wird geprüft" — never a score, never a total, never a pass line. That is the
 *      property `mock-outcome-browser-check` used to hold before it was deleted with the SPA.
 *   3. THE SUBMITTED TEXT STAYS ON SCREEN. The learner can still read what they sent, which is the
 *      property the deleted check asserted as "submitted text stays accessible".
 *   4. THE BINDING IS THE TASK THAT WAS OPENED, down to the version and the rubric the task declares.
 *      The server refuses anything else (422 task_not_servable), and the button carries it.
 */
const writingApi = { ...api, mock: { ...api.mock, read: (runId, language = state.settings?.language || 'de') => api.mock.read(runId, language) }, writing: { ...api.writing, result: async (submissionId, language = state.settings?.language || 'de') => {
  const ticket = contextTicket();
  const result = await api.writing.result(submissionId, language);
  if (currentContext(ticket) && bootReady) guard(refreshCredits());
  return result;
} } };
const mock = createMockController({ api: writingApi, esc, setLabel, setLabelLanguage: set => hasAuthoredSetTitle(set) ? getExamLanguage() || 'und' : getLocale(), readAloud, explanations, getExamLanguage, explanationLanguage: () => state.settings?.language || 'de', canEdit: () => activePreparation() && !sessionProblem, isArchived: () => state.preparation?.state === 'archived', onOpen: run => { location.hash = '#/lauf/' + run.id; } });
window.addEventListener('beforeunload', event => mock.preserveOnUnload(event));
const writing = createWritingController({ api: writingApi, esc, readAloud, explanations, getExamLanguage, onChange: () => { guard(refreshCredits()); if (currentView === 'verlauf') guard(renderHistory()); } });
// PAYMENTS-SLICE-01. `onChange` re-reads the credit line, because a granted pass is exactly the thing
// that line shows; it never writes a learner state anywhere.
const checkout = createCheckoutController({ api, esc, onChange: () => { if (state.preparation) guard(refreshCredits()); }, beforeRedirect: async () => {
  const ticket = contextTicket();
  return await writing.flush() && await mock.flush() && currentContext(ticket);
}, canContinue: () => !sessionProblem && !preparationSwitching });

function acceptLocaleSettings(data, { persist = false } = {}) {
  if (sessionProblem || !validLocale(data?.settings?.language) || !Number.isInteger(data.revision)
    || (Number.isInteger(state.revision) && data.revision < state.revision)) return;
  const changed = getLocale() !== data.settings.language;
  state.settings = data.settings; state.revision = data.revision;
  setLocale(data.settings.language, { persist });
  el('language').value = data.settings.language;
  el('header-language').value = data.settings.language;
  if (changed) explanations.refresh(data.settings.language);
}
const localePreference = createLocalePreference({
  read: () => api.settings.read(), write: (revision, patch) => api.settings.write(revision, patch),
  context: () => [state.account?.id, accountGeneration, sessionProblem].join('|'),
  confirmed: () => ({ settings: state.settings, revision: state.revision }), accept: acceptLocaleSettings,
  changed: ({ state: status, busy, unresolved }) => {
    const key = { saving: 'm185', reconciling: 'reconciling', saved: 'm196', reconciled: 'reconciled', conflict: 'conflict', unresolved: 'unresolved', failed: 'm195' }[status];
    bindShellText(el('locale-state'), () => key ? uiText(key) : '');
    el('locale-reload').hidden = !unresolved;
    el('header-language').disabled = busy || unresolved || Boolean(sessionProblem);
    el('language').disabled = busy || unresolved || settingsSaving || Boolean(sessionProblem);
    el('header-language').value = getLocale();
  },
});

function updateLocaleLabels() {
  updateShellMessages();
  updatePracticeLocale(document, getLocale());
  translateInstructions(document);
  for (const node of document.querySelectorAll('[data-shell-review]')) {
    const facts = JSON.parse(node.dataset.reviewFacts);
    node.textContent = node.dataset.shellReview === 'history' ? reviewHistoryNotice(facts) : contentReviewLabel(facts);
  }
  writing.updateLocale?.(getLocale()); mock.updateLocale?.(getLocale());
  explanations.updateLocale?.(getLocale()); readAloud.updateLocale?.(getLocale());
  sentenceCheck?.updateLocale?.(getLocale()); checkout.updateLocale(getLocale());
  readAloud.stop();
  el('header-language').value = getLocale();
  // Option identities and the chosen preparation are preserved.
  for (const option of el('preparation-picker').options) {
    const choice = preparationChoices(state.exams, state.preparations).find(row => row.id === option.value);
    if (choice) option.textContent = choice.label;
  }
  for (const notice of document.querySelectorAll('[data-material-unavailable]')) notice.hidden = ['de', 'en'].includes(getLocale());
}
const unsubscribeLocale = subscribeLocale(updateLocaleLabels);
window.addEventListener('pagehide', event => {
  if (event.persisted) localePreference.suspend();
  else { unsubscribeLocale(); localePreference.cancel(); }
  readAloud.stop();
});
window.addEventListener('pageshow', event => {
  // The API retains its account fence. A restored document must reread authority before another save.
  if (event.persisted && state.account && !sessionProblem) guard(localePreference.reconcile());
});
el('header-language').addEventListener('change', event => {
  if (!bootReady || sessionProblem || settingsSaving || preparationSwitching) { event.target.value = getLocale(); return; }
  guard(localePreference.save(event.target.value));
});
el('locale-reload').addEventListener('click', () => guard(localePreference.reconcile()));
async function openWriting(box, task, options = {}) {
  if (!activePreparation() || preparationSwitching) return false;
  // Keep the task catalogue as a sibling of the editor so closing a letter can restore it.
  return writing.open(box.id.startsWith('skill-') ? practiceHost(box) : box, task, options);
}
function archivedPracticeNotice() {
  return "<div class=\"card\"><h3><span data-i18n=\"shell.m146\">Diese Vorbereitung ist archiviert</span></h3><p><span data-i18n=\"shell.m147\">Neue Übungen sind hier nicht möglich. Ihre gespeicherten Texte und Rückmeldungen bleiben im Verlauf lesbar.</span></p><a class=\"btn\" href=\"#/verlauf\"><span data-i18n=\"shell.m101\">Verlauf öffnen</span></a></div>";
}

async function openArchivedWriting(entry) {
  const ticket = contextTicket(), host = el('history-detail');
  const request = ++archivedRequest, viewTicket = explanationContext;
  const current = () => currentContext(ticket) && currentView === 'verlauf' && archivedRequest === request && explanationContext === viewTicket;
  explanations.dispose(host);
  host.hidden = false;
  setShellHTML(host, "<p class=\"muted\"><span data-i18n=\"shell.m148\">Gespeicherter Text wird geladen …</span></p>");
  const response = entry.submission_id ? await writingApi.writing.result(entry.submission_id) : await api.writing.readAttempt(entry.id);
  if (!current()) return;
  if (!response?.ok) {
    setShellHTML(host, "<p class=\"err\"><span data-i18n=\"shell.m149\">Der gespeicherte Text konnte nicht geladen werden.</span></p><button class=\"btn\" id=\"archived-refresh\" type=\"button\"><span data-i18n=\"shell.m150\">Erneut laden</span></button>");
  } else {
    const data = response.data, feedback = data.assessment?.feedback;
    let result = '';
    const feedbackState = writingFeedbackState(data);
    if (feedbackState === 'assessed' && feedback) {
      result = "<p class=\"small muted\"><span data-i18n=\"shell.m151\">Übungsfeedback – keine offizielle Bewertung. Die Rückmeldung im lokalen Pilot stammt aus einer technischen Simulation.</span></p>";
      result += Array.isArray(feedback.criteria) ? '<ul class="criteria">' + feedback.criteria.map(c => { const view = writingCriterion(c, data.rubric); return '<li><strong>'
        + '<span ' + examTextAttributes() + '>' + esc(view.label) + '</span>' + ": <span class=\"band\"><span class=\"sr-only\"><span data-i18n=\"shell.m152\">Band</span> </span>" + esc(view.band) + '</span></strong>'
        + (c.evidence ? '<blockquote class="evidence" ' + examTextAttributes() + '>' + esc(c.evidence) + '</blockquote>' : '') + '</li>'; }).join('') + '</ul>' : '';
    } else if (feedbackState === 'blocked') result = "<p><span data-i18n=\"shell.m153\">Die Aufgabe und Rückmeldung sind zurzeit gesperrt. Ihr Text bleibt erhalten.</span></p>";
    else if (['failed', 'unassessed'].includes(feedbackState)) result = "<p><span data-i18n=\"shell.m154\">Unbewertet. Ihr abgegebener Text bleibt erhalten.</span></p>";
    else if (entry.submission_id) result = "<p><span data-i18n=\"shell.m155\">Die Rückmeldung wird vorbereitet. Sie können den Stand erneut laden.</span></p>";
    if (feedbackState === 'assessed' && data.review_withdrawn) result += '<p class="hint" data-review-withdrawn>' + reviewMarkup(data, true) + '</p>';
    setShellHTML(host, '<article class="card"><h3>' + (entry.topic ? '<span ' + examTextAttributes() + '>' + esc(entry.topic) + '</span>' : messageMarkup("m156")) + "</h3><p class=\"small muted\"><span data-i18n=\"shell.m157\">Archiv · schreibgeschützt</span></p><div class=\"archived-writing\" "+ examTextAttributes() + ">"
      + esc(entry.submission_id ? data.submission?.text || '' : data.text || '') + '</div>' + result + (entry.submission_id ? '<div data-archived-explanation></div>' : '')
      + "<div class=\"row\"><button class=\"btn\" id=\"archived-refresh\" type=\"button\"><span data-i18n=\"shell.m158\">Stand erneut laden</span></button><button class=\"btn\" id=\"archived-close\" type=\"button\"><span data-i18n=\"shell.m141\">Schließen</span></button></div></article>");
    if (entry.submission_id) explanations.mount(host.querySelector('[data-archived-explanation]'), { view: data.explanation_view, labels: writingExplanationLabels(data), labelLanguage: getExamLanguage(), isCurrent: current,
      read: async language => { const r = await api.writing.result(entry.submission_id, language); return { ...r, data: r?.data?.explanation_view, parent: r?.data }; },
      onConfirmed: parent => {
        if (!parent || !current()) return;
        if (parent.blocked_reason) { host.querySelector('.criteria')?.remove(); host.querySelector('[data-review-withdrawn]')?.remove(); bindShellText(host.querySelector('h3'), () => uiText("m156")); }
        else if (parent.review_withdrawn && !host.querySelector('[data-review-withdrawn]')) { const notice = document.createElement('p'); notice.className = 'hint'; notice.dataset.reviewWithdrawn = ''; bindShellText(notice, () => reviewHistoryNotice(parent)); host.querySelector('[data-archived-explanation]').before(notice); }
      },
    });
    el('archived-close').onclick = () => { archivedRequest++; explanations.dispose(host); host.replaceChildren(); host.hidden = true; };
  }
  el('archived-refresh').onclick = () => guard(openArchivedWriting(entry));
}
/**
 * CHECKOUT (PAYMENTS-SLICE-01). One render function, and it decides nothing itself: the
 * controller asks the server what is on sale and renders the documented answer — including
 * `payments_unavailable` (503), which is the pilot's default and therefore the state most learners
 * will see. An unwired port is a fact about the installation, not an error the learner caused, so it
 * is not allowed to reach the shell's error strip.
 *
 * The exam is the active preparation's, because a pass is bought for an exam. `market` is the only
 * purchasing input the client has, and it is a LABEL rather than a price: the price lives in a server
 * row, and the client must never send an amount, a currency or a price id (contract §7).
 */
async function renderCheckout(info = preparationRoute()) {
  const host = el('checkout-host');
  if (!host) return;
  const prep = state.preparation;
  if (!prep?.exam_id && !info.orderId && !info.invalid) {
    setShellHTML(host, "<div class=\"card\"><h3><span data-i18n=\"shell.m159\">Keine Prüfung ausgewählt</span></h3><p class=\"small muted\"><span data-i18n=\"shell.m160\">Wählen Sie zuerst eine Prüfungsvorbereitung.</span></p></div>");
    return;
  }
  await checkout.open(host, {
    examId: prep?.exam_id,
    examLabel: prep?.exam || state.exams.find(exam => exam.exam_id === prep?.exam_id)?.exam || prep?.exam_id,
    orderId: info.orderId,
    invalid: info.invalid,
  });
}

async function renderHistory() {
  const ticket = contextTicket();
  const host = el('history-list');
  setShellHTML(host, "<p class=\"muted\"><span data-i18n=\"shell.m161\">Ihr Verlauf wird geladen …</span></p>");
  const [history, progress, runs] = await Promise.all([api.writing.listAttempts(), api.practice.progress(), api.mock.list()]);
  if (currentView !== 'verlauf' || !currentContext(ticket)) return;
  setShellHTML(el('mock-history'), "<h2><span data-i18n=\"shell.m006\">Gespeicherte Prüfungsläufe</span></h2>" + (runs?.ok ? mock.historyMarkup(runs.data?.runs || []) : "<p class=\"err\"><span data-i18n=\"shell.m162\">Die gespeicherten Läufe konnten nicht geladen werden.</span></p>"));
  if (!history?.ok) { setShellHTML(host, "<p class=\"err\"><span data-i18n=\"shell.m163\">Der Verlauf konnte nicht geladen werden. Bitte öffnen Sie die Ansicht erneut.</span></p>"); return; }
  const totals = progress?.ok ? progress.data?.totals : null;
  bindShellText(el('history-summary'), () => totals ? uiText('answers', {count:totals.attempts}) + ' · ' + totals.correct + ' ' + uiText('m164') : uiText("m165"));
  const rows = history.data.attempts || [];
  const statuses = { draft: uiText("m166"), pending: uiText("m167"), unassessed: uiText("m168"), assessed: uiText("m169") };
  setShellHTML(host, rows.length ? rows.map(a => '<article class="card"><div class="card-head"><h3>' + (a.topic ? '<span ' + examTextAttributes() + '>' + esc(a.topic) + '</span>' : messageMarkup("m170")) + '</h3><span class="chip">' + messageMarkup(statuses[a.status] || a.status) + '</span></div><p class="small muted">' + esc(new Date(a.created_at).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })) + (a.parent_submission_id ? " " + messageMarkup("m171") : '') + '</p><button type="button" class="btn" data-attempt="' + esc(a.id) + '">' + (a.submission_id ? messageMarkup("m172") : messageMarkup("m173")) + '</button></article>').join('') : "<div class=\"card\"><h3><span data-i18n=\"shell.m174\">Noch keine Schreibübungen</span></h3><p><span data-i18n=\"shell.m175\">Beginnen Sie mit einer Aufgabe. Ihr Entwurf und jede Abgabe bleiben hier erreichbar.</span></p><a class=\"btn btn-primary\" href=\"#/schreiben\"><span data-i18n=\"shell.m176\">Schreiben üben</span></a></div>");
  host.onclick = async (event) => {
    if (!currentContext(ticket)) return;
    const target = event.target.closest('[data-attempt]'); if (!target) return;
    const entry = rows.find(a => a.id === target.dataset.attempt); if (!entry) return;
    if (entry.mock_run_id) { location.hash = '#/lauf/' + entry.mock_run_id; return; }
    if (!activePreparation()) { await openArchivedWriting(entry); return; }
    const task = { task_id: entry.task_id, version: entry.task_version, rubric_id: entry.rubric_id, rubric_version: entry.rubric_version, topic: entry.topic };
    if (entry.submission_id) await openWriting(el('history-detail'), task, { submissionId: entry.submission_id });
    else await openWriting(el('history-detail'), task, { attemptId: entry.id });
  };
  if (!activePreparation()) {
    for (const button of host.querySelectorAll('[data-attempt]')) if (button.textContent === uiText("m173")) bindShellText(button, () => uiText("m177"));
    host.querySelector('a[href="#/schreiben"]')?.remove();
  }
}
/*
 * NAV-01 — module views.
 *
 * Slices E/F (Nachschlagen) and D (Probeprüfung) ship as their own modules so that one file never has two
 * writers, following the frozen interface in docs/contracts/MIRROR-B1PREP-01.md §4.2. The shell owns the
 * route, the section and the topbar; a module owns everything inside its own host and its own stylesheet.
 * The import is guarded: while a module is absent, or fails to load, the interim renderer stays on screen,
 * so no sidebar entry can point at a blank page.
 */
const MODULE_VIEWS = {
  nachschlagen: { specifier: './library.js', factory: 'createLibraryView', css: 'library.css', host: 'library-host', covers: ['guide-index', 'guide-body'] },
  probepruefung: { specifier: './mock-intro.js', factory: 'createMockIntroView', css: 'mock-intro.css', host: 'mock-intro-host', covers: [] },
  /* Slice B (PRACTICE-UI-01). Until public/app/part-index.js lands the guarded import fails and the interim
     four-part list stays on screen, so the route is never blank. Hören is the same module with a different
     host: the module keys its filter off the host it was given, which keeps "Hören is Prüfungsteile filtered
     to HV" one implementation. */
  pruefungsteile: { specifier: './part-index.js', factory: 'createPartIndexView', css: 'part-index.css', host: 'part-index-host', covers: [] },
  hoeren: { specifier: './part-index.js', factory: 'createPartIndexView', css: 'part-index.css', host: 'hoeren-host', covers: ['skill-hoeren'] },
  /* Slice G (VOCAB-01). Until public/app/vocab.js lands the guarded import fails and the dictionary stays. */
  wortschatz: { specifier: './vocab.js', factory: 'createVocabView', css: 'vocab.css', host: 'vocab-host', covers: ['dict-interim-head', 'dict-interim-search', 'dict-results'] },
  /* Slice H (DRILL-01). One item at a time with instant feedback; the interim recommendation, catalogue and
     cross-link stay visible until the module is present. */
  ueben: { specifier: './drill.js', factory: 'createDrillView', css: 'drill.css', host: 'drill-host', covers: ['ueben-more-link', 'practice-next', 'task-list'] },
};
let mountedModule = null;
let mountedView = null;

function loadModuleStylesheet(href) {
  if (document.querySelector('link[data-module-style="' + href + '"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.moduleStyle = href;
  document.head.append(link);
}

/** Un-mount a module view and restore whatever section it covered. Idempotent. */
function unmountModule() {
  if (mountedModule && typeof mountedModule.unmount === 'function') {
    try { mountedModule.unmount(); } catch (err) { /* a failed teardown must not block the next screen */ }
  }
  mountedModule = null;
  const spec = mountedView ? MODULE_VIEWS[mountedView] : null;
  if (spec) {
    const host = el(spec.host);
    if (host) host.hidden = true;
    for (const id of spec.covers) { const node = el(id); if (node) node.hidden = false; }
  }
  mountedView = null;
}

/**
 * PILOT-FEEDBACK-01 (FB-C). The report sheet is a SHELL affordance, not a view: no route and no MODULE_VIEWS
 * entry, opened from the top bar and from Werkzeuge over whatever page the learner is on.
 *
 * INSTALLED ONLY AFTER A SUCCESSFUL BOOT, which is also what makes the contract's "every signed-in view and no
 * public page" true: the public pages are separate documents and never load this file at all. A failure to load
 * is silent on purpose — the app must work even if the sheet cannot, and this feature must never be the reason a
 * learner cannot reach their work.
 */
let feedbackInstalled = false;
async function installFeedback() {
  if (feedbackInstalled) return;
  feedbackInstalled = true;
  let module;
  try { module = await import('./feedback.js'); } catch (err) { return; }
  loadModuleStylesheet('feedback.css');
  module.installFeedbackEntryPoints({ api, uiText, esc, route: () => currentView });
}

/** True when the view's module rendered; false leaves the caller's interim implementation in place. */
async function mountModule(view) {
  const spec = MODULE_VIEWS[view];
  const host = spec ? el(spec.host) : null;
  if (!spec || !host || sessionProblem) return false;
  let module;
  try { module = await import(spec.specifier); } catch (err) { return false; }
  /* The learner may have navigated while the module was in flight; a late mount would paint over it. */
  if (currentView !== view || sessionProblem) return true;
  const create = module[spec.factory];
  if (typeof create !== 'function') return false;
  unmountModule();
  loadModuleStylesheet(spec.css);
  for (const id of spec.covers) { const node = el(id); if (node) node.hidden = true; }
  host.hidden = false;
  try {
    mountedModule = create({
      api, uiText, esc, state, guideContent,
      language: state.settings?.language || 'de',
      /* Amendment A3: every module gets the exam language, so an authored German fragment stays an
         exam-language island for assistive tech. REVIEW-MOCK-01 D1 found this member missing. */
      examLanguage: getExamLanguage() || 'und',
      navigate: (hash) => { location.hash = hash; },
    });
    mountedModule.mount(host);
  } catch (err) {
    mountedModule = null;
    host.hidden = true;
    for (const id of spec.covers) { const node = el(id); if (node) node.hidden = false; }
    return false;
  }
  mountedView = view;
  return true;
}

let routing = 0;

async function route() {
  if (!bootReady || sessionProblem) return;
  const request = ++routing;
  let info = resolveView(preparationRoute());
  if (preparationSwitching || settingsSaving) {
    pendingPreparationNavigation = { selection: info.id || state.preparation.id, view: VIEW_TITLES[info.view] ? info.view : 'heute', runId: info.runId, checkoutPath: info.path || null };
    return;
  }
  if (mock.active && !(info.view === 'abschnitt' && info.runId === mock.runId)) {
    if (!(await mock.flush())) { history.replaceState(null, '', '#/prep/' + state.preparation.id + '/abschnitt/' + mock.runId); return; }
    if (request !== routing) return;
  }
  if (info.runId) {
    const saved = await api.mock.read(info.runId);
    if (request !== routing || sessionProblem) return;
    if (!saved?.ok) { showError(() => (uiText("m037"))); return; }
    info = { ...info, id: saved.data.preparation_id };
  }
  if (info.id && info.id !== state.preparation?.id) { await switchPreparation(info.id, info.view, info.runId); return; }
  readAloud.stop();
  if (writing.active) {
    if (!(await writing.flush()) || !(await mock.flush())) { history.replaceState(null, '', '#/prep/' + state.preparation.id + '/' + currentView + (mock.runId ? '/' + mock.runId : '')); return; }
    if (request !== routing) return;
    writing.dispose();
  }
  if (mock.active && info.view === 'abschnitt' && info.runId === mock.runId) { history.replaceState(null, '', '#/prep/' + state.preparation.id + '/abschnitt/' + mock.runId); return; }
  explanationContext++; archivedRequest++; explanations.dispose();
  mock.dispose();
  // The checkout is a screen, not a draft: leaving it drops an in-flight poll and its host content,
  // because a status line that kept updating on another view would be a claim about a screen nobody
  // is looking at.
  if (checkout.active && info.view !== 'checkout') checkout.dispose();
  let key = info.view;
  if (key === 'sprachbausteine') {
    // A hidden link alone cannot prevent a saved URL or an exam switch retaining this route.
    // Resolve from this preparation's catalogue only after the outgoing work is saved.
    const available = await refreshSectionNavigation();
    if (request !== routing || sessionProblem) return;
    if (available === false) key = 'ueben';
  }
  const view = VIEW_TITLES[key] ? key : 'heute';
  /*
   * Which view is on screen, so a SLOW failure cannot paint on the wrong one.
   *
   * Clearing the message here is not enough on its own: a render from the view the learner just left can
   * still reject a second later, and its message would appear over the new screen — describing something
   * that is no longer on display. The token is checked before anything is written.
   */
  currentView = view;
  if (view !== 'checkout') history.replaceState(null, '', '#/prep/' + state.preparation.id + '/' + view + (info.runId ? '/' + info.runId : ''));
  else if (!info.invalid) history.replaceState(null, '', info.orderId ? info.path.slice('/app/'.length) : '#/checkout');
  for (const name of Object.keys(VIEW_TITLES)) {
    const node = el(`view-${name}`);
    if (node) node.hidden = name !== view;
  }
  /* "Ihre Vorbereitung" belongs to Heute. On every other view it repeated a third of the screen. */
  const preparationCard = el('preparation-context');
  if (preparationCard) preparationCard.hidden = view !== 'heute';
  const groupNode = el('crumb-group');
  if (groupNode) groupNode.hidden = !NAV_GROUP[view];
  bindShellText(el('crumb-group-name'), () => (NAV_GROUP[view] ? uiText(GROUP_LABEL[NAV_GROUP[view]]) : ''));
  const crumbRoot = el('crumb-root');
  if (crumbRoot) {
    crumbRoot.lang = getExamLanguage() || 'de';
    crumbRoot.dir = getExamLanguage() === 'ar' ? 'rtl' : 'ltr';
    bindShellText(crumbRoot, () => state.preparation?.exam || 'Deutsch B1');
  }
  bindShellText(el('page-title'), () => uiText(VIEW_TITLES[view]));
  renderChrome();
  guard(refreshCredits());
  showError('');
  /*
   * Every render is a promise that can reject, and `void renderX()` would throw the rejection away:
   * the view then sits on "Wird geladen …" with an empty console-shaped silence and nothing on screen
   * explains it. One wrapper, so a failure is always visible where it happened.
   */
  const run = (render, token = view) => {
    void render().catch((err) => {
      if (token === currentView) showError(() => (uiText("m178") + " " + (err && err.message ? err.message : err)));
    });
  };
  /* Leaving a module view tears it down before the next screen paints. */
  if (mountedModule && mountedView !== view) unmountModule();
  /*
   * A bare saved-runs address resolves to Probeprüfung (resolveView), so 'abschnitt' is only ever reached
   * with a run id: it is the run player. There is deliberately no list branch here.
   */
  if (view === 'abschnitt' && info.runId) run(() => mock.showRun(el('mock-host'), info.runId));
  if (view === 'pruefungsteile') run(renderPartIndex);
  if (view === 'hoeren') run(renderHoerenIndex);
  if (view === 'probepruefung') run(renderProbepruefung);
  if (view === 'heute') run(renderDashboard);
  if (view === 'ueben') run(renderUeben);
  /* Hören owns its own dispatch above, so the skill branch must not also render it. */
  if (view !== 'hoeren' && SKILL_SECTIONS[view]) run(() => renderSkill(view));
  if (view === 'fehler') run(renderMistakes);
  /* Verlauf is the history sub-page of Heute: the old #/fortschritt route aliases onto it. */
  if (view === 'verlauf') run(renderHistory);
  if (view === 'wortschatz') run(renderWortschatz);
  if (view === 'nachschlagen') run(renderNachschlagen);
  if (view === 'checkout') run(() => renderCheckout(info));
  /*
   * THE SESSION LIST IS RE-READ WHEN ITS VIEW OPENS, not only when the page loaded.
   *
   * Loaded once at boot it goes stale the moment anything changes: sign in on a phone, and the desktop's list
   * still shows what it saw at breakfast — while the whole purpose of the list is to notice a session you do
   * not recognise. Rendered on entry, what the learner reads is what the server says at that moment. (The
   * browser leg found this: it signed in a second "device" and the list never noticed.)
   */
  if (view === 'einstellungen') run(renderSessions);
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function refresh() {
  const ticket = accountGeneration;
  const account = await api.account.read();
  if (ticket !== accountGeneration || sessionProblem || (state.account && account?.ok && account.data?.id !== state.account.id)) return false;
  if (!account?.ok) { showError(() => (uiText("m179") + " " + failure(account) + '.')); return false; }

  const settings = await api.settings.read();
  if (ticket !== accountGeneration || sessionProblem) return false;
  if (settings?.ok && validLocale(settings.data?.settings?.language) && Number.isInteger(settings.data.revision)) {
    state.account = account.data;
    acceptLocaleSettings(settings.data);
  } else {
    showError(() => (uiText("m180") + " " + failure(settings) + '.'));
    return false;
  }
  renderAccount();
  renderSettings();
  renderChrome();
  /*
   * THE SESSION LIST IS LOADED WITH THE VIEW, and it is awaited by nobody: a slow or refused session list must
   * not hold up the settings the learner came for. `guard` is what turns a rejection into a message instead of
   * an unhandled promise — the defect this file has already met once, where one throw silently skipped every
   * later render.
   */
  if (bootReady) guard(renderSessions());
  return true;
}

// ---------------------------------------------------------------- actions

/*
 * PASSWORT ÄNDERN. A successful change ROTATES the acting session — every session is ended, including this
 * one, and the response carries the replacement cookie — so the page must not assume it is still the same
 * session afterwards. Reloading the account state is the honest way to find out rather than guessing, and the
 * session list is re-read so the learner sees the promised effect instead of being told about it.
 */
el('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = el('password-state');
  const current = el('current-password').value;
  const next = el('new-password').value;
  if (!current || !next) {
    bindShellText(status, () => uiText("m181"));
    return;
  }
  const res = await api.sessions.changePassword(current, next);
  if (res && res.ok) {
    bindShellText(status, () => uiText("m182"));
    el('current-password').value = '';
    el('new-password').value = '';
    /*
     * refresh() is the one place that reads the account and the settings, and it also re-renders the
     * session list — so calling it again is how the page learns what the rotation left it holding,
     * rather than assuming it is still the same session.
     */
    await refresh();
    return;
  }
  bindShellText(status, () => res && res.status === 403
    ? uiText("m183")
    : uiText("m184") + " " + failure(res));
});

el('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!bootReady || sessionProblem || preparationSwitching || settingsSaving || localePreference.busy || localePreference.unresolved || !Number.isInteger(state.revision)) return;
  const status = el('settings-state');
  const button = el('save-settings');
  const prep = state.preparation, ticket = contextTicket();
  const date = el('examDate').value || null, language = el('language').value;
  let dateSaved = false;
  let settingsSaved = false;
  settingsSaving = true;
  el('language').disabled = true;
  bindShellText(status, () => uiText("m185"));
  button.disabled = true;
  el('preparation-picker').disabled = true;
  showError('');
  const recovery = message => {
    if (!currentContext(ticket) || state.preparation?.id !== prep.id) return;
    bindShellText(status, () => message + ' ' + uiText('formPreserved'));
    const reload = document.createElement('button');
    reload.type = 'button'; reload.className = 'btn btn-small'; bindShellText(reload, () => uiText("m186"));
    reload.id = 'settings-reload';
    status.append(' ', reload);
    const currentRecoveryForm = () => currentContext(ticket) && state.preparation?.id === prep.id && status.contains(reload);
    const currentRecovery = () => currentRecoveryForm() && !preparationSwitching && !settingsSaving;
    reload.onclick = () => guard((async () => {
      if (!currentRecovery()) return;
      reload.disabled = true;
      const [preparation, settings] = await Promise.all([api.preparations.read(prep.id), api.settings.read()]);
      if (!currentRecovery()) {
        if (currentRecoveryForm()) reload.disabled = false;
        return;
      }
      if (!preparation?.ok || preparation.data?.id !== prep.id || !settings?.ok || !Number.isInteger(settings.data?.revision)) {
        reload.disabled = false; showError(() => (uiText("m187"))); return;
      }
      rememberPreparation(preparation.data);
      state.preparation = preparation.data;
      api.preparations.select(preparation.data);
      acceptLocaleSettings(settings.data);
      renderSettings(); renderChrome(); renderPreparation();
      bindShellText(status, () => uiText("m188"));
    })());
  };
  try {
    if (activePreparation() && date !== prep.exam_date) {
      const saved = await api.preparations.update(prep.id, prep.revision, { examDate: date });
      if (!currentContext(ticket)) return;
      if (!saved?.ok) {
        const current = saved?.data?.current;
        recovery(saved?.status === 409
          ? uiText("m189") + (current ? ' ' + uiText('elsewhere', {value: current.exam_date || uiText('noDate')}) : '')
          : saved?.status === 0 ? uiText("m190") : uiText("m191"));
        return;
      }
      rememberPreparation(saved.data); state.preparation = saved.data; api.preparations.select(saved.data);
      dateSaved = true; renderChrome();
    }
    settingsSaved = await localePreference.save(language);
    if (!currentContext(ticket)) return;
    if (settingsSaved) {
      bindShellText(status, () => (dateSaved ? uiText('m192') + ' ' : '') + uiText('m196'));
    } else {
      bindShellText(status, () => (dateSaved ? uiText('m192') + ' ' : '') + uiText({ unresolved:'unresolved', conflict:'conflict', reconciled:'reconciled', failed:'m195' }[localePreference.status] || 'm195'));
    }
  } catch (err) {
    recovery((dateSaved ? uiText("m192") + " " : '') + uiText("m197"));
  } finally {
    settingsSaving = false;
    el('language').disabled = Boolean(sessionProblem);
    button.disabled = Boolean(sessionProblem);
    renderPreparation();
    const destination = pendingPreparationNavigation;
    pendingPreparationNavigation = null;
    if (destination && !sessionProblem) {
      if (settingsSaved) {
        history.replaceState(null, '', destination.checkoutPath || '#/prep/' + destination.selection + '/' + destination.view + (destination.runId ? '/' + destination.runId : ''));
        await route();
      } else {
        // A refused or uncertain write keeps its choices and explicit recovery action visible.
        history.replaceState(null, '', '#/prep/' + state.preparation.id + '/' + currentView + (mock.runId ? '/' + mock.runId : ''));
      }
    }
  }
});

el('signout').addEventListener('click', async () => {
  readAloud.stop();
  if (!(await writing.flush()) || !(await mock.flush())) return;
  writing.dispose();
  explanationContext++; explanations.dispose();
  // Do NOT navigate on a refusal. The server's mutation origin gate can reject a sign-out (403),
  // and the learner would then land on the sign-in page believing the session had ended while the
  // cookie was still valid — a false success about a security action, which is the worst kind.
  try {
    const res = await api.auth.signOut();
    if (!res || !res.ok) {
      showError(() => (uiText("m198") + " " + failure(res) + " " + uiText("m199")));
      return;
    }
    location.replace('/signin');
  } catch {
    showError(() => (uiText("m200")));
  }
});

el('delete-account').addEventListener('click', async () => {
  const sure = window.confirm(
    uiText('deleteConfirm', {email: state.account?.email || ''}));
  if (!sure) return;
  try {
    // `{}` and not no body: the server requires `application/json` on every mutating route, so a
    // bodyless DELETE is refused with 415 and account deletion could never succeed from the UI.
    const res = await api.account.remove();
    if (!res) return;
    if (res.ok || res.status === 204) { location.replace('/signin'); return; }
    showError(() => (res.status === 0 || res.status >= 500
      ? uiText("m201")
      : uiText("m202") + " " + failure(res) + " " + uiText("m203")));
  } catch {
    showError(() => (uiText("m201")));
  }
});

el('export-data')?.addEventListener('click', async (event) => {
  const trigger = event.currentTarget;
  trigger.disabled = true; bindShellText(el('export-state'), () => uiText("m204"));
  const res = await api.account.export();
  trigger.disabled = false;
  if (!res?.ok) { bindShellText(el('export-state'), () => uiText("m205")); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'hatoove-meine-daten.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  bindShellText(el('export-state'), () => uiText("m206"));
});
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- boot

// The initial shell is hidden/inert until owned preferences are known. Capture also prevents
// an early synthetic submit or keyboard event from writing a guessed revision/default value.
for (const type of ['click', 'submit', 'change', 'input']) {
  el('app-shell').addEventListener(type, (event) => {
    if (!bootReady || preparationSwitching) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
el('dict-q')?.addEventListener('input', () => guard(renderDictionary()));
el('dict-mode-vocab')?.addEventListener('click', () => { dictMode = 'vocab'; guard(renderDictionary()); });
el('dict-mode-nouns')?.addEventListener('click', () => { dictMode = 'nouns'; guard(renderDictionary()); });
el('guide-index')?.addEventListener('click', (event) => {
  const id = event.target?.closest?.('[data-guide]')?.dataset.guide;
  if (id) guard(openGuide(id));
});

async function boot() {
  if (bootLoading || bootReady || sessionProblem) return;
  bootLoading = true;
  el('boot-retry').hidden = true;
  el('boot-signin').hidden = true;
  bindShellText(el('boot-message'), () => uiText("m207"));
  el('boot-choices').hidden = true;
  try {
    applyExplanationDirection();
    const session = await api.session();
    if (session?.status === 401) { location.replace(checkoutSignInPath()); return; }
    if (!session?.ok) throw new Error(uiText("m208") + " " + failure(session));
    if (!(await refresh())) throw new Error(uiText("m209"));
    if (sessionProblem) throw new Error(uiText("m210"));
    // Owned orders can be read even before a preparation is selected or available.
    const returnInfo = checkoutRoute(location.hash);
    if (returnInfo.orderId || returnInfo.invalid) await checkout.open(el('checkout-boot-host'), returnInfo);
    if (!(await loadPreparations())) return;
    await unlockPreparation();
    // PILOT-FEEDBACK-01 (FB-C): one "Problem melden" entry for the whole app, once the learner is signed in.
    await installFeedback();
  } catch (err) {
    if (bootReady) { showError(() => (uiText("m178") + " " + (err?.message || err))); return; }
    bindShellText(el('boot-message'), () => sessionProblem
      ? uiText("m211")
      : (err?.message || uiText("m212")) + ' ' + uiText('retryLater'));
    el('boot-retry').hidden = Boolean(sessionProblem);
    el('boot-signin').hidden = !sessionProblem;
    el('boot-signin').href = checkoutSignInPath();
  } finally {
    bootLoading = false;
  }
}
el('boot-retry').addEventListener('click', () => guard(boot()));
setLocale(initialLocale());
updateLocaleLabels();
guard(boot());
