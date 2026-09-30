/**
 * Reference areas: Sprechen, Schreiben and Grammatik.
 *
 * These are read-only study pages. Nothing here is scored or tested, and none of it
 * needs an API key - the point is to have the phrases, patterns and worked examples in
 * front of you, with a speaker button on anything German you might want to hear.
 */

import { esc, $, $$, on, delegate, navigate, setViewActions, spinnerRow, spinnerWithTimer } from './shell.js';
import * as store from './store.js';
import * as ai from './ai.js';
import { speak, ttsSupported } from './speech.js';
import { analyseSentence } from './satzbau.js';

/** A speaker button for any German string, when the browser can speak. */
function sayButton(text, label = '') {
  if (!ttsSupported()) return '';
  return `<button class="sm" data-say="${esc(text)}" title="Vorlesen">🔊${label ? ` ${esc(label)}` : ''}</button>`;
}

function speakOpts() {
  const s = store.getState().settings;
  return { rate: s.ttsRate || 0.95, voiceName: s.voiceName };
}

/** Shared renderer for a group of phrases, each with a full example sentence. */
function phraseGroups(groups) {
  return (groups || [])
    .map(
      (g) => `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <h4 style="margin:0">${esc(g.group)}${g.groupEn ? `<span class="dim small"> · ${esc(g.groupEn)}</span>` : ''}</h4>
        <span class="dim small">${g.items.length} Wendungen</span>
      </div>
      ${g.hint ? `<div class="dim small">${esc(g.hint)}</div>` : ''}
      ${g.hintEn ? `<div class="dim small">${esc(g.hintEn)}</div>` : ''}
      <table class="plain mt">
        <tbody>
          ${g.items
            .map(
              (it) => `<tr>
              <td>
                <div><b>${esc(it.de)}</b>${it.en ? ` <span class="dim small">– ${esc(it.en)}</span>` : ''}</div>
                <div class="muted small" style="margin-top:2px">${esc(it.example)}</div>
              </td>
              <td class="num" style="width:48px">${sayButton(it.example)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`
    )
    .join('');
}

function emptyGuide(name, file) {
  return `<div class="empty"><h3>${esc(name)} nicht gefunden</h3>
    <p class="muted"><span class="mono">${esc(file)}</span> fehlt oder ist leer.</p></div>`;
}

/* ============================================================ Nachschlagen */

/**
 * The index for every reference area.
 *
 * Before this existed, each reference was its own sidebar entry, which made the
 * navigation grow every time another one was added. They now sit behind a single
 * "Nachschlagen" item and are opened from here or from the practice view that needs
 * them, each with a way back to this page.
 */
export async function referenceHubView(el) {
  const [speaking, writing, cases, grammar, gender, nouns] = await Promise.all([
    ai.loadSpeakingGuide(),
    ai.loadWritingGuide(),
    ai.loadCasesGuide(),
    ai.loadGrammarGuide(),
    ai.loadGenderRules(),
    ai.loadNounLexicon(),
  ]);

  const count = (arr, fn) => (Array.isArray(arr) ? arr.reduce(fn, 0) : 0);

  const areas = [
    {
      id: 'speakingguide',
      ico: '💬',
      title: 'Redemittel Sprechen',
      what: 'Wie du jeden mündlichen Teil angehst, welche Wendungen du benutzen kannst und wie vollständige Antworten aussehen.',
      stat: speaking.length
        ? `${count(speaking, (n, p) => n + count(p.phrases, (m, g) => m + g.items.length, 0), 0)} Wendungen · ${count(speaking, (n, p) => n + (p.examples?.length || 0), 0)} Musterantworten · ${speaking.length} Teile`
        : 'fehlt',
      ready: speaking.length > 0,
    },
    {
      id: 'writingguide',
      ico: '📨',
      title: 'Briefe schreiben',
      what: 'Die sechs Entscheidungen, die Punkte kosten oder bringen, alle Bausteine und vier vollständige Musterbriefe.',
      stat: writing
        ? `${count(writing.sections, (n, s) => n + s.points.length, 0)} Hinweise · ${count(writing.phrases, (n, g) => n + g.items.length, 0)} Bausteine · ${writing.examples.length} Musterbriefe`
        : 'fehlt',
      ready: Boolean(writing),
    },
    {
      id: 'casesguide',
      ico: '🔤',
      title: 'Fälle & Artikel',
      what: 'der/die/das in allen vier Fällen, Pronomen, Adjektivendungen, n-Deklination und welches Wort welchen Fall verlangt.',
      stat: cases ? `${cases.tables.length} Tabellen · ${cases.triggers.length} Fall-Auslöser · ${cases.examples.length} Beispiele` : 'fehlt',
      ready: Boolean(cases),
    },
    {
      id: 'nounsguide',
      ico: '📚',
      title: 'Nomen & Genus',
      what: 'Das Genus-Lexikon: Regeln nach Endung und Bedeutung, die wichtigen Ausnahmen und 240 Nomen zum Nachschlagen und Üben.',
      stat:
        nouns.length || gender
          ? `${nouns.length} Nomen · ${gender ? gender.exceptions.length : 0} Ausnahmen · ${gender ? gender.doubleGender.length : 0} Wörter mit zwei Genus`
          : 'fehlt',
      ready: nouns.length > 0 || Boolean(gender),
    },
    {
      id: 'grammarguide',
      ico: '📖',
      title: 'Grammatik',
      what: 'Regel, Muster, Tabellen und Beispiele zu den 14 Themen, die in der Prüfung am häufigsten vorkommen.',
      stat: grammar.length
        ? `${grammar.length} Themen · ${count(grammar, (n, t) => n + t.examples.length, 0)} Beispiele · ${count(grammar, (n, t) => n + (t.table ? 1 : 0), 0)} Tabellen`
        : 'fehlt',
      ready: grammar.length > 0,
    },
    {
      id: 'sentenceguide',
      ico: '🧩',
      title: 'Satzbau verstehen',
      what: 'Schreib einen Satz und sieh sofort, wie er gebaut ist: wo das Verb steht, warum dort, und was sich ändern muss.',
      stat: 'interaktiv · Erklärung in Echtzeit',
      ready: true,
    },
  ];

  const ready = areas.filter((a) => a.ready).length;

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Nachschlagen</h3>
          <div class="dim small">${ready} Bereiche · alles zum Lesen, nichts wird abgefragt</div>
        </div>
        <span class="pill good">ohne API-Schlüssel nutzbar</span>
      </div>
      <p class="muted mt">
        Diese Bereiche sind zum Blättern und Nachsehen gedacht: Wendungen, Tabellen, Regeln und
        vollständige Beispiele. Es gibt keine Aufgaben und keine Bewertung.
      </p>
      <p class="dim small">
        Zum Üben geh in die Prüfungsteile oder in die Adaptiven Übungen – die Aufgaben dort richten sich
        nach deinen Schwächen.
      </p>
    </div>

    <div class="grid two">
      ${areas
        .map(
          (a) => `<div class="card"${a.ready ? '' : ' style="opacity:.55"'}>
        <div class="btn-row" style="justify-content:space-between">
          <h3 style="margin:0">${a.ico} ${esc(a.title)}</h3>
        </div>
        <p class="muted small">${esc(a.what)}</p>
        <div class="btn-row" style="justify-content:space-between">
          <span class="dim small">${esc(a.stat)}</span>
          <button class="${a.ready ? 'primary' : ''}" data-open-area="${esc(a.id)}" ${a.ready ? '' : 'disabled'}>Öffnen</button>
        </div>
      </div>`
        )
        .join('')}
    </div>
  `;

  delegate(el, 'click', '[data-open-area]', (e, t) => navigate(t.dataset.openArea, { from: 'reference' }));
}

/* ==================================================================== Sprechen */

export async function speakingGuideView(el, params = {}) {
  const guide = await ai.loadSpeakingGuide();
  if (!guide.length) {
    el.innerHTML = emptyGuide('Sprech-Leitfaden', 'data/speaking-guide.json');
    return;
  }

  const active = guide.find((p) => p.id === params.partId) || guide[0];
  const phraseCount = (p) => p.phrases.reduce((n, g) => n + g.items.length, 0);

  setViewActions(
    `<div class="btn-row">${guide
      .map((p) => `<button class="${p.id === active.id ? 'primary' : ''}" data-guide-part="${esc(p.id)}">${esc(p.title)}</button>`)
      .join('')}</div>`
  );
  const actionsEl = document.getElementById('view-actions');
  $$('[data-guide-part]', actionsEl).forEach((btn) => {
    on(btn, 'click', () => navigate('speakingguide', { partId: btn.dataset.guidePart }));
  });

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">${esc(active.title)}</h3>
          ${active.titleEn ? `<div class="dim small">${esc(active.titleEn)}</div>` : ''}
          <div class="dim small">ca. ${esc(String(active.minutes))} Minuten · ${phraseCount(active)} Wendungen · ${active.examples?.length || 0} Musterantworten</div>
        </div>
        <span class="pill">Nachschlagen, nicht abgefragt</span>
      </div>
      <p class="muted mt">${esc(active.summary)}</p>
      ${active.summaryEn ? `<p class="dim small">${esc(active.summaryEn)}</p>` : ''}
      <p class="dim small">Hier wird nichts bewertet. Lies die Wendungen, hör sie dir an und bau sie in deine eigene Antwort ein.</p>
    </div>

    <div class="card">
      <h4>So gehst du vor</h4>
      <table class="plain">
        <tbody>
          ${(active.approach || [])
            .map(
              (s, i) => `<tr>
            <td style="width:30px" class="dim">${i + 1}</td>
            <td><b>${esc(s.step)}</b> <span class="dim small">· ca. ${esc(String(s.seconds))} Sek.</span>
              ${s.stepEn ? `<div class="dim small">${esc(s.stepEn)}</div>` : ''}
              <div class="muted small">${esc(s.detail)}</div>
              ${s.detailEn ? `<div class="dim small">${esc(s.detailEn)}</div>` : ''}</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    ${phraseGroups(active.phrases)}

    ${active.examples?.length ? `
      <div class="card">
        <h4>Musterantworten</h4>
        <p class="dim small">Zwei vollständige Beispiele zu verschiedenen Themen. Lies sie einmal laut vor.</p>
        ${active.examples
          .map(
            (ex) => `<details class="disclosure mt">
          <summary>${esc(ex.topic)}${ex.topicEn ? `<span class="dim small"> · ${esc(ex.topicEn)}</span>` : ''}</summary>
          <div class="passage">${esc(ex.text)}</div>
          <div class="btn-row mt">${sayButton(ex.text, 'Ganzen Text vorlesen')}</div>
        </details>`
          )
          .join('')}
      </div>` : ''}

    ${active.watchOut?.length ? `
      <div class="card">
        <h4>Typische Fehler in diesem Teil</h4>
        <ul class="muted small" style="margin:0 0 0 18px;padding:0">${active.watchOut.map((w, i) => `<li>${esc(w)}${active.watchOutEn?.[i] ? `<div class="dim">${esc(active.watchOutEn[i])}</div>` : ''}</li>`).join('')}</ul>
      </div>` : ''}

    <div class="card">
      <div class="btn-row"><button class="primary" data-practice="${esc(active.id)}">Diesen Teil jetzt üben</button></div>
    </div>
  `;

  delegate(el, 'click', '[data-say]', (e, t) => speak(t.dataset.say, speakOpts()));
  delegate(el, 'click', '[data-practice]', (e, t) => navigate('speaking', { partId: t.dataset.practice, nonce: Date.now() }));
}

/* =================================================================== Schreiben */

export function contrastRow(p) {
  if (!p.good && !p.bad) return '';
  return `<div class="grid two mt" style="gap:8px">
    ${p.good ? `<div class="feedback ok" style="margin:0"><div class="why"><b>Gut:</b> ${esc(p.good)}</div></div>` : ''}
    ${p.bad ? `<div class="feedback no" style="margin:0"><div class="why"><b>Nicht so:</b> ${esc(p.bad)}</div></div>` : ''}
  </div>`;
}

export async function writingGuideView(el) {
  const guide = await ai.loadWritingGuide();
  if (!guide) {
    el.innerHTML = emptyGuide('Schreib-Leitfaden', 'data/writing-guide.json');
    return;
  }

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Brief und E-Mail schreiben</h3>
          <div class="dim small">
            ${guide.sections.length} Bereiche · ${guide.phrases.reduce((n, g) => n + g.items.length, 0)} Wendungen ·
            ${guide.examples.length} Musterbriefe · 45 Punkte, ca. 30 Minuten
          </div>
        </div>
        <span class="pill">Nachschlagen, nicht abgefragt</span>
      </div>
      <p class="dim small">
        Hier wird nichts bewertet. Die wichtigsten Entscheidungen sind unten erklärt, die Bausteine kannst du
        direkt übernehmen, und die Musterbriefe zeigen, wie ein vollständiger Brief aussieht.
      </p>
    </div>

    ${guide.sections
      .map(
        (s) => `
      <div class="card">
        <h4>${esc(s.title)}</h4>
        ${s.titleEn ? `<div class="dim small">${esc(s.titleEn)}</div>` : ''}
        <div class="dim small">${esc(s.why)}</div>
        ${s.whyEn ? `<div class="dim small">${esc(s.whyEn)}</div>` : ''}
        ${s.points
          .map(
            (p) => `<div class="item-block">
          <b>${esc(p.idea)}</b>
          ${p.ideaEn ? `<div class="dim small">${esc(p.ideaEn)}</div>` : ''}
          <div class="muted small">${esc(p.detail)}</div>
          ${p.detailEn ? `<div class="dim small">${esc(p.detailEn)}</div>` : ''}
          ${contrastRow(p)}
        </div>`
          )
          .join('')}
      </div>`
      )
      .join('')}

    ${phraseGroups(guide.phrases)}

    <div class="card">
      <h4>Musterbriefe</h4>
      <p class="dim small">Vier vollständige Briefe zu den häufigsten Anlässen. Jeder deckt seine vier Leitpunkte ab.</p>
      ${guide.examples
        .map(
          (ex) => `<details class="disclosure mt">
        <summary>${esc(ex.type)}${ex.typeEn ? ` (${esc(ex.typeEn)})` : ''} — ${esc(ex.situation)}</summary>
        ${ex.situationEn ? `<div class="dim small">${esc(ex.situationEn)}</div>` : ''}
        <div class="btn-row mt">
          ${ex.leitpunkte.map((l, i) => `<span class="tag-chip">${esc(l)}${ex.leitpunkteEn?.[i] ? `<div class="dim">${esc(ex.leitpunkteEn[i])}</div>` : ''}</span>`).join('')}
        </div>
        <div class="passage mt">${esc(ex.text)}</div>
        <div class="btn-row mt">${sayButton(ex.text, 'Brief vorlesen')}</div>
      </details>`
        )
        .join('')}
    </div>

    <div class="card">
      <h4>Checkliste vor der Abgabe</h4>
      <table class="plain">
        <tbody>
          ${guide.checklist.map((c, i) => `<tr><td style="width:26px">☐</td><td>${esc(c)}${guide.checklistEn?.[i] ? `<div class="dim small">${esc(guide.checklistEn[i])}</div>` : ''}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h4>Typische Fehler</h4>
      <ul class="muted small" style="margin:0 0 0 18px;padding:0">${guide.watchOut.map((w, i) => `<li>${esc(w)}${guide.watchOutEn?.[i] ? `<div class="dim">${esc(guide.watchOutEn[i])}</div>` : ''}</li>`).join('')}</ul>
    </div>

    <div class="card">
      <div class="btn-row">
        <button class="primary" data-goto-writing>Jetzt einen Brief schreiben</button>
      </div>
    </div>
  `;

  delegate(el, 'click', '[data-say]', (e, t) => speak(t.dataset.say, speakOpts()));
  delegate(el, 'click', '[data-goto-writing]', () => navigate('writing'));
}

/* ============================================================== Fälle & Artikel */

/** English gloss for the German grammar terms that head a row or column. */
const GRAMMAR_EN = {
  Nominativ: 'nominative',
  Akkusativ: 'accusative',
  Dativ: 'dative',
  Genitiv: 'genitive',
  Wechsel: 'two-way',
  maskulin: 'masculine',
  neutrum: 'neuter',
  feminin: 'feminine',
  Plural: 'plural',
};

const glossEn = (s) => {
  const t = GRAMMAR_EN[String(s).trim()];
  return t ? `${s} · ${t}` : String(s);
};

/**
 * Render a look-up table. Cells that differ from the Nominativ row in the same column
 * are emphasised, because "what changes" is the whole point of the article tables.
 */
function referenceTable(table) {
  const rows = table.rows || [];
  const headers = table.headers || [];
  const headersEn = table.headersEn || [];
  const nom = rows.find((r) => /^nominativ$/i.test(String(r[0] || '').trim()));
  const emphasise = Boolean(nom) && headers[0] === '';

  return `
    <table class="plain mt">
      <thead><tr>${headers
        .map((h, i) => {
          const en = headersEn[i];
          const label = en && en !== h ? `${h}${h ? '<div class="dim small">' : ''}${esc(en)}${h ? '</div>' : ''}` : esc(h);
          return `<th${i === 0 ? ' style="width:22%"' : ''}>${label}</th>`;
        })
        .join('')}</tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>${r
              .map((cell, i) => {
                const changed = emphasise && i > 0 && String(cell) !== String(nom[i]);
                const label = i === 0 && GRAMMAR_EN[String(cell).trim()] ? esc(glossEn(cell)) : esc(cell);
                return `<td${changed ? ' style="color:var(--accent-2);font-weight:700"' : i === 0 ? ' class="dim"' : ''}>${label}</td>`;
              })
              .join('')}</tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

export async function casesGuideView(el) {
  const guide = await ai.loadCasesGuide();
  if (!guide) {
    el.innerHTML = emptyGuide('Fälle und Artikel', 'data/cases-guide.json');
    return;
  }

  const totalRows = guide.tables.reduce((n, t) => n + t.rows.length, 0);

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Fälle und Artikel</h3>
          <div class="dim small">${guide.tables.length} Tabellen · ${totalRows} Zeilen · nie abgefragt</div>
        </div>
        <span class="pill">Nachschlagen, nicht abgefragt</span>
      </div>
      <p class="muted mt">${esc(guide.intro)}</p>
      ${guide.introEn ? `<p class="dim small">${esc(guide.introEn)}</p>` : ''}
      <p class="dim small">
        <span style="color:var(--accent-2);font-weight:700">Hervorgehoben</span> sind die Formen, die sich vom
        Nominativ unterscheiden – genau die muss man sich merken.
      </p>
      <div class="btn-row mt">
        ${guide.tables.map((t) => `<span class="tag-chip" data-jump-table="${esc(t.id)}">${esc(t.title)}</span>`).join('')}
      </div>
    </div>

    ${guide.tables
      .map(
        (t) => `
      <div class="card" id="case-${esc(t.id)}">
        <h4>${esc(t.title)}</h4>
        ${t.titleEn ? `<div class="dim small">${esc(t.titleEn)}</div>` : ''}
        <div class="dim small">${esc(t.why)}</div>
        ${t.whyEn ? `<div class="dim small">${esc(t.whyEn)}</div>` : ''}
        ${referenceTable(t)}
        ${t.note ? `<div class="muted small mt">${esc(t.note)}</div>` : ''}
        ${t.noteEn ? `<div class="dim small">${esc(t.noteEn)}</div>` : ''}
      </div>`
      )
      .join('')}

    <div class="card">
      <h4>Welcher Fall? Diese Wörter entscheiden es</h4>
      <p class="dim small">Wenn eines dieser Wörter im Satz steht, steht der Fall schon fest – unabhängig davon, was du sagen willst.</p>
      <table class="plain mt">
        <tbody>
          ${guide.triggers
            .map(
              (t) => `<tr>
            <td style="width:110px"><span class="pill ${t.case === 'Dativ' ? 'warn' : t.case === 'Akkusativ' ? 'bad' : 'good'}">${esc(t.case)}</span></td>
            <td>
              <b>${esc(t.kind)}</b>
              ${t.kindEn ? `<div class="dim small">${esc(t.kindEn)}</div>` : ''}
              <div class="small mt">${t.items.map((i) => `<span class="tag-chip">${esc(i)}</span>`).join(' ')}</div>
              <div class="muted small mt">${esc(t.example)}</div>
              ${t.en ? `<div class="dim small">${esc(t.en)}</div>` : ''}
            </td>
            <td class="num" style="width:48px">${sayButton(t.example)}</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h4>Beispiele im Zusammenhang</h4>
      <table class="plain">
        <tbody>
          ${guide.examples
            .map(
              (e) => `<tr>
            <td><div><b>${esc(e.de)}</b></div>
              <div class="dim small">${esc(e.en)}</div>
              ${e.note ? `<div class="muted small mt">${esc(e.note)}</div>` : ''}</td>
            <td class="num" style="width:48px">${sayButton(e.de)}</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h4>Typische Fehler</h4>
      <ul class="muted small" style="margin:0 0 0 18px;padding:0">${guide.watchOut.map((w, i) => `<li>${esc(w)}${guide.watchOutEn?.[i] ? `<div class="dim">${esc(guide.watchOutEn[i])}</div>` : ''}</li>`).join('')}</ul>
    </div>

    <div class="card">
      <div class="btn-row">
        <button class="primary" data-goto-drill>Fälle jetzt üben</button>
        <button data-goto-atoms>Grammatik-Themen</button>
      </div>
    </div>
  `;

  delegate(el, 'click', '[data-say]', (e, t) => speak(t.dataset.say, speakOpts()));
  delegate(el, 'click', '[data-goto-drill]', () => navigate('drill', { size: 15 }));
  delegate(el, 'click', '[data-goto-atoms]', () => navigate('grammarguide'));
  delegate(el, 'click', '[data-jump-table]', (e, t) => {
    const target = el.querySelector(`#case-${t.dataset.jumpTable}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}


/* ================================================================ Nomen & Genus */

const GENDER_TONE = { der: 'pill warn', die: 'pill bad', das: 'pill good' };
const genderPill = (g) => `<span class="${GENDER_TONE[g] || 'pill'}">${esc(g)}</span>`;

export async function nounsGuideView(el, params = {}) {
  const [gender, nouns] = await Promise.all([ai.loadGenderRules(), ai.loadNounLexicon()]);
  if (!gender && !nouns.length) {
    el.innerHTML = emptyGuide('Nomen und Genus', 'data/gender-rules.json / data/noun-lexicon.json');
    return;
  }

  // The filter lives in the route params: re-rendering the view would otherwise
  // reset it, which is exactly what made the gender buttons appear to do nothing.
  let filter = params.gender || 'alle';
  let query = params.q || '';

  const matches = () =>
    nouns.filter((n) => {
      if (filter !== 'alle' && n.gender !== filter) return false;
      if (!query) return true;
      const q = query.toLowerCase();
      return n.de.toLowerCase().includes(q) || n.en.toLowerCase().includes(q) || n.theme.toLowerCase().includes(q);
    });

  // One helper for both the first paint and the re-render on search, so the two
  // cannot drift apart.
  const nounRow = (n) => `<tr>
            <td>${genderPill(n.gender)} <b>${esc(n.de.replace(/^(der|die|das)\s/, ''))}</b>
              ${n.example ? `<div class="dim small">${esc(n.example)}</div>` : ''}
              ${n.exampleEn ? `<div class="dim small">${esc(n.exampleEn)}</div>` : ''}</td>
            <td>${esc(n.plural)}</td>
            <td>${esc(n.en)}</td>
            <td class="dim small">${esc(n.rule)}${n.ruleEn ? `<div class="dim">${esc(n.ruleEn)}</div>` : ''}<div class="dim">${esc(n.theme)}</div></td>
          </tr>`;
  const nounRows = (list) => list.map(nounRow).join('');

  const lexiconCard = () => {
    if (!nouns.length) return '';
    const list = matches();
    return `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h4 style="margin:0">Nomen-Lexikon</h4>
          <div class="dim small">${nouns.length} Nomen mit Artikel, Plural und der Regel dahinter</div>
        </div>
        <div class="btn-row">
          ${['alle', 'der', 'die', 'das'].map((g) => `<button class="sm ${filter === g ? 'primary' : ''}" data-gender-filter="${g}">${g === 'alle' ? 'Alle' : g}</button>`).join('')}
        </div>
      </div>
      <div class="mt">
        <input type="text" id="noun-search" placeholder="Suchen: Wort, Bedeutung oder Thema …" value="${esc(query)}">
      </div>
      <div class="dim small mt" id="noun-count">${list.length} Einträge</div>
      <table class="plain mt">
        <thead><tr><th>Nomen</th><th>Plural</th><th>Bedeutung</th><th>Regel</th></tr></thead>
        <tbody id="noun-rows">
          ${nounRows(list)}
        </tbody>
      </table>
    </div>`;
  };

  const rewireLexicon = () => {
    const input = el.querySelector('#noun-search');
    if (input) {
      on(input, 'input', (e) => {
        query = e.target.value;
        const list = matches();
        el.querySelector('#noun-rows').innerHTML = nounRows(list);
        el.querySelector('#noun-count').textContent = `${list.length} Einträge`;
      });
    }
    delegate(el, 'click', '[data-gender-filter]', (e, t) => {
      navigate('nounsguide', { from: 'reference', gender: t.dataset.genderFilter, q: query });
    });
  };

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Nomen und Genus</h3>
          <div class="dim small">
            ${gender ? `${gender.rules.length} Regeln · ${gender.exceptions.length} Ausnahmen · ${gender.doubleGender.length} Wörter mit zwei Genus` : ''}
            ${nouns.length ? ` · ${nouns.length} Nomen` : ''}
          </div>
        </div>
        <span class="pill">Nachschlagen, nicht abgefragt</span>
      </div>
      <p class="muted mt">${esc(gender?.intro || '')}</p>
      ${gender?.introEn ? `<p class="dim small">${esc(gender.introEn)}</p>` : ''}
    </div>

    ${(gender?.rules || [])
      .map(
        (r) => `
      <div class="card">
        <div class="btn-row" style="justify-content:space-between">
          <h4 style="margin:0">${esc(r.title)}</h4>
          ${genderPill(r.gender)}
        </div>
        ${r.titleEn ? `<div class="dim small">${esc(r.titleEn)}</div>` : ''}
        <div class="dim small">${esc(r.note)}</div>
        ${r.noteEn ? `<div class="dim small">${esc(r.noteEn)}</div>` : ''}
        <div class="btn-row mt">${r.items.map((i) => `<span class="tag-chip">${esc(i)}</span>`).join('')}</div>
        <table class="plain mt">
          <tbody>
            ${r.examples
              .map(
                (x) => `<tr>
              <td>${genderPill(x.de.slice(0, 3))} <b>${esc(x.de.replace(/^(der|die|das)\s/, ''))}</b> <span class="dim small">– ${esc(x.en)}</span></td>
              <td class="num dim">${esc(x.plural)}</td>
              <td class="num" style="width:48px">${sayButton(x.de)}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
      )
      .join('')}

    ${gender?.exceptions?.length ? `
      <div class="card" style="border-color:var(--warn)">
        <h4>Die wichtigen Ausnahmen</h4>
        <p class="dim small">Diese Nomen brechen eine Regel. Genau deshalb kommen sie in der Prüfung vor.</p>
        <table class="plain mt">
          <thead><tr><th>Nomen</th><th>sieht aus wie</th><th>warum es anders ist</th></tr></thead>
          <tbody>
            ${gender.exceptions
              .map(
                (x) => `<tr>
              <td>${genderPill(x.de.slice(0, 3))} <b>${esc(x.de.replace(/^(der|die|das)\s/, ''))}</b>
                <div class="dim small">${esc(x.en)} · ${esc(x.plural)}</div></td>
              <td>${genderPill(x.looks)}</td>
              <td class="muted small">${esc(x.why)}${x.whyEn ? `<div class="dim">${esc(x.whyEn)}</div>` : ''}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${gender?.doubleGender?.length ? `
      <div class="card" style="border-color:var(--accent)">
        <h4>Gleiches Wort, anderes Genus</h4>
        <p class="dim small">Der Artikel ändert die Bedeutung. Das ist eine beliebte Prüfungsfalle.</p>
        <table class="plain mt">
          <thead><tr><th>Wort</th><th>Bedeutung</th><th>anderer Artikel</th><th>Bedeutung</th></tr></thead>
          <tbody>
            ${gender.doubleGender
              .map(
                (x) => `<tr>
              <td><b>${esc(x.de)}</b><div class="dim small">${esc(x.why)}</div>${x.whyEn ? `<div class="dim small">${esc(x.whyEn)}</div>` : ''}</td>
              <td>${esc(x.en)}</td>
              <td><b>${esc(x.other)}</b></td>
              <td>${esc(x.otherEn)}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>` : ''}

    ${lexiconCard()}

    ${gender?.watchOut?.length ? `
      <div class="card">
        <h4>Typische Fehler</h4>
        <ul class="muted small" style="margin:0 0 0 18px;padding:0">${gender.watchOut.map((w, i) => `<li>${esc(w)}${gender.watchOutEn?.[i] ? `<div class="dim">${esc(gender.watchOutEn[i])}</div>` : ''}</li>`).join('')}</ul>
      </div>` : ''}

    <div class="card">
      <div class="btn-row">
        <button class="primary" data-practice-nouns>Diese Nomen üben</button>
        <button data-goto-cases>Fälle &amp; Artikel</button>
      </div>
    </div>
  `;

  rewireLexicon();
  delegate(el, 'click', '[data-say]', (e, t) => speak(t.dataset.say, speakOpts()));
  delegate(el, 'click', '[data-practice-nouns]', () => navigate('vocabdrill', { deck: 'nouns', size: 20, from: 'reference' }));
  delegate(el, 'click', '[data-goto-cases]', () => navigate('casesguide', { from: 'reference' }));
}

/* =============================================================== Satzbau */

export function sentenceGuideView(el) {
  const SAMPLES = [
    'Ich fahre morgen mit dem Zug nach Berlin.',
    'Morgen fahre ich mit dem Zug nach Berlin.',
    'Weil ich müde bin, bleibe ich heute zu Hause.',
    'Ich habe gestern einen Brief geschrieben.',
    'Wenn es morgen regnet, bleiben wir zu Hause.',
    'Am Montag ich fahre nach Berlin.',
  ];

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Satzbau verstehen</h3>
          <div class="dim small">Schreib einen Satz – du siehst sofort, wie er gebaut ist</div>
        </div>
        <span class="pill good">sofort, ohne API-Schlüssel</span>
      </div>
      <p class="muted small">
        Das Werkzeug zeigt dir, wo das konjugierte Verb steht und welche Regel das erklärt.
        Es ist eine Lernhilfe, kein Parser: es meldet nur, was es sicher erkennt.
      </p>
      <textarea id="satz-input" style="min-height:80px" placeholder="z. B. Morgen fahre ich mit dem Zug nach Berlin."></textarea>
      <div class="btn-row mt">
        <button class="primary" data-analyse>Analysieren</button>
        <button data-clear>Leeren</button>
        <span class="dim small">oder ein Beispiel:</span>
        ${SAMPLES.slice(0, 3).map((s) => `<button class="sm" data-sample="${esc(s)}">${esc(s.slice(0, 22))}…</button>`).join('')}
      </div>
    </div>
    <div id="satz-result"></div>
  `;

  const input = el.querySelector('#satz-input');
  const out = el.querySelector('#satz-result');

  const run = () => {
    const text = input.value.trim();
    if (!text) {
      out.innerHTML = '';
      return;
    }
    const r = analyseSentence(text);
    out.innerHTML = renderSentenceAnalysis(r);
    wireResult(out, text, r);
  };

  let timer = null;
  on(input, 'input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 350);
  });
  on(el.querySelector('[data-analyse]'), 'click', run);
  on(el.querySelector('[data-clear]'), 'click', () => {
    input.value = '';
    out.innerHTML = '';
    input.focus();
  });
  delegate(el, 'click', '[data-sample]', (e, t) => {
    input.value = t.dataset.sample;
    run();
  });

  input.focus();
}

const CLAUSE_LABEL = {
  hauptsatz: 'Hauptsatz',
  nebensatz: 'Nebensatz',
  wfrage: 'W-Frage',
  entscheidungsfrage: 'Ja/Nein-Frage',
};

const CLAUSE_LABEL_EN = {
  hauptsatz: 'main clause',
  nebensatz: 'subordinate clause',
  wfrage: 'W-question',
  entscheidungsfrage: 'yes/no question',
};

function renderSentenceAnalysis(r) {
  if (!r) return '';
  const tone = r.errors ? 'no' : r.warnings ? 'warn' : 'ok';
  const verdict = r.errors
    ? `${r.errors} Fehler gefunden`
    : r.warnings
      ? 'Sieht gut aus – ein Hinweis'
      : 'Alles in Ordnung';
  const verdictEn = r.errors
    ? `${r.errors} ${r.errors === 1 ? 'error' : 'errors'} found`
    : r.warnings
      ? 'Looks good — one note'
      : 'All good';

  return `
    <div class="card">
      <div class="verdict-row">
        <span class="pill ${r.errors ? 'bad' : r.warnings ? 'warn' : 'good'}">${esc(verdict)}</span>
        <span class="dim small">${r.clauses.length} ${r.clauses.length === 1 ? 'Teilsatz' : 'Teilsätze'}</span>
      </div>
      <div class="dim small">${esc(verdictEn)}</div>
      ${r.issues.length
        ? r.issues
            .map(
              (i) => `<div class="feedback ${i.severity === 'error' ? 'no' : 'warn'}" style="margin-top:8px">
          <div class="verdict">${i.severity === 'error' ? '✗' : '!'} ${esc(i.message)}</div>
          ${i.messageEn ? `<div class="why">${esc(i.messageEn)}</div>` : ''}
          ${i.hint ? `<div class="why dim">${esc(i.hint)}</div>` : ''}
          ${i.hintEn ? `<div class="why dim">${esc(i.hintEn)}</div>` : ''}
        </div>`
            )
            .join('')
        : ''}
    </div>

    ${r.clauses
      .map(
        (c, i) => `
      <div class="card">
        <div class="btn-row" style="justify-content:space-between">
          <h4 style="margin:0">Teilsatz ${i + 1}: ${esc(c.text)}</h4>
          <span class="pill">${esc(CLAUSE_LABEL[c.type] || c.type)}${CLAUSE_LABEL_EN[c.type] ? ` · ${esc(CLAUSE_LABEL_EN[c.type])}` : ''}</span>
        </div>
        <table class="plain mt">
          <thead><tr><th>Satzteil</th><th>Inhalt</th></tr></thead>
          <tbody>
            ${c.vorfeld ? `<tr><td class="dim">Position 1 – Vorfeld<div class="dim small">opening element</div></td><td><b>${esc(c.vorfeld)}</b></td></tr>` : ''}
            <tr><td class="dim">Konjugiertes Verb<div class="dim small">finite verb</div></td><td><b>${esc(c.finite || 'nicht erkannt')}</b>${c.finiteIndex >= 0 ? ` <span class="dim small">(Wort ${c.finiteIndex + 1} von ${c.tokenCount})</span>` : ''}</td></tr>
            ${c.mittelfeld ? `<tr><td class="dim">Mittelfeld<div class="dim small">middle field</div></td><td>${esc(c.mittelfeld)}</td></tr>` : ''}
            ${c.bracket ? `<tr><td class="dim">Satzende (${c.bracket.kind === 'perfekt' ? 'Partizip II' : 'Infinitiv'})<div class="dim small">end of clause</div></td><td><b>${esc(c.bracket.word)}</b></td></tr>` : ''}
          </tbody>
        </table>
        <div class="feedback ok mt" style="margin-top:10px">
          <div class="verdict">${esc(c.rule.title)}</div>
          ${c.rule.titleEn ? `<div class="verdict dim">${esc(c.rule.titleEn)}</div>` : ''}
          <div class="why">${esc(c.rule.explanation)}</div>
          ${c.rule.explanationEn ? `<div class="why dim">${esc(c.rule.explanationEn)}</div>` : ''}
        </div>
      </div>`
      )
      .join('')}

    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h4 style="margin:0">Ausführliche Erklärung</h4>
          <div class="dim small">Rollen, Fälle und Begründung Satzteil für Satzteil – von der KI.</div>
        </div>
        <button data-deep-explain>Erklären lassen</button>
      </div>
      <div id="satz-deep" class="mt"></div>
    </div>
  `;
}

function wireResult(out, text, analysis) {
  const btn = out.querySelector('[data-deep-explain]');
  if (!btn) return;
  on(btn, 'click', async () => {
    const host = out.querySelector('#satz-deep');
    if (!ai.isConfigured()) {
      host.innerHTML = `<div class="feedback no"><div class="verdict">Kein API-Schlüssel</div>
        <div class="why">Für die ausführliche Erklärung brauchst du einen Schlüssel (Einstellungen). Die Analyse oben läuft ohne.</div></div>`;
      return;
    }
    btn.disabled = true;
    const stop = spinnerWithTimer(host, 'Die KI erklärt den Satz…');
    try {
      const g = await ai.explainSentence({ sentence: text, analysis });
      stop();
      host.innerHTML = `
        <div class="feedback ${g.correct ? 'ok' : 'no'}" style="margin-top:0">
          <div class="verdict">${g.correct ? '✓ Der Satz ist korrekt' : '✗ Es gibt etwas zu ändern'}</div>
          ${g.summary ? `<div class="why">${esc(g.summary)}</div>` : ''}
          ${g.corrected ? `<div class="why mt"><b>Korrigiert:</b> ${esc(g.corrected)}</div>` : ''}
        </div>
        ${g.parts.length ? `
          <table class="plain mt">
            <thead><tr><th>Satzteil</th><th>Funktion</th><th>Fall</th></tr></thead>
            <tbody>
              ${g.parts.map((p) => `<tr>
                <td><b>${esc(p.text)}</b></td>
                <td>${esc(p.role)}${p.why ? `<div class="dim small">${esc(p.why)}</div>` : ''}</td>
                <td class="dim">${esc(p.caseName)}</td>
              </tr>`).join('')}
            </tbody>
          </table>` : ''}
        ${g.verbNote ? `<div class="muted small mt"><b>Zum Verb:</b> ${esc(g.verbNote)}</div>` : ''}
        ${g.corrections.length ? `<div class="mt"><h4>Korrekturen</h4>${g.corrections
          .map((c) => `<div class="correction"><div><span class="orig">${esc(c.original)}</span> → <span class="corr">${esc(c.corrected)}</span></div>${c.explanation ? `<div class="why">${esc(c.explanation)}</div>` : ''}</div>`)
          .join('')}</div>` : ''}
      `;
    } catch (err) {
      stop();
      host.innerHTML = `<div class="feedback no"><div class="verdict">Erklärung fehlgeschlagen</div><div class="why">${esc(err.message)}</div></div>`;
    } finally {
      btn.disabled = false;
    }
  });
}

/* =================================================================== Grammatik */

export async function grammarGuideView(el, params = {}) {
  const guide = await ai.loadGrammarGuide();
  if (!guide.length) {
    el.innerHTML = emptyGuide('Grammatik-Nachschlagewerk', 'data/grammar-guide.json');
    return;
  }

  const exampleCount = guide.reduce((n, t) => n + t.examples.length, 0);
  const focus = params.topic || null;

  el.innerHTML = `
    <div class="card">
      <div class="btn-row" style="justify-content:space-between">
        <div>
          <h3 style="margin:0">Grammatik zum Nachschlagen</h3>
          <div class="dim small">${guide.length} Themen · ${exampleCount} Beispielsätze · nie abgefragt</div>
        </div>
        <span class="pill">Nachschlagen, nicht abgefragt</span>
      </div>
      <p class="dim small">
        Jedes Thema zeigt die Regel in einfachen Worten, das Muster und vollständige Beispielsätze.
        Klick auf ein Thema, um direkt dorthin zu springen.
      </p>
      <div class="btn-row mt">
        ${guide.map((t) => `<span class="tag-chip" data-jump="${esc(t.id)}">${esc(t.title)}</span>`).join('')}
      </div>
    </div>

    ${guide
      .map(
        (t) => `
      <div class="card" id="topic-${esc(t.id)}">
        <details class="disclosure"${t.id === focus ? ' open' : ''}>
          <summary>${esc(t.title)}${t.titleEn ? `<span class="dim small"> · ${esc(t.titleEn)}</span>` : ''}</summary>
          <div class="dim small">${esc(t.why)}</div>
          ${t.whyEn ? `<div class="dim small">${esc(t.whyEn)}</div>` : ''}
          <p class="muted mt">${esc(t.rule)}</p>
          ${t.ruleEn ? `<p class="dim">${esc(t.ruleEn)}</p>` : ''}
          <div class="card tight" style="background:var(--bg-3)">
            <div class="dim small">Muster<div class="dim">pattern</div></div>
            <div class="mono">${esc(t.pattern)}</div>
            ${t.patternEn ? `<div class="mono dim">${esc(t.patternEn)}</div>` : ''}
          </div>
          ${t.table ? `
            <table class="plain mt">
              <thead><tr>${t.table.headers.map((h, i) => {
                const en = t.table.headersEn?.[i];
                return `<th>${esc(h)}${en && en !== h ? `<div class="dim small">${esc(en)}</div>` : ''}</th>`;
              }).join('')}</tr></thead>
              <tbody>${t.table.rows.map((r, ri) => `<tr>${r.map((c, ci) => {
                const en = ci === 0 ? t.table.firstColumnEn?.[ri] : null;
                return `<td>${esc(c)}${en ? `<div class="dim small">${esc(en)}</div>` : ''}</td>`;
              }).join('')}</tr>`).join('')}</tbody>
            </table>` : ''}
          <table class="plain mt">
            <tbody>
              ${t.examples
                .map(
                  (ex) => `<tr>
                <td><div><b>${esc(ex.de)}</b></div>
                  <div class="dim small">${esc(ex.en)}${ex.note ? ` · ${esc(ex.note)}` : ''}</div></td>
                <td class="num" style="width:48px">${sayButton(ex.de)}</td>
              </tr>`
                )
                .join('')}
            </tbody>
          </table>
          ${t.traps?.length ? `
            <div class="mt">
              <h4>Typische Fehler</h4>
              <ul class="muted small" style="margin:0 0 0 18px;padding:0">${t.traps.map((x, i) => `<li>${esc(x)}${t.trapsEn?.[i] ? `<div class="dim">${esc(t.trapsEn[i])}</div>` : ''}</li>`).join('')}</ul>
            </div>` : ''}
        </details>
      </div>`
      )
      .join('')}

    <div class="card">
      <div class="btn-row">
        <button class="primary" data-goto-drill>Grammatik jetzt üben</button>
      </div>
    </div>
  `;

  delegate(el, 'click', '[data-say]', (e, t) => speak(t.dataset.say, speakOpts()));
  delegate(el, 'click', '[data-goto-drill]', () => navigate('drill', { size: 15 }));
  delegate(el, 'click', '[data-jump]', (e, t) => {
    const target = el.querySelector(`#topic-${t.dataset.jump}`);
    if (target) {
      const details = target.querySelector('details');
      if (details) details.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}
