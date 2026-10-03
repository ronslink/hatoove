/**
 * SUBMISSION-PRESERVE — deleting an attempt never removes submitted work.
 *
 * What this proves (offline, in memory)
 *   * `DELETE /api/v1/attempts/:id` on an attempt with ANY submission answers 409 `submitted_attempt`
 *     and changes nothing, whatever the job state: queued, running, succeeded or failed. No job is
 *     cancelled, no reservation released, no result hidden.
 *   * A stale draft view on a second device cannot delete what the first device submitted.
 *   * Submit and delete racing on one attempt never both succeed.
 *   * Another owner's submitted attempt is a plain 404, identical to an absent one (no 409 oracle).
 *   * A truly unsubmitted draft is still discarded as a tombstone.
 *   * Export keeps tombstoned history written by the retired delete-anything behaviour, flagged by
 *     `attempt_deleted_at`, and never another owner's rows.
 *   * The PostgreSQL adapter's `remove` keeps the submit lock order and its export does not filter
 *     tombstones out (a source-shape check; behaviour there needs a disposable database).
 *
 * What this does NOT prove
 *   * Anything executed on PostgreSQL: row locks, READ COMMITTED re-reads and RLS are untested here.
 *     Run `node tools/owned-api-check.mjs --backend=postgres` against a disposable database for that.
 *   * The browser's handling of the new 409.
 *
 * Usage: node tools/submission-preservation-check.mjs   (exit 0 when every check passes)
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createOwnedApi } from '../server/owned-api.mjs';
import { createOwnedClient, OwnedClientError } from '../public/js/owned-client.js';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ABSENT = '0f0f0f0f-0000-4000-8000-000000000000';
let emails = 0;

function world({ allowance = 10 } = {}) {
  const store = createMemoryDatastore({ allowance });
  // EXAM-S1: registration provisions the initial preparation + balance, as PostgreSQL does.
  const sessions = createMemorySessions({ provision: store.provision });
  const api = createOwnedApi({ datastore: store.port, sessions, settings: store.settings });
  return { store, api };
}

/** A same-origin browser with its own cookie jar, talking to the handler in-process. */
function browser(api, jar = new Map()) {
  const fetchImpl = async (url, init = {}) => {
    const headers = { ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await api.handle({ method: init.method || 'GET', path: url, headers, body: init.body, originChecked: true });
    for (const line of [res.headers['set-cookie']].flat().filter(Boolean)) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (/max-age=0/i.test(line)) jar.delete(pair.slice(0, eq)); else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return { status: res.status, text: async () => res.body };
  };
  return { jar, client: createOwnedClient({ fetchImpl }) };
}

async function learner(w, tag) {
  const b = browser(w.api);
  const account = await b.client.signUp({ name: tag, email: `${tag}-${++emails}@example.invalid`, password: `pw-${tag}-synthetic` });
  return { ...b, account, api: w.api };
}

/** EXAM-S1: a NEW attempt names an owned, ACTIVE preparation; resolved from the route, never assumed. */
async function preparationId(who) {
  const response = await who.api.handle({ method: 'GET', path: '/api/v1/preparations',
    headers: { cookie: [...who.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, originChecked: true });
  assert.equal(response.status, 200, response.body);
  const active = JSON.parse(response.body).preparations.find((p) => p.state === 'active');
  assert.ok(active, 'sign-up must provision exactly one active preparation');
  return active.id;
}

async function submitted(who, text = 'Liebe Anna, ich komme gern am Samstag.') {
  const attempt = await who.client.createAttempt({ preparationId: await preparationId(who) });
  const draft = await who.client.saveDraft(attempt.id, { expectedRevision: 1, text });
  const receipt = await who.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
  return { attempt, draft, receipt };
}

async function rejects(promise, code, { status, detail } = {}) {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof OwnedClientError, `expected ${code}, got ${error ? error.stack || error : 'success'}`);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  if (detail !== undefined) assert.equal(error.detail, detail);
  return error;
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

check('submitted-attempt-is-refused-in-every-job-state', async () => {
  const w = world();
  const a = await learner(w, 'a');
  const states = {
    queued: async () => {},
    running: async (id) => assert.ok(w.store.worker.claim(id)),
    succeeded: async (id) => { assert.ok(w.store.worker.claim(id)); assert.ok(w.store.worker.complete(id, 'ok')); },
    failed: async (id) => { assert.ok(w.store.worker.claim(id)); assert.ok(w.store.worker.fail(id, 'provider_unavailable')); },
  };
  for (const [state, reach] of Object.entries(states)) {
    const s = await submitted(a, `Brief im Zustand ${state}.`);
    await reach(s.receipt.submissionId);
    const job = w.store.inspect.job(s.receipt.submissionId);
    const before = w.store.inspect.fingerprint();
    await rejects(a.client.deleteAttempt(s.attempt.id), 'conflict', { status: 409, detail: 'submitted_attempt' });
    assert.equal(w.store.inspect.fingerprint(), before, `${state}: a refused delete changes nothing`);
    assert.deepEqual(w.store.inspect.job(s.receipt.submissionId), job, `${state}: job untouched`);
    assert.equal(w.store.inspect.attempt(s.attempt.id).deleted_at, null, `${state}: no tombstone`);
    const result = await a.client.readResult(s.receipt.submissionId);
    assert.equal(result.submission.text, `Brief im Zustand ${state}.`, `${state}: snapshot still readable`);
    assert.equal(result.job.status, state, `${state}: job state served unchanged`);
    if (state === 'succeeded') assert.ok(result.assessment, 'the saved assessment is still served');
    if (state === 'failed') assert.deepEqual(await a.client.retry(s.receipt.submissionId), { queued: true }, 'a failed job stays retryable');
  }
  const ent = w.store.inspect.entitlement(a.account.id);
  assert.equal(ent.used, 1, 'exactly one successful debit (the succeeded job)');
  assert.equal(ent.reserved, 3, 'queued, running and the retried job hold reservations');
  return 'queued, running, succeeded and failed all 409 with an identical fingerprint';
});

check('a-stale-draft-view-cannot-delete-submitted-work', async () => {
  const w = world();
  const a = await learner(w, 'a');
  const laptop = a;
  const phone = browser(w.api, new Map(a.jar)); // same session, second device
  await phone.client.refreshAccount();
  const attempt = await laptop.client.createAttempt({ preparationId: await preparationId(laptop) });
  const draft = await laptop.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'Vom Laptop' });
  const phoneView = await phone.client.readAttempt(attempt.id);
  assert.equal(phoneView.revision, draft.revision, 'the phone holds the same draft view');
  const receipt = await laptop.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
  // The phone still thinks it is looking at a draft and asks to discard it.
  await rejects(phone.client.deleteAttempt(attempt.id), 'conflict', { status: 409, detail: 'submitted_attempt' });
  assert.equal(w.store.inspect.job(receipt.submissionId).status, 'queued', 'the feedback job was not cancelled');
  assert.equal(w.store.inspect.entitlement(a.account.id).reserved, 1, 'and its reservation stands');
  return 'second device with a stale view got 409; job queued, reservation intact';
});

check('submit-and-delete-racing-never-both-succeed', async () => {
  const outcomes = new Set();
  // `lag` delays the delete by N event-loop turns so both winners are reached, not just whichever
  // method happens to await less before its critical section.
  for (const order of ['submit-first', 'delete-first']) {
    for (const lag of [0, 1, 3, 10]) {
      const w = world();
      const a = await learner(w, 'a');
      const attempt = await a.client.createAttempt({ preparationId: await preparationId(a) });
      const draft = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'Wettlauf' });
      const submit = () => a.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
      const remove = async () => {
        for (let i = 0; i < lag; i += 1) await new Promise((resolve) => setImmediate(resolve));
        return a.client.deleteAttempt(attempt.id);
      };
      const settled = await Promise.allSettled(order === 'submit-first' ? [submit(), remove()] : [remove(), submit()]);
      const [s, d] = order === 'submit-first' ? settled : [settled[1], settled[0]];
      assert.ok(!(s.status === 'fulfilled' && d.status === 'fulfilled'), `${order}: submit and delete both succeeded`);
      assert.ok(s.status === 'fulfilled' || d.status === 'fulfilled', `${order}: one of them must win`);
      const row = w.store.inspect.attempt(attempt.id);
      if (s.status === 'fulfilled') {
        assert.equal(d.reason.detail, 'submitted_attempt', 'a delete that loses to submit is 409');
        assert.equal(row.deleted_at, null, 'and the submitted attempt is not tombstoned');
        assert.equal(w.store.inspect.job(s.value.submissionId).status, 'queued');
        assert.equal(w.store.inspect.entitlement(a.account.id).reserved, 1);
        outcomes.add('submit-won');
      } else {
        assert.equal(s.reason.detail, 'not_found', 'a submit that loses to delete is 404');
        assert.equal(w.store.inspect.submissionCount(), 0, 'and records nothing');
        assert.equal(w.store.inspect.entitlement(a.account.id).reserved, 0, 'and reserves nothing');
        outcomes.add('delete-won');
      }
    }
  }
  assert.deepEqual([...outcomes].sort(), ['delete-won', 'submit-won'], 'both interleavings must actually be exercised');
  return `outcomes observed: ${[...outcomes].join(', ')} (memory interleaving only; PostgreSQL row locks untested here)`;
});

check('another-owners-submitted-attempt-is-404-not-409', async () => {
  const w = world();
  const a = await learner(w, 'a');
  const b = await learner(w, 'b');
  const s = await submitted(a);
  const openA = await a.client.createAttempt({ preparationId: await preparationId(a) });
  await a.client.saveDraft(openA.id, { expectedRevision: 1, text: 'A privat' });
  const before = w.store.inspect.fingerprint();
  const foreign = await rejects(b.client.deleteAttempt(s.attempt.id), 'not_found', { status: 404 });
  const absent = await rejects(b.client.deleteAttempt(ABSENT), 'not_found', { status: 404 });
  assert.equal(foreign.detail, absent.detail, 'a foreign submitted attempt looks exactly like an absent one');
  await rejects(b.client.deleteAttempt(openA.id), 'not_found', { status: 404 });
  assert.equal(w.store.inspect.fingerprint(), before, 'B changed nothing of A');
  assert.equal((await a.client.readAttempt(openA.id)).text, 'A privat');
  return 'foreign submitted and foreign draft both 404; fingerprint unchanged';
});

check('an-unsubmitted-draft-is-still-discarded', async () => {
  const w = world();
  const a = await learner(w, 'a');
  const empty = await a.client.createAttempt({ preparationId: await preparationId(a) });
  const written = await a.client.createAttempt({ preparationId: await preparationId(a) });
  await a.client.saveDraft(written.id, { expectedRevision: 1, text: 'Wird verworfen' });
  for (const id of [empty.id, written.id]) {
    assert.deepEqual(await a.client.deleteAttempt(id), { deleted: true });
    assert.ok(w.store.inspect.attempt(id).deleted_at, 'tombstone recorded');
    assert.equal(w.store.inspect.attempt(id).draft, null, 'draft removed');
    await rejects(a.client.readAttempt(id), 'not_found', { status: 404 });
    await rejects(a.client.submit(id, { expectedRevision: 2, eventId: randomUUID() }), 'not_found', { status: 404 });
  }
  // The (owner, exam) balance carries its identity now, so compare the counters themselves.
  const ent = w.store.inspect.entitlement(a.account.id);
  assert.deepEqual({ allowance: ent.allowance, used: ent.used, reserved: ent.reserved },
    { allowance: 10, used: 0, reserved: 0 }, 'no counter moved');
  return 'empty and written drafts discarded; stale read/submit 404';
});

check('export-keeps-tombstoned-history-flagged', async () => {
  const w = world();
  const a = await learner(w, 'a');
  const b = await learner(w, 'b');
  const live = await submitted(a, 'Lebendiger Brief.');
  const done = await submitted(a, 'Bewerteter Brief, später alt-gelöscht.');
  assert.ok(w.store.worker.claim(done.receipt.submissionId));
  assert.ok(w.store.worker.complete(done.receipt.submissionId, 'ok'));
  const failed = await submitted(a, 'Fehlgeschlagener Brief, später alt-gelöscht.');
  assert.ok(w.store.worker.claim(failed.receipt.submissionId));
  assert.ok(w.store.worker.fail(failed.receipt.submissionId, 'provider_unavailable'));
  const queued = await submitted(a, 'Wartender Brief, später alt-gelöscht.');
  const theirs = await submitted(b, 'Fremder Brief.');
  // Tombstones written by the RETIRED behaviour, as they exist in installed databases.
  for (const s of [done, failed, queued, theirs]) assert.ok(w.store.worker.legacyTombstone(s.attempt.id));
  assert.equal(w.store.worker.complete(queued.receipt.submissionId, 'late'), false, 'a late completion still cannot revive a tombstone');

  const exported = await w.api.handle({ method: 'GET', path: '/api/v1/export', headers: { cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, originChecked: true });
  assert.equal(exported.status, 200);
  const body = JSON.parse(exported.body);
  const sub = (id) => body.submissions.find((row) => row.id === id);
  const res = (id) => body.results.find((row) => row.submission_id === id);

  assert.equal(sub(live.receipt.submissionId).attempt_deleted_at, null, 'a live submission is flagged as live');
  for (const s of [done, failed, queued]) {
    assert.ok(sub(s.receipt.submissionId), 'a tombstoned submission is still exported');
    assert.ok(Date.parse(sub(s.receipt.submissionId).attempt_deleted_at), 'and explicitly flagged by attempt_deleted_at');
    assert.ok(Date.parse(res(s.receipt.submissionId).attempt_deleted_at), 'its result row carries the same flag');
  }
  assert.ok(res(done.receipt.submissionId).feedback, 'the assessment of a tombstoned attempt is exported');
  assert.equal(res(failed.receipt.submissionId).failure_code, 'provider_unavailable', 'the failure is exported');
  assert.equal(res(queued.receipt.submissionId).status, 'cancelled', 'the retired cancellation is exported as it happened');
  assert.ok(!body.attempts.some((row) => [done, failed, queued].some((s) => s.attempt.id === row.id)), 'tombstoned attempts carry no draft');
  assert.ok(!sub(theirs.receipt.submissionId) && !res(theirs.receipt.submissionId), 'another owner\'s tombstoned rows never appear');
  assert.ok(!exported.body.includes('Fremder Brief'), 'nor their text');
  for (const row of body.submissions) assert.ok(!('owner_id' in row) && !('event_id' in row), 'no owner or event id');
  return `${body.submissions.length} submissions exported, 3 flagged as tombstoned; none from another owner`;
});

check('postgres-adapter-keeps-the-submit-lock-order-and-exports-tombstones', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'server/owned-postgres/adapter.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const body = (name) => {
    const start = source.indexOf(`    async ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    const end = source.indexOf('\n    },\n', start);
    return source.slice(start, end);
  };
  const remove = body('remove');
  const steps = [
    'lockBalance(client, owner, examId)', 'await owned(client, owner, id)',
    'FROM submissions WHERE attempt_id = $1', "fail(409, 'submitted_attempt')", 'UPDATE attempts SET deleted_at',
  ].map((needle) => { const at = remove.indexOf(needle); assert.ok(at >= 0, `remove() lacks: ${needle}`); return at; });
  assert.deepEqual([...steps].sort((x, y) => x - y), steps,
    'remove() must lock the balance, then the attempt, test for a submission, refuse, and only then tombstone');
  assert.ok(!/UPDATE jobs|reserved\s*=\s*reserved\s*-/.test(remove), 'remove() must not cancel jobs or release reservations');
  // EXAM-S1: the (owner, exam) balance lock moved into the shared `lockBalance` helper both writers use.
  assert.match(source, /SELECT \* FROM entitlements WHERE owner_id = \$1 AND exam_id = \$2 FOR UPDATE/,
    'the shared balance lock must still be a FOR UPDATE on the (owner, exam) row');
  const submit = body('submit');
  assert.ok(submit.indexOf('lockBalance(') >= 0 && submit.indexOf('lockBalance(') < submit.indexOf('await owned(client, owner, id)'),
    'submit locks the balance before the attempt');
  const exported = body('exportData');
  const statements = exported.split('client.query(').slice(1);
  // Retain the closed query inventory while checking each current export class and its owner scope.
  // S5/S5B added playback/timing facts; PILOT-07 added personal explanation rows and heads.
  const queryClasses = new Map([
    ['learner_preparation', 1], ['entitlements', 1], ['attempts', 1], ['submissions', 2],
    ['item_evidence', 1], ['mock_run', 1], ['mock_writing', 1], ['mock_run_time_group', 1],
    ['listening_playback', 1], ['writing_explanation_representation', 1], ['writing_explanation_head', 1],
    ['payment_order', 1], ['payment_checkout_event', 1], ['payment_event', 1], ['payment_grant', 1],
  ]);
  assert.equal(statements.length, [...queryClasses.values()].reduce((sum, count) => sum + count, 0),
    'no unclassified direct query may enter the owned export');
  for (const [table, expected] of queryClasses) {
    const matching = statements.filter(sql => new RegExp(`FROM ${table}\\b`).test(sql));
    assert.equal(matching.length, expected, `${table} retains its exact export query class`);
    for (const statement of matching) assert.match(statement, /WHERE (?:[a-z]+\.)?owner_id\s*=\s*\$1/,
      `${table} export is explicitly owner-scoped`);
  }
  assert.match(exported, /const provider_attempts=await readOwnProviderAttempts\(client\)/,
    'provider history uses the protected owned export helper in the existing transaction');
  assert.doesNotMatch(exported, /FROM provider_attempt(?:_observation)?\b/,
    'the learner export must not read raw private provider tables');
  const { readOwnProviderAttempts } = await import('../server/owned-postgres/provider-attempts.mjs');
  const providerQueries = [];
  assert.deepEqual(await readOwnProviderAttempts({ query: async (...args) => {
    providerQueries.push(args); return { rows: [{ value: { synthetic: true } }] };
  } }), [{ synthetic: true }]);
  assert.deepEqual(providerQueries, [['SELECT export_owned_provider_attempts() AS value']],
    'the helper reads only the authenticated-owner SQL projection, with no caller-selected owner');
  for (const table of ['payment_order', 'payment_checkout_event', 'payment_event', 'payment_grant']) {
    const paymentStatements = statements.filter(sql => new RegExp(`FROM ${table}\\b`).test(sql));
    assert.equal(paymentStatements.length, 1, `${table} stays in the account export`);
    assert.match(paymentStatements[0], /WHERE owner_id\s*=\s*\$1/, `${table} export is explicitly owner-scoped`);
  }
  const attachments = statements.filter((sql) => /FROM mock_writing WHERE owner_id\s*=\s*\$1/.test(sql));
  assert.equal(attachments.length, 1, 'writing attachments remain exported and owner-scoped');
  assert.match(exported, /writingContext\(client,\{id:submission\.attempt_id,owner_id:owner,/,
    'feedback rights follow the owned attempt and its original run through revision ancestry');
  assert.match(exported, /if\(context\.blocked_reason\)\s*\{?\s*result\.feedback=null/,
    'blocked feedback is withheld while owned submissions stay exportable');
  const savedRuns = statements.filter((sql) => /FROM mock_run r/.test(sql));
  assert.equal(savedRuns.length, 1, 'saved runs remain part of the account export');
  assert.match(savedRuns[0], /FROM mock_run r WHERE (?:r\.)?owner_id = \$1/, 'saved run export stays owner-scoped');
  assert.ok(statements.some((sql) => /a\.deleted_at IS NULL/.test(sql)),
    'the attempts list stays live-only (tombstones carry no draft)');
  const history = statements.filter((sql) => /a\.deleted_at AS attempt_deleted_at/.test(sql));
  assert.equal(history.length, 2, 'submissions and results carry the tombstone flag');
  for (const sql of history) {
    assert.ok(!/deleted_at IS NULL/.test(sql), 'submissions/results must not drop tombstoned history');
    assert.match(sql, /s\.owner_id = \$1/, 'and stay owner-scoped');
  }
  return 'remove(): balance -> attempt -> submission test -> 409 -> tombstone; export flags tombstones (source shape only)';
});

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let failed = 0;
  const previousContentMode = process.env.B1PREP_CONTENT_MODE;
  try {
    // These synthetic writing tasks intentionally remain unreviewed.
    process.env.B1PREP_CONTENT_MODE = 'internal-preview';
    for (const { name, run } of checks) {
      try {
        const detail = await run();
        console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
      } catch (error) {
        failed += 1;
        console.log(`FAIL ${name}\n  ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error}`);
      }
    }
  } finally {
    if (previousContentMode === undefined) delete process.env.B1PREP_CONTENT_MODE;
    else process.env.B1PREP_CONTENT_MODE = previousContentMode;
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  console.log('NOTE in-memory datastore plus an adapter source-shape check; no PostgreSQL row-lock or RLS evidence.');
  process.exitCode = failed ? 1 : 0;
}
