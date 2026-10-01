/**
 * Owned draft API transport for the browser (pilot contract 0.1.0).
 *
 * Scope: this module is the only place the learner UI talks to the owned
 * `/api/auth` and `/api/v1` routes. It is a transport boundary, nothing more:
 * no storage, no cache, no DOM, no timers, no server changes, no content or
 * review decisions.
 *
 * Hard guarantees
 *   - Every request goes to a fixed, same-origin path built from a validated
 *     UUID. There is no `baseURL`, `ownerID`, provider URL or other caller
 *     supplied endpoint, and no manual `Origin` header (the browser sets it).
 *   - `credentials: 'same-origin'`, `cache: 'no-store'`; mutations send JSON.
 *   - No module-scope network, no DOM/storage access, no background work.
 *   - No automatic retry. POST/PUT/DELETE are attempted exactly once, so an
 *     uncertain submission stays with the caller and its original `eventId`.
 *   - A monotonic local *generation* fences every awaited result: `clear()`,
 *     `signOut()` and `refreshAccount()` identity transitions invalidate the
 *     local context and abort pending work, and a response that belongs to a
 *     superseded generation is rejected as `stale_session` even when the
 *     transport ignores the `AbortSignal`.
 *   - No draft text or identity is cached here; `getAccount()` hands out copies.
 *
 * See docs/contracts/OWNED-CLIENT.md for the full public API and the error codes.
 */

export const CONTRACT_VERSION = '0.1.0';
/** Writing drafts are bounded by UTF-16 code units, as the server does. */
export const DRAFT_TEXT_LIMIT = 12000;

/**
 * Every failure this transport reports is an `OwnedClientError` with one of
 * these codes. `status` is the HTTP status when the failure came from a
 * response, otherwise null. `detail` is a sanitized server error token.
 */
export const ERROR_CODES = Object.freeze([
  'invalid_request',        // caller-side validation failed; no request was sent
  'transport_unavailable',  // no usable fetch implementation
  'network_error',          // transport rejected the request (offline, DNS, CORS)
  'malformed_response',     // 2xx response body missing, unparseable or off-contract
  'unsupported_contract',   // account reported a contractVersion this client cannot use
  'stale_session',          // the response belongs to a superseded session generation
  'unauthenticated',        // 401, or a learner call without a verified account
  'forbidden',              // 403
  'not_found',              // 404
  'conflict',               // 409: draft revision, idempotency, allowance, retry
  'bad_request',            // 400
  'too_large',              // 413
  'unsupported_media_type', // 415
  'unprocessable',          // 422
  'server_error',           // 5xx
  'http_error',             // any other non-2xx
]);

const SUMMARIES = Object.freeze({
  invalid_request: 'The request was rejected before sending it',
  transport_unavailable: 'No fetch implementation is available',
  network_error: 'The request did not reach the server',
  malformed_response: 'The server response did not match the contract',
  unsupported_contract: 'The server contract version is not supported',
  stale_session: 'The response belongs to a superseded session',
  unauthenticated: 'The session is not authenticated',
  forbidden: 'The request was rejected by the server',
  not_found: 'The resource is not available',
  conflict: 'The request conflicts with the current server state',
  bad_request: 'The server rejected the request as invalid',
  too_large: 'The request body exceeded the server limit',
  unsupported_media_type: 'The server requires a JSON request body',
  unprocessable: 'The server rejected the request fields',
  server_error: 'The server failed to handle the request',
  http_error: 'The server refused the request',
});

const STATUS_CODES = Object.freeze({
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
});

const ACCOUNT_PATH = '/api/v1/account';
const ATTEMPTS_PATH = '/api/v1/attempts';
const SETTINGS_PATH = '/api/v1/settings';
/** The closed allowlist the server enforces; mirrored here so the client fails before sending. */
const SETTINGS_FIELDS = ['examDate', 'dailyGoal', 'model', 'theme', 'language'];
const SIGN_UP_PATH = '/api/auth/sign-up/email';
const SIGN_IN_PATH = '/api/auth/sign-in/email';
const SIGN_OUT_PATH = '/api/auth/sign-out';
const JSON_HEADERS = Object.freeze({ accept: 'application/json', 'content-type': 'application/json' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The contract envelope is `{error: code}`. Only a short lowercase token is
 * kept, so a server body that embeds SQL, credentials or provider text can
 * never reach a caller through `OwnedClientError`.
 */
const SERVER_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const JOB_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

/** Typed transport error: `code` is stable, `status` is the HTTP status or null. */
export class OwnedClientError extends Error {
  constructor(code, { status = null, detail = null, message = null } = {}) {
    super(message ?? summarise(code, status, detail));
    this.name = 'OwnedClientError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  get isStaleSession() { return this.code === 'stale_session'; }
  get isUnauthenticated() { return this.code === 'unauthenticated'; }
  get isConflict() { return this.code === 'conflict'; }
  get isNetworkError() { return this.code === 'network_error'; }
}

function summarise(code, status, detail) {
  const parts = [`code=${code}`];
  if (status !== null) parts.push(`status=${status}`);
  if (detail) parts.push(`server=${detail}`);
  return `${SUMMARIES[code] ?? 'The request failed'} (${parts.join(', ')})`;
}

const fail = (code, extra) => { throw new OwnedClientError(code, extra); };

/* ------------------------------------------------------------------ input */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Options objects are closed: a field that is not on the method's allowlist is
 * rejected before any request is built, so a caller can never smuggle
 * `owner_id`, a score, a model or any other privileged field into a body.
 */
function allowlist(value, allowed, context) {
  const options = value === undefined ? {} : value;
  if (!isPlainObject(options)) fail('invalid_request', { message: `${context} expects an options object` });
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    const named = unknown.slice(0, 3).map((key) => String(key).slice(0, 40)).join(', ');
    fail('invalid_request', { message: `${context} rejected unknown field(s): ${named}` });
  }
  return options;
}

/** Public methods are closed: an unexpected argument is a caller bug, not a field. */
function rejectExtraArguments(args, expected, context) {
  if (args.length > expected) {
    fail('invalid_request', { message: `${context} does not accept more than ${expected} argument(s)` });
  }
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail('invalid_request', { message: `${label} must be a canonical UUID` });
  }
  return value;
}

function requireRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_request', { message: `${label} must be an integer >= 1` });
  }
  return value;
}

function requireText(value, label, { limit = DRAFT_TEXT_LIMIT } = {}) {
  if (typeof value !== 'string') fail('invalid_request', { message: `${label} must be a string` });
  if (value.length > limit) {
    fail('invalid_request', { message: `${label} must be at most ${limit} UTF-16 code units` });
  }
  return value;
}

function requireEmail(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 254 || !EMAIL_RE.test(value)) {
    fail('invalid_request', { message: 'email must be a single address without surrounding whitespace' });
  }
  return value;
}

function requirePassword(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    fail('invalid_request', { message: 'password must be a non-empty string of at most 256 characters' });
  }
  return value;
}

function requireName(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    fail('invalid_request', { message: 'name must be a non-empty string of at most 200 characters' });
  }
  return value;
}

/* ----------------------------------------------------------------- output */

function deepCopy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fall through to JSON */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function asResource(value, label) {
  if (!isPlainObject(value)) fail('malformed_response', { message: `${label} response is not a JSON object` });
  return value;
}

/** Shapes below are the executable spike shapes of contract 0.1.0. */
function readAttemptShape(value) {
  const resource = asResource(value, 'attempt');
  return {
    ...resource,
    id: requireUuidish(resource.id, 'attempt.id'),
    revision: requireRevisionish(resource.revision, 'attempt.revision'),
    text: requireTextish(resource.text, 'attempt.text'),
  };
}

function requireUuidish(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('malformed_response', { message: `${label} is not a UUID` });
  return value;
}

function requireRevisionish(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('malformed_response', { message: `${label} is not an integer >= 1` });
  return value;
}

function requireTextish(value, label) {
  if (typeof value !== 'string') fail('malformed_response', { message: `${label} is not a string` });
  if (value.length > DRAFT_TEXT_LIMIT) fail('malformed_response', { message: `${label} exceeds ${DRAFT_TEXT_LIMIT} code units` });
  return value;
}

function readDraftShape(value) {
  const resource = asResource(value, 'draft');
  requireRevisionish(resource.revision, 'draft.revision');
  requireTextish(resource.text, 'draft.text');
  return resource;
}

function readSubmissionShape(value) {
  const resource = asResource(value, 'submission');
  requireUuidish(resource.submissionId, 'submission.submissionId');
  if (typeof resource.replay !== 'boolean') fail('malformed_response', { message: 'submission.replay is not a boolean' });
  return resource;
}

function readResultShape(value, expectedSubmissionId) {
  const resource = asResource(value, 'result');
  const submission = asResource(resource.submission, 'result.submission');
  requireUuidish(submission.id, 'result.submission.id');
  requireTextish(submission.text, 'result.submission.text');
  if (submission.id.toLowerCase() !== expectedSubmissionId.toLowerCase()) {
    fail('malformed_response', { message: 'result.submission.id does not match the requested submission' });
  }
  const job = asResource(resource.job, 'result.job');
  if (typeof job.status !== 'string' || !JOB_STATUSES.includes(job.status)) {
    fail('malformed_response', { message: 'result.job.status is not a known job status' });
  }
  if (resource.assessment !== null && !isPlainObject(resource.assessment)) {
    fail('malformed_response', { message: 'result.assessment must be an object or null' });
  }
  return resource;
}

function readRetryShape(value) {
  const resource = asResource(value, 'retry');
  if (typeof resource.queued !== 'boolean') fail('malformed_response', { message: 'retry.queued is not a boolean' });
  return resource;
}

function readDeletedShape(value) {
  const resource = asResource(value, 'deletion');
  if (typeof resource.deleted !== 'boolean') fail('malformed_response', { message: 'deletion.deleted is not a boolean' });
  return resource;
}

/**
 * Account settings, as the server owns them. The shape is validated rather than passed through:
 * a response carrying an unexpected field is a protocol error, because the caller would otherwise
 * persist whatever arrived. `language` here is the EXPLANATION language - see readSettings below.
 */
function readSettingsShape(value) {
  const resource = asResource(value, 'settings');
  if (!Number.isSafeInteger(resource.revision) || resource.revision < 0) {
    fail('malformed_response', { message: 'settings.revision must be a non-negative integer' });
  }
  const settings = asResource(resource.settings, 'settings.settings');
  const unknown = Object.keys(settings).filter((key) => !SETTINGS_FIELDS.includes(key));
  if (unknown.length) fail('malformed_response', { message: `unsupported setting(s) in the response: ${unknown.join(', ')}` });
  return { revision: resource.revision, settings };
}

/* ----------------------------------------------------------- the factory */

/**
 * Create a transport bound to one fetch implementation.
 * @param {object} [config] only `fetchImpl` is accepted; it defaults to
 *   `globalThis.fetch` and is captured once, when the factory is called,
 *   never at module scope and never re-read per call.
 */
export function createOwnedClient(config = {}) {
  if (!isPlainObject(config)) fail('invalid_request', { message: 'createOwnedClient expects an options object' });
  const unknown = Object.keys(config).filter((key) => key !== 'fetchImpl');
  if (unknown.length) {
    fail('invalid_request', { message: `createOwnedClient rejected unknown field(s): ${unknown.slice(0, 3).join(', ')}` });
  }
  const fetchImpl = config.fetchImpl === undefined ? globalThis.fetch : config.fetchImpl;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    fail('invalid_request', { message: 'fetchImpl must be a function' });
  }

  /** Internal authority. Only a verified /api/v1/account response sets this. */
  let identity = null;
  /** Monotonic session generation. Every identity transition increments it. */
  let generation = 0;
  let active = newController();

  function newController() {
    if (typeof AbortController === 'function') return new AbortController();
    return { signal: undefined, abort() {} };
  }

  /**
   * Invalidate the local context: drop the identity, bump the generation and
   * abort the work of the superseded generation.
   */
  function invalidate() {
    generation += 1;
    identity = null;
    const previous = active;
    active = newController();
    if (previous && typeof previous.abort === 'function') {
      try { previous.abort(); } catch { /* abort must never mask the real failure */ }
    }
  }

  function adopt(account) {
    const next = Object.freeze({ contractVersion: account.contractVersion, id: account.id, email: account.email });
    const changed = identity === null || identity.id !== next.id;
    if (changed) invalidate();
    identity = next;
    return next;
  }

  const currentId = () => (identity ? identity.id : null);
  const superseded = (gen, id) => generation !== gen || currentId() !== id;

  function toClientError(error, signal) {
    if (error instanceof OwnedClientError) return error;
    if (signal && signal.aborted) {
      return new OwnedClientError('stale_session', { message: 'The request was superseded before it completed' });
    }
    return new OwnedClientError('network_error', { message: 'The request did not reach the server' });
  }

  /**
   * One fetch. Fixed same-origin path, browser-supplied Origin, no retry.
   * Treats a missing status as a malformed response rather than a success.
   */
  async function send(method, path, body, signal) {
    if (typeof fetchImpl !== 'function') {
      fail('transport_unavailable', { message: 'No fetch implementation is available' });
    }
    const init = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'GET' ? { accept: 'application/json' } : JSON_HEADERS,
    };
    if (method !== 'GET') init.body = JSON.stringify(body === undefined ? {} : body);
    if (signal) init.signal = signal;
    const response = await fetchImpl(path, init);
    if (!isPlainObject(response)) fail('malformed_response', { message: 'The transport returned no response' });
    if (!Number.isInteger(response.status)) fail('malformed_response', { message: 'The response carries no HTTP status' });
    return response;
  }

  async function readBody(response) {
    let text;
    if (typeof response.text === 'function') {
      try { text = await response.text(); } catch { text = undefined; }
    } else if (typeof response.json === 'function') {
      try { return await response.json(); } catch { fail('malformed_response', { message: 'The response body is not JSON' }); }
    }
    if (typeof text !== 'string' || text.trim() === '') {
      fail('malformed_response', { message: `The response body is empty (HTTP ${response.status})` });
    }
    try { return JSON.parse(text); } catch { fail('malformed_response', { message: 'The response body is not JSON' }); }
  }

  /** Server error envelope: keep only a sanitized opaque token, never text. */
  function envelopeDetail(body) {
    if (!isPlainObject(body)) return null;
    const code = body.error;
    return typeof code === 'string' && SERVER_CODE_RE.test(code) ? code : null;
  }

  async function failure(response) {
    let detail = null;
    try { detail = envelopeDetail(await readBody(response)); } catch { detail = null; }
    const code = STATUS_CODES[response.status] ?? (response.status >= 500 ? 'server_error' : 'http_error');
    return new OwnedClientError(code, { status: response.status, detail });
  }

  /** 2xx: read the body and validate the documented resource shape. */
  async function interpret(response, validate) {
    if (response.status === 401) {
      return { kind: 'error', error: new OwnedClientError('unauthenticated', { status: 401 }), invalidate: true };
    }
    if (response.status < 200 || response.status >= 300) {
      return { kind: 'error', error: await failure(response), invalidate: false };
    }
    try {
      const body = await readBody(response);
      return { kind: 'value', value: deepCopy(validate(body)) };
    } catch (error) {
      const mapped = error instanceof OwnedClientError
        ? error
        : new OwnedClientError('malformed_response', { message: 'The response could not be read' });
      return { kind: 'error', error: mapped, invalidate: false };
    }
  }

  /**
   * Authenticated learner call. Captures the verified identity/generation,
   * aborts with the generation's controller, and re-checks the generation
   * after the await before exposing either a value or an error.
   */
  async function call({ method, path, body, validate }) {
    if (identity === null) {
      fail('unauthenticated', { message: 'No verified account; call refreshAccount() first' });
    }
    const gen = generation;
    const id = identity.id;
    const signal = active.signal;
    let outcome;
    try {
      const response = await send(method, path, body, signal);
      outcome = await interpret(response, validate);
    } catch (error) {
      outcome = { kind: 'error', error: toClientError(error, signal), invalidate: false };
    }
    if (superseded(gen, id)) {
      throw new OwnedClientError('stale_session', { message: 'The session changed while the request was in flight' });
    }
    if (outcome.kind === 'error') {
      if (outcome.invalidate) invalidate();
      throw outcome.error;
    }
    return outcome.value;
  }

  /* ------------------------------------------------------------- account */

  /** Copy of the verified account, or null. Mutating the copy changes nothing. */
  function getAccount() {
    rejectExtraArguments(arguments, 0, 'getAccount');
    return identity === null ? null : deepCopy(identity);
  }

  /**
   * Deliberate session-boundary operation: GET /api/v1/account, verify
   * contractVersion and a non-empty id, then adopt or drop the identity. This
   * is never called automatically from another method.
   */
  async function refreshAccount() {
    rejectExtraArguments(arguments, 0, 'refreshAccount');
    const gen = generation;
    const id = currentId();
    const signal = active.signal;
    let response;
    try {
      response = await send('GET', ACCOUNT_PATH, undefined, signal);
    } catch (error) {
      const mapped = toClientError(error, signal);
      if (superseded(gen, id)) {
        throw new OwnedClientError('stale_session', { message: 'The session changed while the account was being refreshed' });
      }
      throw mapped;
    }
    let outcome;
    if (response.status === 401) {
      outcome = { kind: 'unauthenticated' };
    } else if (response.status < 200 || response.status >= 300) {
      outcome = { kind: 'error', error: await failure(response) };
    } else {
      let body;
      try { body = await readBody(response); } catch (error) { body = error; }
      if (body instanceof OwnedClientError) outcome = { kind: 'error', error: body };
      else if (!isPlainObject(body) || typeof body.id !== 'string' || body.id.trim() === '') {
        outcome = { kind: 'error', error: new OwnedClientError('malformed_response', { message: 'The account response has no non-empty id' }) };
      } else if (body.contractVersion !== CONTRACT_VERSION) {
        const reported = typeof body.contractVersion === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,15}$/.test(body.contractVersion)
          ? body.contractVersion
          : 'unprintable';
        outcome = {
          kind: 'error',
          error: new OwnedClientError('unsupported_contract', {
            message: `The server reported contractVersion ${reported}`,
          }),
        };
      } else {
        outcome = {
          kind: 'account',
          account: {
            contractVersion: CONTRACT_VERSION,
            id: body.id,
            email: typeof body.email === 'string' ? body.email : null,
          },
        };
      }
    }
    // A network failure, a malformed body or an unsupported contract never
    // invents an identity change; only a verified account or a 401 does.
    if (superseded(gen, id)) {
      throw new OwnedClientError('stale_session', { message: 'The session changed while the account was being refreshed' });
    }
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'unauthenticated') {
      if (identity !== null) invalidate();
      return null;
    }
    return deepCopy(adopt(outcome.account));
  }

  /* --------------------------------------------------------------- auth */

  async function authRequest(path, body) {
    const gen = generation;
    const id = currentId();
    const signal = active.signal;
    let response;
    try {
      response = await send('POST', path, body, signal);
    } catch (error) {
      const mapped = toClientError(error, signal);
      // Same generation re-check as every learner method: without an
      // AbortSignal a superseded failure must still read as stale_session.
      if (superseded(gen, id)) {
        throw new OwnedClientError('stale_session', { message: 'The session changed while authenticating' });
      }
      throw mapped;
    }
    if (superseded(gen, id)) {
      throw new OwnedClientError('stale_session', { message: 'The session changed while authenticating' });
    }
    // The auth body is not trusted for identity: the account endpoint is.
    if (response.status < 200 || response.status >= 300) throw await failure(response);
  }

  async function authenticate(path, fields, established) {
    await authRequest(path, fields);
    const account = await refreshAccount();
    if (account === null) {
      throw new OwnedClientError('unauthenticated', {
        status: 401,
        message: `The server did not ${established} a verified session`,
      });
    }
    return account;
  }

  function signIn(credentials) {
    rejectExtraArguments(arguments, 1, 'signIn');
    const options = allowlist(credentials, ['email', 'password'], 'signIn');
    return authenticate(SIGN_IN_PATH, { email: requireEmail(options.email), password: requirePassword(options.password) }, 'answer with');
  }

  function signUp(details) {
    rejectExtraArguments(arguments, 1, 'signUp');
    const options = allowlist(details, ['name', 'email', 'password'], 'signUp');
    return authenticate(SIGN_UP_PATH, {
      name: requireName(options.name),
      email: requireEmail(options.email),
      password: requirePassword(options.password),
    }, 'establish');
  }

  /**
   * Clear the local identity and cancel pending work immediately, then tell the
   * server. A failed sign-out still leaves the local identity cleared and
   * reports the real failure to the caller.
   */
  async function signOut() {
    rejectExtraArguments(arguments, 0, 'signOut');
    invalidate();
    const signal = active.signal;
    let response;
    try {
      response = await send('POST', SIGN_OUT_PATH, {}, signal);
    } catch (error) {
      throw toClientError(error, signal);
    }
    if (response.status < 200 || response.status >= 300) throw await failure(response);
  }

  /** Invalidate local context only. No request, no server session change. */
  function clear() {
    rejectExtraArguments(arguments, 0, 'clear');
    invalidate();
  }

  /* ------------------------------------------------------------ learners */

  const attemptPath = (id) => `${ATTEMPTS_PATH}/${id}`;

  function createAttempt(options) {
    rejectExtraArguments(arguments, 1, 'createAttempt');
    const allowed = allowlist(options, ['parentSubmissionId'], 'createAttempt');
    const body = {};
    if (allowed.parentSubmissionId !== undefined) {
      body.parentSubmissionId = requireUuid(allowed.parentSubmissionId, 'parentSubmissionId');
    }
    return call({
      method: 'POST',
      path: ATTEMPTS_PATH,
      body,
      validate: (value) => readAttemptShape(value),
    });
  }

  function readAttempt(id) {
    rejectExtraArguments(arguments, 1, 'readAttempt');
    const attemptId = requireUuid(id, 'id');
    return call({
      method: 'GET',
      path: attemptPath(attemptId),
      validate: (value) => {
        const attempt = readAttemptShape(value);
        if (attempt.id.toLowerCase() !== attemptId.toLowerCase()) {
          fail('malformed_response', { message: 'The attempt id does not match the requested attempt' });
        }
        return attempt;
      },
    });
  }

  function saveDraft(id, options) {
    rejectExtraArguments(arguments, 2, 'saveDraft');
    const attemptId = requireUuid(id, 'id');
    const allowed = allowlist(options, ['expectedRevision', 'text'], 'saveDraft');
    const body = {
      expectedRevision: requireRevision(allowed.expectedRevision, 'expectedRevision'),
      text: requireText(allowed.text, 'text'),
    };
    return call({ method: 'PUT', path: attemptPath(attemptId), body, validate: readDraftShape });
  }

  function submit(id, options) {
    rejectExtraArguments(arguments, 2, 'submit');
    const attemptId = requireUuid(id, 'id');
    const allowed = allowlist(options, ['expectedRevision', 'eventId'], 'submit');
    const body = {
      expectedRevision: requireRevision(allowed.expectedRevision, 'expectedRevision'),
      eventId: requireUuid(allowed.eventId, 'eventId'),
    };
    // Sent exactly once: an uncertain outcome stays with the caller, who must
    // reuse this same eventId to resolve it idempotently.
    return call({
      method: 'POST',
      path: `${attemptPath(attemptId)}/submissions`,
      body,
      validate: readSubmissionShape,
    });
  }

  function readResult(submissionId) {
    rejectExtraArguments(arguments, 1, 'readResult');
    const id = requireUuid(submissionId, 'submissionId');
    return call({
      method: 'GET',
      path: `/api/v1/submissions/${id}`,
      validate: (value) => readResultShape(value, id),
    });
  }

  /*
   * Account settings. The account-scoped record the server owns: exam date, daily goal, model,
   * theme and `language`. Two deliberate properties:
   *
   *   - the caller passes the revision it last saw, exactly as the draft path does, so a second
   *     device cannot silently overwrite the first (the server answers 409 settings_conflict);
   *   - the response is validated rather than trusted, so a caller cannot persist a field the
   *     server never agreed to store.
   *
   * `language` is the EXPLANATION language. It must never reach the interface or the exam content -
   * the menu and the content stay German - which `tools/design-check.mjs` enforces mechanically.
   */
  function readSettings() {
    rejectExtraArguments(arguments, 0, 'readSettings');
    return call({ method: 'GET', path: SETTINGS_PATH, validate: readSettingsShape });
  }

  function saveSettings(options) {
    rejectExtraArguments(arguments, 1, 'saveSettings');
    const { expectedRevision, settings } = allowlist(options, ['expectedRevision', 'settings'], 'saveSettings');
    // A settings record starts at revision 0 (readSettingsShape accepts it and the server's
    // first write is expectedRevision 0), unlike a draft, which starts at 1. Requiring >= 1
    // here made an account's FIRST settings save impossible (SESSION-BOUNDARY-01).
    const revision = expectedRevision === 0 ? 0 : requireRevision(expectedRevision, 'expectedRevision');
    if (!isPlainObject(settings)) fail('invalid_request', { message: 'settings must be an object' });
    const unknown = Object.keys(settings).filter((key) => !SETTINGS_FIELDS.includes(key));
    if (unknown.length) fail('invalid_request', { message: `unsupported setting(s): ${unknown.join(', ')}` });
    return call({
      method: 'PUT',
      path: SETTINGS_PATH,
      body: { expectedRevision: revision, settings: deepCopy(settings) },
      validate: readSettingsShape,
    });
  }

  function retrySubmission(submissionId) {
    rejectExtraArguments(arguments, 1, 'retry');
    const id = requireUuid(submissionId, 'submissionId');
    return call({
      method: 'POST',
      path: `/api/v1/submissions/${id}/retry`,
      body: {},
      validate: readRetryShape,
    });
  }

  function deleteAttempt(id) {
    rejectExtraArguments(arguments, 1, 'deleteAttempt');
    const attemptId = requireUuid(id, 'id');
    return call({
      method: 'DELETE',
      path: attemptPath(attemptId),
      body: {},
      validate: readDeletedShape,
    });
  }

  return Object.freeze({
    /** Monotonic session generation; a later coordinator-owned cache can key on it. */
    get generation() { return generation; },
    getAccount,
    refreshAccount,
    signIn,
    signUp,
    signOut,
    clear,
    createAttempt,
    readAttempt,
    saveDraft,
    submit,
    readResult,
    readSettings,
    saveSettings,
    retry: retrySubmission,
    deleteAttempt,
  });
}
