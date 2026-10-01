/**
 * DISCRIMINATION LEG — does the RUNNING SERVER wire the hard-delete port?
 *
 * This is not a new check of the deletion transaction. It is the one question the
 * deletion evidence never asked: `tools/deletion-check.mjs` builds its own
 * `createOwnedApi({...ports, accountDeletion: deletion})` and drives THAT. The running
 * server gets its api from `createPostgresWorld()`, so the port it actually receives is
 * whatever `fixture.mjs` passes. If `accountDeletion` is not wired there, the production
 * `DELETE /api/v1/account` is a 503 and the whole slice is unreachable from the product.
 *
 * Real server process, real HTTP, real PostgreSQL, synthetic account.
 *
 * Usage: node tools/coord-deletion-mount-probe.mjs
 *   OWNAPI_PG_* must name a DISPOSABLE database (this creates an account and may delete it).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PROBE_PORT || 4471);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
};

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status < 500) return true;
      last = `status ${res.status}`;
    } catch (error) { last = String(error && error.message || error); }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms: ${last}`);
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT),
    B1PREP_ACCOUNTS: '1',
    B1PREP_FORCE_OFFLINE: '1',
    B1PREP_AI_TEST: '',
    B1PREP_ENV_FILE: path.join(ROOT, `.probe-${randomUUID()}.env`),
    B1PREP_PROGRESS_FILE: path.join(ROOT, `.probe-${randomUUID()}.json`),
  },
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

function stop() {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 5000);
  });
}

try {
  await waitForServer();

  const email = `mount-probe-${randomUUID().slice(0, 8)}@deletion-mount.invalid`;
  const password = `pw-${randomUUID()}`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: 'Synthetic Probe', email, password }),
  });
  const cookie = String(signUp.headers.get('set-cookie') || '').split(';')[0];
  check('the running server accepts a sign-up over real HTTP (accounts really are mounted)',
    signUp.status === 200 && cookie.length > 0, `status ${signUp.status}`);

  const who = await fetch(`${BASE}/api/v1/account`, { headers: { cookie } });
  const account = await who.json().catch(() => null);
  check('the running server serves GET /api/v1/account for that session',
    who.status === 200 && account && typeof account.id === 'string',
    `status ${who.status} id ${account && account.id}`);

  const del = await fetch(`${BASE}/api/v1/account`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: '{}',
  });
  const delBody = await del.json().catch(() => null);
  const stillThere = await fetch(`${BASE}/api/v1/account`, { headers: { cookie } });

  console.log(`\n     DELETE /api/v1/account -> ${del.status} ${JSON.stringify(delBody)}`);
  console.log(`     the same cookie afterwards -> ${stillThere.status}`);

  check('the RUNNING SERVER actually performs the hard delete (200 deleted:true)',
    del.status === 200 && delBody && delBody.deleted === true,
    del.status === 503
      ? `THE PRODUCTION ROUTE IS 503 ${delBody && delBody.error} - the deletion port is not wired in the running server`
      : `status ${del.status}`);

  check('the account is really gone from the running server (the cookie stops working)',
    stillThere.status === 401,
    `status ${stillThere.status} (expected 401 if the deletion ran)`);

  check('the running server reports the deletion honestly when it ran (completeErasure:false)',
    del.status === 200 ? delBody.completeErasure === false : false,
    del.status === 200 ? `completeErasure=${delBody.completeErasure}` : 'not reached: the route refused');
} catch (error) {
  check('probe completed', false, String(error && error.stack || error));
} finally {
  await stop();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
if (results.some((r) => !r.ok)) {
  console.log('--- server log (tail) ---');
  console.log(serverLog.split('\n').slice(-25).join('\n'));
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
