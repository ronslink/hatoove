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
  heute: 'Heute', ueben: 'Üben', woerterbuch: 'Wörterbuch', nachschlagen: 'Nachschlagen',
  // The design organises practice by SKILL. Each maps to a section the catalogue already carries.
  lesen: 'Leseverstehen', sprachbausteine: 'Sprachbausteine',
  hoeren: 'Hörverstehen', schreiben: 'Schreiben',
  fehler: 'Fehler', fortschritt: 'Fortschritt', einstellungen: 'Einstellungen',
};

/** Server state, held in memory only. */
const state = { account: null, settings: null, revision: null };

/** The view currently on screen, so a late failure from the previous one is not painted over it. */
let currentView = 'heute';

// ---------------------------------------------------------------- plumbing

function showError(message) {
  const box = el('error');
  box.textContent = message || '';
  box.hidden = !message;
}

/**
 * How to describe a failed call to a learner.
 *
 * `status === 0` means the request never reached the server (see `api.js`), and printing "(0)" for a
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

function renderSettings() {
  const settings = state.settings || {};
  const examDate = settings.examDate || '';
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
    showError('Aufgaben konnten nicht geladen werden: ' + failure(writing.ok ? objective : writing) + '.');
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
      esc(t.topic), esc(t.family), esc(t.situation),
      'Anrede: ' + esc(t.adressat) + ' &middot; Register: ' + esc(t.register)
        + ' &middot; Fassung ' + esc(t.version) + ' &middot; Prüfstatus: ' + esc(t.review_status),
    )).join(''));
  }
  if (sets.length) {
    // setLabel(), not s.title: nine seeded sets have no authored title and the generator wrote
    // `LV3 1` into the column. This view was the one place it still reached the screen.
    groups.push('<h3 class="section-head">Lesen und Sprachbausteine</h3>' + sets.map((s) => card(
      esc(setLabel(s)), esc(s.family), s.item_count + ' Aufgaben',
      'Teil ' + s.part + ' &middot; Fassung ' + esc(s.version) + ' &middot; Prüfstatus: ' + esc(s.review_status),
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
  if (!res.ok) { box.innerHTML = ''; showError('Nachschlagen fehlgeschlagen: ' + failure(res) + '.'); return; }
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
  if (!res.ok) { box.innerHTML = ''; showError('Das Nachschlagewerk konnte nicht geladen werden: ' + failure(res) + '.'); return; }
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
  // TWO badges, ONE truth: the sidebar and the phone tabbar each carry the count, and the ids are
  // distinct. The first version repeated `id="mistake-count"`, so `getElementById` only ever found the
  // sidebar one: at <=860px the sidebar is `display:none`, and the badge a phone learner needs was the
  // one that never updated.
  const badges = [el('mistake-count'), el('mistake-count-tab')].filter(Boolean);
  const box = el('mistake-list');
  const res = await api.practice.mistakes();
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
    + '</strong><span class="sub">' + esc(sectionName(m.section)) + ' &middot; Aufgabe ' + esc(m.item_id)
    + ' von ' + m.set_item_count + '</span></div>'
    + '<span class="chip chip-orange">deine Antwort: ' + esc(JSON.stringify(m.your_answer)) + '</span></div>').join('') + '</div>';
}


/** The skill views, and the section each one asks the server for. */
const SKILL_SECTIONS = { lesen: 'LV', sprachbausteine: 'SB', hoeren: 'HV', schreiben: 'writing' };

/**
 * One skill's practice, from the catalogue.
 *
 * THE LIST IS THE SERVER'S ANSWER, including when it is empty. Hoeren is empty ON PURPOSE: the nine
 * listening sets exist, carry transcripts, and are marked media_required because there is no audio.
 * Serving their items would make a Hoeren task a Lesen task wearing a Hoeren label, so this view says
 * so rather than showing something to fill the space.
 */
async function renderSkill(view) {
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
  box.innerHTML = '<div class="card"><h3>Wird geladen ...</h3></div>';

  if (section === 'writing') {
    const res = await api.tasks.list({ family: 'writing' });
    if (!res) return;
    if (!res.ok) { box.innerHTML = ''; showError('Aufgaben konnten nicht geladen werden: ' + failure(res) + '.'); return; }
    const tasks = Array.isArray(res.data) ? res.data : [];
    box.innerHTML = tasks.length
      ? tasks.map((t) => '<div class="card"><div class="card-head"><h3>' + esc(t.topic)
        + '</h3><span class="chip">' + esc(t.family) + '</span></div>'
        + '<p class="muted">' + esc(t.situation) + '</p>'
        + '<p class="small muted">Anrede: ' + esc(t.adressat) + ' &middot; Prüfstatus: ' + esc(t.review_status) + '</p></div>').join('')
      : '<div class="card"><h3>Zurzeit keine Schreibaufgaben</h3><p class="muted">Der Server hat gerade nichts Servierbares.</p></div>';
    return;
  }

  const res = await api.objectiveSets.list();
  if (!res) return;
  if (!res.ok) { box.innerHTML = ''; showError('Aufgaben konnten nicht geladen werden: ' + failure(res) + '.'); return; }
  const sets = (Array.isArray(res.data) ? res.data : []).filter((s) => s.section === section);
  if (!sets.length) {
    box.innerHTML = section === 'HV'
      ? '<div class="card"><h3>Hörverstehen braucht Ton</h3><p class="muted">Die Aufgaben sind vorhanden, '
        + 'aber es gibt noch kein Audio. Sie werden deshalb nicht angezeigt — eine Höraufgabe ohne Ton '
        + 'wäre eine Leseaufgabe mit falschem Etikett.</p></div>'
      : '<div class="card"><h3>Zurzeit keine Aufgaben</h3><p class="muted">Der Server hat für diesen '
        + 'Bereich gerade nichts Servierbares.</p></div>';
    return;
  }
  box.innerHTML = sets.map((s) => '<div class="card"><div class="card-head"><h3>' + esc(setLabel(s))
    + '</h3><span class="chip">' + esc(s.family) + '</span></div>'
    + '<p class="muted">' + s.item_count + ' Aufgaben &middot; Teil ' + s.part + '</p>'
    + '<p class="small muted">Prüfstatus: ' + esc(s.review_status) + '</p>'
    + '<button class="btn btn-primary" type="button" data-open="' + esc(s.set_id) + '">Üben</button></div>').join('');
  box.onclick = (event) => {
    const id = event.target?.dataset?.open;
    if (id) guard(openSet(id));
  };
}


/**
 * PRACTICE -- answer one item at a time, marked by the server.
 *
 * THE FAMILIES ARE NOT ONE SHAPE and the form says so. LV1 matches texts to headlines, LV3 matches
 * situations to ads, SB1 and SB2 are gap-fills (SB2 from a bank), LV2 is multiple choice per question.
 * They are normalised here into one honest shape -- a passage, a list of lettered options, and items --
 * rather than one of them being flattened into another's mould.
 *
 * THE CLIENT NEVER MARKS ANYTHING. It posts the answer and shows the boolean the server returns, which
 * comes from a SECURITY DEFINER function the learner's own database role could not replace.
 */
function objectiveForm(set) {
  const p = set.payload || {};
  const opts = (list, idKey, textKey) => (list || []).map((o) => ({
    id: String(o[idKey]), label: String(o[textKey] ?? o.text ?? o.word ?? ''),
  }));
  const fromMap = (map) => Object.entries(map || {}).map(([id, label]) => ({ id, label: String(label) }));
  switch (set.family) {
    case 'LV1':
      return { passages: [{ label: 'Überschriften', lines: (p.headlines || []).map((h) => h.id + ') ' + h.text) }],
        options: opts(p.headlines, 'id', 'text'),
        items: (p.texts || []).map((t) => ({ id: String(t.id), prompt: t.text, options: null })) };
    case 'LV3':
      return { passages: [{ label: 'Anzeigen', lines: (p.ads || []).map((a) => a.id + ') ' + a.text) }],
        options: opts(p.ads, 'id', 'text'),
        items: (p.situations || []).map((s) => ({ id: String(s.n), prompt: s.text, options: null })) };
    case 'SB2':
      return { passages: [{ label: 'Brief', lines: [p.letter] }],
        options: opts(p.bank, 'id', 'word'),
        items: (p.gaps || []).map((g) => ({ id: String(g.n), prompt: 'Lücke ' + g.n, options: null })) };
    case 'LV2':
      return { passages: [{ label: 'Text', lines: [p.text] }], options: null,
        items: (p.questions || []).map((q) => ({ id: String(q.n), prompt: q.question, options: fromMap(q.options) })) };
    case 'SB1':
      return { passages: [{ label: 'Brief', lines: [p.letter] }], options: null,
        items: (p.gaps || []).map((g) => ({ id: String(g.n), prompt: 'Lücke ' + g.n, options: fromMap(g.options) })) };
    default:
      return null;
  }
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
    + form.items.map((item) => {
      const options = item.options || form.options || [];
      return '<section class="card" data-item="' + esc(item.id) + '"><p class="kicker">Aufgabe '
        + esc(item.id) + '</p><p>' + esc(item.prompt) + '</p><div class="row">'
        + options.map((o) => '<button class="btn" type="button" data-answer="' + esc(o.id) + '" title="'
          + esc(o.label) + '">' + esc(o.id) + ') ' + esc(o.label.slice(0, 40)) + '</button>').join('')
        + '</div><p class="small muted result"></p></section>';
    }).join('');
}

/** Post one answer and show what the SERVER said, not what the client guessed. */
async function answerItem(setId, card, itemId, answer) {
  const out = card.querySelector('.result');
  out.textContent = 'Wird geprüft ...';
  const res = await api.practice.answer(setId, { itemId, answer });
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
async function openSet(setId) {
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
  const res = await api.objectiveSets.read(setId);
  if (!res) return;
  if (!res.ok) {
    box.innerHTML = '';
    if (list) list.hidden = false;
    showError('Die Aufgaben konnten nicht geladen werden: ' + failure(res) + '.');
    return;
  }
  const set = res.data;
  box.innerHTML = '<div class="card"><div class="card-head"><h3>' + esc(setLabel(set))
    + '</h3><span class="chip">' + esc(set.family) + '</span></div>'
    + '<button class="btn" type="button" id="practice-close">Schließen</button></div>'
    + '<div class="stack" id="practice-items"></div>';
  renderObjectiveForm(set, el('practice-items'));
  /*
   * ASSIGNMENT, not addEventListener. `box` is the same element for the whole life of the view, so an
   * added listener accumulated one per set opened: opening a second set made one answer POST twice,
   * and the evidence table would record the learner answering once and being charged twice.
   */
  box.onclick = (event) => {
    const answer = event.target?.dataset?.answer;
    const card = event.target?.closest('[data-item]');
    if (answer && card) guard(answerItem(set.set_id, card, card.dataset.item, answer));
  };
  el('practice-close')?.addEventListener('click', () => {
    box.hidden = true;
    box.innerHTML = '';
    if (list) list.hidden = false;
  });
}

function route() {
  const key = (location.hash || '#/heute').replace(/^#\/?/, '') || 'heute';
  const view = VIEW_TITLES[key] ? key : 'heute';
  /*
   * Which view is on screen, so a SLOW failure cannot paint on the wrong one.
   *
   * Clearing the message here is not enough on its own: a render from the view the learner just left can
   * still reject a second later, and its message would appear over the new screen — describing something
   * that is no longer on display. The token is checked before anything is written.
   */
  currentView = view;
  for (const name of Object.keys(VIEW_TITLES)) el(`view-${name}`).hidden = name !== view;
  el('page-title').textContent = VIEW_TITLES[view];
  renderChrome();
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
  if (view === 'heute') run(renderDashboard);
  if (view === 'ueben') { run(renderPracticeNext); run(renderTasks); }
  if (SKILL_SECTIONS[view]) run(() => renderSkill(view));
  if (view === 'fehler') run(renderMistakes);
  if (view === 'woerterbuch') run(renderDictionary);
  if (view === 'nachschlagen') run(renderGuides);
  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function refresh() {
  const account = await api.account.read();
  if (!account) return;
  if (!account.ok) { showError('Konto konnte nicht geladen werden: ' + failure(account) + '.'); return; }
  state.account = account.data;

  const settings = await api.settings.read();
  if (settings && settings.ok) {
    state.settings = settings.data.settings || {};
    state.revision = settings.data.revision;
  } else if (settings) {
    showError('Einstellungen konnten nicht geladen werden: ' + failure(settings) + '.');
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
    if (!res.ok) { status.textContent = ''; showError('Speichern fehlgeschlagen: ' + failure(res) + '.'); return; }
    state.settings = res.data?.settings || wanted;
    state.revision = res.data?.revision ?? state.revision;
    renderSettings();
    status.textContent = 'Gespeichert.';
    setTimeout(() => { if (status.textContent === 'Gespeichert.') status.textContent = ''; }, 4000);
  } catch (err) {
    // `finally` alone left the button re-enabled but the learner staring at "Wird gespeichert …": the
    // handler had no catch, so a rejection was silent. Same shape as the boot guard above.
    status.textContent = '';
    showError('Speichern fehlgeschlagen: ' + (err && err.message ? err.message : 'unbekannter Fehler'));
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
    'Konto endgültig löschen?\n\nDeine eigenen Datensätze werden wirklich entfernt. Das kann nicht rückgängig gemacht werden.');
  if (!sure) return;
  try {
    // `{}` and not no body: the server requires `application/json` on every mutating route, so a
    // bodyless DELETE is refused with 415 and account deletion could never succeed from the UI.
    const res = await api.account.remove();
    if (!res) return;
    if (res.ok || res.status === 204) { location.replace('/signin'); return; }
    showError('Löschen fehlgeschlagen: ' + failure(res) + ' Das Konto wurde nicht entfernt.');
  } catch {
    showError('Löschen fehlgeschlagen: keine Verbindung zum Server. Das Konto wurde nicht entfernt.');
  }
});

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- boot

(async () => {
  /*
   * The whole boot is guarded, and that guard is not decoration. A single missing element id in
   * `renderAccount()` threw here, which silently skipped `renderSettings()` and the mistakes badge
   * after it: the screen looked half-alive and nothing said why. Nothing reaches the learner now
   * except through a message they can read.
   */
  try {
    // Tag the options before the first settings read, so the language tags and `dir` are never
    // missing while the request is in flight.
    applyExplanationDirection();
    // The session comes through the same API layer as everything else. A 401 here is NOT auto-
    // redirected by the layer (auth paths are excluded, because sign-in itself returns 401), so the
    // boot decides for itself. NOTE: `get-session` answers 200 with a null body when signed out, so
    // this guard cannot fire on its own — the static gate on /app/ and the 401 from the first owned
    // call are what actually refuse an anonymous visitor.
    const session = await api.session();
    if (!session || !session.ok) { location.replace('/signin'); return; }
    el('dict-q')?.addEventListener('input', () => guard(renderDictionary()));
    el('dict-mode-vocab')?.addEventListener('click', () => { dictMode = 'vocab'; guard(renderDictionary()); });
    el('dict-mode-nouns')?.addEventListener('click', () => { dictMode = 'nouns'; guard(renderDictionary()); });
    el('guide-index')?.addEventListener('click', (event) => {
      const id = event.target?.dataset?.guide;
      if (id) guard(openGuide(id));
    });
    route();
    await refresh();
    guard(renderMistakes());
  } catch (err) {
    showError('Die Ansicht konnte nicht geladen werden: ' + (err && err.message ? err.message : err));
  }
})();
