/**
 * The client's API layer — the ONLY place in `public/app/` that knows a URL.
 *
 * Ron, 2 October 2026: "we should be using a api structure to serve data to the frontend from the
 * backend", and "keep the approach consistent using apis to serve data not files".
 *
 * So views never build a path, never fetch, and never read a file. A view asks for a THING
 * (`api.tasks.list()`), and this module owns the transport, the paths, the error shape and the
 * session-expiry rule. Three things follow, and each is the point rather than a side effect:
 *
 *   1. ONE place to change a path. Renaming `/api/v1/tasks` is one edit here, not a grep through
 *      views for a string that half of them spell slightly differently.
 *   2. ONE refusal rule. A 401 announces an expired session while preserving unsaved text on screen.
 *      A view cannot accidentally render a 401 as content.
 *   3. NO DATA IN FILES. There is no `fetch('/data/…')` in this client, because there is no `/data/`
 *      route any more. Content arrives as JSON from the API under a verified session.
 *
 * It returns `{ ok, status, data, error }` rather than throwing, so a caller must decide what a
 * failure looks like on screen instead of silently rendering `undefined`.
 */

/** Every path the client uses, in one place. */
const PATHS = Object.freeze({
  session: '/api/auth/get-session',
  signIn: '/api/auth/sign-in/email',
  signOut: '/api/auth/sign-out',
  account: '/api/v1/account',
  settings: '/api/v1/settings',
  tasks: '/api/v1/tasks',
  objectiveSets: '/api/v1/objective-sets',
  vocab: '/api/v1/vocab',
  nouns: '/api/v1/nouns',
  guides: '/api/v1/guides',
  practiceNext: '/api/v1/practice/next',
  practiceProgress: '/api/v1/practice/progress',
  practiceMistakes: '/api/v1/practice/mistakes',
  attempts: '/api/v1/attempts',
  submissions: '/api/v1/submissions',
  export: '/api/v1/export',
  sentenceCheck: '/api/v1/sentence-check',
});

/**
 * An owned-route 401 is an explicit failure, with one shell notification. Never redirect an active
 * writing form automatically: its unsaved text must remain available for recovery.
 */
export function createApi({ fetchImpl = (...args) => fetch(...args), onSessionInvalid = (reason) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hatoove:session-expired', { detail: { reason } }));
} } = {}) {
let accountId = null;
let generation = 0;
let stopped = null;
const refusal = (status, error) => ({ ok: false, status, data: null, error });
function invalidate(reason) {
  stopped = reason;
  generation++;
  onSessionInvalid(reason);
  return refusal(reason === 'account_changed' ? 409 : 401, reason);
}
async function call(method, path, body) {
  const protectedRequest = path.startsWith('/api/v1/') || path === PATHS.signOut || path === PATHS.session;
  if (protectedRequest && stopped) {
    onSessionInvalid(stopped);
    return refusal(stopped === 'account_changed' ? 409 : 401, stopped);
  }
  if (protectedRequest && path !== PATHS.session && !accountId) return refusal(428, 'account_context_required');
  const ticket = generation;
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (protectedRequest && accountId) headers['X-Hatoove-Account'] = accountId;
  let res;
  try {
    res = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    /*
     * A transport failure is an ANSWER, not an exception. Without this the promise rejects, no caller
     * catches it, and the learner is left looking at "Wird geladen …" for ever with no message — the
     * module's own contract (above) says it returns a result rather than throwing, and this is what
     * makes that true. `status: 0` means "the request never reached the server".
     */
    return refusal(0, ticket === generation ? 'network' : 'stale_session');
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* a refusal may carry no body; the status still counts */ }
  // A transport may finish after another request invalidated this tab. Never render that response.
  if (ticket !== generation) return refusal(409, 'stale_session');
  if (protectedRequest && res.status === 401) return invalidate('session_expired');
  if (protectedRequest && res.status === 409 && payload?.error === 'account_changed') return invalidate('account_changed');
  if (path === PATHS.session && res.ok) {
    const next = payload?.user?.id;
    if (typeof next !== 'string' || !next) return invalidate('session_expired');
    if (accountId && next !== accountId) return invalidate('account_changed');
    accountId = next;
  }
  if (path === PATHS.signOut && res.ok) { accountId = null; stopped = 'session_expired'; generation++; }
  return { ok: res.ok, status: res.status, data: payload, error: payload && (payload.error || payload.code) };
}

return Object.freeze({
  /** The verified session, or null when signed out. Returns the raw response for the boot check. */
  session: () => call('GET', PATHS.session),

  auth: Object.freeze({
    signIn: (email, password) => call('POST', PATHS.signIn, { email, password }),
    signUp: (name, email, password) => call('POST', '/api/auth/sign-up/email', { name, email, password }),
    signOut: () => call('POST', PATHS.signOut, {}),
  }),

  account: Object.freeze({
    read: () => call('GET', PATHS.account),
    export: () => call('GET', PATHS.export),
    // `{}` and not no body: the server requires application/json on every mutating route.
    remove: () => call('DELETE', PATHS.account, {}),
  }),

  settings: Object.freeze({
    read: () => call('GET', PATHS.settings),
    write: (expectedRevision, settings) => call('PUT', PATHS.settings, { expectedRevision, settings }),
  }),

  /**
   * The servable tasks for this learner. The policy that decides WHICH versions are servable is
   * deployment configuration on the server and is deliberately not a parameter here: a client must
   * not be able to ask for content the deployment has chosen not to serve.
   */
  sentences: Object.freeze({ check: (text) => call('POST', PATHS.sentenceCheck, { text }) }),
  tasks: Object.freeze({
    list: ({ exam = null, family = null } = {}) => {
      const query = new URLSearchParams();
      if (exam) query.set('exam', exam);
      if (family) query.set('family', family);
      const suffix = query.toString();
      return call('GET', suffix ? `${PATHS.tasks}?${suffix}` : PATHS.tasks);
    },
  }),

  /**
   * The seeded reading and language-elements sets (LV/SB).
   *
   * The response carries NO answers, and that is not a convention this client is trusting: the server
   * does not select the key table AND the learner database role is not granted it, so a mistake here
   * could not leak one. `media_required` sets are absent by design — the listening families have
   * transcripts but no audio, and offering one would be a Hören task with nothing to hear.
   */
  objectiveSets: Object.freeze({
    /** One set WITH its payload. The list is an index and carries none -- see the server's note. */
    read: (setId, version = 'v1') => call('GET', `${PATHS.objectiveSets}/${encodeURIComponent(setId)}?version=${encodeURIComponent(version)}`),
    list: ({ exam = null, family = null } = {}) => {
      const query = new URLSearchParams();
      if (exam) query.set('exam', exam);
      if (family) query.set('family', family);
      const suffix = query.toString();
      return call('GET', suffix ? `${PATHS.objectiveSets}?${suffix}` : PATHS.objectiveSets);
    },
  }),

  /** The B1 word list. A reference lexicon: no answers, so nothing to withhold. */
  vocab: Object.freeze({
    list: ({ q = null, pos = null } = {}) => {
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (pos) query.set('pos', pos);
      const suffix = query.toString();
      return call('GET', suffix ? `${PATHS.vocab}?${suffix}` : PATHS.vocab);
    },
  }),

  /**
   * The noun lexicon: gender, plural and the RULE that decides the gender. This is the content Ron
   * named as "Nomen & Genus", and until now no view could reach it.
   */
  nouns: Object.freeze({
    list: ({ q = null, gender = null, theme = null } = {}) => {
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (gender) query.set('gender', gender);
      if (theme) query.set('theme', theme);
      const suffix = query.toString();
      return call('GET', suffix ? `${PATHS.nouns}?${suffix}` : PATHS.nouns);
    },
  }),

  /**
   * THE RUBRIC, by id and version — so the screen can explain a band from ONE source of truth.
   *
   * A band on its own is not actionable ("B" means nothing without knowing what B is), and the descriptors
   * that explain it belong to the rubric rather than to the client: a copy here would be a second text that
   * can drift from the one the grader was validated against, with no check able to tell. The version is
   * required for the same reason it is required on the route: a result is only meaningful against the
   * contract it was graded under.
   */
  rubrics: Object.freeze({
    read: (rubricId, version) => call('GET', `/api/v1/rubrics/${encodeURIComponent(rubricId)}?version=${encodeURIComponent(version)}`),
  }),

  /**
   * THE SESSION LIFECYCLE (D5): where am I signed in, end one, change the password.
   *
   * `changePassword` may return a NEW session cookie — the acting session is rotated, not spared, because a
   * token that existed before the password changed is exactly the token an intruder might hold. The caller
   * must therefore treat a successful change as "the session I am holding is not the session I had".
   */
  sessions: Object.freeze({
    list: () => call('GET', '/api/v1/sessions'),
    // An empty JSON object, because the route refuses a body-less DELETE with 415 like every other
    // mutating route here — the destructive verbs all require a body rather than accepting an accident.
    revoke: (sessionId) => call('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, {}),
    changePassword: (currentPassword, newPassword) =>
      call('PUT', '/api/v1/account/password', { currentPassword, newPassword }),
  }),

  /**
   * The reference guides: an index, then one document. 64 KB is not fetched to list a title. */
  guides: Object.freeze({
    list: () => call('GET', PATHS.guides),
    read: (guideId) => call('GET', `${PATHS.guides}/${encodeURIComponent(guideId)}`),
  }),

  /**
   * The adaptive loop. next() is a DETERMINISTIC choice the server makes from recorded evidence and
   * returns with the evidence for its own claim; answer() records one attempt, marked server-side.
   * The client never decides what to practise and never marks anything.
   */
  practice: Object.freeze({
    next: () => call('GET', PATHS.practiceNext),
    /**
     * This learner's own totals and per-section tallies, aggregated by the server from item_evidence.
     *
     * It was missing from this layer while `renderDashboard()` already called it, which is the exact
     * class of defect that only a browser finds: `node --check` passes, the endpoint exists, and the
     * first screen silently stays on "Wird geladen …". Measured by tools/app-browser-check.mjs (L7/L9).
     */
    progress: () => call('GET', PATHS.practiceProgress),
    answer: (setId, payload) => call('POST', `${PATHS.objectiveSets}/${encodeURIComponent(setId)}/answers`, payload),
    /**
     * The items whose MOST RECENT answer was wrong. A mistake clears itself when the learner gets the
     * item right -- there is no "mark as learned" and no scheduler.
     *
     * NO CORRECT ANSWER IS RETURNED. It cannot be: the answer key is not readable by the learner's
     * database role at all. What comes back is what the LEARNER answered, so they can try again.
     */
    mistakes: () => call('GET', PATHS.practiceMistakes),
  }),

  /**
   * WRITING: the draft → submission → result path, driven exactly as the owned API defines it.
   *
   * The order is not a convenience, it is the contract: an attempt is created (bound to the task the
   * learner opened), the draft is saved against a REVISION, and a submission freezes the revision it was
   * given. There is no route that submits text directly, which is why the view must save before it
   * submits — and why a 409 on the draft is a real state the learner has to be told about rather than a
   * silent overwrite.
   *
   * `eventId` is the caller's own idempotency key: the same event submitted twice is ONE submission, so
   * a double-tap or a retried request cannot be charged twice. The view owns generating it and keeping it
   * for the life of one submit attempt.
   */
  writing: Object.freeze({
    /**
     * WHAT IS STILL UNFINISHED, so a reload can offer "continue" instead of a blank page.
     *
     * The index carries no text: this is an ID, the task binding and the revision. The text arrives from
     * `readAttempt` once the view has decided which draft it is resuming — one letter per response, not
     * every letter in a list.
     */
    listAttempts: () => call('GET', PATHS.attempts),
    openAttempts: () => call('GET', `${PATHS.attempts}?open=1`),
    createAttempt: (binding = null) => call('POST', PATHS.attempts, binding ? { ...binding } : {}),
    /**
     * Abandon a draft. The route is a TOMBSTONE, not an erase: the attempt stops being resumable and the
     * letter is no longer served, which is what "start over" has to mean on the server as well as on
     * screen.
     *
     * `{}` and not no body — the same rule the account deletion above states: the server requires
     * `application/json` on EVERY mutating route, DELETE included. Omitting it answered `415 json_required`
     * and the button did nothing, which the rendered leg caught immediately (W9b).
     */
    deleteAttempt: (attemptId) => call('DELETE', `${PATHS.attempts}/${encodeURIComponent(attemptId)}`, {}),
    readAttempt: (attemptId) => call('GET', `${PATHS.attempts}/${encodeURIComponent(attemptId)}`),
    saveDraft: (attemptId, expectedRevision, text) => call('PUT', `${PATHS.attempts}/${encodeURIComponent(attemptId)}`,
      { expectedRevision, text }),
    submit: (attemptId, expectedRevision, eventId) => call('POST', `${PATHS.attempts}/${encodeURIComponent(attemptId)}/submissions`,
      { expectedRevision, eventId }),
    result: (submissionId) => call('GET', `${PATHS.submissions}/${encodeURIComponent(submissionId)}`),
    retry: (submissionId) => call('POST', `${PATHS.submissions}/${encodeURIComponent(submissionId)}/retry`, {}),
  }),
});
}

export const api = createApi();
