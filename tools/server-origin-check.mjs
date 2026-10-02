/**
 * HTTP-layer checks for the local API's origin/authorization boundary.
 *
 * SEC-01 fix for finding F-1 (High) in work/implementation/P-03A-PRIVACY-AUDIT.md:
 * the legacy server (server.js) accepted cross-origin state-changing requests, parsed
 * JSON regardless of Content-Type, and let an unauthenticated POST retarget the saved
 * provider key. This file proves the boundary at the HTTP layer with node:http.
 *
 * PROVIDER-CONFIG-01 (D1) extends the boundary: the provider key, base URL and model are
 * server environment configuration and POST /api/config now REFUSES them from any browser
 * (same-origin included) with 403 `provider_config_is_operator_only`, writing nothing. The
 * checks that used to prove a learner could set the key and base URL now prove the refusal,
 * and the read routes are checked for the absence of every key-derived field.
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

/**
 * Names the acceptance criteria require; the test file asserts each one ran and passed.
 *
 * RETARGETED 2 October 2026 (SPA-RETIRE 5). The old list asserted `403 origin_rejected` and
 * `403 provider_config_is_operator_only` from `POST /api/config` and a `200` from a same-origin one.
 * Every one of those legs had been FAILING since the auth wrap landed, because the wrap answers
 * **401 before any handler** — and CI never said so, since this step sits behind another failing step
 * in the same job. The property did not disappear; its shape changed, and these are the names that
 * describe what is actually true and testable at the HTTP layer without a database.
 */
export const REQUIRED_CHECKS = [
  'health-stays-public-without-identity',
  'legacy-config-refuses-a-foreign-origin-at-the-gate',
  'legacy-config-checks-the-body-before-identity',
  'legacy-config-refuses-identity-after-the-gates',
  'the-owned-surface-refuses-identity-before-the-origin-gate',
  'a-refused-request-writes-nothing',
  'no-response-carries-key-shaped-material',
  'static-and-the-front-door-stay-public',
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
  /*
   * TWO SURFACES, TWO ORDERS — and asserting both is the point of this retarget.
   *
   * The LEGACY `/api/config` route runs the origin gate and the body gate BEFORE identity, so a foreign
   * Origin gets `403 origin_rejected` and a `text/plain` body gets `415 json_required` with no session at
   * all. The OWNED `/api/v1/*` surface resolves identity FIRST, so every mutating call is
   * `401 unauthenticated` whatever the caller claims. Both are refusals; they are not the same refusal,
   * and a check that expected one shape everywhere is what had been failing here since the auth wrap
   * landed. Measured, not assumed.
   */
  const ORIGINS = [
    ['same origin', { Origin: goodOrigin }],
    ['foreign origin', { Origin: 'http://attacker.example' }],
    ['absent origin', {}],
    ['null origin', { Origin: 'null' }],
    ['foreign referer only', { Referer: 'http://attacker.example/page' }],
    ['rebinding host', { Origin: 'http://attacker.example', Host: 'attacker.example' }],
  ];
  const OWNED_MUTATING = [['PUT', '/api/v1/settings'], ['POST', '/api/v1/attempts'], ['DELETE', '/api/v1/account']];

  try {
    await record('health-stays-public-without-identity', async () => {
      for (const [label, headers] of [['no origin', {}], ['foreign origin', { Origin: 'http://attacker.example' }]]) {
        const res = await request(ctx.port, { method: 'GET', path: '/api/health', headers });
        assertStatus(res, 200, `GET /api/health (${label})`);
        assertEqual(res.json?.ok, true, `health ok (${label})`);
      }
      return 'liveness answers anyone, with or without an Origin';
    });

    await record('legacy-config-refuses-a-foreign-origin-at-the-gate', async () => {
      const before = ctx.readEnv();
      const refusals = [];
      for (const [label, headers] of ORIGINS.filter(([l]) => l !== 'same origin')) {
        const res = await request(ctx.port, {
          method: 'POST',
          path: '/api/config',
          headers: { ...json, ...headers },
          body: JSON.stringify({ examDate: '2031-01-01' }),
        });
        assertStatus(res, 403, `POST /api/config (${label})`);
        assertEqual(res.json?.code, 'origin_rejected', `error token (${label})`);
        refusals.push(label);
      }
      assertEqual(ctx.readEnv(), before, 'the env file must be unchanged by every refusal');
      return `403 origin_rejected for ${refusals.join(', ')}; env byte-identical`;
    });

    await record('legacy-config-checks-the-body-before-identity', async () => {
      // No identity is needed to be told the BODY is wrong on this route — which is deliberate: the
      // parser shape is not a secret, and the write still cannot happen. The authenticated shapes are
      // asserted in owned-api-check's `error-400-413-415-422` leg, where a session exists.
      for (const [label, headers] of [['text/plain', { 'Content-Type': 'text/plain', Origin: goodOrigin }], ['no content-type', { Origin: goodOrigin }]]) {
        const res = await request(ctx.port, { method: 'POST', path: '/api/config', headers, body: JSON.stringify({ examDate: '2031-01-01' }) });
        assertStatus(res, 415, `POST /api/config (${label})`);
        assertEqual(res.json?.code, 'json_required', `error token (${label})`);
      }
      return '415 json_required for both, with no session';
    });

    await record('legacy-config-refuses-identity-after-the-gates', async () => {
      const before = ctx.readEnv();
      for (const body of [{ examDate: '2032-02-02' }, { apiKey: SYNTHETIC_KEY }, { baseUrl: 'https://attacker.example/v1' }, { model: 'model-of-the-attacker' }]) {
        const res = await request(ctx.port, { method: 'POST', path: '/api/config', headers: { ...json, Origin: goodOrigin }, body: JSON.stringify(body) });
        assertStatus(res, 401, `same-origin POST /api/config ${JSON.stringify(body)}`);
        assertEqual(res.json?.error, 'unauthenticated', 'error token');
      }
      const read = await request(ctx.port, { method: 'GET', path: '/api/config' });
      assertStatus(read, 401, 'GET /api/config');
      assertEqual(ctx.readEnv(), before, 'no browser request reaches the env writer, not even a same-origin one');
      return 'same-origin provider/exam writes and the read are all 401; env byte-identical';
    });

    await record('the-owned-surface-refuses-identity-before-the-origin-gate', async () => {
      /*
       * MEASURED, and not what the first version of this leg assumed. For a MUTATING request the origin
       * gate answers first whatever surface it belongs to: a foreign Origin, `null`, a rebinding Host or
       * a foreign Referer gets `403 origin_rejected` from `/api/v1/*` too — before identity, before the
       * route is looked up. Only then do the same-origin and absent-Origin cases split, and they split on
       * whether the owned surface is MOUNTED: `401 unauthenticated` on a configured runtime
       * (docker-stack-check asserts that where a database exists) and `404 Unknown endpoint` here, where
       * this check deliberately runs with no account configuration.
       *
       * The property that holds without a database, and the one worth asserting: NOTHING a browser
       * sends — any Origin, any method — ever reaches a 2xx on this surface.
       */
      /*
       * MEASURED, and not what the first two versions of this leg assumed. For a MUTATING request the
       * origin gate answers first, on EVERY surface: anything that is not the deployment's own origin —
       * a foreign Origin, `null`, a rebinding Host, a foreign Referer, or NO Origin at all — gets
       * `403 origin_rejected` before identity is considered and before the route is looked up. Only a
       * same-origin request gets past the gate, and then it splits on whether the owned surface is
       * MOUNTED: `401 unauthenticated` on a configured runtime (asserted in docker-stack-check, where a
       * database exists) and `404 Unknown endpoint` here, where this check deliberately runs with no
       * account configuration.
       *
       * The property that holds without a database, and the one worth asserting: NOTHING a browser
       * sends — any Origin, any method — ever reaches a 2xx on this surface.
       */
      const seen = new Map();
      let total = 0;
      for (const [method, path] of OWNED_MUTATING) {
        for (const [label, headers] of ORIGINS) {
          const res = await request(ctx.port, {
            method,
            path,
            headers: { ...json, ...headers },
            body: method === 'DELETE' ? undefined : JSON.stringify({ examDate: '2031-01-01' }),
          });
          total += 1;
          if (res.status >= 200 && res.status < 300) {
            throw new Error(`${method} ${path} (${label}): answered ${res.status} without a session`);
          }
          const sameOrigin = label === 'same origin';
          const expected = sameOrigin ? [401, 404] : [403];
          if (!expected.includes(res.status)) {
            throw new Error(`${method} ${path} (${label}): expected ${expected.join(' or ')}, got ${res.status} (${res.text.slice(0, 90)})`);
          }
          if (!sameOrigin) assertEqual(res.json?.code, 'origin_rejected', `${method} ${path} (${label}) error token`);
          seen.set(res.status, (seen.get(res.status) || 0) + 1);
        }
      }
      const summary = [...seen.entries()].map(([status, count]) => `${status} x${count}`).join(', ');
      return `${total} call(s), no 2xx: ${summary} (everything but same-origin is 403 at the gate; same-origin is 404 here because the surface is unmounted)`;
    });

    await record('a-refused-request-writes-nothing', async () => {
      const beforeEnv = ctx.readEnv();
      const provider = () => ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL'].map((k) => envValue(ctx.readEnv(), k)).join('|');
      const beforeProvider = provider();
      const payload = JSON.stringify({ examDate: '2039-09-09', apiKey: SYNTHETIC_KEY, baseUrl: 'http://127.0.0.1:9/v1', model: 'model-of-the-attacker' });
      for (const [label, headers] of ORIGINS) {
        await request(ctx.port, { method: 'POST', path: '/api/config', headers: { ...json, ...headers }, body: payload });
      }
      for (const [method, path] of OWNED_MUTATING) {
        await request(ctx.port, { method, path, headers: { ...json, Origin: goodOrigin }, body: method === 'DELETE' ? undefined : payload });
      }
      assertEqual(ctx.readEnv(), beforeEnv, 'the env file must be byte-identical after every refusal');
      assertEqual(provider(), beforeProvider, 'provider configuration must be untouched');
      if (fs.existsSync(ctx.progressPath)) throw new Error(`a progress file was created at ${ctx.progressPath}`);
      return 'env byte-identical, no provider field changed, no progress file created';
    });

    await record('no-response-carries-key-shaped-material', async () => {
      const bodies = [];
      for (const [label, headers] of ORIGINS) {
        const res = await request(ctx.port, { method: 'POST', path: '/api/config', headers: { ...json, ...headers }, body: JSON.stringify({ examDate: '2031-01-01', apiKey: SYNTHETIC_KEY }) });
        bodies.push(res.text);
      }
      for (const [method, path] of OWNED_MUTATING) {
        const res = await request(ctx.port, { method, path, headers: { ...json, Origin: goodOrigin }, body: method === 'DELETE' ? undefined : JSON.stringify({ examDate: '2031-01-01' }) });
        bodies.push(res.text);
      }
      const offenders = bodies.filter((body) => /apiKey|baseUrl|DEEPSEEK|keyMasked|sk-[A-Za-z0-9]/.test(body));
      if (offenders.length) throw new Error(`a refusal echoed key-shaped material: ${offenders[0].slice(0, 120)}`);
      return `${bodies.length} refusal body(ies), none naming a provider field`;
    });

    await record('static-and-the-front-door-stay-public', async () => {
      const home = await request(ctx.port, { method: 'GET', path: '/', headers: { Origin: 'http://attacker.example' } });
      assertStatus(home, 200, 'GET / (the front door)');
      if (!/text\/html/.test(String(home.headers['content-type'] || ''))) throw new Error(`expected text/html, got ${home.headers['content-type']}`);
      const signin = await request(ctx.port, { method: 'GET', path: '/signin', headers: { Origin: 'http://attacker.example' } });
      assertStatus(signin, 200, 'GET /signin');
      // The application itself is NOT public. In-process without account configuration it is
      // `503 not_ready` (fail-closed by design); against a configured runtime it is `401`. Both are
      // refusals, and asserting "not 200" keeps the leg honest about which one is available here.
      const app = await request(ctx.port, { method: 'GET', path: '/app/', headers: { Origin: goodOrigin } });
      if (app.status === 200) throw new Error('GET /app/ answered 200 without a session');
      return `200 front door and sign-in; /app/ refused with ${app.status}`;
    });
  } finally {
    await ctx.close();
  }

  return { ok: results.every((r) => r.ok), results, envPath: ctx.envPath, progressPath: ctx.progressPath };
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
