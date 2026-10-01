/**
 * COORD-ADDENDUM PROBE — two findings of the combined-head re-review, executed rather than read.
 *
 *   X-B: the F3 strictness fix over-refuses. `hasUnparseableOriginCharacters` requires
 *        `scheme://host[:port]` with nothing after the authority, so a trailing-slash Origin and
 *        ANY Referer carrying a path are refused. Browsers always put a path in a Referer, so
 *        server.js's documented Referer fallback would be dead for every value a browser can send.
 *   X-E: /api/ready reports ready:true while the origin configuration the mutation gate needs is
 *        unset, so every non-GET - including sign-in - is refused.
 *
 * Real server process, real HTTP, synthetic account, disposable database. Read-only.
 * `node:http` is used rather than fetch because the probe must control the Host header, which
 * fetch forbids.
 *
 * Usage: node tools/coord-readiness-origin-probe.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PROBE_PORT || 4472);
const PUBLIC_ORIGIN = 'https://app.probe.invalid';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
};

/** One request with full control of the headers. */
function request(method, pathname, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
    if (body !== null) req.write(body);
    req.end();
  });
}

async function waitUntilReady(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/api/ready');
      if (res.json && res.json.ready === true) return res.json;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('the server never reported ready');
}

function start(extraEnv = {}) {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      B1PREP_SAAS: '1',
      B1PREP_ACCOUNTS: '1',
      B1PREP_FORCE_OFFLINE: '1',
      B1PREP_ENV_FILE: path.join(ROOT, `.probe2-${randomUUID()}.env`),
      B1PREP_PROGRESS_FILE: path.join(ROOT, `.probe2-${randomUUID()}.json`),
      B1PREP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...extraEnv,
    },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  return { server, log: () => log };
}

function stop(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
  });
}

const HOST = 'app.probe.invalid';
const signUp = (headers) => request('POST', '/api/auth/sign-up/email',
  { 'content-type': 'application/json', host: HOST, ...headers },
  JSON.stringify({ name: 'Probe', email: `probe-${randomUUID().slice(0, 8)}@probe.invalid`, password: 'pw-12345678' }));

/* ---------------------------------------------------------------- X-B */
{
  const { server, log } = start();
  try {
    await waitUntilReady();

    const exact = await signUp({ origin: PUBLIC_ORIGIN });
    check('X-B control: the exact configured Origin is accepted (sign-up 200)',
      exact.status === 200, `status ${exact.status} ${exact.text.slice(0, 120)}`);

    const slash = await signUp({ origin: `${PUBLIC_ORIGIN}/` });
    check('X-B: a trailing-slash Origin is REFUSED (the earlier review recorded it accepted)',
      slash.status === 403, `status ${slash.status}`);

    const refPath = await signUp({ referer: `${PUBLIC_ORIGIN}/konto` });
    check('X-B: a Referer carrying a path is REFUSED, so the documented Referer fallback is dead for browsers',
      refPath.status === 403, `status ${refPath.status}`);

    const refExact = await signUp({ referer: PUBLIC_ORIGIN });
    check('X-B: a Referer that is a bare origin IS accepted, so the fallback is reachable only by a non-browser client',
      refExact.status === 200, `status ${refExact.status}`);
  } catch (error) {
    check('X-B probe completed', false, String(error && error.stack || error));
    console.log(log().split('\n').slice(-12).join('\n'));
  } finally {
    await stop(server);
  }
}

/* ---------------------------------------------------------------- X-E */
{
  const { server, log } = start({ B1PREP_PUBLIC_ORIGIN: '' });
  try {
    const ready = await waitUntilReady();

    check('X-E: /api/ready answers ready:true with B1PREP_PUBLIC_ORIGIN unset',
      ready.ready === true, `body ${JSON.stringify(ready)}`);

    const signInNoOrigin = await request('POST', '/api/auth/sign-in/email',
      { 'content-type': 'application/json', host: HOST },
      JSON.stringify({ email: 'nobody@probe.invalid', password: 'pw-12345678' }));
    check('X-E: while /api/ready says ready, sign-in with no Origin is refused at the gate (403)',
      signInNoOrigin.status === 403, `status ${signInNoOrigin.status} ${signInNoOrigin.text.slice(0, 120)}`);

    // The decisive leg: with no configured origin there is NO Origin value that satisfies the
    // gate, because isSameOriginRequest returns false before it looks at the header at all.
    const signInWithOrigin = await request('POST', '/api/auth/sign-in/email',
      { 'content-type': 'application/json', host: HOST, origin: PUBLIC_ORIGIN },
      JSON.stringify({ email: 'nobody@probe.invalid', password: 'pw-12345678' }));
    check('X-E: and a request carrying the exact expected Origin is refused too - no value satisfies the gate',
      signInWithOrigin.status === 403,
      `status ${signInWithOrigin.status} ${signInWithOrigin.text.slice(0, 120)}`);
  } catch (error) {
    check('X-E probe completed', false, String(error && error.stack || error));
    console.log(log().split('\n').slice(-12).join('\n'));
  } finally {
    await stop(server);
  }
}

/* ------------------------------------------------- X-E control: origin SET */
{
  const { server, log } = start();
  try {
    await waitUntilReady();
    const signIn = await request('POST', '/api/auth/sign-in/email',
      { 'content-type': 'application/json', host: HOST, origin: PUBLIC_ORIGIN },
      JSON.stringify({ email: 'nobody@probe.invalid', password: 'pw-12345678' }));
    check('X-E control: with B1PREP_PUBLIC_ORIGIN set, the SAME request reaches the application (401, not 403)',
      signIn.status === 401,
      `status ${signIn.status} ${signIn.text.slice(0, 160)} - so the unset origin, not the route, is what refuses`);
  } catch (error) {
    check('X-E control completed', false, String(error && error.stack || error));
    console.log(log().split('\n').slice(-12).join('\n'));
  } finally {
    await stop(server);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
