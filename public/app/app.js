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

const el = (id) => document.getElementById(id);

const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', uk: 'Українська', ar: 'العربية', tr: 'Türkçe' };
const VIEW_TITLES = { heute: 'Heute', ueben: 'Üben', fortschritt: 'Fortschritt', einstellungen: 'Einstellungen' };

/** Server state, held in memory only. */
const state = { account: null, settings: null, revision: null };

// ---------------------------------------------------------------- plumbing

function showError(message) {
  const box = el('error');
  box.textContent = message || '';
  box.hidden = !message;
}

/** A JSON call that treats an expired session as "go and sign in", not as an error to render. */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { location.replace('/signin'); return null; }
  let payload = null;
  try { payload = await res.json(); } catch { /* a refusal may carry no body; status still counts */ }
  return { status: res.status, ok: res.ok, payload };
}

// ---------------------------------------------------------------- rendering

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
  el('language').value = ['de', 'en'].includes(language) ? language : 'de';

  el('fact-exam').textContent = examDate || 'nicht gesetzt';
  el('fact-language').textContent = LANGUAGE_NAMES[language] || language || '–';
  el('account-exam').textContent = examDate ? `Prüfung am ${examDate}` : 'Kein Prüfungsdatum';

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

function route() {
  const key = (location.hash || '#/heute').replace(/^#\/?/, '') || 'heute';
  const view = VIEW_TITLES[key] ? key : 'heute';
  for (const name of Object.keys(VIEW_TITLES)) el(`view-${name}`).hidden = name !== view;
  el('page-title').textContent = VIEW_TITLES[view];
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function refresh() {
  const account = await api('GET', '/api/v1/account');
  if (!account) return;
  if (!account.ok) { showError(`Konto konnte nicht geladen werden (${account.status}).`); return; }
  state.account = account.payload;

  const settings = await api('GET', '/api/v1/settings');
  if (settings && settings.ok) {
    state.settings = settings.payload.settings || {};
    state.revision = settings.payload.revision;
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
    const res = await api('PUT', '/api/v1/settings', { expectedRevision: state.revision ?? 0, settings: wanted });
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
    state.settings = res.payload?.settings || wanted;
    state.revision = res.payload?.revision ?? state.revision;
    renderSettings();
    status.textContent = 'Gespeichert.';
    setTimeout(() => { if (status.textContent === 'Gespeichert.') status.textContent = ''; }, 4000);
  } finally {
    button.disabled = false;
  }
});

el('signout').addEventListener('click', async () => {
  await api('POST', '/api/auth/sign-out', {});
  location.replace('/signin');
});

el('delete-account').addEventListener('click', async () => {
  const sure = window.confirm(
    'Konto endgültig löschen?\n\nDeine eigenen Datensätze werden wirklich entfernt. Das kann nicht rückgängig gemacht werden.');
  if (!sure) return;
  const res = await api('DELETE', '/api/v1/account');
  if (!res) return;
  if (res.ok || res.status === 204) { location.replace('/signin'); return; }
  showError(`Löschen fehlgeschlagen (${res.status}). Das Konto wurde nicht entfernt.`);
});

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- boot

(async () => {
  const session = await fetch('/api/auth/get-session', { headers: { accept: 'application/json' } });
  if (!session.ok) { location.replace('/signin'); return; }
  route();
  await refresh();
})();
