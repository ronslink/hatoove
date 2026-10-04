#!/usr/bin/env node
// Synthetic accounts in a guarded disposable database. No providers, mail or live resources.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture, rolePool } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresSessions } from '../server/owned-postgres/sessions.mjs';
import { createPostgresSettings } from '../server/owned-postgres/settings.mjs';

const env = process.env;
const local = env.OWNAPI_PG_PORT === '62563' && env.OWNAPI_PG_DATABASE === 'hatoove_spike';
const ci = env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.OWNAPI_PG_PORT === '5432' && env.OWNAPI_PG_DATABASE === 'hatoove_ci';
if (env.OWNAPI_PG_ALLOW !== '1' || env.OWNAPI_PG_HOST !== '127.0.0.1' || (!local && !ci)) throw Error('registration_language_fixture_refused');

let db, world, concurrentPool, observer, passed = 0;
const check = async (name, work) => { await work(); passed++; console.log('PASS ' + name); };
const sql = (query, args = []) => db.admin.query(query, args);
const credentials = () => ({ name: 'Synthetic locale', email: `locale-${randomUUID()}@example.invalid`, password: 'synthetic-locale-password' });
async function signup(language, sessions = world.sessions) {
  const fields = credentials();
  if (language !== undefined) fields.language = language;
  const result = await sessions.signUp(fields), cookie = String(result.setCookie).split(';')[0];
  const account = await sessions.getSession({ cookie });
  return { ...fields, cookie, id: account.userId };
}
async function call(method, path, body, cookie) {
  const response = await world.api.handle({ method, path, originChecked: true,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(response.body), cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
}
const fault = code => error => error?.code === code;
async function counts() {
  const tables = ['user', 'account', 'session', 'learner_settings', 'learner_preparation', 'entitlements'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await sql(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n])));
}
async function contention(owner, revision) {
  const blocker = await db.admin.connect();
  let promises;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))', [owner]);
    const settings = createPostgresSettings({ pool: concurrentPool });
    promises = Promise.allSettled([settings.write(owner, revision, { language: 'uk' }), settings.write(owner, revision, { language: 'tr' })]);
    let waiting = 0;
    for (let i = 0; i < 100; i++) {
      waiting = (await sql("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name = $1 AND usename = $2 AND wait_event_type = 'Lock' AND wait_event = 'advisory'", [db.schema, db.roles.learner])).rows[0].n;
      if (waiting === 2) break;
      await delay(20);
    }
    assert.equal(waiting, 2, 'both real connections wait behind the owner lock before reading');
    await blocker.query('COMMIT');
    const results = await promises;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const loser = results.find(result => result.status === 'rejected');
    assert.equal(loser.reason.code, 'settings_conflict');
    assert.equal(loser.reason.status, 409);
    const saved = await settings.read(owner);
    assert.equal(saved.revision, revision + 1);
    assert.deepEqual(results.find(result => result.status === 'fulfilled').value, saved);
    assert.ok(['uk', 'tr'].includes(saved.settings.language));
    return saved;
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    if (promises) await promises;
  }
}
try {
  db = await createFixture({ stopBefore: '0039-' });
  const pg = createRequire(new URL('../server/owned-postgres/bootstrap.mjs', import.meta.url))('pg');
  observer = new pg.Pool({ ...db.config, max: 1 });
  world = await createPostgresWorld({ fixture: db });
  concurrentPool = rolePool(db.config, db.schema, db.roles.learner, 3);
  console.log('Fixture ' + db.schema);
  const legacy = await signup(), missing = await signup();
  await world.settings.write(legacy.id, 0, { language: 'tr', theme: 'dark', dailyGoal: 37 });
  await sql("UPDATE learner_settings SET exam_date = '2026-12-03' WHERE user_id = $1", [legacy.id]);
  const prior = (await sql('SELECT * FROM learner_settings ORDER BY user_id')).rows;
  await check('forward migration leaves existing preferences and absent rows byte-for-byte unchanged', async () => {
    assert.deepEqual(await db.applyRemaining(), ['0039-registration-language.sql','0040-explanation-review.sql','0041-pilot-access.sql']);
    assert.deepEqual((await sql('SELECT * FROM learner_settings ORDER BY user_id')).rows, prior);
    assert.equal((await sql('SELECT count(*)::int n FROM learner_settings WHERE user_id = $1', [missing.id])).rows[0].n, 0);
  });
  const accounts = [];
  await check('HTTP signup atomically captures each of five languages at revision zero with unchanged response', async () => {
    for (const language of ['de', 'en', 'uk', 'ar', 'tr']) {
      await sql("DELETE FROM auth_throttle WHERE bucket = 'signup:global'");
      const fields = { ...credentials(), language };
      const response = await call('POST', '/api/auth/sign-up/email', fields);
      assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true });
      const owner = (await world.sessions.getSession({ cookie: response.cookie })).userId;
      const saved = await world.settings.read(owner);
      assert.equal(saved.revision, 0); assert.equal(saved.settings.language, language);
      assert.equal((await sql('SELECT count(*)::int n FROM learner_preparation WHERE owner_id = $1', [owner])).rows[0].n, 1);
      assert.equal((await sql('SELECT count(*)::int n FROM entitlements WHERE owner_id = $1', [owner])).rows[0].n, 1);
      accounts.push({ ...fields, id: owner, cookie: response.cookie });
    }
  });
  await check('omission keeps German defaults without a settings row or reused-connection language', async () => {
    for (let i = 0; i < 3; i++) {
      const owner = (await signup()).id;
      assert.equal((await world.settings.read(owner)).settings.language, 'de');
      assert.equal((await sql('SELECT count(*)::int n FROM learner_settings WHERE user_id = $1', [owner])).rows[0].n, 0);
    }
  });
  await check('invalid languages and injected ownership are refused before any account writes', async () => {
    const before = await counts();
    for (const language of ['fr', 'DE', 'en-US', '', null, 1, [], {}, 'ar\u0000']) {
      const response = await call('POST', '/api/auth/sign-up/email', { ...credentials(), language });
      assert.equal(response.status, 422); assert.equal(response.body.error, 'invalid_language');
      await assert.rejects(world.sessions.signUp({ ...credentials(), language }), fault('invalid_language'));
    }
    const response = await call('POST', '/api/auth/sign-up/email', { ...credentials(), language: 'en', ownerId: legacy.id });
    assert.equal(response.status, 422);
    assert.deepEqual(await counts(), before);
  });
  await check('both registration failure checkpoints roll back locale, identity, preparation, balance and session', async () => {
    for (const failStage of ['provisioned', 'session']) {
      const before = await counts();
      const sessions = createPostgresSessions({ pool: db.auth, adminPool: db.admin, allowance: 10,
        registrationHook: async stage => { if (stage === failStage) throw Error('synthetic_registration_failure'); } });
      await assert.rejects(signup('ar', sessions), /synthetic_registration_failure/);
      assert.deepEqual(await counts(), before);
    }
  });
  await check('duplicate signup and sign-in cannot replace the saved preference', async () => {
    const user = accounts[1], before = await counts();
    await assert.rejects(world.sessions.signUp({ ...user, language: 'de' }), fault('user_exists'));
    await world.sessions.signIn({ email: user.email, password: user.password, language: 'de' });
    assert.equal((await world.settings.read(user.id)).settings.language, 'en');
    const after = await counts(); assert.equal(after.user, before.user); assert.equal(after.learner_settings, before.learner_settings);
    assert.equal((await call('POST', '/api/auth/sign-in/email', { email: user.email, password: user.password, language: 'ar' })).status, 422);
  });
  await check('auth cannot read/write preferences, call initializer directly or attach another trigger', async () => {
    for (const query of ['SELECT * FROM learner_settings', 'UPDATE learner_settings SET language = \'de\'', 'SELECT initialize_registered_language()']) {
      await assert.rejects(db.auth.query(query), error => error.code === '42501');
    }
    const privileges = (await sql("SELECT has_table_privilege($1, $2, 'TRIGGER') allowed, has_function_privilege($1, $3, 'EXECUTE') callable", [db.roles.auth, `${db.schema}.user`, `${db.schema}.initialize_registered_language()`])).rows[0];
    assert.deepEqual(privileges, { allowed: false, callable: false });
    for (const role of [db.roles.learner, db.roles.worker, db.roles.deletion, db.roles.payments]) {
      assert.equal((await sql("SELECT has_function_privilege($1, $2, 'EXECUTE') allowed", [role, `${db.schema}.initialize_registered_language()`])).rows[0].allowed, false);
    }
  });
  await check('SQL initializer validates its scalar, binds exactly NEW.id and restores transaction owner', async () => {
    const client = await db.auth.connect();
    try {
      const inserted = `user-${randomUUID()}`;
      await client.query('BEGIN');
      await client.query("SELECT set_config('hatoove.owner_id', $1, true), set_config('hatoove.registration_language', 'uk', true)", [legacy.id]);
      await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Synthetic\',$2,false,now(),now())', [inserted, `${inserted}@example.invalid`]);
      assert.equal((await client.query("SELECT current_setting('hatoove.owner_id') owner")).rows[0].owner, legacy.id);
      await client.query('COMMIT');
      assert.equal((await world.settings.read(inserted)).settings.language, 'uk');
      assert.deepEqual((await sql('SELECT * FROM learner_settings WHERE user_id = $1', [legacy.id])).rows[0], prior[0]);
      const before = await counts();
      await client.query('BEGIN');
      await client.query("SELECT set_config('hatoove.registration_language', 'fr', true)");
      await assert.rejects(client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Synthetic\',$2,false,now(),now())', [`user-${randomUUID()}`, `${randomUUID()}@example.invalid`]), error => error.code === '23514');
      await client.query('ROLLBACK');
      assert.deepEqual(await counts(), before);
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  });
  await check('two missing-row CAS writers on real concurrent connections yield one commit and one conflict', async () => {
    await contention(missing.id, 0);
  });
  await check('existing-row CAS preserves unrelated theme, goal and historical exam date', async () => {
    const result = await contention(legacy.id, 1);
    assert.equal(result.settings.theme, 'dark'); assert.equal(result.settings.dailyGoal, 37); assert.equal(result.settings.examDate, '2026-12-03');
    assert.equal((await world.settings.read(accounts[1].id)).settings.language, 'en');
  });
  await check('session-owned settings reject unknown languages and cannot target another account', async () => {
    const user = accounts[3];
    const before = await world.settings.read(user.id);
    const bad = await call('PUT', '/api/v1/settings', { expectedRevision: 0, settings: { language: 'fr' } }, user.cookie);
    assert.equal(bad.status, 422);
    const forged = await call('PUT', '/api/v1/settings', { expectedRevision: 0, settings: { language: 'de' }, ownerId: legacy.id }, user.cookie);
    assert.equal(forged.status, 422); assert.deepEqual(await world.settings.read(user.id), before);
    const good = await call('PUT', '/api/v1/settings', { expectedRevision: 0, settings: { language: 'tr' } }, user.cookie);
    assert.equal(good.status, 200); assert.equal(good.body.settings.language, 'tr');
  });
  await check('account deletion removes initialized preference while another owner remains intact', async () => {
    const user = accounts[4];
    assert.equal((await world.deletion.deleteAccount(user.id)).verifiedAbsent, true);
    assert.equal((await sql('SELECT count(*)::int n FROM learner_settings WHERE user_id = $1', [user.id])).rows[0].n, 0);
    assert.equal((await world.settings.read(accounts[1].id)).settings.language, 'en');
  });
} finally {
  if (concurrentPool) await concurrentPool.end();
  if (db) {
    const schema = db.schema;
    await db.cleanup();
    if (observer) {
      try {
        assert.equal((await observer.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname = $1', [schema])).rows[0].n, 0);
        assert.equal((await observer.query('SELECT count(*)::int n FROM pg_roles WHERE rolname = ANY($1::text[])', [Object.values(db.roles)])).rows[0].n, 0);
        assert.equal((await observer.query('SELECT count(*)::int n FROM pg_stat_activity WHERE application_name = $1', [schema])).rows[0].n, 0);
        console.log('Cleanup verified: exact fixture schema, roles and connections absent');
      } finally { await observer.end(); }
    }
  }
}
console.log(`${passed} registration-language PostgreSQL checks passed`);
