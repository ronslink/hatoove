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

const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', uk: 'Українська', ar: 'العربية', tr: 'Türkçe' };
/**
 * The explanation languages the shell offers. It is the same list as the `<option>` elements in
 * index.html and it is enforced here too: a stored value outside it is not silently displayed as
 * the learner's choice. All five render — `noto-sans-latin-ext`, `noto-sans-cyrillic` and
 * `noto-sans-arabic` carry the scripts the branding faces do not (tools/design-assets-check.mjs D7).
 */
const EXPLANATION_LANGUAGES = ['de', 'en', 'uk', 'ar', 'tr'];
const RTL_LANGUAGES = ['ar'];
const VIEW_TITLES = { heute: 'Heute', ueben: 'Üben', fortschritt: 'Fortschritt', einstellungen: 'Einstellungen' };

/** Server state, held in memory only. */
const state = { account: null, settings: null, revision: null };

// ---------------------------------------------------------------- plumbing

function showError(message) {
  const box = el('error');
  box.textContent = message || '';
  box.hidden = !message;
}


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
  el('fact-email').textContent = email;
  el('avatar').textContent = (email[0] || '?').toUpperCase();
  el('greeting').textContent = email.startsWith('–') ? 'Willkommen' : `Willkommen, ${email.split('@')[0]}`;
}

function renderSettings() {
  const settings = state.settings || {};
  const examDate = settings.examDate || '';
  const language = settings.language || 'de';

  el('examDate').value = examDate;
  el('language').value = EXPLANATION_LANGUAGES.includes(language) ? language : 'de';

  el('fact-exam').textContent = examDate || 'nicht gesetzt';
  el('fact-language').textContent = LANGUAGE_NAMES[language] || language || '–';
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
 */
async function renderTasks() {
  const box = el('task-list');
  if (!box) return;
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const res = await api.tasks.list({ family: 'writing' });
  if (!res) return; // a 401 already redirected us to the sign-in page
  if (!res.ok) {
    box.innerHTML = '';
    showError('Aufgaben konnten nicht geladen werden (' + res.status + ').');
    return;
  }
  const tasks = Array.isArray(res.data) ? res.data : [];
  if (!tasks.length) {
    box.innerHTML = '<div class="card"><h3>Zurzeit keine Aufgaben freigegeben</h3>'
      + '<p class="muted">Der Server hat für dieses Angebot gerade nichts Servierbares. Das ist eine '
      + 'Aussage des Servers, keine leere Seite.</p></div>';
    return;
  }
  box.innerHTML = tasks.map((t) => '<div class="card"><div class="card-head"><h3>'
    + t.topic + '</h3><span class="chip">' + t.family + '</span></div>'
    + '<p class="muted">' + t.situation + '</p>'
    + '<p class="small muted">Anrede: ' + t.adressat + ' &middot; Register: ' + t.register
    + ' &middot; Fassung ' + t.version + ' &middot; Prüfstatus: ' + t.review_status + '</p></div>').join('');
}

function route() {
  const key = (location.hash || '#/heute').replace(/^#\/?/, '') || 'heute';
  const view = VIEW_TITLES[key] ? key : 'heute';
  for (const name of Object.keys(VIEW_TITLES)) el(`view-${name}`).hidden = name !== view;
  el('page-title').textContent = VIEW_TITLES[view];
  if (view === 'ueben') void renderTasks();
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function refresh() {
  const account = await api.account.read();
  if (!account) return;
  if (!account.ok) { showError(`Konto konnte nicht geladen werden (${account.status}).`); return; }
  state.account = account.data;

  const settings = await api.settings.read();
  if (settings && settings.ok) {
    state.settings = settings.data.settings || {};
    state.revision = settings.data.revision;
  } else if (settings) {
    showError(`Einstellungen konnten nicht geladen werden (${settings.status}).`);
  }
  renderAccount();
  renderSettings();
}

// ---------------------------------------------------------------- actions

el('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = el('settings-state');
  const button = el('save-settings');
  status.textContent = 'Wird gespeichert …';
  button.disabled = true;
  showError('');
  try {
    const wanted = { examDate: el('examDate').value, language: el('language').value };
    const res = await api.settings.write(state.revision ?? 0, wanted);
    if (!res) return;
    if (res.status === 409) {
      // The server keeps a revision per account. A conflict is not a failure to hide: the learner
      // is told their view was stale and the current values are loaded.
      status.textContent = '';
      showError('Die Einstellungen wurden zwischenzeitlich woanders geändert. Die aktuellen Werte sind geladen — bitte erneut speichern.');
      await refresh();
      return;
    }
    if (!res.ok) { status.textContent = ''; showError(`Speichern fehlgeschlagen (${res.status}).`); return; }
    state.settings = res.data?.settings || wanted;
    state.revision = res.data?.revision ?? state.revision;
    renderSettings();
    status.textContent = 'Gespeichert.';
    setTimeout(() => { if (status.textContent === 'Gespeichert.') status.textContent = ''; }, 4000);
  } finally {
    button.disabled = false;
  }
});

el('signout').addEventListener('click', async () => {
  // Do NOT navigate on a refusal. The server's mutation origin gate can reject a sign-out (403),
  // and the learner would then land on the sign-in page believing the session had ended while the
  // cookie was still valid — a false success about a security action, which is the worst kind.
  try {
    const res = await api.auth.signOut();
    if (!res || !res.ok) {
      showError(`Abmelden fehlgeschlagen (${res ? res.status : 'abgebrochen'}). Die Sitzung ist möglicherweise noch aktiv.`);
      return;
    }
    location.replace('/signin');
  } catch {
    showError('Abmelden fehlgeschlagen: keine Verbindung zum Server. Die Sitzung ist möglicherweise noch aktiv.');
  }
});

el('delete-account').addEventListener('click', async () => {
  const sure = window.confirm(
    'Konto endgültig löschen?\n\nDeine eigenen Datensätze werden wirklich entfernt. Das kann nicht rückgängig gemacht werden.');
  if (!sure) return;
  try {
    // `{}` and not no body: the server requires `application/json` on every mutating route, so a
    // bodyless DELETE is refused with 415 and account deletion could never succeed from the UI.
    const res = await api.account.remove();
    if (!res) return;
    if (res.ok || res.status === 204) { location.replace('/signin'); return; }
    showError(`Löschen fehlgeschlagen (${res.status}). Das Konto wurde nicht entfernt.`);
  } catch {
    showError('Löschen fehlgeschlagen: keine Verbindung zum Server. Das Konto wurde nicht entfernt.');
  }
});

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- boot

(async () => {
  // Tag the options before the first settings read, so the language tags and `dir` are never
  // missing while the request is in flight.
  applyExplanationDirection();
  // The session comes through the same API layer as everything else. A 401 here is NOT auto-
  // redirected by the layer (auth paths are excluded, because sign-in itself returns 401), so the
  // boot decides for itself.
  const session = await api.session();
  if (!session || !session.ok) { location.replace('/signin'); return; }
  route();
  await refresh();
})();
