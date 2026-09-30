/**
 * Offline checks for PM-01: `progressEqual` was key-order sensitive, so identical records
 * compared unequal.
 *
 * `public/js/progress-merge.js` exports `mergeProgress()` and `progressEqual()`.
 * `progressEqual` was a raw `JSON.stringify(a) === JSON.stringify(b)`, while `mergeProgress`
 * builds its output object with a different key order than the state it is given
 * (`counters` precedes `nodes`). Measured on the base commit:
 *
 *   progressEqual(state, mergeProgress(state, state)) === false
 *   state keys : version,createdAt,updatedAt,settings,nodes,history,errors,srs,days,planDone,counters
 *   merged keys: version,createdAt,updatedAt,settings,counters,nodes,history,errors,srs,days,planDone
 *
 * The consequence is not merely a wasted payload. `server.js` does
 * `if (!progressEqual(state, merged)) payload.state = merged;`, which was therefore always
 * true: the server shipped a full merged state on every POST, and no caller could use
 * `progressEqual` to answer the one question it exists to answer - "did anything actually
 * change?".
 *
 * The fix compares a stable key-ordered (canonical) serialisation instead. This file proves:
 *   1. `progressEqual(state, mergeProgress(state, state))` is true for several shapes -
 *      a fresh empty state, a populated state, a top-level key-order variant and a nested
 *      key-order variant;
 *   2. it is still false for genuinely different records (changed counter, changed node,
 *      removed key, added key) - a comparison that returned true for everything would pass
 *      (1) and must not pass this;
 *   3. it is symmetric;
 *   4. the probe discriminates: the *same* check-1 shapes fail (strict `=== false`) when run
 *      against the pre-fix `progress-merge.js` materialized byte-for-byte from git - a probe
 *      that passes on both trees is worthless;
 *   5. `server.js` now omits `payload.state` on a POST that merges to no logical change, and
 *      still returns the merged state when the merge recovered something - demonstrated with
 *      real HTTP requests against an in-process server and a throwaway env file. The same
 *      probe run against the pre-fix server returns the state every time.
 *
 * Scope and honesty:
 *   * HTTP + module layer only. No browser process: real page lifecycle is not exercised.
 *   * The pre-fix tree is materialized from git (`git show`), not simulated, and its
 *     `progress-merge.js` is verified byte-for-byte against a recorded sha256.
 *   * The discrimination step compares the literal returned booleans (strict `=== false`),
 *     not a logical re-derivation - an earlier probe in this programme passed on both trees
 *     and had to be rejected.
 *
 * Safety:
 *   * `B1PREP_ENV_FILE` and `B1PREP_PROGRESS_FILE` point into throwaway temp directories and
 *     `B1PREP_FORCE_OFFLINE=1`, so no repository `.env`, no learner record, no database and no
 *     provider call is involved. Every value is synthetic and deliberately not `sk-` shaped.
 *
 * Usage: node tools/progress-equal-check.mjs [--prefix-root <path>]
 *   The pre-fix tree is materialized from git when `--prefix-root` is omitted.
 * Exit code 0 when every check passes AND both discrimination probes fail on the pre-fix
 * tree, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'progress-equal-check-synthetic-value-not-a-real-key';
export const EXAM_DATE = '2031-03-15';

/**
 * The base the PM-01 branch starts from; the pre-fix module and server are materialized
 * from it. Recorded so the discrimination cannot silently drift to a different commit.
 */
export const PREFIX_BASE = process.env.B1PREP_PM01_PREFIX_BASE || 'f5bc4be151a6c8555f178e67a80f12e5e9a5575f';

/** sha256 of `git show <base>:public/js/progress-merge.js` at the base commit. */
export const PREFIX_MERGE_SHA256 = '5450bdbdbee148d373bfca51d5723f937f33f1c268cbcc6a5d9ebcd13e8ae64f';

/** The acceptance checks the test file asserts ran and passed on this tree. */
export const REQUIRED_CHECKS = [
  'equal-for-fresh-empty-state',
  'equal-for-populated-state',
  'equal-for-top-level-key-order',
  'equal-for-nested-key-order',
  'unequal-for-genuinely-different-records',
  'comparison-is-symmetric',
  'http-omits-state-when-merge-changes-nothing',
  'http-returns-state-when-merge-changes-something',
];

/** The module-level discrimination check, run only when a pre-fix tree is available. */
export const DISCRIMINATION_CHECK = 'probe-discriminates-on-prefix-module';
/** The HTTP-level discrimination check: the pre-fix server returns the state every time. */
export const DISCRIMINATION_HTTP_CHECK = 'prefix-server-returns-state-on-identical-post';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------- assertions */

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, label) {
  if (!value) throw new Error(label);
}

/* ------------------------------------------------------------------ fixtures */

/**
 * The canonical "fresh, empty" state, matching `freshState()` in `public/js/store.js`: a
 * full-shaped record whose containers are empty. It is *not* the literal `{}` - a bare `{}`
 * is genuinely different from what `mergeProgress` produces (the merge legitimately adds the
 * default fields), so requiring that to compare equal would demand an always-true function,
 * which check 2 forbids. The key-order defect is present on this realistic fresh state too.
 */
export function freshState() {
  return {
    version: 1,
    createdAt: 1730000000000,
    updatedAt: 0,
    settings: { examDate: '', dailyGoal: 20, ttsRate: 0.95, autoPlay: true, model: 'deepseek-chat' },
    nodes: {},
    history: [],
    errors: [],
    srs: {},
    days: {},
    planDone: {},
    counters: { attempts: 0, correct: 0, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

/** Synthetic populated record. Everything in it is invented. */
export function seededState() {
  const now = 1730000000000;
  return {
    version: 1,
    createdAt: now - 86400000,
    updatedAt: now,
    settings: { examDate: EXAM_DATE, dailyGoal: 30, ttsRate: 1.1, model: 'deepseek-chat', writingTaskIndex: 3 },
    nodes: { 'skill:LV1': { theta: 61, n: 4, correct: 3, last: now - 3600000, streak: 1, kBase: 34 } },
    history: [
      { t: now - 1000, partId: 'LV1', tags: ['lv_global'], difficulty: 55, correct: true, source: 'drill', ms: 1200, itemRef: 'synthetic-item-1' },
    ],
    errors: [{
      id: 'pm01-synthetic-1',
      t: now - 500,
      partId: 'SB1',
      tags: ['konnektoren'],
      difficulty: 55,
      prompt: 'Prompt synthetic',
      yourAnswer: 'synthetisch',
      correctAnswer: 'synthetisch',
      explanation: 'synthetisch',
      reviewed: 0,
      resolved: false,
      source: 'drill',
    }],
    srs: { 'card-1': { box: 1, due: now + 86400000, reps: 2, lapses: 0 } },
    days: { '2031-03-15': { attempts: 1, correct: 1, ms: 1200, byPart: { LV1: 1 } } },
    planDone: { '2031-03-15': { review: true } },
    counters: { attempts: 1, correct: 1, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

/** Same data, only the top-level key insertion order reversed. */
function reorderTopLevel(value) {
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = value[key];
  return out;
}

/** Same data, top-level order preserved, but every nested object's keys reversed. */
function reorderNested(value) {
  if (Array.isArray(value)) return value.map(reorderNested);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = reorderNested(value[key]);
    return out;
  }
  return value;
}

/* -------------------------------------------------------------------- server */

const servers = new Map();

function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (body !== undefined && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Start one root's server.js in-process on an ephemeral port with a throwaway env/progress
 * file. The env vars are read at module load, so they must be set before the dynamic import;
 * a unique query makes each root a separate module instance with its own paths.
 */
async function ensureServer(root) {
  if (servers.has(root)) return servers.get(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-progress-equal-'));
  const envPath = path.join(dir, '.env');
  const progressPath = path.join(dir, 'progress.json');
  fs.writeFileSync(envPath, `DEEPSEEK_API_KEY=${SYNTHETIC_KEY}\nEXAM_DATE=${EXAM_DATE}\n`, 'utf8');

  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ENV_FILE = envPath;
  process.env.B1PREP_PROGRESS_FILE = progressPath;

  const href = `${pathToFileURL(path.join(root, 'server.js')).href}?suite=progress-equal&root=${encodeURIComponent(root)}`;
  const mod = await import(href);

  const ctx = { root, dir, envPath, progressPath, server: null, port: 0, baseUrl: '' };
  const server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.server = server;
  ctx.port = server.address().port;
  ctx.baseUrl = `http://127.0.0.1:${ctx.port}`;

  ctx.postProgress = (state) =>
    request(ctx.port, {
      method: 'POST',
      path: '/api/progress',
      headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
      body: JSON.stringify({ state }),
    });

  ctx.clearFiles = () => {
    for (const suffix of ['', '.bak', '.tmp', '.rev', '.rev.tmp']) {
      fs.rmSync(ctx.progressPath + suffix, { force: true });
    }
  };
  ctx.close = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };

  servers.set(root, ctx);
  return ctx;
}

/** Close every server this process started and remove its throwaway directory. */
export async function closeAll() {
  for (const ctx of servers.values()) await ctx.close();
  servers.clear();
}

/**
 * POST the same record twice (the second must merge to no logical change), then POST a
 * record the server is holding evidence for that this caller is missing (so the merge
 * genuinely recovers something). Returns the three responses.
 */
async function httpProbe(ctx) {
  ctx.clearFiles();
  const state = seededState();
  const first = await ctx.postProgress(state);
  const identical = await ctx.postProgress(state);
  const missingEvidence = await ctx.postProgress({ ...state, errors: [] });
  return { first, identical, missingEvidence };
}

/* ------------------------------------------------------------------- checks */

/**
 * Run every progress-equal check against one tree.
 * @param {{root?: string, legacyRoot?: string|null}} options
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>,
 *   root: string, legacyRoot: string|null, prefix: object|null, prefixSha: string|null,
 *   envPath: string, progressPath: string}>}
 */
export async function runProgressEqualChecks({ root = DEFAULT_ROOT, legacyRoot = null } = {}) {
  const { mergeProgress, progressEqual } = await import(
    `${pathToFileURL(path.join(root, 'public/js/progress-merge.js')).href}?tree=${encodeURIComponent(root)}`
  );
  const ctx = await ensureServer(root);
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  let prefix = null;
  let prefixSha = null;

  /** The four check-1 shapes, reused verbatim by the discrimination check. */
  const shapes = () => [
    ['fresh-empty-state', freshState()],
    ['populated-state', seededState()],
    ['top-level-key-order', reorderTopLevel(seededState())],
    ['nested-key-order', reorderNested(seededState())],
  ];

  try {
    /* 1. Reflexive equality of a merge with itself, regardless of key order. */
    for (const [label, state] of shapes()) {
      await record(`equal-for-${label}`, async () => {
        const merged = mergeProgress(state, state);
        assertEqual(
          progressEqual(state, merged),
          true,
          `progressEqual(${label}, mergeProgress(${label}, ${label}))`
        );
        return `equal; merged key order ${Object.keys(merged).join(',')}`;
      });
    }

    /* 2. Still a real comparison: these must be unequal. */
    await record('unequal-for-genuinely-different-records', async () => {
      const base = seededState();
      const cases = [
        ['changed counter', { ...base, counters: { ...base.counters, attempts: base.counters.attempts + 1 } }],
        ['changed node', { ...base, nodes: { ...base.nodes, 'skill:LV1': { ...base.nodes['skill:LV1'], theta: 99 } } }],
        ['removed key', { version: base.version }],
        ['added key', { ...base, extraField: true }],
        ['changed setting', { ...base, settings: { ...base.settings, dailyGoal: 999 } }],
        ['removed history entry', { ...base, history: [] }],
      ];
      for (const [label, other] of cases) {
        assertEqual(progressEqual(base, other), false, `${label} must compare unequal`);
      }
      // Not a constant: the square of the sames must still be equal.
      assertEqual(progressEqual(base, base), true, 'identical references must compare equal');
      assertEqual(progressEqual({ x: 1 }, { x: 1 }), true, 'identical plain objects must compare equal');
      assertEqual(progressEqual({ x: 1 }, { x: 2 }), false, 'different values must compare unequal');
      return `${cases.length} difference(s) detected; identical pairs still equal (not a constant)`;
    });

    /* 3. Symmetry, for equal and for unequal pairs. */
    await record('comparison-is-symmetric', async () => {
      const base = seededState();
      const pairs = [
        [base, reorderTopLevel(base)],
        [base, reorderNested(base)],
        [base, { ...base, counters: { ...base.counters, correct: 999 } }],
        [{ a: 1 }, { a: 1 }],
        [{ a: 1 }, { a: 1, b: 2 }],
        [base, mergeProgress(base, base)],
      ];
      for (const [x, y] of pairs) {
        assertEqual(
          progressEqual(x, y),
          progressEqual(y, x),
          'progressEqual(a,b) must equal progressEqual(b,a)'
        );
      }
      return `${pairs.length} pair(s) confirmed symmetric`;
    });

    /* 5a. HTTP: an identical POST merges to no logical change, so no state comes back. */
    await record('http-omits-state-when-merge-changes-nothing', async () => {
      const { first, identical } = await httpProbe(ctx);
      assertEqual(first.status, 200, 'seed POST status');
      assertEqual(identical.status, 200, 'identical POST status');
      assertEqual(identical.json?.merged, true, 'the second write must report a merge, not an overwrite');
      assertTrue(
        !Object.prototype.hasOwnProperty.call(identical.json, 'state'),
        `the response must omit payload.state when nothing changed, got ${JSON.stringify(identical.json).slice(0, 200)}`
      );
      return 'identical POST: ok, merged=true, payload.state omitted';
    });

    /* 5b. HTTP: a POST whose merge recovered evidence still returns the merged state. */
    await record('http-returns-state-when-merge-changes-something', async () => {
      const { missingEvidence } = await httpProbe(ctx);
      assertEqual(missingEvidence.status, 200, 'recovering POST status');
      assertTrue(
        Object.prototype.hasOwnProperty.call(missingEvidence.json, 'state'),
        'a POST whose merge recovered an entry must return the merged state'
      );
      assertEqual(
        missingEvidence.json.state?.errors?.length,
        1,
        'the returned state must carry the recovered notebook entry'
      );
      return 'recovering POST: ok, payload.state present with the recovered entry';
    });

    /* 4 and 5c. Discrimination against the pre-fix tree. */
    if (legacyRoot) {
      const prefixModule = await import(
        `${pathToFileURL(path.join(legacyRoot, 'public/js/progress-merge.js')).href}?tree=${encodeURIComponent(legacyRoot)}`
      );
      prefixSha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(legacyRoot, 'public/js/progress-merge.js')))
        .digest('hex');

      await record(DISCRIMINATION_CHECK, async () => {
        assertEqual(
          prefixSha,
          PREFIX_MERGE_SHA256,
          'the pre-fix progress-merge.js must be the recorded base blob (byte-for-byte)'
        );
        const failures = [];
        for (const [label, state] of shapes()) {
          const value = prefixModule.progressEqual(state, prefixModule.mergeProgress(state, state));
          // Strict byte-for-byte boolean: the pre-fix function must return exactly false.
          if (value !== false) failures.push(`${label} returned ${value}`);
        }
        assertEqual(
          failures.length,
          0,
          `the pre-fix module must fail every check-1 shape, but these did not: ${failures.join(', ')}`
        );
        return `all ${shapes().length} check-1 shapes returned false on the pre-fix module (sha256 ${prefixSha.slice(0, 12)})`;
      });

      const prefixCtx = await ensureServer(legacyRoot);
      await record(DISCRIMINATION_HTTP_CHECK, async () => {
        const { first, identical } = await httpProbe(prefixCtx);
        assertEqual(first.status, 200, 'pre-fix seed POST status');
        assertEqual(identical.status, 200, 'pre-fix identical POST status');
        assertTrue(
          Object.prototype.hasOwnProperty.call(identical.json, 'state'),
          'the pre-fix server must return the state on an identical POST (the defect)'
        );
        prefix = { identicalHasState: true, firstHasState: Object.prototype.hasOwnProperty.call(first.json, 'state') };
        return 'pre-fix: identical POST still returned payload.state (the defect reproduces)';
      });
    }
  } finally {
    ctx.clearFiles();
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    root,
    legacyRoot,
    prefix,
    prefixSha,
    envPath: ctx.envPath,
    progressPath: ctx.progressPath,
  };
}

/* ------------------------------------------------------- pre-fix materialization */

/**
 * Materialize the pre-fix server and progress-merge module from git into a throwaway
 * directory, so the discrimination run uses the real pre-fix code and not a stand-in. Only
 * the four files the server and probe load are needed.
 * @returns {{root: string, base: string, files: string[]}}
 */
export function materializePrefixTree({ root = DEFAULT_ROOT, base = PREFIX_BASE } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-pm01-prefix-'));
  const files = ['server.js', 'public/js/store.js', 'public/js/progress-merge.js', 'public/js/blueprint.js'];
  for (const rel of files) {
    const content = execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return { root: dest, base, files };
}

/* ----------------------------------------------------------------------- CLI */

function printRun(report, io) {
  io.log(`  tree @ ${report.root}`);
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

  io.log('progress-equal-check: progressEqual is key-order insensitive (PM-01)');

  let legacyRoot = prefixValue ? path.resolve(prefixValue) : null;
  let materialized = null;
  if (!legacyRoot) {
    try {
      materialized = materializePrefixTree();
      legacyRoot = materialized.root;
      io.log(`  pre-fix tree materialized from git ${materialized.base} -> ${materialized.root}`);
    } catch (err) {
      io.error(`  FAIL  could not materialize the pre-fix tree (${err.message}).`);
      io.error('        Pass --prefix-root <path to a checkout of the pre-fix tree> to run the discrimination checks.');
      return 1;
    }
  } else if (!fs.existsSync(path.join(legacyRoot, 'server.js'))) {
    io.error(`  FAIL  no server.js under ${legacyRoot}`);
    return 1;
  }

  let report;
  try {
    report = await runProgressEqualChecks({ root: DEFAULT_ROOT, legacyRoot });
  } catch (err) {
    io.error(`  FAIL  the probe could not run: ${err.message}`);
    await closeAll();
    return 1;
  }
  io.log(`  env file used by the suite: ${report.envPath} (throwaway; repository .env never touched)`);
  printRun(report, io);

  await closeAll();
  if (materialized) fs.rmSync(materialized.root, { recursive: true, force: true });

  const failed = report.results.filter((result) => !result.ok);
  if (report.ok) {
    io.log(`  OK    ${report.results.length} check(s) passed, including discrimination against the pre-fix tree.`);
    io.log('  NOTE  HTTP + module layer only: no browser, so real page lifecycle is not exercised.');
    return 0;
  }
  io.error(`  FAIL  ${failed.length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
