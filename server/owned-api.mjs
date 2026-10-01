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
const SESSION_METHODS = ['getSession', 'signUp', 'signIn', 'signOut'];
const SETTINGS_METHODS = ['read', 'write'];
const DELETION_METHODS = ['deleteAccount'];

/**
 * What an account deletion does NOT remove (HARD-DELETE-01 §3). Returned with every
 * deletion, because "deletion is not total, and saying so is part of the fix" (SEC-02).
 * No retention period is stated for backups: none has been decided, and inventing one
 * here would be a false promise.
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
    detail: 'A server running the older single-user mode keeps progress in a file outside this account '
      + 'database; this deletion does not touch it. Hosted mode refuses that file route.',
  }),
]);
/**
 * The closed allowlist for account settings. Validation lives here rather than in the port so
 * the HTTP contract is the contract, whatever datastore implements it. Unknown keys are
 * refused, never dropped: silently discarding a field a caller believes it saved is a defect.
 */
const SETTINGS_FIELDS = ['examDate', 'dailyGoal', 'model', 'theme', 'language'];
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
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || !SETTINGS_TOKEN_RE.test(input.model)) fault(422, 'invalid_settings');
    out.model = input.model;
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

  async function identify(headers) {
    const session = await sessions.getSession(headers);
    if (!isPlainObject(session) || typeof session.userId !== 'string' || session.userId.trim() === '') return null;
    return { userId: session.userId, email: typeof session.email === 'string' ? session.email : null };
  }

  async function route(method, pathname, headers, body) {
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
      return reply(200, {
        deleted: true,
        accountExisted: Boolean(outcome && outcome.existed),
        removed: outcome && isPlainObject(outcome.removed) ? outcome.removed : {},
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
    if (pathname === '/api/v1/attempts' && method === 'POST') {
      onlyFields(body, ['parentSubmissionId']);
      const parent = body.parentSubmissionId === undefined ? null : requireUuid(body.parentSubmissionId, 'invalid_parent');
      return reply(201, await datastore.create(owner, parent));
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
      try { pathname = new URL(String(request.path), 'http://owned.invalid').pathname; } catch { fault(404, 'not_found'); }
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
      return await route(method, pathname, headers, body);
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
