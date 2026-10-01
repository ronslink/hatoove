/**
 * COORD PROBE — V2 of Claude's SAAS-MODEL-01 recommendations.
 *
 * Claim: in hosted mode an ANONYMOUS same-origin caller can rewrite the server's
 * machine-global EXAM_DATE through POST /api/config, and every later visitor then reads it.
 *
 * If that reproduces, it is a LIVE defect that belongs to the deletion/config slice, not to
 * SAAS-RETIRE-01 — and `tools/saas-runtime-check.mjs:676-680` currently ASSERTS the 200.
 *
 * Real server process, real HTTP, synthetic data, throwaway env file. Read-only with respect to
 * the repository: every file it touches lives in a temp directory.
 *
 * Usage: node tools/coord-config-anon-probe.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PROBE_PORT || 4491);
const PUBLIC_ORIGIN = 'https://app.probe.invalid';
const HOST = 'app.probe.invalid';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-config-probe-'));
const envFile = path.join(tmp, 'throwaway.env');
const progressFile = path.join(tmp, 'progress.json');
fs.writeFileSync(envFile, 'EXAM_DATE=\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
};

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

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/api/health');
      if (res.status) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(PORT),
    B1PREP_SAAS: '1',
    B1PREP_ACCOUNTS: '1',
    B1PREP_FORCE_OFFLINE: '1',
    B1PREP_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    B1PREP_ENV_FILE: envFile,
    B1PREP_PROGRESS_FILE: progressFile,
  },
});
let log = '';
server.stdout.on('data', (d) => { log += d.toString(); });
server.stderr.on('data', (d) => { log += d.toString(); });

function stop() {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
  });
}

try {
  await waitForServer();

  const before = fs.readFileSync(envFile, 'utf8');
  const attackerDate = '2099-01-01';

  // ANONYMOUS: no cookie at all. Same-origin, so the SEC-01 gate is satisfied by design.
  const write = await request('POST', '/api/config',
    { 'content-type': 'application/json', host: HOST, origin: PUBLIC_ORIGIN },
    JSON.stringify({ examDate: attackerDate }));

  check('V2: an ANONYMOUS same-origin POST /api/config is refused (expected 401/403/404)',
    write.status >= 400,
    `status ${write.status} body ${write.text.slice(0, 200)}`);

  const after = fs.readFileSync(envFile, 'utf8');
  check('V2: the server\'s env file was NOT rewritten by an anonymous caller',
    !after.includes(attackerDate),
    after.trim() ? `env file now: ${after.trim().slice(0, 200)}` : 'env file unchanged');

  const read = await request('GET', '/api/config', { host: HOST, origin: PUBLIC_ORIGIN });
  check('V2: a later anonymous GET /api/config does not report the attacker\'s date',
    !(read.json && read.json.examDate === attackerDate),
    `status ${read.status} body ${read.text.slice(0, 200)}`);

  check('V2 control: an anonymous GET of a learner route is still refused (401)',
    (await request('GET', '/api/v1/account', { host: HOST, origin: PUBLIC_ORIGIN })).status === 401,
    'GET /api/v1/account');
} catch (error) {
  check('probe completed', false, String(error && error.stack || error));
  console.log(log.split('\n').slice(-15).join('\n'));
} finally {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
console.log('A FAIL here means the defect is REAL: the route must be deleted, not gated.');
process.exit(results.every((r) => r.ok) ? 0 : 1);
