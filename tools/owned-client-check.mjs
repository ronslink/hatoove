/**
 * Focused checks for the owned draft API transport (contract 0.1.0).
 * Run with: node tools/owned-client-check.mjs
 *
 * Dependency-free and deterministic. Every request goes to an injected fake
 * fetch: no server, no browser, no database, no provider, no `.env`, no live
 * network. The checks assert observable behaviour (exact request, session
 * fencing, error codes) rather than implementation details.
 */
import assert from 'node:assert/strict';

/* --------------------------------------------------------------- bootstrap */

// Installed before the module is evaluated, so a module-scope request fails loudly.
const importTimeCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  importTimeCalls.push(args);
  throw new Error('module-scope network access is forbidden in the owned-client transport');
};

const {
  createOwnedClient,
  OwnedClientError,
  ERROR_CODES,
  CONTRACT_VERSION,
  DRAFT_TEXT_LIMIT,
} = await import('../public/js/owned-client.js');

globalThis.fetch = originalFetch;

/* ----------------------------------------------------------------- fixtures */

const ATTEMPT = '11111111-2222-4333-8444-555555555555';
const OTHER_ATTEMPT = '22222222-3333-4444-8555-666666666666';
const SUBMISSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PARENT_SUBMISSION = '12345678-1234-4234-8234-123456789012';
const EVENT_ID = '99999999-8888-4777-8666-555555555555';
// Auth user ids are opaque text in contract 0.1.0, not UUIDs.
const ACCOUNT_A = { contractVersion: '0.1.0', id: 'user-acct-a', email: 'a@example.com' };
const ACCOUNT_B = { contractVersion: '0.1.0', id: 'user-acct-b', email: 'b@example.com' };

const ALL_URLS = [];

const jsonResponse = (status, value) => ({ status, text: async () => JSON.stringify(value) });
const textResponse = (status, body) => ({ status, text: async () => body });
const networkFailure = () => { throw new TypeError('fetch failed'); };
const deferredResponse = () => {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, resolve: settle };
};

/** Fake transport recording the exact call shape; `handler` may throw or be slow. */
function transport(handler) {
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    const call = {
      url,
      method: init.method,
      headers: { ...(init.headers ?? {}) },
      credentials: init.credentials,
      cache: init.cache,
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    ALL_URLS.push(url);
    return Promise.resolve().then(() => handler(call));
  };
  return { calls, fetchImpl, client: () => createOwnedClient({ fetchImpl }) };
}

/** Signed-in client; setup traffic is cleared so checks assert only their own calls. */
async function signedIn(handler, account = ACCOUNT_A) {
  const fake = transport((call) => {
    if (call.url === '/api/auth/sign-in/email') return jsonResponse(200, { user: { id: account.id } });
    if (call.url === '/api/v1/account') return jsonResponse(200, account);
    return handler(call);
  });
  const client = fake.client();
  await client.signIn({ email: 'learner@example.com', password: 'correct-horse' });
  fake.calls.length = 0;
  return { client, calls: fake.calls };
}

const attemptResource = (overrides = {}) => ({
  id: ATTEMPT,
  owner_id: 'user-acct-a',
  revision: 2,
  text: 'Mein Entwurf',
  task_version: 'synthetic-writing-v1',
  rubric_version: 'formative-fixture-v1',
  parent_submission_id: null,
  created_at: '2026-09-30T19:00:00.000Z',
  deleted_at: null,
  ...overrides,
});

const resultResource = (overrides = {}) => ({
  submission: {
    id: SUBMISSION,
    attempt_id: ATTEMPT,
    owner_id: 'user-acct-a',
    event_id: EVENT_ID,
    draft_revision: 2,
    text: 'Mein Entwurf',
    task_version: 'synthetic-writing-v1',
    rubric_version: 'formative-fixture-v1',
  },
  job: { status: 'queued', failure_code: null, tries: 0 },
  assessment: null,
  ...overrides,
});

/* ------------------------------------------------------------------ harness */

const checks = [];
const check = (name, run) => checks.push({ name, run });

/** Assert the failure, its documented code/status, and the error invariants. */
async function expectError(run, code) {
  let error;
  try {
    await run();
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, `expected an OwnedClientError with code ${code}, but the call resolved`);
  assert.ok(error instanceof OwnedClientError, `expected an OwnedClientError, got ${error?.name}: ${error?.message}`);
  assert.ok(ERROR_CODES.includes(error.code), `undocumented error code: ${error.code}`);
  assert.equal(error.code, code, `expected code ${code}, got ${error.code} (${error.message})`);
  assert.ok(error.status === null || Number.isInteger(error.status), 'status must be null or an HTTP status');
  assert.ok(error.detail === null || /^[a-z][a-z0-9_]{0,47}$/.test(error.detail), 'detail must be a sanitized token');
  assert.equal(typeof error.message, 'string');
  return error;
}

const noOriginHeader = (call) => assert.ok(
  !Object.keys(call.headers).some((key) => key.toLowerCase() === 'origin'),
  'the client must not set a manual Origin header',
);

/* ------------------------------------------------------------------- checks */

check('the module performs no network work at import time', () => {
  assert.equal(importTimeCalls.length, 0, 'the module contacted a transport while being imported');
  assert.equal(CONTRACT_VERSION, '0.1.0');
  assert.equal(DRAFT_TEXT_LIMIT, 12000);
  assert.ok(typeof createOwnedClient === 'function' && typeof OwnedClientError === 'function');
});

check('without a fetch implementation every call fails as transport_unavailable', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const client = createOwnedClient();
    assert.equal(client.getAccount(), null, 'a new client starts unauthenticated');
    assert.equal(client.generation, 0);
    await expectError(() => client.refreshAccount(), 'transport_unavailable');
    await expectError(() => client.signIn({ email: 'a@example.com', password: 'x' }), 'transport_unavailable');
    await expectError(() => client.signOut(), 'transport_unavailable');
  } finally {
    globalThis.fetch = saved;
  }
});

check('an unauthenticated learner call is rejected locally and sends nothing', async () => {
  const fake = transport(() => jsonResponse(200, {}));
  const client = fake.client();
  await expectError(() => client.createAttempt(), 'unauthenticated');
  await expectError(() => client.readAttempt(ATTEMPT), 'unauthenticated');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 1, text: 'Entwurf' }), 'unauthenticated');
  await expectError(() => client.submit(ATTEMPT, { expectedRevision: 1, eventId: EVENT_ID }), 'unauthenticated');
  await expectError(() => client.readResult(SUBMISSION), 'unauthenticated');
  await expectError(() => client.retry(SUBMISSION), 'unauthenticated');
  await expectError(() => client.deleteAttempt(ATTEMPT), 'unauthenticated');
  assert.equal(fake.calls.length, 0, 'no request may be sent without a verified account');
});

check('sign-in posts the exact allowlisted request, then takes identity only from the account route', async () => {
  const fake = transport((call) => {
    if (call.url === '/api/auth/sign-in/email') return jsonResponse(200, { user: { id: 'attacker-controlled' } });
    if (call.url === '/api/v1/account') return jsonResponse(200, ACCOUNT_A);
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  const account = await client.signIn({ email: 'ron@example.com', password: 'secret-secret' });

  assert.deepEqual(account, { contractVersion: '0.1.0', id: ACCOUNT_A.id, email: ACCOUNT_A.email });
  assert.equal(fake.calls.length, 2, 'sign-in is exactly one auth POST plus one account verification');
  const [auth, me] = fake.calls;
  assert.equal(auth.url, '/api/auth/sign-in/email');
  assert.equal(auth.method, 'POST');
  assert.equal(auth.credentials, 'same-origin');
  assert.equal(auth.cache, 'no-store');
  assert.equal(auth.headers['content-type'], 'application/json');
  assert.equal(auth.body, '{"email":"ron@example.com","password":"secret-secret"}');
  noOriginHeader(auth);
  assert.equal(me.url, '/api/v1/account');
  assert.equal(me.method, 'GET');
  assert.equal(me.body, undefined);
  assert.equal(me.credentials, 'same-origin');
  assert.equal(me.cache, 'no-store');
  noOriginHeader(me);
  assert.equal(client.getAccount().id, ACCOUNT_A.id, 'identity comes from the verified account, not the auth body');
  assert.ok(client.generation > 0, 'adopting an identity advances the generation');
});

check('sign-up uses the name/email/password allowlist and then verifies the account', async () => {
  const fake = transport((call) => {
    if (call.url === '/api/auth/sign-up/email') return jsonResponse(200, { user: { id: ACCOUNT_B.id } });
    if (call.url === '/api/v1/account') return jsonResponse(200, ACCOUNT_B);
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  const account = await client.signUp({ name: 'Ron S', email: 'ron@example.com', password: 'secret-secret' });
  assert.equal(account.id, ACCOUNT_B.id);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].url, '/api/auth/sign-up/email');
  assert.equal(fake.calls[0].method, 'POST');
  assert.equal(fake.calls[0].headers['content-type'], 'application/json');
  assert.equal(fake.calls[0].body, '{"name":"Ron S","email":"ron@example.com","password":"secret-secret"}');
  noOriginHeader(fake.calls[0]);
});

check('sign-in that does not establish a session reports unauthenticated instead of a fake success', async () => {
  const fake = transport((call) => {
    if (call.url === '/api/auth/sign-in/email') return jsonResponse(200, { user: { id: ACCOUNT_A.id } });
    if (call.url === '/api/v1/account') return jsonResponse(401, { error: 'unauthenticated' });
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  const error = await expectError(() => client.signIn({ email: 'ron@example.com', password: 'secret-secret' }), 'unauthenticated');
  assert.equal(error.status, 401);
  assert.equal(client.getAccount(), null);
});

check('a 401 from an auth POST does not clear an existing verified identity', async () => {
  let signIns = 0;
  const fake = transport((call) => {
    if (call.url === '/api/auth/sign-in/email') {
      signIns += 1;
      return signIns === 1
        ? jsonResponse(200, { user: { id: ACCOUNT_A.id } })
        : jsonResponse(401, { error: 'invalid_credentials' });
    }
    if (call.url === '/api/v1/account') return jsonResponse(200, ACCOUNT_A);
    if (call.url === `/api/v1/attempts/${ATTEMPT}`) return jsonResponse(200, attemptResource());
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  await client.signIn({ email: 'ron@example.com', password: 'correct-horse' });
  fake.calls.length = 0;

  const before = client.getAccount();
  const generation = client.generation;
  const error = await expectError(() => client.signIn({ email: 'ron@example.com', password: 'wrong-password' }), 'unauthenticated');
  assert.equal(error.status, 401);
  assert.equal(error.detail, 'invalid_credentials');
  assert.equal(fake.calls.length, 1, 'a failed auth POST is not retried and is not followed by an account call');
  assert.deepEqual(client.getAccount(), before, 'the verified identity survives a failed auth POST');
  assert.equal(client.generation, generation, 'a failed auth POST is not an identity transition');
  await client.readAttempt(ATTEMPT); // the verified account is still authorised
  assert.equal(fake.calls.length, 2);
});

check('getAccount hands out copies that cannot alter the internal identity', async () => {
  const { client } = await signedIn(() => jsonResponse(200, attemptResource()));
  const first = client.getAccount();
  first.id = 'attacker';
  first.email = 'attacker@example.com';
  first.contractVersion = '9.9.9';
  assert.equal(client.getAccount().id, ACCOUNT_A.id);
  assert.equal(client.getAccount().email, ACCOUNT_A.email);
  const second = client.getAccount();
  assert.notEqual(first, second, 'each call returns an independent copy');
  await client.readAttempt(ATTEMPT); // still authorised as the verified account
});

check('learner calls use the exact fixed routes, methods, bodies and options', async () => {
  const routes = {
    [`/api/v1/attempts/${ATTEMPT}`]: (call) => {
      if (call.method === 'DELETE') return jsonResponse(200, { deleted: true });
      if (call.method === 'PUT') return jsonResponse(200, { revision: 3, text: 'Mein Entwurf' });
      return jsonResponse(200, attemptResource());
    },
    '/api/v1/attempts': () => jsonResponse(201, { id: ATTEMPT, revision: 1, text: '' }),
    [`/api/v1/attempts/${ATTEMPT}/submissions`]: () => jsonResponse(202, { submissionId: SUBMISSION, replay: false }),
    [`/api/v1/submissions/${SUBMISSION}`]: () => jsonResponse(200, resultResource()),
    [`/api/v1/submissions/${SUBMISSION}/retry`]: () => jsonResponse(202, { queued: true }),
  };
  const { client, calls } = await signedIn((call) => {
    const route = routes[call.url];
    if (!route) throw new Error(`unexpected request ${call.url}`);
    return route(call);
  });

  const created = await client.createAttempt({ parentSubmissionId: PARENT_SUBMISSION });
  assert.equal(created.id, ATTEMPT);
  const attempt = await client.readAttempt(ATTEMPT);
  assert.equal(attempt.text, 'Mein Entwurf');
  const draft = await client.saveDraft(ATTEMPT, { expectedRevision: 2, text: 'Mein Entwurf' });
  assert.equal(draft.revision, 3);
  const submission = await client.submit(ATTEMPT, { expectedRevision: 3, eventId: EVENT_ID });
  assert.equal(submission.submissionId, SUBMISSION);
  const result = await client.readResult(SUBMISSION);
  assert.equal(result.submission.id, SUBMISSION);
  const retried = await client.retry(SUBMISSION);
  assert.equal(retried.queued, true);
  const deleted = await client.deleteAttempt(ATTEMPT);
  assert.equal(deleted.deleted, true);

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['POST', '/api/v1/attempts'],
    ['GET', `/api/v1/attempts/${ATTEMPT}`],
    ['PUT', `/api/v1/attempts/${ATTEMPT}`],
    ['POST', `/api/v1/attempts/${ATTEMPT}/submissions`],
    ['GET', `/api/v1/submissions/${SUBMISSION}`],
    ['POST', `/api/v1/submissions/${SUBMISSION}/retry`],
    ['DELETE', `/api/v1/attempts/${ATTEMPT}`],
  ]);
  assert.deepEqual(calls.map((call) => call.body), [
    `{"parentSubmissionId":"${PARENT_SUBMISSION}"}`,
    undefined,
    JSON.stringify({ expectedRevision: 2, text: 'Mein Entwurf' }),
    JSON.stringify({ expectedRevision: 3, eventId: EVENT_ID }),
    undefined,
    '{}',
    '{}',
  ]);
  for (const call of calls) {
    assert.equal(call.credentials, 'same-origin', `${call.url} must use same-origin credentials`);
    assert.equal(call.cache, 'no-store', `${call.url} must opt out of caching`);
    noOriginHeader(call);
    if (call.method !== 'GET') {
      assert.equal(call.headers['content-type'], 'application/json', `${call.method} ${call.url} must send JSON`);
    }
  }
});

check('createAttempt without a parent sends an empty JSON object', async () => {
  const { client, calls } = await signedIn(() => jsonResponse(201, { id: ATTEMPT, revision: 1, text: '' }));
  await client.createAttempt();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, '{}');
  assert.equal(calls[0].headers['content-type'], 'application/json');
});

check('invalid identifiers are rejected locally and never reach a route', async () => {
  const { client, calls } = await signedIn(() => jsonResponse(200, attemptResource()));
  await expectError(() => client.readAttempt('not-a-uuid'), 'invalid_request');
  await expectError(() => client.readAttempt('1'), 'invalid_request');
  await expectError(() => client.readAttempt('../../api/progress'), 'invalid_request');
  await expectError(() => client.readAttempt('https://evil.example/api/v1/attempts'), 'invalid_request');
  await expectError(() => client.readAttempt(`${ATTEMPT}/../../progress`), 'invalid_request');
  await expectError(() => client.readAttempt(null), 'invalid_request');
  await expectError(() => client.readResult('nope'), 'invalid_request');
  await expectError(() => client.retry('nope'), 'invalid_request');
  await expectError(() => client.deleteAttempt(''), 'invalid_request');
  await expectError(() => client.createAttempt({ parentSubmissionId: 'nope' }), 'invalid_request');
  await expectError(() => client.submit(ATTEMPT, { expectedRevision: 1, eventId: 'nope' }), 'invalid_request');
  assert.equal(calls.length, 0, 'no malformed identifier may produce a request');
  assert.ok(!calls.some((call) => call.url.includes('progress')), 'legacy progress endpoints are never used');
});

check('revision and text limits are enforced before sending', async () => {
  const { client, calls } = await signedIn(() => jsonResponse(200, { revision: 3, text: '' }));
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 0, text: 'a' }), 'invalid_request');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: -1, text: 'a' }), 'invalid_request');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 1.5, text: 'a' }), 'invalid_request');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: '1', text: 'a' }), 'invalid_request');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 1, text: 42 }), 'invalid_request');
  await expectError(() => client.submit(ATTEMPT, { expectedRevision: 0, eventId: EVENT_ID }), 'invalid_request');
  await expectError(() => client.submit(ATTEMPT, { eventId: EVENT_ID }), 'invalid_request');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 1, text: 'ä'.repeat(DRAFT_TEXT_LIMIT + 1) }), 'invalid_request');
  assert.equal(calls.length, 0);

  // Exactly at the documented bound the draft is accepted.
  await client.saveDraft(ATTEMPT, { expectedRevision: 1, text: 'ä'.repeat(DRAFT_TEXT_LIMIT) });
  assert.equal(calls.length, 1);
});

check('privileged and unknown fields are refused in every input position', async () => {
  const { client, calls } = await signedIn((call) => {
    if (call.url.endsWith('/submissions')) return jsonResponse(202, { submissionId: SUBMISSION, replay: false });
    return jsonResponse(200, attemptResource());
  });
  await expectError(() => client.createAttempt({ owner_id: 'victim' }), 'invalid_request');
  await expectError(() => client.createAttempt({ baseURL: 'https://evil.example' }), 'invalid_request');
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 1, text: 'a', owner_id: 'victim' }), 'invalid_request');
  await expectError(() => client.submit(ATTEMPT, { expectedRevision: 1, eventId: EVENT_ID, score: 100 }), 'invalid_request');
  await expectError(() => client.signIn({ email: 'a@example.com', password: 'x', ownerId: 'victim' }), 'invalid_request');
  await expectError(() => client.signUp({ name: 'A', email: 'a@example.com', password: 'x', role: 'admin' }), 'invalid_request');
  await expectError(() => createOwnedClient({ baseURL: 'https://evil.example' }), 'invalid_request');
  assert.equal(calls.length, 0, 'no refused input may produce a request');
  assert.ok(!calls.some((call) => (call.body ?? '').includes('owner_id')), 'owner_id is never sent');
  await expectError(() => client.readAttempt(ATTEMPT, { owner_id: 'victim' }), 'invalid_request');
  await expectError(() => client.clear({ force: true }), 'invalid_request');
  assert.equal(calls.length, 0);

  // The same call without the extra field still works, so the refusals are about the field.
  await client.submit(ATTEMPT, { expectedRevision: 1, eventId: EVENT_ID });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].body.includes('owner_id'));
});

check('a 409 conflict is preserved with no retry and no local loss', async () => {
  const { client, calls } = await signedIn(() => jsonResponse(409, { error: 'draft_conflict' }));
  const text = 'Mein Entwurf, den der Lernende gerade tippt';
  const error = await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 5, text }), 'conflict');
  assert.equal(error.status, 409);
  assert.equal(error.detail, 'draft_conflict');
  assert.equal(calls.length, 1, 'a conflict must never be retried automatically');
  assert.equal(JSON.parse(calls[0].body).expectedRevision, 5, 'the caller revision is reported, not rewritten');
  assert.equal(text, 'Mein Entwurf, den der Lernende gerade tippt');
});

check('a 409 keeps the caller able to resolve the conflict with a fresh revision', async () => {
  let attempt = 0;
  const { client, calls } = await signedIn(() => (attempt++ === 0
    ? jsonResponse(409, { error: 'draft_conflict' })
    : jsonResponse(200, { revision: 8, text: 'Mein Entwurf' })));
  await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 5, text: 'Mein Entwurf' }), 'conflict');
  const saved = await client.saveDraft(ATTEMPT, { expectedRevision: 7, text: 'Mein Entwurf' });
  assert.equal(saved.revision, 8, 'the resolved save is reported as the server answered');
  assert.deepEqual(calls.map((call) => JSON.parse(call.body).expectedRevision), [5, 7]);
});

check('an uncertain submission is reported once and left to the caller with its event ID', async () => {
  const { client, calls } = await signedIn((call) => {
    if (call.url.endsWith('/submissions')) return networkFailure();
    return jsonResponse(200, attemptResource());
  });
  const error = await expectError(() => client.submit(ATTEMPT, { expectedRevision: 2, eventId: EVENT_ID }), 'network_error');
  assert.equal(error.status, null);
  assert.equal(calls.length, 1, 'an uncertain POST must not be replayed automatically');
  assert.equal(JSON.parse(calls[0].body).eventId, EVENT_ID);
  // The caller retries explicitly with the same event ID; the transport does not substitute one.
  await expectError(() => client.submit(ATTEMPT, { expectedRevision: 2, eventId: EVENT_ID }), 'network_error');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => JSON.parse(call.body).eventId), [EVENT_ID, EVENT_ID]);
});

check('malformed, off-contract and unsupported responses are reported, never guessed', async () => {
  const notJson = transport(() => textResponse(200, '<html>proxy error</html>'));
  const clientA = notJson.client();
  await expectError(() => clientA.refreshAccount(), 'malformed_response');
  assert.equal(clientA.getAccount(), null);

  const wrongVersion = transport(() => jsonResponse(200, { contractVersion: '0.2.0', id: 'user-acct-a', email: 'a@example.com' }));
  const clientB = wrongVersion.client();
  await expectError(() => clientB.refreshAccount(), 'unsupported_contract');
  assert.equal(clientB.getAccount(), null, 'an unsupported contract must not establish an identity');

  const noId = transport(() => jsonResponse(200, { contractVersion: '0.1.0' }));
  await expectError(() => noId.client().refreshAccount(), 'malformed_response');

  const blankId = transport(() => jsonResponse(200, { contractVersion: '0.1.0', id: '   ' }));
  await expectError(() => blankId.client().refreshAccount(), 'malformed_response');

  const { client, calls } = await signedIn((call) => {
    if (call.url.includes('/submissions/')) return jsonResponse(200, resultResource({ submission: { id: OTHER_ATTEMPT, text: 'x' } }));
    if (call.method === 'DELETE') return { status: 204, text: async () => '' };
    return jsonResponse(200, { id: ATTEMPT }); // attempt without revision/text
  });
  await expectError(() => client.readAttempt(ATTEMPT), 'malformed_response');
  await expectError(() => client.readResult(SUBMISSION), 'malformed_response');
  await expectError(() => client.deleteAttempt(ATTEMPT), 'malformed_response');
  assert.equal(calls.length, 3, 'an accepted response must not trigger a retry');

  const mismatched = await signedIn(() => jsonResponse(200, attemptResource({ id: OTHER_ATTEMPT })));
  await expectError(() => mismatched.client.readAttempt(ATTEMPT), 'malformed_response');
});

check('a delayed save that resolves after clear() is fenced even if the transport ignores AbortSignal', async () => {
  const gate = deferredResponse();
  const { client, calls } = await signedIn(() => gate.promise);
  const pending = client.saveDraft(ATTEMPT, { expectedRevision: 2, text: 'Mein Entwurf' });
  client.clear();
  assert.equal(client.getAccount(), null, 'clear() drops the identity immediately');
  assert.ok(calls[0].signal.aborted, 'clear() aborts the in-flight request');
  gate.resolve(jsonResponse(200, { revision: 3, text: 'Mein Entwurf' })); // success the transport should have dropped
  await expectError(() => pending, 'stale_session');
  assert.equal(client.getAccount(), null, 'a late response must not restore the cleared identity');
  await expectError(() => client.readAttempt(ATTEMPT), 'unauthenticated');
});

check('a superseded auth failure is stale_session, not network_error, when the transport ignores AbortSignal', async () => {
  // With no AbortController the client has no signal to lean on, so only the
  // generation re-check can tell a superseded auth failure from a real one.
  const savedAbortController = globalThis.AbortController;
  globalThis.AbortController = undefined;
  try {
    const gate = deferredResponse();
    const fake = transport(async () => {
      await gate.promise;
      throw new TypeError('fetch failed');
    });
    const client = fake.client();
    const pending = client.signIn({ email: 'ron@example.com', password: 'correct-horse' });
    assert.equal(fake.calls.length, 1, 'the sign-in POST is already in flight');
    assert.equal(fake.calls[0].url, '/api/auth/sign-in/email');
    assert.equal(fake.calls[0].method, 'POST');
    assert.equal(fake.calls[0].signal, undefined, 'there is no AbortSignal for the transport to honour');

    client.clear(); // the session boundary that supersedes the in-flight auth call
    assert.equal(client.getAccount(), null, 'clear() drops the identity immediately');
    gate.resolve();
    await expectError(() => pending, 'stale_session');
    assert.equal(fake.calls.length, 1, 'a superseded auth call is neither retried nor re-posted');

    // Control: in the same signal-less environment an unsuperseded auth failure
    // is still a transport failure, so the re-check cannot mask a real one.
    const control = transport(async () => { throw new TypeError('fetch failed'); });
    await expectError(() => control.client().signIn({ email: 'ron@example.com', password: 'correct-horse' }), 'network_error');
    assert.equal(control.calls.length, 1, 'a failed auth call is not retried');
  } finally {
    globalThis.AbortController = savedAbortController;
  }
});

check('a sign-out supersedes an in-flight auth call as stale_session', async () => {
  const savedAbortController = globalThis.AbortController;
  globalThis.AbortController = undefined;
  try {
    const gate = deferredResponse();
    const fake = transport(async (call) => {
      if (call.url === '/api/auth/sign-out') return jsonResponse(200, { success: true });
      await gate.promise;
      throw new TypeError('fetch failed');
    });
    const client = fake.client();
    const pending = client.signIn({ email: 'ron@example.com', password: 'correct-horse' });
    assert.equal(fake.calls[0].signal, undefined, 'there is no AbortSignal for the transport to honour');
    await client.signOut(); // a real session boundary, not just a local clear
    assert.equal(client.getAccount(), null);
    gate.resolve();
    await expectError(() => pending, 'stale_session');
    assert.equal(fake.calls.length, 2, 'sign-in and sign-out are each attempted exactly once');
    assert.equal(fake.calls.filter((call) => call.url === '/api/auth/sign-in/email').length, 1);
  } finally {
    globalThis.AbortController = savedAbortController;
  }
});

check('a delayed response from a previous account cannot populate the new account', async () => {
  const gate = deferredResponse();
  let account = ACCOUNT_A;
  const fake = transport((call) => {
    if (call.url === '/api/v1/account') return jsonResponse(200, account);
    if (call.url === '/api/auth/sign-in/email') return jsonResponse(200, { user: { id: account.id } });
    if (call.url === '/api/auth/sign-out') return jsonResponse(200, { success: true });
    if (call.url === `/api/v1/attempts/${ATTEMPT}`) return gate.promise;
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  await client.refreshAccount();
  assert.equal(client.getAccount().id, ACCOUNT_A.id);

  const stale = client.readAttempt(ATTEMPT);
  await client.signOut();
  assert.equal(client.getAccount(), null, 'signOut clears the identity before the server answers');
  account = ACCOUNT_B;
  await client.signIn({ email: 'b@example.com', password: 'correct-horse' });
  assert.equal(client.getAccount().id, ACCOUNT_B.id);

  gate.resolve(jsonResponse(200, attemptResource({ owner_id: ACCOUNT_A.id })));
  await expectError(() => stale, 'stale_session');
  assert.equal(client.getAccount().id, ACCOUNT_B.id, 'the late response must not restore the old account');
});

check('a stale 401 cannot sign out a newer account, but a current 401 does', async () => {
  const gate = deferredResponse();
  let account = ACCOUNT_A;
  const fake = transport((call) => {
    if (call.url === '/api/v1/account') return jsonResponse(200, account);
    if (call.url === '/api/auth/sign-in/email') return jsonResponse(200, { user: { id: account.id } });
    if (call.url === '/api/auth/sign-out') return jsonResponse(200, { success: true });
    if (call.url === `/api/v1/attempts/${ATTEMPT}`) return gate.promise;
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  await client.refreshAccount();
  const stale = client.readAttempt(ATTEMPT);
  await client.signOut();
  account = ACCOUNT_B;
  await client.signIn({ email: 'b@example.com', password: 'correct-horse' });

  gate.resolve(jsonResponse(401, { error: 'unauthenticated' }));
  await expectError(() => stale, 'stale_session');
  assert.equal(client.getAccount().id, ACCOUNT_B.id, 'an old-generation 401 must not clear the new account');

  const current = await signedIn(() => jsonResponse(401, { error: 'unauthenticated' }));
  const error = await expectError(() => current.client.readAttempt(ATTEMPT), 'unauthenticated');
  assert.equal(error.status, 401);
  assert.equal(current.client.getAccount(), null, 'a current-generation 401 invalidates the local account');
});

check('a network failure does not invent an identity change', async () => {
  const { client } = await signedIn(() => networkFailure());
  const before = client.generation;
  const error = await expectError(() => client.saveDraft(ATTEMPT, { expectedRevision: 2, text: 'Entwurf' }), 'network_error');
  assert.equal(error.status, null);
  assert.equal(client.getAccount().id, ACCOUNT_A.id, 'a transport failure keeps the verified identity');
  assert.equal(client.generation, before, 'a transport failure is not an identity transition');
});

check('sign-out clears the identity immediately and reports an honest server answer', async () => {
  const ok = await signedIn(() => jsonResponse(200, { success: true }));
  const pending = ok.client.signOut();
  assert.equal(ok.client.getAccount(), null, 'sign-out clears local identity before awaiting the server');
  await pending;
  assert.equal(ok.client.getAccount(), null);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, '/api/auth/sign-out');
  assert.equal(ok.calls[0].method, 'POST');
  assert.equal(ok.calls[0].body, '{}');
  assert.equal(ok.calls[0].headers['content-type'], 'application/json');
  noOriginHeader(ok.calls[0]);

  const offline = await signedIn((call) => {
    if (call.url === '/api/auth/sign-out') return networkFailure();
    throw new Error(`unexpected request ${call.url}`);
  });
  const error = await expectError(() => offline.client.signOut(), 'network_error');
  assert.equal(error.status, null);
  assert.equal(offline.client.getAccount(), null, 'a failed sign-out still leaves the local identity cleared');
  assert.equal(offline.calls.length, 1, 'a failed sign-out is not retried');

  const refused = await signedIn(() => jsonResponse(500, { error: 'internal_error' }));
  const refusedError = await expectError(() => refused.client.signOut(), 'server_error');
  assert.equal(refusedError.status, 500);
  assert.equal(refusedError.detail, 'internal_error');
  assert.equal(refused.client.getAccount(), null);
});

check('refreshAccount is a deliberate boundary, not an automatic poll', async () => {
  const { client, calls } = await signedIn((call) => {
    if (call.url.endsWith('/submissions')) return jsonResponse(202, { submissionId: SUBMISSION, replay: false });
    return jsonResponse(200, attemptResource());
  });
  await client.readAttempt(ATTEMPT);
  await client.saveDraft(ATTEMPT, { expectedRevision: 2, text: 'Entwurf' });
  await client.submit(ATTEMPT, { expectedRevision: 3, eventId: EVENT_ID });
  assert.equal(calls.filter((call) => call.url === '/api/v1/account').length, 0, 'learner calls never poll the account');

  const account = await client.refreshAccount();
  assert.equal(account.id, ACCOUNT_A.id);
  assert.equal(calls.filter((call) => call.url === '/api/v1/account').length, 1, 'only the explicit call asks for the account');
  assert.equal(client.getAccount().id, ACCOUNT_A.id);
});

check('clear() invalidates the local context without contacting the server', async () => {
  const { client, calls } = await signedIn(() => jsonResponse(200, attemptResource()));
  const before = client.generation;
  client.clear();
  client.clear();
  assert.equal(calls.length, 0, 'clear() is local only');
  assert.equal(client.getAccount(), null);
  assert.equal(client.generation, before + 2, 'the generation increases monotonically');
  await expectError(() => client.readAttempt(ATTEMPT), 'unauthenticated');
});

check('server statuses map to distinct documented codes and never sign the learner out', async () => {
  const cases = [[400, 'bad_request'], [403, 'forbidden'], [404, 'not_found'], [413, 'too_large'], [415, 'unsupported_media_type'], [422, 'unprocessable'], [503, 'server_error']];
  for (const [status, code] of cases) {
    const { client } = await signedIn(() => jsonResponse(status, { error: 'opaque_token' }));
    const error = await expectError(() => client.readAttempt(ATTEMPT), code);
    assert.equal(error.status, status, `${status} must keep its status`);
    assert.equal(client.getAccount()?.id, ACCOUNT_A.id, `${status} must not change the verified identity`);
  }
});

check('refreshAccount fences only identity transitions, not a confirmation of the same account', async () => {
  const gate = deferredResponse();
  const fake = transport((call) => {
    if (call.url === '/api/v1/account') return jsonResponse(200, ACCOUNT_A);
    if (call.url === '/api/auth/sign-in/email') return jsonResponse(200, { user: { id: ACCOUNT_A.id } });
    return gate.promise;
  });
  const client = fake.client();
  await client.signIn({ email: 'a@example.com', password: 'correct-horse' });

  const pending = client.saveDraft(ATTEMPT, { expectedRevision: 2, text: 'Entwurf' });
  const confirmed = await client.refreshAccount();
  assert.equal(confirmed.id, ACCOUNT_A.id);
  assert.equal(fake.calls[2].signal.aborted, false, 'a same-account refresh must not abort a valid save');
  gate.resolve(jsonResponse(200, { revision: 3, text: 'Entwurf' }));
  const saved = await pending;
  assert.equal(saved.revision, 3, 'a confirmed same-account refresh does not discard the pending save');
});

check('a refreshAccount identity transition aborts and fences pending work', async () => {
  const gate = deferredResponse();
  let account = ACCOUNT_A;
  const fake = transport((call) => {
    if (call.url === '/api/v1/account') return jsonResponse(200, account);
    if (call.url === `/api/v1/attempts/${ATTEMPT}`) return gate.promise;
    throw new Error(`unexpected request ${call.url}`);
  });
  const client = fake.client();
  await client.refreshAccount();
  assert.equal(client.getAccount().id, ACCOUNT_A.id);

  const pending = client.saveDraft(ATTEMPT, { expectedRevision: 2, text: 'Entwurf' });
  account = ACCOUNT_B; // the server session moved to another account
  const switched = await client.refreshAccount();
  assert.equal(switched.id, ACCOUNT_B.id);
  assert.ok(fake.calls[1].signal.aborted, 'the identity transition aborts the superseded request');
  gate.resolve(jsonResponse(200, { revision: 3, text: 'Entwurf' }));
  await expectError(() => pending, 'stale_session');
  assert.equal(client.getAccount().id, ACCOUNT_B.id);
});

check('errors never carry server internals', async () => {
  const hostile = transport(() => jsonResponse(500, {
    error: 'SQLSTATE 23505 unique_violation in table attempts',
    stack: 'at /srv/hatoove/server.js:42',
    message: 'password=hunter2',
  }));
  const error = await expectError(() => hostile.client().refreshAccount(), 'server_error');
  assert.equal(error.status, 500);
  assert.equal(error.detail, null, 'a non-token error value must not be echoed');
  for (const leak of ['SQLSTATE', 'unique_violation', 'server.js', 'hunter2', 'attempts']) {
    assert.ok(!error.message.includes(leak), `the error message leaked ${leak}`);
  }
  assert.ok(!('body' in error) && !('response' in error), 'the raw response is not attached to the error');

  const { client } = await signedIn(() => jsonResponse(409, { error: 'allowance_exhausted' }));
  const conflict = await expectError(() => client.submit(ATTEMPT, { expectedRevision: 1, eventId: EVENT_ID }), 'conflict');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.detail, 'allowance_exhausted', 'a documented envelope token is preserved');
  assert.ok(conflict.isConflict && !conflict.isStaleSession, 'the typed error exposes its classification');
  assert.equal(conflict.message.includes('allowance_exhausted'), true);
});

check('a caller cannot reach any route other than the fixed same-origin ones', async () => {
  const offenders = ALL_URLS.filter((url) => typeof url !== 'string'
    || !url.startsWith('/api/')
    || url.startsWith('//')
    || /^https?:/i.test(url));
  assert.deepEqual(offenders, [], 'every request must be a same-origin /api path');
  const unexpected = ALL_URLS.filter((url) => !(
    url === '/api/auth/sign-in/email'
    || url === '/api/auth/sign-up/email'
    || url === '/api/auth/sign-out'
    || url === '/api/v1/account'
    || url === '/api/v1/attempts'
    || /^\/api\/v1\/attempts\/[0-9a-f-]{36}(\/submissions)?$/.test(url)
    || /^\/api\/v1\/submissions\/[0-9a-f-]{36}(\/retry)?$/.test(url)
  ));
  assert.deepEqual(unexpected, [], 'only the contract routes may be requested');
  assert.ok(ALL_URLS.length > 20, 'the suite exercised real requests');
  assert.ok(ALL_URLS.every((url) => !url.includes('progress') && !url.includes('/api/ai') && !url.includes('/api/config')),
    'legacy progress/AI/config endpoints are never used');
});

/* -------------------------------------------------------------------- run */

let failed = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${error && error.message ? error.message : error}`);
    if (error && error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  }
}

console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
