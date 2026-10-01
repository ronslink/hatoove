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
 *   - `snapshot().status` is one of saved | unsaved | conflict | submitted | submit_pending.
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
 */
export function createWritingSurface(options = {}) {
  const openDraft = options.openDraft;
  if (typeof openDraft !== 'function') throw new TypeError('createWritingSurface needs an openDraft function');
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 1200;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : (id) => clearTimeout(id);

  let session = null;   // the draft session while signed in and open
  let mode = 'local';   // 'draft' (account) | 'local' (single-user / unavailable)
  let reason = '';      // why 'local', when 'local'
  let taskId = null;
  let text = '';
  let lastError = null;

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

  /**
   * Enter the writing task. On the account path this opens the account's draft and returns
   * the SAVED text, which the view puts into the textarea. On the single-user path - or any
   * refusal the boundary reports - it keeps the view's own text and persists nothing, so the
   * behaviour is exactly what it was before this slice.
   */
  async function enter(nextTaskId, { initialText = '' } = {}) {
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
      return { mode, reason, taskId: id, text };
    }
    session = opened;
    taskId = id;
    mode = 'draft';
    reason = '';
    const snap = session.snapshot();
    if (snap && typeof snap.text === 'string') text = snap.text;
    return { mode, reason, taskId: id, text };
  }

  /** The learner typed: record the text. Saving is added in the next step. */
  function change(nextText) {
    text = String(nextText ?? '');
  }

  return Object.freeze({ enter, change, state });
}
