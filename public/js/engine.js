/**
 * The adaptive engine.
 *
 * Two ideas do the heavy lifting:
 *
 *  1. Target difficulty. For any node we ask for an item slightly harder than the
 *     learner's current estimate (theta + 8), which lands near a 70% success rate.
 *     That is the band where learning is fastest - hard enough to matter, easy
 *     enough not to discourage.
 *
 *  2. Priority. Which node gets drilled next is a function of how big the gap is,
 *     how little evidence we have, how stale it is, and how many exam points the
 *     node drives. Writing and speaking carry more points per task, so they float up.
 */

import { PARTS, SUBTEST_ORDER, GENERATABLE_TAGS, GROUPS, WRITTEN, ORAL, TOTAL_POINTS } from './blueprint.js';
import * as store from './store.js';
import { generateDrill, OFFLINE_TAGS, vocabDrill, withVocabDistractors, finalizeCard } from './generators.js';

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Typical difficulty of the items a part actually presents in the real exam. */
export const PART_DIFFICULTY = {
  LV1: 56, LV2: 56, LV3: 60,
  SB1: 54, SB2: 58,
  HV1: 58, HV2: 58, HV3: 55,
  SA1: 60,
  SP1: 55, SP2: 58, SP3: 55,
};

const SCALE = 18;

function expectedScore(theta, difficulty) {
  return 1 / (1 + Math.pow(10, (difficulty - theta) / SCALE));
}

/* ------------------------------------------------------------- targeting */

/** The difficulty we want the next item at, for a given node. */
export function targetDifficulty(nodeId) {
  const theta = store.masteryOf(nodeId);
  return clamp(theta + 8, 15, 92);
}

function weightedPick(entries) {
  const total = entries.reduce((s, e) => s + Math.max(0, e.score), 0);
  if (total <= 0) return entries[Math.floor(Math.random() * entries.length)] || null;
  let r = Math.random() * total;
  for (const e of entries) {
    r -= Math.max(0, e.score);
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

/**
 * Choose what to drill next.
 * @param {{avoid?:string[], requireGeneratable?:boolean, focusTags?:string[]}} opts
 */
export function pickTag(opts = {}) {
  const avoid = new Set(opts.avoid || []);
  const candidates = [];
  const seen = new Set();

  for (const w of store.weakNodes({ limit: 14, prefix: 'tag:' })) {
    const tag = w.id.slice(4);
    if (!GENERATABLE_TAGS.includes(tag)) continue;
    seen.add(tag);
    candidates.push({ tag, score: w.priority, reason: w.n < 3 ? 'neu' : 'schwach' });
  }

  for (const tag of OFFLINE_TAGS) {
    if (seen.has(tag) || !GENERATABLE_TAGS.includes(tag)) continue;
    seen.add(tag);
    candidates.push({ tag, score: 38, reason: 'ungeübt' });
  }

  if (opts.focusTags && opts.focusTags.length) {
    for (const c of candidates) {
      if (opts.focusTags.includes(c.tag)) c.score *= 2.2;
    }
  }

  const pool = candidates.filter((c) => !avoid.has(c.tag));
  const use = pool.length ? pool : candidates;

  const chosen = weightedPick(use);
  if (!chosen) return { tag: 'konnektoren', reason: 'fallback' };
  return chosen;
}

/**
 * Build a drill session: a spread of items that leans on weaknesses.
 * Consecutive items never repeat the same tag, so a session feels varied.
 */
export function buildDrillSession(size = 10) {
  const out = [];
  const recent = [];
  const usedPrompts = new Set();
  const coverage = new Map();

  for (let i = 0; i < size; i++) {
    const info = pickTag({ avoid: recent.slice(-3) });
    const nodeId = `tag:${info.tag}`;
    const target = targetDifficulty(nodeId);

    let card = null;
    for (let attempt = 0; attempt < 4 && !card; attempt++) {
      const c = generateDrill(info.tag, { targetDifficulty: target, avoid: [...usedPrompts] });
      if (c && !usedPrompts.has(c.prompt)) card = c;
    }
    if (!card) {
      const c = generateDrill(info.tag, { targetDifficulty: target });
      if (!c) continue;
      card = c;
    }
    usedPrompts.add(card.prompt);
    card.reason = info.reason;
    card.nodeId = nodeId;
    card.order = i + 1;
    out.push(card);
    recent.push(info.tag);
    coverage.set(info.tag, (coverage.get(info.tag) || 0) + 1);
  }
  return out;
}

/** A review session built only from due spaced-repetition cards. */
export function buildReviewSession(limit = 12) {
  const errors = store.listErrors();
  const due = store.srsDue(errors.map((e) => e.id), limit);
  const out = [];
  for (const d of due) {
    const e = errors.find((x) => x.id === d.id);
    if (!e) continue;
    out.push({
      id: `rev_${e.id}`,
      kind: 'mc3',
      partId: e.partId,
      tags: e.tags,
      difficulty: e.difficulty,
      instruction: 'Wiederholung – dieselbe Aufgabe noch einmal.',
      prompt: e.prompt,
      options: [],
      answer: e.correctAnswer,
      explanation: e.explanation,
      source: 'review',
      errorId: e.id,
      freeform: true,
    });
  }
  return out;
}

/** Vocab cards, spaced-repetition ordered. */
/**
 * Build an SRS-ordered card session from any deck.
 * @param {Array} deck
 * @param {number} size
 * @param {{keyOf?:Function, modeOf?:Function}} opts
 *   keyOf gives each entry a stable spaced-repetition key (the general deck keys on
 *   the headword, the curated exam-core pack on its own id).
 *   modeOf can force a card direction; long formulae are recognition-only, because
 *   asking someone to reproduce a whole memorised phrase from English is not useful.
 */
export function buildVocabSession(deck, size = 15, opts = {}) {
  if (!Array.isArray(deck) || !deck.length) return [];
  const keyOf = opts.keyOf || ((w) => `vocab:${w.de}`);
  const modeOf = opts.modeOf || (() => undefined);

  const byKey = new Map();
  for (const w of deck) byKey.set(keyOf(w), w);

  const due = store.srsDue([...byKey.keys()], size);
  const chosen = [];
  const used = new Set();
  for (const d of due) {
    const entry = byKey.get(d.id);
    if (entry && !used.has(d.id)) {
      used.add(d.id);
      chosen.push(entry);
    }
    if (chosen.length >= size) break;
  }
  // top up with unseen cards
  if (chosen.length < size) {
    for (const w of deck) {
      const k = keyOf(w);
      if (used.has(k)) continue;
      if (store.srsCard(k)) continue;
      used.add(k);
      chosen.push(w);
      if (chosen.length >= size) break;
    }
  }

  return chosen.map((entry) => {
    const mode = modeOf(entry);
    const card = finalizeCard(vocabDrill(entry, mode)) || vocabDrill(entry, mode);
    const c = withVocabDistractors(card, deck, card.needsDistractors);
    c.vocabKey = keyOf(entry);
    c.entry = entry;
    return finalizeCard(c);
  });
}

/** Card direction for curated exam-core items. */
export function coreCardMode(entry) {
  const words = String(entry?.de || '').trim().split(/\s+/).filter(Boolean).length;
  if (entry?.pos === 'noun') return undefined; // let vocabDrill mix article and meaning
  if (words >= 3) return 'de-en';              // full formulae: recognise, do not reproduce
  return undefined;
}

/* --------------------------------------------------------------- scoring */

/** telc gives every item inside a part the same weight. */
export function pointsFor(partId, correctCount, totalItems) {
  const part = PARTS[partId];
  if (!part || !totalItems) return 0;
  return (part.pts * correctCount) / totalItems;
}

export function emptyScorecard() {
  const card = {};
  for (const id of SUBTEST_ORDER) card[id] = { correct: 0, total: 0 };
  return card;
}

/**
 * Convert a scorecard into telc points.
 * @param {object} card
 * @param {object} [overrides] optional exact points per part, used for Schreiben
 *   and Sprechen where a rubric score replaces the right/wrong arithmetic.
 */
export function scorecardToPoints(card, overrides = {}) {
  const byPart = {};
  let written = 0;
  let oral = 0;
  for (const id of SUBTEST_ORDER) {
    const entry = card[id];
    const hasOverride = Number.isFinite(overrides[id]);
    if ((!entry || !entry.total) && !hasOverride) continue;
    const pts = hasOverride
      ? Math.max(0, Math.min(PARTS[id].pts, overrides[id]))
      : pointsFor(id, entry.correct, entry.total);
    byPart[id] = {
      points: pts,
      max: PARTS[id].pts,
      correct: entry?.correct ?? 0,
      total: entry?.total ?? 0,
      rubric: hasOverride,
    };
    const group = GROUPS.find((g) => g.id === PARTS[id].group);
    if (group.mode === 'written') written += pts;
    else oral += pts;
  }
  return {
    byPart,
    written: { points: written, max: WRITTEN.total, pass: WRITTEN.pass, ok: written >= WRITTEN.pass },
    oral: { points: oral, max: ORAL.total, pass: ORAL.pass, ok: oral >= ORAL.pass },
    total: written + oral,
    totalMax: TOTAL_POINTS,
    passed: written >= WRITTEN.pass && oral >= ORAL.pass,
  };
}

export function gradeBand(percent) {
  if (percent >= 90) return { label: 'sehr gut', tone: 'great' };
  if (percent >= 80) return { label: 'gut', tone: 'good' };
  if (percent >= 70) return { label: 'befriedigend', tone: 'ok' };
  if (percent >= 60) return { label: 'ausreichend', tone: 'pass' };
  return { label: 'nicht bestanden', tone: 'bad' };
}

/* ------------------------------------------------------------- readiness */

/**
 * Predicted exam result from the current ability estimates.
 * Honest about uncertainty: a node with three data points barely moves the number.
 */
export function readiness() {
  const byPart = [];
  let written = 0;
  let oral = 0;
  let evidence = 0;
  let nodeCount = 0;

  for (const id of SUBTEST_ORDER) {
    const nodeId = `skill:${id}`;
    const theta = store.masteryOf(nodeId);
    const difficulty = PART_DIFFICULTY[id] ?? 56;
    const expected = expectedScore(theta, difficulty);
    const pts = PARTS[id].pts * expected;
    const group = GROUPS.find((g) => g.id === PARTS[id].group);
    if (group.mode === 'written') written += pts;
    else oral += pts;
    const conf = store.confidenceOf(nodeId);
    evidence += conf;
    nodeCount += 1;
    byPart.push({
      id,
      label: PARTS[id].label,
      theta,
      confidence: conf,
      expected,
      points: pts,
      max: PARTS[id].pts,
      group: PARTS[id].group,
      attempts: store.nodeOf(nodeId)?.n || 0,
    });
  }

  const confidence = nodeCount ? evidence / nodeCount : 0;
  return {
    written: { points: written, max: WRITTEN.total, pass: WRITTEN.pass, ok: written >= WRITTEN.pass },
    oral: { points: oral, max: ORAL.total, pass: ORAL.pass, ok: oral >= ORAL.pass },
    total: written + oral,
    totalMax: TOTAL_POINTS,
    percent: ((written + oral) / TOTAL_POINTS) * 100,
    band: gradeBand(((written + oral) / TOTAL_POINTS) * 100),
    confidence,
    byPart: byPart.sort((a, b) => a.expected - b.expected),
  };
}

/* ------------------------------------------------------------ study plan */

/**
 * Days remaining, counted in whole calendar days.
 *
 * This deliberately does NOT measure elapsed milliseconds to a 09:00 anchor: doing
 * that made the answer depend on the time of day. Opening the app at 08:00 gave one
 * more day than opening it at 10:00, which pushed the exam day itself into the study
 * plan and scheduled the taper on the morning of the exam.
 */
export function examCountdown(examDate) {
  const iso = examDate || store.getState().settings.examDate;
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const target = new Date(year, month, day, 9, 0, 0);
  if (Number.isNaN(target.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const examDay = new Date(year, month, day);
  // Math.round absorbs the +/-1h of a DST change between the two midnights.
  const days = Math.round((examDay.getTime() - today.getTime()) / 86400000);
  return { date: iso, days, target, past: days < 0 };
}

/**
 * How many study days the learner actually has left. Capped so a distant exam
 * does not produce an unusably long plan.
 */
export function planHorizon({ examDate = null, max = 14, fallback = 7 } = {}) {
  const countdown = examCountdown(examDate);
  if (countdown && !countdown.past) return Math.max(1, Math.min(countdown.days, max));
  return fallback;
}

/**
 * A day-by-day plan that front-loads the parts worth the most points and the tags
 * with the biggest gaps, runs a full timed rehearsal on the second-to-last day, and
 * tapers on the last day so nothing new is crammed the night before.
 *
 * Each entry carries its real calendar date, because "Tag 3" means nothing when you
 * are counting down to a specific Saturday.
 */
export function studyPlan({ days = 7, minutesPerDay = 60, examDate = null } = {}) {
  const weakTagsList = store.weakNodes({ limit: 10, prefix: 'tag:' });
  const tagQueue = weakTagsList.length
    ? weakTagsList.map((w) => w.id.slice(4))
    : OFFLINE_TAGS.slice(0, 10);

  // Only the receptive parts are scheduled here. Schreiben and Sprechen have their
  // own blocks in the rotation below, so including them would double-book the same
  // skill on the same day.
  //
  // Grouping by subtest and cycling LV -> SB -> HV guarantees that no subtest is
  // starved: pure "biggest gap first" ordering kept picking Leseverstehen parts and
  // left Sprachbausteine without a single full-part run in a short plan.
  const byGroup = { LV: [], SB: [], HV: [] };
  for (const id of SUBTEST_ORDER) {
    const group = PARTS[id].group;
    if (!byGroup[group]) continue;
    const theta = store.masteryOf(`skill:${id}`);
    byGroup[group].push({ id, gap: (100 - theta) * (PARTS[id].pts / 25) });
  }
  for (const g of Object.keys(byGroup)) byGroup[g].sort((a, b) => b.gap - a.gap);
  const groupCycle = ['LV', 'SB', 'HV'];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const total = Math.max(1, days);
  const plan = [];
  let practiceDay = 0;

  for (let d = 0; d < total; d++) {
    const date = new Date(today.getTime() + d * 86400000);
    const isFinalDay = d === total - 1;
    const isRehearsalDay = total > 1 && d === total - 2;
    const tasks = [];
    let remaining = minutesPerDay;

    if (isFinalDay) {
      // Taper: consolidate only. Nothing new goes in the day before the exam.
      tasks.push({ label: 'Fehlerheft komplett durchgehen', partId: null, kind: 'review', minutes: 30 });
      tasks.push({ label: 'Redemittel und Musterbriefe laut lesen', partId: 'SP1', kind: 'speaking', minutes: 15 });
      tasks.push({ label: 'Kurze Runde: die zwei schwächsten Themen', partId: null, kind: 'drill', minutes: 15, tags: tagQueue.slice(0, 2) });
      plan.push({ day: d + 1, date, label: 'Tapering – nichts Neues', tasks, totalMinutes: 60, isTaper: true });
      continue;
    }

    if (isRehearsalDay) {
      // Written exam is 90 (Lesen + Sprachbausteine) + 30 (Hören) + 30 (Schreiben) = 150 minutes.
      tasks.push({ label: 'Kompletter Mocktest (schriftlich, 150 Min.)', partId: null, kind: 'mock', minutes: 150 });
      tasks.push({ label: 'Auswertung: die schwächsten Teile ansehen', partId: null, kind: 'review', minutes: 25 });
      plan.push({ day: d + 1, date, label: 'Generalprobe', tasks, totalMinutes: 175, isMock: true });
      continue;
    }

    // 1. Weakest part of the next receptive subtest in the cycle, practised in full.
    const grp = groupCycle[practiceDay % groupCycle.length];
    const pool = byGroup[grp];
    const partTask = pool[Math.floor(practiceDay / groupCycle.length) % pool.length];
    practiceDay += 1;
    tasks.push({
      label: `Prüfungsteil üben: ${PARTS[partTask.id]?.label || partTask.id}`,
      partId: partTask.id,
      kind: 'part',
      minutes: 25,
    });
    remaining -= 25;

    // 2. grammar / vocabulary drill on the weakest tags
    const focusTags = [];
    for (let k = 0; k < 2; k++) focusTags.push(tagQueue[(d * 2 + k) % tagQueue.length]);
    const tagMinutes = Math.max(10, Math.min(remaining, 20));
    tasks.push({ label: 'Adaptive Übungen', partId: null, kind: 'drill', minutes: tagMinutes, tags: focusTags });
    remaining -= tagMinutes;

    // 3. Rotate the skills that cannot be crammed. Listening leads the rotation
    //    because Hoerverstehen is a quarter of the total points and is the skill
    //    most candidates neglect until it is too late.
    const rotation = ['HV1', 'SA1', 'HV3', 'SP1', 'HV2', 'SP2', 'SA1', 'SP3'];
    const rot = rotation[d % rotation.length];
    const rotGroup = PARTS[rot].group;
    if (remaining >= 15) {
      const kind = rotGroup === 'SA' ? 'writing' : rotGroup === 'SP' ? 'speaking' : 'listening';
      const label =
        kind === 'writing'
          ? 'Schreiben: Brief mit Korrektur'
          : kind === 'speaking'
            ? `Sprechen: ${PARTS[rot].label}`
            : `Hören: ${PARTS[rot].label}`;
      tasks.push({ label, partId: rot, kind, minutes: Math.min(remaining, 25) });
      remaining -= Math.min(remaining, 25);
    }

    plan.push({
      day: d + 1,
      date,
      label: d === 0 ? 'Heute: Lücken schließen' : `Tag ${d + 1}`,
      tasks,
      totalMinutes: minutesPerDay - Math.max(0, remaining),
      focusTags,
    });
  }
  return plan;
}

/* ------------------------------------------------------ plan completion */

/**
 * Stable identity for a plan task, so a tick survives the plan being regenerated
 * (which happens on every render and whenever your weaknesses shift).
 */
export function taskKey(task) {
  return `${task.kind}|${task.partId || ''}|${task.label}`;
}

/**
 * Is this task done?
 *
 * Most tasks are detected from the work actually recorded that day, so finishing an
 * exercise ticks it off with no manual bookkeeping. A self-graded review session
 * leaves no attempt behind, so those are ticked by hand instead.
 */
export function isTaskDone(task, attempts = [], manual = {}) {
  if (manual[taskKey(task)]) return true;
  const any = (pred) => attempts.some(pred);
  switch (task.kind) {
    case 'part':
    case 'listening':
      return any((e) => e.partId === task.partId && e.source === 'part');
    case 'writing':
      return any((e) => e.source === 'writing');
    case 'speaking':
      return any((e) => e.source === 'speaking');
    case 'drill':
      // Any practice counts: offline items, AI items, or vocabulary cards.
      return any((e) => e.source === 'drill' || e.source === 'ai' || e.source === 'vocab');
    case 'mock':
      return any((e) => e.source === 'mock');
    default:
      return false;
  }
}

/** Per-task completion for one plan day. */
export function planDayProgress(day, attempts = [], manual = {}) {
  const tasks = (day?.tasks || []).map((task) => ({ task, done: isTaskDone(task, attempts, manual) }));
  return { tasks, done: tasks.filter((t) => t.done).length, total: tasks.length };
}

/* -------------------------------------------------- offline writing hints */

/**
 * Deterministic writing checks that work without any AI call: length, register
 * consistency, greeting/closing conventions and connector variety.
 */
export function analyseWriting(text, task) {
  const clean = String(text || '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const lower = clean.toLowerCase();
  const sentences = clean.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);

  const connectors = [
    'deshalb', 'deswegen', 'trotzdem', 'außerdem', 'zuerst', 'danach', 'schließlich',
    'weil', 'denn', 'aber', 'obwohl', 'damit', 'dass', 'wenn', 'also', 'zum beispiel',
    'einerseits', 'andererseits', 'jedoch', 'allerdings', 'darum', 'folglich',
  ];
  const usedConnectors = connectors.filter((c) => lower.includes(c));

  // Register detection. Case matters here: "Sie" (capital) is the formal address,
  // while lowercase "sie" is she/they. The Ihrer/Ihnen family is unambiguous.
  const formalMarkers = (clean.match(/\b(Sie|Ihnen|Ihr(?:e|em|en|er|es)?)\b/g) || []).length;
  const informalMarkers = (lower.match(/\b(du|dich|dir|dein(?:e|em|en|er|es)?|euch|euer|eure(?:m|n|r|s)?)\b/g) || []).length;
  const register = formalMarkers > informalMarkers * 1.5 ? 'Sie' : informalMarkers > formalMarkers * 1.5 ? 'du' : 'unklar';
  const expectedRegister = ['du', 'Sie'].includes(task?.register) ? task.register : null;
  const matchesRegister = register !== 'unklar' && (!expectedRegister || register === expectedRegister);
  const registerLabel = register === 'unklar'
    ? formalMarkers || informalMarkers ? 'du/Sie gemischt – bitte prüfen' : 'nicht eindeutig erkennbar'
    : expectedRegister && register !== expectedRegister
      ? `${register} – die Aufgabe verlangt ${expectedRegister}`
      : `${register}${expectedRegister ? ' – passend zur Aufgabe' : ''}`;

  const greeting = /^\s*(sehr geehrte|liebe|lieber|hallo|guten tag)/im.test(clean);
  const closing = /(mit freundlichen gr(ü|ue)(ß|ss)en|freundliche gr(ü|ue)(ß|e)|viele gr(ü|ue)(ß|e)|liebe gr(ü|ue)(ß|e)|alles liebe|bis bald|bis dann|tsch(ü|ue)(ß|ss)|herzliche gr(ü|ue)(ß|e))/i.test(clean);

  const leitpunkte = Array.isArray(task?.leitpunkte) ? task.leitpunkte : [];
  const covered = leitpunkte.map((lp) => {
    const keys = String(lp).toLowerCase().split(/[^a-zäöüß]+/).filter((w) => w.length > 3);
    const hits = keys.filter((k) => lower.includes(k));
    return { leitpunkt: lp, hits: hits.length, keys: keys.length, likely: keys.length ? hits.length / keys.length >= 0.34 : false };
  });

  const checks = [
    { id: 'umfang', ok: words.length >= 80 && words.length <= 160, label: `Umfang: ${words.length} Wörter (Ziel ca. 80–120)`, tag: 'sa_umfang' },
    { id: 'anrede', ok: greeting, label: greeting ? 'Anrede vorhanden' : 'Anrede fehlt (Sehr geehrte… / Liebe…)', tag: 'sa_register' },
    { id: 'gruss', ok: closing, label: closing ? 'Grußformel vorhanden' : 'Grußformel fehlt', tag: 'sa_register' },
    { id: 'register', ok: matchesRegister, label: `Register: ${registerLabel}`, tag: 'sa_register' },
    { id: 'konnektoren', ok: usedConnectors.length >= 4, label: `Verbindungswörter: ${usedConnectors.length} (${usedConnectors.slice(0, 6).join(', ') || 'keine'})`, tag: 'sa_konnektoren' },
    { id: 'leitpunkte', ok: covered.length > 0 && covered.every((c) => c.likely), label: covered.length ? `Leitpunkte erkannt: ${covered.filter((c) => c.likely).length}/${covered.length}` : 'Keine Leitpunkte hinterlegt', tag: 'sa_aufgabe' },
  ];

  const score = checks.filter((c) => c.ok).length / checks.length;
  return {
    words: words.length,
    sentences: sentences.length,
    avgSentence: sentences.length ? Math.round((words.length / sentences.length) * 10) / 10 : 0,
    register,
    usedConnectors,
    covered,
    checks,
    heuristic: score,
  };
}
