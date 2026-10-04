#!/usr/bin/env node
/*
 * PILOT ACCESS — the account-request queue, against real PostgreSQL.
 *
 * WHAT THIS PROVES, and each leg is here because the offline suite cannot see it:
 *
 *   1. The migration CREATES the table (a forward migration from `0040` to `0041` on a fixture built
 *      before it), and the ledger records exactly that one file.
 *   2. The HTTP route stores the row: the address as the FOLDED form the queue is keyed on, the consent
 *      version the server ships, the language the sender chose.
 *   3. A duplicate submission writes nothing, changes nothing, and is byte-identical to the first answer.
 *   4. A refused submission stores nothing (unknown field, missing consent, malformed address).
 *   5. The operator command — the REAL `runAccessCommand`, not a re-implementation — lists, declines and
 *      purges the queue, and its refusals are refusals (a named address that is not there is not a success).
 *   6. `tools/table-class-check.mjs` classifies `account_request` as auth support: RLS off, the auth role
 *      only, no owner column. If a later change makes it account data, THAT check is what fails.
 *   7. The role boundary is real: auth reads and writes, and learner/worker/deletion/payments cannot.
 *   8. The rate-limit buckets for this route really limit, the sweep cannot cut a 24-hour window short, and
 *      a keep bound shorter than the window is refused outright.
 *
 * SYNTHETIC ONLY: no provider call, no mail, no live resource, and every row is created here in a random
 * `ownapi_<hex>` schema that `cleanup()` drops.
 *
 * Usage (a DISPOSABLE database; the guard below refuses the learner ports):
 *   OWNAPI_PG_ALLOW=1 OWNAPI_PG_HOST=127.0.0.1 OWNAPI_PG_PORT=5432 OWNAPI_PG_DATABASE=<scratch> \
 *     node tools/pilot-access-pg-check.mjs
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresThrottle, THROTTLE_POLICY, throttleKeepSeconds, longestWindowSeconds, SUPERSEDED_KEEP_SECONDS } from '../server/owned-postgres/throttle.mjs';
import { runAccessCommand, parseAccessArgs, AccessUsageError, USAGE } from '../server/access.mjs';
import { runTableClassCheck } from './table-class-check.mjs';
import { ACCESS_REQUEST_CONSENT_VERSION } from '../server/owned-api.mjs';

const env = process.env;
if (env.OWNAPI_PG_ALLOW !== '1' || env.OWNAPI_PG_HOST !== '127.0.0.1' || !env.OWNAPI_PG_PORT
  || [4300, 55440].includes(Number(env.OWNAPI_PG_PORT))) {
  throw Error('Explicit disposable OWNAPI_PG_ALLOW=1 and OWNAPI_PG_PORT required; learner ports forbidden.');
}

let db, world, smallWorld, observer, passed = 0;
const check = async (name, work) => { await work(); passed += 1; console.log(`PASS ${name}`); };
const sql = (query, args = []) => db.admin.query(query, args);
const rowCount = async () => Number((await sql('SELECT count(*)::int AS n FROM account_request')).rows[0].n);
const tableExists = async () => (await sql("SELECT to_regclass($1) AS name", [`${db.schema}.account_request`])).rows[0].name !== null;
const counter = { n: 0 };
const nextEmail = (tag) => `request-${tag}-${randomUUID()}@example.invalid`;

/** The real HTTP route through the real API, with no session and no cookie: this is a public route. */
async function call(path, body, method = 'POST') {
  const response = await world.api.handle({
    method, path, originChecked: true,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = JSON.parse(response.body); } catch { /* a non-JSON answer is reported as-is */ }
  return { status: response.status, body: response.body, json, headers: response.headers };
}

/** The operator command, driven through its real entry point with the port this installation built. */
async function operator(argv, port = world.accountRequests) {
  const lines = [];
  const errors = [];
  const code = await runAccessCommand(argv, { requests: port, log: (line) => lines.push(String(line)), error: (line) => errors.push(String(line)) });
  return { code, lines, errors, out: lines.join('\n'), err: errors.join('\n') };
}

try {
  db = await createFixture({ stopBefore: '0041-' });
  const pg = createRequire(new URL('../server/owned-postgres/bootstrap.mjs', import.meta.url))('pg');
  observer = new pg.Pool({ ...db.config, max: 1 });
  world = await createPostgresWorld({ fixture: db });
  /*
   * A SECOND WORLD WITH A SMALL POLICY, for the rate-limit legs. The shipped budgets are 50/day globally
   * and 3/day per address, and spending 50 real requests to see a 429 would make this check slow for no
   * extra certainty: the limit's SIZE is the product's, and the mechanism is what is under test here.
   */
  smallWorld = await createPostgresWorld({ fixture: db, limits: {
    accessRequest: { limit: 2, windowSeconds: 86400 },
    accessRequestEmail: { limit: 1, windowSeconds: 86400 },
  } });
  console.log(`Fixture ${db.schema}`);

  await check('forward migration creates only the account-request table, recorded as 0041', async () => {
    assert.equal(await tableExists(), false, 'the table must not exist before 0041 is applied');
    assert.deepEqual(await db.applyRemaining(), ['0041-pilot-access.sql']);
    assert.equal(await tableExists(), true);
    const columns = (await sql(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'account_request' ORDER BY column_name`, [db.schema])).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['consent_version', 'created_at', 'email', 'handled_at', 'id', 'language', 'name', 'status']);
    // THE DATABASE STATES THE NORMALISATION RULE ITSELF, so a future writer that forgets to fold the
    // address fails here rather than filing a second row for the same person.
    await assert.rejects(sql('INSERT INTO account_request(email, name, language, consent_version) VALUES($1,$2,$3,$4)',
      ['Mixed@Example.invalid', 'Anna', 'de', 'x']), (error) => error.code === '23514');
    await assert.rejects(sql('INSERT INTO account_request(email, name, language, consent_version) VALUES($1,$2,$3,$4)',
      ['ok@example.invalid', 'Anna', 'fr', 'x']), (error) => error.code === '23514');
    await assert.rejects(sql('INSERT INTO account_request(email, name, language, consent_version) VALUES($1,$2,$3,$4)',
      ['ok2@example.invalid', '   ', 'de', 'x']), (error) => error.code === '23514');
    assert.equal(await rowCount(), 0);
  });

  const firstEmail = nextEmail('stored');
  await check('the public route stores the folded address, the language and the shipped consent version', async () => {
    const answer = await call('/api/auth/request-access', { name: '  Anna Beispiel ', email: firstEmail.toUpperCase(), language: 'uk', consent: true });
    assert.equal(answer.status, 202, `${answer.status} ${answer.body}`);
    assert.equal(answer.body, '{"ok":true}');
    const rows = (await sql('SELECT * FROM account_request')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, firstEmail.toLowerCase(), 'the queue is keyed on the folded address');
    assert.equal(rows[0].name, 'Anna Beispiel', 'the name is stored trimmed');
    assert.equal(rows[0].language, 'uk');
    assert.equal(rows[0].consent_version, ACCESS_REQUEST_CONSENT_VERSION);
    assert.equal(rows[0].status, 'open');
    assert.equal(rows[0].handled_at, null);
    assert.ok(rows[0].created_at instanceof Date);
  });

  await check('a duplicate submission writes nothing, changes nothing and answers byte-for-byte the same', async () => {
    const before = (await sql('SELECT * FROM account_request')).rows;
    const again = await call('/api/auth/request-access', { name: 'Someone Else', email: firstEmail, language: 'tr', consent: true });
    assert.equal(again.status, 202);
    assert.equal(again.body, '{"ok":true}', 'a duplicate must not be distinguishable in the response');
    const after = (await sql('SELECT * FROM account_request')).rows;
    assert.equal(after.length, 1, 'a duplicate must not create a second row');
    assert.deepEqual(after, before, 'the first request is left exactly as it was, created_at included');
  });

  const refusedEmail = nextEmail('refused');
  await check('refused submissions store nothing and name what was wrong', async () => {
    const before = await rowCount();
    const cases = [
      [{ name: 'Anna', email: refusedEmail, language: 'de', consent: false }, 'invalid_consent'],
      [{ name: 'Anna', email: refusedEmail, language: 'de' }, 'invalid_consent'],
      [{ name: 'Anna', email: refusedEmail, language: 'de', consent: true, note: 'free text' }, 'unknown_field'],
      [{ name: 'Anna', email: 'not-an-address', language: 'de', consent: true }, 'invalid_email'],
      [{ name: '', email: refusedEmail, language: 'de', consent: true }, 'invalid_name'],
      [{ name: 'Anna', email: refusedEmail, language: 'fr', consent: true }, 'invalid_language'],
    ];
    for (const [payload, code] of cases) {
      const answer = await call('/api/auth/request-access', payload);
      assert.equal(answer.status, 422, `${JSON.stringify(payload)} -> ${answer.status}`);
      assert.equal(answer.json.error, code);
    }
    assert.equal(await rowCount(), before, 'a refused request leaves no row');
    assert.equal((await call('/api/auth/request-access', {}, 'GET')).status, 404, 'this route never reads');
  });

  await check('the operator command lists, declines and purges the real queue', async () => {
    const listed = await operator(['list']);
    assert.equal(listed.code, 0);
    assert.match(listed.out, new RegExp(firstEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(listed.out, /consent:pilot-/);
    const open = await operator(['list', '--status=open']);
    assert.match(open.out, /1 account request\(s\) \(open\)/);
    const invited = await operator(['list', '--status', 'invited']);
    assert.equal(invited.out, 'no invited account requests');

    // The lookup folds what the operator types, so the address can be typed as they know it.
    const declined = await operator(['decline', firstEmail.toUpperCase()]);
    assert.equal(declined.code, 0, declined.err);
    assert.match(declined.out, /^declined /);
    const row = (await sql('SELECT * FROM account_request WHERE email = $1', [firstEmail.toLowerCase()])).rows[0];
    assert.equal(row.status, 'declined');
    assert.ok(row.handled_at instanceof Date, 'declining records when it happened');
    // ALREADY HANDLED AND NEVER THERE ARE DIFFERENT ANSWERS: saying "done" for both is how a typo becomes a
    // silent no-op somebody believes they performed.
    const twice = await operator(['decline', firstEmail]);
    assert.equal(twice.code, 1);
    assert.match(twice.err, /already handled/);
    const absent = await operator(['decline', nextEmail('absent')]);
    assert.equal(absent.code, 1);
    assert.match(absent.err, /no request for/);

    const purged = await operator(['purge', '--email', firstEmail]);
    assert.equal(purged.code, 0, purged.err);
    assert.equal(await rowCount(), 0);
    const purgedAgain = await operator(['purge', '--email', firstEmail]);
    assert.equal(purgedAgain.code, 1, 'purging an address that is not there is not a success');
    assert.match(purgedAgain.out, /removed 0 request\(s\)/);
  });

  await check('the retention sweep removes only what is older than the named age', async () => {
    const old = nextEmail('old');
    const fresh = nextEmail('fresh');
    await call('/api/auth/request-access', { name: 'Old', email: old, language: 'de', consent: true });
    await call('/api/auth/request-access', { name: 'Fresh', email: fresh, language: 'de', consent: true });
    // AGE THE ROW rather than waiting 30 days, the trick the throttle and session checks already use.
    await sql("UPDATE account_request SET created_at = now() - interval '40 days' WHERE email = $1", [old.toLowerCase()]);
    const swept = await operator(['purge', '--older-than', '30']);
    assert.equal(swept.code, 0, swept.err);
    assert.match(swept.out, /removed 1 request\(s\) older than 30 day\(s\)/);
    assert.deepEqual((await sql('SELECT email FROM account_request')).rows.map((r) => r.email), [fresh.toLowerCase()]);
    // ZERO DAYS WOULD MEAN "EVERYTHING, INCLUDING A REQUEST FROM A MINUTE AGO", which no operator means.
    for (const days of ['0', '-1', 'abc', '99999']) {
      assert.throws(() => parseAccessArgs(['purge', `--older-than=${days}`]), AccessUsageError);
    }
    assert.throws(() => parseAccessArgs(['purge']), AccessUsageError);
    assert.throws(() => parseAccessArgs(['purge', `--email=${fresh}`, '--older-than=30']), AccessUsageError);
    assert.throws(() => parseAccessArgs(['purge', `--email=${fresh}`, 'stray']), AccessUsageError);
    assert.throws(() => parseAccessArgs(['list', 'stray']), AccessUsageError);
    assert.throws(() => parseAccessArgs(['decline']), AccessUsageError);
    assert.throws(() => parseAccessArgs(['nonsense']), AccessUsageError);
    assert.throws(() => parseAccessArgs([]), AccessUsageError);
    const help = await operator(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.out, USAGE);
    // THE PORT REFUSES THE SAME AMBIGUITY AGAIN, so a caller that skips the parser still cannot delete by
    // accident, and it refuses a bare zero-day sweep.
    await assert.rejects(world.accountRequests.purge({ email: fresh, olderThanDays: 30 }), /exactly_one_selector/);
    await assert.rejects(world.accountRequests.purge({}), /exactly_one_selector/);
    await assert.rejects(world.accountRequests.purge({ olderThanDays: 0 }), /invalid_account_request_age/);
    assert.deepEqual(await world.accountRequests.purge({ email: fresh }), { removed: 1, emails: [fresh.toLowerCase()] });
    assert.equal(await rowCount(), 0);
  });

  await check('table-class-review classifies account_request as auth support and the class rules hold', async () => {
    const report = await runTableClassCheck({ db: db.admin, schema: db.schema, roles: db.roles });
    const row = report.rows.find((entry) => entry.table === 'account_request');
    assert.ok(row, 'the table must be classified, never unclassified');
    assert.equal(row.cls, 'auth support');
    assert.equal(row.verdict, 'OK', row.detail);
    // The detail names the ROLE, which is the point: whoever can read the queue is whoever runs the auth seam.
    assert.match(row.detail, new RegExp(`${db.roles.auth} only; no owner column`));
    assert.equal(report.ok, true, report.failures.map((failure) => `${failure.table}: ${failure.detail}`).join(' | '));
    // RLS OFF is the class rule (these rows belong to no owner, so a policy would have nothing to scope to).
    const flags = (await sql('SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = $1::regclass',
      [`${db.schema}.account_request`])).rows[0];
    assert.deepEqual(flags, { rls: false, force: false });
    const pub = (await sql(`SELECT count(*)::int AS n FROM information_schema.table_privileges
      WHERE table_schema = $1 AND table_name = 'account_request' AND grantee = 'PUBLIC'`, [db.schema])).rows[0].n;
    assert.equal(pub, 0, 'PUBLIC holds nothing');
  });

  await check('only the auth role may read or write the queue', async () => {
    for (const table of ['account_request']) {
      for (const pool of [db.learner, db.worker, db.deletion, db.payments]) {
        for (const statement of [`SELECT * FROM ${table}`, `INSERT INTO ${table}(email,name,language,consent_version) VALUES('x@example.invalid','x','de','x')`, `DELETE FROM ${table}`]) {
          await assert.rejects(pool.query(statement), (error) => error.code === '42501', `${statement} as another role`);
        }
      }
    }
    assert.equal(await rowCount(), 0);
    const stored = nextEmail('authrole');
    await world.accountRequests.submit({ name: 'Anna', email: stored.toLowerCase(), language: 'de', consentVersion: ACCESS_REQUEST_CONSENT_VERSION });
    assert.equal(await rowCount(), 1, 'the auth role can write');
    assert.deepEqual((await world.accountRequests.list()).map((row) => row.email), [stored.toLowerCase()]);
    await world.accountRequests.purge({ email: stored });
    assert.equal(await rowCount(), 0, 'and the queue can be emptied again');
  });

  await check('the request buckets limit on the shipped mechanism and a refused request writes nothing', async () => {
    // The small policy: 1 request per address and 2 in total, per day.
    const one = nextEmail('limit');
    const two = nextEmail('limit');
    /*
     * A CLEAN BUDGET, and this is not optional: the bucket KEYS are the same strings whatever policy is in
     * force, so the earlier legs (which ran the shipped limits) have already spent `accessRequest:global`.
     * Without this reset the first small-policy request would arrive at an exhausted bucket and answer 429
     * for a reason that has nothing to do with the leg. `persistentWorld` clears the signup bucket for
     * exactly this reason.
     */
    await smallWorld.throttle.clear('accessRequest', 'global');
    await smallWorld.throttle.clear('accessRequestEmail', one);
    await smallWorld.throttle.clear('accessRequestEmail', two);
    const first = await smallWorld.api.handle({ method: 'POST', path: '/api/auth/request-access', originChecked: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A', email: one, language: 'de', consent: true }) });
    assert.equal(first.status, 202);
    const perAddress = await smallWorld.api.handle({ method: 'POST', path: '/api/auth/request-access', originChecked: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A', email: one, language: 'de', consent: true }) });
    assert.equal(perAddress.status, 429, 'the per-address bucket is what stops one address filling the queue');
    assert.ok(Number(perAddress.headers['retry-after']) > 0, 'a refusal names when to come back');
    const global = await smallWorld.api.handle({ method: 'POST', path: '/api/auth/request-access', originChecked: true,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'B', email: two, language: 'de', consent: true }) });
    assert.equal(global.status, 429, 'the global daily budget is reached');
    // NOTHING WAS WRITTEN BY THE REFUSALS: exactly the one accepted request is in the queue.
    assert.deepEqual((await sql('SELECT email FROM account_request')).rows.map((row) => row.email), [one.toLowerCase()]);
  });

  await check('the sweep cannot cut a 24-hour window short, and a shorter keep bound is refused', async () => {
    // The bound is derived from the policy, so it is strictly longer than the longest window...
    assert.ok(throttleKeepSeconds(THROTTLE_POLICY) > longestWindowSeconds(THROTTLE_POLICY));
    assert.equal(world.throttle.keepSeconds, throttleKeepSeconds(THROTTLE_POLICY));
    // ...the superseded one-day constant is NOT, which is the regression this rule exists to catch...
    assert.equal(throttleKeepSeconds(THROTTLE_POLICY) > SUPERSEDED_KEEP_SECONDS, true);
    // ...and a caller cannot configure the cleanup into cutting a window short.
    assert.throws(() => createPostgresThrottle({ pool: db.auth, keepSeconds: SUPERSEDED_KEEP_SECONDS }), /throttle_keep_window_too_short/);

    /*
     * AND NOW THE BEHAVIOUR, ON THE REAL TABLE. A bucket INSIDE its 24-hour window must survive the sweep
     * and keep refusing; a bucket past both its window and the bound must be forgotten. Ageing the row is
     * the same technique the throttle and session checks use, so nothing waits 24 hours.
     */
    const bucket = `signin:${nextEmail('sweep')}`;
    await sql("INSERT INTO auth_throttle(bucket, window_started_at, attempts) VALUES($1, now() - interval '23 hours', 99)", [bucket]);
    await world.throttle.sweep();
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1', [bucket])).rows[0].n, 1,
      'a sweep must not delete a counter whose window is still open');
    await sql("UPDATE auth_throttle SET window_started_at = now() - interval '5 days' WHERE bucket = $1", [bucket]);
    await world.throttle.sweep();
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1', [bucket])).rows[0].n, 0,
      'a bucket past its window and the keep bound is removed');
  });
} finally {
  if (db) {
    const schema = db.schema;
    await db.cleanup();
    if (observer) {
      try {
        assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [schema])).rows[0].n, 0);
        assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY($1::text[])', [Object.values(db.roles)])).rows[0].n, 0);
        assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [schema])).rows[0].n, 0);
        console.log('Cleanup verified: exact fixture schema, roles and connections absent');
      } finally { await observer.end(); }
    }
  }
}
console.log(`${passed} pilot-access PostgreSQL checks passed`);
