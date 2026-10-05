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
  exams: '/api/v1/exams',
  preparations: '/api/v1/preparations',
  tasks: '/api/v1/tasks',
  objectiveSets: '/api/v1/objective-sets',
  mockForms: '/api/v1/mock-forms',
  mockRuns: '/api/v1/mock-runs',
  vocab: '/api/v1/vocab',
  nouns: '/api/v1/nouns',
  guides: '/api/v1/guides',
  practiceNext: '/api/v1/practice/next',
  practiceCheck: '/api/v1/practice/check',
  practiceProgress: '/api/v1/practice/progress',
  practiceMistakes: '/api/v1/practice/mistakes',
  /* DRILL-01 (slice H) — Einzelübungen. The item-at-a-time pair beside the whole-set pair above. */
  practiceDrillNext: '/api/v1/practice/drill/next',
  practiceDrillCheck: '/api/v1/practice/drill/check',
  /*
   * PRACTICE-MEDIA (task-17). The practice-bound twin of `mockRuns`: one sitting's playback state, and the
   * bytes of one of its recordings. The bytes are addressed by the SITTING, not by the set, because the
   * server's own route is bound to the `practice_attempt` that owns the allowance.
   */
  practiceAttempts: '/api/v1/practice/attempts',
  attempts: '/api/v1/attempts',
  submissions: '/api/v1/submissions',
  export: '/api/v1/export',
  /* PILOT-FEEDBACK-01 (FB-C). Not preparation-scoped: the contract's routes carry no exam context, so these
     travel with `call` rather than `scopedCall` — a report about a listening item is filed from the page the
     learner is on, not from a selected preparation. */
  feedback: '/api/v1/feedback',
  surveyCurrent: '/api/v1/survey/current',
  surveyRound: '/api/v1/survey',
  sentenceCheck: '/api/v1/sentence-check',
  checkoutOffer: '/api/v1/checkout/offer',
  checkoutSession: '/api/v1/checkout/session',
  orders: '/api/v1/orders',
});
const explanationQuery = (language, key = 'explanationLanguage') => language === null || language === undefined ? '' : '?' + key + '=' + encodeURIComponent(language);

/**
 * An owned-route 401 is an explicit failure, with one shell notification. Never redirect an active
 * writing form automatically: its unsaved text must remain available for recovery.
 */
export function createApi({ fetchImpl = (...args) => fetch(...args), onSessionInvalid = (reason) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hatoove:session-expired', { detail: { reason } }));
} } = {}) {
let accountId = null;
let preparation = null;
let preparationGeneration = 0;
let generation = 0;
let stopped = null;
const refusal = (status, error) => ({ ok: false, status, data: null, error });
function invalidate(reason) {
  stopped = reason;
  preparation = null;
  preparationGeneration++;
  generation++;
  onSessionInvalid(reason);
  return refusal(reason === 'account_changed' ? 409 : 401, reason);
}
async function call(method, path, body, scoped = false, binary = false) {
  const protectedRequest = path.startsWith('/api/v1/') || path === PATHS.signOut || path === PATHS.session;
  if (protectedRequest && stopped) {
    onSessionInvalid(stopped);
    return refusal(stopped === 'account_changed' ? 409 : 401, stopped);
  }
  if (protectedRequest && path !== PATHS.session && !accountId) return refusal(428, 'account_context_required');
  const ticket = generation;
  const preparationTicket = preparationGeneration;
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (protectedRequest && accountId) headers['X-Hatoove-Account'] = accountId;
  let res;
  try {
    res = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      ...(binary ? { cache: 'no-store' } : {}),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    /*
     * A transport failure is an ANSWER, not an exception. Without this the promise rejects, no caller
     * catches it, and the learner is left looking at "Wird geladen …" for ever with no message — the
     * module's own contract (above) says it returns a result rather than throwing, and this is what
     * makes that true. `status: 0` means "no response received"; a write may already have committed.
     */
    if (ticket !== generation) return refusal(409, 'stale_session');
    if (scoped && preparationTicket !== preparationGeneration) return refusal(409, 'stale_preparation');
    return refusal(0, 'network');
  }
  let payload = null;
  try {
    if (binary && res.ok) {
      if (res.headers?.get('content-type')?.split(';')[0] !== 'audio/wav'
        || Number(res.headers?.get('content-length')) > 33554432) return refusal(502, 'media_unavailable');
      payload = await res.blob();
      if (!payload.size || payload.size > 33554432) return refusal(502, 'media_unavailable');
    } else payload = await res.json();
  } catch {
    if (binary && res.ok) {
      if (ticket !== generation) return refusal(409, 'stale_session');
      if (scoped && preparationTicket !== preparationGeneration) return refusal(409, 'stale_preparation');
      return refusal(0, 'network');
    }
    // A refusal may carry no JSON body; its status still counts.
  }
  // A transport may finish after another request invalidated this tab. Never render that response.
  if (ticket !== generation) return refusal(409, 'stale_session');
  /*
   * A 401 FROM THE FEEDBACK ROUTES MUST NOT TEAR DOWN THE RUN (FB-C, contract §6.4). Every protected request
   * answered 401 normally invalidates the session, and that handler calls `mock.refresh()` and shows the error
   * screen — so a learner who filed a report after their session had expired would have an in-progress LISTENING
   * run re-rendered underneath them. An independent reviewer traced exactly this path (`api.js` -> `app.js:163`)
   * and answered "the structural proof is not enough" on the strength of it.
   *
   * Reporting a problem is not worth a re-render. This call returns an ordinary refusal, the sheet says it could
   * not be sent, and the next ordinary request — or the focus check — still discovers the expiry and locks the
   * window. Nothing is hidden; the convergence is simply no longer triggered BY the act of reporting.
   *
   * The 409 `account_changed` case below deliberately still invalidates: a changed account is a different learner
   * on the same tab, and that must be acted on immediately whatever the request was.
   */
  const quietSession = path === PATHS.feedback || path.startsWith(`${PATHS.feedback}/`);
  if (protectedRequest && res.status === 401 && !quietSession) return invalidate('session_expired');
  if (protectedRequest && res.status === 409 && payload?.error === 'account_changed') return invalidate('account_changed');
  if (scoped && preparationTicket !== preparationGeneration) return refusal(409, 'stale_preparation');
  if (path === PATHS.session && res.ok) {
    const next = payload?.user?.id;
    if (typeof next !== 'string' || !next) return invalidate('session_expired');
    if (accountId && next !== accountId) return invalidate('account_changed');
    accountId = next;
  }
  if (path === PATHS.signOut && res.ok) { accountId = null; preparation = null; preparationGeneration++; stopped = 'session_expired'; generation++; }
  return { ok: res.ok, status: res.status, data: payload, error: payload && (payload.error || payload.code) };
}

// This in-memory selection carries context only. The server verifies ownership, state and
// exam identity for every request; neither a cookie nor browser storage supplies an exam.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function scopedCall(method, path, body) {
  if (stopped) return call(method, path, body, true);
  if (!accountId) return refusal(428, 'account_context_required');
  if (!preparation) return refusal(422, 'preparation_required');
  if (method === 'GET') {
    const join = path.includes('?') ? '&' : '?';
    return call(method, path + join + 'preparationId=' + encodeURIComponent(preparation.id), undefined, true);
  }
  if (preparation.state !== 'active') return refusal(409, 'preparation_archived');
  if (body?.preparationId !== undefined && body.preparationId !== preparation.id) return refusal(422, 'preparation_mismatch');
  return call(method, path, { ...body, preparationId: preparation.id }, true);
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

  exams: Object.freeze({ list: () => call('GET', PATHS.exams) }),
  preparations: Object.freeze({
    list: () => call('GET', PATHS.preparations),
    create: (examId) => call('POST', PATHS.preparations, { examId }),
    read: (id) => call('GET', PATHS.preparations + '/' + encodeURIComponent(id)),
    update: (id, expectedRevision, changes) => call('PUT', PATHS.preparations + '/' + encodeURIComponent(id), { ...changes, expectedRevision }),
    credits: (id) => call('GET', PATHS.preparations + '/' + encodeURIComponent(id) + '/credits'),
    select: (value) => {
      if (!accountId || stopped || !UUID.test(value?.id || '') || !['active', 'archived'].includes(value?.state)) return false;
      if (preparation?.id !== value.id || preparation.state !== value.state) preparationGeneration++;
      preparation = { id: value.id, state: value.state };
      return true;
    },
    clear: () => { preparation = null; preparationGeneration++; },
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
      return scopedCall('GET', suffix ? `${PATHS.tasks}?${suffix}` : PATHS.tasks);
    },
  }),

  /**
   * The seeded reading and language-elements sets (LV/SB).
   *
   * The response carries NO answers, and that is not a convention this client is trusting: the server
   * does not select the key table AND the learner database role is not granted it, so a mistake here
   * could not leak one. Listening sets are absent here: their playback needs a durable saved run
   * and is offered through the mock form contract rather than stateless practice.
   */
  objectiveSets: Object.freeze({
    /** One set WITH its payload. The list is an index and carries none -- see the server's note. */
    read: (setId, version) => typeof version !== 'string' || !version.trim()
      ? Promise.resolve(refusal(422, 'invalid_version'))
      : scopedCall('GET', `${PATHS.objectiveSets}/${encodeURIComponent(setId)}?version=${encodeURIComponent(version)}`),
    list: ({ exam = null, family = null } = {}) => {
      const query = new URLSearchParams();
      if (exam) query.set('exam', exam);
      if (family) query.set('family', family);
      const suffix = query.toString();
      return scopedCall('GET', suffix ? `${PATHS.objectiveSets}?${suffix}` : PATHS.objectiveSets);
    },
  }),

  /** New starts are scoped; saved identities resolve their original preparation on the server. */
  mock: Object.freeze({
    forms: () => scopedCall('GET', PATHS.mockForms),
    list: () => scopedCall('GET', PATHS.mockRuns),
    start: payload => scopedCall('POST', PATHS.mockRuns, payload),
    read: (id, language = null) => call('GET', PATHS.mockRuns + '/' + encodeURIComponent(id) + explanationQuery(language), undefined, true),
    save: (id, payload) => call('PUT', PATHS.mockRuns + '/' + encodeURIComponent(id), payload, true),
    chooseWriting: (id, payload) => call('POST', PATHS.mockRuns + '/' + encodeURIComponent(id) + '/writing-choice', payload, true),
    finalise: (id, payload) => call('POST', PATHS.mockRuns + '/' + encodeURIComponent(id) + '/finalise', payload, true),
    playback: id => call('GET', PATHS.mockRuns + '/' + encodeURIComponent(id) + '/playback', undefined, true),
    playbackEvent: (id, payload) => call('POST', PATHS.mockRuns + '/' + encodeURIComponent(id) + '/playback', payload, true),
    media: (id, mediaId, version) => call('GET', PATHS.mockRuns + '/' + encodeURIComponent(id) + '/media/' + encodeURIComponent(mediaId) + '/' + encodeURIComponent(version), undefined, true, true),
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
   * PAYMENTS (PAYMENTS-01). Three account-owned routes, and the shape of the calls is the
   * whole point:
   *
   *   * `offer` asks what is on sale for one exam. The server answers from its own price row, and a
   *     market with no row is a 404 rather than an empty offer. `503 payments_unavailable` is the
   *     pilot's default and is a state the screen must render, not an error to retry silently.
   *   * `startSession` sends the exam, explicit market and idempotency event ID. No amount, currency or
   *     price id: the contract (§2.2, §7) puts the price on the server, so a client that could name
   *     one could name a different one. Unknown fields are refused with 422 like every other
   *     mutating route, so the body here is the allowlist rather than a convenient superset.
   *   * `order` is the ONLY source of truth about a payment. The provider's return URL is a browser
   *     arriving somewhere, not money moving, and the status is read here every time.
   *
   * None of these is preparation-scoped on the server: the offer is for an exam, and an order belongs
   * to the account, so they use `call` rather than `scopedCall` — a checkout that refused to work
   * because a preparation happened to be archived would be a bug, not a safeguard.
   */
  payments: Object.freeze({
    offer: (examId, market = null) => {
      if (typeof examId !== 'string' || !examId.trim()) return Promise.resolve(refusal(422, 'invalid_exam'));
      if (market !== null && !/^[A-Z]{2}$/.test(market)) return Promise.resolve(refusal(422, 'invalid_market'));
      return call('GET', `${PATHS.checkoutOffer}?exam=${encodeURIComponent(examId)}` + (market ? `&market=${encodeURIComponent(market)}` : ''));
    },
    startSession: (payload = {}) => {
      const examId = typeof payload.examId === 'string' ? payload.examId.trim() : '';
      const market = typeof payload.market === 'string' ? payload.market.trim() : '';
      const eventId = payload.eventId;
      // The three documented fields only; commercial terms always come from the server.
      if (!examId || !/^[A-Z]{2}$/.test(market) || !UUID.test(eventId || '')) return Promise.resolve(refusal(422, 'invalid_checkout'));
      return call('POST', PATHS.checkoutSession, { examId, market, eventId });
    },
    order: (orderId) => UUID.test(String(orderId || ''))
      ? call('GET', `${PATHS.orders}/${encodeURIComponent(orderId)}`)
      : Promise.resolve(refusal(422, 'invalid_order')),
  }),

  /**
   * The reference guides: an index, then one document. 64 KB is not fetched to list a title.
   *
   * `read(guideId, locale)` passes the interface language through as the additive `?locale=` member of
   * contract §4.3. Without a locale (or with one the server cannot serve) the response is exactly what it
   * was before slice F2 and the caller renders German only. REVIEW-LIBRARY-UI-01 found the second
   * argument being ignored here, which silently disabled every translated guide line.
   */
  guides: Object.freeze({
    list: () => call('GET', PATHS.guides),
    read: (guideId, locale = null) => call('GET', `${PATHS.guides}/${encodeURIComponent(guideId)}`
      + (typeof locale === 'string' && locale ? `?locale=${encodeURIComponent(locale)}` : '')),
  }),

  /**
   * The adaptive loop. next() is a DETERMINISTIC choice the server makes from recorded evidence and
   * returns with the evidence for its own claim; answer() records one attempt, marked server-side.
   * The client never decides what to practise and never marks anything.
   */
  practice: Object.freeze({
    explanation: (evidenceId, language = null) => call('GET', '/api/v1/objective-evidence/' + encodeURIComponent(evidenceId) + '/explanation' + explanationQuery(language, 'language'), undefined, true),
    /**
     * PRACTICE-01 (slice C) — the two calls the part runner makes, and why they live HERE rather than in
     * the runner.
     *
     * `next(family)` is the same route as `next()` with the one documented query member: the server's
     * selection rule serves ONE released set of that part together with the open sitting it created, so
     * the runner can answer the set and then check it. Called with no argument the request is
     * byte-identical to before this slice (the `?family=` member is appended only for a non-empty
     * string), which is what makes this additive for every existing caller.
     *
     * `check(payload)` is "Auswerten": ONE request marks every answer server-side and returns the whole
     * review. It is `scopedCall` like its neighbours, so the preparation context travels the same way
     * as every other practice call; the runner never marks anything itself.
     *
     * The URLs stay in this module because this module is the only place in `public/app/` that knows
     * one. Agreed with the Lead (task-16, 5 October 2026) rather than opened as a second transport.
     */
    next: (family = null) => scopedCall('GET', PATHS.practiceNext
      + (typeof family === 'string' && family ? '?family=' + encodeURIComponent(family) : '')),
    check: (payload) => scopedCall('POST', PATHS.practiceCheck, payload),
    /**
     * This learner's own totals and per-section tallies, aggregated by the server from item_evidence.
     *
     * It was missing from this layer while `renderDashboard()` already called it, which is the exact
     * class of defect that only a browser finds: `node --check` passes, the endpoint exists, and the
     * first screen silently stays on "Wird geladen …". Measured by tools/app-browser-check.mjs (L7/L9).
     */
    progress: () => scopedCall('GET', PATHS.practiceProgress),
    answer: (setId, payload) => typeof payload?.version !== 'string' || !payload.version.trim()
      ? Promise.resolve(refusal(422, 'invalid_version'))
      : scopedCall('POST', `${PATHS.objectiveSets}/${encodeURIComponent(setId)}/answers`, payload),
    /**
     * The items whose MOST RECENT answer was wrong. A mistake clears itself when the learner gets the
     * item right -- there is no "mark as learned" and no scheduler.
     *
     * NO CORRECT ANSWER IS RETURNED. It cannot be: the answer key is not readable by the learner's
     * database role at all. What comes back is what the LEARNER answered, so they can try again.
     */
    mistakes: () => scopedCall('GET', PATHS.practiceMistakes),
    /**
     * DRILL-01 (slice H) — the Einzelübungen pair.
     *
     * `drillNext()` asks the server which ONE item to practise now, weighted to the learner's weak part, and
     * returns it with the sitting it belongs to and the numbers behind the choice. `drillCheck({attemptId,
     * itemId, answer, latencyMs, language})` marks exactly that item and returns the verdict, the key (which
     * the server can reveal only after the answer is committed) and the explanation.
     *
     * Both are `scopedCall`, so the preparation context travels the way it does for every neighbour here,
     * and the answer posted is the option's typed `value` — never its id, because a listening item's key is
     * a JSON boolean and `mark_objective_item` compares jsonb.
     */
    drillNext: () => scopedCall('GET', PATHS.practiceDrillNext),
    drillCheck: (payload) => scopedCall('POST', PATHS.practiceDrillCheck, payload),
    /**
     * PRACTICE-MEDIA (task-17) — the listening playback of ONE practice sitting, mirroring the mock trio above.
     *
     * The server already owns this transport: `GET|POST /api/v1/practice/attempts/<attemptId>/playback` answer
     * `{items, sitting}` and `{playback}` with the MOCK path's own DTO, and the byte route serves a recording's
     * bytes. What was missing was the client's half — without it a learner met a listening set with no way to
     * hear it.
     *
     * Three deliberate choices:
     *   * `attemptId`, not `setId`: the allowance and the sitting live on the attempt, so a second page for the
     *     same set opens its own sitting with its own play.
     *   * the same `true, true` extra on `media` the mock call passes — a raw-bytes read that must not be
     *     cached. The server serves those bytes only while an acknowledged play is actually in progress, so
     *     the caller must `begin` (or `recover`) BEFORE asking for them.
     *   * every call is `scoped` (`preparationId` attached), like its neighbours: there is no unscoped
     *     practice read.
     */
    playback: (attemptId) => scopedCall('GET', PATHS.practiceAttempts + '/' + encodeURIComponent(attemptId) + '/playback'),
    playbackEvent: (attemptId, payload) => scopedCall('POST', PATHS.practiceAttempts + '/' + encodeURIComponent(attemptId) + '/playback', payload),
    media: (attemptId, mediaId, version) => call('GET', PATHS.practiceAttempts + '/' + encodeURIComponent(attemptId)
      + '/media/' + encodeURIComponent(mediaId) + '/' + encodeURIComponent(version), undefined, true, true),
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
    listAttempts: () => scopedCall('GET', PATHS.attempts),
    openAttempts: () => scopedCall('GET', `${PATHS.attempts}?open=1`),
    createAttempt: (binding = null) => binding?.parentSubmissionId
      ? call('POST', PATHS.attempts, { ...binding })
      : scopedCall('POST', PATHS.attempts, binding ? { ...binding } : {}),
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
    result: (submissionId, language = null) => call('GET', `${PATHS.submissions}/${encodeURIComponent(submissionId)}` + explanationQuery(language), undefined, true),
    retry: (submissionId) => call('POST', `${PATHS.submissions}/${encodeURIComponent(submissionId)}/retry`, {}),
  }),

  /**
   * PILOT-FEEDBACK-01 (FB-C) — the learner's own feedback.
   *
   * ONE entry point for the whole app, so these four calls are the entire client surface: file a report, read
   * your own back, ask whether a survey round is open, and answer or skip it. `submitSurvey` sends either
   * `{answers}` or `{skip:true}` and never both — the server refuses a request that does both or neither, so the
   * client must not guess.
   */
  feedback: Object.freeze({
    create: (payload) => call('POST', PATHS.feedback, payload),
    list: () => call('GET', PATHS.feedback),
    /** 204 when there is nothing to ask; `call` surfaces the status rather than inventing an empty round. */
    currentSurvey: () => call('GET', PATHS.surveyCurrent),
    submitSurvey: (roundId, payload) => call('POST', `${PATHS.surveyRound}/${encodeURIComponent(roundId)}`, payload),
  }),
});
}

export const api = createApi();
