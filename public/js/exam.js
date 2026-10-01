/**
 * Exam views: full exam parts, listening with real play rules, writing with
 * correction, speaking with dictation, and a timed mock exam.
 *
 * Every part is generated through ai.genSet, which silently falls back to the
 * bundled seed bank, so all of this works offline too.
 */

import {
  esc, $, $$, on, delegate, toast, busy, unbusy, busyUpdate, navigate,
  pct, round1, statCard, fmtClock, spinnerRow, spinnerWithTimer, setViewActions,
} from './shell.js';
import * as store from './store.js';
import * as engine from './engine.js';
import * as ai from './ai.js';
import { assessMockWriting, createCompletionGate, summarizeMockOutcome, WRITING_MAX, WRITING_REASONS } from './mock-outcome.js';
import { PARTS, GROUPS, SUBTEST_ORDER, groupOf, tagInfo } from './blueprint.js';
import { speak, speakScript, stopSpeaking, ttsSupported, germanVoices, waitForVoices, startDictation, sttSupported, speakingRate, beep } from './speech.js';
import { session } from './account.js';
import { createWritingSurface, writingTaskId } from './writing-surface.js';

const ALL_PARTS = ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3'];

/* ============================================================ paper index */

/**
 * Which view actually runs a given part.
 *
 * The Prüfungsteile index and the Lernplan both link parts by id, but the oral
 * parts and the writing task are not generated "sets": they have their own views.
 * Routing them through the paper runner ended in "SP1 hat keinen
 * Aufgabengenerator", so every part now resolves to its own view first.
 */
export function viewForPart(partId) {
  if (partId === 'SA1') return 'writing';
  const kind = PARTS[partId]?.kind || '';
  return kind.startsWith('speaking') ? 'speaking' : 'paper';
}

export async function paperView(el, params = {}) {
  if (params.partId) {
    // Safety net: a stale link straight to /paper with an oral part still lands
    // in the right view instead of an error.
    const dest = viewForPart(params.partId);
    if (dest === 'speaking') return speakingView(el, { partId: params.partId, nonce: params.nonce });
    if (dest === 'writing') return writingView(el, params);
    return runSinglePart(el, params);
  }

  const group = params.group || null;
  const list = SUBTEST_ORDER.filter((id) => !group || PARTS[id].group === group);

  el.innerHTML = `
    <div class="card">
      <h3>Prüfungsteile im Originalformat</h3>
      <p class="muted">Jeder Teil wird komplett generiert – gleiche Aufgabenformen, gleiche Nummerierung, gleiche Punktzahl wie in der Prüfung. Auf Wunsch bei jedem Klick neu.</p>
    </div>
    ${GROUPS.filter((g) => !group || g.id === group).map((g) => `
      <div class="card">
        <div class="btn-row" style="justify-content:space-between">
          <div>
            <h3 style="margin:0">${esc(g.name)}</h3>
            <div class="dim small">${g.pts} Punkte · ca. ${g.minutes} Min. · ${esc(g.note)}</div>
          </div>
        </div>
        <div class="grid three mt">
          ${list.filter((id) => PARTS[id].group === g.id).map((id) => {
            const p = PARTS[id];
            const theta = store.masteryOf(`skill:${id}`);
            const conf = store.confidenceOf(`skill:${id}`);
            const n = store.nodeOf(`skill:${id}`)?.n || 0;
            return `<button class="card tight" data-part="${esc(id)}" style="text-align:left;display:block">
              <div style="font-weight:650">${esc(p.label)}</div>
              <div class="small muted" style="margin:4px 0 8px">${p.items} ${p.items === 1 ? 'Aufgabe' : 'Aufgaben'} · ${p.pts} P.${p.plays ? ` · ${p.plays === 1 ? 'einmal hören' : 'zweimal hören'}` : ''}</div>
              <div class="bar ${theta >= 70 ? 'good' : theta >= 50 ? 'warn' : 'bad'}"><i style="width:${Math.round(theta)}%"></i></div>
              <div class="dim small" style="margin-top:4px">${n ? `${n} Aufgaben · ${esc(store.nodeOf(`skill:${id}`).n)} Versuche` : 'noch nicht geübt'}${conf < 0.4 ? ' · Schätzung unsicher' : ''}</div>
            </button>`;
          }).join('')}
        </div>
      </div>`).join('')}
  `;

  delegate(el, 'click', '[data-part]', (e, t) => {
    const id = t.dataset.part;
    const dest = viewForPart(id);
    if (dest === 'speaking') navigate('speaking', { partId: id, nonce: Date.now() });
    else if (dest === 'writing') navigate('writing', { nonce: Date.now() });
    else navigate('paper', { partId: id });
  });
}

/* ====================================================== single part runner */

async function runSinglePart(el, params) {
  const partId = params.partId;
  const part = PARTS[partId];
  if (!part) return;

  setViewActions(`<button data-back>← Alle Teile</button><button data-regen>Neu generieren</button>`);
  on(document.querySelector('[data-back]'), 'click', () => navigate('paper', { group: params.group || null }));
  on(document.querySelector('[data-regen]'), 'click', () => navigate('paper', { partId, group: params.group, nonce: Date.now() }));

  busy('Aufgabe wird erstellt…', `${part.label} · ${ai.isConfigured() ? 'DeepSeek generiert neuen Inhalt' : 'aus der eingebauten Aufgabensammlung'}`);
  let set;
  try {
    set = await ai.genSet(partId, { difficulty: engine.PART_DIFFICULTY[partId] });
  } catch (err) {
    unbusy();
    el.innerHTML = `<div class="card"><h3>Aufgabe konnte nicht erstellt werden</h3><p class="muted">${esc(err.message)}</p>
      <button class="primary" data-retry>Erneut versuchen</button></div>`;
    on(el.querySelector('[data-retry]'), 'click', () => navigate('paper', { partId, nonce: Date.now() }));
    return;
  }
  unbusy();

  renderPartInto(el, partId, set, { onFinished: (result) => showPartResult(el, partId, set, result, params) });
}

/* --------------------------------------------------------- part rendering */

function renderPartInto(container, partId, set, opts = {}) {
  const part = PARTS[partId];
  const state = { partId, set, answers: {}, submitted: false, plays: 0 };

  container.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">${esc(groupOf(partId).name)} · ${esc(part.label)}</h3>
          ${set.title ? `<div style="font-weight:600;font-size:.9rem;margin-top:2px">${esc(set.title)}</div>` : ''}
          <div class="dim small">${esc(part.brief)}</div>
        </div>
        <div class="btn-row">
          <span class="pill">${part.pts} Punkte</span>
          ${set.source === 'ai' ? '<span class="pill good">KI-generiert</span>' : set.source === 'seed' ? '<span class="pill">Aufgabensammlung</span>' : ''}
        </div>
      </div>
      ${set.fallbackReason ? `<div class="feedback no mt"><div class="why">KI nicht verfügbar (${esc(set.fallbackReason)}). Es wird eine Aufgabe aus der eingebauten Sammlung verwendet.</div></div>` : ''}
    </div>
    <div id="part-body"></div>
    <div class="card" id="part-submit">
      <div class="btn-row" style="justify-content:space-between">
        <span class="dim small" id="answered-count">0 / ${part.items} beantwortet</span>
        <button class="primary" data-submit-part>Auswerten</button>
      </div>
    </div>
  `;

  const body = container.querySelector('#part-body');
  body.innerHTML = renderSetBody(partId, set);

  if (part.kind === 'truefalse') wireListeningPlayer(container, partId, set, state);

  const updateCount = () => {
    const n = Object.values(state.answers).filter((v) => v !== '' && v !== undefined && v !== null).length;
    const label = container.querySelector('#answered-count');
    if (label) label.textContent = `${n} / ${part.items} beantwortet`;
  };

  const setAnswer = (key, value) => {
    state.answers[key] = value;
    updateCount();
  };

  wireSetBody(container, partId, set, setAnswer, state);

  on(container.querySelector('[data-submit-part]'), 'click', () => {
    state.submitted = true;
    stopSpeaking();
    const result = scoreSet(partId, set, state.answers);
    recordSetAttempts(partId, set, result, 'part');
    if (opts.onFinished) opts.onFinished(result);
  });

  return state;
}

function renderSetBody(partId, set) {
  const kind = PARTS[partId].kind;

  if (kind === 'matching_headlines') {
    return `
      <div class="card">
        <h4>Überschriften</h4>
        <div class="headline-list">
          ${set.headlines.map((h) => `<div class="headline"><b>${esc(h.id)}</b>${esc(h.text)}</div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h4>Texte</h4>
        ${set.texts.map((t) => `
          <div class="item-block">
            <div class="item-stem"><span class="item-num">${esc(t.id)}</span></div>
            <div class="passage short">${esc(t.text)}</div>
            <div class="btn-row mt">
              <label class="small muted">Überschrift:</label>
              <select data-item="${esc(t.id)}" data-kind="hl">
                <option value="">– wählen –</option>
                ${set.headlines.map((h) => `<option value="${esc(h.id)}">${esc(h.id)}</option>`).join('')}
              </select>
            </div>
          </div>`).join('')}
      </div>`;
  }

  if (kind === 'mc3_text') {
    return `
      <div class="card">
        <h4>${esc(set.title)}</h4>
        <div class="passage">${esc(set.text)}</div>
        <div class="dim small mt">${set.text.split(/\s+/).length} Wörter</div>
      </div>
      <div class="card">
        <h4>Aufgaben</h4>
        ${set.questions.map((q) => `
          <div class="item-block" data-question="${q.n}">
            <div class="item-stem"><span class="item-num">${q.n}</span>${esc(q.question)}</div>
            ${['a', 'b', 'c'].map((k) => `<button class="option" data-q="${q.n}" data-opt="${k}">
              <span class="key">${k}</span><span>${esc(q.options[k])}</span></button>`).join('')}
          </div>`).join('')}
      </div>`;
  }

  if (kind === 'matching_ads') {
    return `
      <div class="card">
        <h4>Anzeigen</h4>
        <div class="ads-grid">
          ${set.ads.map((a) => `<div class="ad"><span class="ad-id">${esc(a.id)}</span>${esc(a.text)}</div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h4>Situationen</h4>
        <p class="dim small">Wenn keine Anzeige passt, wähle <b>x</b>. Jede Anzeige höchstens einmal.</p>
        ${set.situations.map((s) => `
          <div class="item-block">
            <div class="item-stem"><span class="item-num">${s.n}</span>${esc(s.text)}</div>
            <select data-item="${s.n}" data-kind="ad">
              <option value="">– wählen –</option>
              ${set.ads.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join('')}
              <option value="x">x – keine Anzeige passt</option>
            </select>
          </div>`).join('')}
      </div>`;
  }

  if (kind === 'gap_mc3') {
    return `
      <div class="card">
        <h4>${esc(set.title || 'Brief')}</h4>
        <p class="dim small">Wähle für jede Lücke die richtige Lösung.</p>
        <div class="letter-body">${letterHtml(set.letter, set.gaps, 'mc3')}</div>
      </div>`;
  }

  if (kind === 'gap_bank') {
    return `
      <div class="card">
        <h4>Wortbank</h4>
        <div class="btn-row">
          ${set.bank.map((b) => `<span class="tag-chip"><b>${esc(b.id)}</b>&nbsp;${esc(b.word)}</span>`).join('')}
        </div>
        <p class="dim small mt">15 Wörter, 10 werden gebraucht. Jedes höchstens einmal.</p>
      </div>
      <div class="card">
        <h4>${esc(set.title || 'Brief')}</h4>
        <div class="letter-body">${letterHtml(set.letter, set.gaps, 'bank')}</div>
      </div>`;
  }

  if (kind === 'truefalse') {
    const plays = PARTS[partId].plays;
    return `
      <div class="card">
        <h4>Hörtext</h4>
        ${ttsSupported() ? `
          <p class="muted small">Dieser Teil wird im Original <b>${plays === 1 ? 'einmal' : 'zweimal'}</b> abgespielt. Lies die Aussagen, bevor du startest.</p>
          <div class="btn-row">
            <button class="primary" data-play>${plays === 1 ? 'Einmal abspielen' : 'Abspielen'} <span class="dim" data-plays-left>(${plays}×)</span></button>
            <button data-stop disabled>Stopp</button>
          </div>
          <div class="mt small dim" id="play-status">Bereit.</div>
          <div id="tts-note"></div>
        ` : `
          <div class="feedback no">
            <div class="verdict">Keine Sprachausgabe verfügbar</div>
            <div class="why">Dieser Browser kann Texte nicht vorlesen. Lies das Skript unten und beantworte die Aussagen – prüfungsnah ist das nicht, aber der Verständnistest bleibt.</div>
          </div>
        `}
        <details class="disclosure mt" id="script-details" ${ttsSupported() ? '' : 'open'}>
          <summary>Transkript anzeigen (erst nach dem Hören sinnvoll)</summary>
          <div class="passage">${esc(set.script)}</div>
        </details>
      </div>
      <div class="card">
        <h4>Aussagen</h4>
        <p class="dim small">Richtig (+) oder Falsch (−). Es gibt keinen Abzug für falsche Antworten – lass nichts leer.</p>
        ${set.items.map((it) => `
          <div class="item-block">
            <div class="tf-row">
              <div style="flex:1">
                <span class="item-num">${it.n}</span>${esc(it.statement)}
              </div>
              <div class="tf-buttons" data-tf="${it.n}">
                <button data-tfval="true" title="Richtig">+</button>
                <button data-tfval="false" title="Falsch">−</button>
              </div>
            </div>
          </div>`).join('')}
      </div>`;
  }

  return '<div class="card">Unbekannter Aufgabentyp.</div>';
}

function letterHtml(letter, gaps, mode) {
  const gapMap = new Map(gaps.map((g) => [String(g.n), g]));
  const parts = String(letter).split(/(\{\d+\})/);
  return parts.map((p) => {
    const m = p.match(/^\{(\d+)\}$/);
    if (!m) return esc(p);
    const n = m[1];
    const gap = gapMap.get(n);
    if (!gap) return esc(p);
    if (mode === 'mc3') {
      const opts = gap.options || {};
      return `<span class="gap-slot"><span class="num">${n}</span><select data-gap="${n}">
        <option value="">–</option>
        ${['a', 'b', 'c'].map((k) => `<option value="${k}">${k}) ${esc(opts[k] || '')}</option>`).join('')}
      </select></span>`;
    }
    // Bank mode: options are injected by wireSetBody once the bank is known.
    return `<span class="gap-slot"><span class="num">${n}</span><select data-gap="${n}" data-bank="1">
      <option value="">–</option>
    </select></span>`;
  }).join('');
}

function wireSetBody(container, partId, set, setAnswer, state) {
  const kind = PARTS[partId].kind;

  if (kind === 'mc3_text') {
    delegate(container, 'click', '[data-q]', (e, t) => {
      if (state.submitted) return;
      const q = t.dataset.q;
      state.answers[q] = t.dataset.opt;
      $$(`[data-q="${q}"]`, container).forEach((b) => {
        b.classList.toggle('correct', b.dataset.opt === t.dataset.opt);
      });
      updateAnswered(container, state, PARTS[partId].items);
    });
    return;
  }

  if (kind === 'truefalse') {
    delegate(container, 'click', '[data-tfval]', (e, t) => {
      if (state.submitted) return;
      const wrap = t.closest('[data-tf]');
      const n = wrap.dataset.tf;
      const val = t.dataset.tfval;
      state.answers[n] = val;
      $$('button', wrap).forEach((b) => b.classList.remove('on-plus', 'on-minus', 'correct', 'wrong'));
      const target = val === 'true' ? wrap.querySelector('[data-tfval="true"]') : wrap.querySelector('[data-tfval="false"]');
      target.classList.add(val === 'true' ? 'on-plus' : 'on-minus');
      updateAnswered(container, state, PARTS[partId].items);
    });
    return;
  }

  if (kind === 'gap_bank') {
    // fill bank words into every gap select
    $$('select[data-gap]', container).forEach((sel) => {
      sel.innerHTML = `<option value="">–</option>${set.bank.map((b) => `<option value="${esc(b.id)}">${esc(b.id)}) ${esc(b.word)}</option>`).join('')}`;
    });
  }

  delegate(container, 'change', 'select[data-item], select[data-gap]', (e, t) => {
    if (state.submitted) return;
    const key = t.dataset.item || t.dataset.gap;
    setAnswer(key, t.value);
  });
}

function updateAnswered(container, state, total) {
  const label = container.querySelector('#answered-count');
  if (!label) return;
  const n = Object.values(state.answers).filter((v) => v !== '' && v !== undefined && v !== null).length;
  label.textContent = `${n} / ${total} beantwortet`;
}

/* ------------------------------------------------------- listening player */

function wireListeningPlayer(container, partId, set, state) {
  const playBtn = container.querySelector('[data-play]');
  const stopBtn = container.querySelector('[data-stop]');
  const status = container.querySelector('#play-status');
  const left = container.querySelector('[data-plays-left]');
  if (!playBtn) return;

  const maxPlays = PARTS[partId].plays || 1;
  let myRun = 0;

  // Chrome populates getVoices() asynchronously, so never judge on the first empty
  // read. This only ever ADVISES - the play button stays enabled, because a false
  // negative here would break listening practice on a machine where it works.
  waitForVoices().then(() => {
    if (germanVoices().length) return;
    const note = container.querySelector('#tts-note');
    if (!note) return;
    note.innerHTML = `<div class="feedback no mt">
      <div class="verdict">Keine deutsche Stimme gefunden</div>
      <div class="why">
        Ohne deutsche Stimme wird der Text mit englischer Aussprache vorgelesen. Du kannst trotzdem
        starten, aber lies besser das Transkript und sprich die Sätze selbst mit.
        Chrome liefert normalerweise „Google Deutsch“ mit – prüfe die Internetverbindung und starte den
        Browser neu. Details unter <b>Einstellungen</b>.
      </div>
    </div>`;
    const details = container.querySelector('#script-details');
    if (details) details.open = true;
  });

  on(stopBtn, 'click', () => {
    stopSpeaking();
    if (status) status.textContent = 'Gestoppt.';
  });

  on(playBtn, 'click', async () => {
    if (state.plays >= maxPlays) {
      toast(`Im Original wird dieser Teil nur ${maxPlays === 1 ? 'einmal' : 'zweimal'} abgespielt.`, 'warn');
      return;
    }
    state.plays += 1;
    myRun += 1;
    const runId = myRun;
    playBtn.disabled = true;
    stopBtn.disabled = false;
    const rate = store.getState().settings.ttsRate || 0.95;
    const voiceName = store.getState().settings.voiceName || undefined;
    try {
      await speakScript(set.script, {
        rate,
        voiceName,
        onProgress: (i, total) => {
          if (runId !== myRun) return;
          if (status) status.textContent = `Läuft… Abschnitt ${Math.min(i + 1, total)} von ${total}`;
        },
      });
    } catch (err) {
      toast(err.message, 'bad');
    }
    if (runId !== myRun) return;
    stopBtn.disabled = true;
    if (state.plays < maxPlays) {
      playBtn.disabled = false;
      playBtn.innerHTML = `Noch einmal abspielen <span class="dim" data-plays-left>(${maxPlays - state.plays}×)</span>`;
      if (status) status.textContent = 'Abschnitt beendet. Du darfst noch einmal hören.';
    } else {
      playBtn.innerHTML = 'Kein weiteres Abspielen';
      if (status) status.textContent = 'Ende der zulässigen Wiederholungen.';
    }
  });
}

/* -------------------------------------------------------------- scoring */

function scoreSet(partId, set, answers) {
  const kind = PARTS[partId].kind;
  const items = [];
  const push = (n, expected, given, tags, prompt, explanation) => {
    const correct = String(given ?? '').trim() !== '' && String(given).trim().toLowerCase() === String(expected).trim().toLowerCase();
    items.push({ n, expected, given: given ?? '', correct, tags, prompt, explanation });
  };

  if (kind === 'matching_headlines') {
    for (const t of set.texts) {
      push(t.id, t.answer, answers[t.id], ['lv_global'], t.text.slice(0, 240), set.why?.[t.id] || `Überschrift ${t.answer} passt zum Text.`);
    }
  } else if (kind === 'mc3_text') {
    for (const q of set.questions) {
      push(q.n, q.answer, answers[q.n], ['lv_detail'], q.question, q.why);
    }
  } else if (kind === 'matching_ads') {
    for (const s of set.situations) {
      push(s.n, s.answer, answers[s.n], ['lv_selektiv'], s.text, s.why);
    }
  } else if (kind === 'gap_mc3') {
    for (const g of set.gaps) {
      const opts = g.options || {};
      push(g.n, g.answer, answers[g.n], [g.grammar || 'konnektoren'], `Lücke ${g.n}`, `${g.answer}) ${opts[g.answer] || ''} — ${g.why}`);
    }
  } else if (kind === 'gap_bank') {
    const wordOf = (id) => set.bank.find((b) => b.id === id)?.word || id;
    for (const g of set.gaps) {
      push(g.n, g.answer, answers[g.n], [g.grammar || 'konnektoren'], `Lücke ${g.n}`, `${g.answer}) ${wordOf(g.answer)} — ${g.why}`);
    }
  } else if (kind === 'truefalse') {
    const tag = PARTS[partId].skills?.[0] || 'hv_detail';
    for (const it of set.items) {
      push(it.n, String(it.answer), String(answers[it.n]), [tag], it.statement, it.why);
    }
  }

  const correct = items.filter((i) => i.correct).length;
  return { items, correct, total: items.length, partId };
}

function recordSetAttempts(partId, set, result, source) {
  const difficulty = engine.PART_DIFFICULTY[partId] ?? 56;
  for (const item of result.items) {
    store.recordAttempt({
      partId,
      tags: item.tags,
      difficulty,
      correct: item.correct,
      source,
      // Identifies the individual question, so a later merge can tell five items
      // logged within the same millisecond apart.
      itemRef: `${partId}#${item.n}`,
      detail: {
        prompt: item.prompt,
        yourAnswer: item.given,
        correctAnswer: item.expected,
        explanation: item.explanation,
        source,
      },
    });
  }
}

function showPartResult(el, partId, set, result, params) {
  const part = PARTS[partId];
  const points = engine.pointsFor(partId, result.correct, result.total);
  const percent = result.total ? (result.correct / result.total) * 100 : 0;
  setViewActions(`<button data-back>← Alle Teile</button><button data-regen>Neu generieren</button>`);
  on(document.querySelector('[data-back]'), 'click', () => navigate('paper', { group: params.group || null }));
  on(document.querySelector('[data-regen]'), 'click', () => navigate('paper', { partId, group: params.group, nonce: Date.now() }));

  el.innerHTML = `
    <div class="card">
      <h2>Ergebnis · ${esc(groupOf(partId).name)} · ${esc(part.label)}</h2>
      <div class="grid three mt">
        ${statCard('Punkte', `${round1(points)}<span class="dim" style="font-size:.9rem"> / ${part.pts}</span>`, '')}
        ${statCard('Richtig', `${result.correct} / ${result.total}`, '')}
        ${statCard('Quote', pct(percent), `<span class="pill ${percent >= 70 ? 'good' : percent >= 55 ? 'warn' : 'bad'}">${percent >= 70 ? 'solide' : percent >= 55 ? 'grenzwertig' : 'ausbauen'}</span>`)}
      </div>
    </div>
    <div class="card">
      <h3>Im Detail</h3>
      ${result.items.map((it) => `
        <div class="item-block">
          <div class="btn-row" style="justify-content:space-between">
            <b><span class="item-num">${esc(it.n)}</span>${esc(String(it.prompt).slice(0, 150))}</b>
            <span class="pill ${it.correct ? 'good' : 'bad'}">${it.correct ? 'richtig' : 'falsch'}</span>
          </div>
          ${!it.correct ? `<div class="small mt"><span style="color:var(--bad)">Deine Antwort: ${esc(formatAnswer(partId, set, it.given) || '– keine –')}</span> · <span style="color:var(--good)">Richtig: ${esc(formatAnswer(partId, set, it.expected))}</span></div>` : ''}
          ${it.explanation ? `<div class="dim small mt">${esc(it.explanation)}</div>` : ''}
          <div class="btn-row mt">${it.tags.map((t) => `<span class="tag-chip" data-tag="${esc(t)}">${esc(tagInfo(t).label)}</span>`).join('')}</div>
        </div>`).join('')}
    </div>
    <div class="card">
      <h3>Nächster Schritt</h3>
      <p class="muted small">Die falschen Antworten sind im Fehlerheft gelandet und kommen automatisch wieder.</p>
      <div class="btn-row">
        <button class="primary" data-again>Teil wiederholen</button>
        <button data-drill-weak>Schwächen gezielt üben</button>
        <button data-notebook>Fehlerheft (${store.listErrors().length})</button>
      </div>
    </div>
  `;

  on(el.querySelector('[data-again]'), 'click', () => navigate('paper', { partId, group: params.group, nonce: Date.now() }));
  on(el.querySelector('[data-notebook]'), 'click', () => navigate('notebook'));
  on(el.querySelector('[data-drill-weak]'), 'click', () => {
    const weak = store.weakNodes({ limit: 3, prefix: 'tag:' }).map((w) => w.id.slice(4));
    navigate('drill', { tags: weak, size: 10 });
  });
  delegate(el, 'click', '[data-tag]', (e, t) => navigate('drill', { tags: [t.dataset.tag], size: 6 }));
}

function formatAnswer(partId, set, value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const kind = PARTS[partId].kind;
  if (kind === 'gap_mc3') {
    const g = set.gaps.find((x) => String(x.n) === v || x.answer === v);
    if (g?.options?.[v]) return `${v}) ${g.options[v]}`;
  }
  if (kind === 'gap_bank') {
    const b = set.bank.find((x) => x.id === v);
    if (b) return `${v}) ${b.word}`;
  }
  if (kind === 'truefalse') return v === 'true' ? '+ richtig' : '− falsch';
  return v;
}

/* ================================================================ writing */

let writingTask = null;
let writingSlot = 0;
let writingSurface = null;
let writingTimer = null;
// Same overlap guard as the speaking view: two generations can race, and without a
// token the slower answer lands last and overwrites the newer view.
let writingRender = 0;

export async function writingView(el, params = {}) {
  const token = ++writingRender;

  setViewActions(`<button data-new-task>Neue Aufgabe</button>`);
  on(document.querySelector('[data-new-task]'), 'click', () => navigate('writing', { nonce: Date.now() }));

  if (!writingTask || params.nonce) {
    writingTask = null;
    el.innerHTML = spinnerRow('Schreibaufgabe wird erstellt…');
    const generated = await ai.nextWritingTask({ difficulty: engine.PART_DIFFICULTY.SA1 });
    if (token !== writingRender) return; // a newer render already took over
    if (generated.fallbackReason) toast('KI nicht verfügbar – eingebaute Aufgabe wird verwendet.', 'warn');
    writingTask = generated;
    // The draft's task identity: one attempt per rotation slot, stable across re-entry and
    // changes only when the learner asks for a new task (exam.js nextWritingTask increments it).
    writingSlot = store.getState().settings.writingTaskIndex;
  }

  renderWritingTask(el);
}

function renderWritingTask(el) {
  const task = writingTask;
  const st = store.getState().settings;

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Schreiben · Brief/E-Mail</h3>
          <div class="dim small">45 Punkte · 30 Minuten · 4 Leitpunkte · Übungsziel: ca. 80–120 Wörter</div>
          <div class="dim small">Informelle (du) und halbformelle (Sie) E-Mails wechseln sich ab.</div>
        </div>
        <span class="pill ${task.source === 'ai' ? 'good' : ''}">${task.source === 'ai' ? 'KI-generiert' : 'eingebaute Aufgabe'}</span>
      </div>
    </div>

    <div class="card">
      <h4>Aufgabe</h4>
      <p>${esc(task.situation)}</p>
      <p class="small muted">Adressat: ${esc(task.adressat)} · Register: <b>${task.register === 'du' ? 'informell · du' : 'halbformell · Sie'}</b></p>
      <h4 class="mt">Leitpunkte</h4>
      <ol class="muted" style="margin:0 0 0 18px;padding:0">
        ${task.leitpunkte.map((l) => `<li>${esc(l)}</li>`).join('')}
      </ol>
      ${task.tipps?.length ? `<details class="disclosure mt"><summary>Tipps</summary><ul class="muted small" style="margin:0 0 0 18px;padding:0">${task.tipps.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
    </div>

    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <h4 style="margin:0">Dein Text</h4>
        <div class="btn-row">
          <span class="timer" id="w-timer">30:00</span>
          <button class="sm" data-toggle-timer>Start</button>
        </div>
      </div>
      <textarea id="writing-text" class="mt" style="min-height:240px" placeholder="${esc(task.register === 'Sie' ? 'Sehr geehrte/r …,' : 'Liebe/r …,')}\n\n…"></textarea>
      <div id="w-draft-status" class="dim small mt"></div>
      <div class="btn-row mt" style="justify-content:space-between">
        <span class="dim small" id="w-count">0 Wörter</span>
        <div class="btn-row">
          <button data-live-check>Offline-Check</button>
          <button class="primary" data-grade>Korrigieren lassen</button>
        </div>
      </div>
      <div id="w-result" class="mt"></div>
    </div>

    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h4 style="margin:0">Briefe schreiben: Strategie &amp; Bausteine</h4>
          <div class="dim small">Aufbau, Anrede, Wendungen und vier vollständige Musterbriefe – zum Nachschlagen.</div>
        </div>
        <button data-open-writing-guide>Nachschlagen</button>
      </div>
    </div>
  `;

  on(el.querySelector('[data-open-writing-guide]'), 'click', () => navigate('writingguide'));

  const textarea = el.querySelector('#writing-text');
  const count = el.querySelector('#w-count');
  const updateCount = () => {
    const words = textarea.value.trim().split(/\s+/).filter(Boolean).length;
    const ok = words >= 80 && words <= 140;
    count.innerHTML = `${words} Wörter ${ok ? '<span style="color:var(--good)">· im Zielbereich</span>' : words < 80 ? '<span class="dim">· noch zu kurz (Ziel ab 80)</span>' : '<span style="color:var(--warn)">· recht lang</span>'}`;
  };
  updateCount();

  /* Recoverable account draft (WRITING-SURFACE-01B). On the single-user path, or whenever
     the boundary refuses, this paints nothing and the view behaves exactly as before. */
  const draftStatus = el.querySelector('#w-draft-status');
  const renderToken = writingRender;
  let surface = null;
  const paintDraftStatus = () => {
    const s = surface.state();
    if (s.mode !== 'draft') {
      draftStatus.textContent = s.error === 'stale_session'
        ? 'Der Entwurf gehört zu einer anderen Sitzung. Dein Text bleibt hier sichtbar.'
        : '';
      return;
    }
    if (s.status === 'conflict') {
      // A 409 is never swallowed: the learner chooses what the draft service already models.
      draftStatus.innerHTML = `<span>Auf dem Server liegt eine neuere Fassung. Dein Text wurde nicht überschrieben.</span>
        <span class="btn-row" style="display:inline-flex;gap:8px;margin-left:8px">
          <button class="sm" data-conflict-local>Meinen Text behalten</button>
          <button class="sm" data-conflict-server>Server-Fassung übernehmen</button>
        </span>`;
      on(draftStatus.querySelector('[data-conflict-local]'), 'click', async () => {
        surface.resolveConflict('local');
        await surface.flush();
      });
      on(draftStatus.querySelector('[data-conflict-server]'), 'click', () => {
        const resolved = surface.resolveConflict('server');
        if (typeof resolved.text === 'string') { textarea.value = resolved.text; updateCount(); }
      });
      return;
    }
    draftStatus.textContent = s.dirty ? 'Entwurf: noch nicht gespeichert.' : 'Entwurf gespeichert.';
  };
  surface = createWritingSurface({ openDraft: (id) => session().openDraft(id), onState: paintDraftStatus });
  writingSurface = surface;
  on(textarea, 'input', () => { updateCount(); surface.change(textarea.value); });
  surface.enter(writingTaskId(writingSlot), { initialText: textarea.value }).then((entered) => {
    if (renderToken !== writingRender) return; // a newer render already took over
    if (typeof entered.text === 'string' && entered.text !== textarea.value) {
      textarea.value = entered.text;
      updateCount();
    }
    paintDraftStatus();
  }, (error) => {
    if (renderToken !== writingRender) return;
    draftStatus.textContent = 'Der Entwurf konnte nicht geladen werden.';
    console.error(error);
  });

  /* timer */
  let remaining = 30 * 60;
  let running = false;
  let handle = null;
  const timerEl = el.querySelector('#w-timer');
  const tick = () => {
    remaining -= 1;
    timerEl.textContent = fmtClock(remaining);
    timerEl.classList.toggle('low', remaining <= 300 && remaining > 0);
    timerEl.classList.toggle('out', remaining <= 0);
    if (remaining <= 0) {
      stopTimer();
      beep('end');
      toast('Zeit um – in der Prüfung müsstest du jetzt abgeben.', 'warn', 6000);
    }
  };
  const stopTimer = () => {
    running = false;
    if (handle) clearInterval(handle);
    handle = null;
    const btn = el.querySelector('[data-toggle-timer]');
    if (btn) btn.textContent = 'Start';
  };
  on(el.querySelector('[data-toggle-timer]'), 'click', (e) => {
    if (running) return stopTimer();
    running = true;
    e.target.textContent = 'Pause';
    handle = setInterval(tick, 1000);
  });
  writingTimer = () => {
    if (handle) clearInterval(handle);
  };

  /* offline check */
  on(el.querySelector('[data-live-check]'), 'click', () => {
    const analysis = engine.analyseWriting(textarea.value, task);
    el.querySelector('#w-result').innerHTML = renderOfflineAnalysis(analysis, task);
  });

  /* AI grading */
  const gradeBtn = el.querySelector('[data-grade]');
  on(gradeBtn, 'click', async () => {
    const text = textarea.value.trim();
    if (text.split(/\s+/).filter(Boolean).length < 30) {
      toast('Schreibe mindestens ein paar Sätze, bevor du korrigieren lässt.', 'warn');
      return;
    }
    const analysis = engine.analyseWriting(text, task);
    const out = el.querySelector('#w-result');
    out.innerHTML = renderOfflineAnalysis(analysis, task);
    // Dedicated host so the spinner can be removed once the result lands.
    const spinHost = document.createElement('div');
    spinHost.className = 'card tight';
    out.appendChild(spinHost);
    const stopTick = spinnerWithTimer(spinHost, 'Die KI korrigiert deinen Text…');
    const clearSpinner = () => {
      stopTick();
      spinHost.remove();
    };

    if (!ai.isConfigured()) {
      clearSpinner();
      out.insertAdjacentHTML('beforeend', `<div class="feedback no"><div class="verdict">Keine KI-Korrektur</div>
        <div class="why">Für eine vollständige Korrektur mit Fehlerliste und Musterbrief brauchst du einen API-Schlüssel (Einstellungen). Der Offline-Check oben läuft ohne Schlüssel.</div></div>`);
      return;
    }

    // The grading is a network round trip outside the session boundary. A sign-out, expiry or
    // account switch while it is on the wire moves the store's scope; the answer then belongs
    // to the previous learner and is neither shown nor recorded (SESSION-BOUNDARY-02 F2).
    const scope = store.scopeToken();
    try {
      const graded = await ai.gradeWriting({ task, text, analysis });
      clearSpinner();
      if (!store.isScopeCurrent(scope)) return;
      out.insertAdjacentHTML('beforeend', renderAiGrading(graded, task, analysis));

      // Feed the writing-specific weakness tags.
      const covered = graded.leitpunkteCovered || [];
      const taskCoverage = covered.length ? covered.filter(Boolean).length / covered.length : analysis.heuristic;
      const diff = engine.PART_DIFFICULTY.SA1;
      store.recordAttempt({ partId: 'SA1', tags: ['sa_aufgabe'], difficulty: diff, correct: taskCoverage >= 0.99, source: 'writing' });
      for (const c of graded.criteria) {
        const tagMap = { aufgabe: 'sa_aufgabe', kommunikation: 'sa_register', richtigkeit: 'sa_grammatik', ausdruck: 'sa_wortschatz' };
        const tag = tagMap[c.key];
        if (tag) store.recordAttempt({ partId: 'SA1', tags: [tag], difficulty: diff, correct: c.score >= 65, source: 'writing' });
      }
      store.recordAttempt({ partId: 'SA1', tags: ['sa_umfang'], difficulty: diff, correct: analysis.words >= 80 && analysis.words <= 150, source: 'writing' });
      store.recordAttempt({ partId: 'SA1', tags: ['sa_konnektoren'], difficulty: diff, correct: analysis.usedConnectors.length >= 4, source: 'writing' });

      for (const corr of graded.corrections.slice(0, 10)) {
        store.addError({
          partId: 'SA1',
          tags: ['sa_grammatik'],
          difficulty: diff,
          prompt: corr.original,
          yourAnswer: corr.original,
          correctAnswer: corr.corrected,
          explanation: corr.explanation,
          source: 'writing',
        });
      }

      const listenBtn = out.querySelector('[data-read-model]');
      if (listenBtn) on(listenBtn, 'click', () => speak(graded.modelAnswer, { rate: st.ttsRate || 0.95, voiceName: st.voiceName }));
    } catch (err) {
      clearSpinner();
      out.insertAdjacentHTML('beforeend', `<div class="feedback no"><div class="verdict">Korrektur fehlgeschlagen</div><div class="why">${esc(err.message)}</div>
        <div class="why mt">Ein zweiter Versuch hilft oft – Modellanfragen hängen gelegentlich. Dein Text bleibt erhalten.</div></div>`);
    }
  });
}

function renderOfflineAnalysis(a, task) {
  return `
    <div class="card tight">
      <h4>Automatischer Check</h4>
      <table class="plain">
        <tbody>
          ${a.checks.map((c) => `<tr>
            <td style="width:26px;color:${c.ok ? 'var(--good)' : 'var(--bad)'}">${c.ok ? '✓' : '✗'}</td>
            <td>${esc(c.label)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="dim small mt">${a.words} Wörter · ${a.sentences} Sätze · Ø ${a.avgSentence} Wörter pro Satz</div>
    </div>`;
}

function renderAiGrading(g, task, analysis) {
  const bandTone = g.total >= 36 ? 'good' : g.total >= 29 ? 'warn' : 'bad';
  return `
    <div class="card tight">
      <div class="verdict-row">
        <span class="score">${round1(g.total)}<span class="dim" style="font-size:1rem"> / 45</span></span>
        <span class="pill ${bandTone}">${esc(g.band || '')}</span>
      </div>
      <table class="plain">
        <thead><tr><th>Kriterium</th><th class="num">Punkte</th><th class="num">Urteil</th></tr></thead>
        <tbody>
          ${g.criteria.map((c) => `<tr>
            <td>${esc(c.label || c.key)}<div class="dim small">${esc(c.comment)}</div></td>
            <td class="num">${round1(c.points)} / ${c.max}</td>
            <td class="num" style="color:${c.score >= 70 ? 'var(--good)' : c.score >= 50 ? 'var(--warn)' : 'var(--bad)'}">${Math.round(c.score)}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      ${g.leitpunkteCovered?.length ? `<div class="mt">
        <h4>Leitpunkte</h4>
        <div class="btn-row">${g.leitpunkteCovered.map((c, i) => `<span class="tag-chip ${c ? 'strong' : 'weak'}">${c ? '✓' : '✗'} ${esc(task.leitpunkte[i] || `Punkt ${i + 1}`)}</span>`).join('')}</div>
      </div>` : ''}

      ${g.corrections?.length ? `<div class="mt">
        <h4>Korrekturen (${g.corrections.length})</h4>
        ${g.corrections.map((c) => `<div class="correction">
          <div><span class="orig">${esc(c.original)}</span> → <span class="corr">${esc(c.corrected)}</span></div>
          ${c.explanation ? `<div class="why">${esc(c.explanation)}</div>` : ''}
        </div>`).join('')}
      </div>` : ''}

      ${g.strengths?.length ? `<div class="mt"><h4>Das war gut</h4><ul class="muted small" style="margin:0 0 0 18px;padding:0">${g.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${g.priorities?.length ? `<div class="mt"><h4>Prioritäten</h4><ul class="muted small" style="margin:0 0 0 18px;padding:0">${g.priorities.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}

      ${g.modelAnswer ? `<details class="disclosure mt"><summary>Musterbrief anzeigen</summary>
        <div class="passage">${esc(g.modelAnswer)}</div>
        ${ttsSupported() ? '<button class="sm mt" data-read-model>Vorlesen</button>' : ''}
      </details>` : ''}
    </div>`;
}

/* =============================================================== speaking */

let speakingTask = null;
// Generating a task takes a real API round-trip, so two renders can overlap (click
// the sidebar, then switch Teil). Without a token the slower answer lands last and
// overwrites the newer view, wiping a running timer or a half-typed transcript.
let speakingRender = 0;

export async function speakingView(el, params = {}) {
  const partId = params.partId || 'SP1';
  const part = PARTS[partId];
  const token = ++speakingRender;

  setViewActions(`
    <div class="btn-row">
      ${['SP1', 'SP2', 'SP3'].map((id) => `<button class="${id === partId ? 'primary' : ''}" data-sp="${id}">${esc(PARTS[id].label.replace(/^Teil \d – /, ''))}</button>`).join('')}
    </div>
    <button data-new-task>Neue Aufgabe</button>
  `);
  const actionsEl = document.getElementById('view-actions');
  $$('[data-sp]', actionsEl).forEach((btn) => {
    on(btn, 'click', () => navigate('speaking', { partId: btn.dataset.sp, nonce: Date.now() }));
  });
  on(actionsEl.querySelector('[data-new-task]'), 'click', () => navigate('speaking', { partId, nonce: Date.now() }));

  if (!speakingTask || params.nonce || speakingTask.partId !== partId) {
    speakingTask = null;
    el.innerHTML = spinnerRow('Sprechaufgabe wird erstellt…');
    let generated = null;
    if (ai.isConfigured()) {
      try {
        generated = await ai.genSpeakingTask(partId, { difficulty: engine.PART_DIFFICULTY[partId] });
      } catch {
        generated = ai.offlineSpeakingTask(partId);
        toast('KI nicht verfügbar – eingebaute Aufgabe wird verwendet.', 'warn');
      }
    } else {
      generated = ai.offlineSpeakingTask(partId);
    }
    if (token !== speakingRender) return; // a newer render already took over
    speakingTask = generated;
  }

  renderSpeakingTask(el, partId, part);
}

function renderSpeakingTask(el, partId, part) {
  const task = speakingTask;
  const renderToken = speakingRender;
  const st = store.getState().settings;
  const prepMinutes = partId === 'SP1' ? 3 : 5;

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">${esc(part.label)}</h3>
          <div class="dim small">${esc(part.brief)}</div>
        </div>
        <span class="pill ${task.source === 'ai' ? 'good' : ''}">${task.source === 'ai' ? 'KI-generiert' : 'eingebaute Aufgabe'}</span>
      </div>
    </div>

    <div class="card">
      <h4>Aufgabenkarte</h4>
      <p>${esc(task.situation)}</p>
      ${task.keywords?.length ? `<div class="btn-row">${task.keywords.map((k) => `<span class="tag-chip">${esc(k)}</span>`).join('')}</div>` : ''}
      ${task.questions?.length ? `<div class="mt"><h4>Anschlussfragen</h4><ul class="muted" style="margin:0 0 0 18px;padding:0">${task.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    </div>

    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <h4 style="margin:0">Vorbereitung & Sprechen</h4>
        <div class="btn-row">
          <span class="timer" id="s-timer">${fmtClock(prepMinutes * 60)}</span>
          <button class="sm" data-prep>Vorbereitung starten</button>
          <button class="sm" data-speak-task>${ttsSupported() ? 'Aufgabe vorlesen' : ''}</button>
        </div>
      </div>
      <p class="dim small mt">In der echten Prüfung hast du ca. 20 Minuten Vorbereitungszeit für alle drei Teile. Nimm dir ${prepMinutes} Minuten, sprich dann frei – ohne abzulesen.</p>
    </div>

    <div class="card">
      <h4>Dein Beitrag</h4>
      ${sttSupported() ? `
        <p class="muted small">Klicke auf Aufnahme und sprich Deutsch. Der Browser wandelt deine Sprache in Text um; daraus bekommst du Feedback zu Struktur, Wortschatz und Interaktion.</p>
        <div class="btn-row mb">
          <button class="primary" data-rec>🎙 Aufnahme starten</button>
          <button data-rec-stop disabled>Aufnahme beenden</button>
          <span id="rec-status" class="dim small">bereit</span>
        </div>
        <div class="transcript-box" id="transcript"><span class="dim">Dein gesprochener Text erscheint hier…</span></div>
      ` : `
        <div class="feedback no mb">
          <div class="verdict">Spracherkennung nicht verfügbar</div>
          <div class="why">Dieser Browser unterstützt keine Spracherkennung (Chrome und Edge tun es). Sprich laut und tippe danach, was du gesagt hast – das Feedback funktioniert genauso.</div>
        </div>
      `}
      <label class="field mt">
        <span>${sttSupported() ? 'Oder tippe deinen Beitrag (falls das Mikrofon nicht klappt)' : 'Tippe hier, was du gesagt hast'}</span>
        <textarea id="spoken-text" placeholder="Ich möchte Ihnen meine Heimatstadt vorstellen. Sie liegt…" style="min-height:150px"></textarea>
      </label>
      <div class="btn-row mt">
        <button class="primary" data-grade-speak>Feedback holen</button>
        <button data-listen-model ${ttsSupported() ? '' : 'disabled'}>Musterantwort vorlesen</button>
      </div>
      <div id="s-result" class="mt"></div>
    </div>

    ${task.redemittel?.length ? `
      <div class="card">
        <h4>Redemittel für diesen Teil</h4>
        <div class="btn-row">${task.redemittel.map((r) => `<span class="tag-chip" data-say="${esc(r)}">${esc(r)}</span>`).join('')}</div>
        <div class="dim small mt">Klick auf eine Wendung, um sie dir vorlesen zu lassen.</div>
      </div>` : ''}

    ${task.tipps?.length ? `
      <div class="card">
        <h4>Tipps</h4>
        <ul class="muted small" style="margin:0 0 0 18px;padding:0">${task.tipps.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>` : ''}

    ${task.modelAnswer ? `
      <div class="card">
        <div class="btn-row" style="justify-content:space-between">
          <h4 style="margin:0">Musterantwort</h4>
          ${ttsSupported() ? '<button class="sm" data-read-model>Vorlesen</button>' : ''}
        </div>
        <p class="dim small">Ein vollständiges Beispiel für genau diese Aufgabe. Nicht auswendig lernen – lies es einmal laut und bau die Wendungen dann frei ein.</p>
        <div class="passage">${esc(task.modelAnswer)}</div>
      </div>` : ''}

    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h4 style="margin:0">Redemittel &amp; Strategie</h4>
          <div class="dim small">Alle Wendungen, Beispielsätze und Musterantworten für diesen Teil – zum Nachschlagen.</div>
        </div>
        <button data-open-guide="${esc(partId)}">Nachschlagen</button>
      </div>
    </div>
  `;

  on(el.querySelector('[data-open-guide]'), 'click', (e) => navigate('speakingguide', { partId: e.currentTarget.dataset.openGuide }));

  /* prep timer */
  let remaining = prepMinutes * 60;
  let handle = null;
  const timerEl = el.querySelector('#s-timer');
  on(el.querySelector('[data-prep]'), 'click', (e) => {
    if (handle) {
      clearInterval(handle);
      handle = null;
      e.target.textContent = 'Vorbereitung starten';
      return;
    }
    e.target.textContent = 'Stopp';
    handle = setInterval(() => {
      remaining -= 1;
      timerEl.textContent = fmtClock(remaining);
      timerEl.classList.toggle('low', remaining <= 30);
      if (remaining <= 0) {
        clearInterval(handle);
        handle = null;
        beep('end');
        timerEl.textContent = '00:00';
        timerEl.classList.add('out');
        toast('Vorbereitungszeit vorbei – jetzt sprechen!', 'warn', 6000);
      }
    }, 1000);
  });

  on(el.querySelector('[data-speak-task]'), 'click', () => {
    speak(`${task.situation}. ${(task.keywords || []).join('. ')}`, { rate: st.ttsRate || 0.95, voiceName: st.voiceName });
  });

  /* dictation */
  let recognition = null;
  let finalText = '';
  const transcriptEl = el.querySelector('#transcript');
  const recBtn = el.querySelector('[data-rec]');
  const stopBtn = el.querySelector('[data-rec-stop]');
  const statusEl = el.querySelector('#rec-status');
  let startedAt = 0;

  if (recBtn) {
    const setLive = (restarts) => {
      const words = finalText.trim().split(/\s+/).filter(Boolean).length;
      statusEl.innerHTML =
        '<span class="rec-dot" style="display:inline-block"></span> hört zu…' +
        (words ? ` <span class="dim">${words} Wörter erkannt</span>` : '') +
        (restarts > 1 ? ` <span class="dim">(läuft weiter, Abschnitt ${restarts})</span>` : '');
    };

    on(recBtn, 'click', () => {
      finalText = '';
      startedAt = Date.now();
      recognition = startDictation({
        onTranscript: ({ final, interim }) => {
          finalText = final;
          transcriptEl.innerHTML = `${esc(final)} <span class="interim">${esc(interim)}</span>`;
          setLive(recognition?.restarts || 1);
        },
        // Chrome ends recognition on its own every few seconds of silence; the helper
        // resumes it, so this only reports the resume rather than treating it as a stop.
        onRestart: (count) => setLive(count),
        onError: (err) => {
          statusEl.textContent = err.message;
          toast(err.message, 'bad', 7000);
        },
        onEnd: () => {
          recBtn.disabled = false;
          stopBtn.disabled = true;
          const words = finalText.trim().split(/\s+/).filter(Boolean).length;
          statusEl.textContent = words
            ? `Aufnahme beendet – ${words} Wörter erkannt.`
            : 'Aufnahme beendet – nichts erkannt. Sprich näher am Mikrofon.';
        },
      });
      if (recognition) {
        recBtn.disabled = true;
        stopBtn.disabled = false;
        setLive(1);
      }
    });
    on(stopBtn, 'click', () => {
      recognition?.stop();
      startedAt = startedAt || Date.now();
    });
  }

  const gradeBtn = el.querySelector('[data-grade-speak]');
  let feedbackPending = false;
  on(gradeBtn, 'click', async () => {
    if (feedbackPending || renderToken !== speakingRender) return;
    const typed = (el.querySelector('#spoken-text')?.value || '').trim();
    const text = typed || (recBtn ? finalText : '');
    const out = el.querySelector('#s-result');
    if (String(text).trim().split(/\s+/).filter(Boolean).length < 15) {
      toast('Sprich oder tippe mindestens ein paar Sätze.', 'warn');
      return;
    }
    const seconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    const wpm = speakingRate(text, seconds);
    feedbackPending = true;
    gradeBtn.disabled = true;
    let stopTick = () => {};

    try {
      stopTick = spinnerWithTimer(out, 'Feedback wird erstellt…');
      if (!ai.isConfigured()) {
        out.innerHTML = `<div class="feedback no"><div class="verdict">Kein KI-Feedback</div>
          <div class="why">Für eine Bewertung deines Beitrags brauchst du einen API-Schlüssel. Vergleiche solange deinen Text mit der Musterantwort.</div></div>`;
        return;
      }
      const graded = await ai.gradeSpeaking({ task, transcript: text, partId, durationSec: seconds });
      if (renderToken !== speakingRender || !out.isConnected) return;
      out.innerHTML = renderSpeakingFeedback(graded, wpm);

      const diff = engine.PART_DIFFICULTY[partId] ?? 56;
      const tagMap = { struktur: 'sp_struktur', wortschatz: 'sp_wortschatz', fluessigkeit: 'sp_fluessigkeit', interaktion: 'sp_interaktion' };
      for (const c of graded.criteria) {
        const tag = tagMap[c.key];
        if (tag && c.score !== null) {
          store.recordAttempt({ partId, tags: [tag], difficulty: diff, correct: c.score >= 65, source: 'speaking' });
        }
      }
      for (const corr of graded.corrections.slice(0, 8)) {
        store.addError({
          partId, tags: ['sp_wortschatz'], difficulty: diff,
          prompt: corr.original, yourAnswer: corr.original, correctAnswer: corr.corrected,
          explanation: corr.explanation, source: 'speaking',
        });
      }
    } catch (err) {
      if (renderToken !== speakingRender || !out.isConnected) return;
      out.innerHTML = `<div class="feedback no"><div class="verdict">Feedback fehlgeschlagen</div><div class="why">${esc(err.message)}</div>
        <div class="why mt">Ein zweiter Versuch hilft oft – Modellanfragen hängen gelegentlich. Dein Text bleibt erhalten.</div></div>`;
    } finally {
      stopTick();
      feedbackPending = false;
      gradeBtn.disabled = false;
    }
  });

  on(el.querySelector('[data-listen-model]'), 'click', () => {
    const model = task.modelAnswer || 'Für diese Aufgabe gibt es keine Musterantwort.';
    speak(model, { rate: st.ttsRate || 0.95, voiceName: st.voiceName });
  });

  delegate(el, 'click', '[data-say]', (e, t) => speak(t.dataset.say, { rate: st.ttsRate || 0.95, voiceName: st.voiceName }));
}

function renderSpeakingFeedback(g, wpm) {
  const tone = (g.points ?? 0) >= 19 ? 'good' : (g.points ?? 0) >= 14 ? 'warn' : 'bad';
  return `
    <div class="card tight">
      <div class="verdict-row">
        ${g.points !== null ? `<span class="score">${round1(g.points)}<span class="dim" style="font-size:1rem"> / 25</span></span>` : ''}
        <span class="pill ${tone}">${esc(g.band || '')}</span>
        ${wpm ? `<span class="pill">${wpm} Wörter/Min.</span>` : ''}
      </div>
      <table class="plain">
        <thead><tr><th>Kriterium</th><th class="num">Urteil</th></tr></thead>
        <tbody>
          ${g.criteria.map((c) => `<tr>
            <td>${esc(c.key)}<div class="dim small">${esc(c.comment)}</div></td>
            <td class="num">${c.score === null ? '<span class="dim">–</span>' : Math.round(c.score)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${g.betterPhrases?.length ? `<div class="mt"><h4>So klingt es besser</h4>
        ${g.betterPhrases.map((b) => `<div class="correction"><div><span class="orig">${esc(b.said)}</span> → <span class="corr">${esc(b.better)}</span></div></div>`).join('')}
      </div>` : ''}
      ${g.corrections?.length ? `<div class="mt"><h4>Sprachliche Korrekturen</h4>
        ${g.corrections.map((c) => `<div class="correction"><div><span class="orig">${esc(c.original)}</span> → <span class="corr">${esc(c.corrected)}</span></div>${c.explanation ? `<div class="why">${esc(c.explanation)}</div>` : ''}</div>`).join('')}
      </div>` : ''}
      ${g.strengths?.length ? `<div class="mt"><h4>Stärken</h4><ul class="muted small" style="margin:0 0 0 18px;padding:0">${g.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${g.priorities?.length ? `<div class="mt"><h4>Nächste Schritte</h4><ul class="muted small" style="margin:0 0 0 18px;padding:0">${g.priorities.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    </div>`;
}

/* ============================================================== mock exam */

const MOCK_BLOCKS = [
  { id: 'b1', title: 'Leseverstehen + Sprachbausteine', minutes: 90, parts: ['LV1', 'LV2', 'LV3', 'SB1', 'SB2'], note: 'Keine Pause zwischen Lesen und Sprachbausteinen – genau wie in der Prüfung.' },
  { id: 'b2', title: 'Hörverstehen', minutes: 30, parts: ['HV1', 'HV2', 'HV3'], note: 'Am Ende wird das Antwortblatt sofort eingesammelt – es gibt keine Übertragungszeit.' },
  { id: 'b3', title: 'Schreiben', minutes: 30, parts: ['SA1'], note: 'Eine informelle oder halbformelle E-Mail mit vier Leitpunkten.' },
];

let mockState = null;
let mockCleanup = null;
let mockPreparation = 0;

export async function mockView(el, params = {}) {
  if (!mockState || params.nonce) {
    renderMockIntro(el);
    return;
  }
  if (mockState.phase === 'exam') return renderMockBlock(el);
  if (mockState.phase === 'done') return renderMockResult(el);
  renderMockIntro(el);
}

function renderMockIntro(el) {
  setViewActions('');
  el.innerHTML = `
    <div class="card">
      <h3>Mocktest – schriftliche Übung</h3>
      <p class="muted">150 Minuten Übungszeit: Leseverstehen + Sprachbausteine (90 Min.), Hörverstehen (30 Min.), Schreiben (30 Min.).</p>
      <p class="muted small">
        Objektive Aufgaben werden anhand der hinterlegten Lösungen ausgewertet. Schreibfeedback ist vorläufig.
        Diese Übung liefert keine Bestehensprognose; Aufgaben und Hörmaterial sind noch nicht abschließend fachlich geprüft.
      </p>
      <table class="plain mt">
        <thead><tr><th>Block</th><th>Teile</th><th class="num">Zeit</th></tr></thead>
        <tbody>
          ${MOCK_BLOCKS.map((b) => `<tr><td>${esc(b.title)}</td><td>${b.parts.map((p) => esc(p)).join(', ')}</td><td class="num">${b.minutes} Min.</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="btn-row mt">
        <button class="primary" data-start-mock>Mocktest starten</button>
      </div>
      <div class="dim small mt">Dein Schreibtext bleibt während dieser Sitzung verfügbar. Wiederherstellung nach Neuladen ist hier noch nicht verfügbar.</div>
    </div>
    ${!ai.isConfigured() ? `<div class="card" style="border-color:var(--warn-dim)">
      <h3>Hinweis zum Offline-Modus</h3>
      <p class="muted small">Ohne API-Schlüssel werden für die neun Teile Aufgaben aus der eingebauten Sammlung verwendet. Das funktioniert, aber jeder Mocktest sieht dann ähnlich aus.</p>
    </div>` : ''}
    ${!ttsSupported() ? `<div class="card" style="border-color:var(--warn-dim)">
      <h3>Keine Sprachausgabe</h3>
      <p class="muted small">Der Hörverstehen-Block braucht eine deutsche Stimme. Ohne sie werden die Transkripte angezeigt statt vorgelesen.</p>
    </div>` : ''}
  `;
  on(el.querySelector('[data-start-mock]'), 'click', startMock);
}

async function startMock() {
  const preparation = ++mockPreparation;
  const el = document.getElementById('view');
  const allParts = MOCK_BLOCKS.flatMap((b) => b.parts);
  const total = allParts.length;
  let done = 0;

  busy('Mocktest wird vorbereitet…', `0 / ${total} Teile`);
  const results = await Promise.all(
    allParts.map((partId) => {
      // Schreiben has its own task generator rather than a paper set.
      const work = partId === 'SA1'
        ? ai.nextWritingTask({ difficulty: engine.PART_DIFFICULTY.SA1 })
        : ai.genSet(partId, { difficulty: engine.PART_DIFFICULTY[partId] });
      return work
        .then((set) => {
          done += 1;
          busyUpdate('Mocktest wird vorbereitet…', `${done} / ${total} Teile erstellt`);
          return [partId, set];
        })
        .catch(() => {
          done += 1;
          busyUpdate('Mocktest wird vorbereitet…', `${done} / ${total} Teile erstellt`);
          return [partId, null];
        });
    })
  );
  if (preparation !== mockPreparation) return;
  unbusy();

  const sets = Object.fromEntries(results.filter(([, s]) => s));
  const missing = allParts.filter((p) => !sets[p]);
  if (missing.length) toast(`Diese Teile konnten nicht erstellt werden: ${missing.join(', ')}`, 'warn', 7000);

  mockState = {
    phase: 'exam',
    blockIndex: 0,
    sets,
    answers: {},
    blockResults: [],
    startedAt: Date.now(),
    missing,
  };
  renderMockBlock(el);
}

function renderMockBlock(el) {
  mockCleanup?.();
  const session = mockState;
  const index = session.blockIndex;
  const block = MOCK_BLOCKS[index];
  const sets = session.sets;
  const available = block.parts.filter((p) => sets[p]);

  setViewActions(`<span class="pill">Block ${mockState.blockIndex + 1} / ${MOCK_BLOCKS.length}</span>`);

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">${esc(block.title)}</h2>
          <div class="dim small">${esc(block.note)}</div>
        </div>
        <span class="timer" id="mock-timer">${fmtClock(block.minutes * 60)}</span>
      </div>
      <div class="btn-row mt">
        <button class="primary" data-toggle-mock>Zeit starten</button>
        <button data-end-block>Block abgeben</button>
      </div>
    </div>
    <div id="mock-parts"></div>
  `;

  const partsHost = el.querySelector('#mock-parts');
  for (const partId of available) {
    const wrap = document.createElement('div');
    wrap.dataset.mockPart = partId;
    partsHost.appendChild(wrap);
    if (partId === 'SA1') {
      renderMockWriting(wrap, sets[partId], session.writingText || '');
      continue;
    }
    renderPartInto(wrap, partId, sets[partId], { mock: true });
    // In the mock the per-part submit button must not score anything.
    const submitCard = wrap.querySelector('#part-submit');
    if (submitCard) submitCard.remove();
  }

  /* block timer */
  let remaining = block.minutes * 60;
  let handle = null;
  const timerEl = el.querySelector('#mock-timer');
  const stop = () => {
    if (handle) clearInterval(handle);
    handle = null;
  };
  mockCleanup = () => {
    stop();
    const textarea = partsHost.querySelector('#mock-writing');
    if (textarea) session.writingText = textarea.value;
  };
  if (session.completionIndex !== index) {
    session.completionIndex = index;
    session.completeBlock = createCompletionGate();
  }
  on(el.querySelector('[data-toggle-mock]'), 'click', (e) => {
    if (handle) {
      stop();
      e.target.textContent = 'Zeit fortsetzen';
      return;
    }
    e.target.textContent = 'Pause';
    handle = setInterval(() => {
      remaining -= 1;
      timerEl.textContent = fmtClock(remaining);
      timerEl.classList.toggle('low', remaining <= 300 && remaining > 0);
      if (remaining <= 0) {
        stop();
        beep('end');
        timerEl.classList.add('out');
        toast('Zeit für diesen Block ist um. Bitte abgeben.', 'warn', 8000);
        endBlock(block);
      }
    }, 1000);
  });

  on(el.querySelector('[data-end-block]'), 'click', async (e) => {
    e.target.disabled = true;
    stop();
    await endBlock(block);
  });

  async function endBlock(b) {
    stop();
    stopSpeaking();
    const endBtn = el.querySelector('[data-end-block]');
    const toggleBtn = el.querySelector('[data-toggle-mock]');
    if (endBtn) endBtn.disabled = true;
    if (toggleBtn) toggleBtn.disabled = true;
    return session.completeBlock({
      isCurrent: () => mockState === session && session.phase === 'exam' && session.blockIndex === index,
      collect: async () => {
        const entries = [];
        for (const partId of available) {
          const wrap = partsHost.querySelector(`[data-mock-part="${partId}"]`);
          if (partId === 'SA1') {
            const textarea = wrap.querySelector('#mock-writing');
            session.writingText = textarea.value;
            textarea.readOnly = true;
            // A local indicator cannot cover a later view while feedback is pending.
            wrap.insertAdjacentHTML('beforeend', '<div class="card muted" role="status">Schreibfeedback wird angefragt…</div>');
            entries.push(await gradeMockWriting(wrap, sets[partId]));
          } else {
            entries.push(scoreSet(partId, sets[partId], collectFromDom(partId, sets[partId], wrap)));
          }
        }
        return entries;
      },
      commit: (entries) => {
        for (const entry of entries) {
          if (entry.partId === 'SA1') {
            // Only provisional AI feedback feeds the error notebook, and only when the
            // block result is actually committed. The offline heuristic checks are
            // deliberately NOT recorded as assessed writing outcomes - that was the defect.
            if (entry.status === 'provisional' && entry.aiResult) {
              for (const corr of entry.aiResult.corrections.slice(0, 10)) {
                store.addError({
                  partId: 'SA1', tags: ['sa_grammatik'], difficulty: engine.PART_DIFFICULTY.SA1,
                  prompt: corr.original, yourAnswer: corr.original, correctAnswer: corr.corrected,
                  explanation: corr.explanation, source: 'mock',
                });
              }
            }
            continue;
          }
          recordSetAttempts(entry.partId, sets[entry.partId], entry, 'mock');
        }
        session.blockResults.push(...entries);
        session.blockIndex += 1;
        if (session.blockIndex >= MOCK_BLOCKS.length) {
          session.phase = 'done';
          session.finishedAt = Date.now();
        }
        if (partsHost.isConnected) navigate('mock', {});
      },
    });
  }
}

function renderMockWriting(wrap, task, text = '') {
  wrap.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Schreiben · Brief/E-Mail</h3>
          <div class="dim small">45 Punkte · ca. 80–120 Wörter</div>
        </div>
        <span class="pill">Teil der schriftlichen Prüfung</span>
      </div>
    </div>
    <div class="card">
      <h4>Aufgabe</h4>
      <p>${esc(task.situation)}</p>
      <p class="small muted">Adressat: ${esc(task.adressat)} · Register: <b>${task.register === 'du' ? 'informell · du' : 'halbformell · Sie'}</b></p>
      <h4 class="mt">Leitpunkte</h4>
      <ol class="muted" style="margin:0 0 0 18px;padding:0">
        ${task.leitpunkte.map((l) => `<li>${esc(l)}</li>`).join('')}
      </ol>
      <textarea id="mock-writing" class="mt" style="min-height:220px" placeholder="Schreibe hier deinen Brief…">${esc(text)}</textarea>
      <div class="dim small mt" id="mock-writing-count">0 Wörter</div>
    </div>`;
  const ta = wrap.querySelector('#mock-writing');
  const count = wrap.querySelector('#mock-writing-count');
  const updateCount = () => {
    const n = ta.value.trim().split(/\s+/).filter(Boolean).length;
    count.textContent = `${n} Wörter${n >= 80 ? ' · im Zielbereich' : ' · Ziel ab 80'}`;
  };
  on(ta, 'input', updateCount);
  updateCount();
}

/** Preserve the submission even when provisional feedback is unavailable. */
async function gradeMockWriting(wrap, task) {
  const text = wrap.querySelector('#mock-writing')?.value || '';
  const analysis = engine.analyseWriting(text, task);
  return assessMockWriting({ text, task, analysis, configured: ai.isConfigured(), grade: ai.gradeWriting });
}

/** Read whatever is currently in the DOM for a part. */
function collectFromDom(partId, set, root) {
  const answers = {};
  const kind = PARTS[partId].kind;
  if (kind === 'mc3_text') {
    $$('[data-q]', root).forEach((btn) => {
      if (btn.classList.contains('correct')) answers[btn.dataset.q] = btn.dataset.opt;
    });
  } else if (kind === 'truefalse') {
    $$('[data-tf]', root).forEach((wrap) => {
      const n = wrap.dataset.tf;
      const plus = wrap.querySelector('.on-plus');
      const minus = wrap.querySelector('.on-minus');
      if (plus) answers[n] = 'true';
      else if (minus) answers[n] = 'false';
    });
  } else {
    $$('select[data-item], select[data-gap]', root).forEach((sel) => {
      const key = sel.dataset.item || sel.dataset.gap;
      if (sel.value) answers[key] = sel.value;
    });
  }
  return answers;
}

function renderMockResult(el) {
  // Objective parts only. Schreiben is rubric/feedback, never right-wrong, and an
  // unassessed text must not be folded in as a zero.
  const card = engine.emptyScorecard();
  for (const r of mockState.blockResults) {
    if (r.rubric) continue;
    if (!card[r.partId]) card[r.partId] = { correct: 0, total: 0 };
    card[r.partId].correct += r.correct;
    card[r.partId].total += r.total;
  }
  const scored = engine.scorecardToPoints(card);
  const summary = summarizeMockOutcome(mockState.blockResults);
  const writingEntry = mockState.blockResults.find((r) => r.rubric) || null;
  const writing = summary.writing;
  const objectiveMax = GROUPS.filter((g) => g.mode === 'written' && g.id !== 'SA').reduce((s, g) => s + g.pts, 0);
  const objectivePoints = summary.objective.parts.reduce((s, p) => s + engine.pointsFor(p.partId, p.correct, p.total), 0);
  const minutes = Math.round((mockState.finishedAt - mockState.startedAt) / 60000);
  const writingReason = writing ? (WRITING_REASONS[writing.reason] || 'nicht bewertet') : '';

  const actions = setViewActions(`<button data-new-mock>Neuer Mocktest</button>`);
  // #view-actions is a sibling of #view, not a child: query it through the element
  // setViewActions returns, otherwise the button would never receive a handler.
  on(actions?.querySelector('[data-new-mock]'), 'click', () => {
    mockState = null;
    navigate('mock', { nonce: Date.now() });
  });

  el.innerHTML = `
    <div class="card">
      <h2>Mocktest – Ergebnis (Übung)</h2>
      <div class="grid four mt">
        ${statCard('Objektive Punkte', `${round1(objectivePoints)}<span class="dim" style="font-size:.9rem"> / ${objectiveMax}</span>`, '<span class="dim">LV · SB · HV</span>')}
        ${statCard('Richtig', `${summary.objective.correct} / ${summary.objective.total}`, '')}
        ${statCard('Schreiben', writing ? (writing.status === 'provisional' ? `${round1(writing.points)}<span class="dim" style="font-size:.9rem"> / ${writing.max}</span>` : '<span class="dim" style="font-size:.9rem">nicht bewertet</span>') : '—', writing ? `<span class="pill ${writing.status === 'provisional' ? 'warn' : ''}">${esc(writing.status === 'provisional' ? 'vorläufig' : 'unbewertet')}</span>` : '')}
        ${statCard('Dauer', `${minutes} Min.`, '<span class="dim">inkl. Pausen</span>')}
      </div>
      <div class="dim small mt">
        Ausgewertet werden nur die objektiven Teile (Leseverstehen, Sprachbausteine, Hörverstehen) mit
        ${objectiveMax} Punkten. Diese Übung zeigt bewusst <b>kein Bestanden/Nicht bestanden und keine Gesamtnote</b>:
        Sprechen ist hier nicht geprüft und Schreibfeedback ist vorläufig – ein Gesamtergebnis lässt sich daraus nicht berechnen.
      </div>
    </div>

    <div class="card">
      <h3>Ergebnis pro Prüfungsteil</h3>
      <table class="plain">
        <thead><tr><th>Teil</th><th class="num">Richtig</th><th class="num">Punkte</th><th class="num">Quote</th></tr></thead>
        <tbody>
          ${SUBTEST_ORDER.filter((id) => card[id]?.total).map((id) => {
            const e = scored.byPart[id];
            const q = e.rubric ? (e.points / e.max) * 100 : (e.correct / e.total) * 100;
            return `<tr>
              <td><span class="dim small">${esc(groupOf(id).name)}</span><br>${esc(PARTS[id].label)}</td>
              <td class="num">${e.rubric ? '<span class="dim">Bewertung</span>' : `${e.correct} / ${e.total}`}</td>
              <td class="num">${round1(e.points)} / ${e.max}</td>
              <td class="num" style="color:${q >= 70 ? 'var(--good)' : q >= 55 ? 'var(--warn)' : 'var(--bad)'}">${pct(q)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    ${writingEntry ? `
    <div class="card">
      <h3>Schreiben</h3>
      <div class="btn-row mb">
        ${writing.status === 'provisional'
          ? `<span class="pill warn">vorläufig · ${round1(writing.points)} / ${writing.max} Punkte</span>`
          : '<span class="pill">nicht bewertet · kein Punktwert</span>'}
        ${writingEntry.analysis ? `<span class="pill">${writingEntry.analysis.words} Wörter</span>` : ''}
      </div>
      ${writing.status === 'provisional'
        ? '<p class="muted small">Vorläufige KI-Einschätzung, kein Prüfungsergebnis. Sie zählt nicht zu den objektiven Punkten und ist nicht fachlich freigegeben.</p>'
        : `<p class="muted small">Nicht bewertet (${esc(writingReason)}). Der Text bleibt erhalten und wird nicht als 0 Punkte gezählt.</p>`}
      ${writing.hasText ? `<div class="passage mt">${esc(writing.text)}</div>` : '<p class="dim small mt">Kein Text abgegeben.</p>'}
      ${writingEntry.analysis?.checks?.length ? `
        <details class="disclosure mt"><summary>Automatische Textmerkmale (keine Bewertung)</summary>
          <table class="plain"><tbody>
            ${writingEntry.analysis.checks.map((c) => `<tr>
              <td style="width:26px;color:${c.ok ? 'var(--good)' : 'var(--bad)'}">${c.ok ? '✓' : '✗'}</td>
              <td>${esc(c.label)}</td>
            </tr>`).join('')}
          </tbody></table>
        </details>` : ''}
      ${writing.status === 'provisional' && writingEntry.aiResult?.corrections?.length ? `
        <h4 class="mt">Korrekturen</h4>
        ${writingEntry.aiResult.corrections.slice(0, 8).map((c) => `<div class="correction">
          <div><span class="orig">${esc(c.original)}</span> → <span class="corr">${esc(c.corrected)}</span></div>
          ${c.explanation ? `<div class="why">${esc(c.explanation)}</div>` : ''}
        </div>`).join('')}` : ''}
      ${writing.status === 'provisional' && writingEntry.aiResult?.modelAnswer ? `
        <details class="disclosure mt"><summary>Musterbrief</summary><div class="passage">${esc(writingEntry.aiResult.modelAnswer)}</div></details>` : ''}
    </div>` : ''}

    <div class="card">
      <h3>Antworten durchsehen</h3>
      <p class="muted small">
        Die Auswertung eines Mocktests ist der eigentliche Lernschritt: jede Aufgabe mit deiner Antwort,
        der richtigen Lösung und der Begründung. Auch die, die du richtig hattest – prüfe, ob du sie
        wirklich verstanden hast oder nur geraten.
      </p>
      ${SUBTEST_ORDER.filter((id) => card[id]?.total).map((id) => {
        const r = mockState.blockResults.find((x) => x.partId === id);
        if (!r || !r.items?.length) return '';
        return `<details class="disclosure">
          <summary>${esc(PARTS[id].label)} — ${r.correct} / ${r.total} richtig</summary>
          ${r.items.map((it) => `
            <div class="item-block">
              <div class="btn-row" style="justify-content:space-between">
                <b><span class="item-num">${esc(it.n)}</span>${esc(String(it.prompt).slice(0, 170))}</b>
                <span class="pill ${it.correct ? 'good' : 'bad'}">${it.correct ? 'richtig' : 'falsch'}</span>
              </div>
              ${!it.correct ? `<div class="small mt"><span style="color:var(--bad)">Deine Antwort: ${esc(it.given || '– keine –')}</span> · <span style="color:var(--good)">Richtig: ${esc(it.expected)}</span></div>` : ''}
              ${it.explanation ? `<div class="dim small mt">${esc(it.explanation)}</div>` : ''}
            </div>`).join('')}
        </details>`;
      }).join('')}
      ${writingEntry?.text ? `<details class="disclosure"><summary>Schreiben — dein Text</summary><div class="passage">${esc(writingEntry.text)}</div></details>` : ''}
    </div>

    <div class="card">
      <h3>Was jetzt zählt</h3>
      <p class="muted small">Alle Fehler sind im Heft. Der Trainer gewichtet ab jetzt die Teile, in denen du die meisten Punkte liegen lässt.</p>
      <div class="grid two mt">
        <div>
          <h4>Schwächste Teile</h4>
          ${store.weakNodes({ limit: 4, prefix: 'skill:' }).map((w) => `<div class="small">${esc(PARTS[w.id.slice(6)]?.label || w.id)} <span class="dim">· ${Math.round(w.mastery)}</span></div>`).join('') || '<span class="dim small">keine Daten</span>'}
        </div>
        <div>
          <h4>Schwächste Themen</h4>
          <div class="btn-row">${store.weakNodes({ limit: 6, prefix: 'tag:' }).map((w) => `<span class="tag-chip weak">${esc(tagInfo(w.id.slice(4)).label)}</span>`).join('') || '<span class="dim small">keine Daten</span>'}</div>
        </div>
      </div>
      <div class="btn-row mt">
        <button class="primary" data-drill>Schwächen üben</button>
        <button data-notebook>Fehlerheft (${store.listErrors().length})</button>
        <button data-home>Zur Übersicht</button>
      </div>
    </div>
  `;

  on(el.querySelector('[data-drill]'), 'click', () => navigate('drill', { size: 15 }));
  on(el.querySelector('[data-notebook]'), 'click', () => navigate('notebook'));
  on(el.querySelector('[data-home]'), 'click', () => navigate('home'));
}

/** Called when leaving a view so audio and timers never outlive it. */
export function teardownExamViews() {
  mockCleanup?.();
  mockCleanup = null;
  writingRender += 1; // a late AI response must not replace another view
  speakingRender += 1;
  stopSpeaking();
  if (writingTimer) {
    writingTimer();
    writingTimer = null;
  }
}
