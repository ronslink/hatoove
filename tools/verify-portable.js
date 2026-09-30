// Verify the deployed runtime and exFAT persistence without touching learner data.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const root = path.resolve(process.argv[2] || 'F:\\B1_Prep');
const node = path.join(root, 'runtime', 'node.exe');
const launcher = path.join(root, 'portable-launcher.cjs');
const testFile = path.join(root, `.portable test ${randomUUID()}.json`);
const env = { ...process.env, B1PREP_FORCE_OFFLINE: '1', B1PREP_PROGRESS_FILE: testFile };
const liveFiles = ['.env', 'progress.json', 'progress.json.bak'];
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const before = new Map();
for (const name of liveFiles) {
  try { before.set(name, await hash(path.join(root, name))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let proc;
let port;
let base;
const checks = [];

async function start() {
  proc = spawn(node, [launcher, '--no-browser', '--port', String(port), '--progress-file', testFile], {
    cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (data) => { output += data; });
  proc.stderr.on('data', (data) => { output += data; });
  let spawnError;
  proc.on('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (proc.exitCode !== null) throw new Error('Portable launcher exited before readiness.');
    if (output.includes(`Portable app ready: ${base}`)) return;
    await delay(100);
  }
  throw new Error('Portable launcher did not become ready.');
}

async function stop() {
  if (!proc || proc.exitCode !== null) return;
  const ownPid = proc.pid;
  await runFile('taskkill.exe', ['/PID', String(ownPid), '/T', '/F'], { windowsHide: true });
  await delay(200);
  proc = undefined;
}

async function json(route, options) {
  const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, `HTTP success for ${route}`);
  return response.json();
}

try {
  const reserve = http.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  base = `http://127.0.0.1:${port}`;

  await start();
  const health = await json('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.configured, false, 'Testing cannot make paid AI calls');
  assert.equal(health.node, 'v24.21.0');
  checks.push('Bundled runtime starts from an unrelated working directory and overrides saved PORT');
  for (const route of ['/', '/js/app.js', '/js/store.js', '/data/seed.json', '/fonts/source-sans-3-latin-wght-normal.woff2']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.arrayBuffer()).byteLength > 0, route);
  }
  checks.push('App, modules, content and bundled fonts are served from the SSD');

  const timestamp = Date.now();
  const state = {
    version: 1, createdAt: timestamp, updatedAt: timestamp,
    settings: { dailyGoal: 17 },
    nodes: { 'skill:LV1': { theta: 55, n: 1, correct: 1, last: timestamp } },
    history: [], errors: [], srs: {}, days: {}, planDone: {},
    counters: { attempts: 1, correct: 1, aiCalls: 0, aiFailures: 0 },
  };
  await json('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });
  const saved = JSON.parse(await fs.readFile(testFile, 'utf8'));
  assert.equal(saved.settings.dailyGoal, 17);
  await stop();
  await start();
  const restored = await json('/api/progress');
  assert.equal(restored.found, true);
  assert.equal(restored.state.settings.dailyGoal, 17);
  assert.equal(restored.state.counters.attempts, 1);
  checks.push('Isolated progress saves on exFAT and survives a server restart');

  const conflict = await new Promise((resolve, reject) => {
    const second = spawn(node, [launcher, '--no-browser', '--port', String(port), '--progress-file', testFile], {
      cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    second.stdout.on('data', (data) => { output += data; });
    second.stderr.on('data', (data) => { output += data; });
    second.once('error', reject);
    second.once('close', (code) => resolve({ code, output }));
  });
  assert.equal(conflict.code, 1);
  assert.equal(conflict.output.includes('Portable app ready:'), false);
  checks.push('Occupied port fails cleanly without opening an unrelated server');

  const suite = fileURLToPath(new URL('./e2e.js', import.meta.url));
  const browserResult = await runFile(node, [suite, base], {
    env, cwd: path.dirname(path.dirname(suite)), windowsHide: true,
    timeout: 180000, maxBuffer: 2 * 1024 * 1024,
  });
  const summary = browserResult.stdout.match(/[^\r\n]*(?:passed|failed)[^\r\n]*/gi) || [];
  console.log(summary.join('\n'));
  checks.push('Existing browser suite passes against the SSD using isolated progress');

  // F-5: the bundle must say, on the media itself, that the key and the progress copy it
  // carries travel with the media and are outside the app's delete path. This is
  // disclosure, not deletion: the app cannot delete from media it cannot reach.
  const noticePath = path.join(root, 'DELETION-NOTICE.txt');
  let notice = '';
  try { notice = await fs.readFile(noticePath, 'utf8'); } catch { /* absent */ }
  assert.ok(notice.length > 0, 'The portable bundle must carry DELETION-NOTICE.txt (F-5)');
  assert.ok(
    /outside the app delete path/i.test(notice) && /mitigation by disclosure/i.test(notice),
    'DELETION-NOTICE.txt must state that the media copy is outside the app delete path'
  );
  checks.push('Portable bundle states that the key and progress on the media are outside the app delete path');
} finally {
  await stop();
  for (const suffix of ['', '.bak', '.tmp', '.pre-recovery']) await fs.rm(testFile + suffix, { force: true });
  for (const [name, original] of before) {
    assert.equal(await hash(path.join(root, name)), original, `${name} was not changed by tests`);
  }
}
for (const check of checks) console.log(`PASS: ${check}`);
console.log('PASS: Real progress and API settings were unchanged; temporary test files removed.');
