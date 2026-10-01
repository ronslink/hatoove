/**
 * Offline checks that no route discloses any character of the stored provider key.
 *
 * SEC-04 fix for finding F-7 in work/implementation/P-03A-PRIVACY-AUDIT.md: server.js's
 * `maskKey` returned `<first 5>...<last 4>` of the key - nine characters - and
 * `publicConfig()` served it as `keyMasked` from the unauthenticated read routes
 * GET /api/health and GET /api/config. The POST /api/config reply returns the same object
 * (plus `saved`), so it disclosed the same characters. The server binds 127.0.0.1, so those
 * characters were never remotely reachable and were not a usable credential; the point is
 * that a status display does not need any character of the key.
 *
 * What this probe proves
 *   * The body of each route contains no character run of length >= 3 of the configured
 *     key. Every substring of length >= 3 contains a 3-character substring, so scanning
 *     every 3-gram is complete for "any substring": a whole key, a prefix, a suffix or a
 *     differently sliced fragment are all caught. A check written against the old
 *     first5+last4 shape would only catch that one shape, which is why this probe does not
 *     know about it.
 *   * The same scan runs over every string value of the parsed JSON with field paths, so a
 *     leak in a nested field is reported with its location.
 *   * the synthetic key is asserted loaded into the server process at scan time - so a pass
 *     cannot be vacuous because no key was loaded - and the read routes are asserted to
 *     carry no key-derived field both with and without the key.
 *   * The field set of the payload is asserted to be exactly {examDate} for /api/config and
 *     {node, ok} for /api/health, which is how "do not invent a new exposure to replace the
 *     old one" is enforced against a future field.
 *   * `detector-flags-the-legacy-mask` exercises the detector itself: it must flag the
 *     exact string the old `maskKey` returned, and must stay silent on the new payload.
 *   * `runKeyMaskChecks({ serverPath })` re-runs the whole probe against another server.js
 *     copy. The pre-fix source (`git show 8a71f718ee534851a98d19eece07dab933b56479:server.js`)
 *     must FAIL the leak checks there; `judgeDiscrimination` is the criterion, and the CLI
 *     exits 1 when a source that should be caught is not.
 *
 * Scope and honesty
 *   * HTTP layer only, in-process. No browser is started, so this says nothing about how a
 *     browser renders the Settings pill.
 *   * The probe reads back the throwaway env file it wrote and puts those values into
 *     process.env, so the key it scans for is provably the one the server loaded.
 *   * The pre-fix copy is imported from a temp directory that gets a copy of
 *     `public/js/progress-merge.js`, because server.js imports it by relative path. The
 *     copied file is byte-identical to the tree's; only `server.js` differs.
 *
 * Safety
 *   * B1PREP_ENV_FILE and B1PREP_PROGRESS_FILE point into a throwaway temp directory, and
 *     `repository-env-untouched` asserts the checkout's `.env` was neither created nor
 *     modified. It is stat()ed only - never opened - so a real key cannot be read here.
 *   * Any inherited DEEPSEEK_* / EXAM_DATE variable is deleted from this process before
 *     server.js is imported, so a real key in the developer's environment cannot be served,
 *     scanned or printed by this run.
 *   * The key is synthetic, deliberately not `sk-` shaped, and is never printed in full.
 *
 * Usage: node tools/keymask-check.mjs [--prefix-commit <sha> | --server <path-to-server.js>]
 * Exit code 0 when every check passes on this tree, 1 otherwise. With --prefix-commit or
 * --server the probe also runs against that copy and exits 1 if it is not caught - a probe
 * that passes on both trees would be worthless.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Synthetic. Deliberately not `sk-` shaped and never a real provider key. */
export const SYNTHETIC_KEY = 'Zq7Xv2Rt9Kp4Lm8Wn3Bd6Fh5Jg1Cs0Yt4Ew6';
/** Synthetic model name, so a status field visibly comes from the throwaway env file. */
export const SYNTHETIC_MODEL = 'probe-model-synthetic-42';
export const EXAM_DATE = '2031-01-01';
/** Posted by the write-path check; must land in the throwaway env file, nowhere else. */
export const POSTED_EXAM_DATE = '2032-02-02';
/** Length of the character runs the scan tests. Every longer run contains one of these. */
export const KEY_RUN_LENGTH = 3;
/** The commit SEC-04 was written against; its server.js is the pre-fix source. */
export const PREFIX_COMMIT = '8a71f718ee534851a98d19eece07dab933b56479';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fields the read routes may return after PROVIDER-CONFIG-01 (D1). D1 removed `configured`,
 * `model` and `baseUrl`: a presence flag and the operator's provider setup are not learner
 * information. `/api/config` now carries only the learner's own `examDate`, and
 * `/api/health` is a bare liveness payload.
 */
export const ALLOWED_CONFIG_FIELDS = ['examDate'];
export const ALLOWED_HEALTH_FIELDS = ['node', 'ok'];

/** The checks that must FAIL on a source that still discloses key characters. */
export const LEAK_CHECKS = [
  'health-body-has-no-key-run',
  'health-json-values-have-no-key-run',
  'config-body-has-no-key-run',
  'config-json-values-have-no-key-run',
  'config-post-body-has-no-key-run',
];

/** Names the acceptance criteria require; the test file asserts each one ran and passed. */
export const REQUIRED_CHECKS = [
  'probe-key-is-synthetic-not-credential-shaped',
  'throwaway-env-file-outside-repository',
  'key-loaded-into-the-server-process',
  'status-reports-no-key-derived-field',
  ...LEAK_CHECKS,
  'read-routes-stay-live-without-a-key',
  'detector-flags-the-legacy-mask',
  'repository-env-untouched',
];

/* ----------------------------------------------------------------- the detector */

/** Every KEY_RUN_LENGTH-character run of `key`, without duplicates. */
export function keyRuns(key = SYNTHETIC_KEY) {
  const runs = new Set();
  for (let i = 0; i + KEY_RUN_LENGTH <= key.length; i += 1) runs.add(key.slice(i, i + KEY_RUN_LENGTH));
  return [...runs];
}

/**
 * Key runs disclosed by `text`. Case-insensitive on purpose: an echo that was lower- or
 * upper-cased still discloses the characters.
 */
export function findKeyRuns(text, key = SYNTHETIC_KEY) {
  const haystack = String(text).toLowerCase();
  return keyRuns(key).filter((run) => haystack.includes(run.toLowerCase()));
}

/** Every string value inside `payload`, with its path, so a nested leak is locatable. */
export function jsonStringValues(payload, prefix = '$') {
  if (typeof payload === 'string') return [[prefix, payload]];
  if (Array.isArray(payload)) return payload.flatMap((value, index) => jsonStringValues(value, `${prefix}[${index}]`));
  if (payload && typeof payload === 'object') {
    return Object.entries(payload).flatMap(([key, value]) => jsonStringValues(value, `${prefix}.${key}`));
  }
  return [];
}

/** [[path, runs], ...] for every string value of a parsed JSON payload. */
export function findKeyRunsInJson(payload, key = SYNTHETIC_KEY) {
  return jsonStringValues(payload)
    .map(([fieldPath, value]) => [fieldPath, findKeyRuns(value, key)])
    .filter(([, runs]) => runs.length > 0);
}

/** Exactly what the pre-fix `maskKey` returned for a key longer than 10 characters. */
export function legacyMask(key = SYNTHETIC_KEY) {
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

/* ---------------------------------------------------------------- test harness */

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, label) {
  if (!value) throw new Error(label);
}

/** Array/object comparison; assertEqual is for primitives only. */
function assertListEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function envValue(text, name) {
  if (!text) return undefined;
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
  return match ? match[1] : undefined;
}

function statOf(file) {
  try {
    const s = fs.statSync(file);
    return { exists: true, size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  } catch {
    return { exists: false };
  }
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
          /* not JSON; leave null */
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/* -------------------------------------------------------------------- servers */

/** Both throwaway paths, asserted by `throwaway-env-file-outside-repository`. */
export const THROWAWAY_PREFIX = 'b1prep-keymask-';

/**
 * Start a server.js in-process on an ephemeral loopback port with a throwaway env file that
 * holds the synthetic key. B1PREP_ENV_FILE is read at module load, so it is set before the
 * dynamic import; the values are re-applied afterwards anyway, because `settings()` reads
 * process.env on every call and a second call for another source reuses nothing.
 *
 * Mutates process.env, so one probe run at a time per process (as reset-check does).
 */
export async function startProbeServer({ root = DEFAULT_ROOT, serverPath = null, label = 'tree' } = {}) {
  const resolvedRoot = path.resolve(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), THROWAWAY_PREFIX));
  const envPath = path.join(dir, '.env');
  const progressPath = path.join(dir, 'progress.json');
  fs.writeFileSync(
    envPath,
    `DEEPSEEK_API_KEY=${SYNTHETIC_KEY}\nDEEPSEEK_MODEL=${SYNTHETIC_MODEL}\nEXAM_DATE=${EXAM_DATE}\n`,
    'utf8'
  );

  // An inherited key - a real one on the developer's machine - must not reach this run.
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'EXAM_DATE']) delete process.env[name];
  delete process.env.B1PREP_FORCE_OFFLINE; // the probe needs to see a configured key
  process.env.B1PREP_ENV_FILE = envPath;
  process.env.B1PREP_PROGRESS_FILE = progressPath;

  const modulePath = serverPath ? path.resolve(serverPath) : path.join(resolvedRoot, 'server.js');
  const { createServer } = await import(pathToFileURL(modulePath).href);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // The key in effect must be provably the synthetic one from the throwaway file.
  const fileVars = parseEnvText(fs.readFileSync(envPath, 'utf8'));
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'EXAM_DATE']) process.env[name] = fileVars[name];

  return {
    label,
    root: resolvedRoot,
    modulePath,
    dir,
    envPath,
    progressPath,
    port,
    readEnv: () => (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null),
    get: (requestPath) => request(port, { path: requestPath }),
    postConfig: (payload) =>
      request(port, {
        method: 'POST',
        path: '/api/config',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify(payload),
      }),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The pre-fix `server.js`, materialized from git into `targetDir` so it can be imported.
 * Throws when the blob is unavailable or does not look pre-fix, so a caller can never
 * mistake "could not load" for "the probe discriminated".
 */
export function materializePreFixServer(targetDir, { commit = PREFIX_COMMIT, root = DEFAULT_ROOT } = {}) {
  const blob = execFileSync('git', ['-C', path.resolve(root), 'show', `${commit}:server.js`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!/function maskKey\(/.test(blob)) {
    throw new Error(`${commit}:server.js does not contain the pre-fix maskKey; refusing to use it as a pre-fix source`);
  }
  /*
   * The pre-fix server imports `./public/js/progress-merge.js` relative to its own directory, and that
   * import belongs to the PRE-FIX TREE — the current server no longer has it, because PILOT-17a deleted
   * the file store. So the module is taken from the SAME COMMIT as the blob rather than copied from the
   * working tree: a retired module must not have to survive on disk for a historical comparison to stay
   * honest, and this check must not be the reason the SPA cannot be removed.
   */
  fs.mkdirSync(path.join(targetDir, 'public/js'), { recursive: true });
  const moduleBlob = execFileSync('git', ['-C', path.resolve(root), 'show', `${commit}:public/js/progress-merge.js`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.writeFileSync(path.join(targetDir, 'public/js/progress-merge.js'), moduleBlob, 'utf8');
  const file = path.join(targetDir, 'server.js');
  fs.writeFileSync(file, blob, 'utf8');
  return { file, source: `git blob ${commit}:server.js`, preFix: true };
}

/** Write the legacy stand-in (see LEGACY_STANDIN_SOURCE) into `targetDir`. */
export function writeLegacyStandIn(targetDir) {
  const file = path.join(targetDir, 'server.js');
  fs.writeFileSync(file, LEGACY_STANDIN_SOURCE, 'utf8');
  return { file, source: 'synthetic legacy stand-in (git blob unavailable)', preFix: false };
}

/** Discriminates a run against a source that should be caught by the leak checks. */
export function judgeDiscrimination(report) {
  const byName = new Map(report.results.map((result) => [result.name, result]));
  const missing = LEAK_CHECKS.filter((name) => !byName.has(name));
  const failedLeakChecks = LEAK_CHECKS.filter((name) => byName.has(name) && !byName.get(name).ok);
  const liveKey = byName.get('key-loaded-into-the-server-process');
  const keyWasLive = Boolean(liveKey && liveKey.ok);
  const ok = missing.length === 0 && failedLeakChecks.length > 0 && keyWasLive;
  const message = ok
    ? `${report.label} fails ${failedLeakChecks.length}/${LEAK_CHECKS.length} leak check(s) while the key is live: ${failedLeakChecks.join(', ')}`
    : `${report.label} did NOT discriminate: failed leak checks = ${failedLeakChecks.join(', ') || 'none'}` +
      `${missing.length ? `; missing checks = ${missing.join(', ')}` : ''}` +
      `; key-loaded-into-the-server-process = ${liveKey ? (liveKey.ok ? 'passed' : `failed (${liveKey.detail})`) : 'did not run'}`;
  return { ok, failedLeakChecks, keyWasLive, message };
}

/* ------------------------------------------------------------------ the checks */

function leakScanText(res, route) {
  if (res.status !== 200) throw new Error(`${route}: expected HTTP 200, got ${res.status} (${res.text.slice(0, 120)})`);
  // The scan is only meaningful while the synthetic key is live. The route no longer reports
  // whether a key exists (D1.2), so prove liveness at the source rather than from the body.
  assertEqual(process.env.DEEPSEEK_API_KEY, SYNTHETIC_KEY, `${route}: the synthetic key must be loaded, or the scan is vacuous`);
  const runs = findKeyRuns(res.text);
  if (runs.length) {
    throw new Error(`${route}: disclosed ${runs.length} run(s) of >=${KEY_RUN_LENGTH} key characters: ${runs.map((r) => JSON.stringify(r)).join(', ')}`);
  }
  return `200, ${res.text.length} bytes scanned against ${keyRuns().length} key runs, 0 hit`;
}

function leakScanJson(res, route) {
  if (res.json === null) throw new Error(`${route}: response is not JSON`);
  const hits = findKeyRunsInJson(res.json);
  if (hits.length) {
    throw new Error(`${route}: key characters in field(s) ${hits.map(([fieldPath, runs]) => `${fieldPath}=${JSON.stringify(runs)}`).join(', ')}`);
  }
  const scanned = jsonStringValues(res.json).length;
  return `${scanned} string field(s), 0 hit`;
}

/**
 * Run every check against one server source.
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>, label: string, root: string, modulePath: string, envPath: string, progressPath: string}>}
 */
export async function runKeyMaskChecks({ root = DEFAULT_ROOT, serverPath = null, label = null } = {}) {
  const target = label || serverPath || 'tree';
  const ctx = await startProbeServer({ root, serverPath, label: target });
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  const repositoryEnvPath = path.join(ctx.root, '.env');
  const repositoryEnvBefore = statOf(repositoryEnvPath);

  try {
    /* 1. The synthetic key has to be unmistakable, so any leak of it is. */
    await record('probe-key-is-synthetic-not-credential-shaped', () => {
      assertTrue(SYNTHETIC_KEY.length >= 24, `key must be long enough to leak several runs, got ${SYNTHETIC_KEY.length}`);
      assertTrue(/[A-Z]/.test(SYNTHETIC_KEY) && /[a-z]/.test(SYNTHETIC_KEY), 'key must mix cases');
      assertTrue(/[0-9]/.test(SYNTHETIC_KEY), 'key must contain digits');
      assertTrue(!/^sk-/.test(SYNTHETIC_KEY), 'key must not be `sk-` shaped, so it cannot be mistaken for a real one');
      assertTrue(!/sk-[A-Za-z0-9_-]{24,}/.test(SYNTHETIC_KEY), 'key must not match the repository secret scan');
      assertTrue(new Set(keyRuns()).size === SYNTHETIC_KEY.length - KEY_RUN_LENGTH + 1, 'key must have no repeated character run');
      return `${SYNTHETIC_KEY.length} chars, not credential-shaped, ${keyRuns().length} distinct runs scanned`;
    });

    /* 2. Nothing in this run may point at the checkout's own .env. */
    await record('throwaway-env-file-outside-repository', () => {
      const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
      for (const [what, file] of [['B1PREP_ENV_FILE', ctx.envPath], ['B1PREP_PROGRESS_FILE', ctx.progressPath]]) {
        assertTrue(path.resolve(file).startsWith(tmpRoot), `${what} must live under ${tmpRoot}, got ${file}`);
        assertTrue(!path.resolve(file).startsWith(ctx.root + path.sep), `${what} must not sit inside the checkout (${ctx.root})`);
      }
      return `${ctx.envPath} (throwaway)`;
    });

    /* Take the two read-route responses once, with the key live. */
    const health = await ctx.get('/api/health');
    const config = await ctx.get('/api/config');

    /* 3. The key really is loaded - otherwise every leak check below would be vacuous. */
    await record('key-loaded-into-the-server-process', () => {
      assertEqual(envValue(ctx.readEnv(), 'DEEPSEEK_API_KEY'), SYNTHETIC_KEY, 'throwaway env file holds the synthetic key');
      assertEqual(process.env.DEEPSEEK_API_KEY, SYNTHETIC_KEY, 'server process holds the synthetic key');
      assertEqual(process.env.B1PREP_ENV_FILE, ctx.envPath, 'server reads the throwaway env file');
      for (const [route, res] of [['/api/health', health], ['/api/config', config]]) {
        assertEqual(res.status, 200, `${route} status`);
      }
      return `synthetic key loaded into the server process from ${path.basename(ctx.envPath)}`;
    });

    /* 4. The read routes carry only learner/liveness state: no key-derived field at all. */
    await record('status-reports-no-key-derived-field', () => {
      assertListEqual(Object.keys(config.json || {}).sort(), ALLOWED_CONFIG_FIELDS, '/api/config field set');
      assertListEqual(Object.keys(health.json || {}).sort(), ALLOWED_HEALTH_FIELDS, '/api/health field set');
      assertEqual(config.json?.examDate, EXAM_DATE, '/api/config examDate');
      // The removed fields must not come back under any spelling.
      for (const field of ['configured', 'model', 'baseUrl', 'keyMasked']) {
        assertTrue(!Object.hasOwn(config.json || {}, field), `/api/config must not report ${field}`);
        assertTrue(!Object.hasOwn(health.json || {}, field), `/api/health must not report ${field}`);
      }
      return `/api/config = [${ALLOWED_CONFIG_FIELDS.join(', ')}]; /api/health = [${ALLOWED_HEALTH_FIELDS.join(', ')}]`;
    });

    /* 5-8. The read routes must carry no character run of the key. */
    await record('health-body-has-no-key-run', () => leakScanText(health, 'GET /api/health'));
    await record('health-json-values-have-no-key-run', () => leakScanJson(health, 'GET /api/health'));
    await record('config-body-has-no-key-run', () => leakScanText(config, 'GET /api/config'));
    await record('config-json-values-have-no-key-run', () => leakScanJson(config, 'GET /api/config'));

    /* 9. The write path replies with the same object, so it is scanned too. */
    await record('config-post-body-has-no-key-run', async () => {
      const res = await ctx.postConfig({ examDate: POSTED_EXAM_DATE });
      const detail = leakScanText(res, 'POST /api/config');
      assertEqual(envValue(ctx.readEnv(), 'EXAM_DATE'), POSTED_EXAM_DATE, 'the save landed in the throwaway env file');
      assertTrue(Array.isArray(res.json?.saved) && res.json.saved.includes('EXAM_DATE'), 'the reply still reports what was saved');
      return `${detail}; save landed in the throwaway file, not the checkout`;
    });

    /* 10. Without a key the read routes stay live and still carry no key-derived field. */
    await record('read-routes-stay-live-without-a-key', async () => {
      delete process.env.DEEPSEEK_API_KEY;
      const offlineHealth = await ctx.get('/api/health');
      const offlineConfig = await ctx.get('/api/config');
      for (const [route, res] of [['/api/health', offlineHealth], ['/api/config', offlineConfig]]) {
        assertEqual(res.status, 200, `${route} status without a key`);
        assertListEqual(
          Object.keys(res.json || {}).sort(),
          route === '/api/health' ? ALLOWED_HEALTH_FIELDS : ALLOWED_CONFIG_FIELDS,
          `${route} field set without a key`
        );
        const runs = findKeyRuns(res.text);
        assertTrue(runs.length === 0, `${route} disclosed key characters without a key: ${runs.join(', ')}`);
      }
      return 'both routes 200 with no key-derived field and no key characters';
    });

    /* 11. The detector is not vacuous: it must catch the old shape, and only that shape. */
    await record('detector-flags-the-legacy-mask', () => {
      const legacy = legacyMask();
      const legacyPayload = JSON.stringify({
        ok: true,
        configured: true,
        keyMasked: legacy,
        model: SYNTHETIC_MODEL,
        baseUrl: 'https://api.deepseek.com',
        examDate: EXAM_DATE,
      });
      const caught = findKeyRuns(legacyPayload);
      assertTrue(caught.length >= 2, `detector must catch the pre-fix mask ${legacy}, caught ${caught.length} run(s)`);
      const inJson = findKeyRunsInJson(JSON.parse(legacyPayload));
      assertTrue(inJson.some(([fieldPath]) => fieldPath === '$.keyMasked'), 'JSON scan must name $.keyMasked as the leaking field');

      const cleanPayload = JSON.stringify({
        ok: true,
        configured: true,
        model: SYNTHETIC_MODEL,
        baseUrl: 'https://api.deepseek.com',
        examDate: EXAM_DATE,
        node: process.version,
        saved: ['EXAM_DATE'],
      });
      const falsePositives = findKeyRuns(cleanPayload);
      assertTrue(falsePositives.length === 0, `detector fired on a clean payload: ${falsePositives.join(', ')}`);
      return `legacy mask ${legacy} -> ${caught.length} run(s) caught; clean payload -> 0 false positive`;
    });

    /* 12. The checkout's .env must be untouched - stat()ed, never opened. */
    await record('repository-env-untouched', () => {
      const after = statOf(repositoryEnvPath);
      assertEqual(JSON.stringify(after), JSON.stringify(repositoryEnvBefore), `${repositoryEnvPath} state`);
      return repositoryEnvBefore.exists
        ? `existing checkout .env unchanged (size ${after.size}, mtimeMs ${after.mtimeMs}); never opened`
        : 'no checkout .env before or after the run';
    });
  } finally {
    await ctx.close();
  }

  return {
    ok: results.every((result) => result.ok),
    results,
    label: ctx.label,
    root: ctx.root,
    modulePath: ctx.modulePath,
    envPath: ctx.envPath,
    progressPath: ctx.progressPath,
  };
}

/* ----------------------------------------------------------------------- CLI */

export function printRun(report, io) {
  io.log(`  ${report.label} server @ ${report.modulePath}`);
  for (const result of report.results) {
    io.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  [${result.detail}]`);
  }
}

export async function runCli(argv = process.argv.slice(2), io = console) {
  const serverIndex = argv.indexOf('--server');
  const commitIndex = argv.indexOf('--prefix-commit');
  const explicitServer = serverIndex === -1 ? null : path.resolve(argv[serverIndex + 1] || '');
  const prefixCommit = commitIndex === -1 ? null : argv[commitIndex + 1] || PREFIX_COMMIT;

  io.log('keymask-check: no route discloses any character of the key (SEC-04, finding F-7)');
  const report = await runKeyMaskChecks({ label: 'tree' });
  io.log(`  env file used by the suite: ${report.envPath} (throwaway; repository .env never touched)`);
  printRun(report, io);

  let prefixReport = null;
  if (explicitServer || prefixCommit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-keymask-prefix-'));
    try {
      let source;
      if (explicitServer) {
        if (!fs.existsSync(explicitServer)) throw new Error(`no such file: ${explicitServer}`);
        source = { file: explicitServer, source: explicitServer, preFix: null };
      } else {
        source = materializePreFixServer(dir, { commit: prefixCommit });
      }
      io.log('');
      io.log(`  BEFORE/AFTER - same probe, source ${source.source}`);
      prefixReport = await runKeyMaskChecks({ serverPath: source.file, label: 'pre-fix' });
      printRun(prefixReport, io);
      const verdict = judgeDiscrimination(prefixReport);
      io.log(`  ${verdict.ok ? 'OK   ' : 'FAIL '} discrimination: ${verdict.message}`);
      if (source.preFix !== true) {
        io.log('  NOTE  this source was not verified to be the pre-fix blob; only a --prefix-commit run is.');
      }
    } catch (err) {
      io.error(`  FAIL  the pre-fix source could not be probed: ${err.message}`);
      return 1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    io.log('  NOTE  add --prefix-commit <sha> (or --server <path>) to run the same probe against a');
    io.log('        source that should be caught, and prove this probe discriminates.');
  }

  if (!report.ok) {
    io.error(`  FAIL  ${report.results.filter((result) => !result.ok).length} of ${report.results.length} check(s) failed on this tree.`);
    return 1;
  }
  if (prefixReport && !judgeDiscrimination(prefixReport).ok) {
    io.error('  FAIL  the probe passed on both sources, so it proves nothing.');
    return 1;
  }
  io.log(`  OK    ${report.results.length} check(s) passed.`);
  io.log('  NOTE  HTTP layer only: this proves what server.js returns, not how a browser renders the pill.');
  return 0;
}

/**
 * Stand-in for the pre-fix server.js, written by writeLegacyStandIn() when the pre-fix
 * blob is not available in this checkout. It reproduces the old response shape
 * (`keyMasked: <first 5>...<last 4>`) for GET /api/health, GET /api/config and
 * POST /api/config so the discrimination test always has a source it must fail on. It is
 * NOT the real pre-fix file; the git-blob run is the authoritative evidence.
 */
export const LEGACY_STANDIN_SOURCE = `import http from 'node:http';

function config() {
  const key = String(process.env.DEEPSEEK_API_KEY || '').trim();
  return {
    configured: Boolean(key),
    keyMasked: key ? key.slice(0, 5) + '...' + key.slice(-4) : '',
    model: String(process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim() || 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    examDate: String(process.env.EXAM_DATE || '').trim(),
  };
}

export function createServer() {
  return http.createServer((req, res) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/api/health' && req.method === 'GET') return send(200, Object.assign({ ok: true, node: process.version }, config()));
    if (pathname === '/api/config' && req.method === 'GET') return send(200, config());
    if (pathname === '/api/config' && req.method === 'POST') return send(200, Object.assign(config(), { saved: [] }));
    return send(404, { ok: false });
  });
}
`;

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
