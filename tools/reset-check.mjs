/**
 * Offline checks for the reset/delete path. SEC-02 fix for finding F-2 (medium) in
 * work/implementation/P-03A-PRIVACY-AUDIT.md:
 *
 *   "Alles zurücksetzen" and "Fehlerheft leeren" delete nothing. The server merges
 *   saves rather than replacing them, so the full record comes back to both the server
 *   and the browser. Nothing in the app calls DELETE /api/progress.
 *
 * This file drives the real client code (public/js/store.js) against the real server
 * (server.js) in-process, and asserts what the two user-visible actions remove and what
 * they keep. The merge used by ordinary saves is asserted to be untouched.
 *
 * Scope and honesty:
 *   * HTTP + client-module layer. No browser is started, so no real page lifecycle or
 *     debounce timing is exercised; the probe waits longer than the save debounce
 *     instead, so a late save would have to appear before the assertions run.
 *   * The fetch stub adds the Origin header a browser adds to a same-origin request.
 *     Without it the SEC-01 origin boundary would (correctly) reject the call.
 *   * `mode: 'prefix'` drives the same server with the pre-SEC-02 client call sequence
 *     (empty state posted, no DELETE) so the probe can be shown to discriminate. The
 *     authoritative before/after is a run against a checkout of the pre-fix tree, which
 *     `--legacy-root` performs. The prefix mode is what the automated test uses.
 *
 * Safety:
 *   * B1PREP_ENV_FILE and B1PREP_PROGRESS_FILE point into a throwaway temp directory,
 *     and B1PREP_FORCE_OFFLINE=1, so no repository .env, no learner record, no database
 *     and no provider call is involved. Every credential-shaped value is synthetic and
 *     deliberately not `sk-` shaped.
 *
 * Usage: node tools/reset-check.mjs [--legacy-root <path-to-prefix-checkout>]
 * Exit code 0 when every check passes on this tree, 1 otherwise.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'reset-check-synthetic-value-not-a-real-key';
export const EXAM_DATE = '2031-03-15';
/** Synthetic learner text. If this string survives a reset anywhere, the reset was fake. */
export const MARKER = 'SYNTHETIC-LEARNER-TEXT-RESET-CHECK';
/** Longer than the 1200 ms save debounce in store.js, so a late save must have landed. */
const SETTLE_MS = 1600;
const STORAGE_KEY = 'b1prep.state.v1';
const THEME_KEY = 'certa-theme';

/** Names the acceptance criteria require; the test file asserts each one ran and passed. */
export const REQUIRED_CHECKS = [
  'normal-post-still-merges',
  'reset-deletes-server-record',
  'reset-clears-browser-cache',
  'reset-not-undone-on-next-load',
  'reset-preserves-configuration',
  'clear-notebook-removes-entries-keeps-history',
  'unknown-delete-scope-is-rejected',
  'delete-requires-same-origin',
  'backup-copies-outside-deletion-path',
];

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
          id: 'sec02-synthetic-1',
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

/* ------------------------------------------------------------------ servers */

const servers = new Map();

/**
 * Start one root's server.js in-process on an ephemeral port with throwaway env and
 * progress files. The env vars are read at module load, so they must be set before the
 * dynamic import; one context is therefore created per root per process.
 */
async function ensureServer(root) {
  if (servers.has(root)) return servers.get(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-reset-'));
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
}

function clearProgressFiles(ctx) {
  // `.rev` is the SEC-05 revision/tombstone sidecar. Each scenario starts from a clean
  // slate, so it must go too - otherwise a delete in one scenario would leave a
  // `deletedThrough` mark that (correctly) refuses the next scenario's first write.
  for (const suffix of ['', '.bak', '.tmp', '.pre-recovery', '.rev', '.rev.tmp']) {
    fs.rmSync(ctx.progressPath + suffix, { force: true });
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
 * Replace globalThis.fetch with one that resolves the client's relative URLs against
 * the running server, records every call and adds the Origin header a browser adds to a
 * same-origin request.
 */
function installFetchStub(ctx, log) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ctx.baseUrl);
    const { signal, ...rest } = init;
    const headers = { ...(rest.headers || {}) };
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'origin')) headers.Origin = ctx.baseUrl;
    log.push({ method: (rest.method || 'GET').toUpperCase(), path: url.pathname + url.search });
    return realFetch(url, { ...rest, headers, signal });
  };
}

/* ------------------------------------------------------------- client adapters */

/**
 * The real client: the tree's own public/js/store.js, driven exactly as the UI drives
 * it (ui.js calls store.resetAll() and store.clearErrors()).
 */
async function makeTreeClient(root, ctx, local) {
  const storePath = pathToFileURL(path.join(root, 'public/js/store.js')).href;
  const store = await import(storePath);
  let reloads = 0;

  return {
    kind: 'tree',
    async seed(state) {
      local._set(STORAGE_KEY, JSON.stringify(state));
      store.importJSON(JSON.stringify(state));
      // Deliver the queued save now, so no debounce timer is left running and the
      // server and the browser hold the same record, as after a normal session.
      await store.flushNow();
    },
    cacheRaw: () => local._raw(STORAGE_KEY),
    settings: () => store.getState().settings,
    counters: () => store.getState().counters,
    reset: () => store.resetAll(),
    clearNotebook: () => store.clearErrors(),
    async nextLoad() {
      reloads += 1;
      // A fresh module instance reading the same localStorage is the closest thing to a
      // reloaded page that does not need a browser.
      const fresh = await import(`${storePath}?reload=${reloads}`);
      return fresh.syncFromServer();
    },
  };
}

/**
 * The pre-SEC-02 client sequence, read from the pre-fix public/js/store.js: the reset
 * emptied the in-memory state and posted it (writeLocal immediately, the POST after the
 * 1200 ms debounce, folding the merged answer back in); the notebook clear did the same
 * with `errors: []`. Nothing called DELETE. Used to show the probe discriminates.
 */
function makePrefixClient(ctx, local) {
  let state = null;

  const persist = () => {
    local._set(STORAGE_KEY, JSON.stringify(state));
  };
  const post = async () => {
    const res = await ctx.postProgress(state);
    if (res.json?.state) {
      // store.js folded the merged record back into memory and localStorage.
      state = res.json.state;
      persist();
    }
  };

  return {
    kind: 'prefix',
    async seed(next) {
      state = next;
      persist();
      await ctx.postProgress(state);
    },
    cacheRaw: () => local._raw(STORAGE_KEY),
    settings: () => (state?.settings ? { ...state.settings } : {}),
    counters: () => ({ ...(state?.counters || {}) }),
    async reset() {
      // store.js resetAll() before SEC-02: fresh state, local write, debounced POST.
      state = { version: 1, updatedAt: 0, settings: {}, nodes: {}, history: [], errors: [], srs: {}, days: {}, planDone: {}, counters: { attempts: 0, correct: 0 } };
      persist();
      setTimeout(() => {
        post().catch(() => {});
      }, 1200);
    },
    async clearNotebook() {
      state = { ...state, errors: [] };
      persist();
      setTimeout(() => {
        post().catch(() => {});
      }, 1200);
    },
    async nextLoad() {
      const res = await ctx.getProgress();
      if (res.json?.found && res.json.state) {
        const serverTime = Number(res.json.state.updatedAt) || 0;
        if (serverTime > (Number(state?.updatedAt) || 0)) {
          state = { ...res.json.state };
          persist();
          return { adopted: true, uploaded: false, reachable: true };
        }
      }
      return { adopted: false, uploaded: true, reachable: true };
    },
  };
}

/* --------------------------------------------------------------------- probe */

/**
 * Run every reset/delete check against one tree.
 * @param {{root?: string, mode?: 'tree'|'prefix'}} options
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>,
 *   root: string, mode: string, envPath: string, progressPath: string}>}
 */
export async function runResetChecks({ root = DEFAULT_ROOT, mode = 'tree' } = {}) {
  const ctx = await ensureServer(root);
  const local = makeLocalStorage();
  // The theme preference lives outside the progress record (app.js), so it is seeded
  // here the way a browser that had chosen dark mode would hold it.
  local._set(THEME_KEY, 'dark');
  const log = [];
  const results = [];

  clearProgressFiles(ctx);
  if (mode === 'tree') {
    globalThis.localStorage = local;
    installFetchStub(ctx, log);
  }
  const client = mode === 'tree' ? await makeTreeClient(root, ctx, local) : makePrefixClient(ctx, local);

  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  const posts = () => log.filter((entry) => entry.method === 'POST').length;

  try {
    /* 1. The merge used by ordinary saves must stay exactly as it was. */
    await record('normal-post-still-merges', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      const first = await ctx.postProgress(seeded);
      assertEqual(first.status, 200, 'seed POST status');
      assertEqual(first.json.merged, false, 'first write is not a merge');

      // An older snapshot from another tab: it lacks the notebook entry the server
      // already holds. The protection is that the entry is not lost.
      const older = { ...seeded, errors: [], updatedAt: seeded.updatedAt + 1 };
      const second = await ctx.postProgress(older);
      assertEqual(second.status, 200, 'second POST status');
      assertEqual(second.json.merged, true, 'the server must report a merge, not an overwrite');
      assertEqual(second.json.state?.errors?.length, 1, 'the earlier notebook entry must survive the merge');
      assertEqual(second.json.state?.history?.length, 1, 'the earlier attempt must survive the merge');

      const stored = await ctx.getProgress();
      assertEqual(stored.json.state?.errors?.length, 1, 'the stored record must still hold the entry');
      return 'POST still merges; older snapshot did not erase the record';
    });

    /* 2. The reset must remove the record from the server. */
    await record('reset-deletes-server-record', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      await ctx.postProgress(seeded);
      await client.seed(seeded);
      assertEqual(client.counters().attempts, 1, 'the client starts with the seeded record');
      await client.reset();
      await sleep(SETTLE_MS);

      assertTrue(!fs.existsSync(ctx.progressPath), 'progress.json must be gone after a reset');
      assertTrue(!fs.existsSync(`${ctx.progressPath}.bak`), 'the one-generation backup must be gone too');
      const leftovers = filesContaining(ctx.dir, MARKER);
      assertEqual(leftovers.length, 0, `no file under the progress directory may still hold learner text, found ${leftovers.join(', ')}`);
      const after = await ctx.getProgress();
      assertEqual(after.json.found, false, 'GET /api/progress must report no record, not the merged one');
      return 'record deleted; GET reports found:false';
    });

    /* 3. The browser cache must be cleared, or the client re-uploads its copy later. */
    await record('reset-clears-browser-cache', async () => {
      const raw = client.cacheRaw() || '';
      assertTrue(!raw.includes(MARKER), 'the browser cache must not still hold the learner text');
      const cached = raw ? JSON.parse(raw) : {};
      assertEqual(cached.counters?.attempts || 0, 0, 'cached counter must be empty');
      assertEqual((cached.history || []).length, 0, 'cached history must be empty');
      assertEqual((cached.errors || []).length, 0, 'cached notebook must be empty');
      assertEqual(Object.keys(cached.nodes || {}).length, 0, 'cached ability nodes must be empty');
      return 'localStorage holds an empty progress record';
    });

    /* 4. A reload must not put the record back. */
    await record('reset-not-undone-on-next-load', async () => {
      const before = posts();
      const sync = await client.nextLoad();
      await sleep(SETTLE_MS);
      assertEqual(posts(), before, 'the next load must not POST the deleted record back');
      const after = await ctx.getProgress();
      assertEqual(after.json.found, false, 'the server record must stay deleted after a reload');
      const raw = client.cacheRaw() || '';
      assertTrue(!raw.includes(MARKER), 'the reload must not restore the learner text into the cache');
      return `reload: ${JSON.stringify(sync)}; server still empty`;
    });

    /* 5. Configuration is not learner progress and must survive. */
    await record('reset-preserves-configuration', async () => {
      const env = fs.readFileSync(ctx.envPath, 'utf8');
      assertTrue(env.includes(SYNTHETIC_KEY), 'the provider key in .env must survive a reset');
      assertTrue(env.includes(EXAM_DATE), 'the exam date in .env must survive a reset');
      assertEqual(local._raw(THEME_KEY), 'dark', 'the theme preference must survive a reset');
      const settings = client.settings();
      assertEqual(settings.examDate, EXAM_DATE, 'the exam date in the learner settings must survive');
      assertEqual(settings.dailyGoal, 30, 'the daily goal must survive');
      assertEqual(settings.ttsRate, 1.1, 'the TTS rate must survive');
      assertEqual(settings.writingTaskIndex, undefined, 'the rotation counter is progress and must be cleared');
      return 'kept: .env key and exam date, theme, examDate/dailyGoal/ttsRate; cleared: rotation counter';
    });

    /* 6. Clearing the notebook removes the entries and keeps everything else. */
    await record('clear-notebook-removes-entries-keeps-history', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      await ctx.postProgress(seeded);
      await client.seed(seeded);
      await client.clearNotebook();
      await sleep(SETTLE_MS);

      const after = await ctx.getProgress();
      assertEqual(after.json.found, true, 'the record itself must survive a notebook clear');
      assertEqual(after.json.state?.errors?.length, 0, 'the notebook must be empty on the server');
      assertEqual(after.json.state?.history?.length, 1, 'the attempts must survive a notebook clear');
      assertEqual(after.json.state?.nodes?.['skill:LV1']?.n, 4, 'the ability evidence must survive');
      for (const file of [ctx.progressPath, `${ctx.progressPath}.bak`]) {
        if (!fs.existsSync(file)) continue;
        assertTrue(!fs.readFileSync(file, 'utf8').includes(MARKER), `${path.basename(file)} must not keep the deleted notebook text`);
      }
      const raw = client.cacheRaw() || '';
      assertTrue(!raw.includes(MARKER), 'the browser cache must not keep the deleted notebook text');
      return 'notebook emptied on both sides; history and ability kept';
    });

    /* 7. An unknown scope must be refused, never guessed. */
    await record('unknown-delete-scope-is-rejected', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      await ctx.postProgress(seeded);
      const res = await ctx.read('/api/progress?scope=nonsense', {
        method: 'DELETE',
        headers: { Origin: ctx.baseUrl },
      });
      assertEqual(res.status, 400, 'unknown scope status');
      assertEqual(res.json?.code, 'invalid_scope', 'error token');
      const after = await ctx.getProgress();
      assertEqual(after.json.found, true, 'an unknown scope must not delete the record');
      clearProgressFiles(ctx);
      return '400 invalid_scope; record untouched';
    });

    /* 8. The new delete path must not be reachable from a foreign page (SEC-01 gate). */
    await record('delete-requires-same-origin', async () => {
      clearProgressFiles(ctx);
      const seeded = seededState();
      await ctx.postProgress(seeded);
      const res = await ctx.read('/api/progress', {
        method: 'DELETE',
        headers: { Origin: 'http://attacker.example' },
      });
      assertEqual(res.status, 403, 'foreign-origin DELETE status');
      assertEqual(res.json?.code, 'origin_rejected', 'error token');
      const after = await ctx.getProgress();
      assertEqual(after.json.found, true, 'a foreign-origin delete must not remove the record');
      clearProgressFiles(ctx);
      return '403 origin_rejected; record intact';
    });

    /* 9. What the reset deliberately does not reach. */
    await record('backup-copies-outside-deletion-path', async () => {
      const copy = `${ctx.progressPath}.pre-recovery`;
      fs.writeFileSync(copy, JSON.stringify(seededState()), 'utf8');
      await client.reset();
      await sleep(SETTLE_MS);
      assertTrue(fs.existsSync(copy), 'the pre-recovery copy must be untouched (this is the documented boundary)');
      fs.rmSync(copy, { force: true });
      return 'documented: pre-recovery/portable copies (F-5) are outside the deletion path';
    });
  } finally {
    clearProgressFiles(ctx);
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    root,
    mode,
    envPath: ctx.envPath,
    progressPath: ctx.progressPath,
  };
}

/* ----------------------------------------------------------------------- CLI */

function printRun(report, io) {
  io.log(`  ${report.mode === 'tree' ? 'tree' : 'prefix'} client @ ${report.root}`);
  for (const result of report.results) {
    io.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  [${result.detail}]`);
  }
}

/**
 * Parse `--legacy-root <path>`.
 *
 * SEC-05 hardening: with no value (or another flag next) this used to resolve to the
 * current directory and compare the candidate against itself, reporting a silent false
 * negative (`pre-fix run fails 0 check(s)`). It now fails loudly instead, and a path that
 * is not a checkout is refused rather than run.
 *
 * @returns {{provided: boolean, root: string|null, error: string|null}}
 */
export function parseLegacyRoot(argv = [], defaultRoot = DEFAULT_ROOT) {
  const index = argv.indexOf('--legacy-root');
  if (index === -1) return { provided: false, root: null, error: null };
  const value = argv[index + 1];
  if (value === undefined || value === '' || value.startsWith('-')) {
    return { provided: true, root: null, error: '--legacy-root requires a path to a pre-fix checkout (got no value)' };
  }
  const root = path.resolve(value);
  if (!fs.existsSync(path.join(root, 'server.js'))) {
    return { provided: true, root, error: `no server.js under ${root}; --legacy-root must point at a pre-fix checkout` };
  }
  if (root === path.resolve(defaultRoot)) {
    return { provided: true, root, error: `--legacy-root points at this tree (${root}); the comparison would be against itself` };
  }
  return { provided: true, root, error: null };
}

export async function runCli(argv = process.argv.slice(2), io = console) {
  const legacy = parseLegacyRoot(argv);
  const legacyRoot = legacy.root;

  // A bad --legacy-root is a caller error, not a passing run: report it and stop before
  // claiming anything, so the silent compare-against-itself false negative cannot recur.
  if (legacy.provided && legacy.error) {
    io.error(`  FAIL  ${legacy.error}`);
    return 1;
  }

  io.log('reset-check: reset and clear actually delete (SEC-02, finding F-2)');
  const report = await runResetChecks({ mode: 'tree' });
  io.log(`  env file used by the suite: ${report.envPath} (throwaway; repository .env never touched)`);
  printRun(report, io);

  if (legacyRoot) {
    let prefix = null;
    try {
      prefix = await runResetChecks({ root: legacyRoot, mode: 'tree' });
    } catch (err) {
      io.log(`  pre-fix checkout at ${legacyRoot} could not be run: ${err.message}`);
    }
    if (prefix) {
      io.log('');
      io.log(`  BEFORE/AFTER — same probe, pre-fix tree ${prefix.root}`);
      printRun(prefix, io);
      const failed = prefix.results.filter((result) => !result.ok).map((result) => result.name);
      io.log(`  pre-fix run fails ${failed.length} check(s): ${failed.join(', ') || 'none'}`);
      if (failed.length === 0) {
        io.error('  FAIL  the pre-fix tree passed every check: the probe is not discriminating.');
        await closeAll();
        return 1;
      }
    }
  }

  await closeAll();

  if (report.ok) {
    io.log(`  OK    ${report.results.length} check(s) passed.`);
    io.log('  NOTE  HTTP + client module only: no browser, so real page lifecycle and debounce timing are not exercised.');
    return 0;
  }
  io.error(`  FAIL  ${report.results.filter((result) => !result.ok).length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
