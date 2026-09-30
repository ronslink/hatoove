/**
 * DeepSeek layer.
 *
 * The key never touches the browser: everything goes through the local server's
 * /api/ai proxy. Every call is JSON-mode and validated before it is trusted, and
 * every generator has an offline fallback so the app degrades instead of breaking.
 */

import { PARTS, TAGS } from './blueprint.js';
import * as store from './store.js';

let status = { configured: false, model: 'deepseek-chat', keyMasked: '', examDate: '', checked: false };

/* ----------------------------------------------------------------- basics */

export async function refreshStatus() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    status = { ...data, checked: true };
  } catch {
    status = { ...status, configured: false, checked: true };
  }
  return status;
}

export function aiStatus() {
  return status;
}

export function isConfigured() {
  return Boolean(status.configured);
}

function extractJSON(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  let value;
  try {
    value = JSON.parse(t);
  } catch (err) {
    // Allow harmless prose around a JSON object, but do not turn an array into
    // its first object or repair a truncated assessment.
    if (t.startsWith('[')) throw err;
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first < 0 || last <= first) throw err;
    value = JSON.parse(t.slice(first, last + 1));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value;
}

export async function callAI({ system, user, temperature = 0.9, maxTokens = 4096, timeoutMs, validate }) {
  // Regenerate once from the original input; never invent missing JSON fields or
  // accept a partial assessment. Transport/account failures remain explicit.
  const retryable = new Set(['BAD_JSON', 'TRUNCATED', 'BAD_ENVELOPE', 'EMPTY', 'BAD_SCHEMA']);
  let tokenLimit = maxTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: attempt === 0 ? system : `${system}\nDie vorherige Antwort war unvollständig oder ungültig. Erstelle die Antwort neu und knapp als EIN vollständiges gültiges JSON-Objekt. Keine Markdown-Zäune, keine Wertebereiche wie 0-100 anstelle einer Zahl. Escape Anführungszeichen und Zeilenumbrüche in Strings. Alle angeforderten Felder ausfüllen.` },
            { role: 'user', content: user },
          ],
          temperature: attempt === 0 ? temperature : Math.min(temperature, 0.2),
          maxTokens: tokenLimit,
          timeoutMs,
          json: true,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, code: 'BAD_ENVELOPE', error: 'Die KI-Antwort konnte nicht gelesen werden.' }));
      if (!res.ok || !data?.ok) {
        const err = new Error(data?.error || `AI-Fehler (${res.status})`);
        // Preserve non-retriable HTTP errors even if their body is not JSON.
        err.code = res.status === 401 ? 'BAD_KEY' : res.status === 402 ? 'NO_CREDIT'
          : res.status === 429 ? 'RATE_LIMIT' : res.status === 504 ? 'TIMEOUT' : data?.code || 'AI_ERROR';
        throw err;
      }
      if (data.finishReason === 'length') {
        const err = new Error('Die KI-Antwort wurde abgeschnitten. Bitte versuche es erneut.');
        err.code = 'TRUNCATED';
        throw err;
      }
      let parsed;
      try {
        parsed = extractJSON(data.content);
      } catch {
        const err = new Error('Die KI hat keine lesbare Antwort geliefert. Bitte versuche es erneut.');
        err.code = 'BAD_JSON';
        throw err;
      }
      if (validate && !validate(parsed)) {
        const err = new Error('Die KI-Bewertung war unvollständig. Bitte versuche es erneut.');
        err.code = 'BAD_SCHEMA';
        throw err;
      }
      store.noteAi(true);
      return parsed;
    } catch (err) {
      store.noteAi(false, err.message);
      if (attempt === 1 || !retryable.has(err.code)) throw err;
      tokenLimit = Math.min(8192, Math.max(tokenLimit, 1024) * 2);
    }
  }
}

export async function testKey() {
  const res = await fetch('/api/ai/test', { method: 'POST' });
  return res.json();
}

export async function saveConfig(patch) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  status = { ...status, ...data, checked: true };
  return data;
}

/* ------------------------------------------------------------ shared bits */

const AUTHOR = [
  'Du bist ein erfahrener DaF-Prüfungsautor und erstellst Material für die Prüfung "telc Deutsch B1" (Zertifikat Deutsch).',
  'Deine Texte sind sprachlich einwandfrei, natürlich und exakt auf Niveau B1 (GER).',
  'B1 heißt: Hauptsätze und einfache Nebensätze, gängige Konnektoren (weil, dass, wenn, obwohl, deshalb, trotzdem),',
  'Perfekt und Präteritum, Modalverben, Passiv nur selten, Wortschatz der Alltagsthemen. Keine B2-Strukturen, keine Ironie.',
  'Verwende echte deutsche Umlaute (ä ö ü ß), niemals ae/oe/ue/ss als Ersatz.',
].join(' ');

/**
 * The themes the exam actually reuses, taken from the tasks of the official
 * telc Deutsch B1 Übungstest 1 rather than invented. Generated material therefore
 * lands inside the exam's real thematic range instead of a generic B1 spread.
 */
const WRITTEN_THEMES = [
  'Haushalt und Hausarbeit aufteilen',
  'Freizeit und Vereine: Sportverein und Hobbys',
  'Reisen und Verkehr: Bahn, Fahrrad, Flug, Unterkunft',
  'Gesundheit: Schlafstörungen, Arztbesuch, Patientenratgeber',
  'Bildung und Jugend: Nachhilfe, Sprachkurse, Jugendclub',
  'Essen und Trinken: Restaurant, Essen zum Mitnehmen',
];

/** The oral exam reuses a small set of discussion topics. */
const ORAL_THEMES = [
  'Gruppenreisen',
  'Fernsehen',
  'Handy in der Schule',
  'Haustiere',
  'Online-Einkaufen',
  'Auto in der Stadt',
  'Stadt oder Land',
];

/** Typical semi-formal Schreiben situations. */
const WRITING_THEMES = [
  'auf eine Anzeige antworten',
  'sich für einen Kurs anmelden',
  'sich über etwas beschweren',
  'um Informationen bitten',
  'sich für etwas bedanken',
  'einen Termin absagen oder verschieben',
  'jemanden einladen',
  'um Hilfe oder Rat bitten',
];

const INFORMAL_WRITING_THEMES = [
  'einen Besuch bei einer Freundin oder einem Freund planen',
  'auf eine private Einladung antworten',
  'einer Freundin oder einem Freund von einem Urlaub erzählen',
  'sich bei einer Freundin oder einem Freund bedanken',
  'ein Treffen mit einer Freundin oder einem Freund verschieben',
  'eine Freundin oder einen Freund um Rat bitten',
];

const TOPICS = [...WRITTEN_THEMES, ...ORAL_THEMES, ...WRITING_THEMES];

function pickFrom(pool, exclude = []) {
  const fresh = pool.filter((t) => !exclude.includes(t));
  const use = fresh.length ? fresh : pool;
  return use[Math.floor(Math.random() * use.length)] || pool[0];
}

function levelWord(difficulty) {
  if (difficulty < 45) return 'eher leicht (A2+/B1-Einstieg)';
  if (difficulty > 62) return 'anspruchsvoll (B1+, nah an B2)';
  return 'typisches B1-Niveau';
}

const JSON_RULES = [
  'Antworte AUSSCHLIESSLICH mit einem einzigen gültigen JSON-Objekt.',
  'Kein Markdown, keine Code-Fences, keine Erklärungen außerhalb des JSON.',
  'Alle Strings in korrektem Deutsch mit echten Umlauten.',
].join(' ');

/* ------------------------------------------------------------ validation */

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function letter(i) {
  return String.fromCharCode(97 + i);
}

function normBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return ['true', 'richtig', 'r', 'ja', '1', '+', 'plus'].includes(s);
}

function requireFields(obj, path) {
  if (!obj || typeof obj !== 'object') throw new Error(`KI-Ausgabe unvollständig (${path}).`);
  return obj;
}

/* --------------------------------------------------------- set generators */

const SET_PROMPTS = {
  LV1: (t, d) => `Erstelle einen Leseverstehen-Teil 1 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: 10 Überschriften (a–j) und 5 kurze Texte (1–5). Jeder Text ist ein kurzer Zeitungs-/Magazinbeitrag
(2–4 Sätze, 30–50 Wörter). Genau 5 Überschriften passen nicht zu irgendeinem Text.
Die Distraktoren müssen inhaltlich plausibel sein, aber die Hauptaussage verfehlen.

${JSON_RULES}

{
  "title": "kurzer deutscher Titel",
  "headlines": [{"id":"a","text":"..."}, ... genau 10, ids a bis j],
  "texts": [{"id":"1","text":"...","answer":"d"}, ... genau 5, ids 1 bis 5],
  "why": {"1":"Kurze deutsche Begründung", ..., "5":"..."}
}`,

  LV2: (t, d) => `Erstelle einen Leseverstehen-Teil 2 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: EIN längerer Text (180–260 Wörter, Zeitungs-/Zeitschriftenstil, z. B. Reportage oder Bericht)
und 5 Multiple-Choice-Aufgaben (Nummern 6–10) mit den Optionen a, b, c.
Die Aufgaben folgen der Reihenfolge des Textes. Die Distraktoren enthalten typische telc-Fallen:
Aussagen, die im Text stehen, aber die Frage nicht beantworten.

${JSON_RULES}

{
  "title": "...",
  "text": "...",
  "questions": [{"n":6,"question":"...","options":{"a":"...","b":"...","c":"..."},"answer":"b","why":"..."}, ... n = 6,7,8,9,10]
}`,

  LV3: (t, d) => `Erstelle einen Leseverstehen-Teil 3 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: 12 Kleinanzeigen (a–l) und 10 Situationsbeschreibungen (11–20).
Für jede Situation passt höchstens eine Anzeige; jede Anzeige wird höchstens einmal verwendet.
WICHTIG: Für genau 2 der 10 Situationen passt KEINE Anzeige – dort ist die Lösung "x".
Jede Situation hat zwei unterscheidende Bedingungen (z. B. "draußen sitzen" + "günstig"), die die Anzeige erfüllen muss.

${JSON_RULES}

{
  "title": "...",
  "ads": [{"id":"a","text":"..."}, ... genau 12, ids a bis l],
  "situations": [{"n":11,"text":"...","answer":"f","why":"..."}, ... genau 10, n = 11..20]
}`,

  SB1: (t, d) => `Erstelle Sprachbausteine Teil 1 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: Ein persönlicher Brief oder eine E-Mail mit 10 Lücken, nummeriert 21–30.
An jeder Lücke im Brief steht der Platzhalter {21}, {22} … {30}.
Für jede Lücke drei Optionen a/b/c – meist drei Formen desselben Wortes oder drei Kandidaten für dieselbe Funktion.
Die 10 Lücken müssen mindestens 6 VERSCHIEDENE Grammatikthemen abdecken.

Erlaubte Werte für "grammar" (genau so schreiben):
konnektoren, praeposition_kasus, perfekt_auxiliar, adjektivendungen, relativpronomen, possessivartikel,
personalpronomen, temporalpraeposition, konjunktiv2_hoeflich, partizip2, trennbare_verben, modalverben, komparativ

Das Register (du oder Sie) muss im ganzen Text konsistent sein. Der Brief hat Anrede und Grußformel.

${JSON_RULES}

{
  "title": "...",
  "letter": "Liebe Nina,\\n\\n... {21} ... {22} ...\\n\\nViele Grüße\\nSara",
  "gaps": [{"n":21,"options":{"a":"...","b":"...","c":"..."},"answer":"b","grammar":"konnektoren","why":"..."}, ... 10, n = 21..30]
}`,

  SB2: (t, d) => `Erstelle Sprachbausteine Teil 2 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: Ein formeller Brief (z. B. Antwort auf eine Anzeige, Bitte um Informationen) mit 10 Lücken,
nummeriert 31–40, Platzhalter {31} … {40} im Text.
Dazu eine Wortbank mit genau 15 Wörtern (a–o), GROSS geschrieben (z. B. DESHALB, KÖNNTEN).
Genau 10 Wörter werden gebraucht, jedes höchstens einmal, 5 bleiben übrig.
Die Wortbank enthält: subordinierende Konjunktionen, Konnektoradverbien, Präpositionen,
höfliche Konjunktiv-II-Formen und feste Wendungen.

${JSON_RULES}

{
  "title": "...",
  "letter": "Sehr geehrte Damen und Herren,\\n\\n... {31} ...\\n\\nMit freundlichen Grüßen\\n...",
  "bank": [{"id":"a","word":"DESHALB"}, ... genau 15, ids a bis o],
  "gaps": [{"n":31,"answer":"e","grammar":"konnektoren","why":"..."}, ... genau 10, n = 31..40]
}`,

  HV1: (t, d) => `Erstelle Hörverstehen Teil 1 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: FÜNF unabhängige kurze Hörtexte (jeder 3–5 Sätze, gesprochene Sprache mit Füllwörtern),
die im Test nur EINMAL gehört werden. Dazu 5 Aussagen (41–45), die Richtig oder Falsch sind.
Die Aussagen testen das Globalverstehen (Was will die Person sagen?), nicht einzelne Wörter.
Jeder Text ist eine andere Alltagssituation (Anrufbeantworter, Gespräch im Laden, Ansage, Small Talk, Radio).

Das "script" enthält alle fünf Texte, jeden mit Sprecherkennzeichnung in eckigen Klammern,
getrennt durch eine Leerzeile. Beispiel:
[Sprecherin]: Hallo, hier ist ...\\n\\n[Sprecher 1]: Entschuldigung, ...

${JSON_RULES}

{
  "title": "...",
  "script": "[Sprecherin]: ...\\n\\n[Sprecher 2]: ... (5 Texte)",
  "items": [{"n":41,"statement":"...","answer":true,"why":"..."}, ... genau 5, n = 41..45]
}`,

  HV2: (t, d) => `Erstelle Hörverstehen Teil 2 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: EIN längeres Gespräch (Interview oder ausführlicher Dialog, 400–550 Wörter gesamt),
das im Test ZWEIMAL gehört wird. Dazu 10 Aussagen (46–55), Richtig oder Falsch.
Die Aussagen folgen der Reihenfolge des Gesprächs und testen Detailverstehen.
Baue bewusst Fallen ein: Verneinungen (nicht, kein, nie), Synonyme statt wörtlicher Wiederholung,
und eine zunächst genannte, später korrigierte Information.

Das "script" hat abwechselnde Sprecher in eckigen Klammern, z. B. [Moderator]: / [Gast]: .
Mische richtige und falsche Aussagen etwa hälftig.

${JSON_RULES}

{
  "title": "...",
  "script": "[Moderator]: ...\\n[Gast]: ...",
  "items": [{"n":46,"statement":"...","answer":false,"why":"..."}, ... genau 10, n = 46..55]
}`,

  HV3: (t, d) => `Erstelle Hörverstehen Teil 3 (telc B1).

Thema: ${t}. Schwierigkeit: ${levelWord(d)}.

Format: FÜNF kurze Ansagen/Nachrichten (je 2–4 Sätze: Anrufbeantworter, Bahnhofsdurchsage, Radiohinweis,
Terminabsage, Ladenansage). Jede wird im Test ZWEIMAL gehört.
Dazu 5 Aussagen (56–60), Richtig oder Falsch, die je EIN konkretes Detail prüfen
(Uhrzeit, Ort, Preis, Telefonnummer, Datum).

${JSON_RULES}

{
  "title": "...",
  "script": "[Anrufbeantworter]: ...\\n\\n[Durchsage]: ... (5 Ansagen)",
  "items": [{"n":56,"statement":"...","answer":true,"why":"..."}, ... genau 5, n = 56..60]
}`,
};

/** Fix small model slips so the UI never renders a broken set. */
function normaliseSet(partId, raw) {
  requireFields(raw, partId);
  const kind = PARTS[partId].kind;

  if (kind === 'matching_headlines') {
    const headlines = asArray(raw.headlines).slice(0, 10).map((h, i) => ({ id: String(h.id || letter(i)).toLowerCase(), text: String(h.text || '') }));
    const texts = asArray(raw.texts).slice(0, 5).map((t, i) => ({
      id: String(t.id || i + 1),
      text: String(t.text || ''),
      answer: String(t.answer || '').toLowerCase().trim(),
    }));
    if (headlines.length < 8 || texts.length < 5) throw new Error('LV1 unvollständig');
    const ids = new Set(headlines.map((h) => h.id));
    if (texts.some((t) => !ids.has(t.answer))) throw new Error('LV1: Lösung verweist auf unbekannte Überschrift');
    return { title: String(raw.title || 'Leseverstehen Teil 1'), headlines, texts, why: raw.why || {} };
  }

  if (kind === 'mc3_text') {
    const questions = asArray(raw.questions).slice(0, 5).map((q, i) => ({
      n: Number(q.n) || 6 + i,
      question: String(q.question || ''),
      options: {
        a: String(q?.options?.a ?? ''),
        b: String(q?.options?.b ?? ''),
        c: String(q?.options?.c ?? ''),
      },
      answer: String(q.answer || 'a').toLowerCase().trim().slice(0, 1),
      why: String(q.why || ''),
    }));
    if (questions.length < 5 || questions.some((q) => !['a', 'b', 'c'].includes(q.answer))) throw new Error('LV2 unvollständig');
    return { title: String(raw.title || 'Leseverstehen Teil 2'), text: String(raw.text || ''), questions };
  }

  if (kind === 'matching_ads') {
    const ads = asArray(raw.ads).slice(0, 12).map((a, i) => ({ id: String(a.id || letter(i)).toLowerCase(), text: String(a.text || '') }));
    const situations = asArray(raw.situations).slice(0, 10).map((s, i) => ({
      n: Number(s.n) || 11 + i,
      text: String(s.text || ''),
      answer: String(s.answer || 'x').toLowerCase().trim(),
      why: String(s.why || ''),
    }));
    if (ads.length < 10 || situations.length < 10) throw new Error('LV3 unvollständig');
    const ids = new Set(ads.map((a) => a.id));
    for (const s of situations) {
      if (s.answer !== 'x' && !ids.has(s.answer)) throw new Error('LV3: Lösung verweist auf unbekannte Anzeige');
    }
    return { title: String(raw.title || 'Leseverstehen Teil 3'), ads, situations };
  }

  if (kind === 'gap_mc3' || kind === 'gap_bank') {
    const letterText = String(raw.letter || '');
    if (!/\{\d+\}/.test(letterText)) throw new Error(`${partId}: Platzhalter {21} fehlen im Brief`);

    const gaps = asArray(raw.gaps).slice(0, 10).map((g, i) => {
      const n = Number(g.n) || (kind === 'gap_mc3' ? 21 + i : 31 + i);
      const base = { n, answer: String(g.answer ?? '').toLowerCase().trim().slice(0, 1), grammar: String(g.grammar || 'konnektoren'), why: String(g.why || '') };
      if (kind === 'gap_mc3') {
        base.options = {
          a: String(g?.options?.a ?? ''),
          b: String(g?.options?.b ?? ''),
          c: String(g?.options?.c ?? ''),
        };
        if (!['a', 'b', 'c'].includes(base.answer)) throw new Error(`${partId}: ungültiger Antwortschlüssel`);
      }
      return base;
    });
    if (gaps.length < 10) throw new Error(`${partId} unvollständig`);

    if (kind === 'gap_bank') {
      const bank = asArray(raw.bank).slice(0, 15).map((b, i) => ({ id: String(b.id || letter(i)).toLowerCase(), word: String(b.word || '').toUpperCase() }));
      if (bank.length < 12) throw new Error('SB2: Wortbank zu klein');
      const bankIds = new Set(bank.map((b) => b.id));
      for (const g of gaps) if (!bankIds.has(g.answer)) throw new Error('SB2: Lösung verweist auf unbekanntes Wort');
      return { title: String(raw.title || 'Sprachbausteine Teil 2'), letter: letterText, bank, gaps };
    }
    return { title: String(raw.title || 'Sprachbausteine Teil 1'), letter: letterText, gaps };
  }

  if (kind === 'truefalse') {
    const expect = PARTS[partId].items;
    const items = asArray(raw.items).slice(0, expect).map((it, i) => ({
      n: Number(it.n) || 41 + i,
      statement: String(it.statement || ''),
      answer: normBool(it.answer),
      why: String(it.why || ''),
    }));
    if (items.length < expect) throw new Error(`${partId} unvollständig`);
    return { title: String(raw.title || 'Hörverstehen'), script: String(raw.script || ''), items };
  }

  throw new Error(`Kein Generator für ${partId}`);
}

/* -------------------------------------------------------------- content IO */

let seedCache = null;
let vocabCache = null;
let coreCache = null;
let guideCache = null;
let writingGuideCache;
let grammarGuideCache = null;
let casesGuideCache;
let genderRulesCache;
let nounLexiconCache = null;

export async function loadSeed() {
  if (seedCache) return seedCache;
  try {
    const res = await fetch('/data/seed.json');
    seedCache = res.ok ? await res.json() : {};
  } catch {
    seedCache = {};
  }
  return seedCache;
}

/**
 * The exam-core pack: the function words, verb+preposition patterns, collocations
 * and formulae that telc B1 actually reuses. Split across two files so each stays
 * independently authorable and valid.
 */
export async function loadCore() {
  if (coreCache) return coreCache;
  const files = ['/data/core-grammar.json', '/data/core-phrases.json'];
  const tiers = [];
  for (const url of files) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const tier of Array.isArray(data.tiers) ? data.tiers : []) {
        if (!tier || !Array.isArray(tier.items) || !tier.items.length) continue;
        tiers.push({
          id: String(tier.id || `tier${tiers.length}`),
          title: String(tier.title || tier.id || ''),
          why: String(tier.why || ''),
          items: tier.items.map((item, i) => ({
            ...item,
            tierId: String(tier.id || ''),
            tierTitle: String(tier.title || ''),
            pos: item.pos || 'phrase',
            // Stable SRS key: the pack is curated, so the id is the identity.
            key: `core:${tier.id || 'tier'}:${item.id || i}`,
          })),
        });
      }
    } catch {
      /* a missing pack must not break the trainer */
    }
  }
  coreCache = tiers;
  return coreCache;
}

/**
 * The speaking reference guide: how to approach each oral task, with grouped phrases,
 * whole example sentences and full model answers. Pure reference - nothing in it is
 * ever tested, and it needs no API key.
 */
export async function loadSpeakingGuide() {
  if (guideCache) return guideCache;
  try {
    const res = await fetch('/data/speaking-guide.json');
    const data = res.ok ? await res.json() : { parts: [] };
    guideCache = Array.isArray(data.parts) ? data.parts : [];
  } catch {
    guideCache = [];
  }
  return guideCache;
}

/** The writing reference guide: strategy, building blocks and model letters. */
export async function loadWritingGuide() {
  if (writingGuideCache !== undefined) return writingGuideCache;
  try {
    const res = await fetch('/data/writing-guide.json');
    const data = res.ok ? await res.json() : null;
    writingGuideCache = data && Array.isArray(data.sections) ? data : null;
  } catch {
    writingGuideCache = null;
  }
  return writingGuideCache;
}

/** The grammar reference: rules, patterns and worked examples per topic. */
export async function loadGrammarGuide() {
  if (grammarGuideCache) return grammarGuideCache;
  try {
    const res = await fetch('/data/grammar-guide.json');
    const data = res.ok ? await res.json() : { topics: [] };
    grammarGuideCache = Array.isArray(data.topics) ? data.topics : [];
  } catch {
    grammarGuideCache = [];
  }
  return grammarGuideCache;
}

/** The case-and-article reference: der/die/das across all four cases. */
export async function loadCasesGuide() {
  if (casesGuideCache !== undefined) return casesGuideCache;
  try {
    const res = await fetch('/data/cases-guide.json');
    const data = res.ok ? await res.json() : null;
    casesGuideCache = data && Array.isArray(data.tables) ? data : null;
  } catch {
    casesGuideCache = null;
  }
  return casesGuideCache;
}

/** Noun gender: the ending and meaning rules, plus the exceptions that break them. */
export async function loadGenderRules() {
  if (genderRulesCache !== undefined) return genderRulesCache;
  try {
    const res = await fetch('/data/gender-rules.json');
    const data = res.ok ? await res.json() : null;
    genderRulesCache = data && Array.isArray(data.rules) ? data : null;
  } catch {
    genderRulesCache = null;
  }
  return genderRulesCache;
}

/** The B1 noun lexicon: article, plural, meaning and the rule behind each gender. */
export async function loadNounLexicon() {
  if (nounLexiconCache) return nounLexiconCache;
  try {
    const res = await fetch('/data/noun-lexicon.json');
    const data = res.ok ? await res.json() : { nouns: [] };
    nounLexiconCache = Array.isArray(data.nouns) ? data.nouns : [];
  } catch {
    nounLexiconCache = [];
  }
  return nounLexiconCache;
}

export async function loadVocab() {
  if (vocabCache) return vocabCache;
  try {
    const res = await fetch('/data/vocab.json');
    const data = res.ok ? await res.json() : { words: [] };
    vocabCache = Array.isArray(data.words) ? data.words : [];
  } catch {
    vocabCache = [];
  }
  return vocabCache;
}

async function seedSet(partId, excludeTitles = []) {
  const bank = await loadSeed();
  const list = bank[partId];
  if (!Array.isArray(list) || !list.length) return null;
  const fresh = list.filter((s) => !excludeTitles.includes(s.title));
  const pool = fresh.length ? fresh : list;
  const set = pool[Math.floor(Math.random() * pool.length)];
  return { ...structuredClone(set), source: 'seed', part: partId };
}

/**
 * Generate one full exam part. Always resolves: if the AI is unavailable or the
 * payload fails validation we fall back to the bundled seed bank.
 */
export async function genSet(partId, { difficulty = 56, excludeTitles = [] } = {}) {
  const part = PARTS[partId];
  if (!part) throw new Error(`Unbekannter Prüfungsteil: ${partId}`);
  if (!SET_PROMPTS[partId]) {
    throw new Error(`${partId} hat keinen Aufgabengenerator – nutze genWritingTask() oder genSpeakingTask().`);
  }

  if (!isConfigured()) {
    const s = await seedSet(partId, excludeTitles);
    if (s) return s;
    throw new Error('Kein API-Schlüssel und keine Offline-Aufgabe verfügbar.');
  }

  const t = pickFrom(WRITTEN_THEMES, excludeTitles);
  const prompt = SET_PROMPTS[partId](t, difficulty);
  try {
    const raw = await callAI({
      system: AUTHOR,
      user: prompt,
      temperature: 1.0,
      maxTokens: partId === 'LV2' || partId === 'HV2' ? 6000 : 4096,
    });
    const set = normaliseSet(partId, raw);
    return { ...set, topic: t, source: 'ai', part: partId };
  } catch (err) {
    store.noteAi(false, `${partId}: ${err.message}`);
    const s = await seedSet(partId, excludeTitles);
    if (s) return { ...s, topic: t, fallbackReason: err.message };
    throw err;
  }
}

/* -------------------------------------------------------------- ai drills */

export async function genDrillAI({ tag, difficulty = 55, avoid = [] }) {
  const info = TAGS[tag] || { label: tag, hint: '' };
  const avoidNote = avoid.length ? `Verwende NICHT diese schon gestellten Sätze:\n- ${avoid.slice(0, 8).join('\n- ')}` : '';
  const raw = await callAI({
    system: AUTHOR,
    user: `Erstelle EINE einzelne Grammatik-/Wortschatzaufgabe für telc B1 Sprachbausteine.

Grammatikthema: ${info.label} (${tag})
Hinweis zum Thema: ${info.hint}
Schwierigkeit: ${levelWord(difficulty)}

Format: ein einzelner deutscher Satz mit genau EINER Lücke "___" und drei Optionen a/b/c.
Die drei Optionen sind meist Formen desselben Wortes oder drei Kandidaten für dieselbe Funktion.
Der Satz muss aus sich heraus verständlich sein.
${avoidNote}

${JSON_RULES}

{
  "sentence": "Ich wohne seit drei Jahren in ___ Wohnung.",
  "options": {"a":"einer","b":"eine","c":"einen"},
  "answer": "a",
  "explanation": "Kurze deutsche Erklärung der Regel (1–2 Sätze)."
}`,
    temperature: 1.05,
    maxTokens: 800,
  });

  const options = {
    a: String(raw?.options?.a ?? ''),
    b: String(raw?.options?.b ?? ''),
    c: String(raw?.options?.c ?? ''),
  };
  const answer = String(raw?.answer ?? 'a').toLowerCase().trim().slice(0, 1);
  if (!raw?.sentence || !['a', 'b', 'c'].includes(answer) || !options[answer]) {
    throw new Error('KI-Aufgabe unvollständig');
  }

  return {
    id: `ai_${tag}_${Date.now()}`,
    kind: 'mc3',
    partId: 'SB1',
    tag,
    tags: [tag],
    difficulty,
    instruction: 'Welche Lösung ist richtig?',
    prompt: String(raw.sentence),
    options: ['a', 'b', 'c'].map((k) => ({ key: k, text: options[k] })),
    answerKey: answer,
    answer: options[answer],
    explanation: String(raw.explanation || ''),
    source: 'ai',
  };
}

/* --------------------------------------------------------------- writing */

const WRITING_CRITERIA = [
  { key: 'aufgabe', label: 'Aufgabenbewältigung (alle Leitpunkte)', max: 15 },
  { key: 'kommunikation', label: 'Kommunikative Gestaltung (Anrede, Register, Textsorte)', max: 10 },
  { key: 'richtigkeit', label: 'Formale Richtigkeit (Grammatik, Orthografie)', max: 12 },
  { key: 'ausdruck', label: 'Ausdruck / Wortschatz', max: 8 },
];

// Reserve one turn before generation so an AI failure uses the same register and
// overlapping requests cannot both select the same turn. Stored with learner
// settings so the rotation continues after reloads and in mock exams.
export async function nextWritingTask({ difficulty = 58, excludeTopics = [] } = {}) {
  const settings = store.getState().settings;
  const index = Number.isSafeInteger(settings.writingTaskIndex) && settings.writingTaskIndex >= 0
    ? settings.writingTaskIndex : 0;
  const register = index % 2 === 0 ? 'du' : 'Sie';
  settings.writingTaskIndex = index + 1;
  store.saveNow();
  const fallback = () => offlineWritingTask({ register, variantIndex: Math.floor(index / 2), difficulty });
  if (!isConfigured()) return fallback();
  try {
    return await genWritingTask({ difficulty, excludeTopics, register });
  } catch (err) {
    return { ...fallback(), fallbackReason: err.message };
  }
}

export async function genWritingTask({ difficulty = 58, excludeTopics = [], register = 'du' } = {}) {
  const informal = register === 'du';
  const t = pickFrom(informal ? INFORMAL_WRITING_THEMES : WRITING_THEMES, excludeTopics);
  const raw = await callAI({
    system: AUTHOR,
    user: `Erstelle EINE Schreibaufgabe für telc Deutsch B1 (Schreiben, 30 Minuten, 45 Punkte).

Thema: ${t}. Schwierigkeit: ${levelWord(difficulty)}.

Format: Eine ${informal ? 'informelle' : 'halbformelle'} E-Mail. Übungsziel: ca. 80–120 Wörter.
Verbindliches Register: "${register}".
${informal
  ? 'Der Empfänger ist eine Freundin, ein Freund oder ein Familienmitglied. Verwende einen Vornamen und durchgehend du/dir/dein im Muster und in den Tipps. Passende Anrede: Liebe Anna / Lieber Max; Gruß: Liebe Grüße.'
  : 'Der Empfänger ist eine Person, die man siezt, zum Beispiel eine Kursleiterin oder ein Vermieter. Verwende durchgehend Sie/Ihnen/Ihr im Muster und in den Tipps. Passende Anrede: Sehr geehrte Frau / Sehr geehrter Herr; Gruß: Mit freundlichen Grüßen.'}
Die Situation ist klar: Wer schreibt an wen, und warum? Es gibt genau VIER Leitpunkte,
die alle behandelt werden müssen. Die Aufgabenanweisungen dürfen den Prüfling mit Sie ansprechen;
der zu schreibende Text richtet sich aber eindeutig im vorgegebenen Register an den Empfänger.

${JSON_RULES}

{
  "situation": "2–3 Sätze: Wer sind Sie, an wen schreiben Sie, was ist der Anlass.",
  "adressat": "${informal ? 'Ihre Freundin Anna (du)' : 'Ihre Kursleiterin Frau Berger (Sie)'}",
  "register": "${register}",
  "leitpunkte": ["...", "...", "...", "..."],
  "tipps": ["kurzer Tipp auf Deutsch", "...", "..."]
}`,
    temperature: 1.05,
    maxTokens: 1200,
  });

  const leitpunkte = asArray(raw?.leitpunkte).map((point) => typeof point === 'string' ? point.trim() : '');
  if (!raw?.situation || !raw?.adressat || leitpunkte.length !== 4 || leitpunkte.some((point) => !point)) {
    throw new Error('Schreibaufgabe unvollständig: vier Leitpunkte erforderlich');
  }
  if (raw.register !== register) throw new Error('Schreibaufgabe hat nicht das angeforderte Register');
  return {
    id: `sa_${Date.now()}`,
    partId: 'SA1',
    topic: t,
    situation: String(raw.situation),
    adressat: String(raw.adressat || ''),
    register,
    leitpunkte,
    tipps: asArray(raw.tipps).map(String).slice(0, 4),
    criteria: WRITING_CRITERIA,
    difficulty,
    source: 'ai',
  };
}

const OFFLINE_WRITING_TASKS = {
  du: [
    {
      topic: 'Besuch einer Freundin',
      situation: 'Ihre Freundin Anna möchte Sie im nächsten Monat besuchen. Sie fragt, wann sie kommen kann und was Sie gemeinsam unternehmen können. Antworten Sie ihr per E-Mail.',
      adressat: 'Ihre Freundin Anna (du)',
      leitpunkte: [
        'Schlagen Sie einen Termin für den Besuch vor.',
        'Erklären Sie, wie Anna am besten zu Ihnen kommt.',
        'Beschreiben Sie, wo Anna übernachten kann.',
        'Schlagen Sie gemeinsame Aktivitäten vor.',
      ],
    },
    {
      topic: 'Geburtstag eines Freundes',
      situation: 'Ihr Freund Max hat Sie zu seiner Geburtstagsfeier eingeladen. Sie möchten kommen, können aber erst später da sein. Antworten Sie auf seine Einladung.',
      adressat: 'Ihr Freund Max (du)',
      leitpunkte: [
        'Bedanken Sie sich für die Einladung und sagen Sie zu.',
        'Erklären Sie, warum Sie später kommen.',
        'Sagen Sie, wann Sie ungefähr ankommen.',
        'Fragen Sie, was Sie für die Feier mitbringen können.',
      ],
    },
    {
      topic: 'Umzug und Hilfe',
      situation: 'Sie ziehen bald in eine neue Wohnung. Ihre Freundin Julia hat Ihnen Hilfe angeboten und möchte wissen, was noch zu tun ist. Schreiben Sie ihr eine E-Mail.',
      adressat: 'Ihre Freundin Julia (du)',
      leitpunkte: [
        'Bedanken Sie sich für das Hilfsangebot.',
        'Beschreiben Sie Ihre neue Wohnung.',
        'Nennen Sie den Termin und den Treffpunkt für den Umzug.',
        'Erklären Sie, wobei Julia Ihnen helfen kann.',
      ],
    },
  ],
  Sie: [{
    topic: 'Sprachkurs',
    situation:
      'Sie haben einen Deutschkurs besucht und möchten sich bei Ihrer Kursleiterin bedanken. Leider konnten Sie an den letzten zwei Terminen nicht teilnehmen.',
    adressat: 'Ihre Kursleiterin Frau Berger (Sie)',
    leitpunkte: [
      'Bedanken Sie sich für den Kurs.',
      'Erklären Sie, warum Sie zweimal gefehlt haben.',
      'Fragen Sie, ob Sie die Unterlagen noch bekommen können.',
      'Fragen Sie nach einem passenden Folgekurs.',
    ],
  }, {
    topic: 'Termin mit dem Vermieter',
    situation: 'Ihr Vermieter Herr Weber möchte sich am Freitag die defekte Heizung in Ihrer Wohnung ansehen. Zu diesem Termin können Sie nicht zu Hause sein. Schreiben Sie ihm eine E-Mail.',
    adressat: 'Ihr Vermieter Herr Weber (Sie)',
    leitpunkte: [
      'Bedanken Sie sich für seine Nachricht.',
      'Beschreiben Sie das Problem mit der Heizung.',
      'Erklären Sie, warum Sie am Freitag keine Zeit haben.',
      'Schlagen Sie einen neuen Termin vor.',
    ],
  }, {
    topic: 'Ausflug mit dem Sportverein',
    situation: 'Ihre Trainerin Frau Neumann organisiert einen Ausflug mit dem Sportverein. Sie möchten teilnehmen und brauchen noch einige Informationen. Schreiben Sie ihr eine E-Mail.',
    adressat: 'Ihre Trainerin Frau Neumann (Sie)',
    leitpunkte: [
      'Sagen Sie, dass Sie am Ausflug teilnehmen möchten.',
      'Fragen Sie nach dem Treffpunkt und der Abfahrtszeit.',
      'Fragen Sie nach den Kosten.',
      'Bieten Sie Hilfe bei der Vorbereitung an.',
    ],
  }],
};

export function offlineWritingTask({ register = 'du', variantIndex = 0, difficulty = 58 } = {}) {
  const pool = OFFLINE_WRITING_TASKS[register] || OFFLINE_WRITING_TASKS.du;
  const index = Number.isSafeInteger(variantIndex) && variantIndex >= 0 ? variantIndex % pool.length : 0;
  const task = pool[index];
  const informal = register !== 'Sie';
  return {
    ...task,
    id: `sa_off_${Date.now()}`,
    partId: 'SA1',
    register: informal ? 'du' : 'Sie',
    leitpunkte: [...task.leitpunkte],
    tipps: [
      informal ? 'Persönliche Anrede: "Liebe Anna," oder "Lieber Max," – verwenden Sie den Namen aus der Aufgabe.' : 'Höfliche Anrede mit dem Namen aus der Aufgabe: "Sehr geehrte Frau …," / "Sehr geehrter Herr …,"',
      informal ? 'Schreiben Sie durchgehend du, dir und dein.' : 'Schreiben Sie durchgehend Sie, Ihnen und Ihr.',
      'Alle vier Leitpunkte ausdrücklich behandeln.',
      informal ? 'Passende Grußformel: "Liebe Grüße" oder "Viele Grüße"' : 'Passende Grußformel: "Mit freundlichen Grüßen"',
    ],
    criteria: WRITING_CRITERIA,
    difficulty,
    source: 'offline',
  };
}

export async function gradeWriting({ task, text, analysis }) {
  const lps = (task?.leitpunkte || []).map((l, i) => `${i + 1}. ${l}`).join('\n');
  const raw = await callAI({
    system: `${AUTHOR} Du bist jetzt Prüfer und bewertest nach den telc-B1-Kriterien. Sei fair, aber streng; lobe nicht, was falsch ist.`,
    user: `Bewerte diesen Text einer telc-B1-Schreibaufgabe.

AUFGABE
Situation: ${task?.situation || ''}
Adressat: ${task?.adressat || ''} (Register: ${task?.register || 'Sie'})
Leitpunkte:
${lps}

TEXT DES KANDIDATEN
"""
${String(text || '').slice(0, 4000)}
"""

Automatische Voranalyse: ${analysis?.words || 0} Wörter, Register erkannt: ${analysis?.register || '?'},
Verbindungswörter: ${(analysis?.usedConnectors || []).join(', ') || 'keine'}.

Bewerte auf einer Skala von 0 bis 100 je Kriterium und schätze die Punkte für telc (max. 15/10/12/8 = 45 gesamt).
Liste ALLE konkreten Fehler mit Korrektur auf. Wenn der Text zu kurz ist, sag das deutlich.
Bewerte Anrede, Pronomen und Grußformel passend zum Register der Aufgabe (${task?.register || 'Sie'}).
Bei du sind eine persönliche Anrede und Liebe Grüße / Viele Grüße passend. Verlange dann keine formelle Anrede.
Das Muster muss dasselbe Register verwenden. Gib für jeden der ${task?.leitpunkte?.length || 4} Leitpunkte genau einen Wahrheitswert zur Abdeckung zurück.

${JSON_RULES}

{
  "criteria": [
    {"key":"aufgabe","score":0-100,"points":0-15,"comment":"..."},
    {"key":"kommunikation","score":0-100,"points":0-10,"comment":"..."},
    {"key":"richtigkeit","score":0-100,"points":0-12,"comment":"..."},
    {"key":"ausdruck","score":0-100,"points":0-8,"comment":"..."}
  ],
  "total": 0-45,
  "band": "sehr gut | gut | befriedigend | ausreichend | nicht bestanden",
  "leitpunkteCovered": [true,false,true,true],
  "corrections": [{"original":"...","corrected":"...","explanation":"..."}],
  "strengths": ["...","..."],
  "priorities": ["die 2–3 wichtigsten nächsten Schritte"],
  "modelAnswer": "Ein vollständiger Musterbrief auf B1-Niveau (80–120 Wörter)."
}`,
    temperature: 0.4,
    maxTokens: 3500,
  });

  const criteria = asArray(raw?.criteria).map((c, i) => ({
    key: String(c?.key || WRITING_CRITERIA[i]?.key || `c${i}`),
    label: WRITING_CRITERIA.find((w) => w.key === c?.key)?.label || String(c?.key || ''),
    max: WRITING_CRITERIA.find((w) => w.key === c?.key)?.max || 10,
    score: Number(c?.score) || 0,
    points: Number(c?.points) || 0,
    comment: String(c?.comment || ''),
  }));

  const total = Number.isFinite(Number(raw?.total))
    ? Number(raw.total)
    : criteria.reduce((s, c) => s + c.points, 0);

  return {
    criteria,
    total: Math.max(0, Math.min(45, total)),
    band: String(raw?.band || ''),
    leitpunkteCovered: (task?.leitpunkte || []).map((_, i) => raw?.leitpunkteCovered?.[i] === true),
    corrections: asArray(raw?.corrections).map((c) => ({
      original: String(c?.original || ''),
      corrected: String(c?.corrected || ''),
      explanation: String(c?.explanation || ''),
    })),
    strengths: asArray(raw?.strengths).map(String),
    priorities: asArray(raw?.priorities).map(String),
    modelAnswer: String(raw?.modelAnswer || ''),
    source: 'ai',
  };
}

/* -------------------------------------------------------------- speaking */

const SPEAKING_BRIEF = {
  SP1: `Teil 1 – Präsentation. Der Kandidat hält ca. 3 Minuten einen Kurzvortrag zu einem Thema,
gestützt auf 4–6 Stichwörter, und beantwortet danach eine Anschlussfrage des Partners.`,
  SP2: `Teil 2 – Diskussion. Der Kandidat diskutiert mit dem Partner über ein kontroverses Thema:
eigene Meinung, Begründung, Beispiel, Reaktion auf den Partner.`,
  SP3: `Teil 3 – Gemeinsam etwas planen. Der Kandidat plant mit dem Partner eine Aktivität
und muss sich am Ende einigen: Vorschläge machen, Alternativen abwägen, zustimmen oder ablehnen, Entscheidung festhalten.`,
};

export async function genSpeakingTask(partId, { difficulty = 56 } = {}) {
  const t = pickFrom(ORAL_THEMES);
  const raw = await callAI({
    system: AUTHOR,
    user: `Erstelle EINE Aufgabe für die mündliche telc-B1-Prüfung.

Aufgabentyp: ${SPEAKING_BRIEF[partId] || SPEAKING_BRIEF.SP1}
Thema: ${t}. Schwierigkeit: ${levelWord(difficulty)}.

Gib außerdem 8–10 passende Redemittel, die ein B1-Kandidat hier wirklich benutzen würde,
und eine vollständige Musterantwort (die der Kandidat laut lesen könnte, ca. 120–180 Wörter).

${JSON_RULES}

{
  "title": "...",
  "situation": "Was der Kandidat tun soll, auf Deutsch.",
  "keywords": ["4–6 Stichwörter, wie auf der telc-Aufgabenkarte"],
  "questions": ["Anschlussfrage(n) des Partners"],
  "redemittel": ["...", 8–10 Stück],
  "modelAnswer": "... 120–180 Wörter ...",
  "tipps": ["...","..."]
}`,
    temperature: 1.05,
    maxTokens: 2500,
  });

  if (!raw?.situation) throw new Error('Sprechaufgabe unvollständig');
  return {
    id: `sp_${Date.now()}`,
    partId,
    topic: t,
    title: String(raw.title || ''),
    situation: String(raw.situation),
    keywords: asArray(raw.keywords).map(String).slice(0, 6),
    questions: asArray(raw.questions).map(String).slice(0, 3),
    redemittel: asArray(raw.redemittel).map(String).slice(0, 10),
    modelAnswer: String(raw.modelAnswer || ''),
    tipps: asArray(raw.tipps).map(String).slice(0, 4),
    difficulty,
    source: 'ai',
  };
}

export function offlineSpeakingTask(partId = 'SP1') {
  const bank = {
    SP1: {
      title: 'Meine Heimatstadt',
      situation: 'Präsentieren Sie Ihre Heimatstadt oder Ihren Wohnort. Sprechen Sie ca. 3 Minuten.',
      keywords: ['Lage', 'Größe', 'Sehenswürdigkeiten', 'Vor- und Nachteile', 'warum ich dort gern lebe'],
      questions: ['Würden Sie gern für immer dort bleiben? Warum?'],
      redemittel: ['Ich möchte Ihnen kurz … vorstellen.', 'Die Stadt liegt im Norden von …', 'Besonders bekannt ist …', 'Ein Vorteil ist, dass …', 'Andererseits muss ich sagen, dass …', 'Zusammenfassend kann man sagen, dass …'],
      modelAnswer: 'Ich möchte Ihnen meine Heimatstadt vorstellen. Sie liegt im Süden des Landes und hat etwa 200.000 Einwohner. Besonders bekannt ist der alte Marktplatz, wo jeden Samstag ein Wochenmarkt stattfindet. Ein großer Vorteil ist, dass alles gut zu Fuß erreichbar ist und die Mieten noch bezahlbar sind. Andererseits gibt es wenig Arbeitsplätze, deshalb pendeln viele Menschen in die nächste Großstadt. Ich lebe gern dort, weil meine Familie und meine Freunde in der Nähe sind. Zusammenfassend kann man sagen, dass meine Heimatstadt ruhig, aber nie langweilig ist.',
      tipps: ['Mit einer Begrüßung beginnen.', 'Pro Stichwort 2–3 Sätze sprechen.', 'Am Ende kurz zusammenfassen.'],
    },
    SP2: {
      title: 'Handyverbot in Schulen',
      situation: 'Diskutieren Sie mit Ihrem Partner: Sollten Handys in der Schule verboten werden? Nennen Sie Ihre Meinung und begründen Sie sie.',
      keywords: ['Meinung', 'Argument dafür', 'Argument dagegen', 'eigenes Beispiel', 'Fazit'],
      questions: ['Und was meinen Sie dazu?', 'Haben Sie selbst Erfahrungen damit gemacht?'],
      redemittel: ['Ich bin der Meinung, dass …', 'Ein wichtiges Argument dafür ist, dass …', 'Auf der anderen Seite …', 'Da stimme ich Ihnen teilweise zu, aber …', 'Ich sehe das anders, weil …', 'Für mich überwiegt am Ende …'],
      modelAnswer: 'Ich bin der Meinung, dass ein komplettes Handyverbot in Schulen zu streng ist. Ein wichtiges Argument dafür ist, dass Handys die Konzentration stören und im Unterricht ablenken. Auf der anderen Seite brauchen viele Schüler ihr Handy für den Schulweg und für den Notfall. Da stimme ich Ihnen teilweise zu, aber ein Verbot löst das Problem nicht wirklich. Ich sehe das anders, weil man den Schülern besser beibringen sollte, verantwortungsvoll mit dem Handy umzugehen. Für mich überwiegt am Ende eine klare Regel: Handys aus während des Unterrichts, aber erlaubt in den Pausen.',
      tipps: ['Immer begründen, nicht nur behaupten.', 'Auf den Partner reagieren: "Da stimme ich dir zu, aber …"'],
    },
    SP3: {
      title: 'Ein Abschiedsfest planen',
      situation: 'Ihr Deutschkurs endet bald. Planen Sie mit Ihrem Partner ein Abschiedsfest und einigen Sie sich auf die wichtigsten Punkte.',
      keywords: ['Wann?', 'Wo?', 'Was essen und trinken?', 'Wer macht was?', 'Geschenk für die Kursleiterin'],
      questions: ['Welcher Termin passt Ihnen besser?', 'Wer übernimmt was?'],
      redemittel: ['Ich hätte einen Vorschlag: …', 'Wie wäre es, wenn wir …?', 'Das finde ich gut, aber …', 'Sollen wir also …?', 'Dann machen wir es so.', 'Ich könnte mich um … kümmern.'],
      modelAnswer: 'Ich hätte einen Vorschlag: Wie wäre es, wenn wir das Fest am letzten Kurstag nach dem Unterricht feiern? Als Ort würde ich den Kursraum vorschlagen, weil wir dort keine Miete bezahlen müssen. Für das Essen könnten wir etwas mitbringen – jeder etwas aus seinem Land. Das finde ich gut, aber wir brauchen auch Getränke, deshalb kümmere ich mich um Wasser und Saft. Sollen wir außerdem ein Geschenk für die Kursleiterin besorgen? Ja, gerne. Dann machen wir es so: Ich sammle fünf Euro von jedem ein und kaufe eine Blume und eine Karte.',
      tipps: ['Vorschläge machen, nicht nur fragen.', 'Am Ende die Entscheidung zusammenfassen.'],
    },
  };
  return { id: `sp_off_${Date.now()}`, partId, ...bank[partId] || bank.SP1, difficulty: 56, source: 'offline' };
}

function validSpeakingFeedback(raw) {
  const keys = ['struktur', 'wortschatz', 'fluessigkeit', 'interaktion'];
  const text = (value) => typeof value === 'string' && Boolean(value.trim());
  return typeof raw.points === 'number' && Number.isFinite(raw.points) && raw.points >= 0 && raw.points <= 25
    && text(raw.band) && Array.isArray(raw.criteria)
    && keys.every((key) => {
      const matches = raw.criteria.filter((criterion) => criterion?.key === key);
      const criterion = matches[0];
      return matches.length === 1 && typeof criterion.score === 'number' && Number.isFinite(criterion.score)
        && criterion.score >= 0 && criterion.score <= 100 && text(criterion.comment);
    })
    && Array.isArray(raw.corrections) && raw.corrections.every((item) => item && text(item.original) && text(item.corrected) && text(item.explanation))
    && Array.isArray(raw.betterPhrases) && raw.betterPhrases.every((item) => item && text(item.said) && text(item.better))
    && Array.isArray(raw.strengths) && raw.strengths.every(text)
    && Array.isArray(raw.priorities) && raw.priorities.every(text);
}

export async function gradeSpeaking({ task, transcript, partId, durationSec }) {
  const raw = await callAI({
    system: `${AUTHOR} Du bist jetzt mündlicher Prüfer bei telc B1. Bewerte das Transkript.`,
    user: `Bewerte diese mündliche Leistung (telc B1, ${partId}).

AUFGABE
${task?.situation || ''}
${(task?.keywords || []).length ? `Stichwörter: ${task.keywords.join(', ')}` : ''}

TRANSKRIPT (automatisch erkannt, kann Erkennungsfehler enthalten – bewerte nicht die Erkennungsfehler)
"""
${String(transcript || '').slice(0, 4000)}
"""

Sprechdauer: ${durationSec ? `${Math.round(durationSec)} Sekunden` : 'unbekannt'}.

WICHTIG: Aussprache lässt sich aus einem Transkript NICHT beurteilen. Setze "aussprache" auf null
und erkläre das im Kommentar.

Bewerte je Kriterium 0–100 und schätze Punkte für telc (Sprechen ist insgesamt 75 Punkte, hier max. 25 für diesen Teil).
Verwende konkrete Zahlen, keine Ausdrücke wie 0-100. Das JSON unten zeigt nur das Format;
vergib die Werte anhand des Transkripts. Halte Kommentare kurz, nenne höchstens 6 wichtige
Korrekturen, 3 bessere Formulierungen, 3 Stärken und 3 nächste Schritte. Gib auch leere Listen als [] zurück.

${JSON_RULES}

{
  "criteria": [
    {"key":"struktur","score":70,"comment":"..."},
    {"key":"wortschatz","score":65,"comment":"..."},
    {"key":"fluessigkeit","score":60,"comment":"..."},
    {"key":"interaktion","score":70,"comment":"..."},
    {"key":"aussprache","score":null,"comment":"Aus Transkript nicht beurteilbar."}
  ],
  "points": 17,
  "band": "sehr gut | gut | befriedigend | ausreichend | nicht bestanden",
  "corrections": [{"original":"...","corrected":"...","explanation":"..."}],
  "betterPhrases": [{"said":"...","better":"..."}],
  "strengths": ["..."],
  "priorities": ["..."]
}`,
    temperature: 0.4,
    maxTokens: 4096,
    validate: validSpeakingFeedback,
  });

  const points = Number(raw?.points);
  return {
    criteria: asArray(raw?.criteria).filter((c) => ['struktur', 'wortschatz', 'fluessigkeit', 'interaktion', 'aussprache'].includes(c?.key)).map((c) => ({
      key: String(c?.key || ''),
      score: c?.key === 'aussprache' || c?.score === null || c?.score === undefined ? null : Number(c.score),
      comment: String(c?.comment || ''),
    })),
    points: Number.isFinite(points) ? Math.max(0, Math.min(25, points)) : null,
    band: String(raw?.band || ''),
    corrections: asArray(raw?.corrections).map((c) => ({
      original: String(c?.original || ''),
      corrected: String(c?.corrected || ''),
      explanation: String(c?.explanation || ''),
    })),
    betterPhrases: asArray(raw?.betterPhrases).map((c) => ({ said: String(c?.said || ''), better: String(c?.better || '') })),
    strengths: asArray(raw?.strengths).map(String),
    priorities: asArray(raw?.priorities).map(String),
    source: 'ai',
  };
}

/**
 * Explain how one sentence is built: the role of each part, the case in each noun
 * group, and why the verb sits where it does. Complements the instant offline
 * analyser in satzbau.js rather than replacing it.
 */
export async function explainSentence({ sentence, analysis }) {
  const outline = (analysis?.clauses || [])
    .map((c, i) => `Teilsatz ${i + 1}: Typ ${c.type}, konjugiertes Verb "${c.finite || '?'}", Vorfeld "${c.vorfeld || '-'}"`)
    .join('\n');

  const raw = await callAI({
    system: `${AUTHOR} Du erklärst jetzt, wie ein deutscher Satz gebaut ist.`,
    user: `Erkläre den folgenden Satz für einen Lernenden auf B1-Niveau.

SATZ: "${String(sentence).slice(0, 400)}"

Automatische Voranalyse:
${outline || '(keine)'}

Erkläre der Reihe nach:
1. jeden Satzteil und seine Funktion (Subjekt, konjugiertes Verb, Objekt, Angabe),
2. welcher Fall in jeder Nominalgruppe steht und warum,
3. wo das konjugierte Verb steht und welche Regel das erklärt (Zweitstellung, Verb am Satzende, Satzklammer),
4. ob der Satz korrekt ist, und wenn nicht, was genau geändert werden muss.

${JSON_RULES}

{
  "correct": true,
  "corrected": "der korrigierte Satz, oder ein leerer String wenn er schon korrekt ist",
  "summary": "ein kurzer deutscher Satz, der das Wichtigste zusammenfasst",
  "parts": [{"text":"...","role":"Subjekt","case":"Nominativ","why":"kurze Begründung"}],
  "verbNote": "wo das konjugierte Verb steht und warum",
  "corrections": [{"original":"...","corrected":"...","explanation":"..."}]
}`,
    temperature: 0.3,
    maxTokens: 1600,
  });

  return {
    correct: raw?.correct !== false,
    corrected: String(raw?.corrected || ''),
    summary: String(raw?.summary || ''),
    parts: asArray(raw?.parts).map((p) => ({
      text: String(p?.text || ''),
      role: String(p?.role || ''),
      caseName: String(p?.case || ''),
      why: String(p?.why || ''),
    })),
    verbNote: String(raw?.verbNote || ''),
    corrections: asArray(raw?.corrections).map((c) => ({
      original: String(c?.original || ''),
      corrected: String(c?.corrected || ''),
      explanation: String(c?.explanation || ''),
    })),
  };
}

/** Turn free text the learner typed (no mic) into something the grader can read. */
export async function coachDrillAnswer({ prompt, correctAnswer, yourAnswer, tag }) {
  try {
    const raw = await callAI({
      system: `${AUTHOR} Du erklärst einem Lernenden genau einen Fehler – kurz, konkret, freundlich.`,
      user: `Aufgabe: ${prompt}
Richtige Lösung: ${correctAnswer}
Antwort des Lernenden: ${yourAnswer}
Grammatikthema: ${(TAGS[tag] || {}).label || tag}

Erkläre in 2–3 kurzen deutschen Sätzen, warum die richtige Lösung richtig ist, und gib ein zweites Beispiel.
${JSON_RULES}
{"explanation":"...","example":"..."}`,
      temperature: 0.5,
      maxTokens: 500,
    });
    return { explanation: String(raw?.explanation || ''), example: String(raw?.example || '') };
  } catch {
    return null;
  }
}
