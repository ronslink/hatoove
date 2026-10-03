import { initialPreparation, preparationChoices } from './preparation.js';
import { createMockController, mockMember } from './mock.js';
import { createWritingController, writingCriterion, writingFeedbackState } from './writing.js';
import { createCheckoutController, checkoutRoute, checkoutReturnPath } from './checkout.js';
import { guideContent } from './guide-content.js';
import { bindSentenceCheck } from './sentence-check.js';
import { createReadAloud } from './read-aloud.js';
/**
 * The Hatoove app shell (PILOT-08).
 *
 * Three rules shape this file:
 *
 *   1. THE SERVER IS THE AUTHORITY. Nothing here computes a score, decides a grade or keeps a
 *      copy of learner state. It reads the owned API and renders what it is told.
 *   2. NO BROWSER STATE. There is no client-side store: a fresh browser is recovered by signing in
 *      again, because the session cookie and the server records are the whole of memory. That is
 *      also why nothing here touches the browser's storage APIs — a deliberate omission, not an
 *      oversight, so a stale cache can never disagree with the database.
 *   3. SAY WHAT IS TRUE. Where a route does not exist yet (the task catalogue), the shell says so
 *      rather than filling the space with sample data that would read as a working product.
 */

import { api } from './api.js';

const el = (id) => document.getElementById(id);

/** Escape text before it is concatenated into markup. */
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
bindSentenceCheck({ api, esc });
const readAloud = createReadAloud();

const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', uk: 'Українська', ar: 'العربية', tr: 'Türkçe' };
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
 * on `Heute` ("Als Nächstes · LV") and in the per-section tally. MASTER-PLAN §4 rule 6 makes the
 * interface German, so every place a section reaches the screen goes through this map.
 */
const SECTION_NAMES = { LV: 'Leseverstehen', SB: 'Sprachbausteine', HV: 'Hörverstehen', writing: 'Schreiben' };
const sectionName = (code) => SECTION_NAMES[code] || String(code ?? '');

/**
 * What to CALL a set on screen.
 *
 * Nine of the twenty-four seeded sets carry no authored title, so the seed generator wrote a
 * placeholder (`LV3 1`, `SB1 2`, …) into `objective_set.title`. A learner must not be shown a
 * database convenience as if it were the name of their task, so a placeholder becomes the section and
 * its part instead — true, and readable. The missing authored titles are recorded for Ron: they are
 * content, and content is not mine to invent.
 */
const setLabel = (set) => {
  const title = String(set?.title ?? '').trim();
  if (title && !/^(LV|SB|HV)\d+\s+\d+$/.test(title)) return title;
  const part = set?.part === undefined || set?.part === null ? '' : ` · Teil ${set.part}`;
  return `${sectionName(set?.section)}${part}`;
};
const VIEW_TITLES = {
  abschnitt: 'Gespeicherte Prüfungsläufe', heute: 'Heute', ueben: 'Üben', woerterbuch: 'Wörterbuch', nachschlagen: 'Nachschlagen',
  // The design organises practice by SKILL. Each maps to a section the catalogue already carries.
  lesen: 'Leseverstehen', sprachbausteine: 'Sprachbausteine',
  hoeren: 'Hörverstehen', schreiben: 'Schreiben',
  fehler: 'Fehler', fortschritt: 'Fortschritt', einstellungen: 'Einstellungen', mehr: 'Mehr', satzbau: 'Satzbau erkunden',
  checkout: 'Pass freischalten',
};

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
const activePreparation = () => state.preparation?.state === 'active';
const contextTicket = () => preparationGeneration;
const currentContext = ticket => ticket === preparationGeneration && !sessionProblem;

// ---------------------------------------------------------------- plumbing

function showError(message) {
  const box = el('error');
  if (sessionProblem) {
    box.textContent = (sessionProblem === 'account_changed'
      ? 'Das angemeldete Konto wurde in einem anderen Fenster gewechselt. Dieses Fenster ist gesperrt.'
      : 'Deine Sitzung ist abgelaufen. Dieses Fenster ist gesperrt.')
      + ' Dein ungespeicherter Text und deine Auswahl bleiben hier. Kopiere sie, bevor du dich erneut anmeldest.';
    const signIn = document.createElement('a');
    signIn.href = checkoutSignInPath(); signIn.className = 'btn'; signIn.textContent = 'Erneut anmelden';
    box.append(' ', signIn); box.hidden = false;
    return;
  }
  box.textContent = message || '';
  box.hidden = !message;
}

window.addEventListener('hatoove:session-expired', (event) => {
  sessionProblem ||= event.detail?.reason || 'session_expired';
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
  if (!res) return 'Keine Verbindung zum Server.';
  if (res.status === 0) return 'Keine Verbindung zum Server.';
  return 'Fehler ' + res.status + (res.error ? ' (' + res.error + ')' : '');
}

/**
 * Run a promise and SURFACE a failure rather than discarding it.
 *
 * `void someAsync()` is a promise whose rejection nobody handles: the learner sees a control that did
 * nothing and the console sees an exception. Every fire-and-forget call goes through here instead.
 */
function guard(promise) {
  promise.catch((err) => showError('Etwas ist schiefgelaufen: ' + (err && err.message ? err.message : err)));
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
      || !Number.isInteger(value.revision)) throw new Error('Die Vorbereitung konnte nicht gelesen werden.');
  const index = state.preparations.findIndex(p => p.id === value.id);
  if (index < 0) state.preparations.push(value);
  else state.preparations[index] = value;
}

function selectPreparation(value) {
  rememberPreparation(value);
  if (!api.preparations.select(value)) throw new Error('Die Vorbereitung konnte nicht ausgewählt werden.');
  state.preparation = value;
  state.credits = null;
  el('preparation-credits').textContent = 'Guthaben wird geladen …';
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
  el('view-satzbau').querySelector('.kicker').textContent = 'Lernhilfe';
  return hasLanguageSection;
}

function renderPreparation() {
  const prep = state.preparation;
  if (!prep) return;
  const label = prep.exam || state.exams.find(e => e.exam_id === prep.exam_id)?.exam || prep.exam_id;
  el('sidebar-exam').textContent = label;
  el('preparation-exam').textContent = label;
  el('preparation-scope').textContent = prep.state === 'archived'
    ? 'Archiviert · gespeicherte Texte und Rückmeldungen bleiben lesbar.'
    : 'Umfang, Zeitplan und Prüfstatus stehen beim jeweiligen Übungslauf.';
  el('preparation-continue').href = '#/prep/' + prep.id + '/fortschritt';
  el('preparation-start').hidden = !activePreparation();
  el('preparation-start').href = '#/prep/' + prep.id + '/ueben';
  const picker = el('preparation-picker');
  const choices = preparationChoices(state.exams, state.preparations);
  picker.innerHTML = choices.map(choice => '<option value="' + esc(choice.id) + '">' + esc(choice.label) + '</option>').join('');
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
    el('preparation-credits').textContent = 'Das Guthaben dieser Prüfung konnte nicht geladen werden.';
    el('credits-retry').hidden = false;
    return;
  }
  state.credits = value;
  el('preparation-credits').textContent = `Schreibrückmeldungen für ${prep.exam || prep.exam_id}: ${value.available} verfügbar · ${value.reserved} reserviert · ${value.used} verwendet.`
    + (value.expiresAt && Number.isFinite(Date.parse(value.expiresAt)) ? ' Gültig bis ' + new Date(value.expiresAt).toLocaleDateString('de-DE') + '.' : '')
    + (value.available === 0 ? ' Zurzeit ist keine weitere Rückmeldung verfügbar. Gespeicherte Texte bleiben erhalten.' : '');
}

function clearPreparationViews() {
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
  el('preparation-state').textContent = 'Dein Text und deine Antworten werden vor dem Wechsel gespeichert …';
  try {
    if (!(await writing.flush()) || !(await mock.flush())) {
      el('preparation-state').textContent = 'Der Wechsel wurde angehalten. Dein Text und deine Antworten bleiben hier; speichere oder löse zuerst den Konflikt.';
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
      if (!response?.ok) { el('preparation-state').textContent = 'Die Vorbereitung konnte nicht gewechselt werden. ' + failure(response); return false; }
      if (!(await writing.flush()) || !(await mock.flush())) { el('preparation-state').textContent = 'Dein Text ist noch nicht gespeichert. Der Wechsel bleibt angehalten.'; return false; }
      if (pendingPreparationNavigation) continue;
      clearPreparationViews();
      selectPreparation(response.data);
      renderSettings(); renderChrome();
      const target = activePreparation() || destination.runId ? destination.view : 'fortschritt';
      history.replaceState(null, '', destination.checkoutPath || '#/prep/' + state.preparation.id + '/' + target + (destination.runId ? '/' + destination.runId : ''));
      el('preparation-state').textContent = '';
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
    throw new Error('Deine Prüfungsvorbereitung konnte nicht geladen werden.');
  }
  state.exams = exams.data.exams;
  state.preparations = [];
  for (const prep of preparations.data.preparations) rememberPreparation(prep);
  const routeInfo = preparationRoute();
  let requested = routeInfo.id;
  if (routeInfo.runId) {
    const saved = await api.mock.read(routeInfo.runId);
    if (!saved?.ok) throw new Error('Der verlinkte Abschnitt ist nicht verfügbar.');
    requested = saved.data.preparation_id;
  }
  if (requested) {
    const response = await api.preparations.read(requested);
    if (!response?.ok) throw new Error('Die verlinkte Vorbereitung ist nicht verfügbar.');
    selectPreparation(response.data);
    return true;
  }
  const initial = initialPreparation(state.exams, state.preparations);
  if (initial.kind === 'select' && initial.preparation.state === 'active') { selectPreparation(initial.preparation); return true; }
  if (initial.kind === 'select') {
    selectPreparation(initial.preparation);
    if (routeInfo.view !== 'checkout') history.replaceState(null, '', '#/prep/' + state.preparation.id + '/fortschritt');
    return true;
  }
  if (initial.kind === 'create') {
    const created = await api.preparations.create(initial.examId);
    if (!created?.ok) throw new Error('Deine Vorbereitung konnte nicht angelegt werden. Bitte versuche es erneut.');
    selectPreparation(created.data);
    return true;
  }
  const choices = el('boot-choices');
  el('boot-message').textContent = state.preparations.length || state.exams.length
    ? 'Wähle deine Prüfungsvorbereitung. Ein Prüfungstermin ist freiwillig.'
    : 'Zurzeit ist keine Prüfungsvorbereitung verfügbar. Bitte versuche es später erneut.';
  choices.innerHTML = preparationChoices(state.exams, state.preparations).map(choice => '<button class="btn' + (choice.isNew ? ' btn-primary' : '') + '" type="button" data-preparation="' + esc(choice.id) + '">' + esc(choice.label) + '</button>').join('');
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
        if (!response?.ok) throw new Error('Die Vorbereitung konnte nicht geöffnet werden. ' + failure(response));
        selectPreparation(response.data);
        await unlockPreparation();
      } catch (error) { el('boot-message').textContent = error.message; }
      finally { bootLoading = false; for (const item of choices.querySelectorAll('button')) item.disabled = false; }
    })());
  };
  return false;
}

async function unlockPreparation() {
  if (sessionProblem || !state.preparation) throw new Error('Bitte melde dich erneut an.');
  renderSettings(); renderChrome(); renderPreparation();
  const info = preparationRoute();
  if (info.view !== 'checkout') history.replaceState(null, '', '#/prep/' + state.preparation.id + '/' + (activePreparation() || info.runId ? info.view : 'fortschritt') + (info.runId ? '/' + info.runId : ''));
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
 * language from being laid out as if it were left-to-right. Neither is set on `<html>` — the shell,
 * the navigation and the exam material stay German and LTR.
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
  el('account-email').textContent = email;
  el('account-email-2').textContent = email;
  el('avatar').textContent = (email[0] || '?').toUpperCase();
  el('greeting').textContent = email.startsWith('–') ? 'Willkommen' : `Willkommen, ${email.split('@')[0]}`;
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
    into.innerHTML = '';
    if (state) {
      state.textContent = res && res.status === 503
        ? 'Dieser Server kann Sitzungen nicht verwalten.'
        : 'Sitzungen konnten nicht geladen werden: ' + failure(res);
    }
    return;
  }
  const sessions = (res.data && res.data.sessions) || [];
  if (state) state.textContent = '';
  if (!sessions.length) {
    into.innerHTML = '<li class="muted small">Keine weiteren Sitzungen.</li>';
    return;
  }
  into.innerHTML = sessions.map((session) => '<li class="session">'
    + '<div><strong>' + (session.current ? 'Dieses Gerät' : 'Anderes Gerät') + '</strong>'
    + '<span class="small muted"> seit ' + esc(shortDate(session.created_at)) + '</span></div>'
    + (session.current
      ? '<span class="small muted">aktiv</span>'
      : '<button type="button" class="btn btn-small" data-revoke="' + esc(String(session.id)) + '">Beenden</button>')
    + '</li>').join('');
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
      if (state) state.textContent = res && res.ok ? 'Sitzung beendet.' : 'Konnte nicht beendet werden: ' + failure(res);
    })()));
  }
}

/** A local date, without a time nobody needs on a session list. */
function shortDate(value) {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? 'unbekannt'
    : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderSettings() {
  const settings = state.settings || {};
  const examDate = state.preparation?.exam_date || '';
  const language = settings.language || 'de';

  el('examDate').value = examDate;
  el('language').value = EXPLANATION_LANGUAGES.includes(language) ? language : 'de';

  el('account-exam').textContent = examDate ? `Prüfung am ${examDate}` : 'Kein Prüfungsdatum';

  // Arabic is the one explanation language that runs right to left. The shell stays LTR; `dir`
  // belongs on the text that is actually Arabic, never on <html>.
  applyExplanationDirection();

  // The countdown is arithmetic on a date the learner typed. It is not a study plan, a forecast or
  // a readiness estimate, and it must never be presented as one.
  if (!examDate) {
    el('countdown').textContent = 'Kein Prüfungsdatum gesetzt';
    el('countdown-note').textContent = 'Trage dein Prüfungsdatum in den Einstellungen ein, damit der Countdown läuft.';
    return;
  }
  const days = Math.ceil((new Date(`${examDate}T00:00:00`) - new Date()) / 86400000);
  const when = new Date(`${examDate}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  el('countdown').textContent = days > 1 ? `${days} Tage bis ${when}`
    : days === 1 ? `Morgen: ${when}`
      : days === 0 ? `Heute: ${when}` : `Prüfungstermin war am ${when}`;
  el('countdown-note').textContent = 'Nur eine Zählung bis zum Datum — kein Lernplan und keine Prognose.';
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
  if (host) { host.hidden = true; host.innerHTML = ''; }
  if (el('skill-ueben-catalogue')) el('skill-ueben-catalogue').hidden = false;
  box.hidden = false;
  if (!activePreparation()) { box.innerHTML = archivedPracticeNotice(); return; }
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const [writing, objective] = await Promise.all([
    api.tasks.list({ family: 'writing' }),
    api.objectiveSets.list(),
  ]);
  if (!currentContext(ticket)) return;
  if (!writing || !objective) return; // a 401 already redirected us to the sign-in page
  if (!writing.ok || !objective.ok) {
    box.innerHTML = '';
    showError('Aufgaben konnten nicht geladen werden: ' + failure(writing.ok ? objective : writing) + '.');
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
    groups.push('<h3 class="section-head">Schreiben</h3>' + tasks.map((t) => card(
      esc(t.topic), esc(t.family), esc(t.situation),
      'Anrede: ' + esc(t.adressat) + ' &middot; Register: ' + esc(t.register)
        + ' &middot; Fassung ' + esc(t.version) + ' &middot; Prüfstatus: ' + esc(t.review_status),
      // The four-part binding, exactly as the Schreiben view binds it; the controller resumes an open
      // draft for this task+version instead of creating a second one.
      '<div class="row"><button class="btn btn-primary" type="button" data-write="' + esc(t.task_id) + '"'
        + ' data-version="' + esc(t.version) + '" data-rubric="' + esc(t.rubric_id) + '"'
        + ' data-rubric-version="' + esc(t.rubric_version) + '">Schreiben</button></div>',
    )).join(''));
  }
  if (sets.length) {
    // setLabel(), not s.title: nine seeded sets have no authored title and the generator wrote
    // `LV3 1` into the column. This view was the one place it still reached the screen.
    groups.push('<h3 class="section-head">' + esc([...new Set(sets.map(set => sectionName(set.section)))].join(' und ')) + '</h3>' + sets.map((s) => card(
      esc(setLabel(s)), esc(s.family), s.item_count + ' Aufgaben',
      'Teil ' + s.part + ' &middot; Fassung ' + esc(s.version) + ' &middot; Prüfstatus: ' + esc(s.review_status),
      // The version is the second half of the identity: the read below refuses a mismatch rather than
      // rendering the wrong fassung of the task the learner chose.
      '<div class="row"><button class="btn btn-primary" type="button" data-open="' + esc(s.set_id) + '"'
        + ' data-version="' + esc(s.version) + '">Üben</button></div>',
    )).join(''));
  }
  if (!groups.length) {
    box.innerHTML = '<div class="card"><h3>Zurzeit keine Aufgaben freigegeben</h3>'
      + '<p class="muted">Der Server hat für dieses Angebot gerade nichts Servierbares. Das ist eine '
      + 'Aussage des Servers, keine leere Seite.</p></div>';
    return;
  }
  box.innerHTML = groups.join('');
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
        showError('Diese Schreibaufgabe steht nicht mehr in der Liste. Bitte lade die Aufgaben erneut.');
        return;
      }
      await openWriting(host, task);
      return;
    }
    if (!button.dataset.open) return;
    const version = button.dataset.version;
    if (!version) {
      // Same refusal `openSet` makes, said before the request rather than after it.
      showError('Die Fassung dieser Aufgabe fehlt. Bitte lade die Aufgabenliste erneut.');
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
async function renderDictionary() {
  const box = el('dict-results');
  if (!box) return;
  const request = ++dictionaryRequest, mode = dictMode;
  readAloud.clear(box);
  const q = (el('dict-q')?.value || '').trim();
  if (q.length === 1) { box.innerHTML = '<div class="card"><p class="muted">Mindestens zwei Buchstaben.</p></div>'; return; }
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const res = mode === 'nouns' ? await api.nouns.list({ q: q || null }) : await api.vocab.list({ q: q || null });
  if (request !== dictionaryRequest) return;
  if (!res) return; // a 401 already redirected
  if (!res.ok) { box.innerHTML = ''; showError('Nachschlagen fehlgeschlagen: ' + failure(res) + '.'); return; }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) {
    box.innerHTML = '<div class="card"><h3>Nichts gefunden</h3><p class="muted">Der Server hat zu dieser Suche keinen Eintrag.</p></div>';
    return;
  }
  readAloud.clear(box);
  box.innerHTML = rows.map((w) => (mode === 'nouns'
    ? '<div class="card"><div class="card-head"><h3>' + esc(w.de) + '</h3><span class="chip">' + esc(w.gender) + '</span></div>'
      + (state.settings?.language === 'en' ? '<p class="muted" lang="en">' + esc(w.en) + '</p>' : '')
      + '<p class="small muted">Plural: ' + esc(w.plural) + ' &middot; Thema: ' + esc(w.theme) + '</p>'
      + '<p class="small muted">Regel: ' + esc(w.rule) + '</p>'
      + (w.example ? '<p class="small" lang="de" data-read-example>' + esc(w.example) + '</p>' : '') + '</div>'
    : '<div class="card"><div class="card-head"><h3>' + esc(w.de) + '</h3><span class="chip">' + esc(w.pos) + '</span></div>'
      + (state.settings?.language === 'en' ? '<p class="muted" lang="en">' + esc(w.en) + '</p>' : '')
      + (w.plural ? '<p class="small muted">Plural: ' + esc(w.plural) + '</p>' : '')
      + (w.example ? '<p class="small" lang="de" data-read-example>' + esc(w.example) + '</p>' : '') + '</div>')).join('');
  for (const example of box.querySelectorAll('[data-read-example]')) readAloud.mount(example, { label: 'Beispielsatz', language: example.lang });
}

/** NACHSCHLAGEN -- the guide index, then one document's sections. */
async function renderGuides() {
  const box = el('guide-index');
  if (!box) return;
  box.hidden = false;
  el('guide-body').hidden = true;
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const res = await api.guides.list();
  if (!res) return;
  if (!res.ok) { box.innerHTML = ''; showError('Nachschlagen fehlgeschlagen: ' + failure(res) + '.'); return; }
  const guides = Array.isArray(res.data) ? res.data : [];
  if (!guides.length) {
    box.innerHTML = '<div class="card"><h3>Zurzeit keine Nachschlagewerke</h3><p class="muted">Der Server hat gerade nichts Servierbares.</p></div>';
    return;
  }
  box.innerHTML = guides.map((g) => '<div class="card"><div class="card-head"><h3>' + esc(g.title)
    + '</h3><span class="chip">' + g.section_count + ' Abschnitte</span></div>'
    + (g.intro ? '<p class="muted">' + esc(g.intro) + '</p>' : '')
    + '<button class="btn" type="button" data-guide="' + esc(g.guide_id) + '">Öffnen</button></div>').join('');
}

/** One guide, rendered. */
async function openGuide(guideId) {
  const box = el('guide-body');
  const index = el('guide-index');
  if (!box || !index) return;
  index.hidden = true;
  box.hidden = false;
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const res = await api.guides.read(guideId);
  if (!res) return;
  if (!res.ok) { box.hidden = true; index.hidden = false; showError('Das Nachschlagewerk konnte nicht geladen werden: ' + failure(res) + '.'); return; }
  const g = res.data;
  const sections = Array.isArray(g.sections) ? g.sections : [];
  const sectionKinds = { step: 'Schritt', topic: 'Thema', tier: 'Bausteine', gender_rule: 'Genusregel', exception: 'Ausnahme', double_gender: 'Mehrere Bedeutungen', table: 'Übersicht', trigger: 'Auslöser', example: 'Beispiel', phrases: 'Redemittel', phrase_group: 'Redemittel', checklist: 'Checkliste' };
  box.innerHTML = '<div class="card"><div class="card-head"><h3>' + esc(g.title)
    + '</h3><span class="chip">' + sections.length + '</span></div>'
    + '<p class="small muted">Übungsmaterial – noch nicht fachlich geprüft.</p>' + (!['de', 'en'].includes(state.settings?.language || 'de') ? '<p class="small muted">Dieses Nachschlagewerk liegt noch nicht in deiner Erklärungssprache vor. Du siehst die deutsche Fassung.</p>' : '') + '<button class="btn" type="button" id="guide-back">Zurück</button></div>'
    + sections.map((s) => '<div class="card"><div class="card-head"><h3>' + esc(s.title)
      + '</h3><span class="chip">' + esc(sectionKinds[s.kind] || 'Nachschlagen') + '</span></div>'
      + (s.summary ? '<p class="muted">' + esc(s.summary) + '</p>' : '')
      + '<div class="guide-content">' + guideContent(s.payload, esc, state.settings?.language || 'de') + '</div></div>').join('');
  el('guide-back').addEventListener('click', () => { box.hidden = true; index.hidden = false; });
}

/** UEBEN's adaptive recommendation, above the catalogue. */
async function renderPracticeNext() {
  const ticket = contextTicket();
  const box = el('practice-next');
  if (!box) return;
  if (!activePreparation()) { box.innerHTML = ''; return; }
  const res = await api.practice.next();
  if (!currentContext(ticket)) return;
  if (!res) return;
  if (!res.ok) return; // the catalogue below still renders; a failed suggestion is not an error page
  const data = res.data || {};
  if (!data.set) { box.innerHTML = ''; return; }
  const e = data.evidence || {};
  const why = data.reason === 'section_not_started'
    ? 'Dieser Bereich ist noch neu für dich.'
    : (e.attempts ? e.correct + ' von ' + e.attempts + ' richtig (' + Math.round((e.accuracy || 0) * 100) + '%).' : '');
  box.innerHTML = '<div class="card"><div class="card-head"><h3>Deine nächste Aufgabe</h3><span class="chip">'
    + esc(sectionName(data.section)) + '</span></div>'
    + '<p><strong>' + esc(setLabel(data.set)) + '</strong> &middot; ' + data.set.item_count + ' Aufgaben</p>'
    + (why ? '<p class="muted">' + esc(why) + '</p>' : '')
    + '<p class="small muted">Vom Server gewählt aus deinen bisherigen Antworten &mdash; nicht geraten.</p></div>';
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
  if (crumb) crumb.textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const countdown = el('exam-countdown');
  if (countdown) {
    if (examDate) {
      const exam = new Date(examDate + 'T00:00:00');
      const today = new Date(new Date().toDateString());
      const days = Math.round((exam - today) / 86400000);
      countdown.textContent = days >= 0
        ? 'Prüfung am ' + exam.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) + ' · ' + days + (days === 1 ? ' Tag' : ' Tage')
        : 'Prüfungsdatum liegt in der Vergangenheit';
    } else {
      countdown.textContent = 'Kein Prüfungsdatum gesetzt';
    }
  }
  const lang = el('lang-label');
  if (lang) lang.textContent = 'Erklärungen: ' + (LANGUAGE_NAMES[settings.language] || 'Deutsch');
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
async function renderDashboard() {
  const ticket = contextTicket();
  const pct = (value) => Math.round((value || 0) * 100) + '%';
  const [next, progress, savedRuns] = await Promise.all([api.practice.next(), api.practice.progress(), api.mock.list()]);
  if (!currentContext(ticket)) return;
  if (!next || !progress) return; // a 401 already redirected
  const start = document.querySelector('.hero-next a');
  if (start) { start.href = activePreparation() ? '#/ueben' : '#/fortschritt'; start.textContent = activePreparation() ? 'Üben' : 'Verlauf öffnen'; }

  if (next.ok && next.data && next.data.set) {
    const d = next.data;
    const e = d.evidence || {};
    el('next-kicker').textContent = 'Als Nächstes · ' + sectionName(d.section);
    el('next-title').textContent = setLabel(d.set);
    el('next-detail').textContent = d.set.item_count + ' Aufgaben'
      + (d.reason === 'section_not_started'
        ? ' · dieser Bereich ist neu für dich'
        : (e.attempts ? ' · bisher ' + e.correct + ' von ' + e.attempts + ' richtig' : ''));
  } else {
    el('next-kicker').textContent = 'Als Nächstes';
    el('next-title').textContent = 'Zurzeit nichts freigegeben';
    el('next-detail').textContent = 'Der Server hat gerade nichts Servierbares. Das ist eine Aussage des Servers, keine leere Seite.';
  }
  const savedRun = savedRuns?.ok && savedRuns.data?.runs?.find(run => run.state === 'active');
  if (savedRun && activePreparation()) {
    el('next-kicker').textContent = 'Gespeicherten Prüfungslauf fortsetzen';
    el('next-title').textContent = savedRun.title;
    el('next-detail').textContent = 'Deine bestätigten Antworten sind gespeichert. Rückmeldung nach dem Abschließen.';
    if (start) { start.href = '#/lauf/' + savedRun.id; start.textContent = 'Fortsetzen'; }
  }
  if (!activePreparation()) {
    el('next-title').textContent = 'Archivierte Vorbereitung';
    el('next-detail').textContent = 'Deine gespeicherten Texte und Rückmeldungen bleiben im Verlauf lesbar.';
  }

  const totals = (progress.ok && progress.data && progress.data.totals) || { attempts: 0, correct: 0, accuracy: null };
  el('gauge-count').textContent = String(totals.attempts);
  el('gauge-bar').style.width = pct(totals.accuracy);
  el('gauge-foot').textContent = totals.attempts
    ? 'aus ' + totals.attempts + (totals.attempts === 1 ? ' Antwort' : ' Antworten')
    : 'Noch keine Antworten';
  el('gauge-acc').textContent = totals.accuracy === null ? '–' : totals.correct + ' von ' + totals.attempts + ' richtig';
  el('stat-answers').textContent = String(totals.attempts);
  el('stat-correct').textContent = String(totals.correct);

  // No `warn` class: the design uses it against a 60% PASS THRESHOLD, and importing that threshold
  // would smuggle the pass line back in through a colour.
  const sections = (progress.ok && Array.isArray(progress.data.sections)) ? progress.data.sections : [];
  el('parts').innerHTML = sections.length
    ? sections.map((s) => '<div class="part"><span>' + esc(sectionName(s.section)) + '</span>'
      + '<div class="mini"><i style="width:' + pct(s.accuracy) + '"></i></div>'
      + '<b>' + s.correct + ' / ' + s.attempts + '</b></div>').join('')
    : '<p class="small muted">Sobald du Aufgaben beantwortest, erscheint hier deine Bilanz je Bereich.</p>';

  const examDate = state.preparation?.exam_date;
  if (examDate) {
    const exam = new Date(examDate + 'T00:00:00');
    const days = Math.round((exam - new Date(new Date().toDateString())) / 86400000);
    el('countdown').textContent = days >= 0
      ? exam.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' + days + (days === 1 ? ' Tag' : ' Tage')
      : exam.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) + ' · liegt in der Vergangenheit';
  } else {
    el('countdown').textContent = 'Kein Prüfungsdatum gesetzt';
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
    if (box) { box.innerHTML = ''; showError('Fehler konnten nicht geladen werden: ' + failure(res) + '.'); }
    return;
  }
  const data = res.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const count = Number.isInteger(data.count) ? data.count : items.length;

  for (const badge of badges) {
    badge.textContent = String(count);
    // A badge reading 0 is noise, and it is also the one number a learner does not need told.
    badge.hidden = count === 0;
  }
  if (el('mistake-heading')) el('mistake-heading').textContent = 'Deine offenen Fehler';
  if (el('mistake-note')) {
    el('mistake-note').textContent = count === 0
      ? 'Zurzeit nichts offen. Aufgaben, die du zuletzt falsch hattest, erscheinen hier — und verschwinden, sobald du sie richtig hast.'
      : 'Aufgaben, die du zuletzt falsch beantwortet hast. Sobald du eine richtig hast, verschwindet sie hier von selbst.';
  }
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="card"><h3>Nichts offen</h3><p class="muted">Das ist eine Aussage des '
      + 'Servers über deine eigenen Antworten, keine leere Seite.</p></div>';
    return;
  }
  // The design's `.list` carries the border and the radius, and only `.list-item:first-child` drops its
  // top border; bare `.list-item` rows therefore rendered as detached, separately bordered boxes.
  //
  // TWO LINES, TWO JOBS: the title is the SET, the sub-line says which SECTION and which item. They both
  // printed the title for a moment (setLabel returns an authored title unchanged), which duplicated it
  // and dropped the section.
  box.innerHTML = '<div class="list">' + items.map((m) => '<div class="list-item"><div><strong>'
    + esc(setLabel({ title: m.set_title, section: m.section, part: null }))
    + '</strong><span class="sub">' + esc(sectionName(m.section)) + ' &middot; Fassung ' + esc(m.version) + ' &middot; ' + (/^g_/.test(m.item_id) ? 'Grammatikübung' : 'Aufgabe ' + esc(m.item_id) + ' von ' + m.set_item_count) + '</span></div>'
    + '<span class="chip chip-orange">deine Antwort: ' + esc(JSON.stringify(m.your_answer)) + '</span></div>').join('') + '</div>';
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
  if (host) { host.hidden = true; host.innerHTML = ''; }
  box.hidden = false;
  if (!activePreparation()) { box.innerHTML = archivedPracticeNotice(); return; }
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';

  if (section === 'HV') { await mock.list(box, { section: 'HV' }); return; }

  if (section === 'writing') {
    const res = await api.tasks.list({ family: 'writing' });
    if (!currentContext(ticket)) return;
    if (!res) return;
    if (!res.ok) { box.innerHTML = ''; showError('Aufgaben konnten nicht geladen werden: ' + failure(res) + '.'); return; }
    const tasks = Array.isArray(res.data) ? res.data : [];
    box.innerHTML = tasks.length
      ? tasks.map((t) => '<div class="card"><div class="card-head"><h3>' + esc(t.topic)
        + '</h3><span class="chip">' + esc(t.family) + '</span></div>'
        + '<p class="muted">' + esc(t.situation) + '</p>'
        + '<p class="small muted">Anrede: ' + esc(t.adressat) + ' &middot; Prüfstatus: ' + esc(t.review_status) + '</p>'
        /*
         * The binding travels WITH the button. A writing view that creates an attempt without it is bound
         * to the canonical default task, so the learner would read task B and have task A marked — the
         * failure mode where the screen is right and the record belongs to something else.
         */
        + '<button class="btn btn-primary" type="button" data-write="' + esc(t.task_id) + '"'
        + ' data-version="' + esc(t.version) + '" data-rubric="' + esc(t.rubric_id) + '"'
        + ' data-rubric-version="' + esc(t.rubric_version) + '">Schreiben</button></div>').join('')
      : '<div class="card"><h3>Zurzeit keine Schreibaufgaben</h3><p class="muted">Der Server hat gerade nichts Servierbares.</p></div>';
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
  if (!res.ok) { box.innerHTML = ''; showError('Aufgaben konnten nicht geladen werden: ' + failure(res) + '.'); return; }
  const sets = (Array.isArray(res.data) ? res.data : []).filter((s) => s.section === section);
  if (!sets.length) {
    box.innerHTML = '<div class="card"><h3>Zurzeit keine Aufgaben</h3><p class="muted">Der Server hat für diesen '
        + 'Bereich gerade nichts Servierbares.</p></div>';
    return;
  }
  box.innerHTML = sets.map((s) => '<div class="card"><div class="card-head"><h3>' + esc(setLabel(s))
    + '</h3><span class="chip">' + esc(s.family) + '</span></div>'
    + '<p class="muted">' + s.item_count + ' Aufgaben &middot; Teil ' + s.part + ' &middot; Fassung ' + esc(s.version) + '</p>'
    + '<p class="small muted">Prüfstatus: ' + esc(s.review_status) + '</p>'
    + '<button class="btn btn-primary" type="button" data-open="' + esc(s.set_id) + '" data-version="' + esc(s.version) + '">Üben</button></div>').join('');
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
    passages: form.passage ? [{ label: 'Text', lines: [form.passage] }] : [],
    options: form.options,
    items: form.items.map(item => ({ ...item, prompt: item.text })),
  };
}

/** Render the set, with a lettered choice per item. */
function renderObjectiveForm(set, host) {
  const form = objectiveForm(set);
  if (!form) {
    host.innerHTML = '<div class="card"><h3>Diese Aufgabenart wird noch nicht angezeigt</h3>'
      + '<p class="muted">Der Inhalt ist vorhanden; die Ansicht für diese Familie fehlt noch.</p></div>';
    return;
  }
  host.innerHTML =
    (form.passages || []).map((passage) => '<section class="card"><div class="card-head"><h3>'
      + esc(passage.label) + '</h3></div>' + passage.lines.map((l) => '<p>' + esc(l) + '</p>').join('') + '</section>').join('')
    + form.items.map((item, index) => {
      const options = item.options || form.options || [];
      return '<section class="card" data-item="' + esc(item.id) + '"><p class="kicker">Aufgabe '
        + (set.payload?.practice_kind === 'grammar-drill' ? index + 1 : esc(item.id)) + '</p>'
        + (item.passage ? '<div class="stimulus mock-passage" lang="de">' + esc(item.passage) + '</div>' : '') + '<p>' + esc(item.prompt) + '</p><div class="row">'
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
         */
        + options.map((o) => '<button class="btn answer-option" type="button" data-answer="' + esc(o.id) + '">'
          + esc(o.id) + ') ' + esc(o.label) + '</button>').join('')
        + '</div><p class="small muted result"></p></section>';
    }).join('');
}

/** Post one answer and show what the SERVER said, not what the client guessed. */
async function answerItem(set, card, itemId, answer) {
  if (!bootReady || sessionProblem || !activePreparation() || preparationSwitching) return;
  const ticket = contextTicket();
  const out = card.querySelector('.result');
  out.textContent = 'Wird geprüft ...';
  const res = await api.practice.answer(set.set_id, { version: set.version, itemId, answer });
  if (!currentContext(ticket)) return;
  if (!res) return;
  const button = card.querySelector('[data-answer="' + answer + '"]');
  if (!res.ok) {
    out.textContent = res.status === 422 && res.error === 'unknown_item'
      ? 'Diese Aufgabe gibt es im Schlüssel nicht — der Server hat sie nicht bewertet.'
      : 'Bewertung fehlgeschlagen: ' + failure(res) + '.';
    return;
  }
  const correct = res.data && res.data.correct === true;
  if (button) button.setAttribute('aria-pressed', String(correct));
  out.textContent = correct ? 'Richtig.' : 'Noch nicht richtig — die Aufgabe bleibt bei deinen Fehlern.';
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

/** Open one set of the skill currently on screen. */
async function openSet(setId, version) {
  if (!activePreparation() || preparationSwitching) return;
  if (!bootReady || sessionProblem) return;
  if (typeof version !== 'string' || !version.trim()) {
    showError('Die Fassung dieser Aufgabe fehlt. Bitte lade die Aufgabenliste erneut.');
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
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  window.scrollTo(0, 0);
  const res = await api.objectiveSets.read(setId, version);
  if (!res || request !== objectiveRequest || navigation !== routing || sessionProblem) return;
  if (!res.ok) {
    box.innerHTML = '';
    if (list) list.hidden = false;
    showError('Die Aufgaben konnten nicht geladen werden: ' + failure(res) + '.');
    return;
  }
  const set = res.data;
  if (set?.set_id !== setId || set?.version !== version) {
    box.innerHTML = '';
    if (list) list.hidden = false;
    showError('Die geladene Fassung passt nicht zur ausgewählten Aufgabe. Bitte lade die Aufgabenliste erneut.');
    return;
  }
  box.innerHTML = '<div class="card"><div class="card-head"><h3>' + esc(setLabel(set))
    + '</h3><span class="chip">' + esc(set.family) + ' · Fassung ' + esc(set.version) + '</span></div>'
    + '<button class="btn" type="button" id="practice-close">Schließen</button></div>'
    + '<div class="stack" id="practice-items"></div>';
  renderObjectiveForm(set, box.querySelector('#practice-items'));
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
    box.hidden = true;
    box.innerHTML = '';
    if (list) list.hidden = false;
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
const TELC_FEEDBACK_LABEL = 'Übungsfeedback nach den telc-Kriterien – keine offizielle Bewertung';
const CRITERION_LABELS = Object.freeze({
  aufgabe: 'Aufgabenbewältigung',
  kommunikation: 'Kommunikative Gestaltung',
  richtigkeit: 'Formale Richtigkeit',
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
const writingApi = { ...api, writing: { ...api.writing, result: async submissionId => {
  const ticket = contextTicket();
  const result = await api.writing.result(submissionId);
  if (currentContext(ticket) && bootReady) guard(refreshCredits());
  return result;
} } };
const mock = createMockController({ api: writingApi, esc, setLabel, readAloud, explanationLanguage: () => state.settings?.language || 'de', canEdit: () => activePreparation() && !sessionProblem, isArchived: () => state.preparation?.state === 'archived', onOpen: run => { location.hash = '#/lauf/' + run.id; } });
window.addEventListener('beforeunload', event => mock.preserveOnUnload(event));
const writing = createWritingController({ api: writingApi, esc, readAloud, onChange: () => { guard(refreshCredits()); if (currentView === 'fortschritt') guard(renderHistory()); } });
// PAYMENTS-SLICE-01. `onChange` re-reads the credit line, because a granted pass is exactly the thing
// that line shows; it never writes a learner state anywhere.
const checkout = createCheckoutController({ api, esc, onChange: () => { if (state.preparation) guard(refreshCredits()); }, beforeRedirect: async () => {
  const ticket = contextTicket();
  return await writing.flush() && await mock.flush() && currentContext(ticket);
}, canContinue: () => !sessionProblem && !preparationSwitching });
async function openWriting(box, task, options = {}) {
  if (!activePreparation() || preparationSwitching) return false;
  // Keep the task catalogue as a sibling of the editor so closing a letter can restore it.
  return writing.open(box.id.startsWith('skill-') ? practiceHost(box) : box, task, options);
}
function archivedPracticeNotice() {
  return '<div class="card"><h3>Diese Vorbereitung ist archiviert</h3><p>Neue Übungen sind hier nicht möglich. Deine gespeicherten Texte und Rückmeldungen bleiben im Verlauf lesbar.</p><a class="btn" href="#/fortschritt">Verlauf öffnen</a></div>';
}

async function openArchivedWriting(entry) {
  const ticket = contextTicket(), host = el('history-detail');
  host.hidden = false;
  host.innerHTML = '<p class="muted">Gespeicherter Text wird geladen …</p>';
  const response = entry.submission_id ? await api.writing.result(entry.submission_id) : await api.writing.readAttempt(entry.id);
  if (!currentContext(ticket) || currentView !== 'fortschritt') return;
  if (!response?.ok) {
    host.innerHTML = '<p class="err">Der gespeicherte Text konnte nicht geladen werden.</p><button class="btn" id="archived-refresh" type="button">Erneut laden</button>';
  } else {
    const data = response.data, feedback = data.assessment?.feedback;
    const language = EXPLANATION_LANGUAGES.includes(feedback?.language || data.submission?.explanation_language)
      ? feedback?.language || data.submission?.explanation_language : 'de';
    let result = '';
    const feedbackState = writingFeedbackState(data);
    if (feedbackState === 'assessed' && feedback) {
      result = '<p class="small muted">Übungsfeedback – keine offizielle Bewertung. Die Rückmeldung im lokalen Pilot stammt aus einer technischen Simulation.</p>';
      result += Array.isArray(feedback.criteria) ? '<ul>' + feedback.criteria.map(c => { const view = writingCriterion(c, data.rubric); return '<li><strong>'
        + esc(view.label) + ': ' + esc(view.band) + '</strong><p lang="' + language + '" dir="' + (language === 'ar' ? 'rtl' : 'ltr') + '">'
        + esc(c.comment) + '</p></li>'; }).join('') + '</ul>' : '<p lang="' + language + '" dir="' + (language === 'ar' ? 'rtl' : 'ltr') + '">' + esc(feedback.comment) + '</p>';
    } else if (feedbackState === 'blocked') result = '<p>Die Aufgabe und Rückmeldung sind zurzeit gesperrt. Dein Text bleibt erhalten.</p>';
    else if (['failed', 'unassessed'].includes(feedbackState)) result = '<p>Unbewertet. Dein abgegebener Text bleibt erhalten.</p>';
    else if (entry.submission_id) result = '<p>Die Rückmeldung wird vorbereitet. Du kannst den Stand erneut laden.</p>';
    host.innerHTML = '<article class="card"><h3>' + esc(entry.topic || 'Gespeicherter Text') + '</h3><p class="small muted">Archiv · schreibgeschützt</p><div class="archived-writing">'
      + esc(entry.submission_id ? data.submission?.text || '' : data.text || '') + '</div>' + result
      + '<div class="row"><button class="btn" id="archived-refresh" type="button">Stand erneut laden</button><button class="btn" id="archived-close" type="button">Schließen</button></div></article>';
    el('archived-close').onclick = () => { host.replaceChildren(); host.hidden = true; };
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
    host.innerHTML = '<div class="card"><h3>Keine Prüfung ausgewählt</h3><p class="small muted">Wähle zuerst eine Prüfungsvorbereitung.</p></div>';
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
  host.innerHTML = '<p class="muted">Dein Verlauf wird geladen …</p>';
  const [history, progress, runs] = await Promise.all([api.writing.listAttempts(), api.practice.progress(), api.mock.list()]);
  if (currentView !== 'fortschritt' || !currentContext(ticket)) return;
  el('mock-history').innerHTML = '<h2>Gespeicherte Prüfungsläufe</h2>' + (runs?.ok ? mock.historyMarkup(runs.data?.runs || []) : '<p class="err">Die gespeicherten Läufe konnten nicht geladen werden.</p>');
  if (!history?.ok) { host.innerHTML = '<p class="err">Der Verlauf konnte nicht geladen werden. Bitte öffne die Ansicht erneut.</p>'; return; }
  const totals = progress?.ok ? progress.data?.totals : null;
  el('history-summary').textContent = totals ? totals.attempts + ' Antworten gespeichert · ' + totals.correct + ' richtig. Keine Prognose für deine Prüfung.' : 'Deine gespeicherten Texte und Rückmeldungen.';
  const rows = history.data.attempts || [];
  const statuses = { draft: 'Entwurf', pending: 'Rückmeldung wird vorbereitet', unassessed: 'Unbewertet', assessed: 'Rückmeldung gespeichert' };
  host.innerHTML = rows.length ? rows.map(a => '<article class="card"><div class="card-head"><h3>' + esc(a.topic || 'Schreibübung') + '</h3><span class="chip">' + esc(statuses[a.status] || a.status) + '</span></div><p class="small muted">' + esc(new Date(a.created_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })) + (a.parent_submission_id ? ' · Überarbeitung' : '') + '</p><button type="button" class="btn" data-attempt="' + esc(a.id) + '">' + (a.submission_id ? 'Text und Rückmeldung öffnen' : 'Entwurf fortsetzen') + '</button></article>').join('') : '<div class="card"><h3>Noch keine Schreibübungen</h3><p>Beginne mit einer Aufgabe. Dein Entwurf und jede Abgabe bleiben hier erreichbar.</p><a class="btn btn-primary" href="#/schreiben">Schreiben üben</a></div>';
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
    for (const button of host.querySelectorAll('[data-attempt]')) if (button.textContent === 'Entwurf fortsetzen') button.textContent = 'Gespeicherten Entwurf ansehen';
    host.querySelector('a[href="#/schreiben"]')?.remove();
  }
}
let routing = 0;

async function route() {
  if (!bootReady || sessionProblem) return;
  const request = ++routing;
  let info = preparationRoute();
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
    if (!saved?.ok) { showError('Der verlinkte Abschnitt ist nicht verfügbar.'); return; }
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
  for (const name of Object.keys(VIEW_TITLES)) el(`view-${name}`).hidden = name !== view;
  el('page-title').textContent = VIEW_TITLES[view];
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
      if (token === currentView) showError('Die Ansicht konnte nicht geladen werden: ' + (err && err.message ? err.message : err));
    });
  };
  if (view === 'abschnitt') run(() => info.runId ? mock.showRun(el('mock-host'), info.runId) : mock.list(el('mock-host')));
  if (view === 'heute') run(renderDashboard);
  if (view === 'ueben') { run(renderPracticeNext); run(renderTasks); }
  if (SKILL_SECTIONS[view]) run(() => renderSkill(view));
  if (view === 'fehler') run(renderMistakes);
  if (view === 'fortschritt') run(renderHistory);
  if (view === 'woerterbuch') run(renderDictionary);
  if (view === 'nachschlagen') run(renderGuides);
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
  const account = await api.account.read();
  if (!account?.ok) { showError('Konto konnte nicht geladen werden: ' + failure(account) + '.'); return false; }

  const settings = await api.settings.read();
  if (settings?.ok && settings.data?.settings && Number.isInteger(settings.data.revision)) {
    if (sessionProblem) return false;
    state.account = account.data;
    state.settings = settings.data.settings || {};
    state.revision = settings.data.revision;
  } else {
    showError('Einstellungen konnten nicht geladen werden: ' + failure(settings) + '.');
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
    status.textContent = 'Bitte beide Felder ausfüllen.';
    return;
  }
  const res = await api.sessions.changePassword(current, next);
  if (res && res.ok) {
    status.textContent = 'Passwort geändert. Alle anderen Sitzungen wurden beendet.';
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
  status.textContent = res && res.status === 403
    ? 'Das aktuelle Passwort stimmt nicht.'
    : 'Passwort konnte nicht geändert werden: ' + failure(res);
});

el('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!bootReady || sessionProblem || preparationSwitching || settingsSaving || !Number.isInteger(state.revision)) return;
  const status = el('settings-state');
  const button = el('save-settings');
  const prep = state.preparation, ticket = contextTicket();
  const date = el('examDate').value || null, language = el('language').value;
  let dateSaved = false;
  let settingsSaved = false;
  settingsSaving = true;
  status.textContent = 'Wird gespeichert …';
  button.disabled = true;
  el('preparation-picker').disabled = true;
  showError('');
  const recovery = message => {
    if (!currentContext(ticket) || state.preparation?.id !== prep.id) return;
    status.textContent = message + ' Deine Eingaben bleiben im Formular.';
    const reload = document.createElement('button');
    reload.type = 'button'; reload.className = 'btn btn-small'; reload.textContent = 'Aktuelle Werte laden';
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
        reload.disabled = false; showError('Die aktuellen Werte konnten nicht geladen werden. Deine Eingaben bleiben erhalten.'); return;
      }
      rememberPreparation(preparation.data);
      state.preparation = preparation.data;
      api.preparations.select(preparation.data);
      state.settings = settings.data.settings; state.revision = settings.data.revision;
      renderSettings(); renderChrome(); renderPreparation();
      status.textContent = 'Die gespeicherten Werte wurden auf deinen Wunsch geladen. Prüfe sie vor dem nächsten Speichern.';
    })());
  };
  try {
    if (activePreparation() && date !== prep.exam_date) {
      const saved = await api.preparations.update(prep.id, prep.revision, { examDate: date });
      if (!currentContext(ticket)) return;
      if (!saved?.ok) {
        const current = saved?.data?.current;
        recovery(saved?.status === 409
          ? 'Das Prüfungsdatum wurde woanders geändert.' + (current ? ' Dort gespeichert: ' + (current.exam_date || 'kein Termin') + '.' : '')
          : saved?.status === 0 ? 'Ob das Prüfungsdatum gespeichert wurde, ist unklar.' : 'Das Prüfungsdatum konnte nicht gespeichert werden.');
        return;
      }
      rememberPreparation(saved.data); state.preparation = saved.data; api.preparations.select(saved.data);
      dateSaved = true; renderChrome();
    }
    const wanted = { language, ...(state.settings?.theme ? { theme: state.settings.theme } : {}) };
    const res = await api.settings.write(state.revision, wanted);
    if (!currentContext(ticket)) return;
    if (res?.status === 409 && !sessionProblem) {
      recovery((dateSaved ? 'Das Prüfungsdatum ist gespeichert. ' : '') + 'Die Kontoeinstellungen wurden woanders geändert; deine Sprachwahl wurde nicht übernommen.');
      return;
    }
    if (!res?.ok) {
      recovery((dateSaved ? 'Das Prüfungsdatum ist gespeichert. ' : '') + (res?.status === 0 ? 'Ob die Erklärungssprache gespeichert wurde, ist unklar.' : 'Die Erklärungssprache konnte nicht gespeichert werden.'));
      return;
    }
    state.settings = res.data?.settings || wanted;
    state.revision = res.data?.revision ?? state.revision;
    renderSettings();
    // The topbar summarises two settings (the exam pill and the explanation language), so it has to be
    // re-rendered when they change. It was only rendered from route(): the button kept saying
    // "Erklärungen: Deutsch" after the learner had chosen Arabic, until they navigated somewhere.
    renderChrome();
    settingsSaved = true;
    status.textContent = 'Gespeichert.';
    setTimeout(() => { if (status.textContent === 'Gespeichert.') status.textContent = ''; }, 4000);
  } catch (err) {
    recovery((dateSaved ? 'Das Prüfungsdatum ist gespeichert. ' : '') + 'Speichern konnte nicht vollständig abgeschlossen werden.');
  } finally {
    settingsSaving = false;
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
  // Do NOT navigate on a refusal. The server's mutation origin gate can reject a sign-out (403),
  // and the learner would then land on the sign-in page believing the session had ended while the
  // cookie was still valid — a false success about a security action, which is the worst kind.
  try {
    const res = await api.auth.signOut();
    if (!res || !res.ok) {
      showError('Abmelden fehlgeschlagen: ' + failure(res) + ' Die Sitzung ist möglicherweise noch aktiv.');
      return;
    }
    location.replace('/signin');
  } catch {
    showError('Abmelden fehlgeschlagen: keine Verbindung zum Server. Die Sitzung ist möglicherweise noch aktiv.');
  }
});

el('delete-account').addEventListener('click', async () => {
  const sure = window.confirm(
    `Konto ${state.account?.email || ''} endgültig löschen?\n\nDeine eigenen Datensätze werden wirklich entfernt. Das kann nicht rückgängig gemacht werden.`);
  if (!sure) return;
  try {
    // `{}` and not no body: the server requires `application/json` on every mutating route, so a
    // bodyless DELETE is refused with 415 and account deletion could never succeed from the UI.
    const res = await api.account.remove();
    if (!res) return;
    if (res.ok || res.status === 204) { location.replace('/signin'); return; }
    showError(res.status === 0 || res.status >= 500
      ? 'Die Antwort auf deine Löschanfrage fehlt. Ob das Konto gelöscht wurde, ist unklar. Melde dich erneut an, um den Stand zu prüfen.'
      : 'Löschen fehlgeschlagen: ' + failure(res) + ' Das Konto wurde nicht entfernt.');
  } catch {
    showError('Die Antwort auf deine Löschanfrage fehlt. Ob das Konto gelöscht wurde, ist unklar. Melde dich erneut an, um den Stand zu prüfen.');
  }
});

el('export-data')?.addEventListener('click', async (event) => {
  const trigger = event.currentTarget;
  trigger.disabled = true; el('export-state').textContent = 'Dein Export wird vorbereitet …';
  const res = await api.account.export();
  trigger.disabled = false;
  if (!res?.ok) { el('export-state').textContent = 'Der Export konnte nicht erstellt werden. Bitte versuche es erneut.'; return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'hatoove-meine-daten.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  el('export-state').textContent = 'Dein Export wurde zum Download bereitgestellt.';
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
  const id = event.target?.dataset?.guide;
  if (id) guard(openGuide(id));
});

async function boot() {
  if (bootLoading || bootReady || sessionProblem) return;
  bootLoading = true;
  el('boot-retry').hidden = true;
  el('boot-signin').hidden = true;
  el('boot-message').textContent = 'Dein Konto, deine Einstellungen und deine Prüfungsvorbereitung werden geladen …';
  el('boot-choices').hidden = true;
  try {
    applyExplanationDirection();
    const session = await api.session();
    if (session?.status === 401) { location.replace(checkoutSignInPath()); return; }
    if (!session?.ok) throw new Error('Die Anmeldung konnte nicht geprüft werden. ' + failure(session));
    if (!(await refresh())) throw new Error('Dein Konto und deine Einstellungen konnten nicht vollständig geladen werden.');
    if (sessionProblem) throw new Error('Die Sitzung ist nicht mehr gültig.');
    // Owned orders can be read even before a preparation is selected or available.
    const returnInfo = checkoutRoute(location.hash);
    if (returnInfo.orderId || returnInfo.invalid) await checkout.open(el('checkout-boot-host'), returnInfo);
    if (!(await loadPreparations())) return;
    await unlockPreparation();
  } catch (err) {
    if (bootReady) { showError('Die Ansicht konnte nicht geladen werden: ' + (err?.message || err)); return; }
    el('boot-message').textContent = sessionProblem
      ? 'Die Sitzung ist nicht mehr gültig oder das Konto wurde gewechselt. Bitte melde dich erneut an.'
      : (err?.message || 'Die Ansicht konnte nicht geladen werden.') + ' Bitte versuche es erneut.';
    el('boot-retry').hidden = Boolean(sessionProblem);
    el('boot-signin').hidden = !sessionProblem;
    el('boot-signin').href = checkoutSignInPath();
  } finally {
    bootLoading = false;
  }
}
el('boot-retry').addEventListener('click', () => guard(boot()));
guard(boot());
