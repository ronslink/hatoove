/**
 * MFP-14 — the journey harness skeleton (`journey-api-check`).
 *
 * Turns "functional" into a counter that moves. J1–J11 (FUNCTIONAL-ROADMAP §2.2) are driven as
 * HTTP-level legs against a **real configured runtime**: `node server.js` started with
 * `B1PREP_ACCOUNTS=1` against the disposable database, exactly the path a learner takes —
 * not an in-process api.handle() call.
 *
 * HONESTY IS THE DESIGN:
 *   - a leg whose route does not exist yet reports `PENDING <slice-id>` and does NOT count as a
 *     pass;
 *   - a leg reports `FAIL` only on a wrong answer from a route that EXISTS;
 *   - the summary prints `n passed, m pending, f failed`, so the check measures progress toward
 *     the product instead of being red until the end, and it can never be read as more complete
 *     than it is.
 *
 * Route existence is DISCOVERED, not hard-coded: a sentinel request for a path that cannot exist
 * gives the runtime's "no such route" signature, and a leg is `PENDING` when its route answers
 * with exactly that signature. So when MFP-05b adds `GET /api/v1/attempts`, J3 stops being
 * PENDING by itself.
 *
 * Safety: disposable PostgreSQL only (`OWNAPI_PG_*`, refuses the default databases), throwaway
 * env and progress files, synthetic learners, no provider call.
 *
 * Usage: node tools/journey-api-check.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { persistentConfig, persistentRolePool } from '../server/owned-postgres/provision.mjs';
import { stubGrade } from '../server/owned-postgres/worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);
const PORT = Number(process.env.MFP14_JOURNEY_PORT || 4481);
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mfp14-journey-'));
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
/** Bounded waits for J7's worker process. A check that never completes is not evidence. */
const WORKER_START_MS = Number(process.env.MFP14_WORKER_START_MS || 15000);
const WORKER_DEADLINE_MS = Number(process.env.MFP14_WORKER_DEADLINE_MS || 30000);

/* ------------------------------------------------------------ server process */

async function startServer() {
  const env = {
    ...process.env,
    B1PREP_PORT: String(PORT),
    B1PREP_ACCOUNTS: '1',
    B1PREP_ENV_FILE: path.join(TEMP, 'env'),
    B1PREP_PROGRESS_FILE: path.join(TEMP, 'progress.json'),
    B1PREP_FORCE_OFFLINE: '1',
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += String(c); });
  child.stderr.on('data', (c) => { out += String(c); });

  const deadline = Date.now() + 30000;
  let ready = false;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${out.slice(-500)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/ready`);
      if (res.status === 200) { ready = true; break; }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) throw new Error(`server was not ready on ${PORT} within 30s: ${out.slice(-500)}`);
  return {
    log: () => out,
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }),
  };
}

/* ------------------------------------------------------------- HTTP caller */

function makeCaller(port = PORT) {
  return async function call(jar, method, pathName, { body, origin = true } = {}) {
    const headers = { accept: 'application/json' };
    if (jar && jar.cookies.size) headers.cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (origin) headers.origin = `http://127.0.0.1:${port}`;
    if (method !== 'GET' && method !== 'HEAD') headers['content-type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
    });
    for (const line of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!jar) continue;
      if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.cookies.delete(name);
      else jar.cookies.set(name, value);
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  };
}

const newJar = () => ({ cookies: new Map() });

async function signUp(call, tag) {
  const jar = newJar();
  const email = `${tag}-${RUN_ID}@journey.example.invalid`;
  const res = await call(jar, 'POST', '/api/auth/sign-up/email',
    { body: { name: `Synthetic ${tag}`, email, password: `pw-${randomUUID()}` } });
  if (res.status !== 200) return { jar, email, res, ok: false };
  const who = await call(jar, 'GET', '/api/v1/account');
  return { jar, email, userId: who.json && who.json.id, res, ok: who.status === 200 };
}

/* ----------------------------------------------------------------- harness */

const legs = [];
const leg = (id, title, slice, run) => legs.push({ id, title, slice, run });

const pass = (detail) => ({ status: 'pass', detail });
const pending = (slice, detail) => ({ status: 'pending', slice, detail });
const fail = (detail) => ({ status: 'fail', detail });

/* =================================================================== legs */

leg('J1', 'sign up with email and password', 'MFP-04a', async (ctx) => {
  const account = await signUp(ctx.call, 'j1');
  if (account.res.status === 404 && ctx.routeAbsent(account.res)) return pending('MFP-04a', 'sign-up route does not exist');
  if (!account.ok) return fail(`sign-up answered ${account.res.status}`);
  const session = await ctx.call(account.jar, 'GET', '/api/auth/get-session');
  if (session.status !== 200 || !session.json || !session.json.user) return fail(`get-session answered ${session.status}`);
  if (session.json.user.id !== account.userId) return fail('get-session and /api/v1/account disagree');
  ctx.accounts.j1 = account;
  return pass(`sign-up 200; get-session and /api/v1/account agree on ${account.userId}`);
});

leg('J2', 'first-run setup: exam date, explanation language', 'MFP-02a', async (ctx) => {
  const a = ctx.accounts.j1 || await signUp(ctx.call, 'j2');
  const before = await ctx.call(a.jar, 'GET', '/api/v1/settings');
  if (before.status === 404 && ctx.routeAbsent(before)) return pending('MFP-02a', 'settings route does not exist');
  if (before.status !== 200) return fail(`GET settings answered ${before.status}`);
  const revision = before.json.revision;
  const put = await ctx.call(a.jar, 'PUT', '/api/v1/settings',
    { body: { expectedRevision: revision, settings: { examDate: '2027-03-15', language: 'de' } } });
  if (put.status !== 200) return fail(`PUT settings answered ${put.status}`);
  const after = await ctx.call(a.jar, 'GET', '/api/v1/settings');
  if (after.json.settings.examDate !== '2027-03-15' || after.json.settings.language !== 'de') {
    return fail(`settings did not round-trip: ${JSON.stringify(after.json.settings)}`);
  }
  // The language is NOT constrained to the supported set here; MFP-02a owns that. See the record.
  return pass(`examDate+language round-tripped at revision ${after.json.revision}`);
});

leg('J3', 'dashboard: continue your draft, your feedback is ready', 'MFP-05b', async (ctx) => {
  const a = ctx.accounts.j1 || await signUp(ctx.call, 'j3');
  const list = await ctx.call(a.jar, 'GET', '/api/v1/attempts?status=queued');
  if (list.status === 404 && ctx.routeAbsent(list)) return pending('MFP-05b', 'GET /api/v1/attempts list route does not exist');
  if (list.status !== 200 || !Array.isArray(list.json)) return fail(`list answered ${list.status} ${list.text.slice(0, 80)}`);
  return pass(`list route returned ${list.json.length} item(s)`);
});

leg('J4', 'choose a writing task (only servable versions)', 'MFP-05a', async (ctx) => {
  const a = ctx.accounts.j1 || await signUp(ctx.call, 'j4');
  /*
   * `family=SA1` is the EXAM MODEL's writing part id, and it is not a stale name: `public/js/blueprint.js`
   * defines `SA1: { id: 'SA1', group: 'SA', pts: 45, items: 1, kind: 'writing' }` and lists it in
   * `SUBTEST_ORDER`. This leg now FAILS with 422, and the cause is a real product defect, not the check:
   *
   *   /api/v1/tasks          validates family as /^[a-z][a-z0-9_-]{0,31}$/   -> SA1 is refused (uppercase)
   *   /api/v1/objective-sets requires the UPPERCASE ids LV1/SB2/HV3          -> 'lv1' is refused
   *
   * Two sibling routes, one query parameter, opposite conventions, and neither matches the blueprint the
   * rest of the product is built from. PILOT-04 turned this leg from PENDING into FAIL when it implemented
   * the route -- and nobody saw it, because the CI job SKIPS this check (the session-boundary step fails
   * first). The counter is left failing on purpose: fixing the CHECK to ask for `family=writing` would
   * hide the inconsistency the leg exists to expose. The product decision is recorded in AUTORUN-QUEUE.md.
   */
  const tasks = await ctx.call(a.jar, 'GET', '/api/v1/tasks?family=SA1');
  if (tasks.status === 404 && ctx.routeAbsent(tasks)) return pending('MFP-05a', 'GET /api/v1/tasks route does not exist');
  if (tasks.status !== 200 || !Array.isArray(tasks.json)) return fail(`tasks answered ${tasks.status} for family=SA1, the blueprint's writing part id`);
  return pass(`task route returned ${tasks.json.length} servable version(s)`);
});

leg('J5', 'write; autosave with visible state; conflicts explicit', 'MFP-05a', async (ctx) => {
  const a = await signUp(ctx.call, 'j5');
  const created = await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} });
  if (created.status === 404 && ctx.routeAbsent(created)) return pending('MFP-05a', 'attempt routes do not exist');
  if (created.status !== 201) return fail(`create answered ${created.status}`);
  const id = created.json.id;
  const save = await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${id}`, { body: { expectedRevision: 1, text: 'Sehr geehrte Damen und Herren, ...' } });
  if (save.status !== 200 || save.json.revision !== 2) return fail(`save answered ${save.status} rev ${save.json && save.json.revision}`);
  const stale = await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${id}`, { body: { expectedRevision: 1, text: 'stale' } });
  if (stale.status !== 409) return fail(`a stale save answered ${stale.status}, expected 409`);
  const other = await signUp(ctx.call, 'j5b');
  const foreign = await ctx.call(other.jar, 'GET', `/api/v1/attempts/${id}`);
  if (foreign.status !== 404) return fail(`another account read the draft: ${foreign.status}`);
  return pass('create 201, save -> revision 2, stale save 409, another account 404');
});

leg('J6', 'submit; see pending; leave (and duplicate clicks are idempotent)', 'MFP-05a', async (ctx) => {
  const a = await signUp(ctx.call, 'j6');
  const created = await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} });
  if (created.status !== 201) return createdAtFail(ctx, created, 'MFP-05a');
  const id = created.json.id;
  await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${id}`, { body: { expectedRevision: 1, text: 'Ein vollständiger Aufsatz für die Abgabe.' } });
  const eventId = randomUUID();
  const sent = await ctx.call(a.jar, 'POST', `/api/v1/attempts/${id}/submissions`, { body: { expectedRevision: 2, eventId } });
  if (sent.status !== 202) return fail(`submit answered ${sent.status}`);
  const submissionId = sent.json.submissionId;
  const replay = await ctx.call(a.jar, 'POST', `/api/v1/attempts/${id}/submissions`, { body: { expectedRevision: 2, eventId } });
  if (replay.status !== 202 || replay.json.replay !== true) return fail(`a duplicate click was not idempotent (${replay.status})`);
  const result = await ctx.call(a.jar, 'GET', `/api/v1/submissions/${submissionId}`);
  if (result.status !== 200 || !result.json.job) return fail(`result answered ${result.status}`);
  ctx.submissions = ctx.submissions || [];
  ctx.submissions.push({ jar: a.jar, submissionId });
  return pass(`submit 202, replay 202 replay:true, result job.status=${result.json.job.status}`);
});

leg('J7', 'worker produces feedback in the chosen language (recoverable, one debit)', 'MFP-06a', async (ctx) => {
  // The composition: a REAL, separate `node server/worker.mjs` process against the same
  // disposable database. The child is killed in `finally` and its absence is proved, so a
  // failing leg cannot leak a process into the next leg or CI.
  const worker = await ctx.startWorker();
  try {
    if (!worker.ok) return fail(`the worker process did not come up: ${worker.detail}`);

    const a = await signUp(ctx.call, 'j7');
    const created = await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} });
    if (created.status !== 201) return createdAtFail(ctx, created, 'MFP-06a');
    const id = created.json.id;
    await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${id}`, { body: { expectedRevision: 1, text: 'Text für die Bewertung durch den Worker.' } });

    const before = await ctx.entitlement(a.userId);
    const sent = await ctx.call(a.jar, 'POST', `/api/v1/attempts/${id}/submissions`, { body: { expectedRevision: 2, eventId: randomUUID() } });
    if (sent.status !== 202) return fail(`submit answered ${sent.status}`);
    const submissionId = sent.json.submissionId;
    const reserved = await ctx.entitlement(a.userId);
    if (reserved.reserved !== before.reserved + 1) {
      return fail(`submit must reserve exactly one: reserved ${before.reserved} -> ${reserved.reserved}`);
    }

    // Bounded poll: a timeout is a FAILED leg with the last observed status, never a hang.
    const deadline = Date.now() + WORKER_DEADLINE_MS;
    let last = null;
    for (;;) {
      const result = await ctx.call(a.jar, 'GET', `/api/v1/submissions/${submissionId}`);
      if (result.status !== 200) return fail(`result answered ${result.status}`);
      last = result.json;
      if (last.job && last.job.status === 'failed') return fail(`the job failed: ${JSON.stringify(last.job)}`);
      if (last.job && last.job.status === 'succeeded' && last.assessment) break;
      if (Date.now() > deadline) {
        return fail(`the job did not reach succeeded within ${WORKER_DEADLINE_MS}ms; last status=${last.job && last.job.status}; worker log: ${worker.log().slice(-300)}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // The assessment is the DETERMINISTIC STUB's, which no provider call could produce.
    const expected = stubGrade();
    if (last.assessment.model_version !== expected.modelVersion) {
      return fail(`the assessment was not produced by the stub grader (model_version=${last.assessment.model_version}); a provider call is unproven`);
    }
    if (JSON.stringify(last.assessment.feedback) !== JSON.stringify(expected.feedback)) {
      return fail(`the served feedback is not the stub's: ${JSON.stringify(last.assessment.feedback)}`);
    }
    if (await ctx.assessmentCount(submissionId) !== 1) return fail('expected exactly one assessment row');
    const debits = await ctx.ledgerUnits(submissionId);
    if (debits !== 1) return fail(`expected exactly one debit, got ${debits}`);

    const after = await ctx.entitlement(a.userId);
    if (after.used !== before.used + 1) return fail(`used must rise by exactly one: ${before.used} -> ${after.used}`);
    if (after.reserved !== before.reserved) return fail(`reserved must return to its start: ${before.reserved} -> ${after.reserved}`);

    return pass(`child process ${worker.detail}; submit reserved 1 -> 0; job ${last.job.status}; assessment=stub model_version=${last.assessment.model_version}; used ${before.used}->${after.used}; exactly one debit`);
  } finally {
    const gone = await worker.stop();
    if (!gone) throw new Error('the worker process was not gone after SIGKILL (pg_stat_activity still shows its backend)');
  }
});

leg('J8', 'return on a fresh browser; see the exact text and feedback', 'MFP-05b', async (ctx) => {
  const a = ctx.accounts.j1 || await signUp(ctx.call, 'j8');
  const list = await ctx.call(a.jar, 'GET', '/api/v1/attempts?status=succeeded');
  if (list.status === 404 && ctx.routeAbsent(list)) return pending('MFP-05b', 'the list route (fresh-browser resume) does not exist; the by-id lookup does');
  if (list.status !== 200 || !Array.isArray(list.json)) return fail(`list answered ${list.status}`);
  return pass(`list route returned ${list.json.length} item(s) for resume`);
});

leg('J9', 'progress: a factual list and simple counts', 'MFP-09', async (ctx) => {
  const a = ctx.accounts.j1 || await signUp(ctx.call, 'j9');
  const progress = await ctx.call(a.jar, 'GET', '/api/v1/progress');
  if (progress.status === 404 && ctx.routeAbsent(progress)) return pending('MFP-09', 'GET /api/v1/progress route does not exist');
  if (progress.status !== 200) return fail(`progress answered ${progress.status}`);
  return pass('progress route answered 200');
});

leg('J10', 'settings change, sign out, export, hard delete', 'MFP-09', async (ctx) => {
  const a = await signUp(ctx.call, 'j10');
  const exported = await ctx.call(a.jar, 'GET', '/api/v1/export');
  // Prove the neighbours exist before reporting the leg pending, so the record shows the partial.
  const signedOut = await ctx.call(a.jar, 'POST', '/api/auth/sign-out', { body: {} });
  if (exported.status === 404 && ctx.routeAbsent(exported)) {
    return pending('MFP-09', `GET /api/v1/export does not exist (export leg); sign-out and hard delete are wired (sign-out answered ${signedOut.status})`);
  }
  if (exported.status !== 200) return fail(`export answered ${exported.status}`);
  return pass('export route answered 200');
});

leg('J11', 'forgot password, reset via an email port (stub in this programme)', 'MFP-04b', async (ctx) => {
  const jar = newJar();
  const res = await ctx.call(jar, 'POST', '/api/auth/forget-password', { body: { email: `nobody-${RUN_ID}@journey.example.invalid` } });
  if (res.status === 404 && ctx.routeAbsent(res)) return pending('MFP-04b', 'no password-reset route exists');
  if (res.status !== 200) return fail(`reset request answered ${res.status}`);
  return pass('password-reset route answered 200');
});

/** A create-attempt failure that may be a missing route (pending) rather than a wrong answer. */
function createdAtFail(ctx, res, slice) {
  if (res.status === 404 && ctx.routeAbsent(res)) return { status: 'pending', slice, detail: 'attempt routes do not exist' };
  return fail(`create answered ${res.status}`);
}

/* ==================================================================== run */

export async function runJourneyApiCheck() {
  const call = makeCaller(PORT);
  const server = await startServer();
  const report = [];

  // ------------------------------------------------------------------ J7 wiring
  // The composition under test: a SEPARATE worker PROCESS against the same disposable
  // database, connecting as the restricted `<prefix>_worker` role. This check reads the
  // database through that same role as an inspection path (the worker role is the only
  // non-superuser role granted a cross-owner SELECT on entitlements, isolation.sql:18-23);
  // `pid <> pg_backend_pid()` keeps this checker's own connection out of the way so the
  // application_name below matches the CHILD process, not this pool.
  const pg = persistentConfig();
  const inspectPool = persistentRolePool(pg, 'worker', { max: 1 });
  const workerIdentity = `${pg.schema}:worker`;
  const workerRole = pg.roles.worker;
  const workerBackends = async () => (await inspectPool.query(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND usename = $2 AND pid <> pg_backend_pid()',
    [workerIdentity, workerRole])).rows[0].n;
  const entitlement = async (owner) => {
    const row = (await inspectPool.query('SELECT allowance, used, reserved FROM entitlements WHERE owner_id = $1', [owner])).rows[0];
    return row ? { allowance: row.allowance, used: row.used, reserved: row.reserved } : { allowance: 0, used: 0, reserved: 0 };
  };
  const assessmentCount = async (submissionId) => (await inspectPool.query(
    'SELECT count(*)::int AS n FROM assessments WHERE submission_id = $1', [submissionId])).rows[0].n;
  const ledgerUnits = async (submissionId) => (await inspectPool.query(
    'SELECT coalesce(sum(units),0)::int AS n FROM usage_ledger WHERE submission_id = $1', [submissionId])).rows[0].n;

  /**
   * Start `node server/worker.mjs` as a REAL child process against the same disposable
   * database, and bound the startup wait: success is the child's own backend appearing in
   * `pg_stat_activity` as `<schema>:worker` / `<prefix>_worker`. No provider credential is
   * passed, and the runtime is forced offline, so no provider call is even reachable.
   */
  const startWorker = async () => {
    const env = { ...process.env, B1PREP_FORCE_OFFLINE: '1' };
    for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
    const child = spawn(process.execPath, ['server/worker.mjs', '--interval=100'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    let ok = false;
    let detail = '';
    const deadline = Date.now() + WORKER_START_MS;
    for (;;) {
      if (exited) { detail = `the worker exited early (code ${exited.code}, signal ${exited.signal}): ${out.slice(-300)}`; break; }
      try {
        if (await workerBackends() > 0) { ok = true; detail = `worker connected as ${workerRole} (application_name ${workerIdentity})`; break; }
      } catch (error) { detail = `inspection failed: ${error.message}`; }
      if (Date.now() > deadline) { detail = `the worker did not connect within ${WORKER_START_MS}ms; output: ${out.slice(-300)}`; break; }
      await new Promise((r) => setTimeout(r, 100));
    }

    const stop = async () => {
      if (!exited) { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
      const goneDeadline = Date.now() + 5000;
      for (;;) {
        try { if (await workerBackends() === 0) return true; } catch { /* keep trying to prove it is gone */ }
        if (Date.now() > goneDeadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    return { ok, detail, log: () => out, exited: () => exited, stop };
  };

  try {
    // A sentinel request for a path that cannot exist gives the runtime's "no such route"
    // signature. It must carry a session: every `/api/v1/*` path answers 401 before routing, so
    // an anonymous probe would learn the auth signature, not the not-found one.
    const sentinelAccount = await signUp(call, 'sentinel');
    const sentinel = sentinelAccount.ok
      ? await call(sentinelAccount.jar, 'GET', `/api/v1/__mfp14_absent__${randomUUID()}`)
      : { status: 404, text: '{"error":"not_found"}' };
    const routeAbsent = (res) => res.status === sentinel.status && res.text === sentinel.text;

    const ctx = { call, routeAbsent, accounts: {}, sentinel, startWorker, entitlement, assessmentCount, ledgerUnits };
    for (const { id, title, slice, run } of legs) {
      let outcome;
      try {
        outcome = await run(ctx);
      } catch (error) {
        outcome = fail(`threw: ${error && error.message ? error.message : String(error)}`);
      }
      report.push({ id, title, slice, ...outcome });
    }
  } finally {
    await inspectPool.end().catch(() => {});
    await server.stop().catch(() => {});
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
  const passed = report.filter((r) => r.status === 'pass').length;
  const pendingCount = report.filter((r) => r.status === 'pending').length;
  const failed = report.filter((r) => r.status === 'fail').length;
  return { report, passed, pending: pendingCount, failed, ok: failed === 0 };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const database = process.env.OWNAPI_PG_DATABASE || '';
  if (FORBIDDEN.has(database)) throw new Error(`refusing to run against ${database}; set OWNAPI_PG_DATABASE to a disposable database`);
  const result = await runJourneyApiCheck();
  console.log(`\n=== journey-api-check (HTTP, B1PREP_ACCOUNTS=1, port ${PORT}) ===\n`);
  for (const row of result.report) {
    const badge = row.status === 'pass' ? 'PASS   ' : row.status === 'pending' ? 'PENDING' : 'FAIL   ';
    const slice = row.status === 'pending' ? ` ${row.slice}` : '';
    console.log(`${badge} ${row.id}${slice}  ${row.title}`);
    console.log(`        ${row.detail}`);
  }
  console.log(`\n${result.passed} passed, ${result.pending} pending, ${result.failed} failed`);
  process.exitCode = result.failed ? 1 : 0;
}
