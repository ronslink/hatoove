/**
 * Core views: dashboard, adaptive drill, vocabulary, error notebook, plan, settings.
 */

import {
  esc, $, $$, on, delegate, toast, busy, unbusy, navigate, confirmDialog,
  pct, round1, barClass, masteryLabel, statCard, progressLine,
  fmtDate, fmtDuration, spinnerRow, setViewActions,
} from './shell.js';
import * as store from './store.js';
import * as engine from './engine.js';
import * as ai from './ai.js';
import { PARTS, tagInfo } from './blueprint.js';
import { OFFLINE_TAGS } from './generators.js';
import { speak, ttsSupported, germanVoices, waitForVoices } from './speech.js';
import { icon } from './icons.js';

/* ==================================================================== home */

export { dashboardView } from './dashboard.js';

/** "Heute, So 20.09." / "Sa 26.09." — a plan without dates is unusable when counting down. */
function dayLabel(d) {
  if (!d?.date) return `Tag ${d?.day ?? ''}`;
  const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.date.getDay()];
  const dd = String(d.date.getDate()).padStart(2, '0');
  const mm = String(d.date.getMonth() + 1).padStart(2, '0');
  const stamp = `${wd} ${dd}.${mm}.`;
  return d.day === 1 ? `Heute · ${stamp}` : stamp;
}

export function startDailySession() {
  const weak = store.weakNodes({ limit: 4, prefix: 'tag:', minAttempts: 2 }).map((w) => w.id.slice(4));
  const dueReviews = store.listErrors().length;
  if (dueReviews >= 4) {
    navigate('drill', { mode: 'mix', size: 12 });
  } else {
    navigate('drill', { tags: weak.length ? weak : null, size: 12 });
  }
}

export function startDrill(params = {}) {
  navigate('drill', { mode: 'drill', size: 10, ...params });
}

/* =================================================================== drill */

let session = null;

export async function drillView(el, params = {}) {
  const size = params.size || 10;
  const mode = params.mode || 'drill';

  session = {
    mode,
    index: 0,
    correct: 0,
    results: [],
    startedAt: Date.now(),
    cards: [],
    answered: false,
    upgrading: new Set(),
    pending: new Map(),
  };

  el.innerHTML = spinnerRow('Aufgaben werden zusammengestellt…');

  if (mode === 'review') {
    session.cards = engine.buildReviewSession(size);
    if (!session.cards.length) {
      el.innerHTML = `<div class="empty"><div class="big">🎉</div><h3>Nichts zu wiederholen</h3>
        <p class="muted">Dein Fehlerheft ist leer oder alle Karten sind noch nicht fällig.</p>
        <button class="primary" data-back>Zur Übersicht</button></div>`;
      on(el.querySelector('[data-back]'), 'click', () => navigate('home'));
      return;
    }
  } else if (mode === 'mix') {
    const review = engine.buildReviewSession(4);
    const fresh = engine.buildDrillSession(size - review.length);
    session.cards = [...review, ...fresh];
  } else {
    session.cards = engine.buildDrillSession(size);
    if (params.tags && params.tags.length) {
      // Front-load the requested tags so the session opens on the chosen weakness.
      session.cards.sort((a, b) => {
        const av = params.tags.includes(a.tag) ? 0 : 1;
        const bv = params.tags.includes(b.tag) ? 0 : 1;
        return av - bv;
      });
    }
  }

  if (!session.cards.length) {
    el.innerHTML = `<div class="empty"><h3>Keine Aufgaben verfügbar</h3></div>`;
    return;
  }

  const cleanup = () => {
    /* nothing persistent to tear down */
  };

  const onKey = (e) => {
    if (!session) return;
    if (session.answered) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        nextCard();
      }
      return;
    }
    const idx = ['1', '2', '3'].indexOf(e.key);
    if (idx !== -1) {
      const card = session.cards[session.index];
      if (card?.kind === 'mc3' && card.options?.[idx]) answerCard(card.options[idx].key);
    }
  };
  document.addEventListener('keydown', onKey);
  renderCard();
  return () => document.removeEventListener('keydown', onKey);
}

function currentCard() {
  return session?.cards[session.index] || null;
}

function renderCard() {
  const el = document.getElementById('view');
  if (!session) return;
  const card = currentCard();
  if (!card) return renderSummary();

  session.answered = false;

  const tags = (card.tags || [card.tag]).filter(Boolean);
  const chipHtml = tags.map((t) => `<span class="tag-chip" title="${esc(tagInfo(t).hint)}">${esc(tagInfo(t).label)}</span>`).join(' ');
  const reasonHtml = card.reason ? `<span class="pill">${esc(card.reason)}</span>` : '';
  const srcHtml = card.source === 'ai' ? '<span class="pill good">KI-generiert</span>' : card.source === 'seed' ? '<span class="pill">Aufgabensammlung</span>' : '';

  let bodyHtml = '';
  if (card.kind === 'mc3' && card.options?.length) {
    bodyHtml = `<div id="options">
      ${card.options.map((o, i) => `
        <button class="option" data-answer="${esc(o.key)}">
          <span class="key">${esc(o.key)}</span>
          <span>${esc(o.text)}</span>
          <span class="dim small" style="margin-left:auto">${i + 1}</span>
        </button>`).join('')}
    </div>`;
  } else if (card.freeform || card.kind === 'review') {
    bodyHtml = `
      <div class="card tight" style="background:var(--bg-3)">
        <div class="muted small">Diese Aufgabe hattest du schon einmal falsch. Löse sie erneut und beurteile dich dann selbst.</div>
      </div>
      <textarea id="free-answer" placeholder="Deine Antwort…"></textarea>
      <div class="btn-row mt"><button class="primary" data-reveal>Auflösen</button></div>`;
  } else {
    bodyHtml = `
      <input type="text" id="type-answer" placeholder="Antwort eingeben…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="btn-row mt"><button class="primary" data-submit-type>Prüfen</button></div>`;
  }

  el.innerHTML = `
    <div class="card">
      ${progressLine(session.index, session.cards.length, `${session.index + 1} / ${session.cards.length} · ${session.correct} richtig`)}
      <div class="btn-row mb">${chipHtml}${reasonHtml}${srcHtml}</div>
      <div class="dim small">${esc(card.instruction || 'Welche Lösung ist richtig?')}</div>
      <div class="drill-prompt">${esc(card.prompt)}</div>
      ${bodyHtml}
      <div id="feedback"></div>
    </div>
    <div class="btn-row" style="justify-content:space-between">
      <span class="dim small">Tastatur: <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> antworten · <kbd>Enter</kbd> weiter</span>
      <button class="ghost sm" data-quit>Session beenden</button>
    </div>
  `;

  if (card.kind === 'mc3') {
    delegate(el, 'click', '[data-answer]', (e, target) => answerCard(target.dataset.answer));
  }
  const submit = el.querySelector('[data-submit-type]');
  if (submit) {
    const input = el.querySelector('#type-answer');
    on(submit, 'click', () => answerTyped(input.value));
    on(input, 'keydown', (e) => {
      if (e.key === 'Enter') answerTyped(input.value);
    });
    input.focus();
  }
  const reveal = el.querySelector('[data-reveal]');
  if (reveal) on(reveal, 'click', () => revealFreeform());

  on(el.querySelector('[data-quit]'), 'click', () => {
    session = null;
    navigate('home');
  });

  prefetchNext();
}

/** Pull fresh AI content for upcoming cards so the loop stays instant. */
function prefetchNext() {
  if (!session || !ai.isConfigured() || store.getState().settings.aiDrills === false) return;
  if (session.mode === 'vocab') return;
  // Stay two cards ahead: the learner reads and answers the current card while the
  // next two are already being written, so the AI version is ready in time.
  for (const offset of [1, 2]) {
    const idx = session.index + offset;
    if (idx >= session.cards.length) continue;
    if (session.upgrading.has(idx)) continue;
    const card = session.cards[idx];
    // Vocab cards, review cards and already-generated cards are left alone.
    if (!card || card.source === 'ai' || card.freeform || card.vocabKey) continue;
    session.upgrading.add(idx);
    const tag = card.tag || (card.tags || [])[0] || 'konnektoren';
    const task = ai
      .genDrillAI({ tag, difficulty: card.difficulty, avoid: session.cards.map((c) => c.prompt) })
      .then((fresh) => {
        if (session && session.cards[idx]) {
          fresh.reason = session.cards[idx].reason;
          fresh.nodeId = session.cards[idx].nodeId;
          session.cards[idx] = fresh;
        }
      })
      .catch(() => {
        /* offline card stays; that is the point of the fallback */
      });
    session.pending.set(idx, task);
  }
}

function answerCard(key) {
  const card = currentCard();
  if (!card || session.answered) return;
  session.answered = true;

  const correct = key === card.answerKey;
  gradeAndShow(card, correct, card.options.find((o) => o.key === key)?.text || key, card.answer);
}

function answerTyped(value) {
  const card = currentCard();
  if (!card || session.answered) return;
  const given = String(value || '').trim();
  if (!given) {
    toast('Bitte etwas eingeben.', 'warn', 1800);
    return;
  }
  const accepted = [card.answer, ...(card.accept || [])].map((a) => String(a).toLowerCase().trim());
  const norm = given.toLowerCase().trim();
  const correct = accepted.includes(norm) || accepted.some((a) => a.replace(/^(der|die|das)\s/, '') === norm.replace(/^(der|die|das)\s/, ''));
  session.answered = true;
  gradeAndShow(card, correct, given, card.answer);
}

function revealFreeform() {
  const card = currentCard();
  if (!card || session.answered) return;
  const given = (document.getElementById('free-answer')?.value || '').trim();
  session.answered = true;
  const fb = document.getElementById('feedback');
  fb.innerHTML = `
    <div class="feedback ok">
      <div class="verdict">Auflösung</div>
      <div class="why"><b>Richtige Lösung:</b> ${esc(card.answer)}</div>
      ${card.explanation ? `<div class="why mt">${esc(card.explanation)}</div>` : ''}
      <div class="btn-row mt">
        <button class="primary" data-self="right">Wusste ich</button>
        <button data-self="wrong">Wusste ich nicht</button>
      </div>
    </div>`;
  delegate(fb, 'click', '[data-self]', (e, t) => {
    const right = t.dataset.self === 'right';
    if (card.errorId) {
      store.srsGrade(card.errorId, right);
      if (right) store.resolveError(card.errorId);
    }
    session.results.push({ card, correct: right, given, selfGraded: true });
    if (right) session.correct += 1;
    nextCard();
  });
  if (!given) return;
}

function gradeAndShow(card, correct, given, expected) {
  const ms = Date.now() - session.startedAt;
  const isReview = card.source === 'review' || card.freeform;

  if (card.vocabKey) {
    store.srsGrade(card.vocabKey, correct);
    // Vocab also feeds the writing/speaking vocabulary estimate.
    store.recordAttempt({
      partId: card.partId,
      tags: card.tags || [card.tag],
      difficulty: card.difficulty,
      correct,
      source: 'vocab',
      ms,
      itemRef: card.vocabKey || card.id || null,
    });
  } else if (isReview && card.errorId) {
    store.srsGrade(card.errorId, correct);
    if (correct) store.resolveError(card.errorId);
  } else {
    store.recordAttempt({
      partId: card.partId,
      tags: card.tags || [card.tag],
      difficulty: card.difficulty,
      correct,
      source: card.source === 'ai' ? 'ai' : card.source === 'seed' ? 'seed' : 'drill',
      ms,
      itemRef: card.id || null,
      detail: {
        prompt: card.prompt,
        yourAnswer: given,
        correctAnswer: expected,
        explanation: card.explanation,
        source: 'drill',
      },
    });
  }

  session.results.push({ card, correct, given });
  if (correct) session.correct += 1;

  if (card.kind === 'mc3' && card.options) {
    $$('#options .option').forEach((btn) => {
      btn.classList.add('locked');
      if (btn.dataset.answer === card.answerKey) btn.classList.add('correct');
      else if (btn.dataset.answer === given && !correct) btn.classList.add('wrong');
    });
  }

  const fb = document.getElementById('feedback');
  fb.innerHTML = `
    <div class="feedback ${correct ? 'ok' : 'no'}">
      <div class="verdict">${correct ? '✓ Richtig' : '✗ Leider falsch'}</div>
      ${!correct ? `<div class="why"><b>Deine Antwort:</b> ${esc(given)}<br><b>Richtig:</b> ${esc(expected)}</div>` : ''}
      ${card.explanation ? `<div class="why mt">${esc(card.explanation)}</div>` : ''}
      <div class="btn-row mt">
        <button class="primary" data-next>Weiter <span class="dim">(Enter)</span></button>
        ${!correct ? '<button data-explain>Genauer erklären</button>' : ''}
        ${ttsSupported() ? `<button data-listen>Vorlesen</button>` : ''}
      </div>
    </div>`;

  on(fb.querySelector('[data-next]'), 'click', nextCard);
  const explainBtn = fb.querySelector('[data-explain]');
  if (explainBtn) {
    on(explainBtn, 'click', async () => {
      if (!ai.isConfigured()) {
        toast('Für zusätzliche Erklärungen wird ein API-Schlüssel benötigt.', 'warn');
        return;
      }
      explainBtn.disabled = true;
      explainBtn.textContent = 'Erklärt…';
      const res = await ai.coachDrillAnswer({
        prompt: card.prompt,
        correctAnswer: card.answer,
        yourAnswer: given,
        tag: card.tag,
      }).catch(() => null);
      if (res) {
        fb.querySelector('.feedback').insertAdjacentHTML(
          'beforeend',
          `<div class="why mt" style="border-top:1px solid var(--line);padding-top:8px">
            <b>Erklärung:</b> ${esc(res.explanation)}${res.example ? `<br><br><b>Noch ein Beispiel:</b> ${esc(res.example)}` : ''}
          </div>`
        );
      }
      explainBtn.remove();
    });
  }
  const listenBtn = fb.querySelector('[data-listen]');
  if (listenBtn) {
    on(listenBtn, 'click', () => speak(`${card.prompt.replace(/___/g, card.answer)}. ${card.explanation || ''}`, {
      rate: store.getState().settings.ttsRate || 0.95,
    }));
  }
  fb.querySelector('[data-next]')?.focus();
}

async function nextCard() {
  if (!session) return;
  session.index += 1;
  if (session.index >= session.cards.length) return renderSummary();

  // If the next card is still an offline one but an AI version is in flight,
  // give it a moment rather than showing stale content. Bounded, so a slow or
  // failing model can never stall the session.
  const card = session.cards[session.index];
  const pending = session.pending.get(session.index);
  if (pending && card && card.source !== 'ai' && !card.freeform && !card.vocabKey) {
    const host = document.getElementById('view');
    if (host) host.innerHTML = `<div class="card">${spinnerRow('Nächste Aufgabe wird geladen…')}</div>`;
    await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    if (!session) return;
  }
  renderCard();
}

function renderSummary() {
  const el = document.getElementById('view');
  if (!session) return;
  const total = session.results.length;
  const acc = total ? session.correct / total : 0;
  const byTag = new Map();
  for (const r of session.results) {
    for (const t of r.card.tags || [r.card.tag]) {
      if (!t) continue;
      const cur = byTag.get(t) || { right: 0, total: 0 };
      cur.total += 1;
      if (r.correct) cur.right += 1;
      byTag.set(t, cur);
    }
  }
  const rows = [...byTag.entries()].sort((a, b) => a[1].right / a[1].total - b[1].right / b[1].total);
  const weakest = store.weakNodes({ limit: 4, prefix: 'tag:' });
  const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));

  el.innerHTML = `
    <div class="card">
      <h2>Session beendet</h2>
      <div class="grid three mt">
        ${statCard('Ergebnis', `${session.correct} / ${total}`, `<span class="pill ${acc >= 0.8 ? 'good' : acc >= 0.6 ? 'warn' : 'bad'}">${pct(acc * 100)}</span>`)}
        ${statCard('Dauer', `${minutes} Min.`, '')}
        ${statCard('Themen', String(byTag.size), '<span class="dim">bearbeitet</span>')}
      </div>
    </div>

    <div class="card">
      <h3>Was hat diese Session gezeigt?</h3>
      <table class="plain">
        <thead><tr><th>Thema</th><th class="num">Richtig</th><th class="num">Quote</th></tr></thead>
        <tbody>
          ${rows.map(([tag, v]) => `<tr>
            <td>${esc(tagInfo(tag).label)}</td>
            <td class="num">${v.right} / ${v.total}</td>
            <td class="num" style="color:${v.right / v.total >= 0.7 ? 'var(--good)' : v.right / v.total >= 0.4 ? 'var(--warn)' : 'var(--bad)'}">${pct((v.right / v.total) * 100)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Der Trainer passt sich an</h3>
      <p class="muted small">Diese Themen stehen jetzt oben in der Warteschlange:</p>
      <div class="btn-row">
        ${weakest.map((w) => `<span class="tag-chip weak">${esc(tagInfo(w.id.slice(4)).label)} · ${Math.round(w.mastery)}</span>`).join('') || '<span class="dim small">noch zu wenig Daten</span>'}
      </div>
      <div class="btn-row mt">
        <button class="primary" data-again>Noch eine Session</button>
        <button data-goto="home">Zur Übersicht</button>
        <button data-goto="notebook">Fehlerheft (${store.listErrors().length})</button>
      </div>
    </div>
  `;

  session = null;
  on(el.querySelector('[data-again]'), 'click', () => startDailySession());
  on(el.querySelector('[data-goto="home"]'), 'click', () => navigate('home'));
  on(el.querySelector('[data-goto="notebook"]'), 'click', () => navigate('notebook'));
}

/* ============================================================== notebook */

export async function notebookView(el) {
  const errors = store.listErrors();
  const resolved = store.getState().errors.filter((e) => e.resolved).length;

  setViewActions(`
    ${errors.length ? '<button class="primary" data-review>Fehler wiederholen</button>' : ''}
    ${errors.length ? '<button class="danger" data-clear>Heft leeren</button>' : ''}
  `);

  if (!errors.length) {
    el.innerHTML = `<div class="empty"><div class="big">📓</div><h3>Das Fehlerheft ist leer</h3>
      <p class="muted">Jede falsch beantwortete Aufgabe landet automatisch hier – mit Erklärung und Wiederholungsplan.</p>
      <button class="primary" data-start>Jetzt üben</button></div>`;
    on(el.querySelector('[data-start]'), 'click', () => startDrill({ size: 10 }));
    return;
  }

  el.innerHTML = `
    <div class="card">
      <h3>${errors.length} offene Fehler ${resolved ? `<span class="dim small">· ${resolved} bereits geklärt</span>` : ''}</h3>
      <p class="muted small">Fehler werden nach 1, 3, 7, 16 und 35 Tagen automatisch erneut abgefragt. Erst dann verschwinden sie hier.</p>
    </div>
    ${errors.map((e) => {
      const card = store.srsCard(e.id);
      const due = card ? new Date(card.due) : null;
      const isDue = !due || due.getTime() <= Date.now();
      return `<div class="card tight">
        <div class="err-item">
          <div class="btn-row" style="justify-content:space-between">
            <div class="btn-row">
              ${(e.tags || []).map((t) => `<span class="tag-chip">${esc(tagInfo(t).label)}</span>`).join('')}
              ${e.partId ? `<span class="pill">${esc(PARTS[e.partId]?.label || e.partId)}</span>` : ''}
            </div>
            <span class="pill ${isDue ? 'warn' : ''}">${isDue ? 'jetzt fällig' : `wiederholen am ${due.toLocaleDateString('de-DE')}`}</span>
          </div>
          <div class="q mt">${esc(e.prompt)}</div>
          <div class="a">
            <span class="bad-text">${esc(e.yourAnswer || '–')}</span>
            → <span class="good-text">${esc(e.correctAnswer)}</span>
          </div>
          ${e.explanation ? `<div class="dim small mt">${esc(e.explanation)}</div>` : ''}
          <div class="btn-row mt">
            <button class="sm" data-resolve="${esc(e.id)}">Als geklärt markieren</button>
          </div>
        </div>
      </div>`;
    }).join('')}
  `;

  const reviewBtn = document.querySelector('[data-review]');
  on(reviewBtn, 'click', () => navigate('drill', { mode: 'review', size: 12 }));
  const clearBtn = document.querySelector('[data-clear]');
  on(clearBtn, 'click', async () => {
    if (await confirmDialog('Wirklich alle Fehler aus dem Heft löschen?', 'Leeren')) {
      store.clearErrors();
      toast('Fehlerheft geleert.', 'good');
      navigate('notebook');
    }
  });
  delegate(el, 'click', '[data-resolve]', (e, t) => {
    store.resolveError(t.dataset.resolve);
    toast('Als geklärt markiert.', 'good', 1800);
    navigate('notebook');
  });
}

/* ============================================================ vocabulary */

let vocabState = null;

export async function vocabView(el) {
  const [deck, coreTiers] = await Promise.all([ai.loadVocab(), ai.loadCore()]);
  const coreItems = coreTiers.flatMap((t) => t.items);

  if (!deck.length && !coreItems.length) {
    el.innerHTML = `<div class="empty"><h3>Kein Wortschatz gefunden</h3><p class="muted">data/vocab.json und data/core-*.json fehlen oder sind leer.</p></div>`;
    return;
  }

  const coreStats = (items) => ({
    seen: items.filter((i) => store.srsCard(i.key)).length,
    due: store.srsDue(items.map((i) => i.key), 9999).length,
    total: items.length,
  });
  const core = coreStats(coreItems);
  const gen = {
    seen: deck.filter((w) => store.srsCard(`vocab:${w.de}`)).length,
    due: store.srsDue(deck.map((w) => `vocab:${w.de}`), 9999).length,
    total: deck.length,
  };

  el.innerHTML = `
    <div class="card" style="border-color:var(--accent)">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Prüfungskern</h3>
          <div class="dim small">${core.total} Einträge · genau das, was telc B1 immer wieder prüft</div>
        </div>
        <span class="pill good">höchste Trefferquote</span>
      </div>
      <p class="muted small mt">
        Die Wortbank in Sprachbausteine Teil 2 des offiziellen Übungstests besteht aus
        <span class="mono">BESONDERS · DA · DAFÜR · DAMALS · DAMIT · DANKBAR · DESHALB · FÜR · GERNE · KÖNNTEN · MIT · MÜSSTEN · SCHLIESSLICH · WANN · WENN</span> –
        kein einziges seltenes Substantiv. Die Punkte liegen bei <b>Funktionswörtern</b>: Konnektoren,
        Präpositionen, Konjunktiv II, festen Wendungen. Deshalb steht dieser Block zuerst.
      </p>
      <div class="btn-row mb">
        <button class="primary" data-core-all="${Math.min(20, core.total)}">20 Kernthemen üben</button>
        ${core.due ? `<button data-core-all="${Math.min(core.due, 40)}">${core.due} fällige wiederholen</button>` : ''}
        <span class="pill">${core.seen} / ${core.total} begonnen</span>
      </div>
      <table class="plain">
        <thead><tr><th>Block</th><th class="num">Einträge</th><th class="num">begonnen</th><th class="num"></th></tr></thead>
        <tbody>
          ${coreTiers.map((t) => {
            const s = coreStats(t.items);
            return `<tr>
              <td><b>${esc(t.title)}</b><div class="dim small">${esc(t.why)}</div></td>
              <td class="num">${s.total}</td>
              <td class="num">${s.seen}</td>
              <td class="num"><button class="sm" data-core-tier="${esc(t.id)}">Üben</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Allgemeiner Wortschatz</h3>
      <p class="muted small">${gen.total} B1-Wörter nach Themen. Breite für Lesen und Hören – der Kern oben bringt schneller Punkte.</p>
      <div class="grid three mb">
        ${statCard('Wörter', String(gen.total), '')}
        ${statCard('Begonnen', String(gen.seen), `<span class="dim">${pct((gen.seen / Math.max(1, gen.total)) * 100)} des Decks</span>`)}
        ${statCard('Fällig', String(gen.due), '<span class="dim">Wiederholungen</span>')}
      </div>
      <div class="btn-row">
        <button data-vocab-start="15">15 Karten</button>
        <button data-vocab-start="30">30 Karten</button>
        ${gen.due ? `<button data-vocab-start="${Math.min(gen.due, 40)}">${gen.due} fällige wiederholen</button>` : ''}
      </div>
      <h4 class="mt">Schwierige Wörter</h4>
      ${difficultChips(deck, (w) => `vocab:${w.de}`, (w) => w.de)}
    </div>
  `;

  delegate(el, 'click', '[data-vocab-start]', (e, t) => {
    navigate('vocabdrill', { deck: 'general', size: Number(t.dataset.vocabStart) || 15 });
  });
  delegate(el, 'click', '[data-core-all]', (e, t) => {
    navigate('vocabdrill', { deck: 'core', size: Number(t.dataset.coreAll) || 20 });
  });
  delegate(el, 'click', '[data-core-tier]', (e, t) => {
    navigate('vocabdrill', { deck: 'core', tier: t.dataset.coreTier, size: 15 });
  });
}

function difficultChips(items, keyOf, labelOf) {
  const rows = items
    .map((it) => ({ it, card: store.srsCard(keyOf(it)) }))
    .filter((r) => r.card && r.card.lapses > 0)
    .sort((a, b) => b.card.lapses - a.card.lapses)
    .slice(0, 12);
  if (!rows.length) return '<p class="muted small">Noch keine Problemwörter – gut so.</p>';
  return `<div class="btn-row">${rows.map((r) => `<span class="tag-chip weak">${esc(labelOf(r.it))} <span class="dim">×${r.card.lapses}</span></span>`).join('')}</div>`;
}

/** Same card loop as the grammar drill, but driven by a vocabulary or core deck. */
export async function vocabDrillView(el, params = {}) {
  const size = params.size || 15;
  let cards;

  if (params.deck === 'core') {
    const tiers = await ai.loadCore();
    const tier = params.tier ? tiers.find((t) => t.id === params.tier) : null;
    const items = tier ? tier.items : tiers.flatMap((t) => t.items);
    if (!items.length) {
      el.innerHTML = `<div class="empty"><h3>Kein Prüfungskern gefunden</h3>
        <p class="muted">data/core-grammar.json und data/core-phrases.json fehlen oder sind leer.</p>
        <button data-back>Zurück</button></div>`;
      on(el.querySelector('[data-back]'), 'click', () => navigate('vocab'));
      return;
    }
    cards = engine.buildVocabSession(items, size, { keyOf: (w) => w.key, modeOf: engine.coreCardMode });
  } else if (params.deck === 'nouns') {
    // The noun lexicon doubles as a gender deck: article, plural and meaning.
    const nouns = await ai.loadNounLexicon();
    if (!nouns.length) {
      el.innerHTML = `<div class="empty"><h3>Kein Nomen-Lexikon gefunden</h3>
        <p class="muted">data/noun-lexicon.json fehlt oder ist leer.</p>
        <button data-back>Zurück</button></div>`;
      on(el.querySelector('[data-back]'), 'click', () => navigate('reference'));
      return;
    }
    cards = engine.buildVocabSession(nouns, size, {
      keyOf: (n) => `noun:${n.de}`,
      // Gender is the whole point here, so lean on the article card.
      modeOf: () => (Math.random() < 0.6 ? 'article' : 'de-en'),
    });
  } else {
    const deck = await ai.loadVocab();
    cards = engine.buildVocabSession(deck, size);
  }

  if (!cards.length) {
    el.innerHTML = `<div class="empty"><h3>Keine Karten verfügbar</h3>
      <p class="muted">Das Wortschatzdeck ist leer.</p>
      <button data-back>Zurück</button></div>`;
    on(el.querySelector('[data-back]'), 'click', () => navigate('vocab'));
    return;
  }
  session = {
    mode: 'vocab',
    index: 0,
    correct: 0,
    results: [],
    startedAt: Date.now(),
    cards,
    answered: false,
    upgrading: new Set(),
    pending: new Map(),
  };
  const onKey = (e) => {
    if (!session) return;
    if (session.answered) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        nextCard();
      }
      return;
    }
    const idx = ['1', '2', '3'].indexOf(e.key);
    if (idx !== -1) {
      const card = currentCard();
      if (card?.kind === 'mc3' && card.options?.[idx]) answerCard(card.options[idx].key);
    }
  };
  document.addEventListener('keydown', onKey);
  renderCard();
  return () => document.removeEventListener('keydown', onKey);
}

/* ================================================================ plan */

export async function planView(el) {
  const state = store.getState();
  const countdown = engine.examCountdown(state.settings.examDate);
  const days = engine.planHorizon({ examDate: state.settings.examDate });
  const plan = engine.studyPlan({ days, examDate: state.settings.examDate });
  const todayKey = store.dayKey();

  // Work recorded per plan day, so finishing an exercise ticks the task off with no
  // manual step. `manual` covers the tasks that leave no attempt behind.
  const progress = plan.map((d) => {
    const key = store.dayKey(d.date.getTime());
    const attempts = store.attemptsOn(key);
    const manual = store.planDoneOn(key);
    return { day: d, key, attempts, manual, ...engine.planDayProgress(d, attempts, manual) };
  });

  const todayEntry = progress.find((p) => p.key === todayKey);
  const remaining = todayEntry ? todayEntry.total - todayEntry.done : 0;

  // The plan mixes written, oral and review tasks, and each kind has to open a
  // different view. A speaking or writing task still carries a partId (SP1, SA1 …),
  // so `kind` has to be checked first — matching on partId alone sent them to the
  // written paper view, which has no generator for the oral parts.
  const taskButton = (t) => {
    switch (t.kind) {
      case 'mock':
        return '<button class="sm" data-mock>Öffnen</button>';
      case 'drill':
        return '<button class="sm" data-drill>Öffnen</button>';
      case 'review':
        return '<button class="sm" data-review>Öffnen</button>';
      case 'writing':
        return '<button class="sm" data-write>Öffnen</button>';
      case 'speaking':
        return `<button class="sm" data-speak="${esc(t.partId || 'SP1')}">Öffnen</button>`;
      default:
        return t.partId && PARTS[t.partId]
          ? `<button class="sm" data-part="${esc(t.partId)}">Öffnen</button>`
          : '';
    }
  };

  el.innerHTML = `
    <div class="card">
      <h3>Lernplan</h3>
      <p class="muted">
        ${countdown && !countdown.past
          ? `Noch <b>${countdown.days} ${countdown.days === 1 ? 'Tag' : 'Tage'}</b> bis zur Prüfung am ${esc(fmtDate(countdown.date))} – also ${days} Lerntage.
             Der Plan priorisiert die Teile mit den meisten Punkten und deine größten Lücken,
             setzt die Generalprobe auf den vorletzten Tag und lässt den letzten Tag zum Festigen frei.`
          : 'Kein Prüfungsdatum gesetzt – der Plan zeigt die nächsten 7 Tage. Trage dein Datum in den Einstellungen ein.'}
      </p>
      ${todayEntry ? `
        <div class="card tight" style="background:var(--bg-3)">
          <div class="btn-row" style="justify-content:space-between">
            <b>Heute</b>
            <span class="pill ${todayEntry.done === todayEntry.total ? 'good' : ''}">
              ${todayEntry.done} von ${todayEntry.total} erledigt
            </span>
          </div>
          <div class="bar ${todayEntry.done === todayEntry.total ? 'good' : 'warn'} mt">
            <i style="width:${todayEntry.total ? (todayEntry.done / todayEntry.total) * 100 : 0}%"></i>
          </div>
          <div class="dim small mt">
            ${remaining === 0
              ? 'Alles geschafft. Was du heute schon gemacht hast, zählt weiter.'
              : `Noch ${remaining} ${remaining === 1 ? 'Aufgabe' : 'Aufgaben'} offen. Erledigtes wird automatisch abgehakt.`}
          </div>
        </div>` : ''}
      <div class="btn-row">
        <button data-goto="settings">Prüfungsdatum ändern</button>
        <button class="primary" data-start>Heutige Session</button>
      </div>
    </div>
    ${progress.map(({ day: d, key, done, total, tasks, attempts, manual }) => `
      <div class="card"${key === todayKey ? ' style="border-color:var(--accent)"' : d.isMock ? ' style="border-color:var(--accent)"' : d.isTaper ? ' style="border-color:var(--good-dim)"' : ''}>
        <div class="btn-row" style="justify-content:space-between">
          <h3 style="margin:0">${esc(dayLabel(d))} · ${esc(d.label)}${key === todayKey ? ' <span class="pill good">heute</span>' : ''}</h3>
          <span class="pill ${done === total ? 'good' : d.isMock ? 'warn' : d.isTaper ? 'good' : ''}">
            ${done} / ${total} · ${d.totalMinutes} Min.
          </span>
        </div>
        ${d.focusTags?.length ? `<div class="btn-row mt">${d.focusTags.map((t) => `<span class="tag-chip" data-tag="${esc(t)}">${esc(tagInfo(t).label)}</span>`).join('')}</div>` : ''}
        <table class="plain mt">
          <tbody>
            ${tasks.map(({ task: t, done: isDone }) => {
              // A tick earned by real work cannot be un-ticked; one placed by hand can.
              const earned = engine.isTaskDone(t, attempts, {});
              return `<tr>
                <td style="width:30px">
                  <button class="sm" data-task-toggle="${esc(engine.taskKey(t))}" data-task-day="${esc(key)}"
                          ${earned ? 'disabled' : ''}
                          title="${earned ? 'Automatisch erkannt – du hast das heute gemacht' : isDone ? 'Häkchen entfernen' : 'Als erledigt markieren'}"
                          style="padding:2px 7px">${isDone ? '✓' : '○'}</button>
                </td>
                <td${isDone ? ' class="dim"' : ''} style="${isDone ? 'text-decoration:line-through' : ''}">${esc(t.label)}</td>
                <td class="num dim">${t.minutes} Min.</td>
                <td class="num">${taskButton(t)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`).join('')}
  `;

  on(el.querySelector('[data-start]'), 'click', () => startDailySession());
  const s = el.querySelector('[data-goto="settings"]');
  on(s, 'click', () => navigate('settings'));
  delegate(el, 'click', '[data-tag]', (e, t) => startDrill({ tags: [t.dataset.tag], size: 6 }));
  // `from: 'plan'` makes every opened view offer a way straight back here.
  delegate(el, 'click', '[data-part]', (e, t) => navigate('paper', { partId: t.dataset.part, from: 'plan' }));
  delegate(el, 'click', '[data-mock]', () => navigate('mock', { from: 'plan' }));
  delegate(el, 'click', '[data-drill]', () => navigate('drill', { size: 15, from: 'plan' }));
  delegate(el, 'click', '[data-review]', () => navigate('drill', { mode: 'review', size: 12, from: 'plan' }));
  delegate(el, 'click', '[data-write]', () => navigate('writing', { from: 'plan' }));
  delegate(el, 'click', '[data-speak]', (e, t) => navigate('speaking', { partId: t.dataset.speak || 'SP1', from: 'plan', nonce: Date.now() }));
  delegate(el, 'click', '[data-task-toggle]', (e, t) => {
    if (t.disabled) return;
    const day = t.dataset.taskDay;
    const key = t.dataset.taskToggle;
    store.setTaskDone(day, key, !store.planDoneOn(day)[key]);
    navigate('plan');
  });
}

/* ============================================================ settings */

/** Where progress actually lives, and whether the last save worked. */
function renderSyncStatus() {
  const s = store.syncStatus();
  const when = s.lastSavedAt ? new Date(s.lastSavedAt) : null;
  const agoSec = when ? Math.max(0, Math.round((Date.now() - when.getTime()) / 1000)) : null;
  const agoText =
    agoSec === null ? 'noch nicht gespeichert' : agoSec < 5 ? 'gerade eben' : agoSec < 90 ? `vor ${agoSec} s` : `vor ${Math.round(agoSec / 60)} Min.`;

  if (s.state === 'error' || s.state === 'offline') {
    return `<div class="feedback no">
      <div class="verdict">Server nicht erreichbar – derzeit nur im Browser gespeichert</div>
      <div class="why">
        Läuft <span class="mono">node server.js</span> noch? Sobald die Verbindung wieder steht, wird
        automatisch nachgespeichert.
        ${s.lastError ? `<br><span class="dim">${esc(s.lastError)}</span>` : ''}
      </div>
    </div>`;
  }

  return `
    <p class="muted small">
      Jede Antwort wird automatisch in <span class="mono">progress.json</span> direkt neben der App
      gespeichert – nicht mehr nur im Browser. Dein Fortschritt übersteht damit gelöschte Browserdaten,
      einen anderen Browser und einen anderen Port.
    </p>
    <div class="btn-row">
      <span class="pill ${s.state === 'saved' ? 'good' : ''}">${
        s.state === 'pending' ? 'Speichert…' : `Gespeichert ${agoText}`
      }</span>
      ${s.lastLoadedSource === 'backup' ? '<span class="pill warn">aus der Sicherungskopie geladen</span>' : ''}
    </div>`;
}

export async function settingsView(el) {
  const st = store.getState().settings;
  // Chrome populates getVoices() asynchronously and returns [] on the first call,
  // so wait for the list before deciding whether a German voice exists. Reading it
  // synchronously made this page report a missing voice that was actually there.
  const loadEl = document.getElementById('view');
  if (loadEl && !germanVoices().length) loadEl.innerHTML = spinnerRow('Stimmen werden geladen…');
  await waitForVoices();
  const voices = germanVoices();

  el.innerHTML = `
    <div class="card">
      <h3>Prüfung & Lernen</h3>
      <label class="field">
        <span>Prüfungsdatum</span>
        <input type="date" id="exam-date" value="${esc(st.examDate || '')}">
        <div class="hint">Steuert Countdown und Lernplan.</div>
      </label>
      <label class="field">
        <span>Tagesziel (Aufgaben)</span>
        <input type="number" id="daily-goal" min="5" max="200" value="${Number(st.dailyGoal) || 20}">
      </label>
      <label class="field">
        <span>Sprechgeschwindigkeit beim Vorlesen: <b id="rate-val">${Number(st.ttsRate || 0.95).toFixed(2)}</b>×</span>
        <input type="range" id="tts-rate" min="0.6" max="1.3" step="0.05" value="${Number(st.ttsRate || 0.95)}">
        <div class="hint">telc-Hörtexte werden zügig gesprochen. Übe zuerst langsamer, dann im Originaltempo.</div>
      </label>
      ${voices.length ? `
      <label class="field">
        <span>Deutsche Stimme</span>
        <select id="voice-name">
          <option value="">Automatisch (${esc(voices[0].name)})</option>
          ${voices.map((v) => `<option value="${esc(v.name)}" ${st.voiceName === v.name ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})${v.localService ? '' : ' – Netz-Stimme'}</option>`).join('')}
        </select>
        <div class="hint">${voices.some((v) => !v.localService) ? 'Diese Stimme kommt von Google und braucht eine Internetverbindung.' : 'Lokale Stimme – funktioniert auch offline.'}</div>
      </label>` : `
      <div class="feedback no" style="margin-bottom:12px">
        <div class="verdict">Keine deutsche Stimme gefunden</div>
        <div class="why">
          Ohne deutsche Stimme würde der Hörtext mit englischer Aussprache vorgelesen – das trainiert
          falsche Aussprache. Der Rest der App funktioniert normal.<br><br>
          <b>So bekommst du eine deutsche Stimme:</b><br>
          1. Prüfe die Internetverbindung: Chrome liefert „Google Deutsch“ als Netz-Stimme mit.<br>
          2. Sonst: Windows-Einstellungen → Zeit und Sprache → Sprache und Region → Deutsch hinzufügen
             und das Häkchen bei „Sprache“ setzen. Danach den Browser komplett neu starten.<br>
          3. Prüfen mit <span class="mono">node tools/tts-check.js</span>.
        </div>
      </div>`}
      <label class="field">
        <span>Sprache der Erklärungen</span>
        <select id="explain-language">
          <option value="de" ${(st.language || 'de') === 'de' ? 'selected' : ''}>Deutsch</option>
          <option value="en" ${st.language === 'en' ? 'selected' : ''}>English</option>
        </select>
        <div class="hint">
          Gilt nur für Erklärungen und Rückmeldungen zu deinen Antworten. <b>Menü und Prüfungsinhalte bleiben Deutsch.</b>
        </div>
      </label>
      <label class="field">
        <span>KI-Aufgaben im Drill</span>
        <select id="ai-drills">
          <option value="true" ${st.aiDrills !== false ? 'selected' : ''}>An – frisch generierte Aufgaben (empfohlen)</option>
          <option value="false" ${st.aiDrills === false ? 'selected' : ''}>Aus – nur die eingebauten Übungen</option>
        </select>
      </label>
      <div class="btn-row"><button class="primary" data-save-prefs>Einstellungen speichern</button></div>
    </div>

    <div class="card">
      <h3>Fortschritt wird automatisch gespeichert</h3>
      ${renderSyncStatus()}
      <div class="btn-row mt">
        <button class="primary" data-save-now>Jetzt sichern</button>
        <button data-export>Als Datei exportieren</button>
        <button data-import>Datei importieren</button>
        <button class="danger" data-reset>Alles zurücksetzen</button>
      </div>
      <input type="file" id="import-file" accept="application/json" class="hidden">
      <div class="mt small dim">
        ${store.getState().counters.attempts} Aufgaben erfasst ·
        ${store.getState().counters.aiCalls} KI-Aufrufe erfolgreich ·
        ${store.getState().counters.aiFailures} fehlgeschlagen
        ${store.getState().counters.lastAiError ? `<br>Letzter Fehler: ${esc(store.getState().counters.lastAiError)}` : ''}
      </div>
    </div>

    <div class="card">
      <h3>Über diese App</h3>
      <p class="muted small">
        Trainiert die fünf Teile der telc-Deutsch-B1-Prüfung. Die Struktur folgt dem offiziellen Testformat:
        Leseverstehen 3 Teile/20 Aufgaben/75 Punkte, Sprachbausteine 2 Teile/20 Aufgaben/30 Punkte,
        Hörverstehen 3 Teile/20 Aufgaben/75 Punkte (alle Richtig/Falsch), Schreiben 45 Punkte, Sprechen 75 Punkte.
        Schriftlich: 225 Punkte, bestanden ab 135. Mündlich: 75 Punkte, bestanden ab 45.
      </p>
      <p class="muted small">
        Hinweis: Die Punktaufteilung der drei Sprechen-Teile ist eine Schätzung zu je einem Drittel; Gesamtpunktzahl
        und Bestehensgrenze sind die offiziellen Werte. Schätzungen des Trainers sind Prognosen, kein Prüfungsergebnis.
      </p>
    </div>
  `;

  /* --- prefs */
  const rate = el.querySelector('#tts-rate');
  on(rate, 'input', () => {
    el.querySelector('#rate-val').textContent = Number(rate.value).toFixed(2);
  });

  on(el.querySelector('[data-save-prefs]'), 'click', async () => {
    const settings = store.getState().settings;
    settings.examDate = el.querySelector('#exam-date').value;
    settings.dailyGoal = Number(el.querySelector('#daily-goal').value) || 20;
    settings.ttsRate = Number(rate.value);
    settings.aiDrills = el.querySelector('#ai-drills').value === 'true';
    const langSel = el.querySelector('#explain-language');
    if (langSel) settings.language = langSel.value;
    const voiceSel = el.querySelector('#voice-name');
    if (voiceSel) settings.voiceName = voiceSel.value;
    store.saveNow();
    const { session } = await import('./account.js');
    // The server-config exam date is shared by everyone on this server: only the single-user
    // path writes it. An account keeps its date in its own settings record below.
    if (session().phase === 'single-user') {
      try {
        await ai.saveExamDate(settings.examDate);
      } catch {
        /* the date still works locally */
      }
    }
    /*
     * Account-scoped settings, through the session boundary (SESSION-BOUNDARY-01) - never a
     * client of this page's own. Attempted only when signed in, and never silently: without an
     * account the local behaviour is exactly as before, and a refused save is reported rather
     * than swallowed, because a settings page that claims to save and does not is the defect
     * this exists to remove.
     */
    try {
      const outcome = await session().saveSettings({
        examDate: settings.examDate,
        dailyGoal: settings.dailyGoal,
        language: settings.language || 'de',
      });
      // A 409 means another device moved the record; say so instead of pretending it saved.
      if (outcome.reason === 'conflict') {
        toast('Die Einstellungen wurden auf einem anderen Gerät geändert. Bitte neu laden.', 'warn', 6000);
        return;
      }
      if (outcome.reason === 'expired') {
        toast('Die Sitzung ist abgelaufen. Bitte melde dich erneut an.', 'warn', 6000);
        return;
      }
    } catch {
      toast('Einstellungen lokal gespeichert; die Kontospeicherung ist fehlgeschlagen.', 'warn', 6000);
    }
    toast('Einstellungen gespeichert.', 'good');
    navigate('settings');
  });

  /* --- data */
  on(el.querySelector('[data-save-now]'), 'click', async () => {
    const btn = el.querySelector('[data-save-now]');
    btn.disabled = true;
    btn.textContent = 'Sichere…';
    const ok = await store.flushToServer();
    toast(ok ? 'Fortschritt gespeichert.' : `Speichern fehlgeschlagen: ${store.syncStatus().lastError || 'unbekannt'}`, ok ? 'good' : 'bad', 5000);
    navigate('settings');
  });

  on(el.querySelector('[data-export]'), 'click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `b1-prep-fortschritt-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Export erstellt.', 'good');
  });

  const fileInput = el.querySelector('#import-file');
  on(el.querySelector('[data-import]'), 'click', () => fileInput.click());
  on(fileInput, 'change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      store.importJSON(await file.text());
      toast('Fortschritt importiert.', 'good');
      navigate('home');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  on(el.querySelector('[data-reset]'), 'click', async () => {
    if (await confirmDialog('Wirklich den gesamten Fortschritt löschen? Das kann nicht rückgängig gemacht werden.', 'Alles löschen')) {
      store.resetAll();
      toast('Fortschritt zurückgesetzt.', 'good');
      navigate('home');
    }
  });
}
