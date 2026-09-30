/**
 * Offline checks for the *reach and honesty* of the delete path - finding **F-5**
 * ("backup copies of progress ... fall outside any deletion path"), **re-scoped for the SaaS
 * target** in work/implementation/F5-RESCOPE.md.
 *
 * The re-scope concludes (F5-RESCOPE.md §1.1, §1.3):
 *   * The learner's data that survives a delete in the SaaS target is not a USB copy - the
 *     portable build, sync and export/import are dropped (SAAS-CONVERSION.md §1.3). It is the
 *     **hosted** data: the owned tables, account settings, sessions, and every backup. Nothing
 *     here may claim those are gone.
 *   * What survives as an implementable, policy-independent guarantee is **honesty**: the delete
 *     must remove exactly what it claims to remove, and it must state what it cannot reach.
 *
 * So this file proves two separate things and keeps them separate:
 *   1. **Reach.** After the user-visible "delete everything", the record and the copies the server
 *      itself writes beside it (`progress.json`, `.bak`, `.tmp`) are gone, and no file the server
 *      wrote still holds the synthetic learner text. A copy *another tool* left in that directory
 *      is deliberately not the server's to delete and survives - that is the merged
 *      `reset-check` semantic (`backup-copies-outside-deletion-path`), which this slice kept.
 *   2. **Honesty.** The delete response names the files it removed and states what it cannot
 *      reach, and a copy it could **not** remove is reported as a failure rather than claimed as
 *      deleted. The statements are about reach only - **no retention period is claimed** anywhere,
 *      because that is a product/legal decision for Ron and is not made in code (F5-RESCOPE §1.4).
 *
 * The probe drives the real client code (`public/js/store.js`) against the real server
 * (`server.js`) in-process, and creates the copies with the real app processes first (a second
 * genuine save makes `.bak`). It then runs the real user-visible delete and asserts file by file.
 *
 * Scope and honesty of the probe itself:
 *   * HTTP + client-module layer. No browser is started, so no real page lifecycle or debounce
 *     timing is exercised; the probe waits longer than the save debounce instead, exactly as
 *     `reset-check.mjs` and `progress-scope-check.mjs` do.
 *   * `progress.json.tmp` is written by this probe with the exact name and shape the server's
 *     interrupted write leaves, because a genuine interrupted write cannot be produced
 *     deterministically. Everything else the probe asserts on is created by the real code.
 *   * `mode: 'prefix'` is not used. The authoritative before/after is a run of the *same* probe
 *     against the pre-fix tree, materialised from git and compared byte-for-byte by sha256, so
 *     the discrimination cannot drift to a different commit.
 *
 * Safety:
 *   * `B1PREP_ENV_FILE` and `B1PREP_PROGRESS_FILE` point into a throwaway temp directory and
 *     `B1PREP_FORCE_OFFLINE=1` is set, so no repository `.env`, no learner record, no database and
 *     no provider call is involved. Every credential-shaped value is synthetic and deliberately
 *     not `sk-` shaped.
 *   * The one filesystem trick in here (replacing a copy with a directory, to make a removal fail)
 *     happens inside the throwaway directory and is undone by the scenario's own cleanup.
 *
 * Usage: node tools/deletion-scope-check.mjs [--prefix-root <path-to-prefix-checkout>]
 * Exit code 0 when every check passes on this tree and the pre-fix tree is shown to fail the
 * honesty checks, 1 otherwise.
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
/** Synthetic learner text. If this string survives anywhere the server wrote, the delete was fake. */
export const MARKER = 'SYNTHETIC-LEARNER-TEXT-DELETION-SCOPE';
/** Longer than the 1200 ms save debounce in store.js, so a late save must have landed. */
const SETTLE_MS = 1600;
const STORAGE_KEY = 'b1prep.state.v1';
/** F-4 scopes: two accounts, to prove a delete reaches only the one that asked. */
const ACCOUNT_A = 'f5-check-account-a';
const ACCOUNT_B = 'f5-check-account-b';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The commit this branch starts from: `origin/codex/ownapi-03-persistent` (PR #60 still open, so
 * the brief's fallback base). The pre-fix server is materialised *from git at this SHA*, so the
 * discrimination run uses the real pre-fix code and not a stand-in.
 */
export const PREFIX_BASE = process.env.B1PREP_F5_PREFIX_BASE || '3e0a2a811f2199bcf72565edc68634225bb7daa7';
/** sha256 of `git show <base>:server.js` - the pre-fix delete path, byte-for-byte. */
export const PREFIX_SERVER_SHA256 = 'ee25d5c40611b3a88d85b500af1609c151a3764786e8b31b97ee3efae9fb3a7e';
/** The only files the probe loads from a tree. */
export const PREFIX_FILES = [
  'server.js',
  'public/js/store.js',
  'public/js/progress-merge.js',
  'public/js/blueprint.js',
];

/** Names the acceptance criteria require; the test file asserts each one ran and passed. */
export const REQUIRED_CHECKS = [
  'app-created-copies-exist-before-the-delete',
  'delete-removes-the-record-and-its-own-copies',
  'delete-leaves-a-copy-another-tool-wrote',
  'delete-reports-exactly-the-files-it-removed',
  'delete-states-what-it-cannot-reach',
  'delete-keeps-the-write-fence-and-it-holds-no-learner-text',
  'get-reports-no-record-after-the-delete',
  'delete-reaches-only-the-named-account',
  'an-unremovable-copy-is-reported-not-claimed',
];
export const DISCRIMINATION_CHECK = 'probe-discriminates-on-prefix-tree';

/** Checks that must FAIL on the pre-fix tree (they are the point of this slice). */
export const HONESTY_CHECKS = [
  'delete-reports-exactly-the-files-it-removed',
  'delete-states-what-it-cannot-reach',
  'an-unremovable-copy-is-reported-not-claimed',
];
/** Checks that must PASS on both trees - without them a failing pre-fix run proves nothing. */
export const CONTROL_CHECKS = REQUIRED_CHECKS.filter((name) => !HONESTY_CHECKS.includes(name));

/** The three files the server itself writes beside the record. */
const SERVER_WRITTEN = ['progress.json', 'progress.json.bak', 'progress.json.tmp'];
/** A copy another tool left in the same directory (the merged `reset-check` boundary). */
const OTHER_TOOL_COPY = 'progress.json.pre-recovery';

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------- test harness */

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
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
    clear: () => map.clear(),
  };
}

/** Synthetic learner record. Everything in it is invented. */
function seededState() {
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
        id: 'f5-rescope-synthetic-1',
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
    counters: { attempts: 1, correct: 1, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

/* ------------------------------------------------------------------ servers */

const servers = new Map();

/**
 * Start one root's server.js in-process on an ephemeral port with throwaway env and progress
 * files. The env vars are read at module load, so they must be set before the dynamic import; one
 * context is therefore created per root per process.
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
    local: makeLocalStorage(),
    log: [],
    read: (requestPath, options = {}) => request(port, { path: requestPath, ...options }),
    postProgress: (state, accountId = null) =>
      request(port, {
        method: 'POST',
        path: '/api/progress',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
          ...(accountId ? { 'X-B1Prep-Account': accountId } : {}),
        },
        body: JSON.stringify({ state }),
      }),
    getProgress: (accountId = null) =>
      request(port, {
        path: '/api/progress',
        headers: accountId ? { 'X-B1Prep-Account': accountId } : {},
      }),
    deleteAll: (accountId = null) =>
      request(port, {
        method: 'DELETE',
        path: '/api/progress?scope=all',
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          ...(accountId ? { 'X-B1Prep-Account': accountId } : {}),
        },
      }),
    file: (name) => path.join(dir, name),
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

/**
 * Remove everything a scenario may have left in the throwaway progress directory, so each starts
 * from a clean slate. `.rev` goes too: a `deletedThrough` mark left by one scenario would
 * (correctly) refuse the next scenario's first write.
 */
function clearProgressFiles(ctx) {
  const base = path.basename(ctx.progressPath);
  for (const name of fs.readdirSync(ctx.dir)) {
    if (name === path.basename(ctx.envPath)) continue;
    if (name.startsWith(base)) fs.rmSync(path.join(ctx.dir, name), { recursive: true, force: true });
  }
}

/** Names of files directly under `dir` that still hold `needle`. Directories are skipped. */
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
 * Replace globalThis.fetch with one that resolves the client's relative URLs against the running
 * server, adds the Origin header a browser adds to a same-origin request, and records every
 * DELETE **with its parsed body** - the response body is the thing this slice is about, and the
 * client module discards it.
 */
function installFetchStub(ctx) {
  ctx.log.length = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ctx.baseUrl);
    const { signal, ...rest } = init;
    const headers = { ...(rest.headers || {}) };
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'origin')) headers.Origin = ctx.baseUrl;
    const method = (rest.method || 'GET').toUpperCase();
    const response = await realFetch(url, { ...rest, headers, signal });
    if (method === 'DELETE') {
      let body = null;
      try {
        body = await response.clone().json();
      } catch {
        /* not JSON */
      }
      ctx.log.push({ method, path: url.pathname + url.search, status: response.status, body });
    }
    return response;
  };
}

/** The last DELETE this context's client made, with its response body. */
function lastDelete(ctx) {
  const entries = ctx.log.filter((entry) => entry.method === 'DELETE');
  return entries.length ? entries[entries.length - 1] : null;
}

/** The real client: the tree's own public/js/store.js, driven as ui.js drives it. */
async function makeTreeClient(root, local) {
  const storePath = pathToFileURL(path.join(root, 'public/js/store.js')).href;
  const store = await import(storePath);
  return {
    async seed(state) {
      local.setItem(STORAGE_KEY, JSON.stringify(state));
      store.importJSON(JSON.stringify(state));
      // Deliver the queued save now, so the server and the browser hold the same record, as
      // after a normal session.
      await store.flushNow();
    },
    reset: () => store.resetAll(),
  };
}

/* -------------------------------------------------- pre-fix tree from git (discrimination) */

/**
 * Materialise the pre-fix tree from git at `PREFIX_BASE` into a temp directory, using
 * `git show <sha>:<file>` so the bytes are the committed bytes.
 *
 * Throws (never silently skips) when git or the base commit is unavailable; the CLI turns that
 * into a FAIL, and the test file skips the discrimination test *with a reason*.
 */
export function materializePrefixTree(base = PREFIX_BASE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-f5-prefix-'));
  try {
    for (const rel of PREFIX_FILES) {
      const content = execFileSync('git', ['show', `${base}:${rel}`], { cwd: DEFAULT_ROOT, maxBuffer: 64 * 1024 * 1024 });
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not materialise the pre-fix tree from git ${base}: ${err.message}`);
  }
  return { root: dir, base };
}

/* --------------------------------------------------------------------- probe */

/**
 * Run every deletion-scope check against one tree.
 *
 * @param {{ctx: object, client: object}} session the tree's server context and client
 * @returns {Promise<Array<{name: string, ok: boolean, detail: string}>>}
 */
async function runScenarios({ ctx, client }) {
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  /** Clean slate plus the record the server really wrote, including the real one-generation `.bak`. */
  const withRecord = async ({ tmp = false, otherTool = false } = {}) => {
    clearProgressFiles(ctx);
    ctx.local.clear();
    const seeded = seededState();
    await ctx.postProgress(seeded);  // first save: the record, no `.bak` yet
    await client.seed(seeded);       // the client's own save: `writeProgress` copies the previous generation to `.bak`
    if (tmp) fs.writeFileSync(ctx.file('progress.json.tmp'), JSON.stringify(seeded), 'utf8');
    if (otherTool) fs.writeFileSync(ctx.file(OTHER_TOOL_COPY), JSON.stringify(seeded), 'utf8');
    return seeded;
  };

  /** One user-visible delete, then the wait the debounce needs. */
  const deleteAll = async () => {
    await client.reset();
    await sleep(SETTLE_MS);
    return lastDelete(ctx);
  };

  /* 1. The probe must start from copies that really exist, or it proves nothing about deletion. */
  await record('app-created-copies-exist-before-the-delete', async () => {
    await withRecord({ tmp: true, otherTool: true });
    for (const name of [...SERVER_WRITTEN, OTHER_TOOL_COPY]) {
      const full = ctx.file(name);
      assertTrue(fs.existsSync(full), `${name} must exist before the delete`);
      assertTrue(fs.readFileSync(full, 'utf8').includes(MARKER), `${name} must really hold the learner text`);
    }
    return `created first: ${[...SERVER_WRITTEN, OTHER_TOOL_COPY].join(', ')}`;
  });

  /* 2. Reach: what the server itself wrote must be gone, and nothing it wrote may still hold text. */
  await record('delete-removes-the-record-and-its-own-copies', async () => {
    await withRecord({ tmp: true });
    assertTrue(fs.existsSync(ctx.file('progress.json.bak')), 'the scenario must start with a real .bak');
    await deleteAll();
    for (const name of SERVER_WRITTEN) {
      assertTrue(!fs.existsSync(ctx.file(name)), `${name} must be removed by a full delete`);
    }
    const leftovers = filesContaining(ctx.dir, MARKER);
    assertDeepEqual(leftovers, [], 'no file the server wrote may still hold learner text');
    return 'record, one-generation backup and leftover temp removed; no text left behind';
  });

  /* 3. The merged boundary, kept: a copy another tool wrote is not this server's to delete. */
  await record('delete-leaves-a-copy-another-tool-wrote', async () => {
    await withRecord({ otherTool: true });
    await deleteAll();
    assertTrue(fs.existsSync(ctx.file(OTHER_TOOL_COPY)), `${OTHER_TOOL_COPY} is not the server's to delete and must survive`);
    assertTrue(fs.readFileSync(ctx.file(OTHER_TOOL_COPY), 'utf8').includes(MARKER), 'the surviving copy really is a copy of the record');
    return `${OTHER_TOOL_COPY} survived, as the merged reset-check boundary asserts`;
  });

  /* 4. Honesty: the response must name exactly the files it removed - no more, no less. */
  await record('delete-reports-exactly-the-files-it-removed', async () => {
    await withRecord({ tmp: true, otherTool: true });
    const observed = await deleteAll();
    assertTrue(observed, 'the delete must have been issued');
    assertEqual(observed.status, 200, 'delete status');
    assertEqual(observed.body?.deleted, true, 'delete must report deleted:true');
    assertDeepEqual([...(observed.body?.removed || [])].sort(), [...SERVER_WRITTEN].sort(), 'the removed list must be exactly the files this server writes');
    assertTrue(!(observed.body?.removed || []).includes(OTHER_TOOL_COPY), 'a copy the server did not remove must never be claimed as removed');
    for (const name of observed.body.removed) {
      assertTrue(!fs.existsSync(ctx.file(name)), `${name} is claimed as removed but still exists`);
    }
    return `removed exactly: ${observed.body.removed.join(', ')}`;
  });

  /* 5. Honesty: `deleted: true` must be accompanied by the places it cannot reach. */
  await record('delete-states-what-it-cannot-reach', async () => {
    await withRecord();
    const observed = await deleteAll();
    const boundary = observed?.body?.outsideScope;
    assertTrue(Array.isArray(boundary), 'the delete must return an outsideScope list, not only deleted:true');
    assertTrue(boundary.length >= 4, `outsideScope must name the boundaries, got ${boundary.length} statement(s)`);
    for (const statement of boundary) {
      assertTrue(typeof statement === 'string' && statement.trim().length >= 40, `every boundary statement must be a real sentence, got ${JSON.stringify(statement)}`);
    }
    const joined = boundary.join(' ');
    assertTrue(/browser/i.test(joined), 'the boundary must name the browser copy the server cannot reach');
    assertTrue(/backup/i.test(joined), 'the boundary must name backups: a hosted service has them');
    assertTrue(/another tool/i.test(joined), 'the boundary must name a copy another tool wrote beside the record');
    assertTrue(/\.rev\b/.test(joined), 'the boundary must name the write fence it keeps on purpose');
    // The dropped surfaces must not be described: sync, export and the portable build are not part
    // of the SaaS product (SAAS-CONVERSION.md §1.3), so an "outside scope" note about them would be
    // a claim about a mechanism that no longer exists.
    assertTrue(!/(portable|removable|USB|export)/i.test(joined), 'the boundary must not name surfaces the SaaS conversion dropped');
    return `${boundary.length} boundary statement(s), including backups and the browser copy`;
  });

  /* 6. The write fence is kept, on purpose, and is not itself a copy of the learner's text. */
  await record('delete-keeps-the-write-fence-and-it-holds-no-learner-text', async () => {
    await withRecord();
    await deleteAll();
    const fence = ctx.file('progress.json.rev');
    assertTrue(fs.existsSync(fence), 'the revision fence must survive the delete');
    const raw = fs.readFileSync(fence, 'utf8');
    assertTrue(!raw.includes(MARKER), 'the fence must not hold learner text');
    const marker = JSON.parse(raw);
    assertTrue(Number(marker.rev) >= 1, 'the fence must record the delete');
    assertTrue(Number(marker.deletedThrough) >= 1, 'the fence must record what it refuses');
    return `fence kept: rev ${marker.rev}, deletedThrough ${marker.deletedThrough}; no learner text`;
  });

  /* 7. The record is really gone from the server's point of view. */
  await record('get-reports-no-record-after-the-delete', async () => {
    await withRecord();
    await deleteAll();
    const after = await ctx.getProgress();
    assertEqual(after.json?.found, false, 'GET must report no record');
    assertTrue(!after.json?.state, 'GET must not return a state');
    return 'GET reports found:false';
  });

  /* 8. SaaS isolation: a delete reaches the account that asked, and nothing else. */
  await record('delete-reaches-only-the-named-account', async () => {
    clearProgressFiles(ctx);
    ctx.local.clear();
    const seeded = seededState();
    await ctx.postProgress(seeded);
    await ctx.postProgress(seeded, ACCOUNT_A);
    await ctx.postProgress(seeded, ACCOUNT_A);
    await ctx.postProgress(seeded, ACCOUNT_B);
    const res = await ctx.deleteAll(ACCOUNT_A);
    assertEqual(res.status, 200, 'scoped delete status');
    assertEqual(res.json?.deleted, true, 'scoped delete must report deleted:true');
    // The isolation guarantee itself, true on both trees. The response shape (`removed` naming
    // exactly the files) is asserted for the legacy scope by
    // `delete-reports-exactly-the-files-it-removed`; here the scoped report must at least never
    // name a file outside the account that asked.
    assertTrue(
      (res.json?.removed || []).every((name) => name.includes(ACCOUNT_A)),
      'a scoped delete must never report a file outside the account that asked'
    );
    assertTrue(!fs.existsSync(ctx.file(`progress.json.${ACCOUNT_A}`)), "account A's record must be gone");
    assertTrue(!fs.existsSync(ctx.file(`progress.json.${ACCOUNT_A}.bak`)), "account A's one-generation backup must be gone");
    assertTrue(fs.existsSync(ctx.file(`progress.json.${ACCOUNT_B}`)), "account B's record must survive");
    assertTrue(fs.existsSync(ctx.file('progress.json')), 'the legacy record must survive a scoped delete');
    return "removed A's record only; B's record and the legacy record intact";
  });

  /* 9. Honesty when the filesystem refuses: report the failure, never claim the delete. */
  await record('an-unremovable-copy-is-reported-not-claimed', async () => {
    clearProgressFiles(ctx);
    ctx.local.clear();
    const seeded = seededState();
    await ctx.postProgress(seeded);
    await ctx.postProgress(seeded);
    const bak = ctx.file('progress.json.bak');
    assertTrue(fs.existsSync(bak), 'the scenario must start with a real .bak');
    // Make one copy genuinely unremovable: a non-empty directory cannot be removed by
    // `fsp.rm(p, { force: true })`, which does not recurse. The record itself stays removable, so
    // the scenario is about the report and not about a broken install.
    fs.rmSync(bak, { force: true });
    fs.mkdirSync(bak);
    fs.writeFileSync(path.join(bak, 'leftover.json'), JSON.stringify(seeded), 'utf8');
    try {
      const res = await ctx.deleteAll();
      assertEqual(res.status, 500, 'an incomplete delete must not report success');
      assertEqual(res.json?.code, 'delete_incomplete', 'the failure must be named');
      assertEqual(res.json?.deleted, false, 'deleted must not be claimed when a copy is still there');
      assertTrue((res.json?.failed || []).includes('progress.json.bak'), 'the copy that could not be removed must be named');
      assertTrue(fs.existsSync(bak), 'the unremovable copy is still there, as reported');
      assertTrue(Array.isArray(res.json?.outsideScope) && res.json.outsideScope.length > 0, 'even a failed delete must state what it could not reach');
      return `reported 500 delete_incomplete; failed: ${(res.json.failed || []).join(', ')}`;
    } finally {
      fs.rmSync(bak, { recursive: true, force: true });
    }
  });

  return results;
}

/**
 * Run the deletion-scope checks on this tree, and on the pre-fix tree when one is available.
 *
 * @param {{root?: string, legacyRoot?: string|null}} options
 * @returns {Promise<{ok: boolean, results: Array, root: string, prefix: object|null,
 *   prefixSha: string|null, envPath: string, progressPath: string}>}
 */
export async function runDeletionScopeChecks({ root = DEFAULT_ROOT, legacyRoot = null } = {}) {
  const ctx = await ensureServer(root);
  globalThis.localStorage = ctx.local;
  installFetchStub(ctx);
  const client = await makeTreeClient(root, ctx.local);

  let results;
  let prefix = null;
  let prefixSha = null;
  let prefixError = null;
  try {
    results = await runScenarios({ ctx, client });

    if (legacyRoot) {
      try {
        const prefixCtx = await ensureServer(legacyRoot);
        globalThis.localStorage = prefixCtx.local;
        installFetchStub(prefixCtx);
        const prefixClient = await makeTreeClient(legacyRoot, prefixCtx.local);
        const prefixResults = await runScenarios({ ctx: prefixCtx, client: prefixClient });
        prefixSha = createHash('sha256').update(fs.readFileSync(path.join(legacyRoot, 'server.js'))).digest('hex');
        prefix = { root: legacyRoot, results: prefixResults, sha256: prefixSha };
      } catch (err) {
        prefixError = err.message;
      }
    }
  } finally {
    globalThis.localStorage = undefined;
    globalThis.fetch = realFetch;
  }

  if (legacyRoot) {
    let ok = false;
    let detail;
    try {
      assertTrue(prefix !== null, `the pre-fix tree could not be run: ${prefixError}`);
      // Byte-for-byte: the comparison is only meaningful if this really is the recorded base blob.
      assertEqual(prefix.sha256, PREFIX_SERVER_SHA256, 'the pre-fix server.js must be the recorded base blob (byte-for-byte)');
      const byName = new Map(prefix.results.map((result) => [result.name, result]));
      const stillPassing = HONESTY_CHECKS.filter((name) => byName.get(name)?.ok);
      const brokenControls = CONTROL_CHECKS.filter((name) => !byName.get(name)?.ok);
      assertDeepEqual(stillPassing, [], 'the honesty checks must FAIL on the pre-fix tree, or the probe does not discriminate');
      assertDeepEqual(brokenControls, [], `the control checks must still PASS on the pre-fix tree, got failures: ${brokenControls.join(', ')}`);
      ok = true;
      detail = `pre-fix ${prefix.sha256.slice(0, 12)} fails ${HONESTY_CHECKS.length} honesty check(s) and passes all ${CONTROL_CHECKS.length} control(s)`;
    } catch (err) {
      detail = err.message;
    }
    results.push({ name: DISCRIMINATION_CHECK, ok, detail });
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    root,
    prefix,
    prefixSha,
    prefixError,
    envPath: ctx.envPath,
    progressPath: ctx.progressPath,
  };
}

/* ----------------------------------------------------------------------- CLI */

function printRun(report, io, title) {
  if (title) io.log(title);
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

  io.log('deletion-scope-check: the delete removes what it claims and states what it cannot reach (F-5, re-scoped)');

  let legacyRoot = prefixValue ? path.resolve(prefixValue) : null;
  let materialized = null;
  if (!legacyRoot) {
    try {
      materialized = materializePrefixTree();
      legacyRoot = materialized.root;
      io.log(`  pre-fix tree materialised from git ${materialized.base} -> ${materialized.root}`);
    } catch (err) {
      io.error(`  FAIL  ${err.message}.`);
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
  if (report.prefix) {
    io.log('');
    printRun({ root: report.prefix.root, results: report.prefix.results }, io, '  BEFORE/AFTER - same probe, pre-fix tree');
    io.log(`  pre-fix server.js sha256 ${report.prefix.sha256}`);
  }

  await closeAll();
  if (materialized) fs.rmSync(materialized.root, { recursive: true, force: true });

  const failed = report.results.filter((result) => !result.ok);
  if (report.ok) {
    io.log(`  OK    ${report.results.length} check(s) passed, including discrimination against the pre-fix tree.`);
    io.log('  NOTE  HTTP + client module only: no browser, so real page lifecycle and debounce timing are not exercised.');
    io.log('  NOTE  The response states reach, never a retention period: retention is a product/legal decision for Ron.');
    return 0;
  }
  io.error(`  FAIL  ${failed.length} of ${report.results.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
