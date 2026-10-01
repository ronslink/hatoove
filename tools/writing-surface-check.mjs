/**
 * Writing-surface integration checks (WRITING-SURFACE-01B).
 *
 * What this proves, in Node, over the SAME in-process stack the rest of the programme
 * uses (real `public/js/owned-client.js` + real `public/js/draft-session.js` + real
 * `server/owned-api.mjs` over the test-only in-memory datastore/session fakes exported
 * by tools/owned-api-check.mjs), plus the writing-surface controller this slice adds
 * (`public/js/writing-surface.js`) that `public/js/exam.js` delegates to:
 *
 *   1. leave and return  - text written, the screen left, the screen re-entered -> the
 *                          text comes back from the saved draft (the property `close()`'s
 *                          drop behaviour would break);
 *   2. flush before close - leaving with unsaved (debounced, unfired) text saves it; the
 *                          stored value, not the status code, is asserted;
 *   3. the fence         - a stale save is refused and the STORED text is proven unchanged
 *                          (assert the stored value, not the status code), and the
 *                          learner's local text is kept rather than discarded;
 *   4. single-user path  - a boundary that answers `unauthenticated` yields a local view
 *                          that persists nothing, exactly as before this slice.
 *
 * What this does NOT prove: any DOM or browser (exam.js's rendering of the controller is
 * exercised by the browser suites, not here); account.js's own `openDraft` wrapper (the
 * check injects the same contract: reject `{code:'unauthenticated'}` unless signed in);
 * `public/js/exam.js`'s mock-exam writing block, which is not wired by this slice; and
 * any device. No browser is started.
 *
 * Safety: offline, no database, no provider, no `.env`, synthetic text only.
 *
 * Usage: node tools/writing-surface-check.mjs
 *   runWritingSurfaceChecks({ modulePath }) lets the .test.mjs run the same checks against
 *   a deliberately broken scratch copy to prove they discriminate.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

import { createOwnedApi } from '../server/owned-api.mjs';
import { createOwnedClient } from '../public/js/owned-client.js';
import { createDraftSession } from '../public/js/draft-session.js';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

export const DEFAULT_MODULE = fileURLToPath(new URL('../public/js/writing-surface.js', import.meta.url));

/** Synthetic learner text: umlauts, an em dash, a newline and a second paragraph. */
const TEXT_A = 'Liebe Anna,\nich komme gern am Samstag – schöne Grüße aus München!\nBis bald, Alex';
const TEXT_B = 'Sehr geehrte Frau Berger,\nleider kann ich am Kurs nicht teilnehmen.\nMit freundlichen Grüßen';
const TASK = 'writing-sa1-1';

/* ================================================================ harness */

let instanceCounter = 0;
async function loadSurfaceModule(modulePath) {
  instanceCounter += 1;
  return import(`${pathToFileURL(modulePath).href}?instance=${instanceCounter}`);
}

function world() {
  const store = createMemoryDatastore({ allowance: 10 });
  const sessions = createMemorySessions();
  const api = createOwnedApi({ datastore: store.port, sessions });
  return { store, sessions, api };
}

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

function tab(w, prof) {
  const log = [];
  const hooks = {};
  const fetchImpl = async (url, init = {}) => {
    const req = { method: init.method || 'GET', url };
    if (hooks.before) await hooks.before(req);
    const headers = { ...init.headers };
    if (prof.jar.size) headers.cookie = [...prof.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await w.api.handle({ method: req.method, path: url, headers, body: init.body, originChecked: true });
    applySetCookie(prof.jar, response.headers['set-cookie']);
    log.push({ ...req, status: response.status });
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

/**
 * A second tab of the same browser profile. A freshly constructed client holds no account
 * until it asks the server, exactly as a reloaded page does at boot; the boundary in
 * account.js resolves identity before any learner data is read, so the check does too.
 */
async function reloadedTab(w, prof) {
  const t = tab(w, prof);
  const account = await t.client.refreshAccount();
  assert.ok(account, 'the shared session cookie resolves the account in the second tab');
  return t;
}

/**
 * The `openDraft` contract account.js exposes: throw `OwnedClientError('unauthenticated')`
 * unless the page is signed in, otherwise return an opened draft session.
 */
function boundaryOpenDraft(client, pointers) {
  return async (taskId) => {
    if (!client.getAccount()) {
      const error = new Error('Sign in before opening a draft');
      error.name = 'OwnedClientError';
      error.code = 'unauthenticated';
      throw error;
    }
    const session = createDraftSession({ client, pointers, taskId });
    await session.open();
    return session;
  };
}

/** A deterministic debounce: nothing fires unless the check says so. */
function scheduler() {
  let next = 0;
  const timers = new Map();
  return {
    setTimeoutFn: (fn) => { const id = ++next; timers.set(id, fn); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    fire: () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); },
    pending: () => timers.size,
  };
}

function makeSurface(ctx, t, prof, sched) {
  return ctx.mod.createWritingSurface({
    openDraft: boundaryOpenDraft(t.client, prof.pointers),
    debounceMs: 10,
    setTimeoutFn: sched.setTimeoutFn,
    clearTimeoutFn: sched.clearTimeoutFn,
  });
}

/** Let pending microtasks/immediates settle, so a fired debounce can reach the server. */
async function settle(predicate, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

/* ------------------------------------------------------- leave and return */

check('enter-restores-the-saved-text-on-return', async (ctx) => {
  const w = world();
  const prof = profile();
  const t1 = tab(w, prof);
  await signUp(t1, 'a');
  const s1 = makeSurface(ctx, t1, prof, scheduler());
  const first = await s1.enter(TASK, { initialText: '' });
  assert.equal(first.mode, 'draft', 'a signed-in page opens a draft');
  assert.equal(first.text, '', 'a fresh attempt starts empty');
  const attemptId = s1.state().attemptId;
  assert.ok(attemptId, 'the surface exposes the attempt it is bound to');

  s1.change(TEXT_A);
  await s1.leave();

  // The learner leaves the screen: the view is rendered again with a fresh surface and a
  // fresh client (a "re-entry"), sharing only the browser profile (cookie jar + pointers).
  const t2 = await reloadedTab(w, prof);
  const s2 = makeSurface(ctx, t2, prof, scheduler());
  const back = await s2.enter(TASK, { initialText: '' });
  assert.equal(back.mode, 'draft');
  assert.equal(back.text, TEXT_A, 'the text typed before leaving is restored on return');
  // And it is genuinely the server's copy, not a value the surface invented.
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, TEXT_A);
});

check('leave-flushes-unsaved-text-before-closing', async (ctx) => {
  const w = world();
  const prof = profile();
  const t = tab(w, prof);
  await signUp(t, 'a');
  const sched = scheduler();
  const s = makeSurface(ctx, t, prof, sched);
  const entered = await s.enter(TASK, { initialText: '' });
  const attemptId = s.state().attemptId;

  s.change(TEXT_B);
  assert.equal(sched.pending(), 1, 'a debounced save is pending and has NOT fired');
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, '', 'nothing is saved while the debounce is pending');

  const left = await s.leave();
  assert.equal(left.ok, true, 'leaving flushes the pending save');
  assert.equal(sched.pending(), 0, 'the pending debounce was consumed');
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, TEXT_B, 'the STORED text equals what was typed');
  assert.equal(s.state().mode, 'local', 'the session was closed only after the flush');
});

check('debounced-save-persists-without-leaving', async (ctx) => {
  const w = world();
  const prof = profile();
  const t = tab(w, prof);
  await signUp(t, 'a');
  const sched = scheduler();
  const s = makeSurface(ctx, t, prof, sched);
  await s.enter(TASK, { initialText: '' });
  const attemptId = s.state().attemptId;

  s.change(TEXT_A);
  sched.fire();
  const landed = await settle(() => w.store.inspect.attempt(attemptId).draft.text === TEXT_A);
  assert.equal(landed, true, 'the debounced save reached the server without leaving the screen');
  assert.equal(s.state().dirty, false, 'the surface reports the text as saved');
});

/* ------------------------------------------------------------------ fence */

check('stale-save-is-refused-and-stored-text-unchanged', async (ctx) => {
  const w = world();
  const prof = profile();
  const t1 = tab(w, prof);
  await signUp(t1, 'a');
  const s1 = makeSurface(ctx, t1, prof, scheduler());
  await s1.enter(TASK, { initialText: '' });
  const attemptId = s1.state().attemptId;

  // A second tab of the same browser opens the SAME attempt at the same revision.
  const t2 = await reloadedTab(w, prof);
  const s2 = makeSurface(ctx, t2, prof, scheduler());
  await s2.enter(TASK, { initialText: '' });
  assert.equal(s2.state().attemptId, attemptId, 'both tabs share the same attempt');

  s1.change(TEXT_A);
  await s1.flush();
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, TEXT_A, 'tab 1 saved first');
  const fingerprint = w.store.inspect.fingerprint();

  // Tab 2 is now stale: its save must be refused and must write nothing.
  s2.change(TEXT_B);
  const saved = await s2.flush();
  assert.equal(saved.ok, false, 'the stale save is not reported as saved');
  assert.equal(saved.reason, 'conflict', `expected a conflict, got ${saved.reason}`);
  // Assert the STORED value, not the status code: the newer text survived.
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, TEXT_A, 'the stale save did NOT overwrite the newer text');
  assert.equal(w.store.inspect.fingerprint(), fingerprint, 'the refused save wrote nothing');
  // And the learner's own text is kept, not silently discarded.
  const snap = s2.state();
  assert.equal(snap.text, TEXT_B, "the learner's text was not discarded");
  assert.ok(snap.conflict, 'the conflict is surfaced to the caller');
  assert.equal(snap.conflict.text, TEXT_A, 'the conflict carries the re-read server copy');
  assert.equal(snap.conflict.revision, 2, 'and the server revision the next save must build on');
});

check('resolving-the-conflict-locally-writes-the-kept-text', async (ctx) => {
  const w = world();
  const prof = profile();
  const t1 = tab(w, prof);
  await signUp(t1, 'a');
  const s1 = makeSurface(ctx, t1, prof, scheduler());
  await s1.enter(TASK, { initialText: '' });
  const attemptId = s1.state().attemptId;
  const t2 = await reloadedTab(w, prof);
  const s2 = makeSurface(ctx, t2, prof, scheduler());
  await s2.enter(TASK, { initialText: '' });
  s1.change(TEXT_A);
  await s1.flush();
  s2.change(TEXT_B);
  await s2.flush();

  s2.resolveConflict('local');
  const after = await s2.flush();
  assert.equal(after.ok, true, 'saving is allowed again after resolving');
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, TEXT_B, 'the kept text landed on the re-read revision');
  assert.equal(s2.state().conflict, null, 'the conflict is cleared');
});

/* ------------------------------------------------- single-user (unchanged) */

check('single-user-path-persists-nothing', async (ctx) => {
  const w = world();
  const prof = profile();
  const t = tab(w, prof); // never signed in -> accounts off / anonymous
  const sched = scheduler();
  const s = makeSurface(ctx, t, prof, sched);

  const entered = await s.enter(TASK, { initialText: 'local text' });
  assert.equal(entered.mode, 'local', 'the boundary refusal becomes a view state, not a throw');
  assert.equal(entered.reason, 'single-user');
  assert.equal(entered.text, 'local text', 'the text already in the textarea is preserved');

  s.change('local text, edited');
  assert.equal(sched.pending(), 0, 'nothing is scheduled without a draft session');
  const left = await s.leave();
  assert.equal(left.ok, true, 'leaving is a no-op, as before this slice');
  assert.deepEqual(w.store.inspect.calls, [], 'no datastore method ran on the single-user path');
  assert.equal(prof.pointers.map.size, 0, 'no draft pointer was written');
});

check('a-failed-save-does-not-drop-the-text', async (ctx) => {
  const w = world();
  const prof = profile();
  const t = tab(w, prof);
  await signUp(t, 'a');
  const s = makeSurface(ctx, t, prof, scheduler());
  await s.enter(TASK, { initialText: '' });
  const attemptId = s.state().attemptId;

  t.hooks.before = (req) => { if (req.method === 'PUT') throw new TypeError('offline'); };
  s.change(TEXT_A);
  const left = await s.leave();
  assert.equal(left.ok, false, 'an unreachable server is not reported as saved');
  assert.equal(s.state().mode, 'draft', 'the session is kept, so the text is not dropped');
  assert.equal(s.state().text, TEXT_A, 'the learner keeps their text in memory');
  assert.equal(w.store.inspect.attempt(attemptId).draft.text, '', 'the server never received it');

  // Re-entering the same task must not lose the held text (it is re-flushed on it).
  t.hooks.before = undefined;
  const again = await s.enter(TASK, { initialText: '' });
  assert.equal(again.text, TEXT_A, 're-entering does not lose the unsaved text');
});

/* ==================================================================== run */

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runWritingSurfaceChecks({ modulePath = DEFAULT_MODULE } = {}) {
  const results = [];
  let mod = null;
  let loadError = null;
  try {
    mod = await loadSurfaceModule(modulePath);
    if (typeof mod.createWritingSurface !== 'function' || typeof mod.writingTaskId !== 'function') {
      loadError = new Error('writing-surface.js must export createWritingSurface() and writingTaskId()');
    }
  } catch (error) {
    loadError = error;
  }
  if (loadError) {
    return { ok: false, results: checks.map((c) => ({ name: c.name, ok: false, detail: `module did not load: ${loadError.message}` })) };
  }
  const ctx = { mod };
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
  const report = await runWritingSurfaceChecks({ modulePath });
  for (const r of report.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
  }
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed${modulePath === DEFAULT_MODULE ? '' : ` (module: ${modulePath})`}`);
  console.log('NOTE in-memory datastore/session/pointer fakes only; no browser, no DOM, no PostgreSQL.');
  process.exitCode = failed ? 1 : 0;
}
