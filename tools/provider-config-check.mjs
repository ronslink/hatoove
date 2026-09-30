/**
 * Focused offline checks for PROVIDER-CONFIG-01 D1: the AI provider is operator-only and
 * invisible to the learner.
 *
 * Why a separate file: keymask-check.mjs proves that no route discloses characters of the
 * key, and server-origin-check.mjs proves the origin/authorization boundary. Neither proves
 * D1 itself - that the browser can no longer SET the provider at all and that no route
 * reports the key's presence. This file does, at three layers:
 *
 *   1. HTTP: POST /api/config REFUSES `apiKey`, `baseUrl` and `model` from a same-origin
 *      browser with 403 `provider_config_is_operator_only` and writes nothing; the learner's
 *      own `examDate` still saves.
 *   2. HTTP: GET /api/health carries only a liveness payload (`ok`, `node`) and GET
 *      /api/config only the learner's `examDate`. `configured`, `model`, `baseUrl` and
 *      `keyMasked` must not appear under any spelling.
 *   3. Source: the Settings view offers no provider field, and `public/js/ai.js` exposes no
 *      provider-writing path (`saveConfig`, `testKey`).
 *
 * The AI call path itself (`POST /api/ai`) must survive: it is checked to still answer as
 * an API (not a 404) with no key, without contacting any provider.
 *
 * Discrimination: `--server <path>` runs the same refusal checks against another server.js
 * copy, so a source that re-accepts a base URL is shown to fail here. Only synthetic key
 * material and a throwaway B1PREP_ENV_FILE are used; the checkout's own .env is never
 * opened, and no provider is called.
 *
 * Usage: node tools/provider-config-check.mjs [--server <path-to-server.js>]
 * Exit code 0 when every check passes on this tree, 1 otherwise.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'provider-config-synthetic-value-not-a-real-key';
export const EXAM_DATE = '2035-05-05';
export const POSTED_EXAM_DATE = '2036-06-06';
/** The refused provider fields, in the order the route reports them. */
export const PROVIDER_FIELDS = ['apiKey', 'baseUrl', 'model'];
export const REFUSAL_CODE = 'provider_config_is_operator_only';
export const ALLOWED_CONFIG_FIELDS = ['examDate'];
export const ALLOWED_HEALTH_FIELDS = ['node', 'ok'];

/** Names the acceptance criteria require; the tests assert each one ran and passed. */
export const REQUIRED_CHECKS = [
  'post-refuses-an-api-key',
  'post-refuses-a-base-url',
  'post-refuses-a-model',
  'refusal-writes-nothing-even-with-a-learner-field',
  'post-still-saves-the-learners-exam-date',
  'health-reports-liveness-only',
  'config-reports-no-provider-field',
  'ai-route-still-answers-as-an-api',
  'settings-view-offers-no-provider-field',
  'ai-module-exposes-no-provider-writer',
];
/** The refusal checks a source that still accepts the provider must fail. */
export const REFUSAL_CHECKS = ['post-refuses-an-api-key', 'post-refuses-a-base-url', 'post-refuses-a-model'];

function assertStatus(res, expected, label) {
  if (res.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${res.status} (${res.text.slice(0, 160)})`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertListEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function envValue(text, key) {
  if (!text) return undefined;
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return match ? match[1] : undefined;
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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Start a server.js in-process on an ephemeral loopback port with a throwaway env file.
 * B1PREP_ENV_FILE is read at module load, so it is set before the dynamic import. The
 * provider base URL is pointed at an unreachable loopback port so that even an accidental
 * AI call cannot leave the machine, and B1PREP_FORCE_OFFLINE keeps the run keyless.
 */
export async function startProbeServer({ root = DEFAULT_ROOT, serverPath = null, label = 'tree' } = {}) {
  const resolvedRoot = path.resolve(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-provider-config-'));
  const envPath = path.join(dir, '.env');
  const progressPath = path.join(dir, 'progress.json');
  fs.writeFileSync(envPath, `EXAM_DATE=${EXAM_DATE}\n`, 'utf8');

  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_BASE_URL;
  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ENV_FILE = envPath;
  process.env.B1PREP_PROGRESS_FILE = progressPath;
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/v1';

  const modulePath = serverPath ? path.resolve(serverPath) : path.join(resolvedRoot, 'server.js');
  const { createServer } = await import(pathToFileURL(modulePath).href);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

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
 * A scratch copy of this tree's server.js with one removed behaviour re-introduced (the
 * POST /api/config provider write), materialised outside the repository so the refusal
 * checks can be shown to fail there.
 */
export function materializePreFixServer(targetDir, { commit = null, root = DEFAULT_ROOT } = {}) {
  let blob;
  let source;
  if (commit) {
    blob = execFileSync('git', ['-C', path.resolve(root), 'show', `${commit}:server.js`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    source = `git blob ${commit}:server.js`;
  } else {
    const current = fs.readFileSync(path.join(path.resolve(root), 'server.js'), 'utf8');
    // Re-introduce the removed behaviour: accept baseUrl/model/apiKey from the browser again.
    const marker = "    const keys = body && typeof body === 'object' && !Array.isArray(body) ? body : {};";
    if (!current.includes(marker)) throw new Error('server.js no longer matches the D1 shape; cannot build the scratch source');
    const scratch = current
      .replace(marker, '    const keys = {};')
      .replace(
        '    const updates = {};\n    if (typeof keys.examDate === \'string\') updates.EXAM_DATE = keys.examDate.trim();',
        '    const updates = {};\n    if (typeof body.apiKey === \'string\') updates.DEEPSEEK_API_KEY = body.apiKey.trim();\n    if (typeof body.model === \'string\' && body.model.trim()) updates.DEEPSEEK_MODEL = body.model.trim();\n    if (typeof body.baseUrl === \'string\' && body.baseUrl.trim()) updates.DEEPSEEK_BASE_URL = body.baseUrl.trim();\n    if (typeof body.examDate === \'string\') updates.EXAM_DATE = body.examDate.trim();'
      );
    if (scratch === current) throw new Error('the scratch rewrite changed nothing; refusing to use it');
    blob = scratch;
    source = 'scratch copy with the provider write re-introduced';
  }
  fs.mkdirSync(path.join(targetDir, 'public/js'), { recursive: true });
  fs.copyFileSync(
    path.join(path.resolve(root), 'public/js/progress-merge.js'),
    path.join(targetDir, 'public/js/progress-merge.js')
  );
  const file = path.join(targetDir, 'server.js');
  fs.writeFileSync(file, blob, 'utf8');
  return { file, source };
}

/** Discriminates a run against a source that should be caught by the refusal checks. */
export function judgeDiscrimination(report) {
  const byName = new Map(report.results.map((result) => [result.name, result]));
  const failed = REFUSAL_CHECKS.filter((name) => byName.has(name) && !byName.get(name).ok);
  const missing = REFUSAL_CHECKS.filter((name) => !byName.has(name));
  const ok = missing.length === 0 && failed.length > 0;
  const message = ok
    ? `${report.label} fails ${failed.length}/${REFUSAL_CHECKS.length} refusal check(s): ${failed.join(', ')}`
    : `${report.label} did NOT discriminate: failed refusal checks = ${failed.join(', ') || 'none'}` +
      `${missing.length ? `; missing checks = ${missing.join(', ')}` : ''}`;
  return { ok, failed, message };
}

/** Static checks read the tree, never the scratch source. */
function readTreeFile(relative) {
  return fs.readFileSync(path.join(DEFAULT_ROOT, relative), 'utf8');
}

export async function runProviderConfigChecks({ root = DEFAULT_ROOT, serverPath = null, label = null } = {}) {
  const target = label || serverPath || 'tree';
  const ctx = await startProbeServer({ root, serverPath, label: target });
  const results = [];
  const record = (name, fn) => {
    const run = async () => {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    };
    return run().catch((err) => {
      results.push({ name, ok: false, detail: err.message });
    });
  };

  const repositoryEnvPath = path.join(ctx.root, '.env');
  const repositoryEnvBefore = fs.existsSync(repositoryEnvPath) ? fs.statSync(repositoryEnvPath).size : null;

  try {
    await record('post-refuses-an-api-key', async () => {
      const before = ctx.readEnv();
      const res = await ctx.postConfig({ apiKey: SYNTHETIC_KEY });
      assertStatus(res, 403, 'same-origin apiKey');
      assertEqual(res.json?.code, REFUSAL_CODE, 'error token');
      assertEqual(ctx.readEnv(), before, 'env file must be unchanged');
      return `403 ${res.json?.code}`;
    });

    await record('post-refuses-a-base-url', async () => {
      const before = ctx.readEnv();
      const res = await ctx.postConfig({ baseUrl: 'https://attacker.example/v1' });
      assertStatus(res, 403, 'same-origin baseUrl');
      assertEqual(res.json?.code, REFUSAL_CODE, 'error token');
      assertEqual(envValue(ctx.readEnv(), 'DEEPSEEK_BASE_URL'), envValue(before, 'DEEPSEEK_BASE_URL'), 'baseUrl untouched');
      return `403 ${res.json?.code}`;
    });

    await record('post-refuses-a-model', async () => {
      const before = ctx.readEnv();
      const res = await ctx.postConfig({ model: 'model-of-the-attacker' });
      assertStatus(res, 403, 'same-origin model');
      assertEqual(res.json?.code, REFUSAL_CODE, 'error token');
      assertListEqual(res.json?.refused, ['model'], 'refused list names the field');
      assertEqual(envValue(ctx.readEnv(), 'DEEPSEEK_MODEL'), envValue(before, 'DEEPSEEK_MODEL'), 'model untouched');
      return `403 ${res.json?.code}`;
    });

    await record('refusal-writes-nothing-even-with-a-learner-field', async () => {
      const before = ctx.readEnv();
      const res = await ctx.postConfig({ apiKey: SYNTHETIC_KEY, baseUrl: 'http://127.0.0.1:9/v1', model: 'x', examDate: POSTED_EXAM_DATE });
      assertStatus(res, 403, 'all provider fields at once');
      assertListEqual(res.json?.refused, PROVIDER_FIELDS, 'refused list names every provider field');
      assertEqual(ctx.readEnv(), before, 'a refused request writes nothing, not even the exam date it also carried');
      return '403, env byte-identical';
    });

    await record('post-still-saves-the-learners-exam-date', async () => {
      const res = await ctx.postConfig({ examDate: POSTED_EXAM_DATE });
      assertStatus(res, 200, 'examDate');
      assertEqual(envValue(ctx.readEnv(), 'EXAM_DATE'), POSTED_EXAM_DATE, 'exam date persisted to the throwaway env file');
      assertListEqual(Object.keys(res.json || {}).sort(), ['examDate', 'ok', 'saved'], 'reply shape');
      assertListEqual(res.json?.saved, ['EXAM_DATE'], 'saved list');
      assertEqual(res.json?.examDate, POSTED_EXAM_DATE, 'reply examDate');
      return `200 saved ${res.json?.saved}`;
    });

    await record('health-reports-liveness-only', async () => {
      const res = await ctx.get('/api/health');
      assertStatus(res, 200, 'GET /api/health');
      assertListEqual(Object.keys(res.json || {}).sort(), ALLOWED_HEALTH_FIELDS, '/api/health field set');
      assertEqual(res.json?.ok, true, '/api/health ok');
      return `fields [${ALLOWED_HEALTH_FIELDS.join(', ')}]`;
    });

    await record('config-reports-no-provider-field', async () => {
      const res = await ctx.get('/api/config');
      assertStatus(res, 200, 'GET /api/config');
      assertListEqual(Object.keys(res.json || {}).sort(), ALLOWED_CONFIG_FIELDS, '/api/config field set');
      for (const field of ['configured', 'model', 'baseUrl', 'keyMasked']) {
        if (Object.hasOwn(res.json || {}, field)) throw new Error(`/api/config reports ${field}`);
      }
      return `fields [${ALLOWED_CONFIG_FIELDS.join(', ')}]`;
    });

    await record('ai-route-still-answers-as-an-api', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/ai',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${ctx.port}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (res.status === 404) throw new Error('POST /api/ai answers 404; the AI call path must survive D1');
      if (res.status !== 400) throw new Error(`POST /api/ai with no key: expected 400, got ${res.status} (${res.text.slice(0, 120)})`);
      assertEqual(res.json?.code, 'NO_KEY', 'offline error token');
      return `400 ${res.json?.code} (route present, no provider contacted)`;
    });

    if (!serverPath) {
      await record('settings-view-offers-no-provider-field', () => {
        const ui = readTreeFile('public/js/ui.js');
        const forbidden = [
          ['an API-key input', /id="api-key"/],
          ['a model chooser', /id="model"/],
          ['a provider save button', /data-save-key/],
          ['a "test key" button', /data-test-key/],
          ['a "remove key" button', /data-clear-key/],
          ['a "DeepSeek-Schlüssel" card', /DeepSeek-Schlüssel/],
          ['a configured/model status pill', /cfg\.configured/],
        ];
        const found = forbidden.filter(([, re]) => re.test(ui)).map(([what]) => what);
        if (found.length) throw new Error(`the Settings view still offers: ${found.join(', ')}`);
        if (!/Prüfung & Lernen/.test(ui)) throw new Error('the learner settings card is gone; this check no longer measures the settings view');
        return 'no key input, no base-URL input, no model chooser, no test button, no provider card';
      });

      await record('ai-module-exposes-no-provider-writer', () => {
        const ai = readTreeFile('public/js/ai.js');
        for (const name of ['saveConfig', 'testKey']) {
          if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(ai)) {
            throw new Error(`public/js/ai.js still exports ${name}; the provider-setting path must not exist`);
          }
        }
        if (!/saveExamDate/.test(ai)) throw new Error('ai.js lost the learner exam-date path');
        return 'no saveConfig, no testKey; learner exam-date path present';
      });
    }
  } finally {
    await ctx.close();
  }

  const repositoryEnvAfter = fs.existsSync(repositoryEnvPath) ? fs.statSync(repositoryEnvPath).size : null;
  if (repositoryEnvAfter !== repositoryEnvBefore) {
    results.push({ name: 'repository-env-untouched', ok: false, detail: `the checkout .env changed (${repositoryEnvBefore} -> ${repositoryEnvAfter})` });
  } else {
    results.push({ name: 'repository-env-untouched', ok: true, detail: 'no checkout .env before or after the run' });
  }

  return { ok: results.every((result) => result.ok), results, label: ctx.label, root: ctx.root, modulePath: ctx.modulePath, envPath: ctx.envPath };
}

function printRun(report, io) {
  io.log(`  ${report.label} server @ ${report.modulePath}`);
  for (const result of report.results) {
    io.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  [${result.detail}]`);
  }
}

export async function runCli(argv = process.argv.slice(2), io = console) {
  const serverIndex = argv.indexOf('--server');
  const explicitServer = serverIndex === -1 ? null : path.resolve(argv[serverIndex + 1] || '');

  io.log('provider-config-check: the AI provider is operator-only and invisible to the learner (D1)');
  const report = await runProviderConfigChecks({ label: 'tree' });
  io.log(`  env file used by the suite: ${report.envPath} (throwaway; repository .env never touched)`);
  printRun(report, io);

  let scratchReport = null;
  if (explicitServer) {
    if (!fs.existsSync(explicitServer)) throw new Error(`no such file: ${explicitServer}`);
    io.log('');
    io.log(`  BEFORE/AFTER - same checks, source ${explicitServer}`);
    scratchReport = await runProviderConfigChecks({ serverPath: explicitServer, label: 'scratch' });
    printRun(scratchReport, io);
    const verdict = judgeDiscrimination(scratchReport);
    io.log(`  ${verdict.ok ? 'OK   ' : 'FAIL '} discrimination: ${verdict.message}`);
  } else {
    io.log('  NOTE  add --server <path> to run the same checks against a source that re-accepts the');
    io.log('        provider, and prove these checks discriminate.');
  }

  if (!report.ok) {
    io.error(`  FAIL  ${report.results.filter((r) => !r.ok).length} of ${report.results.length} check(s) failed on this tree.`);
    return 1;
  }
  if (scratchReport && !judgeDiscrimination(scratchReport).ok) {
    io.error('  FAIL  the checks passed on both sources, so they prove nothing.');
    return 1;
  }
  io.log(`  OK    ${report.results.length} check(s) passed.`);
  io.log('  NOTE  HTTP + source only: this proves the server\'s routes and the view source, not a rendered page.');
  io.log('        Rendered evidence lives in tools/provider-config-browser-check.mjs.');
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
