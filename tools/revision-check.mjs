/**
 * Offline checks for the SEC-05 revision/tombstone fix for finding F-2 (medium-high race)
 * in work/implementation/SEC-02R-REPORT.md:
 *
 *   A reset racing one in-flight save is silently undone (single tab). `store.importJSON()`
 *   queues the normal 1200 ms debounced save; while that POST is on the wire the learner
 *   clicks "Alles zuruecksetzen"; the DELETE really removes the record, but the in-flight
 *   save's response folds the merged record back into the browser cache, and the next load
 *   re-uploads it. The record is RESURRECTED.
 *
 * The fix is a monotonic `rev` persisted beside the progress record, plus a
 * `deletedThrough` tombstone: a DELETE advances the revision, so every write that left
 * before it is refused with `409 stale_revision` instead of being merged back. The client
 * carries the revision it last saw; on 409 it re-reads and adopts the server copy rather
 * than retrying a stale snapshot.
 *
 * This file drives the real client (public/js/store.js) against the real server
 * (server.js) in-process, with a throwaway .env/progress file, and:
 *   1. reproduces the reviewer's exact race and asserts the record is NOT resurrected;
 *   2. runs the *same probe* against the pre-fix tree (materialized from
 *      `git show 8a71f71:<file>`) and asserts it DOES resurrect there - a probe that
 *      passes on both trees would prove nothing, which this programme already had to
 *      reject once;
 *   3. proves ordinary saves still merge monotonically (a partial write must not erase
 *      newer answers);
 *   4. proves a 409 is handled, not ignored: the client re-reads and the record stays
 *      consistent.
 *
 * Scope and honesty:
 *   * HTTP + client-module layer. No browser process is started; a "reload" is a fresh
 *     module instance reading the same localStorage. The probe makes the network leg
 *     genuinely slow (POST delay) so the save really is in flight when the reset runs,
 *     and asserts that it was - otherwise the probe would be vacuous.
 *   * The fetch stub adds the Origin header a browser adds to a same-origin request.
 *
 * Safety:
 *   * B1PREP_ENV_FILE and B1PREP_PROGRESS_FILE point into a throwaway temp directory, and
 *     B1PREP_FORCE_OFFLINE=1, so no repository .env, no learner record, no database and no
 *     provider call is involved. Every value is synthetic and deliberately not `sk-` shaped.
 *
 * Usage: node tools/revision-check.mjs [--prefix-root <path>]
 *   The pre-fix tree is materialized from git when `--prefix-root` is omitted.
 * Exit code 0 when every check passes AND the probe discriminates, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'revision-check-synthetic-value-not-a-real-key';
export const EXAM_DATE = '2031-03-15';
/** Synthetic learner text. If this string survives a reset anywhere, the reset was fake. */
export const MARKER = 'SYNTHETIC-LEARNER-TEXT-PROBE';
/** The base the SEC-05 branch starts from; the pre-fix probe is materialized from it. */
export const PREFIX_BASE = process.env.B1PREP_PREFIX_BASE || '8a71f71';
/** Longer than the 1200 ms save debounce in store.js. */
const DEBOUNCE_WAIT_MS = 1400;
/** Artificial round-trip so the save is genuinely on the wire when the reset runs. */
const POST_DELAY_MS = 600;
/** Long enough for a delayed POST plus the DELETE to finish. */
const SETTLE_MS = 2000;
const STORAGE_KEY = 'b1prep.state.v1';
const THEME_KEY = 'certa-theme';

/** The acceptance checks the test file asserts ran and passed on this tree. */
export const REQUIRED_CHECKS = [
  'reset-not-resurrected-by-inflight-save',
  'ordinary-saves-still-merge-monotonically',
  'stale-write-is-refused-with-409',
  'client-rereads-and-stays-consistent-after-409',
  'scoped-error-delete-keeps-history-and-ability',
  'revision-survives-a-server-restart',
  'missing-revision-refused-after-delete',
];

/** Name of the discrimination check, run only when a pre-fix tree is available. */
export const DISCRIMINATION_CHECK = 'probe-discriminates-on-prefix-tree';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const realFetch = globalThis.fetch;
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
    _raw: (key) => map.get(key) ?? null,
    _set: (key, value) => map.set(key, String(value)),
  };
}

/** Synthetic learner record. Everything in it is invented. */
function seededState({ withErrors = true } = {}) {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now - 86400000,
    updatedAt: now,
    settings: { examDate: EXAM_DATE, dailyGoal: 30, ttsRate: 1.1, model: 'deepseek-chat', writingTaskIndex: 3 },
    nodes: { 'skill:LV1': { theta: 61, n: 4, correct: 3, last: now - 3600000, streak: 1, kBase: 34 } },
    history: [
      { t: now - 1000, partId: 'LV1', tags: ['lv_global'], difficulty: 55, correct: true, source: 'drill', ms: 1200, itemRef: 'synthetic-item-1' },
    ],
    errors: withErrors
      ? [{
          id: 'sec05-synthetic-1',
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
        }]
      : [],
    srs: { 'card-1': { box: 1, due: now + 86400000, reps: 2, lapses: 0 } },
    days: { '2031-03-15': { attempts: 1, correct: 1, byPart: { LV1: 1 }, ms: 1200 } },
    planDone: { '2031-03-15': { review: true } },
    counters: { attempts: 1, correct: 1, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

/* -------------------------------------------------------------------- server */

const servers = new Map();

/**
 * Start one root's server.js in-process on an ephemeral port with throwaway env and
 * progress files. The env vars are read at module load, so they must be set before the
 * dynamic import; one context is therefore created per root per process.
 */
async function ensureServer(root) {
  if (servers.has(root)) return servers.get(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-revision-'));
  const envPath = path.join(dir, '.env');
  const progressPath = path.join(dir, 'progress.json');
  fs.writeFileSync(envPath, `DEEPSEEK_API_KEY=${SYNTHETIC_KEY}\nEXAM_DATE=${EXAM_DATE}\n`, 'utf8');

  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ENV_FILE = envPath;
  process.env.B1PREP_PROGRESS_FILE = progressPath;

  // A unique query keeps this a separate module instance from other suites (reset-check
  // imports the same server.js): each instance captures its own throwaway progress path.
  const serverHref = `${pathToFileURL(path.join(root, 'server.js')).href}?suite=revision&root=${encodeURIComponent(root)}`;
  const mod = await import(serverHref);
  const ctx = {
    root,
    dir,
    envPath,
    progressPath,
    server: null,
    port: 0,
    baseUrl: '',
  };
  const start = async () => {
    const server = mod.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ctx.server = server;
    ctx.port = server.address().port;
    ctx.baseUrl = `http://127.0.0.1:${ctx.port}`;
  };
  await start();

  ctx.read = (requestPath, options = {}) => request(ctx.port, { path: requestPath, ...options });
  ctx.getProgress = () => request(ctx.port, { path: '/api/progress' });
  ctx.postProgress = (state, options = {}) => {
    const payload = options.rev === undefined ? { state } : { state, rev: options.rev };
    return request(ctx.port, {
      method: 'POST',
      path: '/api/progress',
      headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
      body: JSON.stringify(payload),
    });
  };
  ctx.deleteProgress = (scope = 'all') =>
    request(ctx.port, {
      method: 'DELETE',
      path: scope === 'all' ? '/api/progress' : `/api/progress?scope=${encodeURIComponent(scope)}`,
      headers: { Origin: ctx.baseUrl },
    });
  /** Stop and start again on the same progress files: "survives a restart". */
  ctx.restart = async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    await start();
  };
  ctx.close = async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
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
 * Remove the progress record and every sidecar (including the SEC-05 revision marker), so
 * each scenario starts from a clean slate.
 */
function clearProgressFiles(ctx) {
  for (const suffix of ['', '.bak', '.tmp', '.rev', '.rev.tmp']) {
    fs.rmSync(ctx.progressPath + suffix, { force: true });
  }
}

/* --------------------------------------------------------------------- fetch */

/**
 * Replace globalThis.fetch with one that resolves the client's relative URLs against the
 * running server, adds the Origin header a browser adds to a same-origin request, records
 * every call with its status, and can delay the progress POST so it is genuinely in
 * flight when the reset runs.
 */
function installFetchStub(ctx, log, options = {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ctx.baseUrl);
    const { signal, ...rest } = init;
    const method = (rest.method || 'GET').toUpperCase();
    const headers = { ...(rest.headers || {}) };
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'origin')) headers.Origin = ctx.baseUrl;
    const entry = { method, path: url.pathname + url.search, status: null };
    log.push(entry);
    if (options.onStart) options.onStart(entry);
    try {
      if (options.postDelayMs && method === 'POST' && url.pathname === '/api/progress') {
        await sleep(options.postDelayMs);
      }
      const res = await realFetch(url, { ...rest, method, headers, signal });
      entry.status = res.status;
      return res;
    } finally {
      if (options.onEnd) options.onEnd(entry);
    }
  };
}

/* --------------------------------------------------------------------- probe */

let moduleCounter = 0;

/**
 * The reviewer's exact scenario (SEC-02R, Check 4) plus the reload.
 *
 * seed server + localStorage with a record containing MARKER
 * importJSON(record)   -> queues the normal 1200 ms debounced save
 * wait 1300 ms         -> debounce fires; the POST is now on the wire (delayed)
 * resetAll()           -> user clicks "Alles zuruecksetzen" while that save is in flight
 * reload               -> syncFromServer()
 *
 * The same function runs against the fixed tree and the pre-fix tree; only `root`/`ctx`
 * change, so a pass on both is impossible to fake.
 */
async function runRaceProbe(root, ctx) {
  clearProgressFiles(ctx);
  const local = makeLocalStorage();
  const log = [];
  let postsInFlight = 0;
  globalThis.localStorage = local;
  installFetchStub(ctx, log, {
    postDelayMs: POST_DELAY_MS,
    onStart: (entry) => { if (entry.method === 'POST' && entry.path === '/api/progress') postsInFlight += 1; },
    onEnd: (entry) => { if (entry.method === 'POST' && entry.path === '/api/progress') postsInFlight -= 1; },
  });

  const storePath = pathToFileURL(path.join(root, 'public/js/store.js')).href;
  const record = seededState();
  // The server holds the record first, exactly as after a normal session.
  await ctx.postProgress(record);
  local._set(STORAGE_KEY, JSON.stringify(record));
  local._set(THEME_KEY, 'dark');

  const store = await import(`${storePath}?probe=${++moduleCounter}`);
  await store.syncFromServer();

  // Queue the normal debounced save. It must not be delivered by hand: the point is that
  // it is still on the wire when the reset happens.
  store.importJSON(JSON.stringify(record));
  await sleep(DEBOUNCE_WAIT_MS);
  const inFlightAtReset = postsInFlight > 0;

  await store.resetAll();
  await sleep(SETTLE_MS);

  const afterReset = await ctx.getProgress();
  const cacheAfterReset = local._raw(STORAGE_KEY) || '';

  // A reload that does not need a browser: a fresh module over the same localStorage.
  const postsBeforeReload = log.filter((entry) => entry.method === 'POST').length;
  const fresh = await import(`${storePath}?probe-reload=${++moduleCounter}`);
  await fresh.syncFromServer();
  await sleep(SETTLE_MS);

  const afterReload = await ctx.getProgress();
  const cacheAfterReload = local._raw(STORAGE_KEY) || '';
  return {
    inFlightAtReset,
    afterResetFound: Boolean(afterReset.json?.found),
    markerInCacheAfterReset: cacheAfterReset.includes(MARKER),
    afterReloadFound: Boolean(afterReload.json?.found),
    markerInCacheAfterReload: cacheAfterReload.includes(MARKER),
    postsAfterReload: log.filter((entry) => entry.method === 'POST').length - postsBeforeReload,
  };
}

/* ------------------------------------------------------------------- checks */

/**
 * Run every revision check against one tree.
 * @param {{root?: string, legacyRoot?: string|null}} options
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>,
 *   root: string, prefix: object|null, envPath: string, progressPath: string}>}
 */
export async function runRevisionChecks({ root = DEFAULT_ROOT, legacyRoot = null } = {}) {
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

  try {
    /* 1. The reviewer's exact race: the reset must not be resurrected. */
    await record('reset-not-resurrected-by-inflight-save', async () => {
      const probe = await runRaceProbe(root, ctx);
      assertTrue(probe.inFlightAtReset, 'the probe must catch the POST genuinely in flight, or it proves nothing');
      assertTrue(!probe.afterResetFound, 'the record must be gone from the server right after the reset');
      assertEqual(probe.markerInCacheAfterReset, false, 'the in-flight save must not fold the record back into the browser cache');
      assertTrue(!probe.afterReloadFound, 'a reload resurrected the deleted record (the F-2 race is still open)');
      assertEqual(probe.markerInCacheAfterReload, false, 'the reload must not restore the learner text');
      assertEqual(probe.postsAfterReload, 0, 'the reload must not re-upload the deleted record');
      return `in-flight POST at reset: yes; after reset found=${probe.afterResetFound}, cache has probe=${probe.markerInCacheAfterReset}; after reload found=${probe.afterReloadFound}`;
    });

    /* 2. The merge that protects a partial write must be untouched. */
    await record('ordinary-saves-still-merge-monotonically', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      const first = await ctx.postProgress(seeded);
      assertEqual(first.status, 200, 'seed POST status');
      assertEqual(first.json.merged, false, 'the first write is not a merge');
      assertTrue(Number.isFinite(first.json.rev) && first.json.rev >= 1, 'an accepted write must return a revision');

      // A legacy-shaped write with no revision at all (a lean client) is accepted while no
      // delete has happened, and still merges rather than overwrites.
      const older = { ...seeded, errors: [], updatedAt: seeded.updatedAt + 1 };
      const second = await ctx.postProgress(older);
      assertEqual(second.status, 200, 'legacy (no rev) POST status');
      assertEqual(second.json.merged, true, 'the server must report a merge, not an overwrite');
      assertEqual(second.json.state?.errors?.length, 1, 'the earlier notebook entry must survive the merge');

      // A revision behind the current one, but *not* because of a delete: still merged,
      // because the monotonic merge is the deliberate protection for a partial write.
      const behind = Math.max(0, Number(second.json.rev) - 1);
      const third = await ctx.postProgress({ ...seeded, errors: [], history: seeded.history, updatedAt: seeded.updatedAt + 2 }, { rev: behind });
      assertEqual(third.status, 200, 'a merely-behind revision must still be accepted');
      assertEqual(third.json.state?.errors?.length, 1, 'the merge must keep the entry');
      assertEqual(third.json.state?.history?.length, 1, 'the merge must keep the attempt');
      return 'partial/older writes merge; nothing is lost';
    });

    /* 3. A write that left before a delete is refused with 409 and writes nothing. */
    await record('stale-write-is-refused-with-409', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      const first = await ctx.postProgress(seeded);
      assertEqual(first.status, 200, 'seed POST status');
      const preDeleteRev = Number(first.json.rev);

      const del = await ctx.deleteProgress('all');
      assertEqual(del.status, 200, 'DELETE status');
      assertTrue(Number(del.json.rev) > preDeleteRev, 'the delete must advance the revision');

      const stale = await ctx.postProgress(seeded, { rev: preDeleteRev });
      assertEqual(stale.status, 409, 'a pre-delete write must be refused');
      assertEqual(stale.json?.code, 'stale_revision', 'stable error token');
      assertTrue(String(stale.json?.reason || '').includes('delete'), `reason must name the delete, got ${stale.json?.reason}`);

      const after = await ctx.getProgress();
      assertEqual(after.json.found, false, 'a refused write must not restore the record');
      assertEqual(Number(after.json.rev), Number(del.json.rev), 'a refused write must not advance the revision');
      return `409 stale_revision at rev ${preDeleteRev}; record stayed deleted`;
    });

    /* 4. A 409 is handled, not ignored: the client re-reads and stays consistent. */
    await record('client-rereads-and-stays-consistent-after-409', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      await ctx.postProgress(seeded);

      const local = makeLocalStorage();
      const log = [];
      globalThis.localStorage = local;
      installFetchStub(ctx, log);
      const storePath = pathToFileURL(path.join(root, 'public/js/store.js')).href;
      const store = await import(`${storePath}?conflict=${++moduleCounter}`);
      await store.syncFromServer(); // learns the revision

      // Another action (this user's other tab, or the same click) deletes the record.
      const del = await ctx.deleteProgress('all');
      assertEqual(del.status, 200, 'DELETE status');

      // The client now saves a snapshot that predates the delete.
      store.importJSON(JSON.stringify(seeded));
      await store.flushNow();
      await sleep(SETTLE_MS);

      const conflict = log.find((entry) => entry.status === 409);
      assertTrue(conflict, 'the client save must have been refused with 409');
      // The re-read happened: the client fetched the server copy after the conflict.
      const rereads = log.filter((entry) => entry.method === 'GET' && entry.path === '/api/progress');
      assertTrue(rereads.length >= 2, 'the client must GET again after the 409');
      const after = await ctx.getProgress();
      assertEqual(after.json.found, false, 'the record must stay deleted (consistent), not be resurrected');
      assertTrue(!(local._raw(STORAGE_KEY) || '').includes(MARKER), 'the client cache must not keep the refused snapshot');
      return '409 observed; client re-read, adopted the delete, record consistent';
    });

    /* 5. The scoped notebook clear still keeps history and ability. */
    await record('scoped-error-delete-keeps-history-and-ability', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      await ctx.postProgress(seeded);

      const local = makeLocalStorage();
      globalThis.localStorage = local;
      installFetchStub(ctx, []);
      const storePath = pathToFileURL(path.join(root, 'public/js/store.js')).href;
      const store = await import(`${storePath}?notebook=${++moduleCounter}`);
      await store.syncFromServer();
      await store.clearErrors();
      await sleep(SETTLE_MS);

      const after = await ctx.getProgress();
      assertEqual(after.json.found, true, 'the record itself must survive a notebook clear');
      assertEqual(after.json.state?.errors?.length, 0, 'the notebook must be empty on the server');
      assertEqual(after.json.state?.history?.length, 1, 'the attempts must survive a notebook clear');
      assertEqual(after.json.state?.nodes?.['skill:LV1']?.n, 4, 'the ability evidence must survive');
      assertTrue(!(local._raw(STORAGE_KEY) || '').includes(MARKER), 'the browser cache must not keep the deleted notebook text');
      return 'notebook emptied; history and ability kept';
    });

    /* 6. The revision must survive a restart, or the tombstone is worthless. */
    await record('revision-survives-a-server-restart', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      const first = await ctx.postProgress(seeded);
      const preDeleteRev = Number(first.json.rev);
      const del = await ctx.deleteProgress('all');
      const deletedRev = Number(del.json.rev);
      assertTrue(fs.existsSync(`${ctx.progressPath}.rev`), 'the revision must be persisted beside the record');
      assertTrue(!fs.existsSync(ctx.progressPath), 'the record itself is gone after a full reset');

      await ctx.restart();

      const after = await ctx.getProgress();
      assertEqual(Number(after.json.rev), deletedRev, 'the revision must survive a restart');
      assertEqual(after.json.found, false, 'the record must stay deleted across a restart');
      const stale = await ctx.postProgress(seeded, { rev: preDeleteRev });
      assertEqual(stale.status, 409, 'a pre-delete write must still be refused after a restart');
      return `rev ${deletedRev} persisted in ${path.basename(ctx.progressPath)}.rev and enforced after restart`;
    });

    /* 7. A missing revision: allowed before any delete, refused after one. */
    await record('missing-revision-refused-after-delete', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      const legacy = await ctx.postProgress(seeded); // no rev, no delete yet
      assertEqual(legacy.status, 200, 'a lean client must still be accepted before any delete');

      const del = await ctx.deleteProgress('all');
      assertEqual(del.status, 200, 'DELETE status');

      const refused = await ctx.postProgress(seeded); // no rev, after a delete
      assertEqual(refused.status, 409, 'a no-revision write after a delete must be refused, not silently accepted');
      assertEqual(refused.json?.code, 'stale_revision', 'stable error token');
      assertEqual(refused.json?.reason, 'missing_revision_after_delete', 'reason names the missing revision');
      const after = await ctx.getProgress();
      assertEqual(after.json.found, false, 'the refused write must not restore the record');
      return 'no-revision accepted before a delete; refused after it';
    });

    /* 8. Discrimination: the same probe must fail on the pre-fix tree. */
    if (legacyRoot) {
      await record(DISCRIMINATION_CHECK, async () => {
        const prefixCtx = await ensureServer(legacyRoot);
        prefix = await runRaceProbe(legacyRoot, prefixCtx);
        assertTrue(prefix.afterReloadFound, 'the pre-fix tree must resurrect the record, or the probe is not discriminating');
        return `pre-fix: after reset found=${prefix.afterResetFound}, cache has probe=${prefix.markerInCacheAfterReset}; after reload found=${prefix.afterReloadFound} (RESURRECTED as expected)`;
      });
    }
  } finally {
    clearProgressFiles(ctx);
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    root,
    legacyRoot,
    prefix,
    envPath: ctx.envPath,
    progressPath: ctx.progressPath,
  };
}

/* ------------------------------------------------------- pre-fix materialization */

/**
 * Materialize the pre-fix server and client from git into a throwaway directory, so the
 * discrimination run uses the real pre-fix code and not a stand-in. Only the four files
 * the probe loads are needed.
 * @returns {{root: string, base: string, files: string[]}}
 */
export function materializePrefixTree({ root = DEFAULT_ROOT, base = PREFIX_BASE } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-prefix-'));
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

  io.log('revision-check: a reset invalidates older writes (SEC-05, finding F-2 race)');

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
    report = await runRevisionChecks({ root: DEFAULT_ROOT, legacyRoot });
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
    io.log('  NOTE  HTTP + client module only: no browser, so real page lifecycle is not exercised. The network leg is delayed so the save really is concurrent.');
    return 0;
  }
  io.error(`  FAIL  ${failed.length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
