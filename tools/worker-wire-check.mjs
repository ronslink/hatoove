/**
 * WORKER-WIRE-01 checker (`worker-wire-check`): proves the composition that the journey
 * harness now depends on — a REAL, separate `node server/worker.mjs` process, connecting as
 * the restricted `<prefix>_worker` role, claiming and completing jobs against a real
 * PostgreSQL database.
 *
 * What this proves that `tools/worker-runner-check.mjs` does not (and vice versa):
 *   - runner-check proves the runner's LOGIC with in-process `runOnce()`/`reclaimExpired()`;
 *   - this file proves the COMPOSITION: separate processes, a restricted role, crash
 *     recovery where the recovering party is another real process, and two real processes
 *     racing one job.
 *
 * Every leg has a discrimination: a positive control or a negative that the leg must
 * distinguish. The record `work/implementation/WORKER-WIRE-01.md` §3 additionally records a
 * scratch-copy mutation for each leg, watched to fail.
 *
 * NO PROVIDER CALL. The grader is the deterministic stub; legs that need a grader to throw
 * inject one in-process (the CLI has no failure-injection hook), and the COMPLETION after the
 * failure is done by a real child process.
 *
 * Legs:
 *   W1. crash recovery end to end   — an abandoned running job is completed by a real process (assessments=1, debit=1)
 *   W2. two workers, one job        — two real child processes race one queued job; exactly one processes it
 *   W3. the worker cannot exceed its role — the child's connection is `<prefix>_worker`, and a privileged op through it fails
 *   W4. a failing grader does not lose the submission — failed + stable code, reserved released, text readable, retry() + a real worker completes it
 *
 * Usage: node tools/worker-wire-check.mjs   (needs a disposable DB; OWNAPI_PG_*)
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createWorker, stubGrade } from '../server/owned-postgres/worker.mjs';

/* =============================================================== the world */

const db = await createFixture();
let world = null;

async function teardown() {
  if (world) await world.teardown().catch(() => {});
  else await db.cleanup().catch(() => {});
}

const one = async (sql, params) => (await db.admin.query(sql, params)).rows[0];
const jobRow = (submissionId) => one('SELECT * FROM jobs WHERE submission_id = $1', [submissionId]);
const assessmentCount = async (submissionId) =>
  (await one('SELECT count(*)::int AS n FROM assessments WHERE submission_id = $1', [submissionId])).n;
const ledgerUnits = async (submissionId) =>
  (await one('SELECT coalesce(sum(units),0)::int AS n FROM usage_ledger WHERE submission_id = $1', [submissionId])).n;
const entitlement = (owner) => one('SELECT * FROM entitlements WHERE owner_id = $1', [owner]);
const queuedCount = async () => (await one("SELECT count(*)::int AS n FROM jobs WHERE status = 'queued'")).n;

/** The child CLI's pool announces itself as `<schema>:worker`; no fixture pool uses that name. */
const workerIdentity = `${db.schema}:worker`;
const workerRole = db.roles.worker;
const workerBackends = async () => (await one(
  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND usename = $2',
  [workerIdentity, workerRole])).n;
const workerPids = async () => (await db.admin.query(
  'SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND usename = $2',
  [workerIdentity, workerRole])).rows.map((r) => r.pid);
const backendsAsAdmin = async () => (await one(
  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND usename = $2',
  [workerIdentity, db.config.user])).n;

/* ------------------------------------------------------------- HTTP caller */

function cookieOf(response) {
  const header = response.headers['set-cookie'];
  if (!header) return null;
  const pair = String(Array.isArray(header) ? header[0] : header).split(';')[0];
  return pair.endsWith('=') ? null : pair;
}

function caller(api) {
  return async (method, pathName, { cookie, body } = {}) => {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await api.handle({
      method, path: pathName, headers, originChecked: true,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* not JSON */ }
    return { status: response.status, json, headers: response.headers };
  };
}

async function signUp(call, tag) {
  const email = `${tag}-${randomUUID().slice(0, 8)}@worker-wire.invalid`;
  const password = `pw-${randomUUID()}`;
  const res = await call('POST', '/api/auth/sign-up/email', { body: { name: `Synthetic ${tag}`, email, password } });
  assert.equal(res.status, 200, `sign-up ${tag}: ${res.status}`);
  const cookie = cookieOf(res);
  const who = await call('GET', '/api/v1/account', { cookie });
  return { cookie, userId: who.json.id, email };
}

async function submit(call, cookie, text, eventId = randomUUID()) {
  const created = await call('POST', '/api/v1/attempts', { cookie, body: {} });
  assert.equal(created.status, 201, `create: ${created.status}`);
  const saved = await call('PUT', `/api/v1/attempts/${created.json.id}`, { cookie, body: { expectedRevision: 1, text } });
  assert.equal(saved.status, 200, `save: ${saved.status}`);
  const sent = await call('POST', `/api/v1/attempts/${created.json.id}/submissions`,
    { cookie, body: { expectedRevision: 2, eventId } });
  assert.equal(sent.status, 202, `submit: ${sent.status}`);
  return { attemptId: created.json.id, submissionId: sent.json.submissionId, eventId };
}

/* ---------------------------------------------------------------- harness */

const checks = [];
const check = (name, run) => checks.push({ name, run });

async function until(fn, { timeoutMs = 5000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error('condition not met within the bounded wait');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const floated = [];
function float(promise) { promise.catch((error) => floated.push(error)); return promise; }

/** Drain queued jobs left by an earlier leg with the default stub, bounded. */
async function drain(max = 25) {
  const worker = createWorker({ pool: db.worker });
  for (let i = 0; i < max; i += 1) {
    const outcome = await worker.runOnce();
    if (!outcome.claimed) return;
  }
  throw new Error('queue did not drain within the bounded count');
}

/* --------------------------------------------------- the real worker child */

const CLI = path.resolve(fileURLToPath(new URL('../server/worker.mjs', import.meta.url)));

/**
 * Start `node server/worker.mjs` as a real child process against the fixture database.
 * The startup wait is bounded and keyed on THIS child's own backend appearing in
 * `pg_stat_activity` as `<schema>:worker` — tracked by backend pid, so a sibling worker
 * already running cannot be mistaken for this one. `stop()` kills it and proves ITS backend
 * is gone, again by pid, so it does not depend on being the last worker alive.
 */
async function startWorker({ intervalMs = 100, startMs = 15000 } = {}) {
  const env = {
    ...process.env,
    OWNAPI_PG_HOST: db.config.host,
    OWNAPI_PG_PORT: String(db.config.port),
    OWNAPI_PG_DATABASE: db.config.database,
    OWNAPI_PG_USER: db.config.user,
    OWNAPI_PG_SCHEMA: db.schema,
    OWNAPI_PG_ROLE_PREFIX: db.schema,
  };
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
  const seen = new Set(await workerPids());
  const child = spawn(process.execPath, [CLI, `--interval=${intervalMs}`], { cwd: path.dirname(CLI) + '/..', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += String(c); });
  child.stderr.on('data', (c) => { out += String(c); });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  let pid = null;
  const deadline = Date.now() + startMs;
  for (;;) {
    if (exited) throw new Error(`the worker exited early (code ${exited.code}, signal ${exited.signal}): ${out.slice(-300)}`);
    const fresh = (await workerPids()).filter((p) => !seen.has(p));
    if (fresh.length) { pid = fresh[0]; break; }
    if (Date.now() > deadline) throw new Error(`the worker did not connect within ${startMs}ms: ${out.slice(-300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const stop = async () => {
    if (!exited) { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
    const goneDeadline = Date.now() + 5000;
    for (;;) {
      if (!(await workerPids()).includes(pid)) return;
      if (Date.now() > goneDeadline) throw new Error(`the worker backend ${pid} was still present 5s after SIGKILL`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { child, pid, log: () => out, stop };
}

/** Bounded wait for a submission's job to reach a status, via the privileged read path. */
async function awaitJobStatus(submissionId, status, timeoutMs = 25000) {
  await until(async () => (await jobRow(submissionId)).status === status, { timeoutMs });
  return jobRow(submissionId);
}

/* ================================================================== legs */

check('W1. crash recovery end to end: an abandoned running job is completed by a real process, exactly one assessment and one debit', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'w1');
  const s = await submit(call, a.cookie, 'Text für die Absturzwiederherstellung.');
  assert.equal((await jobRow(s.submissionId)).status, 'queued');
  assert.equal((await entitlement(a.userId)).reserved, 1);

  // A crashed worker, simulated: it CLAIMS the job (tries=1, lease held) and then never
  // commits because its grade hangs. leaseMs=1 makes the lease already lapsed. A real crash
  // leaves exactly this state, and a real process cannot be timed against a ~instant stub.
  const crashed = createWorker({ pool: db.worker, grade: () => new Promise(() => {}), leaseMs: 1 });
  float(crashed.runOnce());
  await until(async () => (await jobRow(s.submissionId)).status === 'running');
  assert.equal((await jobRow(s.submissionId)).tries, 1, 'the abandoned claim consumed a try');

  // DISCRIMINATION: with no recovery process, the abandoned job does not heal itself.
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await jobRow(s.submissionId)).status, 'running', 'a lapsed lease alone must not complete the job');

  // The recovery is another REAL process.
  const worker = await startWorker();
  try {
    const done = await awaitJobStatus(s.submissionId, 'succeeded', 25000);
    assert.equal(done.tries, 2, 'the recovering process claimed it afresh');
    assert.equal(await assessmentCount(s.submissionId), 1, 'exactly one assessment');
    assert.equal(await ledgerUnits(s.submissionId), 1, 'exactly one debit');
    const ent = await entitlement(a.userId);
    assert.deepEqual([ent.used, ent.reserved], [1, 0], 'one debit, reservation released');
    const assessment = await one('SELECT * FROM assessments WHERE submission_id = $1', [s.submissionId]);
    assert.equal(assessment.model_version, stubGrade().modelVersion, 'the stub graded it (no provider call)');
  } finally {
    await worker.stop();
  }
  return 'abandoned(running, lease lapsed, tries=1) -> real process reclaimed -> succeeded, tries=2, assessments=1, ledger=1, used=1/reserved=0; discrimination: it stayed running for 1.2s with no recovery process';
});

check('W2. two workers, one job: two REAL child processes race one queued job, exactly one processes it', async () => {
  const call = caller(world.api);
  await drain();

  // Start BOTH children first and prove both are connected and contending, then queue the job.
  const a = await startWorker();
  const b = await startWorker();
  try {
    assert.equal(await workerBackends(), 2, 'both children are connected (a real race, not one worker twice)');
    const account = await signUp(call, 'w2');
    const s = await submit(call, account.cookie, 'Text für die Nebenläufigkeit zweier Prozesse.');

    await awaitJobStatus(s.submissionId, 'succeeded', 25000);
    assert.equal(await assessmentCount(s.submissionId), 1, 'exactly one assessment across two processes');
    assert.equal(await ledgerUnits(s.submissionId), 1, 'exactly one debit across two processes');
    const ent = await entitlement(account.userId);
    assert.deepEqual([ent.used, ent.reserved], [1, 0]);
    assert.equal((await jobRow(s.submissionId)).tries, 1, 'only one process claimed it');
  } finally {
    await a.stop();
    await b.stop();
  }
  return 'two real processes connected simultaneously -> one job -> assessments=1, ledger=1, tries=1; discrimination: both backends were seen concurrently';
});

check('W3. the worker cannot exceed its role: the child connects as <prefix>_worker and a privileged op through that role fails', async () => {
  const worker = await startWorker();
  try {
    assert.equal(await workerBackends(), 1, 'one worker backend');
    assert.equal(await backendsAsAdmin(), 0, 'the worker did NOT connect as the superuser/admin user');

    // The child's own backend, as seen by the superuser: which role did it connect as?
    const identity = await one(
      'SELECT usename FROM pg_stat_activity WHERE application_name = $1 AND usename = $2 LIMIT 1',
      [workerIdentity, workerRole]);
    assert.equal(identity.usename, workerRole, 'the child connection is the restricted worker role');
    // Its role's own properties, read THROUGH that role (so current_user is the worker role,
    // not this checker's superuser session).
    const role = (await db.worker.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.deepEqual([role.rolsuper, role.rolbypassrls], [false, false], 'the worker role is NOSUPERUSER and NOBYPASSRLS');

    // A privileged operation through the restricted role FAILS.
    await assert.rejects(() => db.worker.query('CREATE TABLE wire_w3_should_fail (id int)'), /permission denied/i);
    await assert.rejects(() => db.worker.query('SELECT count(*) FROM "user"'), /permission denied/i);
    // DISCRIMINATION: the same read succeeds for the privileged role, so the failure is the
    // grant and not a broken statement.
    assert.equal((await one('SELECT count(*)::int AS n FROM "user"')).n >= 0, true, 'the superuser CAN read it');
  } finally {
    await worker.stop();
  }
  return 'child backend usename=<prefix>_worker, not admin, NOSUPERUSER/NOBYPASSRLS; CREATE TABLE and "user" SELECT refused; discrimination: superuser read succeeds';
});

check('W4. a failing grader does not lose the submission: failed + stable code, reserved released, text readable, retry() completes via a real process', async () => {
  const call = caller(world.api);
  await drain();
  const a = await signUp(call, 'w4');
  const text = 'Text für den fehlschlagenden Bewerter.';
  const s = await submit(call, a.cookie, text);

  // The grader throws ONCE. There is no CLI hook to make the stub throw, so the injected
  // failure is in-process; the RECOVERY (the retry completing) is a real child process.
  let calls = 0;
  const grader = () => {
    calls += 1;
    if (calls === 1) { const error = new Error('stub grader unavailable'); error.code = 'grader_unavailable'; throw error; }
    return stubGrade();
  };
  const outcome = await createWorker({ pool: db.worker, grade: grader }).runOnce();
  assert.deepEqual(outcome, { claimed: true, submissionId: s.submissionId, outcome: 'failed', code: 'grader_unavailable' });

  const failed = await jobRow(s.submissionId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_code, 'grader_unavailable', 'a stable failure_code');
  assert.equal((await entitlement(a.userId)).reserved, 0, 'a failure releases the reservation');
  assert.equal(await assessmentCount(s.submissionId), 0, 'no assessment on failure');
  assert.equal(await ledgerUnits(s.submissionId), 0, 'no debit on failure');

  // The learner's text is still readable.
  const attempt = await call('GET', `/api/v1/attempts/${s.attemptId}`, { cookie: a.cookie });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.json.text, text, 'the submitted text is still readable after a failed grade');

  // retry() re-queues, and a REAL process completes it.
  const retried = await call('POST', `/api/v1/submissions/${s.submissionId}/retry`, { cookie: a.cookie, body: {} });
  assert.equal(retried.status, 202);
  assert.deepEqual(retried.json, { queued: true });
  assert.equal((await jobRow(s.submissionId)).status, 'queued');
  assert.equal((await entitlement(a.userId)).reserved, 1, 'retry reserves again');

  const worker = await startWorker();
  try {
    await awaitJobStatus(s.submissionId, 'succeeded', 25000);
    assert.equal(await assessmentCount(s.submissionId), 1, 'the real process completed the retried job');
    const ent = await entitlement(a.userId);
    assert.deepEqual([ent.used, ent.reserved], [1, 0]);
  } finally {
    await worker.stop();
  }
  return 'failed(grader_unavailable) with reserved released and text readable -> retry() re-queued -> real process succeeded, assessments=1, used=1/reserved=0';
});

check('W0. control: with nothing queued, a real worker process claims nothing and writes nothing', async () => {
  await drain();
  assert.equal(await queuedCount(), 0, 'precondition: no queued job');
  const fingerprint = JSON.stringify(await one(
    `SELECT (SELECT count(*) FROM jobs) AS jobs, (SELECT count(*) FROM assessments) AS assessments,
            (SELECT count(*) FROM usage_ledger) AS ledger, (SELECT coalesce(sum(used),0) FROM entitlements) AS used`));
  const worker = await startWorker();
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const after = JSON.stringify(await one(
      `SELECT (SELECT count(*) FROM jobs) AS jobs, (SELECT count(*) FROM assessments) AS assessments,
              (SELECT count(*) FROM usage_ledger) AS ledger, (SELECT coalesce(sum(used),0) FROM entitlements) AS used`));
    assert.equal(after, fingerprint, 'an idle real worker changes nothing');
  } finally {
    await worker.stop();
  }
  assert.deepEqual(floated, [], `a background promise rejected: ${floated.map((e) => e && e.message).join('; ')}`);
  return 'no queued job: the real process stayed idle and changed no row';
});

/* =================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runWorkerWireChecks({ only = null } = {}) {
  const selected = only ? checks.filter((c) => c.name.includes(only)) : checks;
  const report = [];
  try {
    world = await createPostgresWorld({ fixture: db });
    for (const { name, run } of selected) {
      try {
        const detail = await run();
        report.push({ name, ok: true, detail });
      } catch (error) {
        report.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
      }
    }
  } finally {
    await teardown();
  }
  return { ok: report.every((r) => r.ok), results: report };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv.includes('--list')) {
    for (const { name } of checks) console.log(name);
    process.exitCode = 0;
  } else {
    const onlyArg = process.argv.find((a) => a.startsWith('--only='));
    const only = onlyArg ? onlyArg.slice('--only='.length) : null;
    const report = await runWorkerWireChecks({ only });
    for (const r of report.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}\n     ${r.detail}`);
      if (!r.ok && r.error && r.error.stack) console.log(r.error.stack.split('\n').slice(1, 4).join('\n'));
    }
    const failed = report.results.filter((r) => !r.ok).length;
    console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
    console.log('NOTE disposable PostgreSQL, REAL separate worker processes and the REAL adapter/API; the grader is a deterministic stub (no provider call).');
    process.exitCode = failed ? 1 : 0;
  }
}
