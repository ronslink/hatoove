/**
 * Offline checks for the mock-writing outcome path (WRITING-OUTCOMES-02).
 *
 * The defect this fixes: the mock used to fabricate writing points from an offline
 * heuristic whenever AI was unavailable or failed, record those heuristic checks as
 * assessed writing outcomes, show "Bestanden?" from written points alone, and print a
 * whole-exam grade band while speaking is unassessed. Every one of those is a claim the
 * pilot cannot support.
 *
 * What this file does:
 *   * Drives the real module (public/js/mock-outcome.js) and asserts the contract:
 *     absent/too-short/unavailable/failed/malformed writing stays `unassessed` with
 *     `points: null` and the learner's text preserved; successful AI feedback is
 *     `provisional`; a legitimate zero is kept as `points: 0` and is distinct from
 *     "missing"; aggregation never folds writing into the objective denominator; the
 *     summary carries no pass/fail, band or readiness claim; one completion per block.
 *   * Runs the same checks against the PRE-FIX public/js/exam.js so the probe can be
 *     shown to discriminate. The pre-fix writing grader is extracted from the real
 *     pre-fix source bytes and evaluated - not re-described - and the whole file and the
 *     extracted span are asserted byte-for-byte against recorded sha256 digests.
 *
 * Scope and honesty:
 *   * Module + source-substring layer. No browser is started, so no real page lifecycle,
 *     timer or keyboard behaviour is exercised; the completion-gate checks drive the real
 *     gate module directly.
 *   * The pre-fix completion path is replayed as a faithful "no gate at all" subject, and
 *     the source is asserted byte-for-byte to contain neither a gate nor an isCurrent
 *     guard. The pre-fix writing assessment is the extracted, evaluated function itself.
 *   * This is not exam validation. E-01 stays a draft; no generated item is claimed to
 *     match telc standards. All learner text below is synthetic.
 *
 * Safety: no network, no provider, no credential, no repository .env. Pure in-process.
 *
 * Usage: node tools/mock-outcome-check.mjs [--prefix-root <path-to-pre-fix-checkout>]
 * Exit code 0 when every check (including discrimination) passes, 1 otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The base commit this task branched from (see work/implementation/WRITING-OUTCOMES-02.md). */
export const PREFIX_BASE = '41b5efb3b967dc529b6a05c4ff47d99fb757fb94';
/** sha256 of `git show <PREFIX_BASE>:public/js/exam.js` - byte-for-byte. */
export const PREFIX_EXAM_SHA256 = 'a4ae5192a133d4373e142ee6e90ddb0805befb6358650730071b7d584a27704e';
/** sha256 of the extracted pre-fix `gradeMockWriting` span. */
export const PREFIX_GRADER_SHA256 = '2cd1e95287baf700d82569aee92a777511054efedaf0604afb8e6910ee08b99f';
/** public/js/engine.js is untouched by this task; prefix and current bytes must match. */
export const PREFIX_ENGINE_SHA256 = '7aef13a5bca4899e598a1346416361171d8b523990fd53997976bd49845ed30e';

export const DISCRIMINATION_CHECK = 'probe-discriminates-on-prefix-exam';

/** Names the acceptance criteria require; the test file asserts each one ran and passed. */
export const REQUIRED_CHECKS = [
  'missing-writing-is-unassessed',
  'too-short-writing-is-unassessed',
  'unavailable-provider-writing-is-unassessed',
  'failed-provider-writing-is-unassessed',
  'malformed-feedback-is-unassessed',
  'successful-writing-is-provisional',
  'legitimate-zero-is-distinct-from-missing',
  'unassessed-writing-is-not-zero-points',
  'aggregation-keeps-writing-out-of-the-objective-denominator',
  'summary-claims-no-pass-fail-grade-or-readiness',
  'duplicate-completion-commits-once',
  'stale-completion-is-not-committed',
  'late-result-after-advance-is-not-committed',
  'mock-result-source-makes-no-pass-fail-claim',
  'mock-writing-source-records-no-heuristic-attempts',
];

/** Must still pass on the pre-fix tree, or the probe would be a constant, not a probe. */
export const CONTROL_CHECKS = [
  'valid-feedback-total-survives',
  'writing-text-preserved-on-success',
  'gate-still-commits-a-single-real-completion',
  'mock-result-button-is-wired-outside-the-view',
];

/** The checks the pre-fix tree must fail for the defect to be reproduced. */
export const PREFIX_MUST_FAIL = [
  'missing-writing-is-unassessed',
  'too-short-writing-is-unassessed',
  'unavailable-provider-writing-is-unassessed',
  'failed-provider-writing-is-unassessed',
  'malformed-feedback-is-unassessed',
  'successful-writing-is-provisional',
  'legitimate-zero-is-distinct-from-missing',
  'unassessed-writing-is-not-zero-points',
  'aggregation-keeps-writing-out-of-the-objective-denominator',
  'summary-claims-no-pass-fail-grade-or-readiness',
  'duplicate-completion-commits-once',
  'stale-completion-is-not-committed',
  'late-result-after-advance-is-not-committed',
  'mock-result-source-makes-no-pass-fail-claim',
  'mock-writing-source-records-no-heuristic-attempts',
];

const ALL_CHECKS = [
  'missing-writing-is-unassessed',
  'too-short-writing-is-unassessed',
  'unavailable-provider-writing-is-unassessed',
  'failed-provider-writing-is-unassessed',
  'malformed-feedback-is-unassessed',
  'successful-writing-is-provisional',
  'legitimate-zero-is-distinct-from-missing',
  'unassessed-writing-is-not-zero-points',
  'aggregation-keeps-writing-out-of-the-objective-denominator',
  'summary-claims-no-pass-fail-grade-or-readiness',
  'duplicate-completion-commits-once',
  'stale-completion-is-not-committed',
  'late-result-after-advance-is-not-committed',
  'mock-result-source-makes-no-pass-fail-claim',
  'mock-writing-source-records-no-heuristic-attempts',
  'valid-feedback-total-survives',
  'writing-text-preserved-on-success',
  'gate-still-commits-a-single-real-completion',
  'mock-result-button-is-wired-outside-the-view',
];

/* --------------------------------------------------------------- assertions */

function assertTrue(value, label) {
  if (!value) throw new Error(label);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/* ---------------------------------------------------------------- fixtures */

const TASK = {
  situation: 'Synthetic only. Du hast eine Kursanfrage erhalten.',
  adressat: 'Kursleitung',
  register: 'du',
  leitpunkte: [
    'Bedanke dich für die Nachricht',
    'Frag nach dem genauen Termin',
    'Sag, ob du teilnehmen kannst',
    'Bitte um eine schriftliche Bestätigung',
  ],
};

/** Deterministic synthetic learner text; comfortably above the 40-word feedback floor. */
function longText() {
  const sentence = ' Ich schreibe dir, weil ich mich über die Nachricht vom letzten Dienstag wirklich gefreut habe.';
  return `Hallo, vielen Dank für deine Nachricht.${sentence.repeat(12)} Bis bald, viele Grüße.`.trim();
}

function shortText() {
  return 'Hallo, danke für die Nachricht. Bis bald.';
}

function analysisOf(text) {
  return engine.analyseWriting(text, TASK);
}

/** A complete, internally consistent rubric response summing to `total`. */
function validFeedback(total = 42) {
  const split = [15, 10, 12, 8];
  const criteria = [
    { key: 'aufgabe', score: 80, points: 0 },
    { key: 'kommunikation', score: 75, points: 0 },
    { key: 'richtigkeit', score: 70, points: 0 },
    { key: 'ausdruck', score: 65, points: 0 },
  ];
  let remaining = total;
  criteria.forEach((criterion, i) => {
    const share = i === criteria.length - 1 ? remaining : Math.min(split[i], remaining);
    criterion.points = Math.max(0, share);
    remaining -= criterion.points;
  });
  return {
    criteria,
    total,
    band: 'gut',
    leitpunkteCovered: [true, true, true, true],
    corrections: [{ original: 'Ich freue mich', corrected: 'Ich habe mich gefreut', explanation: 'Synthetic.' }],
    strengths: ['Synthetic strength'],
    priorities: ['Synthetic priority'],
    modelAnswer: 'Synthetic model answer.',
  };
}

/* ---------------------------------------------------------------- subjects */

const engine = await import(pathToFileURL(path.join(DEFAULT_ROOT, 'public/js/engine.js')).href);

/**
 * Extract a top-level `async function name(...) { ... }` span by brace balancing.
 * Returns the exact source bytes, so the sha256 can be asserted later.
 */
export function extractFunctionSpan(source, name) {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`could not find ${marker} in the source`);
  const open = source.indexOf('{', start);
  if (open === -1) throw new Error(`no body for ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${marker}`);
}

/** Extract the pre-fix whole-exam aggregation statements byte-for-byte. */
export function extractAggregationSpan(source) {
  const start = source.indexOf('const overrides = {};');
  if (start === -1) throw new Error('could not find the pre-fix aggregation block');
  const end = source.indexOf('const band = engine.gradeBand((scored.total / 300) * 100);', start);
  if (end === -1) throw new Error('could not find the pre-fix grade band line');
  return source.slice(start, end + 'const band = engine.gradeBand((scored.total / 300) * 100);'.length);
}

async function makeCurrentSubject(root) {
  const href = `${pathToFileURL(path.join(root, 'public/js/mock-outcome.js')).href}?tree=${encodeURIComponent(root)}`;
  const mod = await import(href);
  return {
    name: 'current',
    treeLayer: 'module',
    examSource: fs.readFileSync(path.join(root, 'public/js/exam.js'), 'utf8'),
    async assess(options) {
      return mod.assessMockWriting(options);
    },
    async summarize(results, options) {
      return mod.summarizeMockOutcome(results, options);
    },
    gate() {
      return mod.createCompletionGate();
    },
  };
}

async function makePrefixSubject(prefixExamSource) {
  const graderSpan = extractFunctionSpan(prefixExamSource, 'gradeMockWriting');
  const aggregationSpan = extractAggregationSpan(prefixExamSource);

  const runtime = { configured: false, grade: null };
  const ai = {
    isConfigured: () => runtime.configured,
    gradeWriting: (args) => runtime.grade(args),
  };
  const store = { attempts: [], recordAttempt(a) { this.attempts.push(a); }, addError() {} };
  // Evaluate the real pre-fix function bytes; nothing here is re-implemented.
  const grader = new Function('engine', 'ai', 'store', `return (${graderSpan});`)(engine, ai, store);
  const aggregate = new Function(
    'engine',
    'mockState',
    'card',
    `${aggregationSpan}\nreturn { overall: scored.written.points, oral: scored.oral.points, band: band.label, passed: scored.written.ok };`
  );

  return {
    name: 'prefix',
    treeLayer: 'pre-fix source bytes',
    examSource: prefixExamSource,
    graderSpan,
    aggregationSpan,
    store,
    async assess({ text, task, configured, grade }) {
      runtime.configured = Boolean(configured);
      runtime.grade = grade;
      const wrap = { querySelector: (sel) => (sel === '#mock-writing' ? { value: text } : null) };
      return grader(wrap, task);
    },
    async summarize(results) {
      const card = {};
      for (const r of results) {
        if (r.rubric) continue;
        if (!card[r.partId]) card[r.partId] = { correct: 0, total: 0 };
        card[r.partId].correct += r.correct;
        card[r.partId].total += r.total;
      }
      return aggregate(engine, { blockResults: results }, card);
    },
    gate() {
      // The pre-fix endBlock had no completion guard at all: every call collected and
      // committed. That is what this subject replays.
      return ({ collect, commit }) => Promise.resolve().then(collect).then((result) => {
        commit(result);
        return true;
      });
    },
  };
}

/* ------------------------------------------------------------------ checks */

const aggregateFixture = () => ([
  { partId: 'LV1', correct: 20, total: 25 },
  { partId: 'HV1', correct: 10, total: 15 },
  { partId: 'SA1', rubric: true, status: 'unassessed', reason: 'unavailable', points: null, max: 45, text: 'Synthetic learner text' },
]);

const checks = {
  'missing-writing-is-unassessed': async (s) => {
    const entry = await s.assess({ text: '', task: TASK, analysis: analysisOf(''), configured: true, grade: async () => validFeedback(42) });
    assertEqual(entry.status, 'unassessed', 'empty text status');
    assertEqual(entry.reason, 'empty', 'empty text reason');
    assertEqual(entry.points, null, 'empty text points');
    assertEqual(entry.aiResult, null, 'empty text aiResult');
    return 'empty submission -> unassessed, points null (never 0)';
  },

  'too-short-writing-is-unassessed': async (s) => {
    let called = 0;
    const entry = await s.assess({ text: shortText(), task: TASK, analysis: analysisOf(shortText()), configured: true, grade: async () => { called += 1; return validFeedback(42); } });
    assertEqual(entry.status, 'unassessed', 'too-short status');
    assertEqual(entry.reason, 'too_short', 'too-short reason');
    assertEqual(entry.points, null, 'too-short points');
    assertEqual(called, 0, 'a too-short text must not call the provider');
    return 'short text -> unassessed/too_short, provider untouched';
  },

  'unavailable-provider-writing-is-unassessed': async (s) => {
    const text = longText();
    let called = 0;
    const entry = await s.assess({ text, task: TASK, analysis: analysisOf(text), configured: false, grade: async () => { called += 1; return validFeedback(42); } });
    assertEqual(entry.status, 'unassessed', 'unavailable status');
    assertEqual(entry.reason, 'unavailable', 'unavailable reason');
    assertEqual(entry.points, null, 'unavailable points');
    assertEqual(entry.aiResult, null, 'unavailable aiResult');
    assertEqual(entry.text, text, 'unavailable must preserve the text');
    assertEqual(called, 0, 'no provider call when unavailable');
    return 'no provider -> unassessed/unavailable, text kept, points null';
  },

  'failed-provider-writing-is-unassessed': async (s) => {
    const text = longText();
    const entry = await s.assess({ text, task: TASK, analysis: analysisOf(text), configured: true, grade: async () => { throw new Error('provider-internals-must-not-leak'); } });
    assertEqual(entry.status, 'unassessed', 'failed status');
    assertEqual(entry.reason, 'feedback_failed', 'failed reason');
    assertEqual(entry.points, null, 'failed points');
    assertEqual(entry.aiResult, null, 'failed aiResult');
    assertEqual(entry.text, text, 'failed must preserve the text');
    assertTrue(!JSON.stringify(entry).includes('provider-internals-must-not-leak'), 'provider error text must not leak');
    return 'provider error -> unassessed/feedback_failed, text kept, no internal leak';
  },

  'malformed-feedback-is-unassessed': async (s) => {
    const text = longText();
    const bad = [
      { total: 42 },
      { total: 42, criteria: [], corrections: [], strengths: [], priorities: [], modelAnswer: '' },
      { total: 999, criteria: [{ key: 'aufgabe', score: 1, points: 1 }], corrections: [], strengths: [], priorities: [], modelAnswer: '' },
    ];
    for (const value of bad) {
      const entry = await s.assess({ text, task: TASK, analysis: analysisOf(text), configured: true, grade: async () => value });
      assertEqual(entry.status, 'unassessed', `malformed status for ${JSON.stringify(value).slice(0, 40)}`);
      assertEqual(entry.reason, 'malformed_feedback', 'malformed reason');
      assertEqual(entry.points, null, 'malformed points');
    }
    return `${bad.length} malformed shapes -> unassessed/malformed_feedback, points null`;
  },

  'successful-writing-is-provisional': async (s) => {
    const text = longText();
    const entry = await s.assess({ text, task: TASK, analysis: analysisOf(text), configured: true, grade: async () => validFeedback(42) });
    assertEqual(entry.status, 'provisional', 'success status');
    assertEqual(entry.points, 42, 'success points');
    assertTrue(entry.aiResult, 'success must keep the AI result for the detail view');
    assertEqual(entry.text, text, 'success must preserve the text');
    return 'complete feedback -> provisional, points kept, text kept';
  },

  'legitimate-zero-is-distinct-from-missing': async (s) => {
    const zero = await s.assess({ text: longText(), task: TASK, analysis: analysisOf(longText()), configured: true, grade: async () => validFeedback(0) });
    const missing = await s.assess({ text: '', task: TASK, analysis: analysisOf(''), configured: true, grade: async () => validFeedback(0) });
    assertEqual(zero.status, 'provisional', 'a scored zero is a real assessment');
    assertEqual(zero.points, 0, 'a scored zero keeps points 0');
    assertEqual(missing.status, 'unassessed', 'a missing text is unassessed');
    assertEqual(missing.points, null, 'a missing text has no point value');
    assertTrue(zero.points !== missing.points, 'zero and missing must not collapse to the same value');
    return 'points 0 (provisional) is distinct from points null (unassessed)';
  },

  'unassessed-writing-is-not-zero-points': async (s) => {
    const text = longText();
    const entry = await s.assess({ text, task: TASK, analysis: analysisOf(text), configured: false, grade: async () => validFeedback(42) });
    assertEqual(entry.points, null, 'unassessed points must be null, not 0');
    assertTrue(entry.points !== 0, 'unassessed must not be folded in as a zero');
    const summary = await s.summarize(aggregateFixture(), { objectiveMax: 180 });
    assertEqual(summary.writing.points, null, 'summary must not invent a writing zero');
    return 'unassessed stays null everywhere, never 0';
  },

  'aggregation-keeps-writing-out-of-the-objective-denominator': async (s) => {
    const summary = await s.summarize(aggregateFixture(), { objectiveMax: 180 });
    assertTrue(summary && summary.objective, 'summary.objective is required');
    assertEqual(summary.objective.correct, 30, 'objective correct');
    assertEqual(summary.objective.total, 40, 'objective total (writing must not enter)');
    assertTrue(summary.writing && summary.writing.status === 'unassessed', 'writing is reported separately');
    assertEqual(summary.writing.points, null, 'writing points stay null');
    assertEqual(summary.writing.text, 'Synthetic learner text', 'writing text stays available');
    return 'objective 30/40 kept; writing reported separately, never as a zero';
  },

  'summary-claims-no-pass-fail-grade-or-readiness': async (s) => {
    const summary = await s.summarize(aggregateFixture(), { objectiveMax: 180 });
    const keys = collectKeys(summary);
    const forbidden = ['passed', 'pass', 'bestanden', 'band', 'grade', 'readiness', 'percent', 'percentage', 'prognose'];
    const found = forbidden.filter((key) => keys.has(key));
    assertEqual(found, [], 'a whole-exam claim field must not exist');
    return `no pass/fail, band or readiness key anywhere (checked ${keys.size} keys)`;
  },

  'duplicate-completion-commits-once': async (s) => {
    const gate = s.gate();
    let collect = 0;
    let commit = 0;
    const call = () => gate({ isCurrent: () => true, collect: async () => { collect += 1; return ['entry']; }, commit: () => { commit += 1; } });
    const results = await Promise.all([call(), call()]);
    assertEqual(collect, 1, 'collect must run once for a duplicate completion');
    assertEqual(commit, 1, 'commit must run once for a duplicate completion');
    for (const value of results) assertEqual(value, true, 'both callers see the single completion');
    return 'timer+click race -> one collect, one commit';
  },

  'stale-completion-is-not-committed': async (s) => {
    const gate = s.gate();
    let collect = 0;
    let commit = 0;
    const value = await gate({ isCurrent: () => false, collect: async () => { collect += 1; return ['entry']; }, commit: () => { commit += 1; } });
    assertEqual(value, false, 'a stale completion returns false');
    assertEqual(collect, 0, 'a stale completion must not collect');
    assertEqual(commit, 0, 'a stale completion must not commit');
    return 'stale block -> nothing collected, nothing committed';
  },

  'late-result-after-advance-is-not-committed': async (s) => {
    const gate = s.gate();
    let current = true;
    let committed = false;
    await gate({
      isCurrent: () => current,
      collect: async () => { current = false; return ['old-entry']; },
      commit: () => { committed = true; },
    });
    assertEqual(committed, false, 'a result that resolves after the mock advanced must be dropped');
    return 'in-flight result dropped once the block advances (no cross-mock attach)';
  },

  'mock-result-source-makes-no-pass-fail-claim': async (s) => {
    const source = s.examSource;
    assertTrue(!source.includes('Bestanden?'), 'the mock result must not ask "Bestanden?"');
    assertTrue(!source.includes('scored.written.ok'), 'the mock result must not derive a written-only pass flag');
    assertTrue(!source.includes('Bestanden-'), 'no pass/fail wording in the mock result');
    return 'no "Bestanden?" and no written-only pass flag in the exam source';
  },

  'mock-writing-source-records-no-heuristic-attempts': async (s) => {
    const source = s.examSource;
    assertTrue(!source.includes('analysis.heuristic * 45'), 'the offline heuristic must not become points');
    assertTrue(
      !/recordAttempt\(\{\s*partId: 'SA1'[^}]*source: 'mock'/.test(source),
      'heuristic writing checks must not be recorded as mock assessment attempts'
    );
    assertTrue(!source.includes("tags: [c.tag], difficulty: engine.PART_DIFFICULTY.SA1"), 'no per-check heuristic mock attempts');
    return 'no heuristic points and no heuristic mock attempts in the exam source';
  },

  /* ------------------------------------------------------------- controls */

  'valid-feedback-total-survives': async (s) => {
    const entry = await s.assess({ text: longText(), task: TASK, analysis: analysisOf(longText()), configured: true, grade: async () => validFeedback(42) });
    assertEqual(entry.points, 42, 'a valid total must survive');
    return 'valid total 42 preserved';
  },

  'writing-text-preserved-on-success': async (s) => {
    const text = longText();
    const entry = await s.assess({ text, task: TASK, analysis: analysisOf(text), configured: true, grade: async () => validFeedback(42) });
    assertEqual(entry.text, text, 'the learner text must be preserved');
    return 'learner text preserved on success';
  },

  'gate-still-commits-a-single-real-completion': async (s) => {
    const gate = s.gate();
    let committed = null;
    const value = await gate({ isCurrent: () => true, collect: async () => ['only'], commit: (r) => { committed = r; } });
    assertEqual(value, true, 'a single real completion returns true');
    assertEqual(committed, ['only'], 'a single real completion commits its result');
    return 'single completion still commits normally';
  },

  'mock-result-button-is-wired-outside-the-view': async (s) => {
    const source = s.examSource;
    assertTrue(!source.includes("on(el.querySelector('[data-new-mock]')"), 'the Neuer Mocktest button must not be looked up inside #view');
    assertTrue(
      source.includes("actions?.querySelector('[data-new-mock]')") || source.includes("document.querySelector('[data-new-mock]')"),
      'the Neuer Mocktest button must be wired through the action bar'
    );
    return 'Neuer Mocktest is wired to the action bar, not to #view';
  },
};

/* ------------------------------------------------------------------ runner */

/**
 * Run every check against either the current module or the pre-fix source.
 * @param {{root?: string, prefixExamSource?: string|null}} options
 */
export async function runMockOutcomeChecks({ root = DEFAULT_ROOT, prefixExamSource = null } = {}) {
  const subject = prefixExamSource === null
    ? await makeCurrentSubject(root)
    : await makePrefixSubject(prefixExamSource);
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  for (const name of ALL_CHECKS) {
    const check = checks[name];
    await record(name, () => check(subject));
  }

  let extra = { examSha256: null, graderSha256: null, aggregationSha256: null, mustFailObserved: null };

  if (prefixExamSource !== null) {
    const byName = new Map(results.map((r) => [r.name, r]));
    await record(DISCRIMINATION_CHECK, async () => {
      const examSha256 = sha256(prefixExamSource);
      assertEqual(examSha256, PREFIX_EXAM_SHA256, 'the pre-fix exam.js must be the recorded base blob (byte-for-byte)');
      const graderSha256 = sha256(subject.graderSpan);
      assertEqual(graderSha256, PREFIX_GRADER_SHA256, 'the extracted grader span must match its recorded digest (byte-for-byte)');
      const aggregationSha256 = sha256(subject.aggregationSpan);
      extra.examSha256 = examSha256;
      extra.graderSha256 = graderSha256;
      extra.aggregationSha256 = aggregationSha256;

      const notFailing = PREFIX_MUST_FAIL.filter((name) => byName.get(name)?.ok !== false);
      assertEqual(notFailing, [], 'these checks must fail on the pre-fix tree, but passed');
      const controlsBroken = CONTROL_CHECKS.filter((name) => byName.get(name)?.ok !== true);
      assertEqual(controlsBroken, [], 'these control checks must still pass on the pre-fix tree');
      extra.mustFailObserved = PREFIX_MUST_FAIL.length;
      return `${PREFIX_MUST_FAIL.length}/${PREFIX_MUST_FAIL.length} defect checks fail and ${CONTROL_CHECKS.length} controls pass on the pre-fix exam.js (exam sha256 ${examSha256.slice(0, 12)}, grader sha256 ${graderSha256.slice(0, 12)})`;
    });
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    root,
    subject: subject.name,
    treeLayer: subject.treeLayer,
    envPath: null,
    ...extra,
  };
}

/* ------------------------------------------------------- pre-fix materialization */

/**
 * Materialize the pre-fix exam.js from git into a throwaway directory, so the
 * discrimination run uses the real pre-fix bytes and not a stand-in.
 */
export function materializePrefixTree({ root = DEFAULT_ROOT, base = PREFIX_BASE } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-wo02-prefix-'));
  const rel = 'public/js/exam.js';
  const content = execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const target = path.join(dest, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { root: dest, base, file: target };
}

/* ----------------------------------------------------------------------- CLI */

function printRun(report, io) {
  io.log(`  subject: ${report.subject} (${report.treeLayer}) @ ${report.root}`);
  for (const result of report.results) {
    io.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  [${result.detail}]`);
  }
}

export async function runCli(argv = process.argv.slice(2), io = console) {
  const prefixIndex = argv.indexOf('--prefix-root');
  const prefixValue = prefixIndex === -1 ? null : argv[prefixIndex + 1];
  if (prefixIndex !== -1 && (!prefixValue || prefixValue.startsWith('-'))) {
    io.error('  FAIL  --prefix-root requires a path to a pre-fix checkout');
    return 1;
  }

  io.log('mock-outcome-check: absent/failed writing stays unassessed (WRITING-OUTCOMES-02)');

  let prefixFile = prefixValue ? path.resolve(prefixValue) : null;
  let materialized = null;
  if (prefixFile && fs.existsSync(path.join(prefixFile, 'public/js/exam.js'))) {
    prefixFile = path.join(prefixFile, 'public/js/exam.js');
  } else if (prefixFile && !fs.existsSync(prefixFile)) {
    io.error(`  FAIL  no exam.js under ${prefixFile}`);
    return 1;
  } else if (!prefixFile) {
    try {
      materialized = materializePrefixTree();
      prefixFile = materialized.file;
      io.log(`  pre-fix exam.js materialized from git ${materialized.base} -> ${materialized.root}`);
    } catch (err) {
      io.error(`  FAIL  could not materialize the pre-fix tree (${err.message}).`);
      io.error('        Pass --prefix-root <path to a checkout of the pre-fix tree>.');
      return 1;
    }
  }

  let report;
  try {
    report = await runMockOutcomeChecks();
    printRun(report, io);
    const prefixSource = fs.readFileSync(prefixFile, 'utf8');
    const prefixReport = await runMockOutcomeChecks({ prefixExamSource: prefixSource });
    io.log('  --- against the pre-fix exam.js ---');
    printRun(prefixReport, io);
  } catch (err) {
    io.error(`  FAIL  the probe could not run: ${err.message}`);
    return 1;
  } finally {
    if (materialized) fs.rmSync(materialized.root, { recursive: true, force: true });
  }

  const failed = report.results.filter((result) => !result.ok);
  if (report.ok) {
    io.log(`  OK    ${report.results.length} check(s) passed, including discrimination against the pre-fix exam.js.`);
    io.log('  NOTE  Module + source-substring layer only: no browser, so no real page lifecycle, timer or keyboard behaviour is exercised.');
    return 0;
  }
  io.error(`  FAIL  ${failed.length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
