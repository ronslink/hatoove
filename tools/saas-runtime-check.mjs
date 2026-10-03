/**
 * SAAS-RUNTIME-01 — the hosted runtime boundary fails closed (issue #63, step A).
 *
 * The independent SaaS review (#63) found the learner app is a hybrid: durable PostgreSQL
 * modules sit beside active single-user paths. This checker proves the three "refuse" moves
 * that must land before anything later in the review's order can be trusted:
 *
 *   A1  the legacy progress routes (`/api/progress`) are unavailable in the hosted runtime, so a
 *       caller-supplied `x-b1prep-account` header - or none at all - cannot read or delete
 *       another account's record, nor the shared unscoped one. SAAS-MODEL-01 Step 2 then makes
 *       the ENTRY POINT fail closed without its account/database configuration, so omitting the
 *       `B1PREP_SAAS` mode flag can no longer start a local single-user app (removal of the
 *       route itself is SAAS-RETIRE-01);
 *   A2  `/api/ai` requires a verified session, ignores the caller's model (the model is the
 *       operator's), bounds the prompt server-side, and `/api/ai/test` needs the operator
 *       opt-in **and** an operator token - a learner session is never sufficient;
 *   A3  the hosted runtime fails closed: a missing database or a failed initialisation leaves
 *       learner routes at 503 with `ready:false`, and a **database interruption at runtime**
 *       is a refusal - never a silent anonymous path, and never a crash of the whole runtime;
 *   A4  the trusted origin is configuration: the deployment's exact public origin is accepted
 *       and a foreign origin is still refused. CONFIG-ANON-01 additionally removes the
 *       machine-global `/api/config` route from this runtime (a 404, like any unknown
 *       endpoint); the old "POST /api/config -> 200" origin-acceptance assertion is superseded
 *       and replaced by an acceptance assertion on a route that still exists.
 *
 * Method: the **real server process** over real HTTP, synthetic accounts, a fully **stubbed
 * provider** (a local HTTP server that records every request body), and a disposable
 * PostgreSQL database. No live AI call, no real credential, no real learner record.
 *
 * Bounded, always: every HTTP request carries a timeout, every check carries a deadline, and
 * a server process is always reaped. If a refusal does not arrive, that is a FAILED CHECK -
 * never a wait. A checker that stalls is worse than one that fails.
 *
 * Safety: requires a disposable database in `OWNAPI_PG_DATABASE` and refuses `postgres`,
 * `template0` and `template1`. Every server it starts uses throwaway `B1PREP_ENV_FILE` /
 * `B1PREP_PROGRESS_FILE` paths under a temp directory, and no check ever inherits a provider
 * key from the environment: without a stub it runs with `B1PREP_FORCE_OFFLINE=1`. The
 * persistent installation's schema is reused, never dropped.
 *
 * Usage:
 *   OWNAPI_PG_DATABASE=<disposable> node tools/saas-runtime-check.mjs
 *   ... node tools/saas-runtime-check.mjs --only=<substring>   # run matching checks
 *   ... node tools/saas-runtime-check.mjs --list               # list check names
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { migrate, persistentConfig } from '../server/owned-postgres/provision.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const DATABASE = process.env.OWNAPI_PG_DATABASE || '';
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-saas-runtime-'));

/** Bounds. A stall must surface as a failure, never as silence. */
const REQUEST_TIMEOUT_MS = 20000;
const CHECK_TIMEOUT_MS = 90000;
const SERVER_READY_DEADLINE_MS = 30000;

/** The deployment's own public origin the hosted runtime is configured for. */
const PUBLIC_ORIGIN = 'https://app.hatoove.example.test';
const PUBLIC_HOST = 'app.hatoove.example.test';
const FOREIGN_ORIGIN = 'https://attacker.example';
/** Synthetic operator model - a forged request must never be able to replace it. */
const OPERATOR_MODEL = 'operator-model-synthetic';
const SYNTHETIC_KEY = 'saas-runtime-check-synthetic-value-not-a-real-key';
/** Synthetic operator token for the `/api/ai/test` diagnostic. Not a real credential. */
const OPERATOR_TEST_TOKEN = 'saas-runtime-check-operator-token-synthetic';

const checks = [];
const check = (name, run) => checks.push({ name, run });

const must = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* ------------------------------------------------------------------ helpers */

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A real HTTP request with full control over Host/Origin (global fetch forbids Host) and a
 * hard timeout: if the server never answers, the request rejects rather than hanging.
 */
function request(port, { method = 'GET', requestPath = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (host) finalHeaders.Host = host;
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    if (payload !== undefined && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    let settled = false;
    const finish = (fn) => (value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', finish(() => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        const setCookie = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json,
          setCookie: Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []),
        });
      }));
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms (${method} ${requestPath})`));
    }, REQUEST_TIMEOUT_MS);
    req.on('error', finish(reject));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Same-origin mutation headers for the configured public origin. */
const publicHeaders = (extra = {}) => ({ Origin: PUBLIC_ORIGIN, Host: PUBLIC_HOST, ...extra });
const jsonHeaders = (extra = {}) => publicHeaders({ 'Content-Type': 'application/json', ...extra });
/** Same-origin mutation headers for a plain local install (loopback on the listening port). */
const localJsonHeaders = (port, extra = {}) =>
  ({ Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...extra });

/** Minimal cookie jar keyed by cookie name. */
function cookieJar() {
  const jar = new Map();
  return {
    absorb(setCookie) {
      for (const line of setCookie) {
        const [pair, ...attrs] = String(line).split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
        else jar.set(name, value);
      }
    },
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    size() { return jar.size; },
  };
}

/* ---------------------------------------------------------- server process */

function baseEnv(port) {
  return {
    ...process.env,
    B1PREP_PORT: String(port),
    B1PREP_ENV_FILE: path.join(TEMP, `env-${port}`),
    B1PREP_PROGRESS_FILE: path.join(TEMP, `progress-${port}.json`),
  };
}

function dbEnv(portOverride) {
  return {
    OWNAPI_PG_HOST: process.env.OWNAPI_PG_HOST || '127.0.0.1',
    OWNAPI_PG_PORT: String(portOverride || process.env.OWNAPI_PG_PORT || 5432),
    OWNAPI_PG_DATABASE: DATABASE,
    OWNAPI_PG_USER: process.env.OWNAPI_PG_USER || 'postgres',
    ...(process.env.OWNAPI_PG_PASSWORD ? { OWNAPI_PG_PASSWORD: process.env.OWNAPI_PG_PASSWORD } : {}),
    ...(process.env.OWNAPI_PG_SCHEMA ? { OWNAPI_PG_SCHEMA: process.env.OWNAPI_PG_SCHEMA } : {}),
    ...(process.env.OWNAPI_PG_ROLE_PREFIX ? { OWNAPI_PG_ROLE_PREFIX: process.env.OWNAPI_PG_ROLE_PREFIX } : {}),
  };
}

/**
 * Start the real `node server.js` with a throwaway env. `options`:
 *   saas          -> B1PREP_SAAS=1
 *   accounts      -> B1PREP_ACCOUNTS=1
 *   database      -> include OWNAPI_PG_* (defaults to the disposable database)
 *   dbPortOverride-> point the database at a proxy port instead
 *   publicOrigin  -> B1PREP_PUBLIC_ORIGIN (defaults to PUBLIC_ORIGIN when saas)
 *   forceOffline  -> B1PREP_FORCE_OFFLINE=1
 *   dropDatabase  -> remove every OWNAPI_PG_* key, even those inherited from the parent env
 *   provider      -> { key, model, baseUrl } injected as DEEPSEEK_*
 *
 * Without an explicit provider stub the child never sees a provider key: the real
 * environment's `DEEPSEEK_API_KEY` is deleted and the server runs offline. No check can
 * accidentally reach a live provider.
 */
async function startServer(port, options = {}) {
  const env = baseEnv(port);
  if (options.dropDatabase) {
    for (const key of Object.keys(env)) if (key.startsWith('OWNAPI_PG_')) delete env[key];
  }
  if (options.saas) env.B1PREP_SAAS = '1';
  if (options.accounts) env.B1PREP_ACCOUNTS = '1';
  if (options.saas) env.B1PREP_PUBLIC_ORIGIN = options.publicOrigin || PUBLIC_ORIGIN;
  if (options.forceOffline) env.B1PREP_FORCE_OFFLINE = '1';
  if (options.aiTest) env.B1PREP_AI_TEST = '1';
  if (options.aiTestToken) env.B1PREP_AI_TEST_TOKEN = options.aiTestToken;
  if (options.database) Object.assign(env, dbEnv(options.dbPortOverride));
  if (options.provider) {
    env.DEEPSEEK_API_KEY = options.provider.key;
    env.DEEPSEEK_MODEL = options.provider.model;
    env.DEEPSEEK_BASE_URL = options.provider.baseUrl;
  } else {
    delete env.DEEPSEEK_API_KEY;
    delete env.DEEPSEEK_BASE_URL;
    if (options.database || options.saas) env.B1PREP_FORCE_OFFLINE = '1';
  }

  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += String(c); });
  child.stderr.on('data', (c) => { out += String(c); });

  const deadline = Date.now() + SERVER_READY_DEADLINE_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${out.slice(-400)}`);
    try {
      const response = await request(port, { requestPath: '/api/health' });
      if (response.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${port}: ${out.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    port,
    env,
    log: () => out,
    /**
     * Reap the child, always. Resolving on a *future* `exit` event alone is what made the
     * first version of this checker hang: when the server crashed under a database
     * interruption it had already exited, so the listener never fired. A process that is
     * already gone resolves immediately, and a live one is escalated SIGTERM -> SIGKILL
     * with a deadline, so shutdown can never become a wait either.
     */
    stop: () => new Promise((resolve) => {
      let done = false;
      let killTimer = null;
      let forceTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      if (child.exitCode !== null || child.signalCode) return finish();
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { finish(); } }, 4000);
      forceTimer = setTimeout(finish, 8000);
      child.once('exit', finish);
      child.once('error', finish);
      try { child.kill(); } catch { finish(); }
    }),
  };
}

/** Wait until /api/ready reports the given readiness (or the deadline passes). */
async function waitForReady(port, wantReady, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const res = await request(port, { requestPath: '/api/ready' });
      last = res;
      if (res.status === 200 && res.json?.ready === true && wantReady) return res;
      if (res.status === 503 && res.json?.ready === false && !wantReady) return res;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* -------------------------------------------------------- stubbed provider */

/**
 * A provider stub that speaks just enough of the OpenAI-compatible protocol and **records
 * the exact request body it was sent**, so a model-override claim is checked against what
 * actually left the server, not against a response string.
 */
function startProviderStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* record raw below */ }
      calls.push(parsed || { raw });
      const reply = JSON.stringify({
        id: 'stub-completion',
        object: 'chat.completion',
        model: (parsed && parsed.model) || 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reply) });
      res.end(reply);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      calls,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}

/* ------------------------------------------------------ database interrupt */

/**
 * A transparent TCP proxy in front of the database. Destroying every socket and closing the
 * listener simulates a database becoming unreachable mid-run, which is what an in-flight
 * learner request must survive as a refusal.
 */
function startDatabaseProxy(targetPort) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(socket);
    sockets.add(upstream);
    socket.pipe(upstream);
    upstream.pipe(socket);
    const drop = () => { socket.destroy(); upstream.destroy(); };
    socket.on('error', drop);
    upstream.on('error', drop);
    socket.on('close', () => { sockets.delete(socket); sockets.delete(upstream); });
    upstream.on('close', () => { sockets.delete(socket); sockets.delete(upstream); });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      interrupt: () => new Promise((r) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => r());
      }),
    }));
  });
}

/* =================================================================== checks */

check('the-retired-progress-path-is-refused-and-serves-nothing', async () => {
  const port = await freePort();
  // A READY runtime, so the refusal cannot be confused with the not-ready 503 that any route gives.
  const server = await startServer(port, { saas: true, accounts: true, database: true, forceOffline: true });
  try {
    await waitForReady(port, true);
    const progressFile = server.env.B1PREP_PROGRESS_FILE;

    /*
     * RETARGETED 2 October 2026 (SPA-RETIRE 6). This leg used to require 403 `legacy_progress_disabled`
     * from every method — a refusal code that `tools/retired-surface-check.mjs` R1 asserts must exist
     * NOWHERE. It had been failing since the file store was removed, and CI never said so because this
     * check sits behind other steps in the same job. The route is gone, so what is left to assert is
     * that the path is refused for everyone and that no record is ever served or written.
     */
    for (const [method, body] of [['GET', undefined], ['POST', { rev: 0, state: { nodes: { inject: { ok: true } } } }], ['DELETE', undefined]]) {
      const res = await request(port, {
        method, requestPath: '/api/progress',
        headers: method === 'GET' ? {} : jsonHeaders(), body,
      });
      must(res.status === 401 || res.status === 404, `${method} /api/progress must be refused, got ${res.status}`);
      must(!res.text.includes('legacy_progress_disabled'), 'the retired refusal token must not come back');
      must(res.status !== 200 && !res.json?.nodes && !res.json?.state, 'no learner record may be served from this path');
    }

    // A caller-supplied account header changes nothing: the path is refused before any selector is read.
    const foreign = await request(port, { requestPath: '/api/progress', headers: { 'x-b1prep-account': 'someone-elses-account' } });
    must(foreign.status === 401 || foreign.status === 404, `a caller-supplied account header must not select a record (${foreign.status})`);

    must(!fs.existsSync(progressFile), 'no shared progress file may be created by a refused request');
    return 'GET/POST/DELETE /api/progress refused (401/404), no record served, no refusal token, no file written';
  } finally { await server.stop(); }
});

check('entry-point-fails-closed-when-the-mode-flag-is-omitted', async () => {
  // SAAS-MODEL-01 Step 2. With no `B1PREP_SAAS` and no account/database configuration the OLD
  // behaviour was a working single-user app. The new contract is a refusal: the absence of the
  // configuration is an error, not a local mode. This REPLACES the retired
  // `legacy-progress-local-install-unchanged` check, whose purpose ("the local install is
  // unchanged") no longer exists. The negative control is that the single-user path is NOT served.
  const port = await freePort();
  const server = await startServer(port, { forceOffline: true });
  try {
    const ready = await request(port, { requestPath: '/api/ready' });
    assert.equal(ready.status, 503, `readiness must fail closed, got ${ready.status}`);
    assert.equal(ready.json?.ready, false);
    assert.equal(ready.json?.mode, 'unconfigured');
    must(/B1PREP_ACCOUNTS/.test(String(ready.json?.reason || '')),
      `the readiness reason must name the missing configuration, got ${ready.json?.reason}`);
    for (const path of ['/api/v1/account', '/api/progress']) {
      const res = await request(port, { requestPath: path });
      assert.equal(res.status, 503, `${path} must be refused while unconfigured, got ${res.status}`);
    }
    // Negative control: a single-user progress WRITE must not be served, and no file appears.
    const write = await request(port, {
      method: 'POST', requestPath: '/api/progress',
      headers: localJsonHeaders(port), body: { rev: 0, state: { nodes: { b: { ok: true } } } },
    });
    must(write.status !== 200, `the single-user progress write must not be served (got ${write.status})`);
    must(!fs.existsSync(server.env.B1PREP_PROGRESS_FILE), 'no shared progress file may be created');
    must(!/runs single-user/.test(server.log()), `the entry point must not report the single-user fallback:\n${server.log()}`);
    return `ready 503/false (${ready.json.reason}); learner routes 503; single-user path not served`;
  } finally { await server.stop(); }
});

check('fail-closed-no-longer-depends-on-the-mode-flag', async () => {
  // The plan: `B1PREP_SAAS` may still exist as a distinction, but it must no longer decide
  // whether learner data is protected. The OLD code ran a single-user app whenever B1PREP_SAAS
  // was unset AND accounts were not enabled. Here `B1PREP_ACCOUNTS=1` is set but the database
  // configuration is absent, and `B1PREP_SAAS` is deliberately omitted: the new contract is a
  // refusal, not a single-user fallback.
  const port = await freePort();
  const server = await startServer(port, { accounts: true, dropDatabase: true, forceOffline: true });
  try {
    const ready = await request(port, { requestPath: '/api/ready' });
    assert.equal(ready.status, 503, `readiness must fail closed, got ${ready.status}`);
    assert.equal(ready.json?.ready, false);
    must(/OWNAPI_PG_DATABASE/.test(String(ready.json?.reason || '')),
      `the reason must name the missing database configuration, got ${ready.json?.reason}`);
    const account = await request(port, { requestPath: '/api/v1/account' });
    assert.equal(account.status, 503, `learner route must be 503, got ${account.status}`);
    const legacy = await request(port, { requestPath: '/api/progress' });
    must(legacy.status === 503 || legacy.status === 403, `no single-user fallback, got ${legacy.status}`);
    must(!/runs single-user/.test(server.log()), `the entry point must not report the single-user fallback:\n${server.log()}`);
    return `accounts flag set, no database config, B1PREP_SAAS unset => ready 503 (${ready.json.reason}); learner 503`;
  } finally { await server.stop(); }
});

/*
 * THE FIVE AI-ROUTE LEGS WERE RETIRED HERE (SPA-RETIRE 6, 2 October 2026).
 *
 * They asserted that POST /api/ai refuses an anonymous caller, that an authenticated caller cannot
 * override the model, that the input is bounded server-side, and that POST /api/ai/test is
 * operator-only. All five are VOID rather than failed: the routes were deleted with the SPA-era API, so
 * there is nothing left to refuse, bound or override. Their property is now STRUCTURAL and asserted
 * where it can be observed:
 *
 *   * retired-surface-check R8 — no /api/config, /api/ai or /api/ai/test handler literal in server.js;
 *   * retired-surface-check R9 — the browser-facing provider refusal token exists nowhere;
 *   * docker-stack-check — all three answer 404 to an AUTHENTICATED caller, which is the difference
 *     between "gone" and "merely rude";
 *   * worker-runner-check + owned-api-check — assessment is a server-side job with a per-account
 *     allowance and exactly one debit, which is what the deleted proxy was replaced BY.
 *
 * The ledger rule this obeys: never keep an implementation alive to feed a check. The reverse is the
 * same rule — never keep a check alive for an implementation that is gone.
 */

check('saas-missing-database-fails-closed', async () => {
  const port = await freePort();
  // SaaS on, but no database configuration at all.
  const server = await startServer(port, { saas: true, forceOffline: true });
  try {
    const account = await request(port, { requestPath: '/api/v1/account' });
    assert.equal(account.status, 503, `learner route must answer 503, got ${account.status}`);

    const signUp = await request(port, {
      method: 'POST', requestPath: '/api/auth/sign-up/email',
      headers: jsonHeaders(), body: { name: 'X', email: `no-db-${RUN_ID}@example.invalid`, password: 'pw-synthetic-1' },
    });
    assert.equal(signUp.status, 503, `auth route must answer 503, got ${signUp.status}`);

    const ready = await request(port, { requestPath: '/api/ready' });
    assert.equal(ready.status, 503, `readiness must be 503, got ${ready.status}`);
    assert.equal(ready.json?.ready, false, 'readiness must report ready:false');

    // No downgrade: the legacy path is refused too (not-ready is itself a refusal) and the
    // process never reports the single-user fallback.
    const legacy = await request(port, { requestPath: '/api/progress' });
    must(legacy.status === 503 || legacy.status === 403,
      `the legacy path must stay refused (no single-user fallback), got ${legacy.status}`);
    must(!/runs single-user/.test(server.log()), `the hosted runtime must not report the single-user fallback:\n${server.log()}`);
    return `learner 503, readiness 503/false, legacy refused (${legacy.status}), no single-user fallback`;
  } finally { await server.stop(); }
});

check('runtime-database-interruption-is-a-refusal', async () => {
  const bridge = await startDatabaseProxy(Number(process.env.OWNAPI_PG_PORT || 5432));
  const port = await freePort();
  const server = await startServer(port, {
    saas: true, accounts: true, database: true, dbPortOverride: bridge.port,
    forceOffline: true,
  });
  try {
    await waitForReady(port, true, 60000);
    const jar = cookieJar();
    const signUp = await request(port, {
      method: 'POST', requestPath: '/api/auth/sign-up/email',
      headers: jsonHeaders(), body: { name: 'D', email: `saas-drop-${RUN_ID}@example.invalid`, password: 'pw-synthetic-1' },
    });
    assert.equal(signUp.status, 200, `sign-up failed: ${signUp.text.slice(0, 200)}`);
    jar.absorb(signUp.setCookie);

    const ok = await request(port, { requestPath: '/api/v1/account', headers: { Cookie: jar.header() } });
    assert.equal(ok.status, 200, 'the account is readable before the interruption');

    await bridge.interrupt();
    await new Promise((r) => setTimeout(r, 400));

    // The process must still be alive to answer: a database blink is a refusal (5xx), never
    // an outage of the whole runtime and never a silent anonymous success.
    const after = await request(port, { requestPath: '/api/v1/account', headers: { Cookie: jar.header() } });
    must(after.status >= 500, `a database interruption must refuse, got ${after.status}`);
    must(!after.json?.id, 'no account data may be served after a database interruption');

    const legacy = await request(port, { requestPath: '/api/progress' });
    // 401 is the auth wrap (the route is deleted, so no handler can run); 403/503 are the older gates.
    // Every one of them is a refusal, and none of them serves a record — which is the property.
    must([401, 403, 404, 503].includes(legacy.status), `the legacy path must stay refused throughout, got ${legacy.status}`);
    return `learner route => ${after.status} after interruption (was 200); legacy still ${legacy.status}; process alive`;
  } finally { await server.stop(); }
});

check('configured-public-origin-accepted-and-foreign-refused', async () => {
  const port = await freePort();
  // Ready runtime (accounts + database) so an accepted mutation can actually reach 200; the
  // origin gate runs before readiness, so the refusals below hold either way.
  const server = await startServer(port, { saas: true, accounts: true, database: true, forceOffline: true });
  try {
    const ready = await waitForReady(port, true);
    assert.equal(ready && ready.status, 200, `the runtime must be ready before acceptance is measured (${ready && ready.json && ready.json.reason})`);
    // The deployment's own origin is accepted: a same-origin sign-up reaches the account API.
    // CONFIG-ANON-01: this acceptance used to be shown with POST /api/config, which is now
    // gone on a hosted runtime (below). The gate itself is unchanged, so acceptance is shown on
    // a route that still exists.
    const accepted = await request(port, {
      method: 'POST', requestPath: '/api/auth/sign-up/email',
      headers: jsonHeaders(), body: { name: 'O', email: `saas-origin-${RUN_ID}@example.invalid`, password: 'pw-synthetic-1' },
    });
    assert.equal(accepted.status, 200, `the deployment origin must be accepted, got ${accepted.status} ${accepted.text.slice(0, 120)}`);

    // CONFIG-ANON-01. SUPERSEDED ASSERTION, not deleted: this check used to require
    // `POST /api/config -> 200` ("the deployment origin must be accepted"). POST /api/config
    // wrote the machine-global EXAM_DATE for any visitor, and GET /api/config read it back, so
    // on a hosted runtime neither is served now - both answer 404 like any other unknown
    // endpoint. The origin acceptance it carried is asserted above, on a route that exists.
    const configWrite = await request(port, {
      method: 'POST', requestPath: '/api/config',
      headers: jsonHeaders(), body: { examDate: '2027-01-09' },
    });
    /*
     * RETARGETED (SPA-RETIRE 6): the auth wrap answers 401 for ANY /api/* path, so an ANONYMOUS caller
     * cannot distinguish "route deleted" from "route present but refused". Both are refusals and both are
     * acceptable here; the discriminating assertion is the AUTHENTICATED 404 in docker-stack-check, where
     * a session exists. What must never happen is a 200 that writes the machine-global exam date.
     */
    must([401, 404].includes(configWrite.status), `anonymous POST /api/config must be refused, got ${configWrite.status}`);
    const configRead = await request(port, { requestPath: '/api/config' });
    must([401, 404].includes(configRead.status), `anonymous GET /api/config must be refused, got ${configRead.status}`);

    // A foreign origin is refused, even with the deployment's Host header.
    const foreign = await request(port, {
      method: 'POST', requestPath: '/api/config',
      headers: { Origin: FOREIGN_ORIGIN, Host: PUBLIC_HOST, 'Content-Type': 'application/json' },
      body: { examDate: '2027-01-09' },
    });
    assert.equal(foreign.status, 403, `a foreign origin must be refused, got ${foreign.status}`);
    assert.equal(foreign.json?.code, 'origin_rejected');

    // A rebinding Host cannot borrow the configured origin's trust.
    const rebound = await request(port, {
      method: 'POST', requestPath: '/api/config',
      headers: { Origin: PUBLIC_ORIGIN, Host: 'attacker.example', 'Content-Type': 'application/json' },
      body: { examDate: '2027-01-09' },
    });
    assert.equal(rebound.status, 403, `a mismatched Host must be refused, got ${rebound.status}`);
    return `sign-up accepted=${accepted.status}, POST /api/config=${configWrite.status}, GET /api/config=${configRead.status}, foreign=${foreign.status}, rebound=${rebound.status}`;
  } finally { await server.stop(); }
});

/* ====================================================================== run */

/** Run a check with a hard deadline so a stall becomes a FAILED CHECK, not a hang. */
function withDeadline(promise, ms, name) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`check timed out after ${ms}ms: ${name}`)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export async function runSaasRuntimeChecks({ only = null } = {}) {
  if (FORBIDDEN.has(DATABASE)) {
    throw new Error(`refusing to run against ${DATABASE}; set OWNAPI_PG_DATABASE to a disposable database`);
  }
  if (!DATABASE) throw new Error('OWNAPI_PG_DATABASE must name a disposable database');
  const selected = only ? checks.filter((c) => c.name.includes(only)) : checks;
  if (!selected.length) throw new Error(`no check matches --only=${only}`);
  if (process.env.OWNAPI_PG_ALLOW !== '1') {
    throw new Error('set OWNAPI_PG_ALLOW=1 to confirm this is a disposable database the migration command may provision');
  }
  /*
   * The legs that need a READY runtime would otherwise meet `schema_behind` on a fresh disposable schema: the
   * runtime never migrates (MFP-01). Run the operator's migration command first — idempotent on a current
   * schema — so a refusal below is the boundary under test, never an unmigrated database.
   */
  await migrate({ config: persistentConfig() });
  const results = [];
  for (const { name, run } of selected) {
    try {
      const detail = await withDeadline(run(), CHECK_TIMEOUT_MS, name);
      results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? String(error.message).split('\n')[0] : String(error) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('saas-runtime-check.mjs');
if (invokedDirectly) {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length) : null;
  if (process.argv.includes('--list')) {
    for (const c of checks) console.log(c.name);
    process.exit(0);
  }
  let failed = 1;
  try {
    const report = await runSaasRuntimeChecks({ only });
    for (const r of report.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? `  [${r.detail}]` : `\n  ${r.detail}`}`);
    failed = report.results.filter((r) => !r.ok).length;
    console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
    console.log('NOTE real server processes, real HTTP, synthetic accounts, stubbed provider, disposable database.');
  } catch (error) {
    console.error(`ERROR ${error && error.message ? error.message : error}`);
  } finally {
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
  // Exit explicitly: a lingering handle must never keep this process alive after the summary.
  process.exit(failed ? 1 : 0);
}
