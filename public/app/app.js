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

const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', uk: 'Українська', ar: 'العربية', tr: 'Türkçe' };
/**
 * The explanation languages the shell offers. It is the same list as the `<option>` elements in
 * index.html and it is enforced here too: a stored value outside it is not silently displayed as
 * the learner's choice. All five render — `noto-sans-latin-ext`, `noto-sans-cyrillic` and
 * `noto-sans-arabic` carry the scripts the branding faces do not (tools/design-assets-check.mjs D7).
 */
const EXPLANATION_LANGUAGES = ['de', 'en', 'uk', 'ar', 'tr'];
const RTL_LANGUAGES = ['ar'];
const VIEW_TITLES = {
  heute: 'Heute', ueben: 'Üben', woerterbuch: 'Wörterbuch', nachschlagen: 'Nachschlagen',
  fehler: 'Fehler', fortschritt: 'Fortschritt', einstellungen: 'Einstellungen',
};

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
  const [writing, objective] = await Promise.all([
    api.tasks.list({ family: 'writing' }),
    api.objectiveSets.list(),
  ]);
  if (!writing || !objective) return; // a 401 already redirected us to the sign-in page
  if (!writing.ok || !objective.ok) {
    box.innerHTML = '';
    showError('Aufgaben konnten nicht geladen werden (' + writing.status + '/' + objective.status + ').');
    return;
  }
  const tasks = Array.isArray(writing.data) ? writing.data : [];
  const sets = Array.isArray(objective.data) ? objective.data : [];
  const card = (title, chip, line, meta) => '<div class="card"><div class="card-head"><h3>'
    + title + '</h3><span class="chip">' + chip + '</span></div>'
    + '<p class="muted">' + line + '</p>'
    + '<p class="small muted">' + meta + '</p></div>';
  const groups = [];
  if (tasks.length) {
    groups.push('<h3 class="section-head">Schreiben</h3>' + tasks.map((t) => card(
      t.topic, t.family, t.situation,
      'Anrede: ' + t.adressat + ' &middot; Register: ' + t.register
        + ' &middot; Fassung ' + t.version + ' &middot; Prüfstatus: ' + t.review_status,
    )).join(''));
  }
  if (sets.length) {
    groups.push('<h3 class="section-head">Lesen und Sprachbausteine</h3>' + sets.map((s) => card(
      s.title, s.family, s.item_count + ' Aufgaben',
      'Teil ' + s.part + ' &middot; Fassung ' + s.version + ' &middot; Prüfstatus: ' + s.review_status,
    )).join(''));
  }
  if (!groups.length) {
    box.innerHTML = '<div class="card"><h3>Zurzeit keine Aufgaben freigegeben</h3>'
      + '<p class="muted">Der Server hat für dieses Angebot gerade nichts Servierbares. Das ist eine '
      + 'Aussage des Servers, keine leere Seite.</p></div>';
    return;
  }
  box.innerHTML = groups.join('');
}


/**
 * WOERTERBUCH -- the 300-word list and the 240-noun lexicon, from the API.
 *
 * Two corpora in one view because they answer one question ("what does this word mean and how do I use
 * it"), and because a learner does not care which table a word lives in. The server bounds the response
 * and refuses a one-character search, so the view must not fire one either.
 */
let dictMode = 'vocab';
async function renderDictionary() {
  const box = el('dict-results');
  if (!box) return;
  const q = (el('dict-q')?.value || '').trim();
  if (q.length === 1) { box.innerHTML = '<div class="card"><p class="muted">Mindestens zwei Buchstaben.</p></div>'; return; }
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const res = dictMode === 'nouns' ? await api.nouns.list({ q: q || null }) : await api.vocab.list({ q: q || null });
  if (!res) return; // a 401 already redirected
  if (!res.ok) { box.innerHTML = ''; showError('Nachschlagen fehlgeschlagen (' + res.status + ').'); return; }
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) {
    box.innerHTML = '<div class="card"><h3>Nichts gefunden</h3><p class="muted">Der Server hat zu dieser Suche keinen Eintrag.</p></div>';
    return;
  }
  box.innerHTML = rows.map((w) => (dictMode === 'nouns'
    ? '<div class="card"><div class="card-head"><h3>' + esc(w.de) + '</h3><span class="chip">' + esc(w.gender) + '</span></div>'
      + '<p class="muted">' + esc(w.en) + '</p>'
      + '<p class="small muted">Plural: ' + esc(w.plural) + ' &middot; Thema: ' + esc(w.theme) + '</p>'
      + '<p class="small muted">Regel: ' + esc(w.rule) + '</p>'
      + (w.example ? '<p class="small">' + esc(w.example) + '</p>' : '') + '</div>'
    : '<div class="card"><div class="card-head"><h3>' + esc(w.de) + '</h3><span class="chip">' + esc(w.pos) + '</span></div>'
      + '<p class="muted">' + esc(w.en) + '</p>'
      + (w.plural ? '<p class="small muted">Plural: ' + esc(w.plural) + '</p>' : '')
      + (w.example ? '<p class="small">' + esc(w.example) + '</p>' : '') + '</div>')).join('');
}

/** NACHSCHLAGEN -- the guide index, then one document's sections. */
async function renderGuides() {
  const box = el('guide-index');
  if (!box) return;
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';
  const res = await api.guides.list();
  if (!res) return;
  if (!res.ok) { box.innerHTML = ''; showError('Nachschlagen fehlgeschlagen (' + res.status + ').'); return; }
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
  if (!res.ok) { box.innerHTML = ''; showError('Das Nachschlagewerk konnte nicht geladen werden (' + res.status + ').'); return; }
  const g = res.data;
  const sections = Array.isArray(g.sections) ? g.sections : [];
  box.innerHTML = '<div class="card"><div class="card-head"><h3>' + esc(g.title)
    + '</h3><span class="chip">' + sections.length + '</span></div>'
    + '<button class="btn" type="button" id="guide-back">Zurück</button></div>'
    + sections.map((s) => '<div class="card"><div class="card-head"><h3>' + esc(s.title)
      + '</h3><span class="chip">' + esc(s.kind) + '</span></div>'
      + (s.summary ? '<p class="muted">' + esc(s.summary) + '</p>' : '')
      + '<pre class="small">' + esc(JSON.stringify(s.payload, null, 1)) + '</pre></div>').join('');
  el('guide-back').addEventListener('click', () => { box.hidden = true; index.hidden = false; });
}

/** UEBEN's adaptive recommendation, above the catalogue. */
async function renderPracticeNext() {
  const box = el('practice-next');
  if (!box) return;
  const res = await api.practice.next();
  if (!res) return;
  if (!res.ok) return; // the catalogue below still renders; a failed suggestion is not an error page
  const data = res.data || {};
  if (!data.set) { box.innerHTML = ''; return; }
  const e = data.evidence || {};
  const why = data.reason === 'section_not_started'
    ? 'Dieser Bereich ist noch neu für dich.'
    : (e.attempts ? e.correct + ' von ' + e.attempts + ' richtig (' + Math.round((e.accuracy || 0) * 100) + '%).' : '');
  box.innerHTML = '<div class="card"><div class="card-head"><h3>Deine nächste Aufgabe</h3><span class="chip">'
    + esc(data.section) + '</span></div>'
    + '<p><strong>' + esc(data.set.title) + '</strong> &middot; ' + data.set.item_count + ' Aufgaben</p>'
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
  const crumb = el('crumb-date');
  if (crumb) crumb.textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const countdown = el('exam-countdown');
  if (countdown) {
    if (settings.examDate) {
      const exam = new Date(settings.examDate + 'T00:00:00');
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
  const pct = (value) => Math.round((value || 0) * 100) + '%';
  const [next, progress] = await Promise.all([api.practice.next(), api.practice.progress()]);
  if (!next || !progress) return; // a 401 already redirected

  if (next.ok && next.data && next.data.set) {
    const d = next.data;
    const e = d.evidence || {};
    el('next-kicker').textContent = 'Als Nächstes · ' + d.section;
    el('next-title').textContent = d.set.title;
    el('next-detail').textContent = d.set.item_count + ' Aufgaben'
      + (d.reason === 'section_not_started'
        ? ' · dieser Bereich ist neu für dich'
        : (e.attempts ? ' · bisher ' + e.correct + ' von ' + e.attempts + ' richtig' : ''));
  } else {
    el('next-kicker').textContent = 'Als Nächstes';
    el('next-title').textContent = 'Zurzeit nichts freigegeben';
    el('next-detail').textContent = 'Der Server hat gerade nichts Servierbares. Das ist eine Aussage des Servers, keine leere Seite.';
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
    ? sections.map((s) => '<div class="part"><span>' + esc(s.section) + '</span>'
      + '<div class="mini"><i style="width:' + pct(s.accuracy) + '"></i></div>'
      + '<b>' + s.correct + ' / ' + s.attempts + '</b></div>').join('')
    : '<p class="small muted">Sobald du Aufgaben beantwortest, erscheint hier deine Bilanz je Bereich.</p>';

  const settings = state.settings || {};
  if (settings.examDate) {
    const exam = new Date(settings.examDate + 'T00:00:00');
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
  const badge = el('mistake-count');
  const box = el('mistake-list');
  const res = await api.practice.mistakes();
  if (!res) return; // a 401 already redirected
  if (!res.ok) {
    if (box) { box.innerHTML = ''; showError('Fehler konnten nicht geladen werden (' + res.status + ').'); }
    return;
  }
  const data = res.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const count = Number.isInteger(data.count) ? data.count : items.length;

  if (badge) {
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
  box.innerHTML = items.map((m) => '<div class="list-item"><div><strong>' + esc(m.set_title)
    + '</strong><span class="sub">Bereich ' + esc(m.section) + ' &middot; Aufgabe ' + esc(m.item_id)
    + ' von ' + m.set_item_count + '</span></div>'
    + '<span class="chip chip-orange">deine Antwort: ' + esc(JSON.stringify(m.your_answer)) + '</span></div>').join('');
}

function route() {
  const key = (location.hash || '#/heute').replace(/^#\/?/, '') || 'heute';
  const view = VIEW_TITLES[key] ? key : 'heute';
  for (const name of Object.keys(VIEW_TITLES)) el(`view-${name}`).hidden = name !== view;
  el('page-title').textContent = VIEW_TITLES[view];
  renderChrome();
  if (view === 'heute') void renderDashboard();
  if (view === 'ueben') { void renderPracticeNext(); void renderTasks(); }
  if (view === 'fehler') void renderMistakes();
  if (view === 'woerterbuch') void renderDictionary();
  if (view === 'nachschlagen') void renderGuides();
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
  el('dict-q')?.addEventListener('input', () => void renderDictionary());
  el('dict-mode-vocab')?.addEventListener('click', () => { dictMode = 'vocab'; void renderDictionary(); });
  el('dict-mode-nouns')?.addEventListener('click', () => { dictMode = 'nouns'; void renderDictionary(); });
  el('guide-index')?.addEventListener('click', (event) => {
    const id = event.target?.dataset?.guide;
    if (id) void openGuide(id);
  });
  route();
  await refresh();
  void renderMistakes();
})();
