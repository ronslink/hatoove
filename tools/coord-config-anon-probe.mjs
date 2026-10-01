/**
 * CONFIG-ANON-01 — the unauthenticated machine-global config write (the probe).
 *
 * The defect this probe reproduces on the pre-fix tree, against a REAL hosted runtime
 * (`B1PREP_SAAS=1`, a throwaway env file, and **no cookie at all**):
 *
 *   POST /api/config {"examDate":"2099-01-01"}
 *     -> 200 {"ok":true,"examDate":"2099-01-01","saved":["EXAM_DATE"]}
 *   the env file was rewritten: EXAM_DATE=2099-01-01
 *   GET  /api/config (still anonymous) -> 200 {"examDate":"2099-01-01"}
 *
 * Every visitor to the installation then reads the attacker's date. The same-origin gate is
 * satisfied by design (a browser supplies `Origin`), and the handler never consulted identity —
 * while the learner route one line away (`GET /api/v1/account`) correctly refuses.
 *
 * The four legs, and what the fix makes them:
 *
 *   1. anonymous POST /api/config   -> 404 (was 200)          [FAILS on the pre-fix tree]
 *   2. the env file keeps no EXAM_DATE=2099-01-01 (was rewritten) [FAILS on the pre-fix tree]
 *   3. anonymous GET  /api/config   -> 404 (was 200, exposing the date) [FAILS on the pre-fix tree]
 *   4. control: anonymous GET /api/v1/account -> 401 (unchanged; proves the runtime really
 *      does refuse an anonymous learner route, so leg 1's 404 is the route being gone, not a
 *      dead runtime)                                          [PASSES on the pre-fix tree]
 *
 * Three of the four legs fail on the pre-fix tree. A check that cannot fail is not evidence:
 * `--server <path>` re-runs the same probe against another `server.js`, which is how the
 * pre-fix tree is shown to fail (see work/implementation/CONFIG-ANON-01.md).
 *
 * Method: the real `node server.js` over real HTTP, a disposable PostgreSQL database, a
 * throwaway B1PREP_ENV_FILE / B1PREP_PROGRESS_FILE, and an operator-shaped request. No real
 * credential, no live AI, no real learner record. Bounded throughout: every request carries a
 * timeout and a server process is always reaped, so a stall is a FAILED LEG, never a hang.
 *
 * Safety: requires a disposable database in OWNAPI_PG_DATABASE and refuses `postgres`,
 * `template0` and `template1`.
 *
 * Usage:
 *   OWNAPI_PG_DATABASE=<disposable> node tools/coord-config-anon-probe.mjs
 *   ... node tools/coord-config-anon-probe.mjs --server /path/to/pre-fix/server.js
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const DATABASE = process.env.OWNAPI_PG_DATABASE || '';
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-config-anon-'));

const REQUEST_TIMEOUT_MS = 20000;
const SERVER_READY_DEADLINE_MS = 30000;

/** The deployment's own public origin the hosted runtime is configured for. */
const PUBLIC_ORIGIN = 'https://app.hatoove.example.test';
const PUBLIC_HOST = 'app.hatoove.example.test';
/** The attacker's date. Synthetic, and chosen only to be obviously not a real exam date. */
const ATTACKER_DATE = '2099-01-01';
/** The learner control route. */
const CONTROL_PATH = '/api/v1/account';

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

/** A real HTTP request with full Host/Origin control and a hard timeout. No cookie is ever sent. */
function request(port, { method = 'GET', requestPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
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

/* ---------------------------------------------------------- server process */

async function startServer(port, serverPath) {
  const env = {
    ...process.env,
    B1PREP_PORT: String(port),
    B1PREP_SAAS: '1',
    B1PREP_ACCOUNTS: '1',
    B1PREP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    B1PREP_FORCE_OFFLINE: '1',
    B1PREP_ENV_FILE: path.join(TEMP, `env-${port}`),
    B1PREP_PROGRESS_FILE: path.join(TEMP, `progress-${port}.json`),
    OWNAPI_PG_HOST: process.env.OWNAPI_PG_HOST || '127.0.0.1',
    OWNAPI_PG_PORT: String(process.env.OWNAPI_PG_PORT || 5432),
    OWNAPI_PG_DATABASE: DATABASE,
    OWNAPI_PG_USER: process.env.OWNAPI_PG_USER || 'postgres',
    ...(process.env.OWNAPI_PG_PASSWORD ? { OWNAPI_PG_PASSWORD: process.env.OWNAPI_PG_PASSWORD } : {}),
    ...(process.env.OWNAPI_PG_SCHEMA ? { OWNAPI_PG_SCHEMA: process.env.OWNAPI_PG_SCHEMA } : {}),
    ...(process.env.OWNAPI_PG_ROLE_PREFIX ? { OWNAPI_PG_ROLE_PREFIX: process.env.OWNAPI_PG_ROLE_PREFIX } : {}),
  };
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_BASE_URL;

  const child = spawn(process.execPath, [serverPath], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += String(c); });
  child.stderr.on('data', (c) => { out += String(c); });

  const deadline = Date.now() + SERVER_READY_DEADLINE_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${out.slice(-400)}`);
    try {
      const response = await request(port, { requestPath: '/api/ready' });
      if (response.status === 200 && response.json?.ready === true) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become ready on ${port}: ${out.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    port,
    env,
    log: () => out,
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

/* ------------------------------------------------------------------- probe */

const sameOriginJson = { Origin: PUBLIC_ORIGIN, Host: PUBLIC_HOST, 'Content-Type': 'application/json' };

async function runProbe({ serverPath, label }) {
  const port = await freePort();
  const server = await startServer(port, serverPath);
  const legs = [];
  const record = async (name, fn) => {
    try {
      legs.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      legs.push({ name, ok: false, detail: err && err.message ? String(err.message).split('\n')[0] : String(err) });
    }
  };

  try {
    const envPath = server.env.B1PREP_ENV_FILE;

    // Leg 4 (control) first: the runtime really is up and really does refuse an anonymous
    // learner route, so a 404 below is the route being gone rather than a dead process.
    await record('control-anonymous-learner-route-refuses', async () => {
      const res = await request(port, { requestPath: CONTROL_PATH });
      if (res.status !== 401) throw new Error(`expected 401 for an anonymous ${CONTROL_PATH}, got ${res.status} (${res.text.slice(0, 120)})`);
      return `GET ${CONTROL_PATH} (no cookie) -> 401`;
    });

    await record('anonymous-post-config-is-404', async () => {
      const res = await request(port, {
        method: 'POST', requestPath: '/api/config', headers: sameOriginJson,
        body: { examDate: ATTACKER_DATE },
      });
      if (res.status !== 404) throw new Error(`expected 404 for an anonymous POST /api/config, got ${res.status} (${res.text.slice(0, 140)})`);
      return `POST /api/config (no cookie) -> 404`;
    });

    await record('anonymous-post-config-writes-no-env', async () => {
      const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (new RegExp(`^EXAM_DATE=${ATTACKER_DATE}$`, 'm').test(text)) {
        throw new Error(`the env file was rewritten with EXAM_DATE=${ATTACKER_DATE}`);
      }
      return `no EXAM_DATE=${ATTACKER_DATE} in ${path.basename(envPath)}`;
    });

    await record('anonymous-get-config-is-404', async () => {
      const res = await request(port, { requestPath: '/api/config' });
      if (res.status !== 404) {
        throw new Error(`expected 404 for an anonymous GET /api/config, got ${res.status} (${res.text.slice(0, 140)})`);
      }
      return `GET /api/config (no cookie) -> 404`;
    });
  } finally {
    await server.stop();
  }

  return { label, modulePath: serverPath, legs };
}

function printRun(report, io) {
  io.log(`  ${report.label} server @ ${report.modulePath}`);
  for (const leg of report.legs) {
    io.log(`  ${leg.ok ? 'PASS' : 'FAIL'}  ${leg.name}  [${leg.detail}]`);
  }
}

export async function runProbeCli(argv = process.argv.slice(2), io = console) {
  if (FORBIDDEN.has(DATABASE)) throw new Error(`refusing to run against ${DATABASE}; set OWNAPI_PG_DATABASE to a disposable database`);
  if (!DATABASE) throw new Error('OWNAPI_PG_DATABASE must name a disposable database');

  const serverIndex = argv.indexOf('--server');
  const explicitServer = serverIndex === -1 ? null : path.resolve(argv[serverIndex + 1] || '');

  io.log('coord-config-anon-probe: the unauthenticated machine-global config write (CONFIG-ANON-01)');
  io.log('  real hosted runtime (B1PREP_SAAS=1), throwaway env, disposable database, NO cookie sent.');
  const tree = await runProbe({ serverPath: path.join(ROOT, 'server.js'), label: 'tree' });
  printRun(tree, io);

  let failed = tree.legs.filter((l) => !l.ok).length;
  if (tree.legs.length !== 4) failed += 1;

  if (explicitServer) {
    if (!fs.existsSync(explicitServer)) throw new Error(`no such file: ${explicitServer}`);
    io.log('');
    io.log(`  BEFORE/AFTER - same probe, source ${explicitServer}`);
    const scratch = await runProbe({ serverPath: explicitServer, label: 'scratch' });
    printRun(scratch, io);
    const scratchFailed = scratch.legs.filter((l) => !l.ok).length;
    io.log(`  ${scratchFailed > 0 ? 'OK   ' : 'FAIL '} discrimination: ${scratchFailed}/${scratch.legs.length} legs fail on the source above ` +
      `(a fix whose probe cannot fail on the pre-fix tree is not evidence).`);
    if (scratchFailed === 0) failed += 1;
  } else {
    io.log('  NOTE  add --server <path> to run the same probe against the pre-fix tree and show it fail.');
  }

  if (failed) {
    io.error(`  FAIL  ${tree.legs.filter((l) => !l.ok).length} of ${tree.legs.length} leg(s) failed on this tree.`);
    return 1;
  }
  io.log(`  OK    ${tree.legs.length} leg(s) passed.`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let code = 1;
  try {
    code = await runProbeCli();
  } catch (error) {
    console.error(`ERROR ${error && error.message ? error.message : error}`);
  } finally {
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
  process.exit(code);
}
