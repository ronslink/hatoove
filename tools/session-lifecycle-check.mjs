/*
 * SESSION LIFECYCLE — THE FOUR MISSING BEHAVIOURS (D5's security gap).
 *
 * `MASTER-PLAN.md:280` measured what the session port does NOT do: "`session` has no rotation, expiry sweep
 * or revocation on password change". `DECISIONS-RECOMMENDATIONS.md:141` says to "write the four
 * missing-behaviour legs first — rotate the token on sign-in and 401 the retired cookie (session fixation),
 * expiry sweep, revoke one session, revoke all on password change — then prove the boundary did not move".
 * This file is those legs.
 *
 * WHY BEHAVIOUR AND NOT THE LIBRARY FIRST. The recommendation is to adopt Better Auth, but that trades away
 * the root `"dependencies": {}` property and needs a HUMAN signoff on password-hashing parameters and the RLS
 * grants for its tables. The gap below is a security property that exists TODAY, and the port seam
 * (`getSession`/`signUp`/`signIn`/`signOut`) is explicitly why the library swap is reversible — so the
 * behaviours are implemented behind that seam, and these legs become the acceptance criteria the swap must
 * still satisfy rather than being rewritten by it.
 *
 * WHAT IS ALREADY TRUE, and is asserted here so a regression is caught rather than assumed: an expired
 * session is REJECTED, and signing out DELETES the row. Neither is new; both are the baseline the four
 * behaviours build on.
 *
 * Usage:
 *   node tools/session-lifecycle-check.mjs          (needs a disposable DB; OWNAPI_PG_*)
 *   node tools/session-lifecycle-check.mjs --list
 *   node tools/session-lifecycle-check.mjs --only=rotation
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';

/* =============================================================== the world */

const db = await createFixture();
const world = await createPostgresWorld({ fixture: db });

/**
 * A cookie-jar caller.
 *
 * The session lives in a cookie HEADER, so the caller keeps the cookie it was given and sends it back — the
 * whole point of these legs is what happens to a cookie that has been RETIRED, and a caller that helpfully
 * refreshed it would hide exactly that. `setCookie` is the cookie the response issued (or the one already
 * held when it issued none), so "the old cookie" and "the new cookie" are both first-class here.
 */
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
    const issued = raw ? String(raw).split(';')[0] : null;
    return { status: response.status, json, text: response.body, rawSetCookie: raw || null, setCookie: issued || cookie };
  };
}

const call = caller(world.api);

const one = async (sql, params) => (await db.admin.query(sql, params)).rows[0];
const sessionRows = async (userId) =>
  (await db.admin.query('SELECT id, token, "expiresAt" FROM session WHERE "userId" = $1', [userId])).rows;

let emailCounter = 0;
const nextEmail = () => `session-${Date.now()}-${(emailCounter += 1)}@example.invalid`;

/** One account, signed up and holding its cookie. */
async function account(tag = 'a') {
  const email = nextEmail();
  const password = `pw-${tag}-synthetic`;
  const created = await call('POST', '/api/auth/sign-up/email', {
    body: { name: `Learner ${tag}`, email, password },
  });
  assert.equal(created.status, 200, `sign-up must succeed, got ${created.status} ${String(created.text).slice(0, 120)}`);
  const userId = (await one('SELECT id FROM "user" WHERE email = $1', [email])).id;
  assert.ok(created.setCookie && created.setCookie !== null, 'sign-up must issue a cookie');
  return { email, password, userId, cookie: created.setCookie };
}

/** A second device: an independent sign-in, so its cookie is a different session. */
async function secondDevice(a) {
  const res = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(res.status, 200, `second sign-in: ${res.status} ${String(res.text).slice(0, 120)}`);
  assert.notEqual(res.setCookie, a.cookie, 'the second device must hold a different cookie');
  return res;
}

/* ================================================================== legs */

const legs = [];
const check = (name, fn) => legs.push({ name, fn });
const failures = [];
let passed = 0;

/*
 * 1. ROTATION ON SIGN-IN — the session-fixation fix.
 *
 * The attack: an attacker plants a session cookie in a victim's browser (a shared machine, a subdomain, an
 * XSS). The victim signs in, and if the planted session SURVIVES the sign-in, the attacker now holds a valid
 * authenticated session they never had to authenticate for. The fix is that signing in RETIRES the cookie
 * that was presented and issues a new one: the planted token is worthless from the moment the real user
 * authenticates.
 */
check('1. signing in retires the cookie that was presented (session fixation)', async () => {
  const a = await account('rot');

  // A SECOND sign-in presenting the cookie from the first: the old session must not survive it.
  const again = await call('POST', '/api/auth/sign-in/email', {
    cookie: a.cookie, body: { email: a.email, password: a.password },
  });
  assert.equal(again.status, 200, `second sign-in: ${again.status} ${again.text.slice(0, 120)}`);
  assert.notEqual(again.setCookie, a.cookie, 'a sign-in must issue a NEW token, not reissue the same one');

  // The retired cookie is dead...
  const retired = await call('GET', '/api/v1/account', { cookie: a.cookie });
  assert.equal(retired.status, 401, `the retired cookie must be refused, got ${retired.status}`);
  // ...and the new one works.
  const fresh = await call('GET', '/api/v1/account', { cookie: again.setCookie });
  assert.equal(fresh.status, 200, `the new cookie must work, got ${fresh.status}`);

  const rows = await sessionRows(a.userId);
  assert.equal(rows.length, 1, `exactly one live session after rotation, got ${rows.length}`);
  assert.ok(!rows.some((row) => row.token === a.cookie.split('=')[1]),
    'the retired token must not still be in the table');
  return 'the presented cookie is retired on sign-in; the new token works and exactly one session remains';
});

/*
 * 2. AN EXPIRED SESSION IS REFUSED — already true, asserted so it stays true.
 */
check('2. an expired session is refused', async () => {
  const a = await account('exp');
  assert.equal((await call('GET', '/api/v1/account', { cookie: a.cookie })).status, 200, 'live to begin with');

  // Age the session by moving its expiry into the past, rather than sleeping for the TTL.
  await db.admin.query('UPDATE session SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1', [a.userId]);
  const after = await call('GET', '/api/v1/account', { cookie: a.cookie });
  assert.equal(after.status, 401, `an expired session must be refused, got ${after.status}`);
  return 'expiry is enforced on read, not merely recorded';
});

/*
 * 3. THE EXPIRY SWEEP — expired rows are REMOVED, not left to accumulate forever.
 *
 * Rejecting an expired session is not the same as getting rid of it. Every sign-in leaves a row, nothing
 * ever deletes the expired ones, and on a real installation the table grows without bound — which is both a
 * storage leak and a privacy one, since the rows outlive the sessions they describe.
 */
check('3. the expiry sweep removes expired rows instead of letting them accumulate', async () => {
  const a = await account('sweep');
  // Three more sessions, all expired: the sweep must clear all of them.
  for (let i = 0; i < 3; i += 1) {
    await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  }
  const before = await sessionRows(a.userId);
  assert.ok(before.length >= 4, `the fixture needs several sessions, got ${before.length}`);
  await db.admin.query('UPDATE session SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1', [a.userId]);

  // The sweep runs as part of ordinary use: no scheduler, no operator step to forget.
  const fresh = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(fresh.status, 200, fresh.text.slice(0, 120));
  const after = await sessionRows(a.userId);
  assert.equal(after.length, 1, `only the new session may remain, got ${after.length}`);
  return `${before.length} expired row(s) swept by the next sign-in; exactly the new session remains`;
});

/*
 * 4. REVOKE ONE SESSION — a learner who sees a session they do not recognise can end it, and only it.
 *
 * Without this, "sign out" is the only power a learner has, and it requires already holding the session you
 * want to kill — which is no help against a session someone else created.
 */
check('4. a learner can list their sessions and revoke exactly one', async () => {
  const a = await account('revoke');
  // A second device.
  const second = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(second.status, 200, second.text.slice(0, 120));

  const listed = await call('GET', '/api/v1/sessions', { cookie: a.cookie });
  assert.equal(listed.status, 200, `listing sessions: ${listed.status} ${listed.text.slice(0, 120)}`);
  const sessions = listed.json.sessions;
  assert.equal(sessions.length, 2, `two sessions, got ${sessions.length}`);
  assert.equal(sessions.filter((s) => s.current).length, 1, 'exactly one is marked as the current session');
  for (const session of sessions) {
    assert.ok(typeof session.id === 'string' && session.id.length > 0, 'each session has an id');
    assert.ok(session.expires_at, 'and its expiry');
    assert.ok(String(session.token || '') === '', 'THE TOKEN ITSELF MUST NEVER BE SERVED: a session id is enough to revoke it');
  }

  const other = sessions.find((s) => !s.current);
  const revoked = await call('DELETE', `/api/v1/sessions/${other.id}`, { cookie: a.cookie });
  assert.equal(revoked.status, 200, `revoking another session: ${revoked.status} ${revoked.text.slice(0, 120)}`);

  // The other device is out; the acting device is untouched.
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 401,
    'the revoked session must be refused');
  assert.equal((await call('GET', '/api/v1/account', { cookie: a.cookie })).status, 200,
    'revoking another session must not sign the acting one out');

  // A session id that is not yours is NOT FOUND, not "revoked": ids must not be an oracle for other accounts.
  const foreign = await call('DELETE', `/api/v1/sessions/${'00000000-0000-4000-8000-000000000000'}`, { cookie: a.cookie });
  assert.equal(foreign.status, 404, `an unknown/foreign session id must be 404, got ${foreign.status}`);
  return 'two sessions listed with ids and no tokens; revoking the other leaves the acting session alive; a foreign id is 404';
});

/*
 * 5. REVOKE ALL ON PASSWORD CHANGE — the reason a password change is worth anything.
 *
 * If a learner changes their password because they believe someone else has it, and the intruder's session
 * keeps working, the change achieved nothing. So the change ends every OTHER session AND rotates the acting
 * one; the acting device stays signed in with a NEW token, and every old token is dead.
 */
check('5. changing the password revokes every other session and rotates the acting one', async () => {
  const a = await account('pw');
  const second = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(second.status, 200, second.text.slice(0, 120));
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 200, 'the second device works');

  const changed = await call('PUT', '/api/v1/account/password', {
    cookie: a.cookie, body: { currentPassword: a.password, newPassword: 'a-better-synthetic-pw-2' },
  });
  assert.equal(changed.status, 200, `changing the password: ${changed.status} ${changed.text.slice(0, 160)}`);

  // Every pre-change token is dead — the second device's and the acting device's own.
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 401,
    'the other device must be signed out by the password change');
  assert.equal((await call('GET', '/api/v1/account', { cookie: a.cookie })).status, 401,
    'the acting session is rotated too, so its old token is dead');

  // The acting device stays signed in with the token the change issued.
  assert.ok(changed.setCookie && changed.setCookie !== a.cookie, 'the change must issue a new acting token');
  assert.equal((await call('GET', '/api/v1/account', { cookie: changed.setCookie })).status, 200,
    'the acting device stays signed in on the rotated token');
  assert.equal((await sessionRows(a.userId)).length, 1, 'exactly one session survives a password change');

  // The new password works and the old one does not.
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } })).status, 401,
    'the old password must be refused');
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: 'a-better-synthetic-pw-2' } })).status, 200,
    'the new password must work');
  return 'every other session 401, the acting token rotated, one session left, old password refused';
});

/*
 * 6. A REFUSED CHANGE CHANGES NOTHING — the failure path is where security changes usually leak.
 */
check('6. a wrong current password or a refused new one changes nothing', async () => {
  const a = await account('pwno');
  const second = await secondDevice(a);
  const before = (await sessionRows(a.userId)).length;

  const wrong = await call('PUT', '/api/v1/account/password', {
    cookie: a.cookie, body: { currentPassword: 'not-the-password', newPassword: 'a-better-synthetic-pw-2' },
  });
  assert.equal(wrong.status, 403, `a wrong current password must be refused with 403, got ${wrong.status}`);
  assert.equal((await sessionRows(a.userId)).length, before, 'a refused change must not revoke anything');
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 200,
    'and the other device must still be signed in');
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } })).status, 200,
    'and the password must be unchanged');

  /*
   * AND A NEW PASSWORD THAT FAILS THE RULE. The rule is deliberately the SAME one sign-up applies
   * (non-empty, at most 256 characters): a minimum LENGTH is a policy decision belonging with D5's human
   * signoff on hashing parameters, and enforcing here a rule that registration does not would lock a learner
   * out of their own account. So this leg asserts the shared rule rather than an invented policy.
   */
  for (const [what, newPassword] of [['empty', ''], ['over-long', 'x'.repeat(300)]]) {
    /*
     * COUNTED FRESH EACH TIME, because the assertion above SIGNED IN to prove the password is unchanged — and
     * a sign-in legitimately creates a session. Holding the earlier count here would have failed on my own
     * evidence-gathering rather than on a revoked session.
     */
    const live = (await sessionRows(a.userId)).length;
    const refused = await call('PUT', '/api/v1/account/password', {
      cookie: a.cookie, body: { currentPassword: a.password, newPassword },
    });
    assert.equal(refused.status, 422, `a ${what} new password must be refused with 422, got ${refused.status}`);
    assert.equal((await sessionRows(a.userId)).length, live, `a refused change (${what}) must not revoke anything`);
  }
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 200,
    'and the other device must still be signed in');
  return `wrong current password 403, empty and over-long new passwords 422; ${before} session(s) untouched`;
});

/* ==================================================================== run */

async function run() {
  const only = process.argv.find((a) => a.startsWith('--only='));
  if (process.argv.includes('--list')) {
    for (const leg of legs) console.log(leg.name);
    return 0;
  }
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
