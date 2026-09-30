/**
 * Offline checks for F4-SCOPE-01, finding F-4 (Low) in work/implementation/P-03A-PRIVACY-AUDIT.md:
 *
 *   "Legacy persistence inventory: learner-derived text is stored as plaintext in
 *    localStorage and progress.json, with no account scope."
 *
 * This file drives the real client (public/js/store.js) against the real server
 * (server.js) in-process, on an ephemeral port with a throwaway .env and progress file,
 * using synthetic learner text only, and asserts:
 *   * account A's record is not visible to account B on the same browser store;
 *   * the legacy unscoped blob is adopted exactly once and stays recoverable afterwards;
 *   * a signed-out browser exposes no learner text to the next account;
 *   * the server record is account-scoped too (else a fresh account would adopt A's record
 *     over the network);
 *   * the existing deletion path still empties both server and browser;
 *   * a DELETE still refuses an older write carrying a pre-delete revision.
 *
 * Discrimination: the same six checks are run against the pre-fix tree materialised from
 * git (byte-for-byte; its store.js/server.js sha256 are recorded and asserted). The four
 * account-scope checks must FAIL there and the two controls must PASS - a suite that is
 * green on the broken tree as well would prove nothing, which this programme already had
 * to reject once.
 *
 * Scope and honesty:
 *   * HTTP + client-module layer. No browser process is started, so no real page
 *     lifecycle, onscreen keyboard or audio path is exercised. See F4-SCOPE-01.md.
 *   * "Signed out", "sign in" and "reload" are driven through store.js's own account-scope
 *     API and a fresh module instance reading the same localStorage stub.
 *   * The fetch stub adds the Origin header a browser adds to a same-origin request and
 *     forwards the client's X-B1Prep-Account header untouched.
 *   * The "older in-flight write" control encodes the SEC-05 revision fence at the HTTP
 *     layer (a write carrying a pre-delete revision is refused after the delete). The real
 *     timing race is covered separately by tools/revision-check.mjs, which stays green.
 *
 * Safety: B1PREP_ENV_FILE and B1PREP_PROGRESS_FILE point into a throwaway temp directory
 * with B1PREP_FORCE_OFFLINE=1, so no repository .env, no learner record, no database and
 * no provider call is involved. Every value is synthetic and deliberately not `sk-` shaped.
 *
 * Usage: node tools/progress-scope-check.mjs [--prefix-root <path>]
 *   The pre-fix tree is materialised from git when `--prefix-root` is omitted.
 * Exit code 0 when every check passes AND the probe discriminates, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'progress-scope-check-synthetic-value-not-a-real-key';
export const EXAM_DATE = '2031-03-15';
/** Synthetic learner text. If this appears under an account that did not create it, scope leaked. */
export const MARKER = 'SYNTHETIC-LEARNER-TEXT-SCOPE-PROBE';

export const ACCOUNT_A = 'acct-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const ACCOUNT_B = 'acct-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const STORAGE_KEY = 'b1prep.state.v1';
const SCOPE_KEY = 'b1prep.scope.v1';
const LEGACY_OWNER_KEY = 'b1prep.state.v1.legacy-owner';
const ACCOUNT_HEADER = 'X-B1Prep-Account';
/** Longer than the 1200 ms save debounce in store.js. */
const SETTLE_MS = 1600;

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The base this slice branches from (origin/main); the pre-fix probe is materialised from it. */
export const BASE_COMMIT = '5a63429949275f4cb27cd7f64565afe8cf029511';
/** sha256 of `git show <base>:public/js/store.js` - the pre-fix client, verified byte-for-byte. */
export const PREFIX_STORE_SHA256 = '20bf37322f78005c20491feb95a56d5b4ea7372752431484f136038001391460';
/** sha256 of `git show <base>:server.js` - the pre-fix server, verified byte-for-byte. */
export const PREFIX_SERVER_SHA256 = '0a42c13caa9b9f3c607517d10e3fd860b09278653a0b75b25769d43dad05089b';

/** The checks the test file asserts ran and passed on this tree. */
export const REQUIRED_CHECKS = [
  'browser-record-is-account-scoped',
  'legacy-blob-adopted-once-and-recoverable',
  'signed-out-browser-exposes-no-learner-text',
  'server-record-is-account-scoped',
  'delete-still-empties-server-and-browser',
  'delete-refuses-older-write-after-delete',
];

/** Account-scope checks: these must fail on the pre-fix tree. */
export const SCOPE_CHECKS = [
  'browser-record-is-account-scoped',
  'legacy-blob-adopted-once-and-recoverable',
  'signed-out-browser-exposes-no-learner-text',
  'server-record-is-account-scoped',
];
/** Control checks: these must keep passing on the pre-fix tree. */
export const CONTROL_CHECKS = [
  'delete-still-empties-server-and-browser',
  'delete-refuses-older-write-after-delete',
];
export const DISCRIMINATION_CHECK = 'probe-discriminates-on-prefix-tree';

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scopedKey = (id) => `${STORAGE_KEY}::${id}`;

/* --------------------------------------------------------------- assertions */

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, label) {
  if (!value) throw new Error(label);
}

/* ------------------------------------------------------------- test harness */

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
    _raw: (key) => (map.has(key) ? map.get(key) : null),
    _set: (key, value) => map.set(key, value),
    _keys: () => [...map.keys()],
  };
}

/** Synthetic learner record. Everything in it is invented. */
function seededState() {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now - 86400000,
    updatedAt: now,
    settings: { examDate: EXAM_DATE, dailyGoal: 30, ttsRate: 1.05, model: 'deepseek-chat' },
    nodes: { 'skill:LV1': { theta: 61, n: 4, correct: 3, last: now - 3600000, streak: 1, kBase: 34 } },
    history: [
      { t: now - 1000, partId: 'LV1', tags: ['lv_global'], difficulty: 55, correct: true, source: 'drill', ms: 1200, itemRef: 'synthetic-item-1' },
    ],
    errors: [{
      id: 'scope-synthetic-1',
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
    }],
    srs: { 'card-1': { box: 1, due: now + 86400000, reps: 2, lapses: 0 } },
    days: { '2031-03-15': { attempts: 1, correct: 1, byPart: { LV1: 1 }, ms: 1200 } },
    planDone: { '2031-03-15': { review: true } },
    counters: { attempts: 1, correct: 1, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

/* ------------------------------------------------------------------ servers */

const servers = new Map();

/**
 * Start one root's server.js in-process on an ephemeral port with throwaway env and
 * progress files. Env vars are read at module load, so they are set before the dynamic
 * import; one context is therefore created per root per process.
 */
async function ensureServer(root) {
  if (servers.has(root)) return servers.get(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-scope-'));
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

  const post = (body, accountId) => {
    const headers = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` };
    if (accountId) headers[ACCOUNT_HEADER] = accountId;
    return request(port, { method: 'POST', path: '/api/progress', headers, body: JSON.stringify(body) });
  };

  const ctx = {
    root,
    dir,
    envPath,
    progressPath,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    read: (requestPath, options = {}) => request(port, { path: requestPath, ...options }),
    getProgress: () => request(port, { path: '/api/progress' }),
    getProgressScoped: (id) => request(port, { path: '/api/progress', headers: { [ACCOUNT_HEADER]: id } }),
    postProgress: (state) => post({ state }),
    postProgressScoped: (id, state) => post({ state }, id),
    postProgressWith: (payload, accountId) => post(payload, accountId),
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
}

function clearProgressFiles(ctx) {
  const names = fs.readdirSync(ctx.dir);
  for (const name of names) {
    if (name === '.env') continue;
    fs.rmSync(path.join(ctx.dir, name), { force: true, recursive: true });
  }
}

/* ------------------------------------------------------------- client adapter */

let importSeq = 0;
/** A fresh module instance reading the same localStorage stub - the closest thing to a reload. */
async function importStore(root) {
  importSeq += 1;
  return import(`${pathToFileURL(path.join(root, 'public/js/store.js')).href}?scope=${importSeq}`);
}

function installFetchStub(ctx, log) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ctx.baseUrl);
    const { signal, ...rest } = init;
    const headers = { ...(rest.headers || {}) };
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'origin')) headers.Origin = ctx.baseUrl;
    log.push({
      method: (rest.method || 'GET').toUpperCase(),
      path: url.pathname + url.search,
      account: headers[ACCOUNT_HEADER] || null,
    });
    return realFetch(url, { ...rest, headers, signal });
  };
}

/**
 * Guard for the account-scope checks. On the pre-fix tree store.js exports no scope API, so
 * this throws with the observed leak as evidence rather than a bare "not a function".
 */
async function requireScopeApi(store, root, local) {
  if (typeof store.setAccountScope === 'function' && typeof store.clearAccountScope === 'function') return;
  let leaked = 'unobserved';
  try {
    local._set(STORAGE_KEY, JSON.stringify(seededState()));
    const probe = await importStore(root);
    leaked = JSON.stringify(probe.getState()).includes(MARKER) ? 'a second load DID read it' : 'a second load did not read it';
  } catch {
    /* leave the observation best-effort */
  }
  throw new Error(
    'account isolation missing: store.js exports no setAccountScope/clearAccountScope; ' +
      `on the shared key ${leaked} (the F-4 defect)`
  );
}

/* -------------------------------------------------------------- the checks */

async function runChecksForRoot(root, ctx) {
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  const freshLocal = () => {
    const local = makeLocalStorage();
    globalThis.localStorage = local;
    return local;
  };

  /* 1. A second account on the same browser store cannot see the first account's record. */
  await record('browser-record-is-account-scoped', async () => {
    clearProgressFiles(ctx);
    const local = freshLocal();
    installFetchStub(ctx, []);
    const st1 = await importStore(root);
    await requireScopeApi(st1, root, local);
    st1.setAccountScope(ACCOUNT_A);
    st1.importJSON(JSON.stringify(seededState()));
    await st1.flushNow();
    assertEqual(st1.getState().counters.attempts, 1, 'account A holds its record');

    st1.clearAccountScope();
    const st2 = await importStore(root);
    assertEqual(st2.getAccountScope().mode, 'signed-out', 'a fresh load after sign-out is signed out');
    st2.setAccountScope(ACCOUNT_B);
    const b = st2.getState();
    assertEqual(b.counters.attempts, 0, 'account B must not inherit A attempts');
    assertEqual((b.history || []).length, 0, 'account B must not inherit A history');
    assertEqual((b.errors || []).length, 0, 'account B must not inherit A notebook');
    assertTrue(!JSON.stringify(b).includes(MARKER), 'account B must not see A learner text');

    const aGet = await ctx.getProgressScoped(ACCOUNT_A);
    assertEqual(aGet.json.found, true, 'A scoped server record still exists');
    const bGet = await ctx.getProgressScoped(ACCOUNT_B);
    assertEqual(bGet.json.found, false, 'B scoped server record must be absent');
    return 'A and B browser records and server records are isolated';
  });

  /* 2. The legacy blob is adopted exactly once and stays recoverable. */
  await record('legacy-blob-adopted-once-and-recoverable', async () => {
    clearProgressFiles(ctx);
    const local = freshLocal();
    installFetchStub(ctx, []);
    const legacyRaw = JSON.stringify(seededState());
    local._set(STORAGE_KEY, legacyRaw);

    const st1 = await importStore(root);
    await requireScopeApi(st1, root, local);
    const adopted = st1.setAccountScope(ACCOUNT_A);
    assertTrue(!!(adopted.legacyAdopted && adopted.legacyAdopted.accountId === ACCOUNT_A), 'the legacy blob is adopted into A once');
    assertTrue(JSON.stringify(st1.getState()).includes(MARKER), 'A now holds the legacy learner text');
    assertEqual(local._raw(scopedKey(ACCOUNT_A)).includes(MARKER), true, 'A has its own namespaced copy');
    assertEqual(local._raw(LEGACY_OWNER_KEY), ACCOUNT_A, 'the one-time adoption is recorded');
    assertEqual(local._raw(STORAGE_KEY), legacyRaw, 'the legacy key is left intact as the learner backup');

    st1.clearAccountScope();
    const st2 = await importStore(root);
    st2.setAccountScope(ACCOUNT_B);
    assertTrue(!JSON.stringify(st2.getState()).includes(MARKER), 'the legacy blob must not be duplicated into B');
    assertEqual(st2.accountScopeStatus().legacyAdopted, null, 'B did not adopt the legacy blob');
    assertEqual(local._raw(STORAGE_KEY), legacyRaw, 'the legacy backup is still recoverable after B signs in');

    const st3 = await importStore(root);
    st3.setAccountScope(ACCOUNT_A);
    await st3.resetAll();
    await sleep(SETTLE_MS);
    const st4 = await importStore(root);
    st4.setAccountScope(ACCOUNT_A);
    assertTrue(!JSON.stringify(st4.getState()).includes(MARKER), 'a reset must not resurrect/re-adopt the legacy blob');
    assertEqual(local._raw(STORAGE_KEY), legacyRaw, 'the legacy backup survives the reset');
    return 'adopted once into A; never duplicated into B; not re-adopted after a reset';
  });

  /* 3. A signed-out browser exposes no learner text to the next account. */
  await record('signed-out-browser-exposes-no-learner-text', async () => {
    clearProgressFiles(ctx);
    const local = freshLocal();
    const log = [];
    installFetchStub(ctx, log);
    const st1 = await importStore(root);
    await requireScopeApi(st1, root, local);
    st1.setAccountScope(ACCOUNT_A);
    st1.importJSON(JSON.stringify(seededState()));
    await st1.flushNow();
    st1.clearAccountScope();

    const before = log.length;
    const st2 = await importStore(root);
    assertEqual(st2.getAccountScope().mode, 'signed-out', 'a reload after sign-out stays signed out');
    const s = st2.getState();
    assertEqual((s.history || []).length, 0, 'a signed-out browser holds no history');
    assertEqual((s.errors || []).length, 0, 'a signed-out browser holds no notebook');
    assertTrue(!JSON.stringify(s).includes(MARKER), 'a signed-out browser holds no learner text');
    let sync;
    try {
      sync = await st2.syncFromServer();
    } catch (err) {
      sync = { error: String(err.message || err) };
    }
    assertTrue(sync.signedOut === true || sync.reachable === false, 'a signed-out browser must not read the server record');
    await sleep(SETTLE_MS);
    assertEqual(log.length, before, 'a signed-out browser must issue no progress request');

    for (const key of local._keys()) {
      if ((local._raw(key) || '').includes(MARKER)) {
        assertEqual(key, scopedKey(ACCOUNT_A), 'learner text may live only under its own account namespace');
      }
    }

    st2.setAccountScope(ACCOUNT_B);
    assertTrue(!JSON.stringify(st2.getState()).includes(MARKER), 'the next account must not inherit it');
    return 'signed-out browser holds and reads no learner text; only A\u2019s namespaced key carries it';
  });

  /* 4. The server record is account-scoped too (a fresh account must not fetch A's record). */
  await record('server-record-is-account-scoped', async () => {
    clearProgressFiles(ctx);
    const seedA = seededState();
    const p1 = await ctx.postProgressScoped(ACCOUNT_A, seedA);
    assertEqual(p1.status, 200, 'A POST status');
    const aGet = await ctx.getProgressScoped(ACCOUNT_A);
    assertEqual(aGet.json.found, true, 'A can read its own server record');
    assertTrue(JSON.stringify(aGet.json.state || {}).includes(MARKER), 'A server record carries A learner text');
    const bGet = await ctx.getProgressScoped(ACCOUNT_B);
    assertEqual(bGet.json.found, false, 'B must not see A server record');
    const legacyGet = await ctx.getProgress();
    assertEqual(legacyGet.json.found, false, 'a scoped write must not leak into the legacy record');

    const bad = await ctx.postProgressWith({ state: seedA }, '..');
    assertEqual(bad.status, 400, 'an invalid account scope must be refused, not treated as legacy');
    assertEqual(bad.json?.code, 'invalid_account', 'invalid account error token');
    return 'server records are account-scoped; an invalid scope is refused';
  });

  /* 5. Control: the existing deletion path still empties both server and browser (legacy mode). */
  await record('delete-still-empties-server-and-browser', async () => {
    clearProgressFiles(ctx);
    const local = freshLocal();
    installFetchStub(ctx, []);
    const st = await importStore(root);
    const seed = seededState();
    local._set(STORAGE_KEY, JSON.stringify(seed));
    st.importJSON(JSON.stringify(seed));
    await st.flushNow();
    await st.resetAll();
    await sleep(SETTLE_MS);

    assertTrue(!fs.existsSync(ctx.progressPath), 'progress.json must be gone after a reset');
    const after = await ctx.getProgress();
    assertEqual(after.json.found, false, 'GET reports no record after a reset');
    const raw = local._raw(STORAGE_KEY) || '';
    assertTrue(!raw.includes(MARKER), 'the browser cache must not keep learner text');
    return 'legacy reset empties server and browser';
  });

  /* 6. Control: a DELETE still refuses an older write (SEC-05 revision fence). */
  await record('delete-refuses-older-write-after-delete', async () => {
    clearProgressFiles(ctx);
    const seed = seededState();
    const first = await ctx.postProgressWith({ state: seed, rev: 0 });
    assertEqual(first.status, 200, 'seed POST status');
    const del = await ctx.read('/api/progress', { method: 'DELETE', headers: { Origin: ctx.baseUrl } });
    assertEqual(del.status, 200, 'DELETE status');
    const stale = await ctx.postProgressWith({ state: seed, rev: 0 });
    assertEqual(stale.status, 409, 'a write older than the delete must be refused');
    assertEqual(stale.json?.code, 'stale_revision', 'stale revision error token');
    const after = await ctx.getProgress();
    assertEqual(after.json.found, false, 'the deleted record must not be resurrected');
    return 'the DELETE revision fence refuses an older write; no resurrection';
  });

  clearProgressFiles(ctx);
  return results;
}

/**
 * Run the six checks against one tree.
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>,
 *   root: string, envPath: string, progressPath: string}>}
 */
export async function runProgressScopeChecks({ root = DEFAULT_ROOT, prefix = null } = {}) {
  const ctx = await ensureServer(root);
  const results = await runChecksForRoot(root, ctx);

  let prefixReport = null;
  let prefixSha = null;
  if (prefix) {
    const prefixCtx = await ensureServer(prefix.root);
    prefixSha = {
      store: crypto.createHash('sha256').update(fs.readFileSync(path.join(prefix.root, 'public/js/store.js'))).digest('hex'),
      server: crypto.createHash('sha256').update(fs.readFileSync(path.join(prefix.root, 'server.js'))).digest('hex'),
    };
    const prefixResults = await runChecksForRoot(prefix.root, prefixCtx);
    const scopeFailed = SCOPE_CHECKS.filter((name) => !prefixResults.find((r) => r.name === name)?.ok);
    const controlsPassed = CONTROL_CHECKS.filter((name) => prefixResults.find((r) => r.name === name)?.ok);
    const storeMatches = prefixSha.store === PREFIX_STORE_SHA256;
    const serverMatches = prefixSha.server === PREFIX_SERVER_SHA256;
    const ok = scopeFailed.length === SCOPE_CHECKS.length && controlsPassed.length === CONTROL_CHECKS.length && storeMatches && serverMatches;
    prefixReport = { results: prefixResults, scopeFailed, controlsPassed, storeMatches, serverMatches, ok };
    results.push({
      name: DISCRIMINATION_CHECK,
      ok,
      detail:
        `pre-fix scope checks failed ${scopeFailed.length}/${SCOPE_CHECKS.length}` +
        ` (${scopeFailed.join(', ') || 'none'}); controls passed ${controlsPassed.length}/${CONTROL_CHECKS.length};` +
        ` store.js sha256 ${storeMatches ? 'matches' : 'DIFFERS'}, server.js sha256 ${serverMatches ? 'matches' : 'DIFFERS'}`,
    });
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    root,
    prefix: prefixReport,
    prefixSha,
    envPath: ctx.envPath,
    progressPath: ctx.progressPath,
  };
}

/* ------------------------------------------------------- pre-fix materialisation */

/**
 * Materialise the pre-fix server and client from git into a throwaway directory, so the
 * discrimination run uses the real pre-fix code. Only the four files the probe loads are
 * needed.
 */
export function materializePrefixTree({ root = DEFAULT_ROOT, base = BASE_COMMIT } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-scope-prefix-'));
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

  io.log('progress-scope-check: account-scoped legacy persistence (F4-SCOPE-01, finding F-4)');

  let prefix = null;
  let materialized = null;
  if (prefixValue) {
    const root = path.resolve(prefixValue);
    if (!fs.existsSync(path.join(root, 'server.js'))) {
      io.error(`  FAIL  no server.js under ${root}`);
      return 1;
    }
    prefix = { root };
  } else {
    try {
      materialized = materializePrefixTree();
      prefix = { root: materialized.root };
      io.log(`  pre-fix tree materialized from git ${materialized.base} -> ${materialized.root}`);
    } catch (err) {
      io.error(`  FAIL  could not materialize the pre-fix tree (${err.message}).`);
      io.error('        Pass --prefix-root <path to a checkout of the pre-fix tree> to run the discrimination check.');
      return 1;
    }
  }

  let report;
  try {
    report = await runProgressScopeChecks({ prefix });
  } catch (err) {
    io.error(`  FAIL  the probe could not run: ${err.message}`);
    await closeAll();
    return 1;
  }
  io.log(`  env file used by the suite: ${report.envPath} (throwaway; repository .env never touched)`);
  printRun(report, io);

  if (report.prefixSha) {
    io.log('');
    io.log(`  BEFORE/AFTER — pre-fix store.js sha256 ${report.prefixSha.store}`);
    io.log(`  BEFORE/AFTER — pre-fix server.js sha256 ${report.prefixSha.server}`);
    io.log(`  pre-fix scope checks failed: ${report.prefix.scopeFailed.join(', ') || 'none'}`);
    io.log(`  pre-fix controls passed: ${report.prefix.controlsPassed.join(', ') || 'none'}`);
    if (!report.prefix.ok) {
      io.error('  FAIL  the probe did not discriminate on the pre-fix tree.');
    }
  }

  await closeAll();
  if (materialized) fs.rmSync(materialized.root, { recursive: true, force: true });

  const failed = report.results.filter((result) => !result.ok);
  if (report.ok) {
    io.log(`  OK    ${report.results.length} check(s) passed, including discrimination against the pre-fix tree.`);
    io.log('  NOTE  HTTP + client module only: no browser, so no real page lifecycle, keyboard or audio path is exercised.');
    return 0;
  }
  io.error(`  FAIL  ${failed.length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
