/**
 * Offline checks for WRITING-OUTCOMES-02: the mock exercise must not claim
 * outcomes it cannot support.
 *
 * Before this change `public/js/exam.js` graded the mock writing block with an
 * offline heuristic whenever the model was unavailable or failed, recorded those
 * heuristic checks as assessed writing outcomes, and derived "Bestanden?" and a
 * whole-exam grade band from the written points alone - while Sprechen was never
 * assessed. That is a claim the pilot cannot support.
 *
 * This file proves the rules the fix must keep:
 *   1. missing, too-short, unavailable or failed writing stays `unassessed` with
 *      `points: null`, and the submitted text is preserved;
 *   2. a malformed provider reply is not trusted (it becomes `unassessed`);
 *   3. successful model feedback is `provisional`, never authoritative;
 *   4. a legitimate zero from a complete rubric reply is `0`, distinct from missing;
 *   5. aggregation keeps the objective denominator and reports writing separately;
 *   6. no pass/fail, grade band or readiness percentage is derived;
 *   7. one block completes once, even under timer/click races or a new mock.
 *
 * Discrimination (the point of this file): every check is also run against the
 * pre-fix `public/js/exam.js` materialized byte-for-byte from git at the recorded
 * base commit, and the check set that must fail there is asserted exactly. A probe
 * that passes on both broken and fixed code proves nothing, so the failure set is
 * recorded literally, not re-derived. The pre-fix module's sha256 is verified so
 * the comparison cannot silently drift to a different tree.
 *
 * Scope and honesty:
 *   * module level only - the browser page lifecycle is exercised separately by
 *     the optional tools/mock-outcome-browser-check.mjs, when a browser is present;
 *   * no provider call, no credential, no learner record: the model is a stub and
 *     every request value is synthetic;
 *   * `exam.js` is a browser view module, so its internal functions are reached by
 *     a mechanical transform (strip ESM imports/exports, inject dependencies) and
 *     run in `node:vm`. The transform is identical for both trees.
 *
 * Usage: node tools/mock-outcome-check.mjs [--prefix-root <checkout>]
 * Exit code 0 when every check passes on the fixed tree AND the expected checks
 * fail on the pre-fix tree, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/* Browser storage is not used by the pure module, but `store.js`/`engine.js`
 * import it, so a minimal in-memory stand-in keeps the import inert. */
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

/* `shell.js` touches `document` inside its helpers; the extracted views call
 * those helpers, so a minimal inert document keeps the module layer testable. */
globalThis.document = {
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {} }),
  addEventListener: () => {},
  title: '',
};

const shell = await import('../public/js/shell.js');
const store = await import('../public/js/store.js');
const engine = await import('../public/js/engine.js');
const blueprint = await import('../public/js/blueprint.js');
const mockOutcome = await import('../public/js/mock-outcome.js');

/**
 * The base the WRITING-OUTCOMES-02 branch starts from; the pre-fix `exam.js` is
 * materialized from it. Recorded so the discrimination cannot silently drift.
 */
export const PREFIX_BASE = process.env.B1PREP_WO02_PREFIX_BASE || '41b5efb3b967dc529b6a05c4ff47d99fb757fb94';
/** sha256 of `git show <base>:public/js/exam.js` at the base commit. */
export const PREFIX_EXAM_SHA256 = 'a4ae5192a133d4373e142ee6e90ddb0805befb6358650730071b7d584a27704e';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The acceptance checks the test file asserts ran and passed on this tree. */
export const REQUIRED_CHECKS = [
  'missing-writing-is-unassessed-not-zero',
  'too-short-writing-is-unassessed',
  'unavailable-writing-is-unassessed',
  'malformed-response-is-unassessed',
  'unassessed-writing-keeps-the-submitted-text',
  'successful-writing-is-provisional',
  'legitimate-zero-is-assessed-not-missing',
  'summary-keeps-objective-denominator',
  'summary-reports-writing-separately',
  'summary-derives-no-pass-band-or-readiness',
  'result-view-shows-no-pass-or-band',
  'result-view-shows-objective-denominator-only',
  'result-view-keeps-unassessed-writing-visible',
  'completion-gate-commits-once-under-concurrency',
  'completion-gate-drops-stale-block-completion',
  'completion-gate-rejects-completion-from-a-new-mock',
];

/**
 * Checks that MUST fail on the pre-fix `exam.js`. Recorded literally; the runner
 * asserts this exact set, so a check that stops discriminating is caught.
 */
export const PREFIX_FAILURES = [
  'missing-writing-is-unassessed-not-zero',
  'too-short-writing-is-unassessed',
  'unavailable-writing-is-unassessed',
  'malformed-response-is-unassessed',
  'successful-writing-is-provisional',
  'legitimate-zero-is-assessed-not-missing',
  'summary-keeps-objective-denominator',
  'summary-reports-writing-separately',
  'summary-derives-no-pass-band-or-readiness',
  'result-view-shows-no-pass-or-band',
  'result-view-shows-objective-denominator-only',
  'result-view-keeps-unassessed-writing-visible',
  'completion-gate-commits-once-under-concurrency',
  'completion-gate-drops-stale-block-completion',
  'completion-gate-rejects-completion-from-a-new-mock',
];

/* ------------------------------------------------------------- fixtures */

/** Synthetic learner text - never copied from any real exam or learner. */
export const LONG_TEXT = [
  'Sehr geehrte Frau Berger,',
  'ich schreibe Ihnen, weil ich am Samstag leider nicht am Deutschkurs teilnehmen kann.',
  'Meine Schwester heiratet an diesem Tag und die Feier dauert bis in den Abend.',
  'Deshalb möchte ich Sie fragen, ob ich die Aufgaben per E-Mail bekommen kann.',
  'Außerdem würde ich gern wissen, ob es einen Ersatztermin in der nächsten Woche gibt.',
  'Vielen Dank für Ihre Hilfe und freundliche Grüße, Ana',
].join(' ');
export const SHORT_TEXT = 'Hallo, ich kann nicht kommen.';

export const TASK = {
  partId: 'SA1',
  situation: 'Sie koennen am Samstag nicht zum Kurs kommen. Schreiben Sie eine E-Mail.',
  adressat: 'Ihre Kursleiterin Frau Berger (Sie)',
  register: 'Sie',
  leitpunkte: ['Nennen Sie den Grund.', 'Fragen Sie nach den Aufgaben.', 'Fragen Sie nach einem Ersatztermin.', 'Schliessen Sie hoeflich.'],
};

/** A complete, internally consistent rubric reply worth `total` points. */
export function feedbackFor(total, overrides = {}) {
  const split = { aufgabe: 15, kommunikation: 10, richtigkeit: 12, ausdruck: 8 };
  const criteria = Object.entries(split).map(([key, max]) => ({
    key,
    score: max ? Math.round((total / 45) * 100) : 0,
    points: Math.min(max, Math.round((total * max) / 45)),
    comment: 'synthetic',
  }));
  // Make the criteria sum exactly the requested total.
  let sum = criteria.reduce((s, c) => s + c.points, 0);
  let i = 0;
  while (sum !== total) {
    const c = criteria[i % criteria.length];
    if (sum < total && c.points < split[c.key]) { c.points += 1; sum += 1; }
    else if (sum > total && c.points > 0) { c.points -= 1; sum -= 1; }
    i += 1;
  }
  return {
    criteria,
    total,
    band: 'synthetic',
    leitpunkteCovered: [true, true, true, true],
    corrections: [{ original: 'ich kann nicht', corrected: 'ich kann leider nicht', explanation: 'synthetic' }],
    strengths: ['synthetic'],
    priorities: ['synthetic'],
    modelAnswer: 'Synthetic model answer.',
    ...overrides,
  };
}

/** Objective part results as `scoreSet` produces them, for the aggregation checks. */
export function objectiveResults() {
  return [
    { partId: 'LV1', correct: 5, total: 5, items: [] },
    { partId: 'LV2', correct: 3, total: 5, items: [] },
    { partId: 'LV3', correct: 2, total: 5, items: [] },
    { partId: 'SB1', correct: 1, total: 5, items: [] },
    { partId: 'SB2', correct: 0, total: 5, items: [] },
    { partId: 'HV1', correct: 4, total: 5, items: [] },
    { partId: 'HV2', correct: 2, total: 5, items: [] },
    { partId: 'HV3', correct: 5, total: 5, items: [] },
  ];
}

/* --------------------------------------------------------------- helpers */

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const assertTrue = (value, label) => { if (!value) throw new Error(label); };

/* --------------------------------------------- exam.js extraction (vm) */

/**
 * `exam.js` is a browser ESM view module. To reach its internal `gradeMockWriting`
 * and `renderMockResult` unchanged, strip the static imports (re-injected from an
 * explicit dependency map) and the `export` keywords, then evaluate it in a vm
 * context. Function declarations land on the context object; `let mockState` is
 * exposed through a small accessor appended to the same script scope.
 */
export function evaluateExam(source, deps) {
  const unresolved = [];
  let code = source.replace(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';[ \t]*$/gm, (m, spec, mod) => {
    const ns = deps[mod];
    if (!ns) { unresolved.push(mod); return `/* unresolved import: ${mod} */`; }
    const s = spec.trim();
    if (/^\*\s+as\s+/.test(s)) return `const ${s.replace(/^\*\s+as\s+/, '').trim()} = __ns[${JSON.stringify(mod)}];`;
    const names = s.replace(/[{}]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    return `const { ${names.join(', ')} } = __ns[${JSON.stringify(mod)}];`;
  });
  code = code.replace(/^export\s+/gm, '');
  code += '\n;globalThis.__probe = { setMockState(v) { mockState = v; }, getMockState() { return mockState; } };\n';

  const ctx = {
    __ns: deps,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Math, Date, Number, String, Boolean, Object, Array, Set, Map, Error, RegExp,
    isNaN, parseInt, parseFloat,
    document: {
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {} }),
      addEventListener: () => {},
    },
  };
  vm.createContext(ctx);
  new vm.Script(code, { filename: 'exam-extracted.js' }).runInContext(ctx);
  return { ctx, unresolved };
}

/** Build a probe target from an `exam.js` source string. */
export function makeImpl(label, source, { fixed }) {
  const provider = { configured: false, grade: null };
  const storeStub = { recordAttempt() {}, addError() {}, weakNodes: () => [], listErrors: () => [] };
  const aiStub = {
    isConfigured: () => provider.configured,
    gradeWriting: (args) => provider.grade(args),
  };
  const deps = {
    './shell.js': shell,
    './store.js': storeStub,
    './engine.js': engine,
    './ai.js': aiStub,
    './blueprint.js': blueprint,
    './speech.js': {},
    './mock-outcome.js': mockOutcome,
  };
  const { ctx, unresolved } = evaluateExam(source, deps);
  const setProvider = (next) => { provider.configured = Boolean(next.configured); provider.grade = next.grade; };

  return {
    label,
    fixed,
    unresolved,
    setProvider,
    /** Run the tree's own `gradeMockWriting` exactly as the mock does. */
    async assess({ text, configured, grade }) {
      setProvider({ configured, grade });
      const wrap = { querySelector: () => ({ value: text, readOnly: false }) };
      return ctx.gradeMockWriting(wrap, TASK);
    },
    /** Render the tree's own result view and return the produced HTML. */
    renderResult(blockResults, { startedAt = 0, finishedAt = 90000 } = {}) {
      ctx.__probe.setMockState({ phase: 'done', blockResults, sets: {}, answers: {}, startedAt, finishedAt });
      const el = { innerHTML: '', querySelector: () => null };
      ctx.renderMockResult(el);
      return el.innerHTML;
    },
    summary: fixed ? (results) => mockOutcome.buildMockSummary(results) : undefined,
    gate: fixed ? () => mockOutcome.createCompletionGate() : undefined,
  };
}

/* --------------------------------------------------------------- probes */

const fail = (detail) => ({ ok: false, detail });
const pass = (detail = 'ok') => ({ ok: true, detail });

export const PROBES = [
  {
    name: 'missing-writing-is-unassessed-not-zero',
    async run(impl) {
      const entry = await impl.assess({ text: '', configured: false, grade: async () => feedbackFor(30) });
      if (entry.points !== null) return fail(`missing writing produced points ${JSON.stringify(entry.points)} instead of null`);
      if (entry.status !== 'unassessed') return fail(`missing writing status is ${JSON.stringify(entry.status)}`);
      return pass();
    },
  },
  {
    name: 'too-short-writing-is-unassessed',
    async run(impl) {
      const entry = await impl.assess({ text: SHORT_TEXT, configured: true, grade: async () => feedbackFor(30) });
      if (entry.points !== null) return fail(`too-short writing produced points ${JSON.stringify(entry.points)}`);
      if (entry.status !== 'unassessed') return fail(`too-short writing status is ${JSON.stringify(entry.status)}`);
      return pass();
    },
  },
  {
    name: 'unavailable-writing-is-unassessed',
    async run(impl) {
      const entry = await impl.assess({ text: LONG_TEXT, configured: true, grade: async () => { throw new Error('provider down'); } });
      if (entry.points !== null) return fail(`failed grading produced points ${JSON.stringify(entry.points)}`);
      if (entry.status !== 'unassessed') return fail(`failed grading status is ${JSON.stringify(entry.status)}`);
      return pass();
    },
  },
  {
    name: 'malformed-response-is-unassessed',
    async run(impl) {
      const entry = await impl.assess({ text: LONG_TEXT, configured: true, grade: async () => ({ total: 12, criteria: 'nope' }) });
      if (entry.points !== null) return fail(`malformed reply produced points ${JSON.stringify(entry.points)}`);
      if (entry.status !== 'unassessed') return fail(`malformed reply status is ${JSON.stringify(entry.status)}`);
      return pass();
    },
  },
  {
    name: 'unassessed-writing-keeps-the-submitted-text',
    async run(impl) {
      const entry = await impl.assess({ text: LONG_TEXT, configured: true, grade: async () => { throw new Error('provider down'); } });
      if (entry.text !== LONG_TEXT) return fail('the submitted text was not preserved on an unassessed entry');
      return pass();
    },
  },
  {
    name: 'successful-writing-is-provisional',
    async run(impl) {
      const entry = await impl.assess({ text: LONG_TEXT, configured: true, grade: async () => feedbackFor(38) });
      if (entry.status !== 'provisional') return fail(`successful feedback status is ${JSON.stringify(entry.status)}`);
      if (entry.points !== 38) return fail(`successful feedback points ${JSON.stringify(entry.points)} != 38`);
      if (entry.correct !== null) return fail('a provisional writing entry must not carry a right/wrong verdict');
      return pass();
    },
  },
  {
    name: 'legitimate-zero-is-assessed-not-missing',
    async run(impl) {
      const entry = await impl.assess({ text: LONG_TEXT, configured: true, grade: async () => feedbackFor(0) });
      if (entry.status !== 'provisional') return fail(`zero score status is ${JSON.stringify(entry.status)}`);
      if (entry.points !== 0) return fail(`zero score points ${JSON.stringify(entry.points)} != 0`);
      return pass();
    },
  },
  {
    name: 'summary-keeps-objective-denominator',
    async run(impl) {
      if (!impl.summary) return fail('no aggregation exists on this tree');
      const summary = impl.summary(objectiveResults());
      if (summary.objective.max !== 180) return fail(`objective denominator ${summary.objective.max} != 180 (the 8 objectively scored parts)`);
      if (summary.objective.total !== 40) return fail(`objective item count ${summary.objective.total} != 40`);
      if (summary.objective.correct !== 22) return fail(`objective correct ${summary.objective.correct} != 22`);
      // LV1 is 5/5 of 25 points; SB2 is 0/5 of 15 points.
      assertEqual(Number(summary.objective.byPart.LV1.points.toFixed(2)), 25, 'LV1 points');
      assertEqual(Number(summary.objective.byPart.SB2.points.toFixed(2)), 0, 'SB2 points');
      return pass();
    },
  },
  {
    name: 'summary-reports-writing-separately',
    async run(impl) {
      if (!impl.summary) return fail('no aggregation exists on this tree');
      const unassessed = { partId: 'SA1', rubric: true, status: 'unassessed', reason: 'feedback_failed', points: null, text: LONG_TEXT, analysis: { words: 60 } };
      const summary = impl.summary([...objectiveResults(), unassessed]);
      if (summary.objective.max !== 180) return fail('writing leaked into the objective denominator');
      if (!summary.writing || summary.writing.status !== 'unassessed') return fail('writing was not reported as unassessed');
      if (summary.writing.text !== LONG_TEXT) return fail('writing text missing from the summary');
      if (summary.writing.points !== null) return fail('unassessed writing carried points');
      const provisional = impl.summary([...objectiveResults(), { partId: 'SA1', rubric: true, status: 'provisional', points: 0, text: LONG_TEXT, aiResult: {} }]);
      if (provisional.writing.status !== 'provisional' || provisional.writing.points !== 0) return fail('a legitimate zero was not kept as assessed');
      if (provisional.objective.max !== 180) return fail('provisional writing changed the objective denominator');
      return pass();
    },
  },
  {
    name: 'summary-derives-no-pass-band-or-readiness',
    async run(impl) {
      if (!impl.summary) return fail('no aggregation exists on this tree');
      const summary = impl.summary([...objectiveResults(), { partId: 'SA1', rubric: true, status: 'provisional', points: 40, text: LONG_TEXT, aiResult: {} }]);
      for (const key of ['pass', 'band', 'readinessPercent']) {
        if (summary[key] !== null) return fail(`summary.${key} = ${JSON.stringify(summary[key])} (must be null)`);
      }
      return pass();
    },
  },
  {
    name: 'result-view-shows-no-pass-or-band',
    async run(impl) {
      const html = impl.renderResult([...objectiveResults(), { partId: 'SA1', rubric: true, status: 'unassessed', reason: 'unavailable', points: null, text: LONG_TEXT, analysis: engine.analyseWriting(LONG_TEXT, TASK) }]);
      if (/Bestanden/i.test(html)) return fail('the result view still claims a pass/fail');
      if (/sehr gut|befriedigend|ausreichend|nicht bestanden/i.test(html)) return fail('the result view still shows a grade band');
      return pass();
    },
  },
  {
    name: 'result-view-shows-objective-denominator-only',
    async run(impl) {
      const html = impl.renderResult([...objectiveResults(), { partId: 'SA1', rubric: true, status: 'unassessed', reason: 'unavailable', points: null, text: LONG_TEXT }]);
      if (!html.includes('/ 180')) return fail('the objective denominator 180 is not shown');
      if (/\/\s*225/.test(html) || /\/\s*300/.test(html)) return fail('the view still shows a whole-exam denominator');
      return pass();
    },
  },
  {
    name: 'result-view-keeps-unassessed-writing-visible',
    async run(impl) {
      const html = impl.renderResult([...objectiveResults(), { partId: 'SA1', rubric: true, status: 'unassessed', reason: 'unavailable', points: null, text: LONG_TEXT }]);
      if (!html.includes(LONG_TEXT)) return fail('the submitted text is not visible in the result view');
      if (!/nicht bewertet/i.test(html)) return fail('the unassessed state is not shown');
      return pass();
    },
  },
  {
    name: 'completion-gate-commits-once-under-concurrency',
    async run(impl) {
      if (!impl.gate) return fail('this tree has no completion gate');
      const gate = impl.gate();
      let collects = 0;
      let commits = 0;
      const call = () => gate({ isCurrent: () => true, collect: async () => { collects += 1; return ['r']; }, commit: () => { commits += 1; } });
      const results = await Promise.all([call(), call(), call()]);
      if (commits !== 1) return fail(`concurrent completions committed ${commits} times`);
      if (collects !== 1) return fail(`concurrent completions collected ${collects} times`);
      if (!results.every((r) => r === true)) return fail('a concurrent completion did not report success');
      return pass();
    },
  },
  {
    name: 'completion-gate-drops-stale-block-completion',
    async run(impl) {
      if (!impl.gate) return fail('this tree has no completion gate');
      const gate = impl.gate();
      let current = true;
      let commits = 0;
      const pending = gate({ isCurrent: () => current, collect: async () => { current = false; return ['r']; }, commit: () => { commits += 1; } });
      const ok = await pending;
      if (ok !== false) return fail('a stale completion reported success');
      if (commits !== 0) return fail('a stale completion still committed');
      return pass();
    },
  },
  {
    name: 'completion-gate-rejects-completion-from-a-new-mock',
    async run(impl) {
      if (!impl.gate) return fail('this tree has no completion gate');
      const sessionA = {};
      let current = sessionA;
      const gate = impl.gate();
      let commits = 0;
      const pending = gate({ isCurrent: () => current === sessionA, collect: async () => { current = {}; return ['r']; }, commit: () => { commits += 1; } });
      const ok = await pending;
      if (ok !== false) return fail('a completion from an abandoned mock reported success');
      if (commits !== 0) return fail('a completion from an abandoned mock was committed to the new one');
      return pass();
    },
  },
];

/** Run every probe against one implementation. */
export async function runProbes(impl) {
  const results = [];
  for (const probe of PROBES) {
    try {
      const outcome = await probe.run(impl);
      results.push({ name: probe.name, ok: outcome.ok, detail: outcome.detail });
    } catch (err) {
      results.push({ name: probe.name, ok: false, detail: `threw: ${err.message}` });
    }
  }
  return results;
}

/* ------------------------------------------------- materialize pre-fix */

/** Materialize the pre-fix `exam.js` from git into a throwaway directory. */
export function materializePrefixTree({ root = DEFAULT_ROOT, base = PREFIX_BASE } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-wo02-prefix-'));
  const content = execFileSync('git', ['-C', root, 'show', `${base}:public/js/exam.js`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const file = path.join(dest, 'exam-prefix.js');
  fs.writeFileSync(file, content, 'utf8');
  return { root: dest, file, base, sha256, source: content };
}

/** Literal pre-fix behaviours, recorded so the discrimination is falsifiable. */
export const PREFIX_LITERALS = Object.freeze({
  missingWritingPoints: 0,
  missingWritingHasNoStatus: true,
  successfulWritingHasNoStatus: true,
  resultViewClaimsPass: true,
  resultViewWholeExamDenominator: '/ 225',
});

/**
 * Collect the pre-fix tree's literal answers to the scenarios the fix changes.
 * These are compared byte-for-byte (strict equality on the returned values), not
 * re-derived, so a comparison that drifts is caught.
 */
export async function collectPrefixLiterals(impl) {
  const missing = await impl.assess({ text: '', configured: false, grade: async () => feedbackFor(30) });
  const success = await impl.assess({ text: LONG_TEXT, configured: true, grade: async () => feedbackFor(38) });
  const html = impl.renderResult([
    ...objectiveResults(),
    { partId: 'SA1', rubric: true, status: 'unassessed', reason: 'unavailable', points: null, text: LONG_TEXT, analysis: engine.analyseWriting(LONG_TEXT, TASK) },
  ]);
  return {
    missingWritingPoints: missing.points,
    missingWritingHasNoStatus: !('status' in missing) || missing.status === undefined,
    successfulWritingHasNoStatus: !('status' in success) || success.status === undefined,
    resultViewClaimsPass: /Bestanden/i.test(html),
    resultViewWholeExamDenominator: /\/\s*225/.test(html) ? '/ 225' : '(none)',
  };
}

/* ----------------------------------------------------------------- CLI */

export async function runMockOutcomeChecks({ prefixSource = null } = {}) {
  const fixedSource = fs.readFileSync(path.join(DEFAULT_ROOT, 'public/js/exam.js'), 'utf8');
  const fixed = makeImpl('fixed', fixedSource, { fixed: true });
  const results = await runProbes(fixed);

  let prefix = null;
  let prefixResults = null;
  let prefixLiterals = null;
  if (prefixSource) {
    prefix = makeImpl('prefix', prefixSource, { fixed: false });
    prefixResults = await runProbes(prefix);
    prefixLiterals = await collectPrefixLiterals(prefix);
  }
  return { results, prefixResults, prefixLiterals, prefixUnresolved: prefix?.unresolved || [] };
}

async function main() {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf('--prefix-root');
  const root = rootArg >= 0 ? args[rootArg + 1] : DEFAULT_ROOT;
  const log = (line) => console.log(line);
  const error = (line) => console.error(line);

  let prefixTree = null;
  let prefixError = null;
  try {
    prefixTree = materializePrefixTree({ root });
  } catch (err) {
    prefixError = err.message;
  }

  if (prefixTree) {
    log(`pre-fix exam.js materialized from git ${prefixTree.base} (sha256 ${prefixTree.sha256.slice(0, 12)}...)`);
    if (prefixTree.sha256 !== PREFIX_EXAM_SHA256) {
      error(`FATAL: pre-fix exam.js sha256 ${prefixTree.sha256} != recorded ${PREFIX_EXAM_SHA256}`);
      process.exitCode = 1;
      return;
    }
  } else {
    error(`WARNING: could not materialize the pre-fix tree (${prefixError}); discrimination not proven.`);
  }

  const report = await runMockOutcomeChecks({ prefixSource: prefixTree?.source || null });
  const fixedFailures = report.results.filter((r) => !r.ok);
  log(`fixed tree: ${report.results.length - fixedFailures.length}/${report.results.length} checks passed`);
  for (const f of fixedFailures) error(`  FAIL ${f.name}: ${f.detail}`);

  let discriminationOk = false;
  if (report.prefixResults) {
    const failed = report.prefixResults.filter((r) => !r.ok).map((r) => r.name).sort();
    const expected = [...PREFIX_FAILURES].sort();
    discriminationOk = failed.length === expected.length && failed.every((n, i) => n === expected[i]);
    const literalKeys = Object.keys(PREFIX_LITERALS);
    const literalsOk = literalKeys.every((k) => report.prefixLiterals[k] === PREFIX_LITERALS[k]);
    log(`pre-fix literals: ${literalsOk ? 'match' : 'MISMATCH'} ${JSON.stringify(report.prefixLiterals)}`);
    if (!literalsOk) error(`  expected literals ${JSON.stringify(PREFIX_LITERALS)}`);
    discriminationOk = discriminationOk && literalsOk;
    log(`pre-fix tree: ${failed.length} checks fail (expected ${expected.length})`);
    for (const name of failed) log(`  pre-fix FAIL ${name}`);
    if (!discriminationOk) {
      error('DISCRIMINATION MISMATCH: the failing set on the pre-fix tree is not the recorded set.');
      error(`  expected: ${expected.join(', ')}`);
      error(`  actual:   ${failed.join(', ')}`);
    }
  }

  if (fixedFailures.length || !discriminationOk) {
    process.exitCode = 1;
    return;
  }
  log('mock-outcome: all checks pass and the probe discriminates against the pre-fix tree.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
