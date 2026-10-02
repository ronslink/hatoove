/*
 * AUTH THROTTLE — the abuse gap PILOT-18 MEASURED.
 *
 * The queue's item 4 records the numbers, taken on 1 October 2026: **12 rapid registrations all accepted**
 * (no throttle), and **12 rapid failed sign-ins all 401, no 429**. The plan's instruction is "**Throttle
 * first** — it is what protects the operator's provider budget. Write the failing check, then the fix."
 * This is that check, written first.
 *
 * WHAT IS BEING PROTECTED, because a rate limit that is not tied to a resource becomes a way to lock people
 * out:
 *
 *   * THE ACCOUNT, from credential stuffing and from someone guessing one learner's password: a per-EMAIL
 *     failure counter on sign-in.
 *   * THE OPERATOR'S BUDGET, which is genuinely global: a cap on registrations per window. Every account
 *     costs a database row and a session; the pilot's promise is a working product for real learners, not a
 *     free bulk-registration endpoint.
 *   * THE PASSWORD ITSELF: the change route verifies a password, so without a limit it is a password oracle
 *     wearing a friendlier name.
 *
 * AND THE LEG THAT MATTERS MOST IS THE ONE ABOUT WHAT MUST **NOT** HAPPEN: failures against one account must
 * not block another. A single global counter for sign-in would let one attacker lock every learner out of the
 * product — a denial of service that a "security" feature introduced. Leg 2 exists to make that impossible
 * to do by accident.
 *
 * TIME IS MANIPULATED, NOT WAITED FOR: the window is aged in the database, exactly as the session-expiry leg
 * moves `expiresAt`, so the real limits are exercised and a 15-minute window does not become a 15-minute
 * check.
 *
 * Usage:
 *   node tools/auth-throttle-check.mjs          (needs a disposable DB; OWNAPI_PG_*)
 *   node tools/auth-throttle-check.mjs --list
 *   node tools/auth-throttle-check.mjs --only=lockout
 */

import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { THROTTLE_POLICY } from '../server/owned-postgres/throttle.mjs';

/* =============================================================== the world */

const db = await createFixture();
const world = await createPostgresWorld({ fixture: db });

function caller(api) {
  return async function call(method, path, { cookie = null, body = undefined, headers = {} } = {}) {
    const built = { ...headers, accept: 'application/json' };
    if (cookie) built.cookie = cookie;
    if (method !== 'GET') built['content-type'] = 'application/json';
    const response = await api.handle({
      method, path, headers: built, originChecked: true,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* not JSON */ }
    const raw = response.headers && (response.headers['set-cookie'] || response.headers['Set-Cookie']);
    return {
      status: response.status,
      json,
      retryAfter: response.headers && (response.headers['retry-after'] || response.headers['Retry-After']),
      setCookie: raw ? String(raw).split(';')[0] : cookie,
    };
  };
}

const call = caller(world.api);
const one = async (sql, params) => (await db.admin.query(sql, params)).rows[0];

let counter = 0;
const nextEmail = () => `throttle-${Date.now()}-${(counter += 1)}@example.invalid`;

/**
 * Forget the GLOBAL registration counter.
 *
 * The signup cap is global ON PURPOSE, which means every leg that creates an account spends from one shared
 * budget — and the first version of this file did not account for that: leg 5 asserted "one user row per
 * accepted registration" against a bucket the earlier legs had already part-spent, and legs 6 and 7 could not
 * sign up at all because leg 5 had exhausted it. A leg that fails because of ANOTHER leg's registrations is
 * measuring the shared resource, not the code. So the legs that need a clean budget say so explicitly.
 */
const resetSignup = () => db.admin.query('DELETE FROM auth_throttle WHERE bucket = $1', ['signup:global']);

async function account(tag = 'a') {
  await resetSignup();
  const email = nextEmail();
  const password = `pw-${tag}-synthetic`;
  const created = await call('POST', '/api/auth/sign-up/email', { body: { name: `L ${tag}`, email, password } });
  assert.equal(created.status, 200, `sign-up ${tag}: ${created.status} ${JSON.stringify(created.json)}`);
  const userId = (await one('SELECT id FROM "user" WHERE email = $1', [email])).id;
  return { email, password, userId, cookie: created.setCookie };
}

/** Sign in wrongly until refused, or until `max` attempts; returns the list of statuses. */
async function failSignIn(email, max = 15) {
  const statuses = [];
  for (let i = 0; i < max; i += 1) {
    const res = await call('POST', '/api/auth/sign-in/email', { body: { email, password: 'not-the-password' } });
    statuses.push(res.status);
    if (res.status === 429) return { statuses, res };
  }
  return { statuses, res: null };
}

/* ================================================================== legs */

const legs = [];
const check = (name, fn) => legs.push({ name, fn });
const failures = [];
let passed = 0;

/*
 * 1. REPEATED FAILED SIGN-INS ARE REFUSED WITH 429, after a bounded number of attempts.
 */
check('1. failed sign-ins against one account are throttled with 429', async () => {
  const a = await account('one');
  const { statuses, res } = await failSignIn(a.email);
  assert.ok(res, `a failed sign-in must eventually be refused; all ${statuses.length} attempts answered ${[...new Set(statuses)].join('/')}`);
  assert.equal(res.status, 429);
  assert.equal(res.json.error, 'too_many_requests', `a stable code, got ${JSON.stringify(res.json)}`);
  // The refusal has to say when to come back, or a client can only hammer harder.
  assert.ok(res.retryAfter && Number(res.retryAfter) > 0, `Retry-After must be present and positive, got ${res.retryAfter}`);
  const firstRefusal = statuses.indexOf(429) + 1;
  assert.ok(firstRefusal >= 2 && firstRefusal <= 12,
    `the limit must be a limit, not the first attempt (refused at attempt ${firstRefusal})`);
  return `${firstRefusal - 1} failed attempt(s) allowed, attempt ${firstRefusal} refused with 429 and Retry-After: ${res.retryAfter}`;
});

/*
 * 2. NO GLOBAL LOCKOUT — the leg that stops a "security" feature becoming a denial of service.
 *
 * One attacker hammering account A must not stop learner B from signing in. A single counter shared by every
 * account would do exactly that, and it would look like a feature working.
 */
check('2. throttling one account does not lock out another', async () => {
  const victim = await account('victim');
  const bystander = await account('bystander');
  const { res } = await failSignIn(victim.email);
  assert.ok(res && res.status === 429, 'the victim account is throttled');

  const ok = await call('POST', '/api/auth/sign-in/email', { body: { email: bystander.email, password: bystander.password } });
  assert.equal(ok.status, 200, `an unrelated account must still sign in, got ${ok.status} ${JSON.stringify(ok.json)}`);

  // And the victim's OWN correct password is refused while throttled — that is what throttling means, and it
  // is why the counter has to be per account rather than global.
  const victimCorrect = await call('POST', '/api/auth/sign-in/email', { body: { email: victim.email, password: victim.password } });
  assert.equal(victimCorrect.status, 429, 'the throttled account stays refused even with the right password');
  return 'the attacker is stopped, the bystander is unaffected, and the throttled account stays refused';
});

/*
 * 3. A SUCCESSFUL SIGN-IN CLEARS THE COUNT — otherwise a learner who mistypes twice and then succeeds is two
 *    failures closer to being locked out for the rest of the window.
 */
check('3. a successful sign-in clears that account\'s failure count', async () => {
  const a = await account('clear');
  for (let i = 0; i < 3; i += 1) {
    await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: 'wrong' } });
  }
  const before = await one('SELECT attempts FROM auth_throttle WHERE bucket = $1', [`signin:${a.email}`]);
  assert.ok(before && before.attempts >= 3, `the failures are recorded, got ${JSON.stringify(before)}`);

  const good = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(good.status, 200, `signing in correctly: ${good.status}`);
  const after = await one('SELECT attempts FROM auth_throttle WHERE bucket = $1', [`signin:${a.email}`]);
  assert.equal(after, undefined, `the counter must be cleared on success, still there: ${JSON.stringify(after)}`);
  return `3 failures recorded, then cleared by a correct password`;
});

/*
 * 4. THE WINDOW EXPIRES — a rate limit that never forgets is a permanent ban.
 */
check('4. the window expires and the account can try again', async () => {
  const a = await account('expire');
  const { res } = await failSignIn(a.email);
  assert.ok(res && res.status === 429, 'throttled to begin with');

  // AGE THE WINDOW rather than sleeping through it: the same trick the session-expiry leg uses.
  await db.admin.query('UPDATE auth_throttle SET window_started_at = now() - interval \'1 hour\' WHERE bucket = $1', [`signin:${a.email}`]);
  const again = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: 'not-the-password' } });
  assert.equal(again.status, 401, `after the window the answer is a normal refusal, got ${again.status}`);
  const ok = await call('POST', '/api/auth/sign-in/email', { body: { email: a.email, password: a.password } });
  assert.equal(ok.status, 200, 'and the right password works again');
  return 'the counter is bounded by its window, not permanent';
});

/*
 * 5. SIGN-UPS ARE CAPPED — the operator's budget, and the only genuinely global limit here.
 *
 * Every registration costs a row and a session. The cap is deliberately generous (it is not a per-learner
 * limit and must never read as one) but it must exist, and a refusal must create NOTHING.
 */
check('5. registrations are capped per window and a refused one creates nothing', async () => {
  // A CLEAN BUDGET: the cap is global, so this leg starts from zero rather than from whatever the earlier legs
  // happened to spend. The limit itself comes from the policy, never from a number copied into the check.
  await resetSignup();
  const limit = THROTTLE_POLICY.signup.limit;
  const before = Number((await one('SELECT count(*)::int AS n FROM "user"')).n);
  let accepted = 0;
  let refused = null;
  for (let i = 0; i < limit + 10 && !refused; i += 1) {
    const email = nextEmail();
    const res = await call('POST', '/api/auth/sign-up/email', { body: { name: `Bulk ${i}`, email, password: 'pw-bulk-synthetic' } });
    if (res.status === 429) refused = { res, email };
    else {
      assert.equal(res.status, 200, `attempt ${i + 1}: ${res.status} ${JSON.stringify(res.json)}`);
      accepted += 1;
    }
  }
  assert.ok(refused, `registrations must be capped; ${limit + 10} rapid sign-ups were all accepted`);
  assert.equal(refused.res.json.error, 'too_many_requests');
  assert.ok(refused.res.retryAfter && Number(refused.res.retryAfter) > 0, 'Retry-After must be present');
  assert.equal(accepted, limit, `exactly the policy's limit (${limit}) may be accepted, got ${accepted}`);

  // NOTHING WAS CREATED FOR THE REFUSED ONE: no user row, and the total is exactly the accepted count.
  assert.equal((await one('SELECT id FROM "user" WHERE email = $1', [refused.email])), undefined,
    'a refused registration must not leave a user row');
  assert.equal(Number((await one('SELECT count(*)::int AS n FROM "user"')).n), before + accepted,
    'exactly one user row per accepted registration, no more');
  return `${accepted} accepted (the policy limit), then 429 with Retry-After: ${refused.res.retryAfter}, and the refused one left no row`;
});

/*
 * 6. THE PASSWORD CHANGE IS THROTTLED TOO — it verifies a password, so it is an oracle without a limit.
 *    The throttle is checked BEFORE the password is verified, so a wrong guess costs an attempt either way.
 */
check('6. guessing the current password through the change route is throttled', async () => {
  const a = await account('oracle');
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await call('PUT', '/api/v1/account/password', {
      cookie: a.cookie, body: { currentPassword: `guess-${i}`, newPassword: 'pw-new-synthetic' },
    });
    statuses.push(res.status);
    if (res.status === 429) break;
  }
  assert.equal(statuses[statuses.length - 1], 429, `the oracle must be limited, got ${[...new Set(statuses)].join('/')}`);
  // AND THE REAL PASSWORD IS REFUSED WHILE THROTTLED: the limit runs before verification, so being throttled
  // cannot be turned into a way to keep testing passwords.
  const blocked = await call('PUT', '/api/v1/account/password', {
    cookie: a.cookie, body: { currentPassword: a.password, newPassword: 'pw-new-synthetic' },
  });
  assert.equal(blocked.status, 429, 'the correct password must also be refused while throttled');
  return `${statuses.length} guesses before 429; the correct password is refused too`;
});

/*
 * 7. THE THROTTLE DOES NOT REVEAL WHETHER AN ACCOUNT EXISTS.
 *
 * "429 for this address and 401 for that one" would let anyone enumerate which emails are registered.
 */
check('7. a throttled unknown account looks exactly like a throttled real one', async () => {
  const unknown = nextEmail();
  const known = await account('enumerate');
  await failSignIn(unknown);
  await failSignIn(known.email);
  const unknownRes = await call('POST', '/api/auth/sign-in/email', { body: { email: unknown, password: 'x' } });
  const knownRes = await call('POST', '/api/auth/sign-in/email', { body: { email: known.email, password: 'x' } });
  assert.equal(unknownRes.status, knownRes.status, `both must answer the same, got ${unknownRes.status} and ${knownRes.status}`);
  assert.deepEqual(unknownRes.json, knownRes.json, 'and with the same body');
  return `both ${unknownRes.status} ${JSON.stringify(unknownRes.json)}`;
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
