/**
 * Saved learner journeys over the real HTTP runtime and a disposable PostgreSQL schema.
 * These routes are shipped contracts: a missing route fails rather than becoming pending.
 * The separate worker uses the deterministic stub, never a live provider. API assertions
 * cover saved data and ownership; rendered interaction is covered by app-browser-check.
 * Password recovery here proves only the generic request contract; auth-entry-check drives
 * the actual operator-assisted reset and fresh sign-in.
 *
 * Safety: synthetic accounts, throwaway env file, isolated ports and disposable OWNAPI_PG_*.
 * Usage: node tools/journey-api-check.mjs
 */

import assert from 'node:assert/strict';
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
    B1PREP_FORCE_OFFLINE: '1',
    // Opt only this isolated child into deliberately unreviewed fixture content.
    B1PREP_CONTENT_MODE: 'internal-preview',
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
  const password = `pw-${randomUUID()}`;
  const res = await call(jar, 'POST', '/api/auth/sign-up/email',
    { body: { name: `Synthetic ${tag}`, email, password } });
  expect(res);
  const who = expect(await call(jar, 'GET', '/api/v1/account'));
  assert.ok(who.id, 'a synthetic account must resolve before its journey starts');
  return { jar, email, password, userId: who.id, res, ok: true };
}

function expect(response, status = 200) {
  assert.equal(response.status, status, `expected HTTP ${status}; got ${response.status}: ${response.text.slice(0, 160)}`);
  assert.ok(response.json && typeof response.json === 'object', 'expected a JSON response');
  return response.json;
}
/* ----------------------------------------------------------------- harness */

const legs = [];
const leg = (id, title, slice, run) => legs.push({ id, title, slice, run });
const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });

leg('J1', 'sign up with email and password', 'MFP-04a', async (ctx) => {
  const account = await signUp(ctx.call, 'j1');
  const session = expect(await ctx.call(account.jar, 'GET', '/api/auth/get-session'));
  assert.equal(session.user.id, account.userId);
  ctx.accounts.j1 = account;
  return pass('sign-up, session and owned account agree');
});

leg('J2', 'first-run setup preserves the supported explanation language', 'MFP-02a', async (ctx) => {
  const a = ctx.accounts.j1;
  const before = expect(await ctx.call(a.jar, 'GET', '/api/v1/settings'));
  assert.equal(before.settings.language, 'de');
  const saved = expect(await ctx.call(a.jar, 'PUT', '/api/v1/settings',
    { body: { expectedRevision: before.revision, settings: { examDate: '2027-03-15', language: 'uk' } } }));
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.settings.examDate, '2027-03-15');
  assert.equal(saved.settings.language, 'uk');
  assert.deepEqual(expect(await ctx.call(a.jar, 'GET', '/api/v1/settings')), saved);
  expect(await ctx.call(a.jar, 'PUT', '/api/v1/settings',
    { body: { expectedRevision: saved.revision, settings: { language: 'fr' } } }), 422);
  assert.deepEqual(expect(await ctx.call(a.jar, 'GET', '/api/v1/settings')), saved);
  return pass('German default, Ukrainian selection, revision round-trip; unsupported language writes nothing');
});

leg('J3', 'discover and reopen an owned saved draft through history', 'MFP-05b', async (ctx) => {
  const a = ctx.accounts.j1;
  const created = expect(await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} }), 201);
  const text = 'Liebe Freundin, ich freue mich auf deinen Besuch. Viele Grüße.';
  const saved = expect(await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${created.id}`,
    { body: { expectedRevision: created.revision, text } }));
  const history = expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts')).attempts;
  const open = expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts?open=1')).attempts;
  assert.ok(Array.isArray(history) && Array.isArray(open));
  assert.equal(history.length, 1);
  assert.equal(history[0].id, created.id);
  assert.equal(history[0].status, 'draft');
  assert.equal(history[0].revision, saved.revision);
  assert.deepEqual(open.map(row => row.id), [created.id]);
  assert.equal('text' in history[0], false, 'the index must not expose draft bodies');
  assert.equal(expect(await ctx.call(a.jar, 'GET', `/api/v1/attempts/${created.id}`)).text, text);
  expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts?status=queued'), 422);
  ctx.dashboardDraft = { id: created.id, text };
  return pass('history/open indexes contain the saved revision; by-id read returns exact text; obsolete filter refused');
});

leg('J4', 'choose a servable writing task through either supported family form', 'MFP-05a', async (ctx) => {
  const a = ctx.accounts.j1;
  const tasks = expect(await ctx.call(a.jar, 'GET', '/api/v1/tasks?family=SA1'));
  const byKind = expect(await ctx.call(a.jar, 'GET', '/api/v1/tasks?family=writing'));
  assert.ok(Array.isArray(tasks) && tasks.length > 0, 'writing catalogue must be nonempty');
  assert.deepEqual(tasks, byKind, 'writing part and kind must select the same versions');
  for (const task of tasks) {
    assert.equal(task.family, 'writing');
    assert.ok(task.task_id && task.version && task.rubric_id && task.rubric_version);
    assert.ok(['approved', 'unreviewed'].includes(task.review_status));
  }
  expect(await ctx.call(a.jar, 'GET', '/api/v1/tasks?family=sa1'), 422);
  return pass(`${tasks.length} bound writing versions; SA1 and writing agree; invalid casing refused`);
});

leg('J5', 'save exact text; reject stale and foreign draft access', 'MFP-05a', async (ctx) => {
  const a = await signUp(ctx.call, 'j5');
  const created = expect(await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} }), 201);
  const text = 'Sehr geehrte Damen und Herren, ich schreibe wegen des Kurses.';
  const saved = expect(await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${created.id}`,
    { body: { expectedRevision: created.revision, text } }));
  assert.equal(saved.revision, created.revision + 1);
  assert.equal(saved.text, text);
  const stale = expect(await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${created.id}`,
    { body: { expectedRevision: created.revision, text: 'stale' } }), 409);
  assert.equal(stale.error, 'draft_conflict');
  const read = expect(await ctx.call(a.jar, 'GET', `/api/v1/attempts/${created.id}`));
  assert.equal(read.text, text); assert.equal(read.revision, saved.revision);
  expect(await ctx.call(ctx.accounts.j1.jar, 'GET', `/api/v1/attempts/${created.id}`), 404);
  ctx.otherDraft = { id: created.id, text };
  return pass('saved revision/text preserved after stale409; another account404');
});

leg('J6', 'submit an immutable text; duplicate requests return one pending submission', 'MFP-05a', async (ctx) => {
  const a = await signUp(ctx.call, 'j6');
  const created = expect(await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} }), 201);
  const text = 'Ein vollständiger Aufsatz für die Abgabe.';
  const saved = expect(await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${created.id}`,
    { body: { expectedRevision: created.revision, text } }));
  const body = { expectedRevision: saved.revision, eventId: randomUUID() };
  const sent = expect(await ctx.call(a.jar, 'POST', `/api/v1/attempts/${created.id}/submissions`, { body }), 202);
  const replay = expect(await ctx.call(a.jar, 'POST', `/api/v1/attempts/${created.id}/submissions`, { body }), 202);
  assert.equal(replay.replay, true); assert.equal(replay.submissionId, sent.submissionId);
  const result = expect(await ctx.call(a.jar, 'GET', `/api/v1/submissions/${sent.submissionId}`));
  assert.equal(result.job.status, 'queued'); assert.equal(result.submission.text, text);
  assert.equal(result.assessment, null);
  const history = expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts')).attempts;
  assert.equal(history.length, 1); assert.equal(history[0].status, 'pending');
  assert.equal(history[0].submission_id, sent.submissionId);
  assert.deepEqual(expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts?open=1')).attempts, []);
  return pass('same event returns same submission; immutable text queued, indexed as pending, excluded from drafts');
});

leg('J7', 'worker keeps the snapshotted explanation language and debits exactly once', 'MFP-06a', async (ctx) => {
  const a = await signUp(ctx.call, 'j7');
  const settings = expect(await ctx.call(a.jar, 'GET', '/api/v1/settings'));
  const selected = expect(await ctx.call(a.jar, 'PUT', '/api/v1/settings',
    { body: { expectedRevision: settings.revision, settings: { language: 'ar' } } }));
  const created = expect(await ctx.call(a.jar, 'POST', '/api/v1/attempts', { body: {} }), 201);
  const submittedText = 'Liebe Frau Berger, ich bedanke mich für den Kurs. Ich möchte am nächsten Dienstag kommen und bringe alle Unterlagen mit. Viele Grüße.';
  const saved = expect(await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${created.id}`,
    { body: { expectedRevision: created.revision, text: submittedText } }));
  const before = await ctx.entitlement(a.userId);
  const sent = expect(await ctx.call(a.jar, 'POST', `/api/v1/attempts/${created.id}/submissions`,
    { body: { expectedRevision: saved.revision, eventId: randomUUID() } }), 202);
  const submissionId = sent.submissionId;
  const reserved = await ctx.entitlement(a.userId);
  assert.equal(reserved.reserved, before.reserved + 1);
  // Changing today's preference cannot change the language attached to an existing submission.
  expect(await ctx.call(a.jar, 'PUT', '/api/v1/settings',
    { body: { expectedRevision: selected.revision, settings: { language: 'de' } } }));
  const worker = await ctx.startWorker();
  try {
    assert.equal(worker.ok, true, worker.detail);
    const deadline = Date.now() + WORKER_DEADLINE_MS;
    let last;
    for (;;) {
      last = expect(await ctx.call(a.jar, 'GET', `/api/v1/submissions/${submissionId}`));
      assert.notEqual(last.job.status, 'failed', `worker failed: ${last.job.failure_code}`);
      if (last.job.status === 'succeeded' && last.assessment) break;
      assert.ok(Date.now() <= deadline, `worker exceeded ${WORKER_DEADLINE_MS}ms; last=${last.job.status}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const expected = stubGrade({ text: submittedText, explanationLanguage: 'ar' });
    assert.equal(last.submission.text, submittedText);
    assert.equal(last.submission.explanation_language, 'ar');
    assert.equal(last.assessment.model_version, expected.modelVersion);
    assert.deepEqual(last.assessment.feedback, expected.feedback);
    assert.equal(await ctx.assessmentCount(submissionId), 1);
    assert.equal(await ctx.ledgerUnits(submissionId), 1);
    const after = await ctx.entitlement(a.userId);
    assert.equal(after.used, before.used + 1); assert.equal(after.reserved, before.reserved);
    ctx.assessed = { account: a, attempt: created, submissionId, text: submittedText, result: last };
    return pass('Arabic snapshot survives preference change; exact stub feedback, one assessment and one debit');
  } finally {
    assert.equal(await worker.stop(), true, 'worker backend must be gone after the leg');
  }
});

leg('J8', 'fresh sign-in discovers exact feedback and saves a separate revision', 'MFP-05b', async (ctx) => {
  const original = ctx.assessed; assert.ok(original, 'J7 must have produced feedback');
  const a = original.account;
  const oldJar = { cookies: new Map(a.jar.cookies) };
  expect(await ctx.call(a.jar, 'POST', '/api/auth/sign-out', { body: {} }));
  expect(await ctx.call(oldJar, 'GET', '/api/v1/account'), 401);
  a.jar = newJar();
  expect(await ctx.call(a.jar, 'POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } }));
  const history = expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts')).attempts;
  assert.ok(Array.isArray(history)); assert.equal(history.length, 1);
  const row = history[0];
  assert.equal(row.id, original.attempt.id); assert.equal(row.status, 'assessed');
  assert.equal(row.submission_id, original.submissionId); assert.equal('text' in row, false);
  const result = expect(await ctx.call(a.jar, 'GET', `/api/v1/submissions/${row.submission_id}`));
  assert.equal(result.submission.text, original.text);
  assert.deepEqual(result.assessment.feedback, original.result.assessment.feedback);
  assert.deepEqual(result.task, original.result.task); assert.deepEqual(result.rubric, original.result.rubric);
  expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts?status=succeeded'), 422);
  const revision = expect(await ctx.call(a.jar, 'POST', '/api/v1/attempts',
    { body: { parentSubmissionId: original.submissionId } }), 201);
  assert.equal(revision.text, original.text);
  for (const field of ['task_id', 'task_version', 'rubric_id', 'rubric_version']) assert.equal(revision[field], original.attempt[field]);
  const text = original.text + '\nÜberarbeitete Fassung: Ich freue mich auf Ihre Antwort.';
  expect(await ctx.call(a.jar, 'PUT', `/api/v1/attempts/${revision.id}`, { body: { expectedRevision: revision.revision, text } }));
  assert.equal(expect(await ctx.call(a.jar, 'GET', `/api/v1/submissions/${original.submissionId}`)).submission.text, original.text);
  assert.deepEqual(expect(await ctx.call(a.jar, 'GET', '/api/v1/attempts?open=1')).attempts.map(item => item.id), [revision.id]);
  ctx.revision = { id: revision.id, text };
  return pass('new cookie rediscovers exact text/feedback/binding; revision inherits and preserves the original');
});

leg('J9', 'objective progress counts the current learner evidence exactly', 'MFP-09', async (ctx) => {
  const a = ctx.assessed.account;
  const before = expect(await ctx.call(a.jar, 'GET', '/api/v1/practice/progress'));
  assert.equal(before.totals.attempts, 0);
  const catalogue = expect(await ctx.call(a.jar, 'GET', '/api/v1/objective-sets?family=SB1'));
  assert.ok(catalogue.length > 0, 'an actual servable set is required');
  const selected = catalogue[0];
  const set = expect(await ctx.call(a.jar, 'GET', `/api/v1/objective-sets/${selected.set_id}?version=${selected.version}`));
  const gap = set.payload.gaps[0]; assert.ok(gap && gap.options);
  const itemId = String(gap.n), choices = Object.keys(gap.options);
  assert.ok(choices.length >= 2);
  const receipts = [];
  for (const answer of choices.slice(0, 2)) {
    const receipt = expect(await ctx.call(a.jar, 'POST', `/api/v1/objective-sets/${selected.set_id}/answers`,
      { body: { version: selected.version, itemId, answer } }), 201);
    assert.equal(typeof receipt.correct, 'boolean'); assert.equal(receipt.item_id, itemId);
    receipts.push({ ...receipt, answer });
  }
  const progress = expect(await ctx.call(a.jar, 'GET', '/api/v1/practice/progress'));
  const correct = receipts.filter(receipt => receipt.correct).length;
  assert.deepEqual(progress.totals, { attempts: 2, correct, accuracy: correct / 2, sections: 1 });
  assert.deepEqual(progress.sections, [{ section: 'SB', attempts: 2, correct, accuracy: correct / 2 }]);
  const mistakes = expect(await ctx.call(a.jar, 'GET', '/api/v1/practice/mistakes'));
  const latest = receipts.at(-1);
  assert.equal(mistakes.count, latest.correct ? 0 : 1);
  if (!latest.correct) {
    assert.equal(mistakes.items[0].item_id, itemId); assert.equal(mistakes.items[0].your_answer, latest.answer);
    assert.equal('correct_answer' in mistakes.items[0], false);
  }
  const foreign = expect(await ctx.call(ctx.accounts.j1.jar, 'GET', '/api/v1/practice/progress'));
  assert.equal(foreign.totals.attempts, 0, 'another learner must not inherit the evidence');
  ctx.objective = { setId: selected.set_id, version: selected.version, itemId, receipts };
  return pass('two actual answers, exact per-section counts and latest-mistake state; another account stays empty');
});

leg('J10', 'export exact owned work, change settings, sign out, sign in and delete the account', 'MFP-09', async (ctx) => {
  const original = ctx.assessed, a = original.account;
  const before = expect(await ctx.call(a.jar, 'GET', '/api/v1/settings'));
  expect(await ctx.call(a.jar, 'PUT', '/api/v1/settings', { body: { expectedRevision: before.revision, settings: { language: 'tr' } } }));
  const exported = expect(await ctx.call(a.jar, 'GET', '/api/v1/export'));
  assert.equal(exported.format, 'hatoove-learner-export-v1'); assert.ok(Date.parse(exported.exported_at));
  assert.equal(exported.settings.settings.language, 'tr');
  assert.equal(exported.attempts.length, 2); assert.equal(exported.submissions.length, 1); assert.equal(exported.results.length, 1);
  assert.equal(exported.attempts.find(row => row.id === ctx.revision.id).text, ctx.revision.text);
  assert.equal(exported.submissions[0].id, original.submissionId); assert.equal(exported.submissions[0].text, original.text);
  assert.equal(exported.submissions[0].explanation_language, 'ar');
  assert.equal(exported.results[0].submission_id, original.submissionId);
  assert.deepEqual(exported.results[0].feedback, original.result.assessment.feedback);
  assert.equal(exported.objective_evidence.length, 2);
  for (const receipt of ctx.objective.receipts) {
    const evidence = exported.objective_evidence.find(row => row.evidence_id === receipt.evidence_id);
    assert.ok(evidence); assert.equal(evidence.answer, receipt.answer); assert.equal(evidence.correct, receipt.correct);
    assert.equal(evidence.item_id, ctx.objective.itemId); assert.equal(evidence.set_id, ctx.objective.setId);
  }
  for (const foreign of [ctx.dashboardDraft, ctx.otherDraft]) {
    assert.equal(JSON.stringify(exported).includes(foreign.id), false);
    assert.equal(JSON.stringify(exported).includes(foreign.text), false);
  }
  const forbidden = /^(password|password_hash|token|session|sessions|secret|lease_token|lease_until|event_id|owner_id|account|objective_key)$/i;
  const inspect = value => { if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    assert.equal(forbidden.test(key), false, `export exposes ${key}`); inspect(entry);
  } };
  inspect(exported);
  const oldJar = { cookies: new Map(a.jar.cookies) };
  expect(await ctx.call(a.jar, 'POST', '/api/auth/sign-out', { body: {} }));
  expect(await ctx.call(oldJar, 'GET', '/api/v1/export'), 401);
  a.jar = newJar();
  expect(await ctx.call(a.jar, 'POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } }));
  assert.equal(expect(await ctx.call(a.jar, 'GET', '/api/v1/settings')).settings.language, 'tr');
  assert.equal(expect(await ctx.call(a.jar, 'DELETE', '/api/v1/account', { body: {} })).deleted, true);
  expect(await ctx.call(a.jar, 'GET', '/api/v1/export'), 401);
  expect(await ctx.call(newJar(), 'POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } }), 401);
  assert.equal(expect(await ctx.call(ctx.accounts.j1.jar, 'GET', `/api/v1/attempts/${ctx.dashboardDraft.id}`)).text, ctx.dashboardDraft.text);
  return pass('export includes exact original/revision/feedback/evidence and no foreign work or secrets; sign-out and deletion invalidate access');
});

leg('J11', 'password-reset request gives the same generic response for known and unknown accounts', 'MFP-04b', async (ctx) => {
  const known = expect(await ctx.call(newJar(), 'POST', '/api/auth/request-password-reset',
    { body: { email: ctx.accounts.j1.email } }));
  const unknown = expect(await ctx.call(newJar(), 'POST', '/api/auth/request-password-reset',
    { body: { email: `nobody-${RUN_ID}@journey.example.invalid` } }));
  assert.deepEqual(known, { ok: true }); assert.deepEqual(unknown, known);
  expect(await ctx.call(newJar(), 'POST', '/api/auth/request-password-reset', { body: { email: 'invalid' } }), 422);
  return pass('known/unknown requests both return only {ok:true}; malformed email refused; actual reset is covered by auth-entry-check');
});
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
    const env = { ...process.env, B1PREP_FORCE_OFFLINE: '1', B1PREP_CONTENT_MODE: 'internal-preview' };
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
    const ctx = { call, accounts: {}, startWorker, entitlement, assessmentCount, ledgerUnits };
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
  const pendingCount = 0; // All journey routes above are shipped and required.
  const failed = report.filter((r) => r.status === 'fail').length;
  return { report, passed, pending: pendingCount, failed, ok: failed === 0 };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const database = process.env.OWNAPI_PG_DATABASE || '';
  if (!database || FORBIDDEN.has(database)) throw new Error(`refusing to run against ${database}; set OWNAPI_PG_DATABASE to a disposable database`);
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
