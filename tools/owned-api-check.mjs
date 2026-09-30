/**
 * Checks for the owned attempts API (OWNAPI-01, contract 0.1.0).
 *
 * What this proves
 *   * Shapes: the REAL public/js/owned-client.js is driven against
 *     server/owned-api.mjs through a fake fetchImpl that routes into the handler,
 *     with a per-browser cookie jar. A shape the client rejects shows up here as
 *     `malformed_response`, not as a hand-rolled assertion that merely resembles it.
 *   * Ownership, revisions, idempotency, immutability, the error contract and
 *     fail-closed wiring, each produced by a real request.
 *   * The server.js mount (when present) sits behind the SEC-01 origin gate: a
 *     second pass starts server.js in-process on an ephemeral loopback port.
 *
 * What this does NOT prove
 *   * Anything about PostgreSQL. The datastore below is IN MEMORY and test-only.
 *     The programme's ownership guarantees were proven against PostgreSQL with
 *     forced RLS and separate roles (spikes/auth-runtime/isolation.test.mjs); no
 *     adapter to that exists yet. Here, ownership scoping lives in the in-memory
 *     store's `ownedAttempt`/`ownedSubmission` helpers, which the discrimination
 *     run in work/implementation/OWNAPI-01.md disables to show the suite fails.
 *   * Real auth. The session port is a synthetic in-memory fake, not Better Auth.
 *   * Browser behaviour. No browser is started.
 *
 * Safety: offline, no database, no provider, no `.env`; the server.js pass points
 * B1PREP_ENV_FILE / B1PREP_PROGRESS_FILE at a throwaway temp directory.
 *
 * Usage: node tools/owned-api-check.mjs   (exit 0 when every check passes)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { createOwnedApi, Fault, CONTRACT_VERSION } from '../server/owned-api.mjs';
import { createOwnedClient, OwnedClientError } from '../public/js/owned-client.js';

/* ================================================== in-memory ports (TEST ONLY) */

/**
 * In-memory datastore mirroring spikes/auth-runtime/store.mjs semantics.
 * Test-only: it has no durability, no RLS and no roles. Each method runs without
 * an await, so it is atomic within one event-loop turn, standing in for the
 * spike's single transaction.
 */
export function createMemoryDatastore({ allowance = 10 } = {}) {
  const attempts = new Map();
  const drafts = new Map();
  const submissions = new Map();
  const events = new Map();
  const jobs = new Map();
  const assessments = new Map();
  const entitlements = new Map();
  const calls = [];

  const fail = (status, code) => { throw new Fault(status, code); };
  // Reading an entitlement never creates one, so a rejected request leaves no trace.
  const entitlement = (owner) => entitlements.get(owner) ?? { allowance, used: 0, reserved: 0 };
  const adjust = (owner, { used = 0, reserved = 0 }) => {
    const next = { ...entitlement(owner) };
    next.used += used;
    next.reserved += reserved;
    entitlements.set(owner, next);
  };
  // Ownership scoping. Another owner's record is indistinguishable from an absent one.
  const ownedAttempt = (owner, id) => {
    const attempt = attempts.get(id);
    if (!attempt || attempt.owner_id !== owner || attempt.deleted_at) fail(404, 'not_found');
    return attempt;
  };
  const ownedSubmission = (owner, id) => {
    const submission = submissions.get(id);
    if (!submission || submission.owner_id !== owner) fail(404, 'not_found');
    ownedAttempt(owner, submission.attempt_id);
    return submission;
  };
  const submissionFor = (attemptId) => [...submissions.values()].find((s) => s.attempt_id === attemptId);
  const attemptView = (attempt) => ({ ...attempt, ...drafts.get(attempt.id) });

  const port = {
    async create(owner, parent = null) {
      calls.push('create');
      if (parent) ownedSubmission(owner, parent);
      const id = randomUUID();
      attempts.set(id, {
        id, owner_id: owner, task_version: 'synthetic-writing-v1', rubric_version: 'formative-fixture-v1',
        parent_submission_id: parent, created_at: new Date().toISOString(), deleted_at: null,
      });
      drafts.set(id, { revision: 1, text: '' });
      return { id, revision: 1, text: '' };
    },
    async read(owner, id) {
      calls.push('read');
      return attemptView(ownedAttempt(owner, id));
    },
    async save(owner, id, expectedRevision, text) {
      calls.push('save');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof text !== 'string' || text.length > 12000) {
        fail(422, 'invalid_draft');
      }
      ownedAttempt(owner, id);
      const current = drafts.get(id);
      if (current.revision !== expectedRevision) fail(409, 'draft_conflict');
      if (submissionFor(id)) fail(409, 'revision_required');
      const next = { revision: current.revision + 1, text };
      drafts.set(id, next);
      return { ...next };
    },
    async submit(owner, id, expectedRevision, eventId) {
      calls.push('submit');
      const ent = entitlement(owner);
      const attempt = ownedAttempt(owner, id);
      const priorId = events.get(`${owner}\u0000${eventId}`);
      if (priorId) {
        const prior = submissions.get(priorId);
        if (prior.attempt_id !== attempt.id || prior.draft_revision !== expectedRevision) fail(409, 'idempotency_conflict');
        return { submissionId: prior.id, replay: true };
      }
      const draft = drafts.get(id);
      if (draft.revision !== expectedRevision) fail(409, 'draft_conflict');
      if (!draft.text.trim()) fail(422, 'empty_submission');
      if (submissionFor(id)) fail(409, 'already_submitted');
      if (ent.used + ent.reserved >= ent.allowance) fail(409, 'allowance_exhausted');
      const submissionId = randomUUID();
      // Frozen: stands in for the spike's trigger that rejects snapshot updates.
      submissions.set(submissionId, Object.freeze({
        id: submissionId, attempt_id: id, owner_id: owner, event_id: eventId, draft_revision: draft.revision,
        text: draft.text, task_version: attempt.task_version, rubric_version: attempt.rubric_version,
      }));
      events.set(`${owner}\u0000${eventId}`, submissionId);
      jobs.set(submissionId, { status: 'queued', failure_code: null, tries: 0 });
      adjust(owner, { reserved: 1 });
      return { submissionId, replay: false };
    },
    async result(owner, submissionId) {
      calls.push('result');
      const submission = ownedSubmission(owner, submissionId);
      const job = jobs.get(submissionId);
      return {
        submission: { ...submission },
        job: { status: job.status, failure_code: job.failure_code, tries: job.tries },
        assessment: assessments.has(submissionId) ? structuredClone(assessments.get(submissionId)) : null,
      };
    },
    async retry(owner, submissionId) {
      calls.push('retry');
      const ent = entitlement(owner);
      ownedSubmission(owner, submissionId);
      const job = jobs.get(submissionId);
      if (job.status !== 'failed' || job.tries >= 3 || job.failure_code === 'retry_exhausted') fail(409, 'retry_unavailable');
      if (ent.used + ent.reserved >= ent.allowance) fail(409, 'allowance_exhausted');
      job.status = 'queued';
      job.failure_code = null;
      adjust(owner, { reserved: 1 });
    },
    async remove(owner, id) {
      calls.push('remove');
      const attempt = ownedAttempt(owner, id);
      for (const submission of submissions.values()) {
        const job = submission.attempt_id === id ? jobs.get(submission.id) : null;
        if (job && (job.status === 'queued' || job.status === 'running')) {
          job.status = 'cancelled';
          adjust(owner, { reserved: -1 });
        }
      }
      attempt.deleted_at = new Date().toISOString();
      drafts.delete(id);
    },
  };

  /** Worker-side test hooks. Not part of the HTTP port and never reachable over HTTP. */
  const worker = {
    claim(submissionId) {
      const job = jobs.get(submissionId);
      if (!job || job.status !== 'queued') return false;
      job.status = 'running';
      job.tries += 1;
      return true;
    },
    complete(submissionId, comment) {
      const job = jobs.get(submissionId);
      const submission = submissions.get(submissionId);
      if (!job || job.status !== 'running' || attempts.get(submission.attempt_id).deleted_at) return false;
      assessments.set(submissionId, Object.freeze({
        feedback: { kind: 'synthetic-formative', comment },
        model_version: 'fixture-v1', prompt_version: 'fixture-v1', rubric_version: submission.rubric_version,
      }));
      adjust(submission.owner_id, { reserved: -1, used: 1 });
      job.status = 'succeeded';
      return true;
    },
    fail(submissionId, code) {
      const job = jobs.get(submissionId);
      if (!job || job.status !== 'running') return false;
      job.status = 'failed';
      job.failure_code = code;
      adjust(submissions.get(submissionId).owner_id, { reserved: -1 });
      return true;
    },
  };

  const inspect = {
    calls,
    submissionCount: () => submissions.size,
    submission: (id) => submissions.get(id),
    job: (id) => ({ ...jobs.get(id) }),
    attempt: (id) => (attempts.has(id) ? { ...attempts.get(id), draft: drafts.get(id) ? { ...drafts.get(id) } : null } : null),
    entitlement: (owner) => ({ ...entitlement(owner) }),
    fingerprint: () => JSON.stringify({
      attempts: [...attempts.values()], drafts: [...drafts.entries()], submissions: [...submissions.values()],
      jobs: [...jobs.entries()], assessments: [...assessments.entries()], entitlements: [...entitlements.entries()],
    }),
  };

  return { port, worker, inspect };
}

/** In-memory session port. Synthetic accounts only; TEST ONLY, not an auth system. */
export function createMemorySessions() {
  const COOKIE = 'hatoove_owned_session';
  const users = new Map();
  const sessions = new Map();
  const hash = (password, salt) => scryptSync(password, salt, 32);
  const tokenFrom = (headers) => {
    const cookie = String(headers.cookie || '');
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return null;
  };
  const issue = (userId) => {
    const token = randomBytes(24).toString('base64url');
    sessions.set(token, userId);
    return { setCookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` };
  };
  return {
    cookieName: COOKIE,
    liveSessions: () => sessions.size,
    async getSession(headers) {
      const userId = sessions.get(tokenFrom(headers));
      if (!userId) return null;
      const user = [...users.values()].find((u) => u.id === userId);
      return user ? { userId: user.id, email: user.email } : null;
    },
    async signUp({ email, password }) {
      if (users.has(email)) throw new Fault(422, 'user_exists');
      const salt = randomBytes(16);
      // Auth user ids are opaque text in contract 0.1.0, deliberately not UUIDs.
      const user = { id: `user-${randomBytes(9).toString('base64url')}`, email, salt, hash: hash(password, salt) };
      users.set(email, user);
      return issue(user.id);
    },
    async signIn({ email, password }) {
      const user = users.get(email);
      if (!user || !timingSafeEqual(user.hash, hash(password, user.salt))) throw new Fault(401, 'invalid_credentials');
      return issue(user.id);
    },
    async signOut(headers) {
      sessions.delete(tokenFrom(headers));
      return { setCookie: `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
    },
  };
}

/* ============================================================ fake browsers */

function applySetCookie(jar, header) {
  if (!header) return;
  for (const line of Array.isArray(header) ? header : [header]) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * A same-origin "browser" talking to the handler in-process. `originChecked` is
 * true because the SEC-01 gate is proven separately against server.js below.
 */
function inProcessBrowser(api) {
  const jar = new Map();
  const log = [];
  const exchange = async ({ method, path: url, headers = {}, body, originChecked = true }) => {
    const sent = { ...headers };
    if (jar.size) sent.cookie = cookieHeader(jar);
    const response = await api.handle({ method, path: url, headers: sent, body, originChecked });
    applySetCookie(jar, response.headers['set-cookie']);
    log.push({ method, url, status: response.status, headers: response.headers });
    return response;
  };
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.credentials, 'same-origin', 'the client must send same-origin credentials');
    const response = await exchange({ method: init.method || 'GET', path: url, headers: init.headers, body: init.body });
    return { status: response.status, text: async () => response.body };
  };
  /** Raw request for inputs the real client refuses to send. */
  const raw = async (method, url, body, { headers, originChecked } = {}) => {
    const response = await exchange({
      method, path: url,
      body: typeof body === 'string' || body === undefined || body instanceof Uint8Array ? body : JSON.stringify(body),
      headers: { accept: 'application/json', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers },
      originChecked,
    });
    return { status: response.status, headers: response.headers, json: JSON.parse(response.body), text: response.body };
  };
  return { jar, log, fetchImpl, raw, client: createOwnedClient({ fetchImpl }) };
}

/** Real HTTP over node:http, with a browser-like Origin and cookie jar. */
function httpBrowser(port, { origin = `http://127.0.0.1:${port}` } = {}) {
  const jar = new Map();
  const request = ({ method, url, headers = {}, body }) => new Promise((resolve, reject) => {
    const sent = { host: `127.0.0.1:${port}`, ...headers };
    if (origin) sent.origin = origin;
    if (jar.size) sent.cookie = cookieHeader(jar);
    // As a browser does. node:http would otherwise send a DELETE body unframed.
    if (body !== undefined) sent['content-length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        applySetCookie(jar, res.headers['set-cookie']);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const fetchImpl = async (url, init = {}) => {
    const res = await request({ method: init.method || 'GET', url, headers: init.headers, body: init.body });
    return { status: res.status, text: async () => res.text };
  };
  return { jar, request, fetchImpl, client: createOwnedClient({ fetchImpl }) };
}

/* ================================================================ harness */

const ATTEMPT_ABSENT = '0f0f0f0f-0000-4000-8000-000000000000';
const SUBMISSION_ABSENT = '0e0e0e0e-0000-4000-8000-000000000000';
let emailCounter = 0;
const nextEmail = (tag) => `${tag}-${++emailCounter}@example.invalid`;

function world({ allowance } = {}) {
  const store = createMemoryDatastore({ allowance });
  const sessions = createMemorySessions();
  const api = createOwnedApi({ datastore: store.port, sessions });
  return { store, sessions, api, browser: () => inProcessBrowser(api) };
}

async function learner(w, tag = 'a') {
  const b = w.browser();
  const account = await b.client.signUp({ name: `Learner ${tag}`, email: nextEmail(tag), password: `pw-${tag}-synthetic` });
  return { ...b, account };
}

async function expectClientError(promise, code, { status, detail } = {}) {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof OwnedClientError, `expected OwnedClientError ${code}, got ${error ? error.stack || error : 'success'}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
  if (status !== undefined) assert.equal(error.status, status);
  if (detail !== undefined) assert.equal(error.detail, detail);
  return error;
}

/** A learner with one submitted attempt. */
async function submitted(w, tag = 'a', text = 'Liebe Anna, ich komme gern am Samstag.') {
  const who = await learner(w, tag);
  const attempt = await who.client.createAttempt();
  const draft = await who.client.saveDraft(attempt.id, { expectedRevision: 1, text });
  const eventId = randomUUID();
  const receipt = await who.client.submit(attempt.id, { expectedRevision: draft.revision, eventId });
  return { ...who, attempt, draft, eventId, receipt };
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ----------------------------------------------------------- account/auth */

check('client-signup-establishes-verified-account', async () => {
  const w = world();
  const a = await learner(w);
  assert.equal(a.account.contractVersion, CONTRACT_VERSION);
  assert.match(a.account.id, /^user-/, 'opaque text user id from the session port');
  assert.match(a.account.email, /@example\.invalid$/);
  assert.deepEqual(a.client.getAccount(), a.account);
  const account = await a.raw('GET', '/api/v1/account');
  assert.deepEqual(Object.keys(account.json).sort(), ['contractVersion', 'email', 'id']);
});

check('client-signin-and-wrong-password', async () => {
  const w = world();
  const email = nextEmail('s');
  await w.browser().client.signUp({ name: 'S', email, password: 'right-synthetic' });
  const b = w.browser();
  await expectClientError(b.client.signIn({ email, password: 'wrong-synthetic' }), 'unauthenticated', { status: 401, detail: 'invalid_credentials' });
  assert.equal(b.client.getAccount(), null);
  const account = await b.client.signIn({ email, password: 'right-synthetic' });
  assert.equal(account.email, email);
});

check('unauthenticated-requests-get-401', async () => {
  const w = world();
  const b = w.browser();
  assert.equal(await b.client.refreshAccount(), null, 'a 401 account reads as signed out');
  for (const [method, url, body] of [
    ['GET', '/api/v1/account'],
    ['POST', '/api/v1/attempts', {}],
    ['GET', `/api/v1/attempts/${ATTEMPT_ABSENT}`],
    ['GET', `/api/v1/submissions/${SUBMISSION_ABSENT}`],
    ['GET', '/api/v1/no-such-route'],
  ]) {
    const res = await b.raw(method, url, body);
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.deepEqual(res.json, { error: 'unauthenticated' });
  }
  assert.deepEqual(w.store.inspect.calls, [], 'no datastore method is reached without a session');
});

check('sign-out-invalidates-server-session', async () => {
  const w = world();
  const a = await learner(w);
  const stolen = cookieHeader(a.jar);
  await a.client.signOut();
  assert.equal(a.client.getAccount(), null);
  assert.equal(a.jar.size, 0, 'the session cookie is cleared');
  const replay = await w.api.handle({ method: 'GET', path: '/api/v1/account', headers: { cookie: stolen } });
  assert.equal(replay.status, 401, 'the old session token no longer authenticates');
});

check('get-session-reports-only-the-verified-session', async () => {
  const w = world();
  const a = await learner(w);
  const res = await a.raw('GET', '/api/auth/get-session');
  assert.deepEqual(res.json, { user: { id: a.account.id, email: a.account.email } });
  const anon = await w.browser().raw('GET', '/api/auth/get-session');
  assert.equal(anon.status, 200);
  assert.equal(anon.json, null);
});

/* -------------------------------------------------------------- lifecycle */

check('client-full-lifecycle-shapes', async () => {
  const w = world();
  const a = await learner(w);
  const attempt = await a.client.createAttempt();
  assert.equal(attempt.revision, 1, 'draft revisions start at 1');
  assert.equal(attempt.text, '');
  const read = await a.client.readAttempt(attempt.id);
  assert.equal(read.id, attempt.id);
  assert.equal(read.owner_id, a.account.id);
  const saved = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'Hallo Anna' });
  assert.deepEqual(saved, { revision: 2, text: 'Hallo Anna' });
  const eventId = randomUUID();
  const receipt = await a.client.submit(attempt.id, { expectedRevision: 2, eventId });
  assert.equal(receipt.replay, false);
  const result = await a.client.readResult(receipt.submissionId);
  assert.equal(result.submission.text, 'Hallo Anna');
  assert.equal(result.submission.draft_revision, 2);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.assessment, null);
  // Uppercase ids are canonical UUIDs too; the handler normalises them.
  const upper = await a.client.readAttempt(attempt.id.toUpperCase());
  assert.equal(upper.id, attempt.id);
  // Every response on the owned surface is no-store.
  assert.ok(a.log.length >= 6);
  for (const entry of a.log) assert.equal(entry.headers['cache-control'], 'no-store', `${entry.method} ${entry.url}`);
});

check('draft-revision-checked-and-increments-once', async () => {
  const w = world();
  const a = await learner(w);
  const attempt = await a.client.createAttempt();
  const r2 = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'eins' });
  const r3 = await a.client.saveDraft(attempt.id, { expectedRevision: 2, text: 'zwei' });
  assert.deepEqual([r2.revision, r3.revision], [2, 3]);
  const before = w.store.inspect.fingerprint();
  await expectClientError(a.client.saveDraft(attempt.id, { expectedRevision: 2, text: 'veraltet' }), 'conflict', { status: 409, detail: 'draft_conflict' });
  await expectClientError(a.client.saveDraft(attempt.id, { expectedRevision: 9, text: 'Zukunft' }), 'conflict', { status: 409, detail: 'draft_conflict' });
  assert.equal(w.store.inspect.fingerprint(), before, 'a stale save writes nothing');
  const current = await a.client.readAttempt(attempt.id);
  assert.deepEqual([current.revision, current.text], [3, 'zwei']);
});

check('submission-idempotent-on-owner-and-event', async () => {
  const w = world();
  const s = await submitted(w);
  const again = await s.client.submit(s.attempt.id, { expectedRevision: s.draft.revision, eventId: s.eventId });
  assert.deepEqual(again, { submissionId: s.receipt.submissionId, replay: true });
  assert.equal(w.store.inspect.submissionCount(), 1, 'no duplicate submission');
  assert.equal(w.store.inspect.entitlement(s.account.id).reserved, 1, 'reserved exactly once');
  // Same key, different fingerprint -> conflict.
  await expectClientError(s.client.submit(s.attempt.id, { expectedRevision: s.draft.revision + 1, eventId: s.eventId }),
    'conflict', { status: 409, detail: 'idempotency_conflict' });
  // New key cannot resubmit the same frozen attempt.
  await expectClientError(s.client.submit(s.attempt.id, { expectedRevision: s.draft.revision, eventId: randomUUID() }),
    'conflict', { status: 409, detail: 'already_submitted' });
  assert.equal(w.store.inspect.submissionCount(), 1);
  // The event key is per owner: another account reusing the same eventId gets its own submission.
  const b = await learner(w, 'b');
  const attemptB = await b.client.createAttempt();
  await b.client.saveDraft(attemptB.id, { expectedRevision: 1, text: 'B Text' });
  const receiptB = await b.client.submit(attemptB.id, { expectedRevision: 2, eventId: s.eventId });
  assert.equal(receiptB.replay, false);
  assert.notEqual(receiptB.submissionId, s.receipt.submissionId);
});

check('submission-snapshot-immutable', async () => {
  const w = world();
  const s = await submitted(w, 'a', 'Original eingereicht');
  await expectClientError(s.client.saveDraft(s.attempt.id, { expectedRevision: s.draft.revision, text: 'nachträglich' }),
    'conflict', { status: 409, detail: 'revision_required' });
  const record = w.store.inspect.submission(s.receipt.submissionId);
  assert.throws(() => { record.text = 'changed'; }, TypeError, 'stored snapshot is frozen');
  const result = await s.client.readResult(s.receipt.submissionId);
  assert.equal(result.submission.text, 'Original eingereicht');
  assert.equal(result.submission.draft_revision, s.draft.revision);
  // Mutating a returned copy cannot reach the stored snapshot.
  result.submission.text = 'caller edit';
  assert.equal((await s.client.readResult(s.receipt.submissionId)).submission.text, 'Original eingereicht');
  // A new attempt linked to the submission is the only way to revise.
  const revision = await s.client.createAttempt({ parentSubmissionId: s.receipt.submissionId });
  assert.equal(revision.revision, 1);
  assert.equal((await s.client.readAttempt(revision.id)).parent_submission_id, s.receipt.submissionId);
});

check('result-never-regrades', async () => {
  const w = world();
  const s = await submitted(w);
  const id = s.receipt.submissionId;
  assert.ok(w.store.worker.claim(id));
  assert.ok(w.store.worker.complete(id, 'Synthetic formative note.'));
  const usageBefore = w.store.inspect.entitlement(s.account.id);
  const fingerprint = w.store.inspect.fingerprint();
  const reads = [];
  for (let i = 0; i < 3; i += 1) reads.push(await s.client.readResult(id));
  assert.equal(reads[0].job.status, 'succeeded');
  assert.deepEqual(reads[0].assessment.feedback, { kind: 'synthetic-formative', comment: 'Synthetic formative note.' });
  assert.deepEqual(reads[1], reads[0]);
  assert.deepEqual(reads[2], reads[0]);
  assert.equal(w.store.inspect.fingerprint(), fingerprint, 'reading a result writes nothing');
  assert.deepEqual(w.store.inspect.entitlement(s.account.id), usageBefore, 'no new debit or reservation');
  // A succeeded job is not retryable, so a result cannot be regraded through retry either.
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
});

check('retry-only-eligible-failed-job-same-identity', async () => {
  const w = world();
  const s = await submitted(w);
  const id = s.receipt.submissionId;
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
  w.store.worker.claim(id);
  w.store.worker.fail(id, 'provider_unavailable');
  assert.deepEqual(await s.client.retry(id), { queued: true });
  const result = await s.client.readResult(id);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.submission.id, id, 'same submission identity');
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
  // retry_exhausted never retries.
  w.store.worker.claim(id);
  w.store.worker.fail(id, 'retry_exhausted');
  await expectClientError(s.client.retry(id), 'conflict', { status: 409, detail: 'retry_unavailable' });
});

check('allowance-exhausted-409', async () => {
  const w = world({ allowance: 1 });
  const s = await submitted(w);
  const next = await s.client.createAttempt();
  await s.client.saveDraft(next.id, { expectedRevision: 1, text: 'zweiter Text' });
  await expectClientError(s.client.submit(next.id, { expectedRevision: 2, eventId: randomUUID() }),
    'conflict', { status: 409, detail: 'allowance_exhausted' });
});

check('delete-is-a-tombstone', async () => {
  const w = world();
  const s = await submitted(w);
  assert.deepEqual(await s.client.deleteAttempt(s.attempt.id), { deleted: true });
  assert.ok(w.store.inspect.attempt(s.attempt.id).deleted_at, 'tombstone recorded');
  assert.equal(w.store.inspect.attempt(s.attempt.id).draft, null, 'draft removed');
  assert.equal(w.store.inspect.job(s.receipt.submissionId).status, 'cancelled');
  assert.equal(w.store.inspect.entitlement(s.account.id).reserved, 0, 'reservation released');
  await expectClientError(s.client.readAttempt(s.attempt.id), 'not_found', { status: 404 });
  await expectClientError(s.client.saveDraft(s.attempt.id, { expectedRevision: 2, text: 'stale' }), 'not_found', { status: 404 });
  await expectClientError(s.client.submit(s.attempt.id, { expectedRevision: 2, eventId: s.eventId }), 'not_found', { status: 404 });
  await expectClientError(s.client.readResult(s.receipt.submissionId), 'not_found', { status: 404 });
  await expectClientError(s.client.retry(s.receipt.submissionId), 'not_found', { status: 404 });
  await expectClientError(s.client.createAttempt({ parentSubmissionId: s.receipt.submissionId }), 'not_found', { status: 404 });
  await expectClientError(s.client.deleteAttempt(s.attempt.id), 'not_found', { status: 404 });
  assert.equal(w.store.worker.complete(s.receipt.submissionId, 'late'), false, 'a late completion cannot recreate it');
});

/* -------------------------------------------------------------- ownership */

check('cross-owner-is-404-for-every-route', async () => {
  const w = world();
  const a = await submitted(w, 'a');
  const openA = await a.client.createAttempt();
  await a.client.saveDraft(openA.id, { expectedRevision: 1, text: 'A privat' });
  w.store.worker.claim(a.receipt.submissionId);
  w.store.worker.fail(a.receipt.submissionId, 'provider_unavailable'); // retry-eligible for A
  const b = await learner(w, 'b');
  const before = w.store.inspect.fingerprint();

  const attempts = [
    ['read', () => b.client.readAttempt(openA.id), () => b.client.readAttempt(ATTEMPT_ABSENT)],
    ['save', () => b.client.saveDraft(openA.id, { expectedRevision: 2, text: 'B overwrite' }),
      () => b.client.saveDraft(ATTEMPT_ABSENT, { expectedRevision: 2, text: 'x' })],
    ['submit', () => b.client.submit(openA.id, { expectedRevision: 2, eventId: randomUUID() }),
      () => b.client.submit(ATTEMPT_ABSENT, { expectedRevision: 2, eventId: randomUUID() })],
    ['result', () => b.client.readResult(a.receipt.submissionId), () => b.client.readResult(SUBMISSION_ABSENT)],
    ['retry', () => b.client.retry(a.receipt.submissionId), () => b.client.retry(SUBMISSION_ABSENT)],
    ['delete', () => b.client.deleteAttempt(openA.id), () => b.client.deleteAttempt(ATTEMPT_ABSENT)],
    ['parent', () => b.client.createAttempt({ parentSubmissionId: a.receipt.submissionId }),
      () => b.client.createAttempt({ parentSubmissionId: SUBMISSION_ABSENT })],
  ];
  for (const [label, foreign, absent] of attempts) {
    const e1 = await expectClientError(foreign(), 'not_found', { status: 404 });
    const e2 = await expectClientError(absent(), 'not_found', { status: 404 });
    assert.equal(e1.detail, e2.detail, `${label}: another owner's record must look exactly like an absent one`);
    assert.equal(e1.detail, 'not_found');
  }
  assert.equal(w.store.inspect.fingerprint(), before, 'B changed nothing that belongs to A');
  // A still owns everything, unchanged.
  assert.equal((await a.client.readAttempt(openA.id)).text, 'A privat');
  assert.deepEqual(await a.client.retry(a.receipt.submissionId), { queued: true });
});

check('identity-is-never-accepted-from-input', async () => {
  const w = world();
  const a = await learner(w, 'a');
  const b = await learner(w, 'b');
  const attemptA = await a.client.createAttempt();
  // Identity smuggled in the body is refused, not honoured.
  for (const [method, url, body] of [
    ['POST', '/api/v1/attempts', { owner_id: a.account.id }],
    ['POST', '/api/v1/attempts', { ownerId: a.account.id }],
    ['PUT', `/api/v1/attempts/${attemptA.id}`, { expectedRevision: 1, text: 'x', owner_id: a.account.id }],
    ['POST', `/api/v1/attempts/${attemptA.id}/submissions`, { expectedRevision: 1, eventId: randomUUID(), userId: a.account.id }],
  ]) {
    const res = await b.raw(method, url, body);
    assert.equal(res.status, 422, `${method} ${url}`);
    assert.deepEqual(res.json, { error: 'unknown_field' });
  }
  // Identity in the query string is ignored: B still only sees B.
  const res = await b.raw('GET', `/api/v1/account?id=${encodeURIComponent(a.account.id)}`);
  assert.equal(res.json.id, b.account.id);
  const peek = await b.raw('GET', `/api/v1/attempts/${attemptA.id}?owner=${encodeURIComponent(a.account.id)}`);
  assert.equal(peek.status, 404);
});

/* ---------------------------------------------------------- error contract */

check('error-403-mutation-without-origin-gate', async () => {
  const w = world();
  const a = await learner(w);
  const before = w.store.inspect.fingerprint();
  for (const url of ['/api/v1/attempts', '/api/v1/no-such-route', '/api/auth/sign-in/email', '/api/auth/sign-out']) {
    const res = await a.raw('POST', url, {}, { originChecked: false });
    assert.equal(res.status, 403, url);
    assert.deepEqual(res.json, { error: 'origin_rejected' });
  }
  assert.equal(w.store.inspect.fingerprint(), before);
  assert.equal(w.sessions.liveSessions(), 1, 'an ungated sign-out did not end the session');
  const read = await a.raw('GET', '/api/v1/account', undefined, { originChecked: false });
  assert.equal(read.status, 200, 'reads do not need the mutation gate');
});

check('error-404-unknown-routes-and-methods', async () => {
  const w = world();
  const a = await learner(w);
  for (const [method, url] of [
    ['GET', '/api/v1/nope'], ['GET', '/api/v1'], ['PUT', '/api/v1/attempts'], ['GET', '/api/v1/attempts'],
    ['PATCH', `/api/v1/attempts/${ATTEMPT_ABSENT}`], ['GET', '/api/v1/attempts/not-a-uuid'],
    ['POST', `/api/v1/submissions/${SUBMISSION_ABSENT}`], ['GET', '/api/auth/unknown'], ['POST', '/api/auth/sign-in/social'],
  ]) {
    const res = await a.raw(method, url, method === 'GET' ? undefined : {});
    assert.equal(res.status, 404, `${method} ${url}`);
    assert.deepEqual(res.json, { error: 'not_found' });
  }
});

check('error-400-413-415-422', async () => {
  const w = world();
  const a = await learner(w);
  const attempt = await a.client.createAttempt();
  const put = `/api/v1/attempts/${attempt.id}`;
  const cases = [
    [400, 'invalid_json', () => a.raw('PUT', put, '{"expectedRevision":1,')],
    [400, 'invalid_utf8', () => a.raw('PUT', put, new Uint8Array([0x7b, 0xff, 0x7d]))],
    [413, 'body_too_large', () => a.raw('PUT', put, JSON.stringify({ expectedRevision: 1, text: 'x'.repeat(70000) }))],
    [415, 'json_required', () => a.raw('PUT', put, '{}', { headers: { 'content-type': 'text/plain' } })],
    [422, 'invalid_body', () => a.raw('PUT', put, '[1,2]')],
    [422, 'invalid_draft', () => a.raw('PUT', put, { expectedRevision: 1, text: 'x'.repeat(12001) })],
    [422, 'invalid_draft', () => a.raw('PUT', put, { expectedRevision: 0, text: 'x' })],
    [422, 'invalid_submission', () => a.raw('POST', `${put}/submissions`, { expectedRevision: 1, eventId: 'not-a-uuid' })],
    [422, 'invalid_parent', () => a.raw('POST', '/api/v1/attempts', { parentSubmissionId: 42 })],
    [422, 'empty_submission', () => a.raw('POST', `${put}/submissions`, { expectedRevision: 1, eventId: randomUUID() })],
  ];
  const before = (await a.client.readAttempt(attempt.id)).revision;
  for (const [status, code, run] of cases) {
    const res = await run();
    assert.equal(res.status, status, code);
    assert.deepEqual(res.json, { error: code });
  }
  assert.equal((await a.client.readAttempt(attempt.id)).revision, before, 'no rejected request wrote a draft');
  // 12,000 UTF-16 code units exactly is accepted (text limit, not a byte limit).
  const ok = await a.raw('PUT', put, { expectedRevision: before, text: 'ä'.repeat(12000) });
  assert.equal(ok.status, 200);
});

check('error-500-is-redacted', async () => {
  const w = world();
  const leaky = { ...w.store.port, async read() { throw new Error('SELECT * FROM attempts -- password=synthetic-secret'); } };
  const api = createOwnedApi({ datastore: leaky, sessions: w.sessions });
  const b = inProcessBrowser(api);
  await b.client.signUp({ name: 'R', email: nextEmail('r'), password: 'pw-synthetic' });
  const res = await b.raw('GET', `/api/v1/attempts/${ATTEMPT_ABSENT}`);
  assert.equal(res.status, 500);
  assert.equal(res.text, '{"error":"internal_error"}');
  await expectClientError(b.client.readAttempt(ATTEMPT_ABSENT), 'server_error', { status: 500, detail: 'internal_error' });
});

/* ------------------------------------------------------------- fail closed */

check('fail-closed-without-ports', async () => {
  const w = world();
  const a = await learner(w);
  const cookie = cookieHeader(a.jar);
  const partialStore = { ...w.store.port };
  delete partialStore.retry;
  const variants = [
    ['no ports', createOwnedApi()],
    ['no sessions', createOwnedApi({ datastore: w.store.port })],
    ['no datastore', createOwnedApi({ sessions: w.sessions })],
    ['partial datastore', createOwnedApi({ datastore: partialStore, sessions: w.sessions })],
    ['partial sessions', createOwnedApi({ datastore: w.store.port, sessions: { getSession: w.sessions.getSession } })],
  ];
  const callsBefore = w.store.inspect.calls.length;
  for (const [label, api] of variants) {
    assert.equal(api.configured, false, label);
    for (const [method, url] of [['GET', '/api/v1/account'], ['GET', `/api/v1/attempts/${ATTEMPT_ABSENT}`],
      ['POST', '/api/v1/attempts'], ['POST', '/api/auth/sign-in/email']]) {
      const res = await api.handle({ method, path: url, headers: { cookie, 'content-type': 'application/json' }, body: '{}', originChecked: true });
      assert.equal(res.status, 503, `${label}: ${method} ${url}`);
      assert.equal(res.body, '{"error":"not_configured"}');
    }
    const client = createOwnedClient({ fetchImpl: inProcessBrowser(api).fetchImpl });
    await expectClientError(client.refreshAccount(), 'server_error', { status: 503 });
  }
  assert.equal(w.store.inspect.calls.length, callsBefore, 'no datastore method ran');
});

check('garbage-session-port-output-is-401', async () => {
  const w = world();
  for (const value of [{ userId: '' }, { userId: '   ' }, { userId: 42 }, 'user-a', ['user-a'], undefined]) {
    const api = createOwnedApi({ datastore: w.store.port, sessions: { ...w.sessions, getSession: async () => value } });
    const res = await api.handle({ method: 'GET', path: '/api/v1/account' });
    assert.equal(res.status, 401, JSON.stringify(value));
  }
});

/* ============================================ server.js mount (HTTP layer) */

// server.js resolves its .env and progress paths once, at first import, so the
// throwaway directory is created once per run and removed after the last check.
let legacy = null;
async function legacyModule() {
  if (!legacy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-api-check-'));
    process.env.B1PREP_FORCE_OFFLINE = '1';
    process.env.B1PREP_ENV_FILE = path.join(dir, 'throwaway.env');
    process.env.B1PREP_PROGRESS_FILE = path.join(dir, 'progress.json');
    legacy = { dir, progressPath: process.env.B1PREP_PROGRESS_FILE, module: await import('../server.js') };
  }
  return legacy;
}

async function startLegacyServer(options) {
  const { module, progressPath } = await legacyModule();
  const server = options === undefined ? module.createServer() : module.createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, progressPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function serverSupportsMount() {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  return /OWNAPI-01 mount/.test(source);
}

check('server-mount-off-by-default', async () => {
  const ctx = await startLegacyServer();
  try {
    const b = httpBrowser(ctx.port);
    const res = await b.request({ method: 'GET', url: '/api/v1/account' });
    assert.equal(res.status, 404, 'without an injected owned API, /api/v1 does not exist');
    const health = await b.request({ method: 'GET', url: '/api/health' });
    assert.equal(health.status, 200, 'legacy routes unchanged');
  } finally { await ctx.close(); }
});

check('server-mount-behind-sec01-origin-gate', async () => {
  if (!(await serverSupportsMount())) throw new Error('server.js has no OWNAPI-01 mount point');
  const w = world();
  const ctx = await startLegacyServer({ ownedApi: w.api });
  try {
    const foreign = httpBrowser(ctx.port, { origin: 'http://attacker.example' });
    const before = w.store.inspect.fingerprint();
    for (const url of ['/api/auth/sign-up/email', '/api/v1/attempts', '/api/v1/no-such-route']) {
      const res = await foreign.request({ method: 'POST', url, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', email: 'x@example.invalid', password: 'pw' }) });
      assert.equal(res.status, 403, `foreign-origin POST ${url}`);
    }
    const absent = httpBrowser(ctx.port, { origin: null });
    const noOrigin = await absent.request({ method: 'POST', url: '/api/v1/attempts', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 403, 'absent Origin and Referer is rejected');
    assert.equal(w.store.inspect.fingerprint(), before, 'no rejected request reached the datastore');
    assert.equal(w.sessions.liveSessions(), 0, 'no cross-origin sign-up created a session');
  } finally { await ctx.close(); }
});

check('server-mount-real-client-over-http', async () => {
  if (!(await serverSupportsMount())) throw new Error('server.js has no OWNAPI-01 mount point');
  const w = world();
  const ctx = await startLegacyServer({ ownedApi: w.api });
  try {
    const a = httpBrowser(ctx.port);
    const account = await a.client.signUp({ name: 'H', email: nextEmail('h'), password: 'pw-http-synthetic' });
    const attempt = await a.client.createAttempt();
    const draft = await a.client.saveDraft(attempt.id, { expectedRevision: 1, text: 'über HTTP' });
    const receipt = await a.client.submit(attempt.id, { expectedRevision: draft.revision, eventId: randomUUID() });
    const result = await a.client.readResult(receipt.submissionId);
    assert.equal(result.submission.text, 'über HTTP');
    assert.deepEqual(await a.client.deleteAttempt(attempt.id), { deleted: true });
    const b = httpBrowser(ctx.port);
    await b.client.signUp({ name: 'H2', email: nextEmail('h'), password: 'pw-http-synthetic' });
    await expectClientError(b.client.readResult(receipt.submissionId), 'not_found', { status: 404 });
    const raw = await a.request({ method: 'GET', url: '/api/v1/account' });
    assert.equal(raw.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(raw.text).id, account.id);
    assert.equal(fs.existsSync(ctx.progressPath), false, 'the legacy JSON progress store was never written');
  } finally { await ctx.close(); }
});

/* ==================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runOwnedApiChecks() {
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run();
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
    }
  }
  if (legacy) fs.rmSync(legacy.dir, { recursive: true, force: true });
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const report = await runOwnedApiChecks();
  for (const r of report.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
    if (!r.ok && r.error && r.error.stack) console.log(r.error.stack.split('\n').slice(1, 4).join('\n'));
  }
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  console.log('NOTE in-memory datastore and session fakes only; no PostgreSQL/RLS evidence.');
  process.exitCode = failed ? 1 : 0;
}
