/**
 * Smoke tests for B1 Prep. Run with: npm run check
 *
 * Covers the offline logic (generators, ability model, scoring, plans) and the
 * structural integrity of the two content packs. No browser and no network needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARTS, SUBTEST_ORDER, WRITTEN, ORAL, TOTAL_POINTS, GENERATABLE_TAGS, TAGS, canonicalTag } from '../public/js/blueprint.js';
import { generateDrill, OFFLINE_TAGS, vocabDrill, finalizeCard, withVocabDistractors } from '../public/js/generators.js';
import * as engine from '../public/js/engine.js';
import * as store from '../public/js/store.js';
import { parseScript, chunkForSpeech, startDictation } from '../public/js/speech.js';
import { analyseSentence } from '../public/js/satzbau.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failures = [];
const pendingAsync = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('returned false');
    // Async checks are awaited before the summary.
    if (r && typeof r.then === 'function') {
      pendingAsync.push(
        r.then(
          () => {
            passed += 1;
            process.stdout.write('.');
          },
          (err) => {
            failed += 1;
            failures.push(`${name}: ${err.message}`);
            process.stdout.write('F');
          }
        )
      );
      return;
    }
    passed += 1;
    process.stdout.write('.');
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    process.stdout.write('F');
  }
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

console.log('\n=== B1 Prep checks ===\n');

/* ------------------------------------------------------------- blueprint */

check('blueprint: part points match group totals', () => {
  const sums = {};
  for (const id of SUBTEST_ORDER) {
    const p = PARTS[id];
    sums[p.group] = (sums[p.group] || 0) + p.pts;
  }
  eq(sums.LV, 75, 'Leseverstehen');
  eq(sums.SB, 30, 'Sprachbausteine');
  eq(sums.HV, 75, 'Hörverstehen');
  eq(sums.SA, 45, 'Schreiben');
  eq(sums.SP, 75, 'Sprechen');
  eq(sums.LV + sums.SB + sums.HV + sums.SA, WRITTEN.total, 'written total');
  eq(sums.SP, ORAL.total, 'oral total');
  eq(WRITTEN.total + ORAL.total, TOTAL_POINTS, 'grand total');
  return true;
});

check('blueprint: official item numbering ranges', () => {
  eq(PARTS.LV1.items + PARTS.LV2.items + PARTS.LV3.items, 20, 'Leseverstehen items 1-20');
  eq(PARTS.SB1.items + PARTS.SB2.items, 20, 'Sprachbausteine items 21-40');
  eq(PARTS.HV1.items + PARTS.HV2.items + PARTS.HV3.items, 20, 'Hörverstehen items 41-60');
  eq(PARTS.HV1.plays, 1, 'HV1 played once');
  eq(PARTS.HV2.plays, 2, 'HV2 played twice');
  eq(PARTS.HV3.plays, 2, 'HV3 played twice');
  return true;
});

check('blueprint: every tag referenced by a part exists', () => {
  for (const id of SUBTEST_ORDER) {
    for (const t of PARTS[id].skills || []) {
      ok(TAGS[t], `${id} references unknown tag ${t}`);
    }
  }
  return true;
});

/* ------------------------------------------------------------ generators */

check('generators: every pool item has its answer among the options', () => {
  let n = 0;
  for (const tag of OFFLINE_TAGS) {
    for (let i = 0; i < 40; i++) {
      const d = generateDrill(tag);
      ok(d, `${tag}: generator returned nothing`);
      ok(Array.isArray(d.options) && d.options.length === 3, `${tag}: needs 3 options`);
      ok(d.options.some((o) => o.text === d.answer), `${tag}: answer "${d.answer}" not in options for "${d.prompt}"`);
      ok(d.answerKey && d.options.some((o) => o.key === d.answerKey && o.text === d.answer), `${tag}: answerKey does not point at the answer`);
      ok(typeof d.explanation === 'string' && d.explanation.length > 10, `${tag}: explanation too short`);
      n += 1;
    }
  }
  ok(n >= 400, 'not enough generated items');
  return true;
});

check('generators: options are shuffled, not always in source order', () => {
  const keys = new Set();
  for (let i = 0; i < 200; i++) keys.add(generateDrill('konnektoren').answerKey);
  eq(keys.size, 3, 'answer position should vary across a, b and c');
  return true;
});

check('generators: difficulty stays inside 20-90', () => {
  for (const tag of OFFLINE_TAGS) {
    for (let i = 0; i < 25; i++) {
      const d = generateDrill(tag);
      ok(d.difficulty >= 20 && d.difficulty <= 90, `${tag}: difficulty ${d.difficulty} out of range`);
    }
  }
  return true;
});

check('generators: target difficulty biases item choice', () => {
  const easy = [];
  const hard = [];
  for (let i = 0; i < 120; i++) {
    easy.push(generateDrill('relativpronomen', { targetDifficulty: 25 }).difficulty);
    hard.push(generateDrill('relativpronomen', { targetDifficulty: 90 }).difficulty);
  }
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  ok(avg(hard) > avg(easy), `hard target (${avg(hard)}) should select harder items than easy target (${avg(easy)})`);
  return true;
});

check('generators: vocab cards produce a valid drill', () => {
  const entry = { de: 'die Erfahrung', en: 'experience', pos: 'noun', plural: 'die Erfahrungen', example: 'Ich habe viel Erfahrung.', exampleEn: 'I have a lot of experience.' };
  const art = finalizeCard(vocabDrill(entry, 'article'));
  ok(art.options.some((o) => o.text === 'die'), 'article card must include the right article');
  ok(art.options.some((o) => o.key === art.answerKey && o.text === 'die'), 'answerKey must resolve');
  const rec = withVocabDistractors(vocabDrill(entry, 'de-en'), [entry, { de: 'a', en: 'x' }, { de: 'b', en: 'y' }, { de: 'c', en: 'z' }], 'en');
  ok(rec.options.length === 3, 'recognition card needs 3 options');
  ok(rec.options.some((o) => o.text === rec.answer), 'recognition answer must be present');
  return true;
});

/* ----------------------------------------------------------- ability model */

check('store: a correct answer raises ability, a wrong one lowers it', () => {
  store.resetAll();
  store.recordAttempt({ partId: 'SB1', tags: ['konnektoren'], difficulty: 55, correct: true });
  const afterRight = store.thetaOf('tag:konnektoren');
  ok(afterRight > 50, `expected ability above 50 after a correct answer, got ${afterRight}`);
  store.recordAttempt({ partId: 'SB1', tags: ['konnektoren'], difficulty: 55, correct: false });
  const afterWrong = store.thetaOf('tag:konnektoren');
  ok(afterWrong < afterRight, 'ability should drop after a wrong answer');
  return true;
});

check('store: beating a hard item moves ability more than an easy one', () => {
  store.resetAll();
  store.recordAttempt({ partId: 'LV2', tags: ['lv_detail'], difficulty: 85, correct: true });
  const hardGain = store.thetaOf('tag:lv_detail') - 50;
  store.resetAll();
  store.recordAttempt({ partId: 'LV2', tags: ['lv_detail'], difficulty: 25, correct: true });
  const easyGain = store.thetaOf('tag:lv_detail') - 50;
  ok(hardGain > easyGain, `hard win (+${hardGain}) should beat easy win (+${easyGain})`);
  return true;
});

check('store: ability is bounded to 1-99 over a long run', () => {
  store.resetAll();
  for (let i = 0; i < 200; i++) store.recordAttempt({ partId: 'SB1', tags: ['modalverben'], difficulty: 50, correct: true });
  const hi = store.thetaOf('tag:modalverben');
  ok(hi <= 99 && hi > 80, `200 correct answers should push ability high but bounded, got ${hi}`);
  for (let i = 0; i < 400; i++) store.recordAttempt({ partId: 'SB1', tags: ['modalverben'], difficulty: 50, correct: false });
  const lo = store.thetaOf('tag:modalverben');
  ok(lo >= 1 && lo < 20, `long failure run should push ability low but bounded, got ${lo}`);
  return true;
});

check('store: repeated mistakes are not duplicated in the notebook', () => {
  store.resetAll();
  const detail = { prompt: 'Ich wohne bei ___ Eltern.', yourAnswer: 'meine', correctAnswer: 'meinen', explanation: 'Dativ' };
  store.recordAttempt({ partId: 'SB1', tags: ['praeposition_kasus'], difficulty: 55, correct: false, detail });
  store.recordAttempt({ partId: 'SB1', tags: ['praeposition_kasus'], difficulty: 55, correct: false, detail });
  eq(store.listErrors().length, 1, 'the same mistake should appear once');
  return true;
});

check('store: spaced repetition pushes the due date out on success', () => {
  store.resetAll();
  // srsGrade returns the live card object, so capture primitive snapshots.
  const first = { ...store.srsGrade('card1', true) };
  const second = { ...store.srsGrade('card1', true) };
  ok(second.due > first.due, 'a second success should schedule further out');
  const third = { ...store.srsGrade('card1', false) };
  ok(third.box < second.box, `a lapse should drop the box (${second.box} -> ${third.box})`);
  eq(third.lapses, 1, 'lapse counter should increment');
  const fourth = { ...store.srsGrade('card1', true) };
  ok(fourth.reps === 4, 'reps should count every grade');
  return true;
});

check('store: weak nodes favour low ability, low evidence and exam weight', () => {
  store.resetAll();
  for (let i = 0; i < 12; i++) store.recordAttempt({ partId: 'SB1', tags: ['modalverben'], difficulty: 55, correct: true });
  for (let i = 0; i < 12; i++) store.recordAttempt({ partId: 'SB1', tags: ['relativpronomen'], difficulty: 55, correct: false });
  const weak = store.weakNodes({ limit: 10, prefix: 'tag:' });
  eq(weak[0].id, 'tag:relativpronomen', 'the failing topic should rank as the top weakness');
  return true;
});

check('store: export/import round-trips', () => {
  store.resetAll();
  store.recordAttempt({ partId: 'LV1', tags: ['lv_global'], difficulty: 56, correct: true });
  const snapshot = store.exportJSON();
  store.resetAll();
  eq(store.getState().counters.attempts, 0, 'reset should clear attempts');
  store.importJSON(snapshot);
  eq(store.getState().counters.attempts, 1, 'import should restore attempts');
  return true;
});

/* ---------------------------------------------------------------- engine */

check('engine: a drill session never repeats a prompt within itself', () => {
  store.resetAll();
  for (let round = 0; round < 30; round++) {
    const cards = engine.buildDrillSession(10);
    eq(cards.length, 10, 'session size');
    const prompts = new Set(cards.map((c) => c.prompt));
    eq(prompts.size, 10, `duplicate prompt inside session (round ${round})`);
    for (const c of cards) ok(c.tag && c.partId, 'card missing tag or partId');
  }
  return true;
});

check('engine: consecutive cards avoid repeating the same tag', () => {
  store.resetAll();
  for (let round = 0; round < 40; round++) {
    const cards = engine.buildDrillSession(12);
    for (let i = 1; i < cards.length; i++) {
      ok(cards[i].tag !== cards[i - 1].tag, `tag repeated back to back: ${cards[i].tag}`);
    }
  }
  return true;
});

check('engine: the drill is pulled toward the weakest tag', () => {
  store.resetAll();
  for (let i = 0; i < 14; i++) {
    store.recordAttempt({ partId: 'SB1', tags: ['relativpronomen'], difficulty: 50, correct: false });
    store.recordAttempt({ partId: 'SB1', tags: ['modalverben'], difficulty: 50, correct: true });
  }
  const picks = { relativpronomen: 0, modalverben: 0 };
  for (let round = 0; round < 60; round++) {
    for (const c of engine.buildDrillSession(10)) {
      if (c.tag in picks) picks[c.tag] += 1;
    }
  }
  ok(picks.relativpronomen > picks.modalverben * 1.5,
    `weak tag should dominate: relativpronomen=${picks.relativpronomen}, modalverben=${picks.modalverben}`);
  return true;
});

check('engine: points use telc weights (LV3 items are cheaper than LV1 items)', () => {
  eq(engine.pointsFor('LV1', 5, 5), 25, 'LV1 full marks');
  eq(engine.pointsFor('LV3', 10, 10), 25, 'LV3 full marks');
  eq(engine.pointsFor('SB1', 10, 10), 15, 'SB1 full marks');
  eq(engine.pointsFor('HV2', 5, 10), 12.5, 'HV2 half marks');
  eq(engine.pointsFor('SA1', 1, 1), 45, 'SA1 full marks');
  return true;
});

check('engine: scorecard totals match the official 225/135 and 75/45', () => {
  const card = engine.emptyScorecard();
  for (const id of SUBTEST_ORDER) card[id] = { correct: PARTS[id].items, total: PARTS[id].items };
  const s = engine.scorecardToPoints(card);
  eq(Math.round(s.written.points), 225, 'written total');
  eq(Math.round(s.oral.points), 75, 'oral total');
  ok(s.written.ok && s.oral.ok, 'a perfect paper must pass both sections');

  const half = engine.emptyScorecard();
  for (const id of SUBTEST_ORDER) half[id] = { correct: 5, total: 10 };
  const h = engine.scorecardToPoints(half);
  eq(h.passed, false, '50% must not pass');

  const pass = engine.emptyScorecard();
  for (const id of SUBTEST_ORDER) pass[id] = { correct: 6, total: 10 };
  const p = engine.scorecardToPoints(pass);
  ok(p.passed, '60% in every section must pass');
  return true;
});

check('engine: grade bands follow the telc scheme', () => {
  eq(engine.gradeBand(95).label, 'sehr gut');
  eq(engine.gradeBand(85).label, 'gut');
  eq(engine.gradeBand(72).label, 'befriedigend');
  eq(engine.gradeBand(62).label, 'ausreichend');
  eq(engine.gradeBand(50).label, 'nicht bestanden');
  return true;
});

check('engine: readiness is low with no evidence and rises with success', () => {
  store.resetAll();
  const base = engine.readiness();
  ok(base.total >= 0 && base.total <= TOTAL_POINTS, 'readiness must be inside range');
  eq(base.confidence, 0, 'no evidence means zero confidence');

  store.resetAll();
  for (const id of SUBTEST_ORDER) {
    for (let i = 0; i < 12; i++) store.recordAttempt({ partId: id, tags: PARTS[id].skills || [], difficulty: engine.PART_DIFFICULTY[id], correct: true });
  }
  const trained = engine.readiness();
  ok(trained.total > base.total + 40, `consistent success should lift the prediction (${base.total} -> ${trained.total})`);
  ok(trained.confidence > 0.7, `confidence should be high after 12 attempts per part, got ${trained.confidence}`);
  return true;
});

check('engine: a weak section is flagged as failing even when the total looks fine', () => {
  store.resetAll();
  for (const id of SUBTEST_ORDER) {
    const oral = PARTS[id].group === 'SP';
    for (let i = 0; i < 14; i++) {
      store.recordAttempt({ partId: id, tags: PARTS[id].skills || [], difficulty: engine.PART_DIFFICULTY[id], correct: !oral });
    }
  }
  const r = engine.readiness();
  ok(r.written.ok, 'written section should pass');
  ok(!r.oral.ok, 'oral section should fail, so the exam is not passed');
  return true;
});

check('engine: study plan covers every productive skill and rehearses before the exam', () => {
  store.resetAll();
  const plan = engine.studyPlan({ days: 7 });
  eq(plan.length, 7, 'plan length');

  // The full rehearsal belongs on the penultimate day; the last day tapers.
  ok(plan[5].isMock, 'the second-to-last day should be the full mock');
  ok(plan[6].isTaper, 'the last day should taper rather than cram');
  ok(!plan[6].isMock, 'the taper day must not also be the mock');

  const kinds = new Set(plan.flatMap((d) => d.tasks.map((t) => t.kind)));
  for (const k of ['part', 'drill', 'writing', 'speaking', 'listening', 'mock']) {
    ok(kinds.has(k), `plan should include a "${k}" task`);
  }
  return true;
});

check('engine: a six-day plan schedules listening, not just the productive skills', () => {
  store.resetAll();
  const plan = engine.studyPlan({ days: 6 });
  const listening = plan.filter((d) => d.tasks.some((t) => t.kind === 'listening'));
  ok(listening.length >= 2, `Hoerverstehen is 75 points; expected at least 2 listening days, got ${listening.length}`);
  const covered = new Set(plan.flatMap((d) => d.tasks.filter((t) => t.kind !== 'drill').map((t) => t.partId)));
  for (const id of ['SA1', 'SP1', 'HV1']) {
    ok(covered.has(id), `six-day plan should touch ${id}`);
  }
  // Every receptive subtest must get at least one full-part run.
  const partIds = plan.flatMap((d) => d.tasks.filter((t) => t.kind === 'part').map((t) => t.partId));
  for (const g of ['LV', 'SB', 'HV']) {
    ok(partIds.some((id) => PARTS[id].group === g), `six-day plan never practises a full ${g} part`);
  }
  // No day should schedule the same exam part twice.
  for (const d of plan) {
    const ids = d.tasks.map((t) => t.partId).filter(Boolean);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    ok(!dup, `day ${d.day} (${d.label}) schedules ${dup} twice`);
  }
  return true;
});

check('engine: the mock task matches the real 150-minute written exam', () => {
  store.resetAll();
  const plan = engine.studyPlan({ days: 7 });
  const mock = plan.flatMap((d) => d.tasks).find((t) => t.kind === 'mock');
  ok(mock, 'no mock task found');
  eq(mock.minutes, 150, 'written exam is 90 + 30 + 30 minutes');
  ok(/150/.test(mock.label), `the label should state 150 minutes, got "${mock.label}"`);
  return true;
});

check('engine: every plan day carries a real calendar date', () => {
  store.resetAll();
  const plan = engine.studyPlan({ days: 6 });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < plan.length; i++) {
    ok(plan[i].date instanceof Date, `day ${i + 1} has no Date`);
    const expected = new Date(today.getTime() + i * 86400000);
    eq(plan[i].date.getTime(), expected.getTime(), `day ${i + 1} should be ${expected.toDateString()}`);
  }
  return true;
});

check('engine: a one-day plan degrades safely', () => {
  store.resetAll();
  const plan = engine.studyPlan({ days: 1 });
  eq(plan.length, 1, 'plan length');
  ok(plan[0].isTaper, 'a single remaining day should taper, never double as the mock');
  ok(!plan[0].isMock, 'a single day must not be both mock and taper');
  return true;
});

check('engine: plan horizon follows the exam date', () => {
  store.resetAll();
  const inDays = (n) => {
    const d = new Date(Date.now() + n * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  eq(engine.planHorizon({ examDate: inDays(3) }), 3, 'three days out');
  eq(engine.planHorizon({ examDate: inDays(6) }), 6, 'six days out');
  eq(engine.planHorizon({ examDate: inDays(60) }), 14, 'a distant exam is capped at 14 days');
  eq(engine.planHorizon({ examDate: '' }), 7, 'no date falls back to a week');
  return true;
});

check('engine: writing analysis catches register and length problems', () => {
  const task = { leitpunkte: ['Bedanken Sie sich für den Kurs.', 'Erklären Sie Ihre Abwesenheit.', 'Fragen Sie nach den Unterlagen.'] };
  const bad = engine.analyseWriting('Hallo ich kann nicht kommen. Tschüss', task);
  ok(bad.words < 80, 'short text should be flagged by word count');
  ok(!bad.checks.find((c) => c.id === 'umfang').ok, 'umfang check should fail');
  ok(bad.register === 'unklar' || bad.register === 'du', 'register detection should work');

  const good = engine.analyseWriting(
    'Sehr geehrte Frau Berger,\n\nich möchte mich herzlich für den Kurs bedanken, weil er mir sehr geholfen hat. ' +
    'Leider konnte ich an den letzten beiden Terminen nicht teilnehmen, denn ich war krank. Deshalb möchte ich Sie fragen, ' +
    'ob ich die Unterlagen noch bekommen könnte. Außerdem würde ich gern wissen, wann der nächste Kurs beginnt. ' +
    'Über eine kurze Antwort würde ich mich sehr freuen.\n\nMit freundlichen Grüßen\nSara',
    task
  );
  ok(good.words >= 60, 'the model text should be long enough');
  ok(good.checks.find((c) => c.id === 'anrede').ok, 'greeting should be detected');
  ok(good.checks.find((c) => c.id === 'gruss').ok, 'closing should be detected');
  eq(good.register, 'Sie', 'formal register should be detected');
  ok(good.usedConnectors.length >= 4, 'connectors should be detected');
  return true;
});

check('engine: writing feedback accepts informal salutations and sign-offs', () => {
  for (const closing of ['Liebe Grüße', 'Viele Grüße', 'Alles Liebe', 'Bis bald', 'Bis dann', 'Tschüss', 'Tschuess']) {
    const result = engine.analyseWriting(`Liebe Julia,\n\nvielen Dank für Deine Einladung. Ich freue mich auf dich!\n\n${closing}\nSara`, { register: 'du' });
    eq(result.register, 'du', 'capitalized informal address should remain informal');
    for (const id of ['anrede', 'gruss', 'register']) {
      ok(result.checks.find((c) => c.id === id).ok, `${id} should accept informal email ending with ${closing}`);
    }
  }
  return true;
});

check('engine: writing register must match the task recipient', () => {
  const informal = 'Hallo Julia, danke für deine Einladung. Ich bringe dir einen Kuchen mit. Liebe Grüße, Sara';
  const formal = 'Sehr geehrte Frau Berger, vielen Dank für Ihre Hilfe. Ich freue mich auf Ihre Antwort. Mit freundlichen Grüßen, Sara';
  for (const [text, register] of [[informal, 'Sie'], [formal, 'du']]) {
    const check = engine.analyseWriting(text, { register }).checks.find((c) => c.id === 'register');
    ok(!check.ok, 'consistent but incorrect recipient register should fail');
    ok(check.label.includes(`Aufgabe verlangt ${register}`), 'feedback should explain the expected register');
  }
  ok(engine.analyseWriting(formal, { register: 'Sie' }).checks.find((c) => c.id === 'register').ok, 'formal task should still accept formal address');
  return true;
});

check('engine: writing register handles possessive inflections and missing markers', () => {
  for (const phrase of ['deines Bruders', 'eurer Einladung', 'eurem Vorschlag', 'euren Ideen']) {
    eq(engine.analyseWriting(`Hallo Julia, wegen ${phrase} melde ich mich. Tschüss`, { register: 'du' }).register, 'du', `recognize ${phrase}`);
  }
  eq(engine.analyseWriting('Vielen Dank für die Hilfe Ihres Kollegen.', { register: 'Sie' }).register, 'Sie', 'recognize Ihres');
  const absent = engine.analyseWriting('Hallo, ich kann am Samstag kommen. Bis bald!', { register: 'du' }).checks.find((c) => c.id === 'register');
  ok(!absent.ok && absent.label.includes('nicht eindeutig'), 'missing address markers should not be described as mixed du/Sie');
  return true;
});

/* --------------------------------------------------------- content packs */

check('seed.json: all eight part keys with three sets each', () => {
  const seed = readJSON('data/seed.json');
  for (const id of ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1', 'HV2', 'HV3']) {
    ok(Array.isArray(seed[id]), `seed.${id} missing`);
    ok(seed[id].length >= 3, `seed.${id} needs at least 3 sets, has ${seed[id].length}`);
  }
  ok(/[äöüß]/.test(JSON.stringify(seed)), 'seed bank should contain real umlauts');
  return true;
});

check('seed.json: LV1 sets are internally consistent', () => {
  const seed = readJSON('data/seed.json');
  for (const s of seed.LV1) {
    eq(s.headlines.length, 10, 'LV1 needs 10 headlines');
    eq(s.texts.length, 5, 'LV1 needs 5 texts');
    const ids = new Set(s.headlines.map((h) => h.id));
    const used = new Set();
    for (const t of s.texts) {
      ok(ids.has(t.answer), `LV1 text ${t.id} points at unknown headline ${t.answer}`);
      ok(!used.has(t.answer), `LV1 headline ${t.answer} used twice`);
      used.add(t.answer);
    }
  }
  return true;
});

check('seed.json: LV3 sets include the "x" option', () => {
  const seed = readJSON('data/seed.json');
  for (const s of seed.LV3) {
    eq(s.ads.length, 12, 'LV3 needs 12 ads');
    eq(s.situations.length, 10, 'LV3 needs 10 situations');
    const ids = new Set(s.ads.map((a) => a.id));
    for (const sit of s.situations) {
      ok(sit.answer === 'x' || ids.has(sit.answer), `LV3 situation ${sit.n} points at unknown ad ${sit.answer}`);
    }
  }
  return true;
});

check('seed.json: SB letters contain the right gap placeholders', () => {
  const seed = readJSON('data/seed.json');
  for (const s of seed.SB1) {
    for (let n = 21; n <= 30; n++) {
      ok(s.letter.includes(`{${n}}`), `SB1 letter is missing placeholder {${n}}`);
      ok(s.gaps.some((g) => g.n === n), `SB1 gaps missing item ${n}`);
    }
    for (const g of s.gaps) ok(['a', 'b', 'c'].includes(g.answer), `SB1 item ${g.n} has a bad answer key`);
  }
  for (const s of seed.SB2) {
    eq(s.bank.length, 15, 'SB2 needs a 15-word bank');
    const bankIds = new Set(s.bank.map((b) => b.id));
    for (let n = 31; n <= 40; n++) {
      ok(s.letter.includes(`{${n}}`), `SB2 letter is missing placeholder {${n}}`);
    }
    for (const g of s.gaps) ok(bankIds.has(g.answer), `SB2 item ${g.n} points at unknown bank word ${g.answer}`);
    const used = new Set(s.gaps.map((g) => g.answer));
    eq(used.size, 10, 'SB2 should use 10 distinct bank words');
  }
  return true;
});

check('seed.json: listening sets have the right item counts and booleans', () => {
  const seed = readJSON('data/seed.json');
  const expect = { HV1: 5, HV2: 10, HV3: 5 };
  for (const [id, n] of Object.entries(expect)) {
    for (const s of seed[id]) {
      eq(s.items.length, n, `${id} item count`);
      ok(typeof s.script === 'string' && s.script.length > 100, `${id} script missing`);
      for (const it of s.items) ok(typeof it.answer === 'boolean', `${id} item ${it.n} answer must be boolean`);
    }
  }
  const hv2 = seed.HV2[0];
  ok(hv2.items.some((i) => i.answer) && hv2.items.some((i) => !i.answer), 'HV2 should mix true and false');
  return true;
});

check('vocab.json: 300 usable entries', () => {
  const v = readJSON('data/vocab.json');
  ok(Array.isArray(v.words), 'words[] missing');
  ok(v.words.length >= 250, `expected ~300 words, got ${v.words.length}`);
  const de = new Set(v.words.map((w) => w.de));
  eq(de.size, v.words.length, 'duplicate headwords');
  for (const w of v.words.slice(0, 400)) {
    ok(w.de && w.en && w.pos, `entry missing fields: ${JSON.stringify(w).slice(0, 80)}`);
    ok(typeof w.example === 'string' && w.example.length > 8, `entry has no example: ${w.de}`);
    if (w.pos === 'noun') ok(/^(der|die|das) /.test(w.de), `noun without article: ${w.de}`);
  }
  return true;
});

check('vocab.json: drives the SRS session builder', () => {
  store.resetAll();
  const v = readJSON('data/vocab.json');
  const cards = engine.buildVocabSession(v.words, 20);
  eq(cards.length, 20, 'vocab session size');
  for (const c of cards) {
    ok(c.vocabKey && c.vocabKey.startsWith('vocab:'), 'vocab card needs an srs key');
    ok(c.answer, 'vocab card needs an answer');
    if (c.kind === 'mc3') {
      ok(c.options.length === 3, 'MC vocab card needs 3 options');
      ok(c.options.some((o) => o.text === c.answer), 'vocab answer must be among options');
    }
  }
  return true;
});

/* ------------------------------------------------- exam-core content pack */

for (const file of ['data/core-grammar.json', 'data/core-phrases.json']) {
  check(`${file.split('/').pop()}: well-formed tiers and items`, () => {
    let data;
    try {
      data = readJSON(file);
    } catch {
      return true; // pack not present yet - not a failure
    }
    ok(Array.isArray(data.tiers) && data.tiers.length > 0, 'tiers[] missing');
    const ids = new Set();
    const des = new Set();
    let count = 0;
    for (const tier of data.tiers) {
      ok(tier.id && tier.title, 'every tier needs an id and a title');
      ok(tier.why, `tier ${tier.id} needs a "why"`);
      ok(Array.isArray(tier.items) && tier.items.length > 0, `tier ${tier.id} has no items`);
      for (const item of tier.items) {
        count += 1;
        ok(item.id && /^[a-z0-9_]+$/.test(item.id), `bad item id: ${item.id}`);
        ok(!ids.has(item.id), `duplicate id ${item.id}`);
        ids.add(item.id);
        ok(!des.has(item.de), `duplicate headword: ${item.de}`);
        des.add(item.de);
        ok(item.de && item.en, `item ${item.id} needs de and en`);
        ok(item.example && item.example.split(/\s+/).length >= 5, `item ${item.id} example too short`);
        ok(['phrase', 'verb', 'noun', 'conj', 'prep', 'adv', 'adj'].includes(item.pos), `item ${item.id} bad pos: ${item.pos}`);
        if (item.pos === 'noun') ok(/^(der|die|das) /.test(item.de), `noun without article: ${item.de}`);
      }
    }
    ok(count >= 100, `expected a substantial pack, got ${count} items`);
    ok(/[äöüß]/.test(JSON.stringify(data)), 'pack should contain real German umlauts');
    return true;
  });
}

check('exam core: covers the official Sprachbausteine word bank', () => {
  let data;
  try {
    data = readJSON('data/core-grammar.json');
  } catch {
    return true;
  }
  const words = data.tiers.flatMap((t) => t.items).map((i) => i.de.toLowerCase());
  // The 15 words telc used in Sprachbausteine Teil 2 of the official Übungstest 1.
  const official = ['besonders', 'da', 'dafür', 'damals', 'damit', 'dankbar', 'deshalb', 'für', 'gerne', 'könnten', 'mit', 'müssten', 'schließlich', 'wann', 'wenn'];
  const missing = official.filter((w) => !words.some((de) => de.includes(w)));
  ok(missing.length === 0, `core pack should cover the official word bank, missing: ${missing.join(', ')}`);
  return true;
});

/* --------------------------------------------- ability estimate calibration */

/** Build a state whose history is n attempts at one difficulty with a given hit rate. */
function stateWithAttempts(partId, difficulty, total, correct) {
  const history = [];
  for (let i = 0; i < total; i++) {
    history.push({ t: 1000 + i, partId, tags: [], difficulty, correct: i < correct, source: 'part', ms: 0, itemRef: `${partId}#${i}` });
  }
  return {
    nodes: { [`skill:${partId}`]: { theta: 50, n: total, correct, last: 2000, streak: 0 } },
    history,
    errors: [],
    srs: {},
    days: {},
    settings: {},
    counters: { attempts: total, correct },
  };
}

/** Predicted success rate at a difficulty, using the app's own logistic scale. */
function predict(ability, difficulty) {
  return 1 / (1 + Math.pow(10, (difficulty - ability) / 18));
}

check('ability: the estimate matches what the recorded attempts imply', () => {
  // 18 of 40 correct at difficulty 58 implies ~56.4 on the logistic scale.
  store.importJSON(JSON.stringify(stateWithAttempts('SB2', 58, 40, 18)));
  const mle = store.mleAbility('skill:SB2');
  ok(mle, 'expected an estimate');
  ok(Math.abs(mle.theta - 56.4) < 2, `expected about 56.4, got ${mle.theta}`);

  // And the forecast must reproduce the observed hit rate at the same difficulty.
  const rate = predict(store.masteryOf('skill:SB2'), 58);
  ok(Math.abs(rate - 0.45) < 0.06, `predicted ${(rate * 100).toFixed(0)}% for an observed 45%`);
  store.resetAll();
  return true;
});

check('ability: a lucky streak does not inflate the estimate', () => {
  // The old Elo put HV1 at 84 when 70% correct implies ~65. The estimate must follow
  // the evidence, not the path taken to get there. Shrinkage still pulls 20 attempts
  // a little toward the prior, so the prediction is deliberately conservative.
  store.importJSON(JSON.stringify(stateWithAttempts('HV1', 58, 20, 14)));
  const mle = store.mleAbility('skill:HV1');
  ok(Math.abs(mle.theta - 64.5) < 2, `expected about 64.5, got ${mle.theta}`);
  const rate = predict(store.masteryOf('skill:HV1'), 58);
  ok(rate > 0.58 && rate < 0.72, `predicted ${(rate * 100).toFixed(0)}% for an observed 70%`);
  // The important part: nowhere near the 96% the old estimator claimed.
  ok(rate < 0.8, 'must not claim near-certainty for a 70% performer');
  store.resetAll();
  return true;
});

check('ability: all-correct and all-wrong stay bounded and sensible', () => {
  store.importJSON(JSON.stringify(stateWithAttempts('LV1', 56, 10, 10)));
  const hi = store.mleAbility('skill:LV1').theta;
  ok(hi > 70 && hi <= 99, `10/10 should imply a high ability, got ${hi}`);

  store.importJSON(JSON.stringify(stateWithAttempts('LV1', 56, 10, 0)));
  const lo = store.mleAbility('skill:LV1').theta;
  ok(lo < 40 && lo >= 1, `0/10 should imply a low ability, got ${lo}`);
  store.resetAll();
  return true;
});

check('ability: a node with no attempts falls back to the prior', () => {
  store.resetAll();
  eq(store.mleAbility('skill:SP1'), null, 'no evidence means no estimate');
  eq(store.masteryOf('skill:SP1'), 50, 'and the prior stands');
  eq(store.mleAbility('tag:konnektoren'), null, 'same for tags');
  return true;
});

check('ability: few attempts are shrunk toward the prior', () => {
  store.importJSON(JSON.stringify(stateWithAttempts('LV3', 60, 2, 2)));
  const raw = store.mleAbility('skill:LV3').theta;
  const shrunk = store.masteryOf('skill:LV3');
  ok(raw > shrunk, `2 attempts must be pulled toward 50 (raw ${raw}, shrunk ${shrunk})`);
  ok(shrunk < 80, `2/2 must not read as mastery, got ${shrunk}`);
  store.resetAll();
  return true;
});

check('ability: estimates follow the recorded attempts for every part', () => {
  // Each part gets a different hit rate; the forecast must track them and not drift.
  const rates = { LV1: 9 / 10, LV2: 26 / 28, LV3: 16 / 20, SB1: 40 / 60, SB2: 18 / 40, HV1: 14 / 20 };
  const nodes = {};
  const history = [];
  let t = 1000;
  for (const [partId, rate] of Object.entries(rates)) {
    const total = partId === 'SB1' ? 60 : partId === 'SB2' ? 40 : partId === 'LV2' ? 28 : 20;
    const correct = Math.round(rate * total);
    nodes[`skill:${partId}`] = { theta: 50, n: total, correct, last: t, streak: 0 };
    for (let i = 0; i < total; i++) {
      history.push({ t: t++, partId, tags: [], difficulty: 58, correct: i < correct, source: 'part', ms: 0 });
    }
  }
  store.importJSON(JSON.stringify({ nodes, history, errors: [], srs: {}, days: {}, settings: {}, counters: {} }));

  for (const [partId, rate] of Object.entries(rates)) {
    const predicted = predict(store.masteryOf(`skill:${partId}`), 58);
    const target = partId === 'SB1' ? 40 / 60 : rate;
    ok(
      Math.abs(predicted - target) < 0.08,
      `${partId}: observed ${(target * 100).toFixed(0)}%, predicted ${(predicted * 100).toFixed(0)}%`
    );
  }
  store.resetAll();
  return true;
});


/* ------------------------------------------------------ plan completion */

check('plan: tasks are ticked off by the work actually recorded', () => {
  const tasks = [
    { kind: 'part', partId: 'SB2', label: 'Prüfungsteil üben: Teil 2 – Wortbank im Brief' },
    { kind: 'drill', partId: null, label: 'Adaptive Übungen' },
    { kind: 'writing', partId: 'SA1', label: 'Schreiben: Brief mit Korrektur' },
    { kind: 'mock', partId: null, label: 'Kompletter Mocktest' },
  ];
  const attempts = [
    { partId: 'SB2', source: 'part', correct: true, t: 1 },
    { partId: 'LV1', source: 'part', correct: true, t: 2 },
  ];
  ok(engine.isTaskDone(tasks[0], attempts, {}), 'the SB2 task should be ticked by SB2 practice');
  ok(!engine.isTaskDone(tasks[1], attempts, {}), 'no drill yet');
  ok(!engine.isTaskDone(tasks[2], attempts, {}), 'no writing yet');
  ok(!engine.isTaskDone(tasks[3], attempts, {}), 'no mock yet');

  for (const source of ['drill', 'ai', 'vocab']) {
    ok(engine.isTaskDone(tasks[1], [{ partId: 'SB1', source, t: 3 }], {}), `${source} should tick the drill task`);
  }
  ok(engine.isTaskDone(tasks[2], [{ partId: 'SA1', source: 'writing', t: 4 }], {}), 'writing is detected');
  ok(engine.isTaskDone(tasks[3], [{ partId: 'LV1', source: 'mock', t: 5 }], {}), 'the mock is detected');
  return true;
});

check('plan: practice on a different part does not tick the wrong task', () => {
  const task = { kind: 'part', partId: 'SB2', label: 'x' };
  ok(!engine.isTaskDone(task, [{ partId: 'SB1', source: 'part', t: 1 }], {}), 'SB1 work must not tick the SB2 task');
  ok(!engine.isTaskDone(task, [{ partId: 'SB2', source: 'drill', t: 2 }], {}), 'a drill is not a full part run');
  return true;
});

check('plan: a task that leaves no trace can be ticked by hand', () => {
  const task = { kind: 'review', partId: null, label: 'Fehlerheft komplett durchgehen' };
  ok(!engine.isTaskDone(task, [], {}), 'a self-graded review records no attempt');
  ok(engine.isTaskDone(task, [], { [engine.taskKey(task)]: true }), 'so a manual tick counts');
  return true;
});

check('plan: task keys survive the plan being regenerated', () => {
  const a = { kind: 'part', partId: 'SB2', label: 'Prüfungsteil üben: Teil 2', minutes: 25 };
  const b = { kind: 'part', partId: 'SB2', label: 'Prüfungsteil üben: Teil 2', minutes: 30 };
  eq(engine.taskKey(a), engine.taskKey(b), 'same task, different minute value');
  const c = { kind: 'part', partId: 'SB1', label: 'Prüfungsteil üben: Teil 2' };
  ok(engine.taskKey(a) !== engine.taskKey(c), 'a different part must give a different key');
  return true;
});

check('plan: day progress counts what is finished', () => {
  const day = {
    tasks: [
      { kind: 'part', partId: 'SB2', label: 'a' },
      { kind: 'drill', partId: null, label: 'b' },
      { kind: 'review', partId: null, label: 'c' },
    ],
  };
  const attempts = [
    { partId: 'SB2', source: 'part', t: 1 },
    { partId: 'SB1', source: 'drill', t: 2 },
  ];
  const p = engine.planDayProgress(day, attempts, {});
  eq(p.total, 3, 'three tasks');
  eq(p.done, 2, 'two are detectable');
  eq(p.tasks[2].done, false, 'the review cannot be detected');
  return true;
});


/* -------------------------------------------------------- reference guides */

check('speaking guide: one complete reference section per oral task', () => {
  const data = readJSON('data/speaking-guide.json');
  eq(data.parts.length, 3, 'three oral tasks');
  eq(data.parts.map((p) => p.id).sort().join(','), 'SP1,SP2,SP3', 'the real task ids');

  let phrases = 0;
  for (const p of data.parts) {
    ok(p.title && p.summary, `${p.id} needs a title and a summary`);
    ok(Array.isArray(p.approach) && p.approach.length >= 4, `${p.id} needs a step-by-step approach`);
    for (const s of p.approach) {
      ok(s.step && s.detail, `${p.id} approach steps need a step and a detail`);
      ok(Number.isFinite(s.seconds), `${p.id} approach steps need a timing`);
    }
    ok(Array.isArray(p.phrases) && p.phrases.length >= 5, `${p.id} needs several phrase groups`);
    for (const g of p.phrases) {
      ok(g.group && g.hint, `${p.id}: every phrase group needs a name and a hint`);
      ok(Array.isArray(g.items) && g.items.length >= 4, `${p.id}/${g.group} needs several phrases`);
      for (const it of g.items) {
        phrases += 1;
        ok(it.de && it.en, `a phrase in ${g.group} needs German and English`);
        ok(
          it.example && it.example.split(/\s+/).length >= 5,
          `"${it.de}" needs a complete example sentence, got "${it.example}"`
        );
      }
    }
    ok(Array.isArray(p.examples) && p.examples.length >= 2, `${p.id} needs at least two model answers`);
    for (const ex of p.examples) {
      ok(ex.topic, `${p.id} model answers need a topic`);
      ok(ex.text && ex.text.split(/\s+/).length >= 120, `${p.id}/"${ex.topic}" is too short to be a model answer`);
    }
    ok(Array.isArray(p.watchOut) && p.watchOut.length >= 3, `${p.id} should list typical mistakes`);
  }
  ok(phrases >= 100, `expected a substantial reference, got ${phrases} phrases`);
  ok(/[äöüß]/.test(JSON.stringify(data)), 'the German must use real umlauts');
  return true;
});

check('writing guide: strategy, building blocks and model letters', () => {
  const d = readJSON('data/writing-guide.json');
  eq(d.sections.length, 6, 'six strategy sections');
  eq(d.phrases.length, 8, 'eight phrase groups');
  eq(d.examples.length, 4, 'four model letters');

  let points = 0;
  for (const s of d.sections) {
    ok(s.title && s.why, 'every section needs a title and a why');
    ok(Array.isArray(s.points) && s.points.length >= 3, `${s.title} needs at least three points`);
    for (const p of s.points) {
      points += 1;
      ok(p.idea && p.detail, `${s.title}: every point needs an idea and a detail`);
    }
  }
  ok(points >= 20, `expected substantial guidance, got ${points} points`);

  let phrases = 0;
  for (const g of d.phrases) {
    ok(g.group && g.hint, 'every phrase group needs a name and a hint');
    ok(Array.isArray(g.items) && g.items.length >= 4, `${g.group} needs several phrases`);
    for (const it of g.items) {
      phrases += 1;
      ok(it.de && it.en, `a phrase in ${g.group} needs German and English`);
      ok(
        it.example && it.example.split(/\s+/).length >= 5,
        `"${it.de}" needs a complete example sentence, got "${it.example}"`
      );
    }
  }
  ok(phrases >= 40, `expected at least 40 phrases, got ${phrases}`);

  for (const ex of d.examples) {
    ok(ex.type && ex.situation, 'model letters need a type and a situation');
    eq(ex.leitpunkte.length, 4, `${ex.type} must have exactly four Leitpunkte`);
    const words = ex.text.split(/\s+/).length;
    ok(words >= 85 && words <= 140, `${ex.type} should be 85-140 words, got ${words}`);
  }
  ok(d.checklist.length >= 6, 'a usable submission checklist');
  ok(d.watchOut.length >= 5, 'typical mistakes');
  ok(/[äöüß]/.test(JSON.stringify(d)), 'the German must use real umlauts');
  return true;
});

check('grammar guide: every topic has a rule, a pattern and worked examples', () => {
  const d = readJSON('data/grammar-guide.json');
  eq(d.topics.length, 14, 'fourteen topics');
  const ids = d.topics.map((t) => t.id);
  eq(new Set(ids).size, ids.length, 'topic ids must be unique');

  // The two the learner specifically asked for, plus the other high-yield ones.
  for (const id of ['reflexivverben', 'um_zu_infinitiv', 'infinitiv_mit_zu', 'wechselpraepositionen', 'nebensatz_wortstellung']) {
    ok(ids.includes(id), `the guide should cover ${id}`);
  }

  let examples = 0;
  for (const t of d.topics) {
    ok(t.title && t.why, `${t.id} needs a title and a why`);
    ok(t.rule && t.rule.length > 60, `${t.id} needs a real explanation, not a stub`);
    ok(t.pattern, `${t.id} needs the pattern line`);
    ok(Array.isArray(t.examples) && t.examples.length >= 4, `${t.id} needs several examples`);
    for (const e of t.examples) {
      examples += 1;
      ok(e.de && e.de.split(/\s+/).length >= 4, `${t.id} has a stub example: "${e.de}"`);
      ok(e.en, `${t.id}: "${e.de}" needs a translation`);
    }
    ok(Array.isArray(t.traps) && t.traps.length >= 3, `${t.id} should list typical mistakes`);
    if (t.table) {
      ok(Array.isArray(t.table.headers) && t.table.headers.length >= 2, `${t.id} table needs headers`);
      ok(Array.isArray(t.table.rows) && t.table.rows.length >= 1, `${t.id} table needs rows`);
    }
  }
  ok(examples >= 60, `expected plenty of worked examples, got ${examples}`);
  ok(/[äöüß]/.test(JSON.stringify(d)), 'the German must use real umlauts');
  return true;
});

check('cases guide: article and pronoun tables are factually correct', () => {
  const d = readJSON('data/cases-guide.json');
  eq(d.tables.length, 8, 'eight tables');

  // Ground truth: the definite and indefinite article across all four cases.
  const expect = {
    bestimmter_artikel: [
      ['Nominativ', 'der', 'das', 'die', 'die'],
      ['Akkusativ', 'den', 'das', 'die', 'die'],
      ['Dativ', 'dem', 'dem', 'der', 'den (+ -n am Nomen)'],
      ['Genitiv', 'des (+ -s)', 'des (+ -s)', 'der', 'der'],
    ],
    unbestimmter_artikel: [
      ['Nominativ', 'ein', 'ein', 'eine', 'keine'],
      ['Akkusativ', 'einen', 'ein', 'eine', 'keine'],
      ['Dativ', 'einem', 'einem', 'einer', 'keinen'],
      ['Genitiv', 'eines', 'eines', 'einer', 'keiner'],
    ],
  };
  for (const [id, rows] of Object.entries(expect)) {
    const t = d.tables.find((x) => x.id === id);
    ok(t, `missing table ${id}`);
    eq(JSON.stringify(t.rows), JSON.stringify(rows), `${id} rows`);
  }

  const pronouns = d.tables.find((t) => t.id === 'personalpronomen');
  ok(pronouns, 'missing the pronoun table');
  eq(pronouns.rows.length, 9, 'nine persons');
  eq(pronouns.rows[0].join('/'), 'ich/ich/mich/mir', 'first person singular');
  eq(pronouns.rows[2].join('/'), 'er/er/ihn/ihm', 'third person masculine');
  eq(pronouns.rows[3].join('/'), 'es/es/es/ihm', 'third person neuter');
  eq(pronouns.rows[8].join('/'), 'Sie/Sie/Sie/Ihnen', 'formal address');
  return true;
});

check('cases guide: tables are well formed and every example is a sentence', () => {
  const d = readJSON('data/cases-guide.json');
  ok(d.intro && d.intro.length > 40, 'needs an intro');

  for (const t of d.tables) {
    ok(t.id && t.title && t.why, `table ${t.id} needs an id, title and why`);
    ok(Array.isArray(t.headers) && t.headers.length >= 3, `${t.id} needs headers`);
    ok(Array.isArray(t.rows) && t.rows.length >= 3, `${t.id} needs rows`);
    for (const r of t.rows) eq(r.length, t.headers.length, `${t.id} has a ragged row: ${JSON.stringify(r)}`);
  }

  eq(d.triggers.length, 4, 'four case triggers');
  for (const t of d.triggers) {
    ok(t.case && t.kind, 'every trigger needs a case and a kind');
    ok(Array.isArray(t.items) && t.items.length >= 4, `${t.kind} needs a word list`);
    ok(t.example && t.example.split(/\s+/).length >= 4, `${t.kind} needs a full example`);
  }

  eq(d.examples.length, 8, 'eight worked examples');
  for (const e of d.examples) {
    ok(e.de && e.de.split(/\s+/).length >= 4, `stub example: ${e.de}`);
    ok(e.en, `${e.de} needs a translation`);
  }
  ok(d.watchOut.length >= 5, 'typical mistakes');
  ok(/[äöüß]/.test(JSON.stringify(d)), 'the German must use real umlauts');
  return true;
});

/* ---------------------------------------------------------------- Satzbau */

check('satzbau: finds the finite verb and the Vorfeld in a main clause', () => {
  const r = analyseSentence('Morgen fahre ich mit dem Zug nach Berlin.');
  eq(r.clauses.length, 1, 'one clause');
  const c = r.clauses[0];
  eq(c.type, 'hauptsatz', 'main clause');
  eq(c.finite, 'fahre', 'the finite verb');
  eq(c.vorfeld, 'Morgen', 'exactly one element before the verb');
  eq(c.rule.id, 'v2', 'the V2 rule is named');
  eq(r.errors, 0, 'nothing to correct');
  return true;
});

check('satzbau: a subordinate clause puts the verb last', () => {
  const r = analyseSentence('Weil ich müde bin, bleibe ich zu Hause.');
  eq(r.clauses[0].type, 'nebensatz', 'first clause is subordinate');
  eq(r.clauses[0].finite, 'bin', 'the verb is at the end');
  eq(r.clauses[0].rule.id, 'verbfinal', 'the verb-final rule');
  eq(r.clauses[1].type, 'hauptsatz', 'second clause is a main clause');
  eq(r.clauses[1].rule.id, 'v2_nach_nebensatz', 'and the Nebensatz is its Vorfeld');
  eq(r.errors, 0, 'this is correct German');
  return true;
});

check('satzbau: flags a verb that is not in second position', () => {
  const r = analyseSentence('Am Montag ich fahre nach Berlin.');
  eq(r.errors, 1, 'one error');
  ok(/Vorfeld/.test(r.issues[0].message), `should mention the Vorfeld, got: ${r.issues[0].message}`);
  ok(/Am Montag fahre ich/.test(r.issues[0].hint), `the hint should show the fix, got: ${r.issues[0].hint}`);
  return true;
});

check('satzbau: flags a main clause that does not start with the verb after a Nebensatz', () => {
  const r = analyseSentence('Weil ich müde bin, ich bleibe zu Hause.');
  eq(r.errors, 1, 'one error');
  ok(/Nebensatz/.test(r.issues[0].message), r.issues[0].message);
  ok(/bleibe ich/.test(r.issues[0].hint), `the hint should show the fix, got: ${r.issues[0].hint}`);
  return true;
});

check('satzbau: spots a Perfekt bracket', () => {
  const c = analyseSentence('Ich habe gestern einen Brief geschrieben.').clauses[0];
  eq(c.finite, 'habe', 'the auxiliary sits in position 2');
  eq(c.bracket.kind, 'perfekt', 'the participle closes the bracket');
  eq(c.bracket.word, 'geschrieben', 'and it is the participle');
  return true;
});

check('satzbau: flags a noun after an article that is not capitalised', () => {
  const r = analyseSentence('Ich habe ein buch gekauft.');
  ok(r.errors >= 1, 'should flag it');
  ok(
    r.issues.some((i) => /Nomen schreibt man groß/.test(i.message)),
    `expected a capitalisation message, got ${JSON.stringify(r.issues.map((i) => i.message))}`
  );
  return true;
});

check('satzbau: a capitalised word is not mistaken for a verb', () => {
  // "Frage" is both a noun and the form "ich frage". Position decides.
  const c = analyseSentence('Ich rufe dich an, weil ich eine Frage habe.').clauses[1];
  eq(c.type, 'nebensatz', 'subordinate clause');
  eq(c.finite, 'habe', 'the verb at the end, not the noun Frage');
  return true;
});

check('satzbau: leaves correct sentences alone', () => {
  const sentences = [
    'Ich fahre morgen nach Berlin.',
    'Morgen fahre ich nach Berlin.',
    'Am Montag nach der Arbeit fahre ich nach Berlin.',
    'Wo wohnst du?',
    'Kannst du mir helfen?',
    'Ich rufe dich an.',
    'Ich rufe dich an, weil ich eine Frage habe.',
    'Wenn es morgen regnet, bleiben wir zu Hause.',
    'Ich bin gestern mit dem Fahrrad gefahren.',
  ];
  for (const s of sentences) {
    const r = analyseSentence(s);
    eq(r.errors, 0, `"${s}" should raise no error, got: ${JSON.stringify(r.issues.map((i) => i.message))}`);
  }
  return true;
});

check('satzbau: does not split a sentence at an ordinal', () => {
  const r = analyseSentence('Am 3. Mai fahre ich nach Berlin.');
  eq(r.clauses.length, 1, 'one clause, not two');
  eq(r.clauses[0].finite, 'fahre', 'the verb is still found');
  return true;
});

check('satzbau: handles empty and junk input without throwing', () => {
  eq(analyseSentence(''), null, 'empty input');
  eq(analyseSentence('   '), null, 'whitespace');
  const r = analyseSentence('Hallo!!! ???');
  ok(r === null || Array.isArray(r.clauses), 'must not throw on punctuation soup');
  return true;
});

/* ------------------------------------------------------------ Noun gender */

check('gender rules: the ending and meaning rules are well formed', () => {
  const d = readJSON('data/gender-rules.json');
  eq(d.rules.length, 6, 'six rules');
  eq(d.exceptions.length, 40, 'forty exceptions');
  eq(d.doubleGender.length, 14, 'fourteen double-gender words');

  eq(
    d.rules.map((r) => `${r.gender}:${r.kind}`).join(' '),
    'die:Endung der:Endung das:Endung der:Bedeutung die:Bedeutung das:Bedeutung',
    'rules in the intended order'
  );

  for (const r of d.rules) {
    ok(r.title && r.note, `${r.title} needs a note`);
    ok(Array.isArray(r.items) && r.items.length >= 4, `${r.title} needs its endings or groups`);
    ok(Array.isArray(r.examples) && r.examples.length >= 3, `${r.title} needs examples`);
    for (const x of r.examples) {
      ok(x.de.startsWith(`${r.gender} `), `${x.de} does not carry the rule's gender ${r.gender}`);
      ok(x.plural, `${x.de} needs a plural`);
    }
  }

  // Most exceptions are gender mismatches; a few (der Herr, der Nachbar, der Student)
  // are weak masculine nouns, where the gender is what you would guess but the form
  // is not. Both are worth listing, so require a majority of true mismatches.
  const validGenders = new Set(['der', 'die', 'das']);
  let mismatches = 0;
  for (const x of d.exceptions) {
    ok(validGenders.has(x.looks), `exception ${x.de} has an invalid "looks" value: ${x.looks}`);
    ok(x.why && x.why.length > 25, `exception ${x.de} needs a real reason`);
    ok(/^(der|die|das) /.test(x.de), `${x.de} needs an article`);
    if (x.de.slice(0, 3) !== x.looks) mismatches += 1;
  }
  ok(mismatches >= 30, `expected most exceptions to be genuine gender mismatches, got ${mismatches}`);

  for (const x of d.doubleGender) {
    ok(x.other && x.why && x.otherEn, `${x.de} needs the other article, its meaning and an explanation`);
    ok(x.de.slice(0, 3) !== x.other.slice(0, 3), `${x.de} and ${x.other} must differ in gender`);
    eq(
      x.de.replace(/^(der|die|das) /, ''),
      x.other.replace(/^(der|die|das) /, ''),
      `${x.de} and ${x.other} should be the same noun`
    );
  }

  ok(d.watchOut.length >= 5, 'typical mistakes');
  ok(/[äöüß]/.test(JSON.stringify(d)), 'the German must use real umlauts');
  return true;
});

check('noun lexicon: gender, plural and the rule behind each noun', () => {
  const nouns = readJSON('data/noun-lexicon.json').nouns;
  ok(nouns.length >= 200, `expected a full lexicon, got ${nouns.length}`);
  eq(new Set(nouns.map((n) => n.de)).size, nouns.length, 'headwords must be unique');

  const byGender = {};
  for (const n of nouns) byGender[n.gender] = (byGender[n.gender] || 0) + 1;
  for (const g of ['der', 'die', 'das']) ok(byGender[g] >= 40, `too few ${g} nouns: ${byGender[g] || 0}`);

  for (const n of nouns) {
    ok(n.de.startsWith(`${n.gender} `), `${n.de} does not start with its own gender ${n.gender}`);
    ok(n.plural && /^(die|kein Plural)/.test(n.plural), `${n.de} needs a full plural, got "${n.plural}"`);
    ok(n.en, `${n.de} needs a meaning`);
    ok(n.rule, `${n.de} needs a rule label`);
    ok(n.theme, `${n.de} needs a theme`);
    ok(n.example && n.example.split(/\s+/).length >= 6, `${n.de} needs a real example sentence`);
  }

  const themes = new Set(nouns.map((n) => n.theme));
  ok(themes.size >= 10, `expected broad thematic coverage, got ${themes.size} themes`);
  ok(/[äöüß]/.test(JSON.stringify(nouns)), 'the German must use real umlauts');
  return true;
});

check('noun lexicon: the gender drill really drills gender', () => {
  const nouns = readJSON('data/noun-lexicon.json').nouns;

  // The deck shares the vocab drill, which only builds an article card for
  // entries tagged as nouns. Without `pos` every card silently degrades into a
  // meaning question, so the "gender deck" would teach no gender at all.
  for (const n of nouns) eq(n.pos, 'noun', `${n.de} must carry pos: "noun"`);

  for (const n of nouns) {
    const card = vocabDrill(n, 'article');
    ok(card, `${n.de} must produce an article card`);
    eq(card.instruction, 'Welcher Artikel ist richtig?', `${n.de} must ask for the article`);
    eq(card.answer, n.gender, `${n.de} must accept its own gender as the answer`);
    ok(card.options.length === 3, `${n.de} must offer der/die/das`);
  }

  // A Singularetantum must say so rather than carry an invented plural.
  const singularOnly = nouns.filter((n) => n.plural === 'kein Plural');
  ok(singularOnly.length >= 20, `expected the mass nouns to be marked, got ${singularOnly.length}`);
  for (const de of ['das Glück', 'der Stolz', 'das Eigentum', 'die Geduld', 'das Obst']) {
    const hit = nouns.find((n) => n.de === de);
    ok(hit, `${de} is missing from the lexicon`);
    eq(hit.plural, 'kein Plural', `${de} has no plural and must not invent one`);
  }
  // "die Eigentümer" means *owners* — a different word, and a classic trap.
  ok(!nouns.some((n) => n.plural === 'die Eigentümer'), 'die Eigentümer is not the plural of Eigentum');

  // No card may render a dangling "undefined" where a translation should be.
  for (const n of nouns) {
    for (const mode of ['article', 'de-en', 'en-de']) {
      const card = vocabDrill(n, mode) || {};
      ok(!String(card.explanation || '').includes('undefined'), `${n.de} (${mode}) leaks undefined`);
    }
  }
  return true;
});

/* ------------------------------------------------------- bilingual content */

/**
 * Every explanation the learner reads should have an English counterpart. These
 * checks are deliberately structural: they fail when a field is added without its
 * translation, which is the failure mode that actually happens when content grows.
 */
check('English: the noun lexicon translates every example and every rule label', () => {
  const nouns = readJSON('data/noun-lexicon.json').nouns;
  for (const n of nouns) {
    ok(n.exampleEn && n.exampleEn.length > 8, `${n.de} needs an English example`);
    ok(n.ruleEn, `${n.de} needs an English rule label`);
    // A gloss, not a copy of the German.
    ok(n.ruleEn !== n.rule, `${n.de}: ruleEn must actually be English`);
  }
  const labels = new Set(nouns.map((n) => n.rule));
  eq(new Set(nouns.map((n) => n.ruleEn)).size, labels.size, 'each rule label needs its own English gloss');
  return true;
});

check('English: the reference guides are bilingual end to end', () => {
  const cases = readJSON('data/cases-guide.json');
  ok(cases.introEn?.length > 20, 'cases intro needs English');
  eq(cases.watchOutEn.length, cases.watchOut.length, 'every watch-out needs English');
  for (const t of cases.tables) {
    ok(t.titleEn, `${t.id} needs an English title`);
    ok(t.whyEn, `${t.id} needs an English why`);
    ok(t.noteEn, `${t.id} needs an English note`);
    eq(t.headersEn.length, t.headers.length, `${t.id}: every header needs English`);
  }
  for (const t of cases.triggers) ok(t.kindEn, `trigger "${t.kind}" needs English`);

  const gender = readJSON('data/gender-rules.json');
  ok(gender.introEn?.length > 20, 'gender intro needs English');
  eq(gender.watchOutEn.length, gender.watchOut.length, 'every watch-out needs English');
  for (const r of gender.rules) {
    ok(r.titleEn, `${r.title} needs an English title`);
    ok(r.noteEn, `${r.title} needs an English note`);
  }
  // The 40 exception reasons and 14 double-gender reasons are the whole point.
  for (const e of gender.exceptions) ok(e.whyEn?.length > 15, `${e.de} needs an English reason`);
  for (const d of gender.doubleGender) ok(d.whyEn?.length > 15, `${d.de} needs an English reason`);

  const grammar = readJSON('data/grammar-guide.json').topics;
  for (const t of grammar) {
    ok(t.titleEn, `${t.id} needs an English title`);
    ok(t.whyEn, `${t.id} needs an English why`);
    ok(t.ruleEn?.length > 60, `${t.id} needs an English rule`);
    ok(t.patternEn, `${t.id} needs an English pattern`);
    eq(t.trapsEn.length, t.traps.length, `${t.id}: every trap needs English`);
    if (t.table) eq(t.table.headersEn.length, t.table.headers.length, `${t.id}: every header needs English`);
  }
  return true;
});

check('English: Sprechen and Schreiben strategies are bilingual', () => {
  const sp = readJSON('data/speaking-guide.json');
  for (const p of sp.parts) {
    ok(p.titleEn, `${p.id} needs an English title`);
    ok(p.summaryEn?.length > 20, `${p.id} needs an English summary`);
    for (const a of p.approach) {
      ok(a.stepEn, `${p.id}: "${a.step}" needs English`);
      ok(a.detailEn?.length > 20, `${p.id}: "${a.step}" needs an English detail`);
    }
    eq(p.watchOutEn.length, p.watchOut.length, `${p.id}: every watch-out needs English`);
    for (const g of p.phrases || []) {
      ok(g.groupEn, `phrase group "${g.group}" needs English`);
      ok(g.hintEn, `phrase group "${g.group}" needs an English hint`);
    }
    for (const e of p.examples || []) ok(e.topicEn, `topic "${e.topic}" needs English`);
  }

  const wr = readJSON('data/writing-guide.json');
  for (const s of wr.sections) {
    ok(s.titleEn, `${s.title} needs an English title`);
    ok(s.whyEn, `${s.title} needs an English why`);
    for (const p of s.points) {
      ok(p.ideaEn, `${s.title}: "${p.idea}" needs English`);
      ok(p.detailEn?.length > 20, `${s.title}: "${p.idea}" needs an English detail`);
    }
  }
  for (const g of wr.phrases) {
    ok(g.groupEn, `writing phrase group "${g.group}" needs English`);
    ok(g.hintEn, `writing phrase group "${g.group}" needs an English hint`);
  }
  eq(wr.checklistEn.length, wr.checklist.length, 'every checklist item needs English');
  eq(wr.watchOutEn.length, wr.watchOut.length, 'every watch-out needs English');
  for (const e of wr.examples) {
    ok(e.typeEn, `${e.type} needs an English type`);
    ok(e.situationEn, `${e.type} needs an English situation`);
    eq(e.leitpunkteEn.length, e.leitpunkte.length, `${e.type}: every guiding point needs English`);
  }
  return true;
});

check('English: the Satzbau analyser explains itself in both languages', () => {
  const samples = [
    'Ich fahre morgen mit dem Zug nach Berlin.',
    'Weil ich müde bin, bleibe ich heute zu Hause.',
    'Am Montag ich fahre nach Berlin.',
    'Hast du morgen Zeit?',
    'Ich habe gestern einen Brief geschrieben.',
  ];
  for (const s of samples) {
    const r = analyseSentence(s);
    ok(r, `no analysis for "${s}"`);
    for (const c of r.clauses) {
      ok(c.rule.titleEn, `rule ${c.rule.id} needs an English title`);
      ok(c.rule.explanationEn, `rule ${c.rule.id} needs an English explanation`);
    }
    for (const i of r.issues) {
      ok(i.messageEn, `issue "${i.message}" needs an English message`);
      if (i.hint) ok(i.hintEn, `hint "${i.hint}" needs an English hint`);
    }
  }
  // The deliberate-error sample must actually produce a translated diagnostic.
  const bad = analyseSentence('Am Montag ich fahre nach Berlin.');
  ok(bad.errors > 0, 'the broken sample should be flagged');
  ok(bad.issues.every((i) => i.messageEn), 'every flag needs an English message');
  return true;
});

/* --------------------------------------------------- tag canonicalisation */

check('tags: every canonical tag is a real taxonomy key', () => {
  for (const raw of Object.keys(TAGS)) eq(canonicalTag(raw), raw, `${raw} must pass through unchanged`);
  return true;
});

check('tags: model synonyms fold onto the taxonomy', () => {
  const cases = {
    Konnektoradverb: 'konnektoren',
    konnektoradverbien: 'konnektoren',
    Konjunktionen: 'konnektoren',
    'präpositionen': 'praeposition_kasus',
    Praepositionen: 'praeposition_kasus',
    Perfekt: 'perfekt_auxiliar',
    Partizip: 'partizip2',
    Adjektivendung: 'adjektivendungen',
    Relativsatz: 'relativpronomen',
    Fragewort: 'wortstellung_nebensatz',
    Konjunktiv: 'konjunktiv2_hoeflich',
    Verneinung: 'negation',
    Wortbildung: 'lexik_wortbildung',
    Kollokationen: 'lexik_kollokation',
    'Verben mit Präposition': 'lexik_verben_praeposition',
  };
  for (const [input, expected] of Object.entries(cases)) {
    eq(canonicalTag(input), expected, `"${input}"`);
  }
  return true;
});

check('tags: garbage never creates a phantom weakness node', () => {
  for (const junk of ['', '   ', 'Sonstiges', '???', 'blah blah', null, undefined, 'x']) {
    const c = canonicalTag(junk);
    ok(TAGS[c], `"${junk}" produced "${c}", which is not a taxonomy key`);
  }
  return true;
});

check('store: off-taxonomy tag nodes are merged on load', () => {
  const legacy = {
    nodes: {
      'tag:konnektoren': { theta: 60, n: 10, correct: 6, last: 1000, streak: 1 },
      'tag:Konnektoradverb': { theta: 30, n: 4, correct: 0, last: 2000, streak: 0 },
      'tag:präpositionen': { theta: 45, n: 2, correct: 1, last: 1500, streak: 0 },
      'skill:SB1': { theta: 55, n: 20, correct: 12, last: 2000, streak: 0 },
    },
    history: [],
    errors: [{ id: 'e1', tags: ['Konnektoradverb', 'praepositionen'], resolved: false }],
    srs: {},
    days: {},
    settings: {},
    counters: { attempts: 16, correct: 7 },
  };
  store.importJSON(JSON.stringify(legacy));

  eq(store.nodeOf('tag:Konnektoradverb'), null, 'the off-taxonomy node should be gone');
  eq(store.nodeOf('tag:präpositionen'), null, 'the umlaut variant should be gone');

  const merged = store.nodeOf('tag:konnektoren');
  ok(merged, 'evidence should land on the canonical node');
  eq(merged.n, 14, 'attempt counts should add up');
  eq(merged.correct, 6, 'correct counts should add up');
  // The estimate must be evidence-weighted, not simply overwritten.
  ok(merged.theta > 30 && merged.theta < 60, `merged theta should sit between the two, got ${merged.theta}`);

  const prep = store.nodeOf('tag:praeposition_kasus');
  ok(prep && prep.n === 2, 'the preposition variant should move to praeposition_kasus');

  const err = store.listErrors()[0];
  ok(err.tags.every((t) => TAGS[t]), `error tags should be canonical, got ${err.tags.join(', ')}`);
  ok(!err.tags.includes('Konnektoradverb'), 'the raw alias should not survive on the error');

  store.resetAll();
  return true;
});

check('store: recording an alias tag updates the canonical node', () => {
  store.resetAll();
  store.recordAttempt({ partId: 'SB1', tags: ['Konnektoradverb'], difficulty: 55, correct: true });
  eq(store.nodeOf('tag:Konnektoradverb'), null, 'no phantom node');
  ok(store.thetaOf('tag:konnektoren') > 50, 'the canonical node should have moved');
  store.resetAll();
  return true;
});

/* ------------------------------------------------------------------- tts */

check('speech: script parsing splits speakers correctly', () => {
  const turns = parseScript('[Moderator]: Guten Tag.\n[Gast]: Hallo, danke.\n\n[Anrufbeantworter]: Bitte rufen Sie zurück.');
  eq(turns.length, 3, 'turn count');
  eq(turns[0].speaker, 'Moderator', 'first speaker');
  eq(turns[1].text, 'Hallo, danke.', 'second text');
  eq(turns[2].speaker, 'Anrufbeantworter', 'third speaker');
  return true;
});

check('speech: continuation lines fold into the previous turn', () => {
  const turns = parseScript('[Sprecherin]: Erster Satz.\nZweiter Satz ohne Sprechermarke.');
  eq(turns.length, 1, 'should stay one turn');
  ok(turns[0].text.includes('Erster Satz') && turns[0].text.includes('Zweiter Satz'), 'both sentences kept');
  return true;
});

check('speech: short turns are spoken whole, long ones are chunked', () => {
  const short = 'Das ist ein kurzer Satz.';
  eq(chunkForSpeech(short).length, 1, 'a short turn must stay a single utterance');

  const long = Array.from({ length: 30 }, (_, i) => `Dies ist der Satz Nummer ${i + 1} in einem sehr langen Hoertext.`).join(' ');
  ok(long.length > 600, 'fixture should exceed the chunk threshold');
  const chunks = chunkForSpeech(long);
  ok(chunks.length > 1, 'a very long turn should be split');
  for (const c of chunks) ok(c.length <= 600, `chunk too long: ${c.length}`);
  // No text may be lost or duplicated by chunking.
  const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim();
  eq(rejoined, long.replace(/\s+/g, ' ').trim(), 'chunking must preserve the text exactly');
  return true;
});

check('speech: chunking avoids cutting mid-sentence where it can', () => {
  const long = `${'A'.repeat(50)}. ${'B'.repeat(400)}. ${'C'.repeat(400)}.`;
  const chunks = chunkForSpeech(long);
  for (const c of chunks.slice(0, -1)) {
    ok(/[.!?]$/.test(c), `chunk should end at a sentence boundary: "${c.slice(-20)}"`);
  }
  return true;
});

/* ------------------------------------------------------------ dictation */

/**
 * A stand-in for Chrome's SpeechRecognition, so the resume-and-accumulate behaviour
 * can be tested. The real engine cannot run in Node or in headless Chrome.
 */
function fakeRecognition() {
  const instances = [];
  class Fake {
    constructor() {
      this.started = 0;
      this.stopCalls = 0;
      this.ended = false;
      instances.push(this);
    }
    start() {
      this.started += 1;
      this.onstart?.();
    }
    stop() {
      this.stopCalls += 1;
      this.onend?.();
    }
    /** Deliver a result. `isFinal` false simulates interim speech. */
    say(text, isFinal = true) {
      const res = [{ transcript: text }];
      res.isFinal = isFinal;
      this.onresult({ resultIndex: 0, results: [res] });
    }
    /** Chrome deciding to stop by itself. */
    die(code) {
      if (code) this.onerror({ error: code });
      this.onend?.();
    }
  }
  Fake.instances = instances;
  return Fake;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('dictation: Chrome stopping on silence is resumed automatically', async () => {
  const Fake = fakeRecognition();
  let restarts = 0;
  const d = startDictation({ Recognition: Fake, restartDelayMs: 10, onRestart: () => { restarts += 1; } });
  ok(d, 'should start');

  const rec = Fake.instances[0];
  eq(rec.started, 1, 'first session started');

  // Chrome ends by itself after a few seconds of silence.
  rec.say('Ich möchte Ihnen meine Heimatstadt');
  rec.die();
  eq(restarts, 1, 'the helper should announce a resume');

  await sleep(80);
  eq(rec.started, 2, 'listening should have resumed on the same engine');
  eq(rec.stopCalls, 0, 'and it must not have been stopped');

  // The learner keeps talking into the resumed session.
  rec.say('vorstellen. Sie liegt im Süden.');
  const text = d.stop();
  ok(text.includes('Heimatstadt') && text.includes('Süden'), `both halves kept, got "${text}"`);
  return true;
});

check('dictation: text from before a restart is not lost', async () => {
  const Fake = fakeRecognition();
  const finals = [];
  let ended = null;
  const d = startDictation({
    Recognition: Fake,
    restartDelayMs: 10,
    onTranscript: ({ final }) => finals.push(final),
    onEnd: (text) => { ended = text; },
  });

  const rec = Fake.instances[0];
  rec.say('Ich möchte Ihnen');
  rec.die();
  await sleep(80);
  rec.say('meine Heimatstadt vorstellen.');
  d.stop();

  const full = 'Ich möchte Ihnen meine Heimatstadt vorstellen.';
  eq(ended, full, 'the final transcript must span the restart');
  ok(finals[finals.length - 1].includes('Ich möchte Ihnen'), 'the earlier words must survive');
  ok(finals[finals.length - 1].includes('Heimatstadt'), 'and so must the later ones');
  return true;
});

check('dictation: a real stop does not restart', async () => {
  const Fake = fakeRecognition();
  let ended = null;
  const d = startDictation({ Recognition: Fake, restartDelayMs: 10, onEnd: (t) => { ended = t; } });
  const rec = Fake.instances[0];
  rec.say('Ein kurzer Satz.');
  d.stop();
  await sleep(80);
  eq(rec.started, 1, 'stopping must not resume listening');
  eq(ended, 'Ein kurzer Satz.', 'the text is handed back on stop');
  eq(d.running, false, 'and the helper reports itself stopped');
  eq(d.text, 'Ein kurzer Satz.', 'the transcript is readable afterwards');
  return true;
});

check('dictation: a fatal error stops instead of looping', async () => {
  const Fake = fakeRecognition();
  const errors = [];
  const d = startDictation({ Recognition: Fake, restartDelayMs: 10, onError: (e) => errors.push(e.message) });
  const rec = Fake.instances[0];
  rec.die('not-allowed');
  await sleep(80);
  eq(rec.started, 1, 'a denied microphone must not be retried');
  ok(errors.some((m) => /verweigert/i.test(m)), `expected a permission message, got ${JSON.stringify(errors)}`);
  eq(d.running, false, 'and the helper is finished');
  return true;
});

check('dictation: no-speech is treated as recoverable, not fatal', async () => {
  const Fake = fakeRecognition();
  const errors = [];
  const d = startDictation({ Recognition: Fake, restartDelayMs: 10, onError: (e) => errors.push(e.message) });
  const rec = Fake.instances[0];
  rec.die('no-speech');
  await sleep(80);
  eq(rec.started, 2, 'silence should resume, not stop');
  eq(errors.length, 0, 'silence is not an error worth showing');
  d.stop();
  return true;
});

check('dictation: interim results are reported without being committed', async () => {
  const Fake = fakeRecognition();
  const seen = [];
  const d = startDictation({ Recognition: Fake, onTranscript: (t) => seen.push(t) });
  const rec = Fake.instances[0];
  rec.say('Ich möchte', false);
  const last = seen[seen.length - 1];
  eq(last.final, '', 'interim speech is not final yet');
  eq(last.interim, 'Ich möchte', 'but it is shown as interim');
  rec.say('Ich möchte Ihnen', true);
  eq(seen[seen.length - 1].final, 'Ich möchte Ihnen', 'then it commits');
  d.stop();
  return true;
});

check('dictation: a runaway engine gives up instead of spinning forever', async () => {
  const Fake = fakeRecognition();
  const errors = [];
  const d = startDictation({
    Recognition: Fake,
    restartDelayMs: 1,
    runawayWindowMs: 2000,
    runawayLimit: 5,
    onError: (e) => errors.push(e.message),
  });
  const rec = Fake.instances[0];

  // An engine that dies the instant it restarts.
  for (let i = 0; i < 12; i++) {
    rec.die();
    await sleep(15);
  }
  ok(errors.some((m) => /ständig ab/i.test(m)), `expected a give-up message, got ${JSON.stringify(errors)}`);
  eq(d.running, false, 'it must stop retrying');
  const startedAtGiveUp = rec.started;
  rec.die();
  await sleep(60);
  eq(rec.started, startedAtGiveUp, 'and it must not resume after giving up');
  return true;
});

/* ------------------------------------------------------------------ done */

await Promise.all(pendingAsync);

console.log(`\n\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('All checks passed.\n');
process.exit(0);
