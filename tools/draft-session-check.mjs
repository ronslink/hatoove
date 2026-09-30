/**
 * Checks for the recoverable-draft service layer (DRAFT-SESSION-01).
 *
 * What this proves
 *   * public/js/draft-session.js driving the REAL public/js/owned-client.js against
 *     the REAL server/owned-api.mjs handler. The datastore and session ports are the
 *     in-memory, test-only fakes exported by tools/owned-api-check.mjs (reused, not
 *     re-implemented). Only the ~20-line in-process fetch adapter is repeated here,
 *     because owned-api-check.mjs does not export its `inProcessBrowser`; it adds a
 *     shared per-"browser" cookie jar (two tabs, one profile) and fault hooks.
 *   * Recovery across a simulated reload: a fresh module instance (cache-busted
 *     import), a fresh client, the same cookie jar and the same injected pointer store.
 *   * Revision discipline, account isolation, submit/result and fail-closed behaviour.
 *
 * What this does NOT prove
 *   * Anything in a browser or on a device (DRAFT-RECOVERY-MATRIX section D stays
 *     open), a durable pointer store (the one here is an in-memory Map), PostgreSQL/RLS,
 *     or real auth. No browser is started. `public/js/exam.js` is not wired.
 *
 * Safety: offline, no database, no provider, no `.env`, synthetic text only.
 *
 * Usage: node tools/draft-session-check.mjs   (exit 0 when every check passes)
 *   runDraftSessionChecks({modulePath, wrapDatastore}) lets the .test.mjs run the same
 *   checks against a deliberately broken scratch copy to prove they discriminate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

import { createOwnedApi } from '../server/owned-api.mjs';
import { createOwnedClient } from '../public/js/owned-client.js';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

export const DEFAULT_MODULE = fileURLToPath(new URL('../public/js/draft-session.js', import.meta.url));

/** Synthetic learner text: umlauts, Arabic, emoji and newlines (matrix R1/R2). */
const TEXT_A = 'Liebe Anna,\nich komme gern am Samstag – schöne Grüße! 😊\nمرحبا\n';
const TEXT_A2 = `${TEXT_A}Viele Grüße, Mira`;
const TEXT_B = 'Sehr geehrte Damen und Herren, ich schreibe wegen der Wohnung.';
const TASK = 'writing-b1-synthetic-t1';

/* ================================================================ harness */

let instanceCounter = 0;
/** A fresh module instance each call: nothing module-scoped can survive a "reload". */
async function loadSessionModule(modulePath) {
  instanceCounter += 1;
  return import(`${pathToFileURL(modulePath).href}?instance=${instanceCounter}`);
}

function world({ allowance, wrapDatastore } = {}) {
  const store = createMemoryDatastore({ allowance });
  const sessions = createMemorySessions();
  const port = wrapDatastore ? wrapDatastore(store.port) : store.port;
  const api = createOwnedApi({ datastore: port, sessions });
  return { store, sessions, api };
}

/** Test pointer store: ids only, deep-copied in and out. Stands in for durable storage. */
function memoryPointers() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
  };
}

/** One browser profile: a cookie jar and a pointer store shared by every tab/reload. */
const profile = () => ({ jar: new Map(), pointers: memoryPointers() });

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

/**
 * A tab: the real owned client over an in-process fetch into the real handler.
 * hooks.before(req)  may throw to simulate a request that never reached the server;
 * hooks.after(req)   may throw to simulate a lost response after the server committed;
 * hooks.hold(req)    may return a promise that delays delivery of the response.
 */
function tab(w, prof) {
  const log = [];
  const hooks = {};
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.credentials, 'same-origin', 'the client must send same-origin credentials');
    const req = { method: init.method || 'GET', url };
    if (hooks.before) await hooks.before(req);
    const headers = { ...init.headers };
    if (prof.jar.size) headers.cookie = [...prof.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await w.api.handle({ method: req.method, path: url, headers, body: init.body, originChecked: true });
    applySetCookie(prof.jar, response.headers['set-cookie']);
    log.push({ ...req, status: response.status, body: response.body });
    if (hooks.hold) await hooks.hold(req);
    if (hooks.after) await hooks.after(req);
    return { status: response.status, text: async () => response.body };
  };
  return { log, hooks, client: createOwnedClient({ fetchImpl }) };
}

let emailCounter = 0;
async function signUp(t, tag) {
  emailCounter += 1;
  return t.client.signUp({ name: `Learner ${tag}`, email: `${tag}-${emailCounter}@example.invalid`, password: `pw-${tag}-synthetic` });
}

/** A signed-in tab with an open draft session. */
async function opened(ctx, w, prof, { tag = 'a', signIn = true } = {}) {
  const t = tab(w, prof);
  const account = signIn ? await signUp(t, tag) : null;
  const mod = await loadSessionModule(ctx.modulePath);
  const session = mod.createDraftSession({ client: t.client, pointers: prof.pointers, taskId: TASK });
  const first = await session.open();
  return { ...t, account, mod, session, first };
}

/** A "reload": fresh module instance and client, same cookie jar and pointer store. */
async function reload(ctx, w, prof) {
  const t = tab(w, prof);
  const mod = await loadSessionModule(ctx.modulePath);
  const session = mod.createDraftSession({ client: t.client, pointers: prof.pointers, taskId: TASK });
  return { ...t, mod, session };
}

async function expectCode(promiseOrFn, code) {
  let error;
  try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn); } catch (e) { error = e; }
  assert.ok(error, `expected ${code}, got success`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
  return error;
}

const writes = (log) => log.filter((e) => e.method !== 'GET').map((e) => `${e.method} ${e.url}`);

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ------------------------------------------------------------- start/resume */

check('open-creates-one-owned-attempt-and-records-only-ids', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  assert.equal(a.first.status, 'saved');
  assert.equal(a.first.revision, 1);
  assert.equal(a.first.text, '');
  assert.equal(w.store.inspect.attempt(a.first.attemptId).owner_id, a.account.id);
  const pointers = [...prof.pointers.map.values()];
  assert.equal(pointers.length, 1);
  assert.deepEqual(Object.keys(pointers[0]).sort(), ['attemptId', 'pendingEventId', 'submissionId']);
  assert.equal(pointers[0].attemptId, a.first.attemptId);
  // Opening again in the same session resumes rather than creating a second attempt.
  const again = await a.session.open();
  assert.equal(again.attemptId, a.first.attemptId);
  assert.equal(w.store.inspect.calls.filter((c) => c === 'create').length, 1);
});

check('recovery-across-simulated-reload', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  assert.deepEqual(await a.session.save(TEXT_A), { status: 'saved', revision: 2 });
  assert.deepEqual(await a.session.save(TEXT_A2), { status: 'saved', revision: 3 });

  // The page goes away: module instance, client and session are all discarded.
  const r = await reload(ctx, w, prof);
  assert.notEqual(r.mod, a.mod, 'the reload uses a fresh module instance');
  assert.equal(r.session.snapshot(), null, 'a fresh instance holds no text before recovery');
  const recovered = await r.session.open();
  assert.equal(recovered.text, TEXT_A2, 'the exact latest text comes back');
  assert.equal(recovered.text.length, TEXT_A2.length);
  assert.equal(recovered.revision, 3, 'with the revision the server holds');
  assert.equal(recovered.attemptId, a.first.attemptId);
  assert.equal(recovered.status, 'saved');
  assert.equal(recovered.dirty, false);
  assert.equal(w.store.inspect.calls.filter((c) => c === 'create').length, 1, 'no second attempt was created');
  // The recovered session continues from the recovered revision.
  assert.deepEqual(await r.session.save(`${TEXT_A2}!`), { status: 'saved', revision: 4 });
});

check('unsaved-text-is-not-invented-after-reload', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  await a.session.save(TEXT_A);
  a.hooks.before = () => { throw new TypeError('offline'); };
  await expectCode(a.session.save(TEXT_A2), 'network_error');
  const offline = a.session.snapshot();
  assert.equal(offline.text, TEXT_A2, 'the learner keeps the unsaved text in memory (R5)');
  assert.equal(offline.status, 'unsaved');
  assert.equal(offline.revision, 2);
  const r = await reload(ctx, w, prof);
  const recovered = await r.session.open();
  assert.equal(recovered.text, TEXT_A, 'only server-saved text is recovered; nothing is invented');
  assert.equal(recovered.revision, 2);
});

/* ------------------------------------------------------ revision discipline */

check('stale-save-rejected-writes-nothing', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const one = await opened(ctx, w, prof);          // tab 1
  const two = await reload(ctx, w, prof);          // tab 2, same browser profile
  await two.session.open();
  assert.equal(two.session.snapshot().revision, 1);
  assert.deepEqual(await one.session.save(TEXT_A), { status: 'saved', revision: 2 });

  const before = w.store.inspect.fingerprint();
  const outcome = await two.session.save(TEXT_B);  // tab 2 still believes revision 1
  assert.equal(outcome.status, 'conflict', `a stale save must conflict, got ${JSON.stringify(outcome)}`);
  assert.equal(w.store.inspect.fingerprint(), before, 'the stale save wrote nothing');
  assert.deepEqual(outcome.server, { revision: 2, text: TEXT_A }, 'the conflict carries the re-read server copy');
  assert.equal(outcome.local, TEXT_B, 'the local text is preserved, not discarded');
  const puts = two.log.filter((e) => e.method === 'PUT');
  assert.equal(puts.length, 1, 'the stale snapshot was sent once and never retried');
  assert.equal(puts[0].status, 409);
  assert.equal(two.session.snapshot().status, 'conflict');

  // Further saves are refused locally until the conflict is resolved.
  const sent = two.log.length;
  await expectCode(two.session.save(`${TEXT_B} mehr`), 'conflict_unresolved');
  await expectCode(two.session.submit(), 'conflict_unresolved');
  assert.equal(two.log.length, sent, 'nothing was sent while the conflict is open');
  assert.equal(w.store.inspect.fingerprint(), before);

  // Explicitly keeping the local text: the next save lands on the re-read revision.
  const kept = two.session.resolveConflict('local');
  assert.deepEqual([kept.revision, kept.status, kept.text], [2, 'unsaved', `${TEXT_B} mehr`]);
  assert.deepEqual(await two.session.save(TEXT_B), { status: 'saved', revision: 3 });
  const stored = w.store.inspect.attempt(one.first.attemptId).draft;
  assert.deepEqual(stored, { revision: 3, text: TEXT_B });
  // Tab 1 is now the stale one and is refused in turn.
  const back = await one.session.save(`${TEXT_A} spät`);
  assert.equal(back.status, 'conflict');
  assert.deepEqual(w.store.inspect.attempt(one.first.attemptId).draft, { revision: 3, text: TEXT_B });
});

check('conflict-resolved-to-server-adopts-server-copy', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const one = await opened(ctx, w, prof);
  const two = await reload(ctx, w, prof);
  await two.session.open();
  await one.session.save(TEXT_A);
  assert.equal((await two.session.save(TEXT_B)).status, 'conflict');
  const taken = two.session.resolveConflict('server');
  assert.deepEqual([taken.text, taken.revision, taken.status, taken.dirty], [TEXT_A, 2, 'saved', false]);
  assert.deepEqual(await two.session.save(TEXT_A), { status: 'unchanged', revision: 2 });
  assert.throws(() => two.session.resolveConflict('server'), { code: 'invalid_request' });
});

check('repeated-and-concurrent-saves-do-not-corrupt', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  assert.deepEqual(await a.session.save(TEXT_A), { status: 'saved', revision: 2 });
  const fingerprint = w.store.inspect.fingerprint();
  const sent = a.log.length;
  assert.deepEqual(await a.session.save(TEXT_A), { status: 'unchanged', revision: 2 });
  assert.equal(a.log.length, sent, 'an unchanged save sends nothing');
  assert.equal(w.store.inspect.fingerprint(), fingerprint);

  // Double-fired save of the same text: one write, one increment, no self-conflict.
  const dup = await Promise.all([a.session.save(TEXT_A2), a.session.save(TEXT_A2)]);
  assert.deepEqual(dup, [{ status: 'saved', revision: 3 }, { status: 'unchanged', revision: 3 }]);
  // Two different texts fired together are applied in order, each on the previous revision.
  const both = await Promise.all([a.session.save('eins'), a.session.save('zwei')]);
  assert.deepEqual(both, [{ status: 'saved', revision: 4 }, { status: 'saved', revision: 5 }]);
  assert.deepEqual(w.store.inspect.attempt(a.first.attemptId).draft, { revision: 5, text: 'zwei' });
  assert.equal(a.log.filter((e) => e.status === 409).length, 0, 'the session never conflicted with itself');
});

/* --------------------------------------------------------- account isolation */

check('sign-out-drops-text-and-next-account-cannot-recover-it', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof, { tag: 'a' });
  await a.session.save(TEXT_A);
  await a.session.signOut();
  assert.equal(a.session.snapshot(), null, 'no text is held after sign-out');
  await expectCode(a.session.save('nach dem Abmelden'), 'not_open');
  await expectCode(a.session.readResult(), 'not_open');
  assert.equal(prof.jar.size, 0, 'the session cookie is gone');

  // Account B on the same browser profile (same jar, same pointer store).
  const b = tab(w, prof);
  const accountB = await signUp(b, 'b');
  const mod = await loadSessionModule(ctx.modulePath);
  const sessionB = mod.createDraftSession({ client: b.client, pointers: prof.pointers, taskId: TASK });
  const openedB = await sessionB.open();
  assert.equal(openedB.text, '', 'B starts empty');
  assert.equal(openedB.revision, 1);
  assert.notEqual(openedB.attemptId, a.first.attemptId, 'B gets its own attempt');
  assert.equal(w.store.inspect.attempt(openedB.attemptId).owner_id, accountB.id);

  // Leak scan over everything B could see: responses, snapshot, pointer store.
  const visible = JSON.stringify({ log: b.log, snap: sessionB.snapshot(), pointers: [...prof.pointers.map] });
  for (const fragment of ['Liebe Anna', 'مرحبا', 'Samstag']) {
    assert.ok(!visible.includes(fragment), `A's text leaked to B: ${fragment}`);
  }
  // A's draft is intact server-side for A's next sign-in.
  assert.deepEqual(w.store.inspect.attempt(a.first.attemptId).draft, { revision: 2, text: TEXT_A });
});

check('forged-pointer-to-another-account-resolves-to-nothing', async (ctx) => {
  const w = world(ctx);
  const profA = profile();
  const a = await opened(ctx, w, profA, { tag: 'a' });
  await a.session.save(TEXT_A);
  // B's profile is seeded with a pointer naming A's attempt under B's key.
  const profB = profile();
  const b = tab(w, profB);
  const accountB = await signUp(b, 'b');
  const key = `draft\u0000${accountB.id}\u0000${TASK}`;
  await profB.pointers.set(key, { attemptId: a.first.attemptId, submissionId: null, pendingEventId: null });
  const mod = await loadSessionModule(ctx.modulePath);
  const sessionB = mod.createDraftSession({ client: b.client, pointers: profB.pointers, taskId: TASK });
  const got = await sessionB.open();
  assert.equal(got.text, '', 'the server refused the foreign attempt; nothing was invented');
  assert.notEqual(got.attemptId, a.first.attemptId);
  assert.equal(b.log.find((e) => e.url.endsWith(a.first.attemptId)).status, 404);
  assert.equal((await profB.pointers.get(key)).attemptId, got.attemptId, 'the forged hint was replaced');
  assert.ok(!JSON.stringify(b.log).includes('Liebe Anna'));
});

check('late-response-after-sign-out-does-not-land', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  a.hooks.hold = (req) => (req.method === 'PUT' ? gate : undefined);
  const pending = a.session.save(TEXT_A);
  await new Promise((resolve) => setImmediate(resolve));
  a.hooks.hold = undefined;
  await a.session.signOut();
  release();
  await expectCode(pending, 'stale_session');
  assert.equal(a.session.snapshot(), null, 'the late response did not repopulate the session');
});

check('account-switch-under-an-open-session-fails-closed', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof, { tag: 'a' });
  await a.session.save(TEXT_A);
  // Same client object signs in as someone else without the session's knowledge.
  await a.client.signOut();
  await signUp(a, 'b');
  const sent = a.log.length;
  await expectCode(a.session.save(TEXT_B), 'stale_session');
  assert.equal(a.log.length, sent, 'nothing was sent under the new account');
  assert.equal(a.session.snapshot(), null, "A's text was dropped");
  // client.clear() alone also fences it.
  const c = await opened(ctx, w, profile(), { tag: 'c' });
  await c.session.save(TEXT_A);
  c.client.clear();
  await expectCode(c.session.save(TEXT_A2), 'stale_session');
  assert.equal(c.session.snapshot(), null);
});

/* ----------------------------------------------------------- submit/result */

check('submit-freezes-the-saved-revision', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  await expectCode(a.session.readResult(), 'not_submitted');
  await a.session.save(TEXT_A);
  // Unsaved local text is never submitted.
  a.hooks.before = (req) => { if (req.method === 'PUT') throw new TypeError('offline'); };
  await expectCode(a.session.save(TEXT_A2), 'network_error');
  a.hooks.before = undefined;
  const sent = a.log.length;
  await expectCode(a.session.submit(), 'unsaved_changes');
  assert.equal(a.log.length, sent, 'nothing was sent');
  assert.equal(w.store.inspect.submissionCount(), 0);
  // Back to the saved text, then submit.
  assert.deepEqual(await a.session.save(TEXT_A), { status: 'unchanged', revision: 2 });
  const receipt = await a.session.submit();
  assert.equal(receipt.replay, false);
  const frozen = w.store.inspect.submission(receipt.submissionId);
  assert.deepEqual([frozen.text, frozen.draft_revision], [TEXT_A, 2]);
  assert.equal(a.session.snapshot().status, 'submitted');
  // Frozen: saving is refused locally and nothing is sent.
  const after = a.log.length;
  await expectCode(a.session.save(TEXT_B), 'already_submitted');
  assert.equal(a.log.length, after);
  assert.deepEqual(await a.session.submit(), { submissionId: receipt.submissionId, replay: true });
  assert.equal(w.store.inspect.submissionCount(), 1);
  // After a reload the submission is recovered from the pointer.
  const r = await reload(ctx, w, prof);
  const back = await r.session.open();
  assert.deepEqual([back.status, back.submissionId, back.text], ['submitted', receipt.submissionId, TEXT_A]);
  const result = await r.session.readResult();
  assert.equal(result.submission.text, TEXT_A);
});

check('uncertain-submit-reuses-the-same-event-id-after-reload', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  await a.session.save(TEXT_A);
  // The server commits the submission but the response is lost.
  a.hooks.after = (req) => { if (req.url.endsWith('/submissions')) throw new TypeError('connection reset'); };
  await expectCode(a.session.submit(), 'network_error');
  assert.equal(w.store.inspect.submissionCount(), 1, 'the server did commit');
  assert.equal(a.session.snapshot().status, 'submit_pending');
  await expectCode(a.session.save(TEXT_B), 'already_submitted');
  const pending = [...prof.pointers.map.values()][0].pendingEventId;
  assert.ok(pending, 'the event id was recorded before sending');

  const r = await reload(ctx, w, prof);
  const back = await r.session.open();
  assert.equal(back.status, 'submit_pending');
  const receipt = await r.session.submit();
  assert.equal(receipt.replay, true, 'the same event id resolved to the committed submission');
  assert.equal(w.store.inspect.submissionCount(), 1, 'no second submission');
  assert.equal(w.store.inspect.submission(receipt.submissionId).event_id, pending);
  assert.equal(w.store.inspect.entitlement(a.account.id).reserved, 1, 'reserved exactly once');
  assert.equal(r.session.snapshot().status, 'submitted');
});

check('definite-submit-rejection-releases-the-event-id', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  // Empty text: the server answers 422 and commits nothing.
  await expectCode(a.session.submit(), 'unprocessable');
  assert.equal(a.session.snapshot().status, 'saved', 'no pending submission is left behind');
  assert.equal([...prof.pointers.map.values()][0].pendingEventId, null);
  assert.deepEqual(await a.session.save(TEXT_A), { status: 'saved', revision: 2 });
  assert.equal((await a.session.submit()).replay, false);
});

check('read-result-never-regrades', async (ctx) => {
  const w = world(ctx);
  const prof = profile();
  const a = await opened(ctx, w, prof);
  await a.session.save(TEXT_A);
  const { submissionId } = await a.session.submit();
  assert.equal((await a.session.readResult()).job.status, 'queued');
  assert.ok(w.store.worker.claim(submissionId));
  assert.ok(w.store.worker.complete(submissionId, 'Synthetic formative note.'));
  const fingerprint = w.store.inspect.fingerprint();
  const usage = w.store.inspect.entitlement(a.account.id);
  const callsBefore = w.store.inspect.calls.length;
  const reads = [];
  for (let i = 0; i < 3; i += 1) reads.push(await a.session.readResult());
  assert.equal(reads[0].job.status, 'succeeded');
  assert.deepEqual(reads[1], reads[0]);
  assert.deepEqual(reads[2], reads[0]);
  assert.deepEqual(w.store.inspect.calls.slice(callsBefore), ['result', 'result', 'result'], 'reads only; no retry');
  assert.equal(w.store.inspect.fingerprint(), fingerprint, 'reading a result writes nothing');
  assert.deepEqual(w.store.inspect.entitlement(a.account.id), usage, 'no new debit or reservation');
  // Failed result stays unassessed; readResult still does not retry it.
  const b = await opened(ctx, w, profile(), { tag: 'b' });
  await b.session.save(TEXT_B);
  const failed = (await b.session.submit()).submissionId;
  w.store.worker.claim(failed);
  w.store.worker.fail(failed, 'provider_unavailable');
  const unassessed = await b.session.readResult();
  assert.deepEqual([unassessed.job.status, unassessed.assessment], ['failed', null]);
  assert.equal(w.store.inspect.job(failed).status, 'failed', 'no retry was queued by reading');
});

/* ------------------------------------------- the module's OWN fence, in isolation */

/**
 * The #51 reviewer's non-blocking finding, closed.
 *
 * The checks above exercise the fence through `owned-client.js`, whose own generation guard
 * throws `stale_session` FIRST - so the module's own guard was never the thing being tested, and
 * deleting it from `draft-session.js` still left every check green. This check drives the module
 * with a transport that does NOT guard: it silently switches account and bumps `generation` under
 * an open session, exactly as a broken or hostile client could. Only the module's own fence can
 * refuse that, so if this check passes the guard is load-bearing rather than redundant.
 */
check('own-fence-holds-when-the-transport-does-not', async (ctx) => {
  const { createDraftSession } = await loadSessionModule(ctx.modulePath);
  const pointers = memoryPointers();
  const accountA = { id: 'user-00000000-0000-4000-8000-00000000000a', email: 'a@example.invalid' };
  const accountB = { id: 'user-00000000-0000-4000-8000-00000000000b', email: 'b@example.invalid' };
  const attempt = { id: '11111111-1111-4111-8111-111111111111', revision: 1, text: '' };
  const sent = [];

  // A transport with NO fence of its own: no throwing on an account change, no generation check.
  let current = accountA;
  const fake = {
    generation: 1,
    getAccount: () => current,
    refreshAccount: async () => current,
    createAttempt: async () => ({ ...attempt }),
    readAttempt: async () => ({ ...attempt }),
    saveDraft: async (id, { expectedRevision, text }) => {
      sent.push({ text });
      attempt.revision = expectedRevision + 1;
      attempt.text = text;
      return { revision: attempt.revision, text };
    },
    submit: async () => ({ submissionId: '22222222-2222-4222-8222-222222222222', replay: false }),
    readResult: async () => ({ submission: { id: '22222222-2222-4222-8222-222222222222' }, job: { status: 'queued' }, assessment: null }),
    signOut: async () => { current = null; },
    clear: () => { current = null; },
  };

  const session = createDraftSession({ client: fake, pointers, taskId: TASK });
  const first = await session.open();
  assert.equal(first.text, '');
  assert.deepEqual(await session.save(TEXT_A), { status: 'saved', revision: 2 });
  assert.equal(sent.length, 1);

  // The account changes underneath the open session, and the transport says nothing about it.
  current = accountB;
  fake.generation += 1;

  await expectCode(session.save(TEXT_B), 'stale_session');
  assert.equal(sent.length, 1, 'nothing was written to B under the old session');
  assert.equal(session.snapshot(), null, 'the local text was dropped, not carried across accounts');

  // And with the account restored, the dropped session stays dropped. The refusal is `not_open`
  // on this SECOND call rather than `stale_session`, because the first breach already dropped the
  // state - that is the module's documented behaviour, so the check records it instead of
  // demanding a particular code. What matters is that nothing is sent and open() is required again.
  current = accountA;
  const after = await expectCode(session.save(TEXT_A), 'not_open');
  assert.equal(after.code, 'not_open');
  assert.equal(sent.length, 1, 'a fenced session does not come back to life on its own');
  assert.equal((await session.open()).text, TEXT_A, 're-opening recovers the server copy');
});

/* ---------------------------------------------------------------- fail closed */

check('fail-closed-without-client-or-account', async (ctx) => {
  const { createDraftSession } = await loadSessionModule(ctx.modulePath);
  const pointers = memoryPointers();
  for (const [label, options] of [
    ['nothing', undefined],
    ['no client', { pointers, taskId: TASK }],
    ['fake client', { client: {}, pointers, taskId: TASK }],
    ['no pointer store', { client: createOwnedClient({ fetchImpl: async () => { throw new Error('unreachable'); } }), taskId: TASK }],
  ]) {
    assert.throws(() => createDraftSession(options), { code: 'not_configured' }, label);
  }

  // A client whose transport never reaches a server: open() rejects; no draft is invented.
  const unreachable = createOwnedClient({ fetchImpl: async () => { throw new TypeError('offline'); } });
  const noTransport = createDraftSession({ client: unreachable, pointers, taskId: TASK });
  await expectCode(noTransport.open(), 'network_error');
  assert.equal(noTransport.snapshot(), null);
  await expectCode(noTransport.save(TEXT_A), 'not_open');
  await expectCode(noTransport.submit(), 'not_open');

  // Signed out: no attempt is created, no datastore method runs.
  const w = world(ctx);
  const anon = tab(w, profile());
  const s = createDraftSession({ client: anon.client, pointers, taskId: TASK });
  await expectCode(s.open(), 'unauthenticated');
  assert.equal(s.snapshot(), null);
  assert.deepEqual(w.store.inspect.calls, [], 'no datastore method ran');
  assert.equal(pointers.map.size, 0, 'no pointer was written');

  // Server not configured (503): rejected, not reported as an empty draft.
  const down = createOwnedApi();
  const t = tab({ api: down }, profile());
  const s503 = createDraftSession({ client: t.client, pointers, taskId: TASK });
  await expectCode(s503.open(), 'server_error');
  assert.equal(s503.snapshot(), null);

  // Network down while resuming: the error surfaces; no fresh empty attempt replaces the draft.
  const prof = profile();
  const a = await opened(ctx, w, prof);
  await a.session.save(TEXT_A);
  const r = await reload(ctx, w, prof);
  r.hooks.before = (req) => { if (req.url.startsWith('/api/v1/attempts')) throw new TypeError('offline'); };
  await expectCode(r.session.open(), 'network_error');
  assert.equal(r.session.snapshot(), null);
  assert.equal(w.store.inspect.calls.filter((c) => c === 'create').length, 1, 'no replacement attempt was created');
  assert.equal([...prof.pointers.map.values()][0].attemptId, a.first.attemptId, 'the pointer survived');
});

check('invalid-input-is-refused-before-sending', async (ctx) => {
  const { createDraftSession } = await loadSessionModule(ctx.modulePath);
  const client = createOwnedClient({ fetchImpl: async () => { throw new Error('must not be called'); } });
  for (const taskId of [undefined, '', '../x', 'a b', 'x'.repeat(129), 42]) {
    assert.throws(() => createDraftSession({ client, pointers: memoryPointers(), taskId }), { code: 'invalid_request' }, String(taskId));
  }
  const w = world(ctx);
  const a = await opened(ctx, w, profile());
  const sent = a.log.length;
  await expectCode(a.session.save('x'.repeat(12001)), 'invalid_request');
  await expectCode(a.session.save(42), 'invalid_request');
  assert.throws(() => a.session.resolveConflict('local'), { code: 'invalid_request' });
  assert.equal(a.log.length, sent);
  // A malformed pointer record is ignored, never trusted.
  const prof = profile();
  const b = tab(w, prof);
  const acct = await signUp(b, 'm');
  await prof.pointers.set(`draft\u0000${acct.id}\u0000${TASK}`, { attemptId: '../../api/v1/account' });
  const s = createDraftSession({ client: b.client, pointers: prof.pointers, taskId: TASK });
  const got = await s.open();
  assert.equal(got.revision, 1);
  assert.deepEqual(writes(b.log).slice(-1), ['POST /api/v1/attempts']);
});

check('snapshot-is-a-copy-and-module-has-no-ambient-state', async (ctx) => {
  const w = world(ctx);
  const a = await opened(ctx, w, profile());
  await a.session.save(TEXT_A);
  const snap = a.session.snapshot();
  snap.text = 'tampered';
  snap.revision = 99;
  assert.equal(a.session.snapshot().text, TEXT_A);
  assert.equal(a.session.snapshot().revision, 2);
  const source = fs.readFileSync(ctx.modulePath, 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
  for (const banned of [/\bimport\b/, /localStorage|sessionStorage|indexedDB/, /\bdocument\b|\bwindow\b/, /setTimeout|setInterval/, /\bfetch\(/]) {
    assert.ok(!banned.test(code), `draft-session.js must not use ${banned}`);
  }
});

/* ==================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runDraftSessionChecks({ modulePath = DEFAULT_MODULE, wrapDatastore } = {}) {
  const ctx = { modulePath, wrapDatastore };
  const results = [];
  for (const { name, run } of checks) {
    try {
      await run(ctx);
      results.push({ name, ok: true, detail: 'ok' });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const modulePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_MODULE;
  const report = await runDraftSessionChecks({ modulePath });
  for (const r of report.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
  }
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed${modulePath === DEFAULT_MODULE ? '' : ` (module: ${modulePath})`}`);
  console.log('NOTE in-memory datastore, session and pointer fakes only; no browser/device, no PostgreSQL/RLS evidence.');
  process.exitCode = failed ? 1 : 0;
}
