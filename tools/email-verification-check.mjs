/*
 * EMAIL VERIFICATION — the last of the four routes PILOT-18 measured as 404.
 *
 * The queue measured `forget-password`, `reset-password`, `verify-email` and `send-verification-email` all
 * returning 404 with `verification` holding 0 rows. The reset half is built (D6's token path, operator
 * delivery); this is the same machinery for the OTHER purpose: proving that a learner controls the address
 * they registered with.
 *
 * SAME CHANNEL, NO PROVIDER: the link goes through `server/notify.mjs` to the operator console, exactly as the
 * reset link does, because D6's provider decision is still a human's to make. Verification therefore needs no
 * decision to build — which is why it is the next item rather than a blocked one.
 *
 * WHAT IS DIFFERENT FROM A RESET, and why each difference is deliberate:
 *
 *   * A LONGER LIFE. A reset link is a credential and lives 30 minutes; a verification link only asserts
 *     "this address is mine", so it can live a day without being dangerous.
 *   * IT DOES NOT SIGN ANYONE IN. An emailed link that both proves an address AND authenticates would let the
 *     delivery channel — an operator console, a chat message, a screenshot — become a login. Verifying marks
 *     the account; signing in still needs the password.
 *   * IT IS NOT A SECRET ABOUT THE ACCOUNT. `send-verification-email` answers the same for an unknown address
 *     as for a known one, and produces no message for the unknown one, so it cannot be used to ask "does this
 *     learner have an account here?" — the same rule the reset request follows.
 *
 * Usage:
 *   node tools/email-verification-check.mjs          (needs a disposable DB; OWNAPI_PG_*)
 *   node tools/email-verification-check.mjs --list
 */

import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createNotifier } from '../server/notify.mjs';

/* =============================================================== the world */

const db = await createFixture();

/** The operator's view, captured rather than printed — the delivery half is the check's, the link builder is
 *  the product's, exactly as `account-recovery-check` does it. */
const delivered = [];
const notifier = createNotifier({
  publicOrigin: 'https://pilot.example.test',
  channel: 'test-capture',
  deliver: async (message) => { delivered.push(message); return { delivered: true, channel: 'test-capture' }; },
});
const world = await createPostgresWorld({ fixture: db, notifier });

function caller(api) {
  return async function call(method, path, { cookie = null, body = undefined } = {}) {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await api.handle({
      method, path, headers, originChecked: true,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* not JSON */ }
    const raw = response.headers && (response.headers['set-cookie'] || response.headers['Set-Cookie']);
    return { status: response.status, json, text: response.body, setCookie: raw ? String(raw).split(';')[0] : cookie };
  };
}

const call = caller(world.api);
const one = async (sql, params) => (await db.admin.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.admin.query(sql, params)).rows;

let counter = 0;
const nextEmail = () => `verify-${Date.now()}-${(counter += 1)}@example.invalid`;

async function account(tag = 'a') {
  await db.admin.query('DELETE FROM auth_throttle WHERE bucket = $1', ['signup:global']);
  const email = nextEmail();
  const password = `pw-${tag}-synthetic`;
  const created = await call('POST', '/api/auth/sign-up/email', { body: { name: `L ${tag}`, email, password } });
  assert.equal(created.status, 200, `sign-up ${tag}: ${created.status} ${created.text.slice(0, 120)}`);
  const row = await one('SELECT id, "emailVerified" FROM "user" WHERE email = $1', [email]);
  return { email, password, userId: row.id, cookie: created.setCookie, verified: row.emailVerified };
}

/** Ask for a verification link and return the operator's message, if any. */
async function requestVerification(email) {
  const before = delivered.length;
  const res = await call('POST', '/api/auth/send-verification-email', { body: { email } });
  return { res, message: delivered.slice(before)[0] || null };
}

const tokenOf = (message) => {
  const match = message && message.link ? /[?&]token=([^&\s]+)/.exec(String(message.link)) : null;
  return match ? decodeURIComponent(match[1]) : null;
};

/* ================================================================== legs */

const legs = [];
const check = (name, fn) => legs.push({ name, fn });
const failures = [];
let passed = 0;

/*
 * 1. THE ROUTE EXISTS, AND THE REQUEST IS NOT AN ACCOUNT ORACLE.
 */
check('1. a verification request answers identically for known and unknown addresses', async () => {
  const a = await account('same');
  const known = await requestVerification(a.email);
  const unknown = await requestVerification(nextEmail());
  assert.equal(known.res.status, 200, `the route must answer 200, got ${known.res.status}`);
  assert.equal(unknown.res.status, 200, 'an unknown address must answer 200 too');
  assert.deepEqual(known.res.json, unknown.res.json, 'and identically, or the route enumerates accounts');
  assert.ok(!/token/i.test(known.res.text), `THE RESPONSE MUST NOT CARRY A TOKEN: ${known.res.text.slice(0, 160)}`);
  return `both ${known.res.status} ${JSON.stringify(known.res.json)}`;
});

/*
 * 2. THE LINK REACHES THE OPERATOR, AND ONLY FOR A REAL ACCOUNT — and it is a DIFFERENT kind of message from
 *    a reset, so an operator can tell the two apart at a glance.
 */
check('2. the verification link goes to the operator, labelled as what it is', async () => {
  const a = await account('notify');
  const { message, res } = await requestVerification(a.email);
  assert.ok(message, 'the operator must receive a message');
  assert.equal(message.to, a.email);
  assert.equal(message.kind, 'email-verification', `a reset is "password-reset"; this is ${message.kind}`);
  assert.ok(tokenOf(message), 'and the link carries a token');
  assert.ok(!message.link.includes('reset-password'), 'the verification link must not point at the reset page');
  assert.ok(!res.text.includes(tokenOf(message)), 'the token must not be in the response');

  const before = delivered.length;
  await call('POST', '/api/auth/send-verification-email', { body: { email: nextEmail() } });
  assert.equal(delivered.length, before, 'no message may be produced for an address with no account');
  return `delivered for the real account with kind ${message.kind}; nothing for the unknown one`;
});

/*
 * 3. THE STORED TOKEN IS A HASH.
 */
check('3. the stored verification token is a hash, not the link', async () => {
  const a = await account('hashed');
  const { message } = await requestVerification(a.email);
  const token = tokenOf(message);
  const rows = await all('SELECT identifier, value FROM verification WHERE identifier LIKE $1', [`%${a.email}`]);
  assert.equal(rows.length, 1, `exactly one row, got ${rows.length}`);
  assert.notEqual(rows[0].value, token, 'the stored value must not BE the token');
  assert.ok(rows[0].value.length >= 32, `the stored value must be a hash, got ${rows[0].value.length} chars`);
  return `stored a ${rows[0].value.length}-char hash for a ${token.length}-char token`;
});

/*
 * 4. A VALID TOKEN MARKS THE ACCOUNT VERIFIED, ONCE.
 */
check('4. a valid token sets emailVerified, once', async () => {
  const a = await account('once');
  assert.equal(a.verified, false, 'a fresh account is unverified — which is what makes this assertion worth making');
  const { message } = await requestVerification(a.email);
  const token = tokenOf(message);

  const done = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert.equal(done.status, 200, `a valid token must verify, got ${done.status} ${done.text.slice(0, 120)}`);
  assert.equal((await one('SELECT "emailVerified" FROM "user" WHERE id = $1', [a.userId])).emailVerified, true,
    'and the account must record it');

  const again = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert.equal(again.status, 400, `a consumed token must be refused, got ${again.status}`);
  assert.equal((await all('SELECT id FROM verification WHERE identifier LIKE $1', [`%${a.email}`])).length, 0,
    'and the row is gone rather than merely unusable');
  return 'verified on first use, refused on second, row deleted';
});

/*
 * 5. AN EXPIRED TOKEN IS REFUSED AND MARKS NOTHING.
 */
check('5. an expired verification token is refused', async () => {
  const a = await account('expired');
  const { message } = await requestVerification(a.email);
  const token = tokenOf(message);
  await db.admin.query('UPDATE verification SET "expiresAt" = now() - interval \'1 minute\' WHERE identifier LIKE $1', [`%${a.email}`]);
  const res = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert.equal(res.status, 400, `an expired token must be refused, got ${res.status}`);
  assert.equal((await one('SELECT "emailVerified" FROM "user" WHERE id = $1', [a.userId])).emailVerified, false,
    'and nothing may be marked verified');
  return 'expired token refused, account still unverified';
});

/*
 * 6. THE TOKEN IS BOUND TO ITS OWN ACCOUNT.
 */
check('6. one account\'s token cannot verify another account', async () => {
  const a = await account('bound-a');
  const b = await account('bound-b');
  const { message } = await requestVerification(a.email);
  const done = await call('POST', '/api/auth/verify-email', { body: { token: tokenOf(message) } });
  assert.equal(done.status, 200, "A's token must verify A");
  assert.equal((await one('SELECT "emailVerified" FROM "user" WHERE id = $1', [a.userId])).emailVerified, true, 'A is verified');
  assert.equal((await one('SELECT "emailVerified" FROM "user" WHERE id = $1', [b.userId])).emailVerified, false,
    "and B is untouched — the token resolves to A through its own row, not through anything in the request");
  return "A verified, B still unverified";
});

/*
 * 7. VERIFYING IS NOT SIGNING IN.
 *
 * If a verification link also authenticated, then the delivery channel — an operator console, a chat message, a
 * screenshot — would be a way to obtain a session. The link proves an address; the password still signs in.
 */
check('7. verifying an address does not create a session', async () => {
  const a = await account('nosession');
  const sessionsBefore = (await all('SELECT id FROM session WHERE "userId" = $1', [a.userId])).length;
  const { message } = await requestVerification(a.email);
  const res = await call('POST', '/api/auth/verify-email', { body: { token: tokenOf(message) } });
  assert.equal(res.status, 200, res.text.slice(0, 120));
  assert.equal(res.setCookie, null, 'the route must not set a session cookie');
  assert.equal((await all('SELECT id FROM session WHERE "userId" = $1', [a.userId])).length, sessionsBefore,
    'and it must not create a session row');
  assert.equal((await call('GET', '/api/v1/account')).status, 401,
    'an unauthenticated caller stays unauthenticated after verifying');
  return `no cookie, no session row, still 401 unauthenticated`;
});

/*
 * 8. AN ALREADY-VERIFIED ACCOUNT IS NOT ASKED AGAIN, and the request stays harmless.
 */
check('8. requesting verification for an already-verified account produces no second link', async () => {
  const a = await account('already');
  const first = await requestVerification(a.email);
  await call('POST', '/api/auth/verify-email', { body: { token: tokenOf(first.message) } });
  const before = delivered.length;
  const second = await requestVerification(a.email);
  assert.equal(second.res.status, 200, 'the request still answers 200: the caller learns nothing');
  assert.equal(delivered.length, before, 'but no message is produced for an account that is already verified');
  assert.equal((await all('SELECT id FROM verification WHERE identifier LIKE $1', [`%${a.email}`])).length, 0,
    'and no token is left lying around');
  return 'already-verified: 200 with no message and no token';
});

/*
 * 9. UNUSABLE TOKENS, WITH THE TWO KINDS DISTINGUISHED — the contract `account-recovery-check` pinned for the
 *    reset route, asserted here so the two flows cannot drift apart.
 */
check('9. an unusable verification token is refused, malformed distinguished from unresolvable', async () => {
  const malformed = [['an empty string', ''], ['a number', 42], ['a null', null], ['an absurdly long string', 'x'.repeat(600)]];
  for (const [what, token] of malformed) {
    const res = await call('POST', '/api/auth/verify-email', { body: { token } });
    assert.equal(res.status, 422, `${what} must be 422, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_token', `${what}: the code`);
  }
  for (const token of ['nonsense-nonsense-nonsense', 'x'.repeat(64)]) {
    const res = await call('POST', '/api/auth/verify-email', { body: { token } });
    assert.equal(res.status, 400, `${JSON.stringify(token.slice(0, 20))} must be 400, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_token', 'the same code as every other failure');
  }
  return `${malformed.length} malformed refused with 422, 2 unresolvable with 400`;
});

/* ==================================================================== run */

async function run() {
  if (process.argv.includes('--list')) {
    for (const leg of legs) console.log(leg.name);
    return 0;
  }
  const only = process.argv.find((a) => a.startsWith('--only='));
  for (const leg of legs) {
    if (only && !leg.name.toLowerCase().includes(only.split('=')[1].toLowerCase())) continue;
    try {
      const detail = await leg.fn();
      passed += 1;
      console.log(`PASS ${leg.name}${detail ? `  [${detail}]` : ''}`);
    } catch (error) {
      failures.push(leg.name);
      console.log(`FAIL ${leg.name}`);
      console.log(`     ${String(error.message).split('\n')[0]}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} finally {
  await db.cleanup().catch(() => {});
}
process.exitCode = code;
