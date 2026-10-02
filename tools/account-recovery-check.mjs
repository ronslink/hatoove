/*
 * ACCOUNT RECOVERY — D6's token path, and the security properties it has to have.
 *
 * The recommendation is **operator-assisted resets for the pilot; wire the token path now**: build
 * `POST /api/auth/request-password-reset` + `POST /api/auth/reset-password` writing tokens to the
 * `verification` table, with the DELIVERY STEP BEHIND ONE MODULE (`server/notify.mjs`) whose pilot
 * implementation logs the link to the operator console. Adopting a provider later is then one file.
 *
 * THE PROPERTY THIS CHECK EXISTS FOR: **the requester must never receive the token.**
 *
 * That is not a detail. Anyone can type someone else's email address into a reset form. If the response — or
 * any response to that request — carried the token, then "I forgot my password" would be "I can take over any
 * account whose email address I know". The token goes to the OPERATOR CONSOLE and nowhere else; that is
 * exactly what "operator-assisted" means, and it is why the pilot can ship recovery without an email provider
 * and without being a hole.
 *
 * The rest is what makes the token worth having rather than a second password in the clear:
 *   * stored HASHED, so a read of the `verification` table does not hand over working links;
 *   * SINGLE USE, because a link that keeps working keeps working for whoever found it;
 *   * TIME-BOUNDED, because a link in a support ticket should not be valid next year;
 *   * BOUND TO THE ACCOUNT, so account A's link cannot change account B's password;
 *   * and a successful reset ENDS EVERY SESSION, for the same reason a password change does: if someone else
 *     had the password, leaving their session alive means the reset achieved nothing.
 *
 * Usage:
 *   node tools/account-recovery-check.mjs          (needs a disposable DB; OWNAPI_PG_*)
 *   node tools/account-recovery-check.mjs --list
 */

import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createNotifier } from '../server/notify.mjs';

/* =============================================================== the world */

const db = await createFixture();

/**
 * WHAT THE OPERATOR SAW, collected instead of printed.
 *
 * The DELIVERY half is the test's; the LINK-BUILDING half is the PRODUCT's, through the same `createNotifier`
 * the console channel uses. Building the link here instead would let this check pass while the shipped channel
 * produced something else — which is exactly the bug the real-stack leg found, where the port built a link
 * from an origin the running server never supplied and the log line had no origin at all.
 *
 * The port hands over `{to, kind, token, expiresAt}` and learns nothing about how or where it travels.
 */
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
const nextEmail = () => `recovery-${Date.now()}-${(counter += 1)}@example.invalid`;

async function account(tag = 'a') {
  await db.admin.query('DELETE FROM auth_throttle WHERE bucket = $1', ['signup:global']);
  const email = nextEmail();
  const password = `pw-${tag}-synthetic`;
  const created = await call('POST', '/api/auth/sign-up/email', { body: { name: `L ${tag}`, email, password } });
  assert.equal(created.status, 200, `sign-up ${tag}: ${created.status} ${created.text.slice(0, 120)}`);
  const userId = (await one('SELECT id FROM "user" WHERE email = $1', [email])).id;
  return { email, password, userId, cookie: created.setCookie };
}

/** Request a reset and return the operator's message, if any — the ONLY legitimate route to the token. */
async function requestReset(email) {
  const before = delivered.length;
  const res = await call('POST', '/api/auth/request-password-reset', { body: { email } });
  const message = delivered.slice(before)[0] || null;
  return { res, message };
}

/** Pull the token out of a delivered link, exactly as an operator reading the log would. */
const tokenOf = (message) => {
  const link = message && (message.link || message.url);
  if (!link) return null;
  const match = /[?&]token=([^&\s]+)/.exec(String(link));
  return match ? decodeURIComponent(match[1]) : null;
};

/* ================================================================== legs */

const legs = [];
const check = (name, fn) => legs.push({ name, fn });
const failures = [];
let passed = 0;

/*
 * 1. THE REQUEST ANSWERS THE SAME THING FOR EVERY ADDRESS, and contains no token.
 */
check('1. requesting a reset answers identically for known and unknown addresses, with no token', async () => {
  const a = await account('same');
  const known = await requestReset(a.email);
  const unknown = await requestReset(nextEmail());

  assert.equal(known.res.status, 200, `a reset request answers 200, got ${known.res.status}`);
  assert.equal(unknown.res.status, 200, 'an UNKNOWN address must also answer 200, or the form enumerates accounts');
  assert.deepEqual(known.res.json, unknown.res.json, 'and the two responses must be identical');
  assert.ok(!/token/i.test(known.res.text), `THE RESPONSE MUST NOT MENTION A TOKEN: ${known.res.text.slice(0, 160)}`);
  return `both answered ${known.res.status} ${JSON.stringify(known.res.json)}`;
});

/*
 * 2. THE TOKEN REACHES THE OPERATOR AND NOT THE REQUESTER — the property that makes this safe without email.
 */
check('2. the reset link is delivered to the operator only', async () => {
  const a = await account('notify');
  const { res, message } = await requestReset(a.email);
  assert.equal(res.status, 200);
  assert.ok(message, 'the notifier must receive a message: the operator is the delivery channel in the pilot');
  assert.equal(message.to, a.email, 'addressed to the account that asked');
  assert.equal(message.kind, 'password-reset', 'and marked with what it is');
  assert.ok(tokenOf(message), `the link must carry a token: ${JSON.stringify(message).slice(0, 200)}`);
  assert.ok(!res.text.includes(tokenOf(message)), 'and that token must NOT appear in the HTTP response');

  // A reset for an unknown address delivers nothing at all: there is no account to recover, and sending a
  // link would turn the form into a way to probe which addresses exist.
  const before = delivered.length;
  await call('POST', '/api/auth/request-password-reset', { body: { email: nextEmail() } });
  assert.equal(delivered.length, before, 'no message may be produced for an address that has no account');
  return `link delivered for the real account, nothing for the unknown one, nothing in the response`;
});

/*
 * 3. THE TOKEN IS STORED HASHED.
 */
check('3. the stored token is a hash, not the link itself', async () => {
  const a = await account('hashed');
  const { message } = await requestReset(a.email);
  const token = tokenOf(message);
  const rows = await all('SELECT identifier, value FROM verification WHERE identifier LIKE $1', [`%${a.email}`]);
  assert.equal(rows.length, 1, `exactly one verification row, got ${rows.length}`);
  assert.notEqual(rows[0].value, token, 'the stored value must not BE the token: a table read would hand over working links');
  assert.ok(rows[0].value.length >= 32, `the stored value must be a hash, got ${rows[0].value.length} chars`);
  return `stored ${rows[0].value.slice(0, 12)}… (${rows[0].value.length} chars) for a ${token.length}-char token`;
});

/*
 * 4. THE TOKEN WORKS ONCE, AND THE NEW PASSWORD IS THE ONE THAT WORKS.
 */
check('4. a valid token changes the password once and not twice', async () => {
  const a = await account('once');
  const { message } = await requestReset(a.email);
  const token = tokenOf(message);

  const done = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'pw-reset-synthetic-1' } });
  assert.equal(done.status, 200, `a valid token resets the password, got ${done.status} ${done.text.slice(0, 120)}`);

  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } })).status, 401,
    'the old password must be refused');
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: 'pw-reset-synthetic-1' } })).status, 200,
    'and the new one must work');

  const again = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'pw-reset-synthetic-2' } });
  assert.equal(again.status, 400, `a consumed token must be refused, got ${again.status}`);
  assert.equal((await all('SELECT id FROM verification WHERE identifier LIKE $1', [`%${a.email}`])).length, 0,
    'and the row is gone rather than merely unusable');
  return 'reset worked, the old password stopped working, the token cannot be replayed, the row is deleted';
});

/*
 * 5. AN EXPIRED TOKEN IS REFUSED, and refused without saying anything useful to a guesser.
 */
check('5. an expired token is refused', async () => {
  const a = await account('expired');
  const { message } = await requestReset(a.email);
  const token = tokenOf(message);
  await db.admin.query('UPDATE verification SET "expiresAt" = now() - interval \'1 minute\' WHERE identifier LIKE $1', [`%${a.email}`]);
  const res = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'pw-reset-synthetic-3' } });
  assert.equal(res.status, 400, `an expired token must be refused, got ${res.status}`);
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } })).status, 200,
    'and the password must be unchanged');
  return 'expired token refused, password untouched';
});

/*
 * 6. A RESET ENDS EVERY SESSION — the whole reason the flow exists.
 *
 * A learner resets because they believe someone else has their password. If the intruder's session survives,
 * the reset achieved nothing.
 */
check('6. a completed reset ends every session', async () => {
  const a = await account('sessions');
  const second = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(second.status, 200, 'a second device is signed in');
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 200, 'and working');

  const { message } = await requestReset(a.email);
  const done = await call('POST', '/api/auth/reset-password', { body: { token: tokenOf(message), newPassword: 'pw-reset-synthetic-4' } });
  assert.equal(done.status, 200, done.text.slice(0, 120));
  assert.equal((await call('GET', '/api/v1/account', { cookie: second.setCookie })).status, 401,
    'the other session must be ended by the reset');
  assert.equal((await call('GET', '/api/v1/account', { cookie: a.cookie })).status, 401,
    'and so must the session that asked, since the password it was authenticated against is gone');
  assert.equal((await all('SELECT id FROM session WHERE "userId" = $1', [a.userId])).length, 0,
    'no session may survive a password reset');
  return 'every session ended by the reset';
});

/*
 * 7. THE TOKEN IS BOUND TO ONE ACCOUNT: A's link cannot change B's password.
 */
check('7. one account\'s token cannot change another account\'s password', async () => {
  const a = await account('bound-a');
  const b = await account('bound-b');
  const { message } = await requestReset(a.email);
  const token = tokenOf(message);

  /*
   * The token carries no account id, BY DESIGN: the row's `identifier` is the address and the token is only a
   * secret. So the honest test is that B's password is untouched by redeeming a token that was minted for A —
   * whichever way the implementation resolves a token to an account, it must resolve A's.
   */
  const done = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'pw-reset-synthetic-5' } });
  assert.equal(done.status, 200, `A's token must reset A, got ${done.status}`);
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: b.email, password: b.password } })).status, 200,
    "B's password must be untouched");
  assert.equal((await call('POST', '/api/auth/sign-in/email', { body: { email: b.email, password: 'pw-reset-synthetic-5' } })).status, 401,
    "and B must not accept A's new password");
  return "A's token reset A and left B alone";
});

/*
 * 8. UNUSABLE TOKENS ARE REFUSED, WITH THE TWO KINDS DISTINGUISHED.
 *
 * The first version of this leg expected 400 for everything and failed on the empty string, which is the check
 * being under-specified rather than the product being wrong — the same shape this project has met before. The
 * contract is worth stating precisely because the two cases are genuinely different:
 *
 *   * MALFORMED — absent, empty, not a string, absurdly long: nothing was looked up, so it is a field
 *     validation refusal (422), exactly as every other field in this API behaves.
 *   * UNRESOLVABLE — a plausible token that matches no live row: the request was well formed, so it is 400.
 *
 * Both say `invalid_token` and nothing more: a guesser learns nothing from which one they get, and there is
 * nothing useful to tell them.
 */
check('8. an unusable token is refused, and malformed is distinguished from unresolvable', async () => {
  const malformed = [
    ['an empty string', ''],
    ['a number', 42],
    ['a null', null],
    ['an absurdly long string', 'x'.repeat(600)],
  ];
  for (const [what, token] of malformed) {
    const res = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'pw-reset-synthetic-6' } });
    assert.equal(res.status, 422, `${what} is a malformed request and must be 422, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_token', `${what}: the code`);
  }

  const unresolvable = ['nonsense-nonsense-nonsense', '../../etc/passwd-not-a-token', 'x'.repeat(64)];
  for (const token of unresolvable) {
    const res = await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'pw-reset-synthetic-6' } });
    assert.equal(res.status, 400, `${JSON.stringify(token.slice(0, 20))} resolves to nothing and must be 400, got ${res.status}`);
    assert.equal(res.json.error, 'invalid_token', 'the same code as every other failure');
  }
  return `${malformed.length} malformed refused with 422, ${unresolvable.length} unresolvable with 400`;
});

/*
 * 9. THE OLDER ROUTE NAME IS THE SAME ROUTE.
 *
 * The queue's original measurement recorded `forget-password` as 404, and `request-password-reset` is the name
 * the current library and its documentation use. Both are real, so both are served — and this leg asserts they
 * are the SAME operation rather than two implementations that can drift: one message each, both 200, both with
 * the same shape.
 */
check('9. forget-password is the same operation as request-password-reset', async () => {
  const a = await account('alias');
  const newer = await requestReset(a.email);
  assert.equal(newer.res.status, 200, newer.res.text.slice(0, 120));
  assert.ok(newer.message, 'the current name works');

  const before = delivered.length;
  const older = await call('POST', '/api/auth/forget-password', { body: { email: a.email } });
  assert.equal(older.status, 200, `the older name must not be a 404: ${older.status}`);
  assert.deepEqual(older.json, newer.res.json, 'and it must answer the same');
  assert.equal(delivered.length, before + 1, 'and produce exactly one operator message, not two');

  // The unknown-address behaviour is identical on both names, so neither is an enumeration oracle.
  const unknownNew = await call('POST', '/api/auth/request-password-reset', { body: { email: nextEmail() } });
  const unknownOld = await call('POST', '/api/auth/forget-password', { body: { email: nextEmail() } });
  assert.deepEqual(unknownOld.json, unknownNew.json, 'and both answer an unknown address identically');
  return 'forget-password and request-password-reset are one operation under two documented names';
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
