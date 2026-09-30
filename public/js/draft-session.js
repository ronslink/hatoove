/**
 * Recoverable writing draft, service layer (DRAFT-SESSION-01).
 *
 * Scope: one learner, one writing task, one owned attempt. This module drives an
 * injected `createOwnedClient()` instance from ./owned-client.js; it never talks to
 * the network itself. It is pure logic: no DOM, no localStorage, no timers, no
 * imports and no module-scope state, so a page reload (a fresh module instance) can
 * only get text back from the server.
 *
 * Authority
 *   - The server draft is authoritative. Local text is kept only in memory, only
 *     for the account the session was opened for, and only until sign-out/close.
 *   - Every save sends the revision this session last saw. A 409 is never retried
 *     with a fresher revision: the session re-reads the server copy, keeps the
 *     learner's local text, and refuses further saves until the caller resolves the
 *     conflict explicitly (docs/contracts/PILOT-V0.1.md: "Conflict never silently
 *     overwrites text").
 *   - The session is fenced on the client's `generation` and verified account id.
 *     If either changes (sign-out, clear, account switch), local text is dropped
 *     and every later call, including a late in-flight response, fails closed with
 *     `stale_session`.
 *
 * Task identity
 *   Contract 0.1.0 attempts carry no caller task id and there is no list route, so a
 *   fresh page cannot find its attempt from the server alone. The caller therefore
 *   injects `pointers`, a small key/value store holding, per (account id, task id),
 *   only `{attemptId, submissionId, pendingEventId}` - identifiers, never text. Its
 *   durable browser implementation and the server-side task binding are deferred
 *   coordinator decisions (PILOT-02-DRAFT). A pointer is only a hint: the server's
 *   owner scoping decides what it resolves to, and an unresolvable one is dropped.
 *
 * See work/implementation/DRAFT-SESSION-01.md for the evidence and what is deferred.
 */

export const DRAFT_SESSION_VERSION = '0.1.0';

export const SESSION_ERROR_CODES = Object.freeze([
  'not_configured',      // no usable client or pointer store was injected
  'invalid_request',     // caller input rejected; nothing was sent
  'not_open',            // open() has not completed, or the session was closed
  'unauthenticated',     // no verified account when opening
  'stale_session',       // the account/generation changed; local text was dropped
  'conflict_unresolved', // a save conflict must be resolved before saving again
  'unsaved_changes',     // submit refused: local text differs from the saved revision
  'already_submitted',   // the attempt is frozen by a submission
  'not_submitted',       // readResult() before any submission
]);

/** Session-level refusal. Transport failures surface as the client's own errors. */
export class DraftSessionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DraftSessionError';
    this.code = code;
  }
}

const refuse = (code, message) => { throw new DraftSessionError(code, message); };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT_LIMIT = 12000;
const CLIENT_METHODS = ['refreshAccount', 'getAccount', 'createAttempt', 'readAttempt', 'saveDraft', 'submit', 'readResult', 'signOut', 'clear'];
const POINTER_METHODS = ['get', 'set', 'delete'];

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const implementsAll = (port, methods) => Boolean(port) && typeof port === 'object'
  && methods.every((name) => typeof port[name] === 'function');
const clientCode = (error) => (error && typeof error.code === 'string' ? error.code : null);

/** Pointer records are validated on read; anything malformed is treated as absent. */
function readPointer(value) {
  if (!value || typeof value !== 'object' || !isUuid(value.attemptId)) return null;
  return {
    attemptId: value.attemptId,
    submissionId: isUuid(value.submissionId) ? value.submissionId : null,
    pendingEventId: isUuid(value.pendingEventId) ? value.pendingEventId : null,
  };
}

/**
 * @param {object} options
 * @param {object} options.client     a createOwnedClient() instance (required)
 * @param {object} options.pointers   {get(key), set(key, record), delete(key)}; may be async (required)
 * @param {string} options.taskId     caller task identity, e.g. 'writing-b1-t1'
 * @param {Function} [options.newEventId] UUID factory for submission event ids;
 *   defaults to globalThis.crypto.randomUUID, read at call time, never at module scope
 */
export function createDraftSession(options) {
  if (!options || typeof options !== 'object') refuse('not_configured', 'createDraftSession expects an options object');
  const { client, pointers, taskId, newEventId } = options;
  if (!implementsAll(client, CLIENT_METHODS)) refuse('not_configured', 'No owned client is wired');
  if (!implementsAll(pointers, POINTER_METHODS)) refuse('not_configured', 'No pointer store is wired');
  if (typeof taskId !== 'string' || !TASK_RE.test(taskId)) refuse('invalid_request', 'taskId must be a short identifier');
  if (newEventId !== undefined && typeof newEventId !== 'function') refuse('invalid_request', 'newEventId must be a function');

  /** null until open() succeeds; null again after close()/signOut()/a fence breach. */
  let state = null;
  /** Saves run one at a time, so a second save always sees the first one's revision. */
  let queue = Promise.resolve();

  const pointerKey = (accountId) => `draft\u0000${accountId}\u0000${taskId}`;

  function eventId() {
    const make = newEventId || (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? () => globalThis.crypto.randomUUID() : null);
    if (!make) refuse('not_configured', 'No UUID source for submission event ids');
    const id = make();
    if (!isUuid(id)) refuse('not_configured', 'newEventId did not return a UUID');
    return id;
  }

  /** Drop every piece of learner text this session holds. */
  function drop() { state = null; }

  function current() {
    if (!state) refuse('not_open', 'The draft session is not open');
    return state;
  }

  /**
   * The fence. Called before a request and again after every await: a session whose
   * client has moved to another generation or account must not touch or expose text.
   */
  function fenced(expected) {
    const account = client.getAccount();
    const live = state !== null && state === expected
      && client.generation === expected.generation
      && account !== null && account.id === expected.accountId;
    if (!live) {
      drop();
      refuse('stale_session', 'The account or session changed; the local draft was dropped');
    }
    return expected;
  }

  /** Transport failures that mean the session is gone also drop local text. */
  function rethrow(error, expected) {
    if (state === expected && (clientCode(error) === 'stale_session' || clientCode(error) === 'unauthenticated')) drop();
    throw error;
  }

  async function writePointer(s) {
    await pointers.set(pointerKey(s.accountId), {
      attemptId: s.attemptId, submissionId: s.submissionId, pendingEventId: s.pendingEventId,
    });
  }

  /**
   * Start or resume the owned attempt for this task. This is the page-load boundary,
   * so it deliberately verifies the account first. Returns a snapshot.
   */
  async function open() {
    drop();
    const account = await client.refreshAccount();
    if (!account) refuse('unauthenticated', 'Sign in before opening a draft');
    const generation = client.generation;
    const key = pointerKey(account.id);
    const pointer = readPointer(await pointers.get(key));

    let attempt = null;
    if (pointer) {
      try {
        attempt = await client.readAttempt(pointer.attemptId);
      } catch (error) {
        // 404 is the server saying "not yours or gone": forget the hint, start clean.
        if (clientCode(error) !== 'not_found') throw error;
        await pointers.delete(key);
      }
    }
    const resumed = attempt !== null;
    if (!resumed) attempt = await client.createAttempt();

    const next = {
      accountId: account.id,
      generation,
      attemptId: attempt.id,
      revision: attempt.revision,
      text: attempt.text,
      savedText: attempt.text,
      conflict: null,
      submissionId: resumed ? pointer.submissionId : null,
      pendingEventId: resumed ? pointer.pendingEventId : null,
    };
    // Verify the fence against the new state before exposing it.
    if (client.generation !== generation || (client.getAccount() || {}).id !== account.id) {
      refuse('stale_session', 'The account changed while the draft was opening');
    }
    state = next;
    if (!resumed) await writePointer(next);
    return snapshot();
  }

  /**
   * Save `text` against the revision this session last saw. Resolves to
   *   {status: 'saved', revision}     the server accepted it
   *   {status: 'unchanged', revision} the text already equals the saved revision; nothing sent
   *   {status: 'conflict', server: {revision, text}, local}
   *                                  another writer moved the draft; nothing was written,
   *                                  local text is kept and resolveConflict() is required
   * A network failure rejects and leaves the text in memory as unsaved.
   */
  function save(text) {
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) {
      return Promise.reject(new DraftSessionError('invalid_request', `text must be a string of at most ${TEXT_LIMIT} UTF-16 code units`));
    }
    const run = queue.then(() => saveNow(text));
    queue = run.catch(() => {});
    return run;
  }

  async function saveNow(text) {
    const s = fenced(current());
    if (s.submissionId || s.pendingEventId) refuse('already_submitted', 'The attempt is frozen by a submission');
    s.text = text;
    if (s.conflict) refuse('conflict_unresolved', 'Resolve the save conflict before saving again');
    if (text === s.savedText) return { status: 'unchanged', revision: s.revision };

    let saved;
    try {
      saved = await client.saveDraft(s.attemptId, { expectedRevision: s.revision, text });
    } catch (error) {
      fenced(s);
      if (clientCode(error) === 'conflict' && error.detail === 'draft_conflict') return enterConflict(s);
      if (clientCode(error) === 'conflict' && error.detail === 'revision_required') {
        refuse('already_submitted', 'The attempt was submitted elsewhere; start a new revision');
      }
      return rethrow(error, s);
    }
    fenced(s);
    s.revision = saved.revision;
    s.savedText = saved.text;
    return { status: 'saved', revision: s.revision };
  }

  /** Re-read the server copy; never retry the stale snapshot. */
  async function enterConflict(s) {
    let server;
    try {
      server = await client.readAttempt(s.attemptId);
    } catch (error) {
      fenced(s);
      return rethrow(error, s);
    }
    fenced(s);
    s.conflict = { revision: server.revision, text: server.text };
    return { status: 'conflict', server: { ...s.conflict }, local: s.text };
  }

  /**
   * Explicit conflict resolution, no request sent.
   *   'server' adopt the server text and revision (local text is discarded)
   *   'local'  keep the local text as unsaved, based on the server revision; the next
   *            save() deliberately replaces the server text
   */
  function resolveConflict(choice) {
    const s = fenced(current());
    if (!s.conflict) refuse('invalid_request', 'There is no conflict to resolve');
    if (choice !== 'server' && choice !== 'local') refuse('invalid_request', "choice must be 'server' or 'local'");
    s.revision = s.conflict.revision;
    s.savedText = s.conflict.text;
    if (choice === 'server') s.text = s.conflict.text;
    s.conflict = null;
    return snapshot();
  }

  /**
   * Submit the saved revision. Refused while local text is unsaved, so the frozen text
   * is exactly the server's saved text. The event id is recorded before sending, so
   * an uncertain outcome - even across a reload - is retried with the same id.
   */
  async function submit() {
    await queue;
    const s = fenced(current());
    if (s.submissionId) return { submissionId: s.submissionId, replay: true };
    if (s.conflict) refuse('conflict_unresolved', 'Resolve the save conflict before submitting');
    if (s.text !== s.savedText) refuse('unsaved_changes', 'Save the draft before submitting');
    if (!s.pendingEventId) {
      s.pendingEventId = eventId();
      await writePointer(s);
      fenced(s);
    }
    let receipt;
    try {
      receipt = await client.submit(s.attemptId, { expectedRevision: s.revision, eventId: s.pendingEventId });
    } catch (error) {
      fenced(s);
      // A 4xx is a definite answer: a failed enqueue commits nothing, so the event id
      // is released. Anything else (network, 5xx, malformed) stays uncertain and pending.
      if (Number.isInteger(error && error.status) && error.status >= 400 && error.status < 500) {
        s.pendingEventId = null;
        await writePointer(s);
      }
      return rethrow(error, s);
    }
    fenced(s);
    s.submissionId = receipt.submissionId;
    s.pendingEventId = null;
    await writePointer(s);
    return { submissionId: receipt.submissionId, replay: receipt.replay };
  }

  /** Read the saved result. A read only: it never retries or regrades. */
  async function readResult() {
    const s = fenced(current());
    if (!s.submissionId) refuse('not_submitted', 'Nothing has been submitted');
    let result;
    try {
      result = await client.readResult(s.submissionId);
    } catch (error) {
      fenced(s);
      return rethrow(error, s);
    }
    fenced(s);
    return result;
  }

  /** Copy of the session view, or null when closed. Mutating it changes nothing. */
  function snapshot() {
    if (!state) return null;
    const s = state;
    let status = 'saved';
    if (s.submissionId) status = 'submitted';
    else if (s.pendingEventId) status = 'submit_pending';
    else if (s.conflict) status = 'conflict';
    else if (s.text !== s.savedText) status = 'unsaved';
    return {
      taskId,
      status,
      attemptId: s.attemptId,
      revision: s.revision,
      text: s.text,
      dirty: s.text !== s.savedText,
      conflict: s.conflict ? { ...s.conflict } : null,
      submissionId: s.submissionId,
    };
  }

  /** Drop local text without contacting the server (e.g. leaving the task). */
  function close() { drop(); }

  /**
   * Sign out: local text is dropped and the client invalidated *before* the server is
   * told, so a failed sign-out cannot leave the draft readable. The pointer (ids only)
   * is kept for the same account's next sign-in; it is keyed by account id and the
   * server refuses it to anyone else.
   */
  async function signOut() {
    drop();
    await client.signOut();
  }

  return Object.freeze({ open, save, resolveConflict, submit, readResult, snapshot, close, signOut });
}
