/**
 * Writing-surface controller (WRITING-SURFACE-01B).
 *
 * Binds a writing task's text to the account's recoverable draft session through the
 * session boundary, WITHOUT touching the DOM: `public/js/exam.js` renders the textarea
 * and calls `enter()` / `change()` / `leave()`, while the save / restore / flush /
 * conflict policy lives here, where a check can prove it.
 *
 * Why a separate module and not the view directly: `close()` on a draft session drops
 * the local text, so the ordering "flush, THEN close" is the whole slice. Keeping that
 * ordering in one place, exercised by `tools/writing-surface-check.mjs` against the real
 * draft service, is what makes it checkable at all.
 *
 * Contract notes, read from public/js/draft-session.js and public/js/account.js:
 *   - `openDraft(taskId)` (the injected dependency) is async and throws
 *     `OwnedClientError('unauthenticated')` when the page is not signed in; that is a
 *     VIEW STATE, not a crash, so `enter()` resolves with `mode: 'local'`.
 *   - the public write is `save(text)`; state is read with `snapshot()` (synchronous).
 *     `save()` resolves to {status:'saved'|'unchanged'|'conflict'}; it REJECTS on invalid
 *     input, on a network failure (text kept in memory as unsaved) or with
 *     `already_submitted` when the attempt was frozen elsewhere.
 *   - `close()` drops local text without contacting the server - never close while dirty.
 */
export const WRITING_TASK_PREFIX = 'writing-sa1-';

/** Task identity for the draft pointer: one draft per rotation slot, stable on re-entry. */
export function writingTaskId(index) {
  const n = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  return `${WRITING_TASK_PREFIX}${n}`;
}

/**
 * @param {object} options
 * @param {Function} options.openDraft  async (taskId) => draft session; rejects to refuse
 * @param {number}   [options.debounceMs]  idle time before an autosave (default 1200)
 * @param {Function} [options.setTimeoutFn] injected scheduler (checks drive it by hand)
 * @param {Function} [options.clearTimeoutFn]
 * @param {Function} [options.onState]     called with `state()` after every change
 */
export function createWritingSurface(options = {}) {
  const openDraft = options.openDraft;
  if (typeof openDraft !== 'function') throw new TypeError('createWritingSurface needs an openDraft function');
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 1200;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : (id) => clearTimeout(id);
  const onState = typeof options.onState === 'function' ? options.onState : null;

  let session = null;   // the draft session while signed in and open
  let mode = 'local';   // 'draft' (account) | 'local' (single-user / unavailable)
  let reason = '';      // why 'local', when 'local'
  let taskId = null;
  let text = '';
  let lastError = null;
  let timer = null;     // pending debounced autosave
  let saving = null;    // in-flight save promise

  /** A copy of the current surface state, for the view and for a check. */
  function state() {
    const snap = session ? session.snapshot() : null;
    return {
      mode,
      reason,
      taskId,
      status: snap ? snap.status : (mode === 'draft' ? 'closed' : 'local'),
      attemptId: snap ? snap.attemptId : null,
      revision: snap ? snap.revision : null,
      text,
      dirty: snap ? Boolean(snap.dirty) : false,
      conflict: snap ? snap.conflict : null,
      error: lastError ? lastError.code || lastError.name || 'error' : null,
    };
  }

  function notify() {
    if (!onState) return;
    try { onState(state()); } catch { /* a view listener must not break the surface */ }
  }

  function clearTimer() {
    if (timer !== null) { clearTimeoutFn(timer); timer = null; }
  }

  /**
   * Enter the writing task. On the account path this opens the account's draft and returns
   * the SAVED text, which the view puts into the textarea. On the single-user path - or any
   * refusal the boundary reports - it keeps the view's own text and persists nothing, so the
   * behaviour is exactly what it was before this slice.
   */
  async function enter(nextTaskId, { initialText = '' } = {}) {
    clearTimer();
    const id = String(nextTaskId);
    text = String(initialText ?? '');
    lastError = null;
    let opened;
    try {
      opened = await openDraft(id);
    } catch (error) {
      session = null;
      mode = 'local';
      reason = error && error.code === 'unauthenticated' ? 'single-user' : 'unavailable';
      lastError = error || null;
      taskId = id;
      notify();
      return { mode, reason, taskId: id, text };
    }
    session = opened;
    taskId = id;
    mode = 'draft';
    reason = '';
    const snap = session.snapshot();
    if (snap && typeof snap.text === 'string') text = snap.text;
    notify();
    return { mode, reason, taskId: id, text };
  }

  /**
   * The learner typed. On the account path this schedules a debounced save; on the
   * single-user path it only records the text, exactly as before this slice.
   */
  function change(nextText) {
    text = String(nextText ?? '');
    if (mode !== 'draft' || !session) { notify(); return; }
    clearTimer();
    const snap = session.snapshot();
    const alreadySaved = snap && !snap.dirty && text === snap.text;
    if (alreadySaved) { notify(); return; }
    timer = setTimeoutFn(() => { timer = null; void flush(); }, debounceMs);
    notify();
  }

  /**
   * Write the learner's text through the boundary, now. Returns
   *   {ok:true, status}                     the server holds the text (or already did)
   *   {ok:false, reason:'conflict', ...}    a 409: nothing written, local text kept
   *   {ok:false, reason:<code>}             invalid input, a network failure, already_submitted
   */
  async function flush() {
    if (mode !== 'draft' || !session) return { ok: true, mode };
    clearTimer();
    if (saving) {
      try { await saving; } catch { /* the outcome of the in-flight save is below */ }
    }
    if (mode !== 'draft' || !session) return { ok: true, mode };
    const snap = session.snapshot();
    if (!snap) return { ok: false, reason: 'closed' };
    if (!snap.dirty && text === snap.text) { notify(); return { ok: true, status: snap.status }; }
    const run = (async () => {
      const outcome = await session.save(text);
      if (outcome && outcome.status === 'conflict') {
        return { ok: false, reason: 'conflict', conflict: outcome };
      }
      return { ok: true, status: outcome ? outcome.status : 'saved' };
    })();
    saving = run.then(
      (result) => { saving = null; return result; },
      (error) => { saving = null; throw error; },
    );
    try {
      const result = await saving;
      notify();
      return result;
    } catch (error) {
      notify();
      return { ok: false, reason: (error && error.code) || 'error', error };
    }
  }

  /**
   * Resolve a 409 the way the draft service models it. 'local' keeps the learner's text
   * (unsaved, based on the re-read revision) so the next save overwrites the server copy;
   * 'server' adopts the server text. Nothing is discarded on the learner's behalf.
   */
  function resolveConflict(choice) {
    if (mode !== 'draft' || !session) return { ok: false, reason: 'local' };
    const snap = session.resolveConflict(choice);
    if (snap && typeof snap.text === 'string') text = snap.text;
    notify();
    return { ok: true, text, revision: snap ? snap.revision : null };
  }

  return Object.freeze({ enter, change, flush, resolveConflict, state });
}
