/**
 * Offline checks for the deletion *scope*. F-5 fix for finding F-5 (Low) in
 * work/implementation/P-03A-PRIVACY-AUDIT.md:
 *
 *   "Backup copies of progress, plus copies of the key on removable media, fall outside any
 *    deletion path."
 *
 * Two separate problems, kept separate here:
 *   1. Deletion scope. Copies the app itself left beside the record (`.bak`, a leftover
 *      `.tmp`, the recovery tool's `.pre-recovery`, the home-sync tool's
 *      `.before-ssd-sync-<id>.bak`) were not in the deletion path, so a learner who
 *      "deleted everything" still left their own text in files they never saw.
 *   2. Removable media. The portable build copies the real `.env` (the key) and the
 *      progress files onto whatever media it is written to. A delete inside the install
 *      cannot reach media that is not attached, so that copy is stated, not claimed
 *      deleted.
 *
 * This file drives the real client code (public/js/store.js) against the real server
 * (server.js) in-process, creates the copies with the real app processes first (a second
 * save creates the `.bak`; tools/recover-progress.js creates the `.pre-recovery`), then
 * runs the user-visible delete action and asserts, file by file, what survives.
 *
 * Scope and honesty:
 *   * HTTP + client-module layer. No browser, so no real page lifecycle or debounce
 *     timing is exercised; the probe waits longer than the save debounce instead.
 *   * The `.before-ssd-sync-<id>.bak` and `.tmp` files are written by this probe with the
 *     exact name and shape the app tools use, because running tools/sync-home.js needs a
 *     portable install and two stopped servers. The two copies that must be genuinely
 *     app-created (`.bak` by the server, `.pre-recovery` by the recovery tool) are.
 *   * `mode: 'prefix'` is not used. The authoritative before/after is a run of the same
 *     probe against a checkout of the pre-fix tree, materialized from git and verified
 *     byte-for-byte by sha256.
 *
 * Safety:
 *   * B1PREP_ENV_FILE and B1PREP_PROGRESS_FILE point into a throwaway temp directory, and
 *     B1PREP_FORCE_OFFLINE=1, so no repository .env, no learner record, no database and no
 *     provider call is involved. Every credential-shaped value is synthetic and
 *     deliberately not `sk-` shaped.
 *
 * Usage: node tools/deletion-scope-check.mjs [--prefix-root <path-to-prefix-checkout>]
 * Exit code 0 when every check passes on this tree, 1 otherwise.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'deletion-scope-check-synthetic-value-not-a-real-key';
export const EXAM_DATE = '2031-03-15';
/** Synthetic learner text. If this string survives a delete anywhere, the delete was fake. */
export const MARKER = 'SYNTHETIC-LEARNER-TEXT-DELETION-SCOPE';
/** Longer than the 1200 ms save debounce in store.js, so a late save must have landed. */
const SETTLE_MS = 1600;
const STORAGE_KEY = 'b1prep.state.v1';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The commit this branch starts from; the pre-fix server is materialized from it, so the
 * discrimination run uses the real pre-fix code and not a stand-in. Recorded so the
 * comparison cannot silently drift to a different commit.
 */
export const PREFIX_BASE = process.env.B1PREP_F5_PREFIX_BASE || '3a8c26647a2dabd1a95aff393ca9be870381d01a';
/** sha256 of `git show <base>:server.js` - the pre-fix deletion path, byte-for-byte. */
export const PREFIX_SERVER_SHA256 = 'ce465f18601ea3e68c1b19313f9f0c00c3f2554c913bfe7d2ba4cfdb1615d207';
/** The only files the probe loads from a tree. */
export const PREFIX_FILES = [
  'server.js',
  'public/js/store.js',
  'public/js/progress-merge.js',
  'public/js/blueprint.js',
  'tools/recover-progress.js',
];

/** Names the acceptance criteria require; the test file asserts each one ran and passed. */
export const REQUIRED_CHECKS = [
  'app-created-copies-created-first',
  'ui-delete-removes-every-local-copy',
  'learner-record-gone-get-reports-empty',
  'tombstone-kept-without-learner-text',
  'removable-media-copy-reported-out-of-scope',
  'delete-response-states-its-boundary',
];
export const DISCRIMINATION_CHECK = 'probe-discriminates-on-prefix-tree';

/** The name shape tools/sync-home.js leaves its never-replaced backup under. */
const SYNC_COPY_PREFIX = '.before-ssd-sync-';
const SYNC_COPY_SUFFIX = `${SYNC_COPY_PREFIX}2031-03-15T00-00-00-000Z-00000000-0000-4000-8000-000000000000.bak`;

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------- test harness */

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, label) {
  if (!value) throw new Error(label);
}

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

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Synthetic learner record. Everything in it is invented. */
function seededState({ attempts = 5 } = {}) {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now - 86400000,
    updatedAt: now,
    settings: { examDate: EXAM_DATE, dailyGoal: 30, ttsRate: 1.1, model: 'deepseek-chat' },
    nodes: { 'skill:LV1': { theta: 61, n: 4, correct: 3, last: now - 3600000 } },
    history: [
      { t: now - 1000, partId: 'LV1', tags: ['lv_global'], difficulty: 55, correct: true, source: 'drill', ms: 1200, itemRef: 'synthetic-item-1' },
    ],
    errors: [
      {
        id: 'f5-synthetic-1',
        t: now - 500,
        partId: 'SB1',
        tags: ['konnektoren'],
        difficulty: 55,
        prompt: `Prompt ${MARKER}`,
        yourAnswer: MARKER,
        correctAnswer: 'synthetisch',
        explanation: 'synthetisch',
        reviewed: 0,
        resolved: false,
        source: 'drill',
      },
    ],
    srs: {},
    days: { '2031-03-15': { attempts: 1, correct: 1, byPart: { LV1: 1 }, ms: 1200 } },
    planDone: { '2031-03-15': { review: true } },
    counters: { attempts, correct: 1, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

/* ------------------------------------------------------------------ servers */

const servers = new Map();
const mediaDirs = new Set();

/**
 * Start one root's server.js in-process on an ephemeral port with throwaway env and
 * progress files. The env vars are read at module load, so they must be set before the
 * dynamic import; one context is therefore created per root per process.
 */
async function ensureServer(root) {
  if (servers.has(root)) return servers.get(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-f5-'));
  const envPath = path.join(dir, '.env');
  const progressPath = path.join(dir, 'progress.json');
  fs.writeFileSync(envPath, `DEEPSEEK_API_KEY=${SYNTHETIC_KEY}\nEXAM_DATE=${EXAM_DATE}\n`, 'utf8');

  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ENV_FILE = envPath;
  process.env.B1PREP_PROGRESS_FILE = progressPath;

  const { createServer } = await import(pathToFileURL(path.join(root, 'server.js')).href);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const ctx = {
    root,
    dir,
    envPath,
    progressPath,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    read: (requestPath, options = {}) => request(port, { path: requestPath, ...options }),
    postProgress: (state) =>
      request(port, {
        method: 'POST',
        path: '/api/progress',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ state }),
      }),
    getProgress: () => request(port, { path: '/api/progress' }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  servers.set(root, ctx);
  return ctx;
}

/** Close every server this process started and remove its throwaway directory. */
export async function closeAll() {
  for (const ctx of servers.values()) await ctx.close();
  servers.clear();
  for (const dir of mediaDirs) fs.rmSync(dir, { recursive: true, force: true });
  mediaDirs.clear();
}

/** Remove every copy a scenario may have left, so each starts from a clean slate. */
function clearFiles(progressPath) {
  for (const suffix of ['', '.bak', '.tmp', '.pre-recovery', '.rev', '.rev.tmp', '.f5-source.json']) {
    fs.rmSync(progressPath + suffix, { force: true });
  }
  const dir = path.dirname(progressPath);
  const base = path.basename(progressPath);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${base}${SYNC_COPY_PREFIX}`)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

/** Names of files under the throwaway progress directory that still hold `needle`. */
function filesContaining(dir, needle) {
  const hits = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(name);
  }
  return hits;
}

/**
 * Replace globalThis.fetch with one that resolves the client's relative URLs against the
 * running server and adds the Origin header a browser adds to a same-origin request.
 */
function installFetchStub(ctx) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ctx.baseUrl);
    const { signal, ...rest } = init;
    const headers = { ...(rest.headers || {}) };
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'origin')) headers.Origin = ctx.baseUrl;
    return realFetch(url, { ...rest, headers, signal });
  };
}

/** The real client: the tree's own public/js/store.js, driven as ui.js drives it. */
async function makeTreeClient(root, local) {
  const storePath = pathToFileURL(path.join(root, 'public/js/store.js')).href;
  const store = await import(storePath);
  return {
    async seed(state) {
      local.setItem(STORAGE_KEY, JSON.stringify(state));
      store.importJSON(JSON.stringify(state));
      await store.flushNow();
    },
    reset: () => store.resetAll(),
  };
}

/* --------------------------------------------------------------------- probe */

/**
 * Create the copies the app leaves behind, run the user-visible delete, and report what
 * survived. Nothing here asserts: the caller decides what is a pass and what is a failure,
 * which is what lets the same probe be run against the pre-fix tree.
 * @returns {Promise<object>} observations
 */
async function runScopeProbe(root, ctx, client) {
  clearFiles(ctx.progressPath);
  const seeded = seededState();
  const syncCopy = `${ctx.progressPath}${SYNC_COPY_SUFFIX}`;

  // A simulated removable medium the app never touches: its own folder, outside the
  // install, holding the key and a copy of the record - exactly what build-portable.ps1
  // produces. Deletion here must not claim to have reached it.
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-media-'));
  mediaDirs.add(mediaDir);
  const mediaApp = path.join(mediaDir, 'B1_Prep');
  fs.mkdirSync(mediaApp, { recursive: true });
  fs.writeFileSync(path.join(mediaApp, '.env'), `DEEPSEEK_API_KEY=${SYNTHETIC_KEY}\nEXAM_DATE=${EXAM_DATE}\n`, 'utf8');
  fs.writeFileSync(path.join(mediaApp, 'progress.json'), JSON.stringify(seeded), 'utf8');
  fs.writeFileSync(path.join(mediaApp, 'progress.json.bak'), JSON.stringify(seeded), 'utf8');

  /* 1. Create the local copies with the real app processes first. */
  await ctx.postProgress(seeded); // the server writes progress.json
  await ctx.postProgress({ ...seeded, updatedAt: seeded.updatedAt + 1 }); // a second save leaves .bak

  // Give the recovery tool something to recover, so it writes its safety copy: a richer
  // previous generation, as a real .bak from an older tab would be.
  const richer = {
    ...seeded,
    updatedAt: seeded.updatedAt + 2,
    counters: { ...seeded.counters, attempts: 9 },
    history: [...seeded.history, { t: seeded.updatedAt - 500, partId: 'LV2', tags: [], difficulty: 55, correct: true, source: 'drill', ms: 900, itemRef: 'synthetic-item-2' }],
  };
  const richerPath = `${ctx.progressPath}.f5-source.json`;
  fs.writeFileSync(richerPath, JSON.stringify(richer), 'utf8');
  execFileSync(process.execPath, [path.join(root, 'tools/recover-progress.js'), '--target', ctx.progressPath, '--source', richerPath], { encoding: 'utf8' });
  fs.rmSync(richerPath, { force: true });

  // Names/shapes the other app tools leave (see the file header for why these two are
  // written directly rather than by running tools/sync-home.js).
  fs.writeFileSync(syncCopy, JSON.stringify(seeded), 'utf8');
  fs.writeFileSync(`${ctx.progressPath}.tmp`, JSON.stringify(seeded), 'utf8');

  const copyPaths = {
    'progress.json': ctx.progressPath,
    'progress.json.bak': `${ctx.progressPath}.bak`,
    'progress.json.tmp': `${ctx.progressPath}.tmp`,
    'progress.json.pre-recovery': `${ctx.progressPath}.pre-recovery`,
    [path.basename(syncCopy)]: syncCopy,
  };
  const created = {};
  for (const [name, file] of Object.entries(copyPaths)) created[name] = fs.existsSync(file);
  const preRecoveryHasMarker =
    created['progress.json.pre-recovery'] && fs.readFileSync(copyPaths['progress.json.pre-recovery'], 'utf8').includes(MARKER);

  /* 2. The user-visible delete action. */
  await client.seed(seeded);
  await client.reset();
  await sleep(SETTLE_MS);

  const survivesAfterReset = {};
  for (const [name, file] of Object.entries(copyPaths)) survivesAfterReset[name] = fs.existsSync(file);
  const markerLeftovers = filesContaining(ctx.dir, MARKER);
  const getAfter = await ctx.getProgress();
  const revFile = `${ctx.progressPath}.rev`;

  const mediaSurvived =
    fs.existsSync(path.join(mediaApp, '.env')) && fs.existsSync(path.join(mediaApp, 'progress.json'));

  /* 3. What the delete reports about its own boundary. */
  clearFiles(ctx.progressPath);
  await ctx.postProgress(seeded);
  fs.writeFileSync(`${ctx.progressPath}.pre-recovery`, JSON.stringify(seeded), 'utf8');
  const response = await ctx.read('/api/progress', { method: 'DELETE', headers: { Origin: ctx.baseUrl } });
  const removed = Array.isArray(response.json?.removed) ? response.json.removed : null;
  const outsideScope = Array.isArray(response.json?.outsideScope) ? response.json.outsideScope : null;

  return {
    created,
    allCreatedFirst: Object.values(created).every(Boolean),
    preRecoveryHasMarker,
    survivesAfterReset,
    anyCopySurvived: Object.values(survivesAfterReset).some(Boolean),
    markerLeftovers,
    recordGone: !fs.existsSync(ctx.progressPath),
    getFound: getAfter.json?.found,
    tombstoneKept: fs.existsSync(revFile),
    tombstoneHasMarker: fs.existsSync(revFile) && fs.readFileSync(revFile, 'utf8').includes(MARKER),
    mediaSurvived,
    response: {
      status: response.status,
      removed,
      outsideScope,
      mentionsMedia: Array.isArray(outsideScope) && outsideScope.some((line) => /removable media/i.test(String(line))),
      removedNames: removed,
    },
  };
}

/* ------------------------------------------------------- pre-fix materialization */

/**
 * Materialize the pre-fix server and tools from git into a throwaway directory, so the
 * discrimination run uses the real pre-fix code. Only the files the probe loads are needed.
 * @returns {{root: string, base: string, files: string[]}}
 */
export function materializePrefixTree({ root = DEFAULT_ROOT, base = PREFIX_BASE } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-f5-prefix-'));
  for (const rel of PREFIX_FILES) {
    const content = execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return { root: dest, base, files: PREFIX_FILES };
}

/* --------------------------------------------------------------------- suite */

/**
 * Run every deletion-scope check against one tree.
 * @param {{root?: string, legacyRoot?: string|null}} options
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>,
 *   root: string, legacyRoot: string|null, prefix: object|null, prefixSha: string|null,
 *   envPath: string, progressPath: string}>}
 */
export async function runDeletionScopeChecks({ root = DEFAULT_ROOT, legacyRoot = null } = {}) {
  const local = makeLocalStorage();
  globalThis.localStorage = local;
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  const ctx = await ensureServer(root);
  installFetchStub(ctx);
  const client = await makeTreeClient(root, local);
  let observed = null;
  let prefix = null;
  let prefixSha = null;

  try {
    await record('app-created-copies-created-first', async () => {
      observed = await runScopeProbe(root, ctx, client);
      assertTrue(observed.allCreatedFirst, `every app copy must exist before the delete, got ${JSON.stringify(observed.created)}`);
      assertTrue(observed.preRecoveryHasMarker, 'the recovery tool must have written a .pre-recovery copy holding the learner text');
      return `created first: ${Object.keys(observed.created).join(', ')}`;
    });

    await record('ui-delete-removes-every-local-copy', async () => {
      const survived = Object.entries(observed.survivesAfterReset).filter(([, exists]) => exists).map(([name]) => name);
      assertEqual(survived.length, 0, `these app-created copies outlived the delete: ${survived.join(', ')}`);
      return `removed: ${Object.keys(observed.survivesAfterReset).join(', ')}`;
    });

    await record('learner-record-gone-get-reports-empty', async () => {
      assertTrue(observed.recordGone, 'progress.json must be gone after the delete');
      assertTrue(observed.markerLeftovers.length === 0, `no file may still hold learner text, found ${observed.markerLeftovers.join(', ')}`);
      assertEqual(observed.getFound, false, 'GET /api/progress must report no record');
      return 'record gone; GET reports found:false';
    });

    await record('tombstone-kept-without-learner-text', async () => {
      assertTrue(observed.tombstoneKept, 'the .rev tombstone must survive the delete (it is what refuses a pre-delete write)');
      assertTrue(!observed.tombstoneHasMarker, 'the tombstone must hold no learner text');
      return '.rev kept as the write fence; holds no learner text';
    });

    await record('removable-media-copy-reported-out-of-scope', async () => {
      assertTrue(observed.mediaSurvived, 'a copy on media the app never touched must still exist after the delete');
      return 'reported, not claimed deleted: the simulated media copy (.env + progress.json) is untouched';
    });

    await record('delete-response-states-its-boundary', async () => {
      assertEqual(observed.response.status, 200, 'DELETE status');
      assertTrue(Array.isArray(observed.response.removed), 'the delete must report the files it removed');
      assertTrue(observed.response.removed.includes('progress.json'), `removed must name progress.json, got ${JSON.stringify(observed.response.removed)}`);
      assertTrue(observed.response.removed.includes('progress.json.pre-recovery'), 'removed must name the pre-recovery copy');
      assertTrue(observed.response.mentionsMedia, `outsideScope must name removable media, got ${JSON.stringify(observed.response.outsideScope)}`);
      return 'reports removed files and names removable media as out of scope';
    });

    /* Discrimination: the same probe must leave copies behind on the pre-fix tree. */
    if (legacyRoot) {
      await record(DISCRIMINATION_CHECK, async () => {
        prefixSha = createHash('sha256').update(fs.readFileSync(path.join(legacyRoot, 'server.js'))).digest('hex');
        assertEqual(prefixSha, PREFIX_SERVER_SHA256, 'the pre-fix server.js must be the recorded base blob (byte-for-byte)');
        const prefixCtx = await ensureServer(legacyRoot);
        const prefixLocal = makeLocalStorage();
        globalThis.localStorage = prefixLocal;
        installFetchStub(prefixCtx);
        const prefixClient = await makeTreeClient(legacyRoot, prefixLocal);
        prefix = await runScopeProbe(legacyRoot, prefixCtx, prefixClient);
        assertTrue(prefix.allCreatedFirst, 'the pre-fix probe must also create every copy, or it proves nothing');
        assertTrue(prefix.anyCopySurvived, 'the pre-fix tree must leave an app-created copy behind, or the probe is not discriminating');
        const survived = Object.entries(prefix.survivesAfterReset).filter(([, exists]) => exists).map(([name]) => name);
        return `pre-fix leaves ${survived.join(', ')} behind (sha256 ${prefixSha.slice(0, 12)})`;
      });
    }
  } finally {
    globalThis.localStorage = undefined;
    globalThis.fetch = realFetch;
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

  io.log('deletion-scope-check: backups and copies are inside the deletion path (F-5)');

  let legacyRoot = prefixValue ? path.resolve(prefixValue) : null;
  let materialized = null;
  if (!legacyRoot) {
    try {
      materialized = materializePrefixTree();
      legacyRoot = materialized.root;
      io.log(`  pre-fix tree materialized from git ${materialized.base} -> ${materialized.root}`);
    } catch (err) {
      io.error(`  FAIL  could not materialize the pre-fix tree (${err.message}).`);
      io.error('        Pass --prefix-root <path to a checkout of the pre-fix tree> to run the discrimination check.');
      return 1;
    }
  } else if (!fs.existsSync(path.join(legacyRoot, 'server.js'))) {
    io.error(`  FAIL  no server.js under ${legacyRoot}`);
    return 1;
  }

  let report;
  try {
    report = await runDeletionScopeChecks({ root: DEFAULT_ROOT, legacyRoot });
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
    io.log('  NOTE  HTTP + client module only: no browser, so real page lifecycle and debounce timing are not exercised.');
    io.log('  NOTE  The removable-media copy is mitigation by disclosure, not deletion: the app cannot delete from media it cannot reach.');
    return 0;
  }
  io.error(`  FAIL  ${failed.length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
