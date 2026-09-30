/**
 * HTTP-layer checks for the local API's origin/authorization boundary.
 *
 * SEC-01 fix for finding F-1 (High) in work/implementation/P-03A-PRIVACY-AUDIT.md:
 * the legacy server (server.js) accepted cross-origin state-changing requests, parsed
 * JSON regardless of Content-Type, and let an unauthenticated POST retarget the saved
 * provider key. This file proves the boundary at the HTTP layer with node:http.
 *
 * Scope and honesty:
 *   * HTTP layer only. No browser is started, so this does NOT prove what any specific
 *     browser sends or blocks. It proves the server's own decision for each request.
 *   * Offline. No provider, no AI, no database.
 *
 * Safety:
 *   * The server is started in-process on an ephemeral loopback port.
 *   * B1PREP_ENV_FILE and B1PREP_PROGRESS_FILE point into a throwaway temp directory, so
 *     no repository `.env` and no learner record is read or written.
 *   * Every credential-shaped value is synthetic and obviously not a real key.
 *
 * Usage: node tools/server-origin-check.mjs
 * Exit code 0 when every check passes, 1 otherwise.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Synthetic, and deliberately not `sk-` shaped so the repository secret scan stays quiet. */
export const SYNTHETIC_KEY = 'origin-check-synthetic-value-not-a-real-key';
export const HTTPS_BASE = 'https://api.deepseek.com';
export const LOOPBACK_HTTP_BASE = 'http://127.0.0.1:9/v1';

/** Names the acceptance criteria require; the test file asserts each one ran and passed. */
export const REQUIRED_CHECKS = [
  'post-foreign-origin-rejected-without-env-write',
  'post-absent-origin-rejected',
  'post-null-origin-rejected',
  'post-text-plain-rejected',
  'post-same-origin-json-accepted',
  'baseurl-http-nonloopback-rejected',
  'baseurl-https-accepted',
  'get-foreign-origin-still-works',
];

function assertStatus(res, expected, label) {
  if (res.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${res.status} (${res.text.slice(0, 120)})`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
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
 * Start server.js in-process on an ephemeral port with a throwaway .env/progress file.
 * The env vars must be set before server.js is imported, because it resolves those
 * paths at module load, hence the dynamic import.
 */
export async function startCheckServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-origin-'));
  const envPath = path.join(dir, '.env');
  const progressPath = path.join(dir, 'progress.json');
  process.env.B1PREP_FORCE_OFFLINE = '1';
  process.env.B1PREP_ENV_FILE = envPath;
  process.env.B1PREP_PROGRESS_FILE = progressPath;

  const { createServer } = await import('../server.js');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    envPath,
    progressPath,
    readEnv: () => (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Run every boundary check against one in-process server.
 * @returns {Promise<{ok: boolean, results: Array<{name: string, ok: boolean, detail: string}>, envPath: string}>}
 */
export async function runOriginChecks() {
  const ctx = await startCheckServer();
  const results = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  const json = { 'Content-Type': 'application/json' };
  const goodOrigin = ctx.baseUrl;

  try {
    await record('post-foreign-origin-rejected-without-env-write', async () => {
      const before = ctx.readEnv();
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: 'http://attacker.example' },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 403, 'foreign Origin');
      assertEqual(res.json?.code, 'origin_rejected', 'error token');
      assertEqual(ctx.readEnv(), before, 'env file must be unchanged');
      return `403 ${res.json?.code}`;
    });

    await record('post-absent-origin-rejected', async () => {
      const before = ctx.readEnv();
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 403, 'absent Origin');
      assertEqual(res.json?.code, 'origin_rejected', 'error token');
      assertEqual(ctx.readEnv(), before, 'env file must be unchanged');
      return `403 ${res.json?.code}`;
    });

    await record('post-null-origin-rejected', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: 'null' },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 403, 'null Origin');
      assertEqual(res.json?.code, 'origin_rejected', 'error token');
      return `403 ${res.json?.code}`;
    });

    await record('post-foreign-referer-rejected', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Referer: 'http://attacker.example/page' },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 403, 'foreign Referer');
      assertEqual(res.json?.code, 'origin_rejected', 'error token');
      return `403 ${res.json?.code}`;
    });

    await record('post-text-plain-rejected', async () => {
      const before = ctx.readEnv();
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { 'Content-Type': 'text/plain', Origin: goodOrigin },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 415, 'text/plain body');
      assertEqual(res.json?.code, 'json_required', 'error token');
      assertEqual(ctx.readEnv(), before, 'env file must be unchanged');
      return `415 ${res.json?.code}`;
    });

    await record('post-missing-content-type-rejected', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { Origin: goodOrigin },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 415, 'no Content-Type');
      assertEqual(res.json?.code, 'json_required', 'error token');
      return `415 ${res.json?.code}`;
    });

    await record('post-same-origin-json-accepted', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: goodOrigin },
        body: JSON.stringify({ apiKey: SYNTHETIC_KEY }),
      });
      assertStatus(res, 200, 'same-origin JSON');
      // B1PREP_FORCE_OFFLINE keeps `configured` false in this suite by design; the proof
      // we want is that the write landed in the (throwaway) env file.
      if (!Array.isArray(res.json?.saved) || !res.json.saved.includes('DEEPSEEK_API_KEY')) {
        throw new Error(`saved list must name the key, got ${JSON.stringify(res.json?.saved)}`);
      }
      const after = ctx.readEnv();
      assertEqual(envValue(after, 'DEEPSEEK_API_KEY'), SYNTHETIC_KEY, 'synthetic key persisted');
      return '200 saved';
    });

    await record('post-loopback-referer-accepted', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Referer: `${goodOrigin}/settings` },
        body: JSON.stringify({ examDate: '2032-02-02' }),
      });
      assertStatus(res, 200, 'loopback Referer, no Origin');
      assertEqual(envValue(ctx.readEnv(), 'EXAM_DATE'), '2032-02-02', 'exam date persisted');
      return '200 saved';
    });

    await record('host-header-rebinding-rejected', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: 'http://attacker.example', Host: 'attacker.example' },
        body: JSON.stringify({ examDate: '2031-01-01' }),
      });
      assertStatus(res, 403, 'rebinding Host');
      assertEqual(res.json?.code, 'origin_rejected', 'error token');
      return `403 ${res.json?.code}`;
    });

    await record('baseurl-http-nonloopback-rejected', async () => {
      const before = envValue(ctx.readEnv(), 'DEEPSEEK_BASE_URL');
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: goodOrigin },
        body: JSON.stringify({ baseUrl: 'http://attacker.example/v1' }),
      });
      assertStatus(res, 400, 'non-loopback http baseUrl');
      assertEqual(res.json?.code, 'invalid_base_url', 'error token');
      assertEqual(envValue(ctx.readEnv(), 'DEEPSEEK_BASE_URL'), before, 'env baseUrl must be unchanged');
      return `400 ${res.json?.code}`;
    });

    await record('baseurl-non-http-scheme-rejected', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: goodOrigin },
        body: JSON.stringify({ baseUrl: 'file:///etc/passwd' }),
      });
      assertStatus(res, 400, 'file:// baseUrl');
      assertEqual(res.json?.code, 'invalid_base_url', 'error token');
      return `400 ${res.json?.code}`;
    });

    await record('baseurl-https-accepted', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: goodOrigin },
        body: JSON.stringify({ baseUrl: `${HTTPS_BASE}/` }),
      });
      assertStatus(res, 200, 'https baseUrl');
      assertEqual(envValue(ctx.readEnv(), 'DEEPSEEK_BASE_URL'), HTTPS_BASE, 'https baseUrl persisted (trailing slash trimmed)');
      return '200 saved';
    });

    await record('baseurl-http-loopback-accepted', async () => {
      const res = await request(ctx.port, {
        method: 'POST',
        path: '/api/config',
        headers: { ...json, Origin: goodOrigin },
        body: JSON.stringify({ baseUrl: LOOPBACK_HTTP_BASE }),
      });
      assertStatus(res, 200, 'loopback http baseUrl');
      assertEqual(envValue(ctx.readEnv(), 'DEEPSEEK_BASE_URL'), LOOPBACK_HTTP_BASE, 'loopback baseUrl persisted');
      return '200 saved';
    });

    await record('get-foreign-origin-still-works', async () => {
      const res = await request(ctx.port, {
        method: 'GET',
        path: '/api/health',
        headers: { Origin: 'http://attacker.example' },
      });
      assertStatus(res, 200, 'GET /api/health with foreign Origin');
      assertEqual(res.json?.ok, true, 'health ok');
      return '200 read path unaffected';
    });

    await record('get-no-origin-still-works', async () => {
      const res = await request(ctx.port, { method: 'GET', path: '/api/config' });
      assertStatus(res, 200, 'GET /api/config without Origin');
      return '200';
    });

    await record('static-asset-get-still-works', async () => {
      const res = await request(ctx.port, { method: 'GET', path: '/index.html', headers: { Origin: 'http://attacker.example' } });
      assertStatus(res, 200, 'GET /index.html');
      if (!/text\/html/.test(String(res.headers['content-type'] || ''))) {
        throw new Error(`expected text/html, got ${res.headers['content-type']}`);
      }
      return '200 static';
    });
  } finally {
    await ctx.close();
  }

  return { ok: results.every((r) => r.ok), results, envPath: ctx.envPath };
}

/* -------------------------------------------------------------------- CLI */
export async function runCli(io = console) {
  const report = await runOriginChecks();
  io.log('server-origin-check: HTTP-layer origin/authorization boundary (SEC-01, finding F-1)');
  io.log(`  env file used by the suite: ${report.envPath} (throwaway; repository .env never touched)`);
  for (const r of report.results) io.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.detail}]`);
  if (report.ok) {
    io.log(`  OK    ${report.results.length} check(s) passed.`);
    io.log('  NOTE  HTTP layer only: this proves the server\'s decision, not any browser\'s behaviour.');
    return 0;
  }
  io.error(`  FAIL  ${report.results.filter((r) => !r.ok).length} of ${report.results.length} check(s) failed.`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(await runCli());
}
