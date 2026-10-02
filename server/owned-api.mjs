/**
 * Owned attempts API, pilot contract 0.1.0 (OWNAPI-01).
 *
 * Serves exactly the routes public/js/owned-client.js calls:
 *
 *   POST /api/auth/sign-up/email   POST /api/auth/sign-in/email
 *   POST /api/auth/sign-out        GET  /api/auth/get-session
 *   GET/DELETE /api/v1/account
 *   POST /api/v1/attempts          GET/PUT/DELETE /api/v1/attempts/:id
 *   POST /api/v1/attempts/:id/submissions
 *   GET  /api/v1/submissions/:id   POST /api/v1/submissions/:id/retry
 *
 * Contract: docs/contracts/PILOT-V0.1.md. Executable precedent:
 * spikes/auth-runtime/{server,store}.mjs, whose resource shapes are reproduced here.
 *
 * Persistence and identity are two injected ports; this module owns neither.
 *
 *   sessions  - the only source of identity. Identity is never read from a body,
 *               a path or a query string.
 *       getSession(headers)            -> {userId, email} | null
 *       signUp({name, email, password}) -> {setCookie?}      (may throw Fault)
 *       signIn({email, password})       -> {setCookie?}      (may throw Fault)
 *       signOut(headers)                -> {setCookie?}
 *
 *   datastore - owner-scoped records. `owner` is always the verified session user
 *               id. Every method must treat a record of another owner exactly like
 *               an absent record: Fault(404, 'not_found'), never 403.
 *       create(owner, parentSubmissionId|null) -> {id, revision, text, ...}
 *       read(owner, attemptId)                 -> {id, revision, text, ...}
 *       save(owner, attemptId, expectedRevision, text) -> {revision, text}
 *       submit(owner, attemptId, expectedRevision, eventId) -> {submissionId, replay}
 *       result(owner, submissionId)            -> {submission, job, assessment|null}
 *       retry(owner, submissionId)             -> void
 *       remove(owner, attemptId)               -> void
 *
 * IMPORTANT: the ownership guarantees of this programme were proven against
 * PostgreSQL with forced row-level security and separate login roles
 * (spikes/auth-runtime/isolation.test.mjs). No datastore adapter for that exists
 * yet; the only implementation is the in-memory one used by
 * tools/owned-api-check.mjs. Do NOT back this port with the legacy JSON progress
 * store: it would void those guarantees while every check here still passed.
 *
 * Origin: this module does not re-implement the SEC-01 same-origin gate. A
 * mutation is refused with 403 origin_rejected unless the caller asserts
 * `originChecked: true`, which server.js does only after isSameOriginRequest().
 * Forgetting the gate therefore fails closed instead of open.
 */

export const CONTRACT_VERSION = '0.1.0';
export const BODY_LIMIT_BYTES = 64 * 1024;
export const TEXT_LIMIT = 12000;

/** A contract failure: HTTP status plus a stable lowercase token. */
export class Fault extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'Fault';
    this.status = status;
    this.code = code;
  }
}

const fault = (status, code) => { throw new Fault(status, code); };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const ATTEMPT_RE = new RegExp(`^/api/v1/attempts/(${UUID})$`, 'i');
const SUBMIT_RE = new RegExp(`^/api/v1/attempts/(${UUID})/submissions$`, 'i');
const RESULT_RE = new RegExp(`^/api/v1/submissions/(${UUID})$`, 'i');
const RETRY_RE = new RegExp(`^/api/v1/submissions/(${UUID})/retry$`, 'i');
const TOKEN_RE = /^[a-z][a-z0-9_]{0,47}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

const DATASTORE_METHODS = ['create', 'read', 'save', 'submit', 'result', 'retry', 'remove'];
/**
 * The shared-content catalogue is an OPTIONAL CAPABILITY, not part of ownership.
 *
 * It is deliberately NOT in `DATASTORE_METHODS`. That list gates the ENTIRE owned API, so putting a
 * catalogue method in it disables EVERY route for any datastore that does not implement one — which
 * is exactly what happened: adding `listTasks` turned five checks that use an in-memory fake from
 * green to "503 on every call", and the fail-closed gate was working correctly while doing it.
 *
 * An absent catalogue must disable the CATALOGUE, in the way an absent settings port disables
 * settings and an absent deletion port disables deletion, and leave the rest of the product alone.
 */
const CATALOGUE_METHODS = ['listTasks', 'listObjectiveSets', 'readObjectiveSet', 'listVocab', 'listNouns', 'listGuides', 'readGuide'];
/**
 * PRACTICE is its own optional capability, for the same reason the catalogue is.
 *
 * It is NOT in `DATASTORE_METHODS`, because that list gates the ENTIRE owned API: adding one method to
 * it once turned five checks that use an in-memory fake from green to "503 on every call". An
 * in-memory datastore that cannot mark objective items should lose the PRACTICE routes, not the
 * product.
 */
const PRACTICE_METHODS = ['answerObjectiveItem', 'nextPractice', 'practiceProgress', 'listMistakes'];
/** `/api/v1/objective-sets/{setId}` — read ONE set, payload included. The list is an index. */
const OBJECTIVE_SET_RE = /^\/api\/v1\/objective-sets\/([A-Za-z0-9._-]{1,128})$/;
/** `/api/v1/objective-sets/{setId}/answers` — the set id is dotted (`telc-deutsch-b1.lv1.01`). */
const OBJECTIVE_ANSWER_RE = /^\/api\/v1\/objective-sets\/([A-Za-z0-9._-]{1,128})\/answers$/;
/** `/api/v1/guides/{guideId}` — a closed slug shape, so an id can never reach SQL as anything else. */
const GUIDE_RE = /^\/api\/v1\/guides\/([a-z][a-z0-9-]{0,63})$/;
const SESSION_METHODS = ['getSession', 'signUp', 'signIn', 'signOut'];
const SETTINGS_METHODS = ['read', 'write'];
const DELETION_METHODS = ['deleteAccount'];

/**
 * What an account deletion does NOT remove (HARD-DELETE-01 §3). Returned with every
 * deletion, because "deletion is not total, and saying so is part of the fix" (SEC-02).
 * No retention period is stated for any of them: none has been decided, and inventing one
 * here would be a false promise. The model provider is named for the same reason as the
 * backups — this application cannot reach what it keeps either.
 */
export const DELETION_NOT_REMOVED = Object.freeze([
  Object.freeze({
    what: 'operator_backups',
    detail: 'Copies of the database made before this deletion (backups, write-ahead log archives, replicas) '
      + 'are outside the application\'s reach. A restore from one of them could bring these records back. '
      + 'No retention period for those copies has been decided, so this response cannot say when they expire.',
  }),
  Object.freeze({
    what: 'copies_outside_the_service',
    detail: 'Anything you copied, exported or downloaded yourself, and anything this browser or device still '
      + 'holds locally, is not reachable by the server.',
  }),
  Object.freeze({
    what: 'legacy_progress_file',
    detail: 'A server that is not running in hosted mode also keeps learner progress in a file outside '
      + 'this account database, and serves it at /api/progress. This deletion removes the account '
      + 'database rows only; it does not touch that file. Whether that route is served depends on how '
      + 'the deployment is configured, so this response cannot promise it is refused.',
  }),
  Object.freeze({
    what: 'model_provider',
    detail: 'Text you submitted for assessment was sent to the model provider configured for this '
      + 'installation. Copies that provider keeps, and for how long, are outside the application\'s '
      + 'reach, and no retention period for them is known. This response cannot say when they expire.',
  }),
]);
/**
 * The closed allowlist for account settings. Validation lives here rather than in the port so
 * the HTTP contract is the contract, whatever datastore implements it. Unknown keys are
 * refused, never dropped: silently discarding a field a caller believes it saved is a defect.
 */
/*
 * `model` is NOT here, and must not come back: the model is OPERATOR configuration (D10b — `.env`
 * locally, the platform's environment variables in a deployment), so a learner setting it would be a
 * way to change the provider's behaviour from a browser. Both input shapes are asserted refused in
 * `tools/owned-api-check.mjs`, which is the leg that replaced the retired provider-config check.
 *
 * EXPORTED, and imported by `settings.mjs`, because this list existed in THREE places (here, the
 * PostgreSQL settings port, and the shipped client) and three copies of a field list is three chances
 * for the surface to disagree with itself. The client keeps its own copy deliberately — it must not
 * import server code — but `tools/owned-api-check.mjs` asserts the two agree on `model` being refused.
 */
export const SETTINGS_FIELDS = ['examDate', 'dailyGoal', 'theme', 'language'];
/**
 * FAMILY NAMING — ONE CONVENTION, ONE PARSER.
 *
 * Two routes the same client calls used to disagree: `/api/v1/tasks` accepted a lowercase KIND
 * (`writing`) while `/api/v1/objective-sets` accepted an uppercase PART ID (`HV1`). `journey-api-check`
 * leg J4 asks the tasks route for `family=SA1` — the blueprint's writing part id — and got 422, which
 * made it the only red leg in the only red CI job. The stored rows are NOT the problem and are NOT
 * rewritten: `objective_set.family` really is the part id (`HV1`) and `task_version.family` really is the
 * kind (`writing`), so a single parser maps one wire vocabulary onto both.
 *
 * ONE VOCABULARY, TWO FORMS, A CLOSED SET — and both forms are CASE-SIGNIFICANT:
 *   * the PART ID, uppercase — `LV1`-`LV3`, `SB1`-`SB2`, `HV1`-`HV3`, `SA1` (writing is a single 45-point
 *     task, so it has one part). `sa1` is refused;
 *   * the KIND, lowercase — `writing`, `lv`, `sb`, `hv`, which the app and `docker-stack-check` already
 *     send and which must keep working. `WRITING` is refused.
 * Case-significance is deliberate, not an oversight: `docker-stack-check` already asserts that a lowercase
 * PART ID is "refused, not silently accepted", and accepting both casings would be two conventions wearing
 * one name — the defect this parser exists to end. The two forms are a vocabulary and a kind, not a
 * spelling and its variant.
 * Anything else is refused. `SA2` and `LV9` look plausible and do not exist, so they are 422 like any junk.
 *
 * `SA` is the writing group: the blueprint names its writing part `SA1`, and a kind is a valid filter on
 * both routes, which is the property that makes them one convention rather than two.
 */
const FAMILY_PARTS = Object.freeze({ LV: [1, 2, 3], SB: [1, 2], HV: [1, 2, 3], SA: [1] });
const FAMILY_KINDS = Object.freeze({ writing: 'SA', lv: 'LV', sb: 'SB', hv: 'HV' });

/**
 * @returns {{partId: string|null, group: string, part: number|null, kind: string}|null} null when the
 *   value is outside the closed set — the caller turns that into `422 invalid_family`.
 */
export function parseFamily(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 32 || raw !== value) return null; // no padding, no surprises
  const partMatch = /^([A-Z]{2})([1-9])$/.exec(raw);
  if (partMatch) {
    const [, group, digit] = partMatch;
    const parts = FAMILY_PARTS[group];
    if (!parts || !parts.includes(Number(digit))) return null;
    return { partId: `${group}${digit}`, group, part: Number(digit), kind: group === 'SA' ? 'writing' : group.toLowerCase() };
  }
  const kind = FAMILY_KINDS[raw];
  if (kind) return { partId: null, group: kind, part: null, kind: raw };
  return null;
}

/** A content identifier: a task id, a task version, a rubric id or a rubric version. Deliberately wider
 * than `SETTINGS_TOKEN_RE` (which is about tokens a learner types) because seeded ids carry dots and
 * dashes — `writing.du.besuch-einer-freundin` — and the same character set the catalogue route accepts.
 */
const CONTENT_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SETTINGS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SETTINGS_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SETTINGS_THEMES = ['system', 'light', 'dark'];

/**
 * Validate an account-settings payload. Kept here, beside the route, so the HTTP contract is
 * enforced at the boundary whatever port implements it. Unknown keys are refused rather than
 * dropped, because silently discarding a field a caller believes it saved is a defect this
 * programme has already been bitten by.
 */
function validateSettings(input) {
  if (!isPlainObject(input)) fault(422, 'invalid_settings');
  const unknown = Object.keys(input).filter((key) => !SETTINGS_FIELDS.includes(key));
  if (unknown.length) fault(422, 'invalid_settings');
  const out = {};
  if (input.examDate !== undefined) {
    if (typeof input.examDate !== 'string' || input.examDate.length > 10) fault(422, 'invalid_settings');
    if (input.examDate !== '' && !SETTINGS_DATE_RE.test(input.examDate)) fault(422, 'invalid_settings');
    out.examDate = input.examDate;
  }
  if (input.dailyGoal !== undefined) {
    if (!Number.isSafeInteger(input.dailyGoal) || input.dailyGoal < 1 || input.dailyGoal > 500) fault(422, 'invalid_settings');
    out.dailyGoal = input.dailyGoal;
  }
  if (input.theme !== undefined) {
    if (!SETTINGS_THEMES.includes(input.theme)) fault(422, 'invalid_settings');
    out.theme = input.theme;
  }
  if (input.language !== undefined) {
    // Stored, but the app does not offer a language setting yet: the field exists so the
    // contract does not have to change when it does. See C-06.
    if (typeof input.language !== 'string' || input.language.length > 16) fault(422, 'invalid_settings');
    out.language = input.language;
  }
  if (!Object.keys(out).length) fault(422, 'invalid_settings');
  return out;
}

/** True for every path this module answers, including its unknown routes (404). */
export function isOwnedPath(pathname) {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/') || pathname.startsWith('/api/auth/');
}

function implementsAll(port, methods) {
  return Boolean(port) && typeof port === 'object' && methods.every((name) => typeof port[name] === 'function');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lowerHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' && !isPlainObject(headers) ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    if (typeof value === 'string') out[String(key).toLowerCase()] = value;
    else if (Array.isArray(value)) out[String(key).toLowerCase()] = value.join(', ');
  }
  return out;
}

function hasJsonContentType(headers) {
  return /^application\/json\s*(?:;|$)/i.test(String(headers['content-type'] || '').trim());
}

function decodeBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > BODY_LIMIT_BYTES) fault(413, 'body_too_large');
    return body;
  }
  const bytes = body instanceof Uint8Array ? body : null;
  if (!bytes) fault(400, 'invalid_body');
  if (bytes.length > BODY_LIMIT_BYTES) fault(413, 'body_too_large');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fault(400, 'invalid_utf8');
  }
}

function parseJsonObject(text) {
  if (text.trim() === '') return {};
  let value;
  try { value = JSON.parse(text); } catch { fault(400, 'invalid_json'); }
  if (!isPlainObject(value)) fault(422, 'invalid_body');
  return value;
}

/** Closed field sets: identity, marks, models and job states can never be supplied. */
function onlyFields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) fault(422, 'unknown_field');
}

function requireRevision(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fault(422, code);
  return value;
}

function requireUuid(value, code) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fault(422, code);
  return value.toLowerCase();
}

function requireAuthFields(body, withName) {
  const { email, password, name } = body;
  if (typeof email !== 'string' || email !== email.trim() || email.length > 254 || !EMAIL_RE.test(email)) {
    fault(422, 'invalid_email');
  }
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) fault(422, 'invalid_password');
  if (withName && (typeof name !== 'string' || name.trim() === '' || name.length > 200)) fault(422, 'invalid_name');
  return withName ? { name, email, password } : { email, password };
}

function reply(status, value, setCookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (setCookie) headers['set-cookie'] = setCookie;
  return { status, headers, body: JSON.stringify(value) };
}

const errorReply = (status, code) => reply(status, { error: TOKEN_RE.test(code) ? code : 'internal_error' });

/**
 * Build the owned API.
 * @param {{datastore?: object, sessions?: object, settings?: object, accountDeletion?: object}} ports
 *   `settings` is optional: an installation that does not wire it answers 503 on the settings
 *   routes only, so the account boundary is unaffected by a missing optional port.
 *   `accountDeletion` is optional in the same way: `deleteAccount(owner) -> {existed, removed}`;
 *   unwired, `DELETE /api/v1/account` answers 503 `deletion_unavailable` and deletes nothing.
 * @returns {{handle: Function, handleNode: Function, matches: Function, configured: boolean}}
 */
export function createOwnedApi({ datastore, sessions, settings = null, accountDeletion = null } = {}) {
  // Fail closed: without both ports wired, every owned route answers 503 and no
  // port method is ever reached, so nothing can be served without an identity.
  const configured = implementsAll(datastore, DATASTORE_METHODS) && implementsAll(sessions, SESSION_METHODS);
  const settingsWired = implementsAll(settings, SETTINGS_METHODS);
  const deletionWired = implementsAll(accountDeletion, DELETION_METHODS);
  const catalogueWired = implementsAll(datastore, CATALOGUE_METHODS);
  const practiceWired = implementsAll(datastore, PRACTICE_METHODS);

  async function identify(headers) {
    const session = await sessions.getSession(headers);
    if (!isPlainObject(session) || typeof session.userId !== 'string' || session.userId.trim() === '') return null;
    return { userId: session.userId, email: typeof session.email === 'string' ? session.email : null };
  }

  async function route(method, pathname, headers, body, query = new URLSearchParams()) {
    // Auth routes: exact allowlist, as the spike does for the library handler.
    if (pathname.startsWith('/api/auth/')) {
      const key = `${method} ${pathname}`;
      if (key === 'POST /api/auth/sign-up/email') {
        onlyFields(body, ['name', 'email', 'password']);
        const outcome = await sessions.signUp(requireAuthFields(body, true));
        return reply(200, { ok: true }, outcome && outcome.setCookie);
      }
      if (key === 'POST /api/auth/sign-in/email') {
        onlyFields(body, ['email', 'password']);
        const outcome = await sessions.signIn(requireAuthFields(body, false));
        return reply(200, { ok: true }, outcome && outcome.setCookie);
      }
      if (key === 'POST /api/auth/sign-out') {
        onlyFields(body, []);
        const outcome = await sessions.signOut(headers);
        return reply(200, { ok: true }, outcome && outcome.setCookie);
      }
      if (key === 'GET /api/auth/get-session') {
        const who = await identify(headers);
        return reply(200, who ? { user: { id: who.userId, email: who.email } } : null);
      }
      fault(404, 'not_found');
    }

    // Every /api/v1 route, including an unknown one, requires a verified session.
    const who = await identify(headers);
    if (!who) fault(401, 'unauthenticated');
    const owner = who.userId;

    if (pathname === '/api/v1/account' && method === 'GET') {
      return reply(200, { contractVersion: CONTRACT_VERSION, id: owner, email: who.email });
    }

    /*
     * Hard account deletion (HARD-DELETE-02; Ron: "delete is a hard delete"). DELETE on the
     * same resource the GET above reads, so the account is named by the session and nothing
     * else: no owner field, header or query parameter is read, and an empty body is the only
     * body accepted. The port runs the whole deletion in one transaction, including every
     * session of the account, so the cookie that asked is refused from the next request on.
     */
    if (pathname === '/api/v1/account' && method === 'DELETE') {
      onlyFields(body, []);
      if (!deletionWired) fault(503, 'deletion_unavailable');
      const outcome = await accountDeletion.deleteAccount(owner);
      // The session rows are already gone with the account; this only clears the cookie, and
      // its failure must not turn a committed deletion into an error reply.
      let setCookie;
      try { setCookie = (await sessions.signOut(headers))?.setCookie; } catch { setCookie = undefined; }
      /*
       * FOOTGUN for the future deletion UI (F10): a bodyless DELETE still demands
       * `Content-Type: application/json` (the mutation gate above answers 415 `json_required`
       * otherwise), and the shipped client (`public/js/owned-client.js`) has no method that
       * issues this request yet. The contract is left as-is deliberately — every mutation in
       * this API takes a JSON body, and special-casing DELETE would add a second rule — but a
       * caller must send `{}` with that header, not an empty body of another type.
       */
      return reply(200, {
        deleted: true,
        accountExisted: Boolean(outcome && outcome.existed),
        // The delete statements' OWN row counts. They are not the proof of absence: that is
        // `verifiedAbsent`, set only because the port read every account table back first.
        removed: outcome && isPlainObject(outcome.removed) ? outcome.removed : {},
        verifiedAbsent: Boolean(outcome && outcome.verifiedAbsent === true),
        completeErasure: false,
        notRemoved: DELETION_NOT_REMOVED,
      }, setCookie);
    }

    /*
     * Account settings (A-01). Same account boundary as everything else, and the same
     * revision story as the owned-attempts port: the first write is `expectedRevision: 0`,
     * each write increments the revision by one, and a stale write writes nothing and is
     * refused with the server's current copy so the caller can reconcile rather than guess.
     */
    if (pathname === '/api/v1/settings') {
      if (!settingsWired) fault(503, 'settings_unavailable');
      if (method === 'GET') return reply(200, await settings.read(owner));
      if (method === 'PUT') {
        onlyFields(body, ['expectedRevision', 'settings', ...SETTINGS_FIELDS]);
        const expectedRevision = body.expectedRevision === undefined ? 0 : body.expectedRevision;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fault(422, 'invalid_settings');
        // Either a `settings` object or the fields inline; never both, so there is one shape
        // a caller can rely on and no ambiguity about which one wins.
        const hasObject = body.settings !== undefined;
        const hasInline = SETTINGS_FIELDS.some((field) => body[field] !== undefined);
        if (hasObject && hasInline) fault(422, 'invalid_settings');
        if (!hasObject && !hasInline) fault(422, 'invalid_settings');
        const input = hasObject ? body.settings : Object.fromEntries(
          SETTINGS_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
        return reply(200, await settings.write(owner, expectedRevision, validateSettings(input)));
      }
      fault(404, 'not_found');
    }
    if (pathname === '/api/v1/tasks' && method === 'GET') {
      if (!catalogueWired) fault(503, 'catalogue_unavailable');
      /*
       * PILOT-04 -- the servable task catalogue. This is the route the Ueben view has been waiting
       * for: without it no learner-facing code could reach the seeded content at all, which is why
       * that view has been an honest empty state rather than a broken one.
       *
       * THE SERVING POLICY IS DEPLOYMENT CONFIGURATION, NOT A REQUEST PARAMETER. Ron, 2 October
       * 2026: "we will assume for now all are approved until we have built the approval process."
       * The default therefore SERVES unreviewed content, and an explicit `approved` is the
       * fail-closed value. A learner may NARROW the list (exam, family) and may never widen it --
       * a query string must not be able to unlock unreviewed content.
       */
      const family = query.get('family');
      const parsedFamily = family === null ? null : parseFamily(family);
      if (family !== null && !parsedFamily) fault(422, 'invalid_family');
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
        ? 'approved' : 'approved+unreviewed';
      // The KIND is what the task catalogue stores; the part id is the wire vocabulary (see parseFamily).
      const tasks = await datastore.listTasks(owner, { examId: exam, family: parsedFamily ? parsedFamily.kind : null, serveReview });
      /*
       * ONE CARD PER TASK, THE NEWEST VERSION.
       *
       * The catalogue is immutable, so re-binding the six prompts to the telc rubric produced v2 rows
       * alongside v1 — and both are `unreviewed`, so the serving policy serves both. Returning both would
       * show a learner the same prompt twice and make them guess which one to write into; the honest rule
       * is that a task has VERSIONS and the catalogue offers the newest servable one.
       *
       * Done in the route rather than in SQL so both backends behave identically by construction: the
       * datastore returns rows, and one place decides which of them a learner sees. `created_at` orders it
       * — the newest row wins — with the version string as a stable tiebreak for rows seeded in the same
       * statement. Old attempts are untouched: they keep their own binding and render under it.
       */
      const newest = new Map();
      for (const task of tasks) {
        const current = newest.get(task.task_id);
        if (!current || String(task.created_at || '') > String(current.created_at || '')
          || (String(task.created_at || '') === String(current.created_at || '') && String(task.version) > String(current.version))) {
          newest.set(task.task_id, task);
        }
      }
      return reply(200, tasks.filter((task) => newest.get(task.task_id) === task));
    }
    if (pathname === '/api/v1/objective-sets' && method === 'GET') {
      if (!catalogueWired) fault(503, 'catalogue_unavailable');
      /*
       * OBJECTIVE-SEED-01 — the reading and language-elements catalogue.
       *
       * The payload is the AUTHORED structure for each family, verbatim, because the families are NOT
       * one shape: LV1 matches texts to headlines, LV3 matches situations to ads, SB1/SB2 are
       * gap-fills (SB2 from a bank). Flattening them into one synthetic multiple-choice row would
       * destroy the authored task.
       *
       * NO ANSWERS ARE IN THIS RESPONSE, and that is doubly true: the query does not select
       * `objective_key`, and the learner role is not granted that table, so a future edit that added
       * the join would fail with a permission error rather than leak.
       *
       * `family` may only NARROW, exactly as for `/tasks`: the serving policy is deployment
       * configuration and a query string must not be able to unlock what the deployment withheld.
       *
       * THE NAMING INCONSISTENCY IS FIXED, not annotated. It used to read "the writing family is
       * `writing` while these are codes (`LV1`, `HV3`); unifying them is a follow-up" — and that follow-up
       * is what made `journey-api-check` J4 the only red leg in the only red CI job. One parser now
       * accepts one vocabulary in both spellings (see `parseFamily`): a PART ID narrows to that part, a
       * KIND (`lv`) narrows to the whole group. `objective_set.family` stores the part id, so an exact
       * match is the narrowest case and a group match is the widest.
       */
      const family = query.get('family');
      const parsedFamily = family === null ? null : parseFamily(family);
      if (family !== null && !parsedFamily) fault(422, 'invalid_family');
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
        ? 'approved' : 'approved+unreviewed';
      return reply(200, await datastore.listObjectiveSets(owner, {
        examId: exam,
        // An exact PART ID is the narrowest filter; a KIND narrows to the group. Both reach the same
        // storage column, which is why one of them is passed as an equality and the other as a prefix.
        family: parsedFamily && parsedFamily.partId ? parsedFamily.partId : null,
        group: parsedFamily && parsedFamily.partId ? null : (parsedFamily ? parsedFamily.group : null),
        part: parsedFamily ? parsedFamily.part : null,
        serveReview,
      }));
    }
    if (pathname === '/api/v1/vocab' && method === 'GET') {
      if (!catalogueWired) fault(503, 'catalogue_unavailable');
      /*
       * LIBRARY-SEED-01 — the B1 core vocabulary, 300 entries.
       *
       * `q` is bounded and `limit` is fixed by the server. A learner may narrow the lexicon; the
       * server decides how much of it one response may carry, so a crafted request cannot ask for the
       * whole table on every keystroke.
       */
      const pos = query.get('pos');
      if (pos !== null && !/^(noun|verb|adj|adv|phrase)$/.test(pos)) fault(422, 'invalid_pos');
      const q = query.get('q');
      if (q !== null && (q.trim().length < 2 || q.length > 64)) fault(422, 'invalid_query');
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
        ? 'approved' : 'approved+unreviewed';
      return reply(200, await datastore.listVocab(owner, {
        examId: exam, pos, q: q === null ? null : q.trim(), serveReview,
      }));
    }
    if (pathname === '/api/v1/nouns' && method === 'GET') {
      if (!catalogueWired) fault(503, 'catalogue_unavailable');
      /*
       * LIBRARY-SEED-02 — the B1 noun lexicon, 240 nouns with gender, plural and the gender rule.
       *
       * `gender` and `theme` are closed exact filters: a learner drills one article or browses one
       * theme, and an unknown value is REFUSED rather than silently returning nothing, because an
       * empty list and a typo look identical to a learner and only one of them is their fault.
       */
      const gender = query.get('gender');
      if (gender !== null && !/^(der|die|das)$/.test(gender)) fault(422, 'invalid_gender');
      const theme = query.get('theme');
      if (theme !== null && (theme.trim().length < 2 || theme.length > 64)) fault(422, 'invalid_theme');
      const q = query.get('q');
      if (q !== null && (q.trim().length < 2 || q.length > 64)) fault(422, 'invalid_query');
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
        ? 'approved' : 'approved+unreviewed';
      return reply(200, await datastore.listNouns(owner, {
        examId: exam, theme: theme === null ? null : theme.trim(), gender,
        q: q === null ? null : q.trim(), serveReview,
      }));
    }
    if (pathname === '/api/v1/guides' && method === 'GET') {
      if (!catalogueWired) fault(503, 'catalogue_unavailable');
      /*
       * LIBRARY-SEED-03 — the reference guides. The INDEX only: 5 documents, 101 sections between
       * them, and `grammar-guide` alone is 64 KB, so the list carries titles and section counts and
       * one guide is fetched by id.
       */
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
        ? 'approved' : 'approved+unreviewed';
      return reply(200, await datastore.listGuides(owner, { examId: exam, serveReview }));
    }
    {
      const guideMatch = GUIDE_RE.exec(pathname);
      if (guideMatch && method === 'GET') {
        if (!catalogueWired) fault(503, 'catalogue_unavailable');
        const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
          ? 'approved' : 'approved+unreviewed';
        const guide = await datastore.readGuide(owner, { guideId: guideMatch[1], serveReview });
        // A guide that does not exist and a guide the deployment will not serve are BOTH 404, so the
        // endpoint is not an oracle for what exists but is withheld.
        if (!guide) fault(404, 'not_found');
        return reply(200, guide);
      }
    }
    {
      /*
       * PILOT-22 -- answer one objective item. Marking happens SERVER-SIDE inside a SECURITY DEFINER
       * function, because this connection is the learner role and is NOT granted the answer key.
       * The response is the single boolean the function returns; the expected answer never leaves it.
       *
       * The evidence row is APPEND-ONLY: answering again records a new row rather than rewriting the
       * last, because this is the raw signal adaptive selection reads.
       */
      const answerMatch = OBJECTIVE_ANSWER_RE.exec(pathname);
      if (answerMatch && method === 'POST') {
        if (!practiceWired) fault(503, 'practice_unavailable');
        onlyFields(body, ['itemId', 'answer', 'version', 'latencyMs']);
        if (typeof body.itemId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.itemId)) fault(422, 'invalid_item');
        if (body.answer === undefined) fault(422, 'invalid_answer');
        const version = body.version === undefined ? 'v1' : body.version;
        if (typeof version !== 'string' || !/^v[0-9]{1,4}$/.test(version)) fault(422, 'invalid_version');
        const latencyMs = body.latencyMs === undefined ? null : body.latencyMs;
        if (latencyMs !== null && (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 3600000)) {
          fault(422, 'invalid_latency');
        }
        return reply(201, await datastore.answerObjectiveItem(owner, {
          setId: answerMatch[1], version, itemId: body.itemId, answer: body.answer, latencyMs,
        }));
      }
    }
    if (pathname === '/api/v1/practice/next' && method === 'GET') {
      if (!practiceWired) fault(503, 'practice_unavailable');
      /*
       * PILOT-22b -- what to practise next. RULES CHOOSE; AI DOES NOT CHOOSE (MASTER-PLAN section 14).
       *
       * The response carries the EVIDENCE for its own claim, so the client can tell the learner "LV,
       * 2 of 5 correct" instead of handing over an item with no reason. A deterministic choice over
       * recorded evidence is repeatable and explainable; a model call is neither, costs tokens on
       * every request, and cannot be justified to the person it is deciding for.
       */
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
        ? 'approved' : 'approved+unreviewed';
      const next = await datastore.nextPractice(owner, { examId: exam, serveReview });
      // Nothing servable is NOT an error: it means the catalogue is empty for this deployment, and the
      // client shows its honest empty state rather than an error page.
      if (!next) return reply(200, { reason: 'nothing_available', section: null, evidence: null, set: null });
      return reply(200, next);
    }
    {
      /*
       * One objective set, WITH its payload. The list is an INDEX and carries no payload: fetching 15
       * titles used to ship all fifteen full task texts to the browser. A learner opening a set gets
       * that one set.
       */
      const setMatch = OBJECTIVE_SET_RE.exec(pathname);
      if (setMatch && method === 'GET') {
        if (!catalogueWired) fault(503, 'catalogue_unavailable');
        const version = query.get('version') === null ? 'v1' : query.get('version');
        if (typeof version !== 'string' || !/^v[0-9]{1,4}$/.test(version)) fault(422, 'invalid_version');
        const serveReview = String(process.env.B1PREP_SERVE_REVIEW || 'approved+unreviewed').trim() === 'approved'
          ? 'approved' : 'approved+unreviewed';
        const set = await datastore.readObjectiveSet(owner, { setId: setMatch[1], version, serveReview });
        if (!set) fault(404, 'not_found');
        return reply(200, set);
      }
    }
    if (pathname === '/api/v1/practice/progress' && method === 'GET') {
      if (!practiceWired) fault(503, 'practice_unavailable');
      /*
       * PILOT-22c -- what the learner has actually done, per section.
       *
       * COUNTS, NOT A SCORE. The supplied design's dashboard carries a calibrated estimate and a pass
       * line; the product forbids both. This is the truthful substitute, and the dashboard renders it
       * without inventing a number to fill the gauge.
       */
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      return reply(200, await datastore.practiceProgress(owner, { examId: exam }));
    }
    if (pathname === '/api/v1/practice/mistakes' && method === 'GET') {
      if (!practiceWired) fault(503, 'practice_unavailable');
      /*
       * PILOT-22d -- the items whose MOST RECENT answer was wrong. No correct answer is returned: the
       * key is not readable by this role, and a mistakes list that revealed it would hand over exactly
       * what the practice loop withholds.
       */
      const exam = query.get('exam');
      if (exam !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(exam)) fault(422, 'invalid_exam');
      return reply(200, await datastore.listMistakes(owner, { examId: exam }));
    }
    if (pathname === '/api/v1/attempts' && method === 'GET') {
      /*
       * PILOT-06 — WHAT IS STILL OPEN, so a reload does not lose a letter.
       *
       * A learner who reloads mid-writing gets a new attempt today, because nothing tells the client which
       * attempt is unfinished. The client cannot answer that for itself: it keeps NOTHING in the browser
       * (app-browser-check L30 asserts it), so the server has to say it.
       *
       * `?open=1` is the ONLY shape this GET serves. Any other query, and no query at all, is answered
       * with the same `404 not_found` the path already gives for an unsupported METHOD — the API's
       * established convention, asserted by `owned-api-check` leg `error-404-unknown-routes-and-methods`,
       * which covers `GET /api/v1/attempts` today. Returning a special 422 for "you forgot the flag"
       * would have carved an exception into a convention that is otherwise uniform, so the flag is part of
       * WHAT IS SERVED rather than a parameter with a validation error.
       *
       * The index carries NO DRAFT TEXT: a list that returned letters would ship a learner's writing in
       * every poll, while the client only needs the ID, the binding and the revision so it can read the
       * one attempt it resumes.
       */
      if (query.get('open') !== '1') fault(404, 'not_found');
      return reply(200, { attempts: await datastore.listOpenAttempts(owner) });
    }
    if (pathname === '/api/v1/attempts' && method === 'POST') {
      onlyFields(body, ['parentSubmissionId', 'taskId', 'taskVersion', 'rubricId', 'rubricVersion']);
      const parent = body.parentSubmissionId === undefined ? null : requireUuid(body.parentSubmissionId, 'invalid_parent');
      /*
       * PILOT-05 — AN ATTEMPT IS BOUND TO THE TASK THE LEARNER OPENED.
       *
       * This route used to take no binding at all: every attempt was created against the one canonical
       * writing task. So the six seeded prompts were unreachable as attempts, and a writing view could
       * only have submitted against ONE task while showing another — a screen that looks right and a row
       * that belongs to something else.
       *
       * ALL FOUR FIELDS OR NONE. A partial binding is a caller bug, not a request to guess the rest, and
       * the datastore applies the serving policy and pins the rubric to the one the task declares (see
       * `adapter.create`): the client selects from what the deployment serves, and cannot widen that or
       * choose its own rubric.
       */
      const BINDING = { taskId: 'invalid_binding', taskVersion: 'invalid_binding', rubricId: 'invalid_binding', rubricVersion: 'invalid_binding' };
      const given = Object.keys(BINDING).filter((field) => body[field] !== undefined);
      let binding = null;
      if (given.length) {
        if (given.length !== Object.keys(BINDING).length) fault(422, 'invalid_binding');
        for (const [field, code] of Object.entries(BINDING)) {
          if (typeof body[field] !== 'string' || !CONTENT_TOKEN_RE.test(body[field])) fault(422, code);
        }
        binding = { taskId: body.taskId, taskVersion: body.taskVersion, rubricId: body.rubricId, rubricVersion: body.rubricVersion };
      }
      return reply(201, await datastore.create(owner, parent, binding || undefined));
    }

    let match = ATTEMPT_RE.exec(pathname);
    if (match) {
      const id = match[1].toLowerCase();
      if (method === 'GET') return reply(200, await datastore.read(owner, id));
      if (method === 'PUT') {
        onlyFields(body, ['expectedRevision', 'text']);
        const expected = requireRevision(body.expectedRevision, 'invalid_draft');
        if (typeof body.text !== 'string' || body.text.length > TEXT_LIMIT) fault(422, 'invalid_draft');
        return reply(200, await datastore.save(owner, id, expected, body.text));
      }
      if (method === 'DELETE') {
        onlyFields(body, []);
        await datastore.remove(owner, id);
        return reply(200, { deleted: true });
      }
      fault(404, 'not_found');
    }
    match = SUBMIT_RE.exec(pathname);
    if (match && method === 'POST') {
      onlyFields(body, ['expectedRevision', 'eventId']);
      const expected = requireRevision(body.expectedRevision, 'invalid_submission');
      const eventId = requireUuid(body.eventId, 'invalid_submission');
      return reply(202, await datastore.submit(owner, match[1].toLowerCase(), expected, eventId));
    }
    match = RESULT_RE.exec(pathname);
    if (match && method === 'GET') return reply(200, await datastore.result(owner, match[1].toLowerCase()));
    match = RETRY_RE.exec(pathname);
    if (match && method === 'POST') {
      onlyFields(body, []);
      await datastore.retry(owner, match[1].toLowerCase());
      return reply(202, { queued: true });
    }
    return fault(404, 'not_found');
  }

  /**
   * Framework-neutral entry point.
   * @param {{method: string, path: string, headers?: object, body?: string|Uint8Array, originChecked?: boolean}} request
   *   `path` may carry a query string; it is ignored. `originChecked` must be true for
   *   a mutation, and may only be set by a caller that ran the SEC-01 origin gate.
   * @returns {Promise<{status: number, headers: object, body: string}>}
   */
  async function handle(request) {
    try {
      const method = String(request && request.method || 'GET').toUpperCase();
      let pathname;
      let query;
      try {
        const url = new URL(String(request.path), 'http://owned.invalid');
        pathname = url.pathname;
        query = url.searchParams;
      } catch { fault(404, 'not_found'); }
      if (!isOwnedPath(pathname)) fault(404, 'not_found');
      const mutation = method !== 'GET' && method !== 'HEAD';
      // Origin precedes routing (contract), so an unchecked mutation is 403 even
      // for an unknown route.
      if (mutation && request.originChecked !== true) fault(403, 'origin_rejected');
      if (!configured) fault(503, 'not_configured');
      const headers = lowerHeaders(request.headers);
      let body = {};
      if (mutation) {
        if (!hasJsonContentType(headers)) fault(415, 'json_required');
        body = parseJsonObject(decodeBody(request.body));
      }
      return await route(method, pathname, headers, body, query);
    } catch (error) {
      if (error instanceof Fault) return errorReply(error.status, error.code);
      // Unexpected failure: redacted. No message, SQL or provider text leaves.
      return errorReply(500, 'internal_error');
    }
  }

  /**
   * node:http adapter for server.js. Call it only after the SEC-01 gate has
   * accepted the request; `originChecked` is asserted on that basis.
   */
  async function handleNode(req, res, { originChecked = false } = {}) {
    let body;
    let tooLarge = false;
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > BODY_LIMIT_BYTES) { tooLarge = true; break; }
        chunks.push(chunk);
      }
      if (tooLarge) req.resume();
      body = Buffer.concat(chunks);
    }
    const response = tooLarge
      ? (originChecked ? errorReply(413, 'body_too_large') : errorReply(403, 'origin_rejected'))
      : await handle({ method, path: req.url, headers: req.headers, body, originChecked });
    res.writeHead(response.status, response.headers);
    res.end(method === 'HEAD' ? undefined : response.body);
  }

  return Object.freeze({ handle, handleNode, matches: isOwnedPath, configured });
}
