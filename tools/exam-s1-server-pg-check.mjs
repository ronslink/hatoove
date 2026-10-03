#!/usr/bin/env node
/**
 * EXAM-S1 — preparations, exam-keyed credits and atomic registration on REAL PostgreSQL.
 *
 * DISPOSABLE DATABASE ONLY (`OWNAPI_PG_*`, random schema from `createFixture`, dropped afterwards). Two
 * synthetic owners per leg, two exams: telc Deutsch B1 and a synthetic `synthetic-en-b2` package that is
 * inserted into the disposable schema and enabled ONLY through this check's server-side catalogue. Every
 * grader is a stub; no provider, email or payment is reached.
 *
 * Legs (each fails against base 0d32619, which has no preparation table, routes or exam-keyed balance):
 *   1. upgrade: a pre-0023 schema with legacy balances, dates (valid and invalid), bound and unbound
 *      attempts, submissions, jobs and evidence is migrated; balances, text, IDs and reservations are
 *      preserved exactly, only provable rows are bound, invalid dates are preserved, temporary policies gone;
 *   2. registration: account, session, preparation and balance commit together; an injected failure rolls
 *      ALL of them back; updating an existing account cannot trigger provisioning or invoke a grant helper;
 *   3. missing/foreign/mismatched context writes nothing (full fingerprint);
 *   4. concurrent duplicate preparation creation converges on one row; stale revision 409 with current DTO;
 *   5. create/archive/resume never grants or refills; a second active preparation is refused;
 *   6. exam-specific success, failure, retry and reclaim, through the runtime worker AND the fixture worker;
 *   7. export includes all preparations and balances; hard delete removes them; a late job writes nothing.
 *   8. concurrent submissions for two exams sharing one event ID produce one success and one contract 409,
 *      one job/reservation/debit, with the winner still replayable.
 *   9. (EXAM-S1-D) an archived preparation is read-only to learner practice: saving or deleting an unsubmitted
 *      draft is 409 `preparation_archived` and writes nothing; foreign stays 404 and submitted stays 409; reads,
 *      the open index and export survive; queued/running/failed submitted work still retries and completes
 *      against the original exam ledger; unarchiving restores draft editing.
 *  10. (EXAM-S1-D) archive vs save/delete is serialised by row locks on two real connections: a save that
 *      holds its preparation share lock delays the archive and lands first; an uncommitted archive delays a
 *      save and a delete, which then refuse. No deadlock.
 *  11. (EXAM-S1-D) an UNRESOLVED legacy draft stays readable and exportable but is never edited or discarded
 *      under a guessed context (422 `preparation_unresolved`); a provably bound legacy draft stays editable.
 *
 * Legs 9-11 fail against base 3f9d14e, whose save/remove did not consult the preparation.
 *
 * Usage: node tools/exam-s1-server-pg-check.mjs [--only=<text>]
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createFixture, rolePool } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { createPostgresSessions } from '../server/owned-postgres/sessions.mjs';
import { createWorker, stubGrade } from '../server/owned-postgres/worker.mjs';
import { DEFAULT_TASK_BINDING, TELC_B1_WRITING_RUBRIC } from '../server/owned-postgres/content-seed.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';

process.env.B1PREP_CONTENT_MODE = 'internal-preview';
delete process.env.B1PREP_SERVE_REVIEW;
delete process.env.B1PREP_SERVE_RIGHTS;

const TELC = 'telc-deutsch-b1';
const SYNTH = 'synthetic-en-b2';
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const catalogue = createExamCatalogue({ enabled: [TELC, SYNTH] });

const TELC_TASK = { taskId: 's1.writing.telc', taskVersion: 'v1', rubricId: TELC_B1_WRITING_RUBRIC.rubricId, rubricVersion: TELC_B1_WRITING_RUBRIC.version };
const SYNTH_TASK = { taskId: 's1.writing.synth', taskVersion: 'v1', rubricId: 's1.rubric.synth', rubricVersion: 'v1' };
const TELC_SET = 's1.telc.lv1';
const SYNTH_SET = 's1.synth.r1';
const LETTER = 'Liebe Anna, vielen Dank für deine Nachricht. Ich komme gern am Samstag zu dir und bringe einen Kuchen mit, damit wir zusammen feiern können.';

/* ------------------------------------------------------------------ world */

async function seedContent(sql) {
  const rights = async (id) => sql(
    `INSERT INTO content_rights(content_version_id, basis, decided_by, note)
     SELECT $1, 'generated', 'exam-s1-check', 'synthetic EXAM-S1 row in a disposable schema'
      WHERE NOT EXISTS (SELECT 1 FROM content_rights WHERE content_version_id = $1)`, [id]);
  const content = async (id, kind, family, exam) => {
    await sql(`INSERT INTO content_version(content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
               VALUES($1, $2, $3, 'synthetic:exam-s1-server-pg-check', 'unreviewed', 'unknown', 'synthetic', $4)`, [id, kind, family, exam]);
    await rights(id);
  };
  await sql(`INSERT INTO exam_package(exam_id, exam, level, exam_language, blueprint_version)
             VALUES($1, 'Synthetic English B2', 'B2', 'en', 'synthetic@exam-s1') ON CONFLICT DO NOTHING`, [SYNTH]);
  // The real telc rubric, made servable in THIS disposable schema only, so the runtime worker can grade.
  const rubricRow = (await sql('SELECT content_version_id FROM rubric_version WHERE rubric_id = $1 AND version = $2',
    [TELC_B1_WRITING_RUBRIC.rubricId, TELC_B1_WRITING_RUBRIC.version])).rows[0];
  assert.ok(rubricRow, 'the seeded telc rubric exists');
  await rights(rubricRow.content_version_id);
  await content('s1.rubric.synth@v1', 'rubric', 'writing', SYNTH);
  await sql(`INSERT INTO rubric_version(rubric_id, version, family, criteria, max_total, content_version_id, exam_id)
             VALUES('s1.rubric.synth', 'v1', 'writing', $1::jsonb, 45, 's1.rubric.synth@v1', $2)`,
  [JSON.stringify(TELC_B1_WRITING_RUBRIC.criteria), SYNTH]);
  for (const [task, exam] of [[TELC_TASK, TELC], [SYNTH_TASK, SYNTH]]) {
    await content(`${task.taskId}@v1`, 'task', 'writing', exam);
    await sql(`INSERT INTO task_version(task_id, version, family, register, topic, situation, adressat, leitpunkte,
                                        rubric_id, rubric_version, content_version_id, exam_id)
               VALUES($1, 'v1', 'writing', 'du', 'EXAM-S1 synthetisch', 'Synthetisch.', 'Synthetisch (du)',
                      '["Eins.","Zwei."]'::jsonb, $2, $3, $4, $5)`,
    [task.taskId, task.rubricId, task.rubricVersion, `${task.taskId}@v1`, exam]);
  }
  for (const [set, exam] of [[TELC_SET, TELC], [SYNTH_SET, SYNTH]]) {
    await content(`${set}@v1`, 'task', 'lv', exam);
    await sql(`INSERT INTO objective_set(set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
               VALUES($1, 'v1', $2, 'LV1', 'LV', 1, 'EXAM-S1 synthetic', '{"items":[]}'::jsonb, 1, false, $3)`, [set, exam, `${set}@v1`]);
    await sql(`INSERT INTO objective_key(set_id, version, answers, explanations) VALUES($1, 'v1', '{"1":"a"}'::jsonb, '{}'::jsonb)`, [set]);
  }
}

async function makeWorld(options = {}) {
  const db = await createFixture();
  const sql = (text, params) => db.admin.query(text, params);
  await seedContent(sql);
  const world = await createPostgresWorld({ fixture: db, examCatalogue: catalogue, ...options });
  async function call(method, path, { cookie = null, body } = {}) {
    const headers = { accept: 'application/json', ...(cookie ? { cookie } : {}) };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await world.api.handle({ method, path, headers, originChecked: true,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* not JSON */ }
    return { status: response.status, json, cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
  }
  async function learner(tag) {
    await sql("DELETE FROM auth_throttle WHERE bucket = 'signup:global'");
    const email = `exam-s1-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
    const res = await call('POST', '/api/auth/sign-up/email', { body: { name: `EXAM-S1 ${tag}`, email, password: 'pw-exam-s1-synthetic' } });
    assert.equal(res.status, 200, `sign-up ${tag}: ${JSON.stringify(res.json)}`);
    const account = await call('GET', '/api/v1/account', { cookie: res.cookie });
    const preps = await call('GET', '/api/v1/preparations', { cookie: res.cookie });
    return { cookie: res.cookie, id: account.json.id, email, telc: preps.json.preparations.find((p) => p.exam_id === TELC) };
  }
  const balance = async (owner, exam) => {
    const row = (await sql('SELECT allowance, used, reserved FROM entitlements WHERE owner_id = $1 AND exam_id = $2', [owner, exam])).rows[0];
    return row ? { allowance: row.allowance, used: row.used, reserved: row.reserved } : null;
  };
  return { db, sql, world, call, learner, balance, teardown: () => world.teardown() };
}

const legs = [];
const check = (name, fn) => legs.push({ name, fn });

/* ------------------------------------------------------------------- legs */

check('1. upgrade preserves balances, dates, text, IDs and reservations; binds only provable rows', async () => {
  const db = await createFixture({ stopBefore: '0023-' });
  const sql = (text, params) => db.admin.query(text, params);
  try {
    const users = ['legacy-valid', 'legacy-invalid', 'legacy-none'].map((tag) => `user-${tag}-${randomUUID().slice(0, 8)}`);
    for (const id of users) {
      await sql(`INSERT INTO "user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
                 VALUES($1, 'Legacy', $2, false, now(), now())`, [id, `${id}@example.invalid`]);
    }
    const [u1, u2, u3] = users;
    await sql(`INSERT INTO learner_settings(user_id, exam_date, revision) VALUES($1, '2026-11-20', 1), ($2, '2026-02-30', 1)`, [u1, u2]);
    await sql('INSERT INTO entitlements(owner_id, allowance, used, reserved) VALUES($1, 7, 2, 2)', [u1]);
    const b = DEFAULT_TASK_BINDING;
    const bound = randomUUID();
    const unbound = randomUUID();
    await sql(`INSERT INTO attempts(id, owner_id, task_id, task_version, rubric_id, rubric_version) VALUES($1, $2, $3, $4, $5, $6)`,
      [bound, u1, b.taskId, b.taskVersion, b.rubricId, b.rubricVersion]);
    await sql(`INSERT INTO attempts(id, owner_id, task_version, rubric_version) VALUES($1, $2, 'legacy', 'legacy')`, [unbound, u1]);
    const subs = [];
    for (const [attempt, status, tv, rv] of [[bound, 'queued', b.taskVersion, b.rubricVersion], [unbound, 'running', 'legacy', 'legacy']]) {
      const sid = randomUUID();
      subs.push(sid);
      await sql(`INSERT INTO submissions(id, attempt_id, owner_id, event_id, draft_revision, text, task_version, rubric_version)
                 VALUES($1, $2, $3, $4, 1, $5, $6, $7)`, [sid, attempt, u1, randomUUID(), `${LETTER} ${status}`, tv, rv]);
      await sql(`INSERT INTO jobs(id, submission_id, owner_id, status) VALUES($1, $2, $3, $4)`, [randomUUID(), sid, u1, status]);
    }
    const set = (await sql('SELECT set_id, version FROM objective_set ORDER BY set_id LIMIT 1')).rows[0];
    const evidenceId = randomUUID();
    await sql(`INSERT INTO item_evidence(evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct)
               VALUES($1, $2, $3, $4, $5, '1', 'LV1', 'LV', '"a"'::jsonb, true)`, [evidenceId, u1, TELC, set.set_id, set.version]);
    const before = (await sql('SELECT * FROM submissions ORDER BY id')).rows;

    const applied = await db.applyRemaining();
    assert.ok(applied.some((file) => file.startsWith('0023-')), `0023 applied: ${applied}`);

    assert.deepEqual((await sql('SELECT * FROM submissions ORDER BY id')).rows, before, 'submission snapshots untouched');
    const ent = (await sql('SELECT owner_id, exam_id, allowance, used, reserved FROM entitlements')).rows;
    assert.deepEqual(ent, [{ owner_id: u1, exam_id: TELC, allowance: 7, used: 2, reserved: 2 }], 'balance preserved exactly as telc');
    const preps = (await sql('SELECT owner_id, exam_id, state, exam_date, legacy_exam_date_disposition FROM learner_preparation')).rows;
    assert.equal(preps.length, 3, 'one active telc preparation per existing user');
    const byOwner = new Map(preps.map((p) => [p.owner_id, p]));
    assert.equal(byOwner.get(u1).legacy_exam_date_disposition, 'valid_backfilled');
    assert.ok(byOwner.get(u1).exam_date, 'a real date was copied');
    assert.equal(byOwner.get(u2).exam_date, null);
    assert.equal(byOwner.get(u2).legacy_exam_date_disposition, 'invalid_preserved');
    assert.equal(byOwner.get(u3).legacy_exam_date_disposition, 'none');
    assert.equal((await sql('SELECT exam_date FROM learner_settings WHERE user_id = $1', [u2])).rows[0].exam_date, '2026-02-30', 'raw legacy value preserved');
    const attempts = new Map((await sql('SELECT id, preparation_id, exam_id FROM attempts')).rows.map((a) => [a.id, a]));
    assert.equal(attempts.get(bound).exam_id, TELC);
    assert.ok(attempts.get(bound).preparation_id);
    assert.equal(attempts.get(unbound).preparation_id, null, 'an unprovable attempt stays unresolved');
    assert.equal(attempts.get(unbound).exam_id, null);
    assert.deepEqual((await sql('SELECT DISTINCT exam_id FROM jobs')).rows, [{ exam_id: TELC }], 'reservations stay in the telc balance');
    assert.ok((await sql('SELECT preparation_id FROM item_evidence WHERE evidence_id = $1', [evidenceId])).rows[0].preparation_id);
    assert.equal((await sql("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1 AND policyname LIKE 'migration_0023%'", [db.schema])).rows[0].n, 0,
      'temporary backfill policies are dropped');
    // The learner role still sees nothing of another owner.
    const learner = await db.learner.connect();
    try {
      await learner.query('BEGIN');
      await learner.query("SELECT set_config('hatoove.owner_id', $1, true)", [u2]);
      assert.equal((await learner.query('SELECT count(*)::int AS n FROM learner_preparation')).rows[0].n, 1);
      assert.equal((await learner.query('SELECT count(*)::int AS n FROM attempts')).rows[0].n, 0);
      await learner.query('ROLLBACK');
    } finally { learner.release(); }
  } finally {
    await db.cleanup();
  }
});

check('2. registration is atomic, and provisioning is registration-only and insert-only', async () => {
  let failAt = null;
  const w = await makeWorld({ registrationHook: async (stage) => { if (stage === failAt) throw new Error(`injected ${stage} failure`); } });
  try {
    const a = await w.learner('reg');
    assert.equal(a.telc.state, 'active');
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 0, reserved: 0 });
    // The trigger retains the server-configured policy, including an explicit zero or no grant.
    for (const allowance of [3, 0, null]) {
      const sessions = createPostgresSessions({ pool: w.db.auth, adminPool: w.db.admin, allowance });
      const email = `exam-s1-allowance-${randomUUID().slice(0, 8)}@example.invalid`;
      await sessions.signUp({ name: 'Configured allowance', email, password: 'pw-exam-s1-synthetic' });
      const owner = (await w.sql('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id;
      assert.deepEqual(await w.balance(owner, TELC), allowance === null ? null : { allowance, used: 0, reserved: 0 });
      assert.equal((await w.sql('SELECT count(*)::int AS n FROM learner_preparation WHERE owner_id = $1 AND exam_id = $2', [owner, TELC])).rows[0].n, 1);
    }
    for (const stage of ['provisioned', 'session']) {
      failAt = stage;
      const counts = async () => (await w.sql(`SELECT (SELECT count(*) FROM "user")::int AS u, (SELECT count(*) FROM session)::int AS s,
        (SELECT count(*) FROM account)::int AS a, (SELECT count(*) FROM learner_preparation)::int AS p, (SELECT count(*) FROM entitlements)::int AS e`)).rows[0];
      const before = await counts();
      await w.sql("DELETE FROM auth_throttle WHERE bucket = 'signup:global'");
      const email = `exam-s1-rollback-${randomUUID().slice(0, 8)}@example.invalid`;
      const res = await w.call('POST', '/api/auth/sign-up/email', { body: { name: 'Rollback', email, password: 'pw-exam-s1-synthetic' } });
      assert.equal(res.status, 500, `injected ${stage} failure surfaces`);
      assert.equal(res.cookie, '', 'no cookie for a rolled-back registration');
      assert.deepEqual(await counts(), before, `${stage}: user/account/session/preparation/balance all rolled back`);
      assert.equal((await w.sql('SELECT count(*)::int AS n FROM "user" WHERE email = $1', [email])).rows[0].n, 0);
    }
    failAt = null;
    const initialPreparations = (await w.sql('SELECT id, exam_id, revision FROM learner_preparation WHERE owner_id = $1 ORDER BY id', [a.id])).rows;
    // Reproduce the xmin bypass: an UPDATE makes an existing user's row version current. Neither
    // that update nor arbitrary provisioning settings may grant another exam or refill the first.
    const auth = await w.db.auth.connect();
    try {
      await auth.query('BEGIN');
      await auth.query("SELECT set_config('hatoove.registration_allowance', '999', true)");
      await auth.query("SELECT set_config('hatoove.owner_id', $1, true), set_config('hatoove.provisioning', 'on', true)", [a.id]);
      await auth.query('UPDATE "user" SET "updatedAt" = "updatedAt" WHERE id = $1', [a.id]);
      assert.equal((await auth.query('SELECT xmin::text = (txid_current() % 4294967296)::text AS current_version FROM "user" WHERE id = $1', [a.id])).rows[0].current_version, true,
        'the previous guard would have accepted this updated account');
      await assert.rejects(auth.query('SELECT provision_learner($1, $2, 999)', [a.id, SYNTH]), { code: '42883' }, 'the callable grant helper is absent');
      await auth.query('ROLLBACK');
      // Also commit a standalone UPDATE, proving that success cannot silently provision anything.
      await auth.query('BEGIN');
      await auth.query("SELECT set_config('hatoove.registration_allowance', '999', true)");
      await auth.query('UPDATE "user" SET "updatedAt" = "updatedAt" WHERE id = $1', [a.id]);
      await auth.query('COMMIT');
      await assert.rejects(auth.query('SELECT provision_registered_learner()'), { code: '42501' }, 'auth cannot invoke the trigger helper');
      const privileges = (await auth.query(`SELECT has_function_privilege(current_user, 'provision_registered_learner()', 'EXECUTE') AS execute,
        has_table_privilege(current_user, '"user"', 'TRIGGER') AS trigger`)).rows[0];
      assert.deepEqual(privileges, { execute: false, trigger: false }, 'auth cannot attach or invoke the provisioning trigger');
    } finally { auth.release(); }
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 0, reserved: 0 }, 'no refill');
    assert.equal(await w.balance(a.id, SYNTH), null, 'no arbitrary exam grant');
    assert.deepEqual((await w.sql('SELECT id, exam_id, revision FROM learner_preparation WHERE owner_id = $1 ORDER BY id', [a.id])).rows, initialPreparations,
      'no arbitrary preparation or mutation');
    await assert.rejects(w.db.learner.query('SELECT provision_registered_learner()'), { code: '42501' }, 'learner cannot invoke the trigger helper');
  } finally { await w.teardown(); }
});

check('3. missing, foreign and mismatched context write nothing', async () => {
  const w = await makeWorld();
  try {
    const a = await w.learner('ctx-a');
    const b = await w.learner('ctx-b');
    const synth = await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: SYNTH } });
    assert.equal(synth.status, 201);
    const before = await w.world.store.inspect.fingerprint();
    const answer = (prep, set) => w.call('POST', `/api/v1/objective-sets/${set}/answers`,
      { cookie: a.cookie, body: { ...(prep ? { preparationId: prep } : {}), itemId: '1', answer: 'a', version: 'v1' } });
    assert.equal((await answer(null, TELC_SET)).json.error, 'preparation_required');
    assert.equal((await answer(b.telc.id, TELC_SET)).status, 404, 'foreign');
    assert.equal((await answer(randomUUID(), TELC_SET)).status, 404, 'absent');
    assert.equal((await answer(synth.json.id, TELC_SET)).json.error, 'preparation_mismatch');
    assert.equal((await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: {} })).json.error, 'preparation_required');
    assert.equal((await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: b.telc.id } })).status, 404);
    assert.equal((await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: synth.json.id, ...TELC_TASK } })).json.error, 'preparation_mismatch');
    assert.equal((await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: a.telc.id, ...SYNTH_TASK } })).json.error, 'preparation_mismatch');
    for (const route of ['/api/v1/tasks', '/api/v1/practice/progress', '/api/v1/attempts?open=1']) {
      const sep = route.includes('?') ? '&' : '?';
      assert.equal((await w.call('GET', route, { cookie: a.cookie })).status, 422, route);
      assert.equal((await w.call('GET', `${route}${sep}preparationId=${b.telc.id}`, { cookie: a.cookie })).status, 404, route);
    }
    assert.equal(await w.world.store.inspect.fingerprint(), before, 'no refused request wrote a row');
    // SQL refuses the mismatch even if the API were bypassed.
    const client = await w.db.learner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [a.id]);
      await assert.rejects(client.query(
        `INSERT INTO attempts(id, owner_id, task_id, task_version, rubric_id, rubric_version, preparation_id, exam_id)
         VALUES($1, $2, $3, 'v1', $4, $5, $6, $7)`,
        [randomUUID(), a.id, TELC_TASK.taskId, TELC_TASK.rubricId, TELC_TASK.rubricVersion, synth.json.id, SYNTH]), /violates foreign key/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    const ok = await answer(synth.json.id, SYNTH_SET);
    assert.equal(ok.status, 201);
    const telcProgress = await w.call('GET', `/api/v1/practice/progress?preparationId=${a.telc.id}`, { cookie: a.cookie });
    assert.equal(telcProgress.json.totals.attempts, 0, 'synthetic evidence does not leak into the telc preparation');
  } finally { await w.teardown(); }
});

check('4. concurrent duplicate creation converges; stale edits conflict with the current DTO', async () => {
  const w = await makeWorld();
  const pools = [];
  try {
    const a = await w.learner('race');
    const ports = [0, 1, 2].map(() => {
      const pool = rolePool(w.db.config, w.db.schema, w.db.roles.learner, 1);
      pools.push(pool);
      return createPostgresDatastore({ pool, examCatalogue: catalogue });
    });
    const outcomes = await Promise.all(ports.map((port) => port.createPreparation(a.id, SYNTH)));
    assert.equal(outcomes.filter((o) => o.created).length, 1, 'exactly one creation');
    assert.equal(new Set(outcomes.map((o) => o.preparation.id)).size, 1, 'all callers see the same preparation');
    assert.equal((await w.sql("SELECT count(*)::int AS n FROM learner_preparation WHERE owner_id = $1 AND exam_id = $2", [a.id, SYNTH])).rows[0].n, 1);
    const id = outcomes[0].preparation.id;
    const first = await w.call('PUT', `/api/v1/preparations/${id}`, { cookie: a.cookie, body: { expectedRevision: 1, examDate: '2027-03-15' } });
    assert.equal(first.status, 200);
    const stale = await w.call('PUT', `/api/v1/preparations/${id}`, { cookie: a.cookie, body: { expectedRevision: 1, examDate: '2027-04-01' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.current.exam_date, '2027-03-15');
    assert.equal((await w.call('PUT', `/api/v1/preparations/${id}`, { cookie: a.cookie, body: { expectedRevision: 2, examDate: '2027-02-29' } })).status, 422);
    const again = await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: SYNTH } });
    assert.equal(again.status, 200);
    assert.equal(again.json.exam_date, '2027-03-15', 'idempotent create keeps the date');
  } finally {
    await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
    await w.teardown();
  }
});

check('5. preparations never grant or refill; a second active preparation is refused', async () => {
  const w = await makeWorld();
  try {
    const a = await w.learner('nogrant');
    const telcBefore = await w.balance(a.id, TELC);
    const synth = await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: SYNTH } });
    assert.equal(await w.balance(a.id, SYNTH), null, 'a new exam has no grant');
    assert.deepEqual((await w.call('GET', `/api/v1/preparations/${synth.json.id}/credits`, { cookie: a.cookie })).json,
      { examId: SYNTH, allowance: 0, used: 0, reserved: 0, expiresAt: null, available: 0 });
    const archived = await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 1, state: 'archived' } });
    assert.equal(archived.json.state, 'archived');
    assert.equal((await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: a.telc.id, ...TELC_TASK } })).json.error, 'preparation_archived');
    const second = await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: TELC } });
    assert.equal(second.status, 201);
    const resume = await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 2, state: 'active' } });
    assert.equal(resume.json.error, 'active_preparation_exists');
    await w.call('PUT', `/api/v1/preparations/${second.json.id}`, { cookie: a.cookie, body: { expectedRevision: 1, state: 'archived' } });
    assert.equal((await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 2, state: 'active' } })).status, 200);
    assert.deepEqual(await w.balance(a.id, TELC), telcBefore, 'create/archive/resume changed no balance');
    assert.equal(await w.balance(a.id, SYNTH), null);
    const history = await w.call('GET', '/api/v1/preparations', { cookie: a.cookie });
    assert.equal(history.json.preparations.length, 3, 'archived history listed');
  } finally { await w.teardown(); }
});

check('6. success, failure, retry and reclaim settle against the original exam only', async () => {
  const w = await makeWorld();
  try {
    const a = await w.learner('ledger');
    const synth = (await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: SYNTH } })).json;
    await w.sql('INSERT INTO entitlements(owner_id, exam_id, allowance) VALUES($1, $2, 3)', [a.id, SYNTH]); // explicit test provisioning
    const write = async (prep, task) => {
      const created = await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: prep, ...task } });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      await w.call('PUT', `/api/v1/attempts/${created.json.id}`, { cookie: a.cookie, body: { expectedRevision: 1, text: LETTER } });
      const sub = await w.call('POST', `/api/v1/attempts/${created.json.id}/submissions`, { cookie: a.cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
      assert.equal(sub.status, 202, JSON.stringify(sub.json));
      return sub.json.submissionId;
    };
    let clock = new Date();
    const worker = createWorker({ pool: w.db.worker, grade: stubGrade, now: () => clock });

    // telc success through the RUNTIME worker.
    const telcSub = await write(a.telc.id, TELC_TASK);
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 0, reserved: 1 });
    assert.equal((await worker.runOnce()).outcome, 'succeeded');
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 1, reserved: 0 });
    assert.deepEqual(await w.balance(a.id, SYNTH), { allowance: 3, used: 0, reserved: 0 }, 'telc debit left synthetic alone');
    const result = await w.call('GET', `/api/v1/submissions/${telcSub}`, { cookie: a.cookie });
    assert.equal(result.json.preparation_id, a.telc.id);
    assert.equal(result.json.exam_id, TELC);

    // synthetic failure through the runtime worker (unsupported rubric), then retry, then fixture success.
    const synthSub = await write(synth.id, SYNTH_TASK);
    assert.deepEqual(await w.balance(a.id, SYNTH), { allowance: 3, used: 0, reserved: 1 });
    const failed = await worker.runOnce();
    assert.equal(failed.outcome, 'failed');
    assert.deepEqual(await w.balance(a.id, SYNTH), { allowance: 3, used: 0, reserved: 0 }, 'failure released the synthetic reservation');
    assert.equal((await w.call('POST', `/api/v1/submissions/${synthSub}/retry`, { cookie: a.cookie, body: {} })).status, 202);
    assert.deepEqual(await w.balance(a.id, SYNTH), { allowance: 3, used: 0, reserved: 1 });
    assert.equal(await w.world.store.worker.claim(synthSub), true);
    assert.equal(await w.world.store.worker.complete(synthSub, 'fixture'), true);
    assert.deepEqual(await w.balance(a.id, SYNTH), { allowance: 3, used: 1, reserved: 0 }, 'fixture debit hit the synthetic balance');
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 1, reserved: 0 });

    // Reclaim: an abandoned synthetic job refunds the synthetic balance.
    const lost = await write(synth.id, SYNTH_TASK);
    await w.sql("UPDATE jobs SET status = 'running', tries = 3, lease_until = now() - interval '1 minute' WHERE submission_id = $1", [lost]);
    clock = new Date(Date.now() + 1000);
    assert.deepEqual(await worker.reclaimExpired(), { requeued: 0, abandoned: 1 });
    assert.deepEqual(await w.balance(a.id, SYNTH), { allowance: 3, used: 1, reserved: 0 });
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 1, reserved: 0 });
  } finally { await w.teardown(); }
});

check('7. export carries every preparation and balance; delete removes them; a late job writes nothing', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const w = await makeWorld();
  try {
    const a = await w.learner('export');
    const b = await w.learner('export-other');
    await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 1, state: 'archived' } });
    const active = (await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: TELC } })).json;
    const created = await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: active.id, ...TELC_TASK } });
    await w.call('PUT', `/api/v1/attempts/${created.json.id}`, { cookie: a.cookie, body: { expectedRevision: 1, text: LETTER } });
    await w.call('POST', `/api/v1/attempts/${created.json.id}/submissions`, { cookie: a.cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
    const exported = await w.call('GET', '/api/v1/export', { cookie: a.cookie });
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.json.preparations.map((p) => p.state).sort(), ['active', 'archived']);
    assert.deepEqual(exported.json.balances.map((x) => x.exam_id), [TELC]);
    assert.equal(exported.json.attempts[0].preparation_id, active.id);
    assert.equal(exported.json.submissions[0].exam_id, TELC);

    // A grader still running when the account is deleted must not write anything afterwards.
    const worker = createWorker({ pool: w.db.worker, grade: async (input) => { await gate; return stubGrade(input); } });
    const pending = worker.runOnce();
    for (let i = 0; i < 50 && (await w.sql("SELECT count(*)::int AS n FROM jobs WHERE owner_id = $1 AND status = 'running'", [a.id])).rows[0].n === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const deleted = await w.call('DELETE', '/api/v1/account', { cookie: a.cookie, body: {} });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.equal(deleted.json.verifiedAbsent, true);
    release();
    assert.equal((await pending).outcome, 'stale', 'the late job finds nothing to complete');
    for (const table of ['learner_preparation', 'entitlements', 'attempts', 'jobs', 'assessments', 'usage_ledger', 'item_evidence']) {
      assert.equal((await w.sql(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`, [a.id])).rows[0].n, 0, `${table} empty`);
    }
    assert.equal((await w.sql('SELECT count(*)::int AS n FROM learner_preparation WHERE owner_id = $1', [b.id])).rows[0].n, 1, 'the other owner is untouched');
  } finally {
    release();
    await w.teardown();
  }
});

check('8. concurrent cross-exam event reuse has one success, one 409, and one reservation/debit', async () => {
  const w = await makeWorld();
  const pools = [];
  let held;
  const pending = [];
  try {
    const a = await w.learner('event-race');
    const synth = (await w.call('POST', '/api/v1/preparations', { cookie: a.cookie, body: { examId: SYNTH } })).json;
    await w.sql('INSERT INTO entitlements(owner_id, exam_id, allowance) VALUES($1, $2, 3)', [a.id, SYNTH]);
    const attempts = [];
    for (const [prep, task] of [[a.telc.id, TELC_TASK], [synth.id, SYNTH_TASK]]) {
      const created = await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: prep, ...task } });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const saved = await w.call('PUT', `/api/v1/attempts/${created.json.id}`, { cookie: a.cookie, body: { expectedRevision: 1, text: LETTER } });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      attempts.push(created.json.id);
    }
    // S4 serializes all writing mutations for one owner before per-exam balances. Hold that
    // real lock, overlap a second restricted connection, and prove the exact blocker/key rather
    // than waiting for two event lookups that can no longer occur concurrently.
    held = gatedPort(w, pools, (text) => /pg_advisory_xact_lock\(hashtextextended\(\$1,\s*7352\)\)/.test(text));
    const waiting = gatedPort(w, pools);
    const ports = [held.port, waiting.port];
    const eventId = randomUUID();
    const first = ports[0].submit(a.id, attempts[0], 2, eventId);
    pending.push(first);
    await waitForGate(held, first);
    const second = ports[1].submit(a.id, attempts[1], 2, eventId);
    pending.push(second);
    const settled = Promise.allSettled(pending);
    let overlap;
    for (let i = 0; i < 500 && !overlap; i += 1) {
      if (held.pids.size === 1 && waiting.pids.size === 1) {
        overlap = (await w.sql(`SELECT holder.pid AS winner_pid, waiter.pid AS loser_pid
          FROM pg_locks holder JOIN pg_locks waiter
            ON holder.locktype=waiter.locktype AND holder.database=waiter.database
            AND holder.classid=waiter.classid AND holder.objid=waiter.objid AND holder.objsubid=waiter.objsubid
          WHERE holder.pid=$1 AND waiter.pid=$2 AND holder.locktype='advisory'
            AND holder.granted AND NOT waiter.granted AND holder.objsubid=1
            AND ((holder.classid::bigint << 32) | holder.objid::bigint)=hashtextextended($3,7352)
            AND $1=ANY(pg_blocking_pids($2))`, [[...held.pids][0], [...waiting.pids][0], a.id])).rows[0];
      }
      if (!overlap) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(overlap, "second submission must wait on this owner's exact 7352 lock held by the first backend");
    assert.equal(overlap.winner_pid, [...held.pids][0]);
    assert.equal(overlap.loser_pid, [...waiting.pids][0]);
    held.release();
    const outcomes = await settled;
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'one submission wins');
    const winner = outcomes.findIndex((o) => o.status === 'fulfilled');
    assert.equal(winner, 0, 'the verified lock-holder backend wins before its waiting peer');
    const loser = 1 - winner;
    assert.equal(outcomes[loser].reason.status, 409, 'the overlapped submission is a contract conflict, not a 500');
    assert.equal(outcomes[loser].reason.code, 'idempotency_conflict');
    const result = outcomes[winner].value;
    assert.equal(result.replay, false);
    const counts = async () => (await w.sql(`SELECT
      (SELECT count(*) FROM submissions WHERE owner_id = $1)::int AS submissions,
      (SELECT count(*) FROM jobs WHERE owner_id = $1)::int AS jobs,
      (SELECT count(*) FROM usage_ledger WHERE owner_id = $1)::int AS debits,
      (SELECT sum(reserved) FROM entitlements WHERE owner_id = $1)::int AS reserved,
      (SELECT sum(used) FROM entitlements WHERE owner_id = $1)::int AS used`, [a.id])).rows[0];
    assert.deepEqual(await counts(), { submissions: 1, jobs: 1, debits: 0, reserved: 1, used: 0 });
    assert.deepEqual(await ports[winner].submit(a.id, attempts[winner], 2, eventId), { submissionId: result.submissionId, replay: true });
    await assert.rejects(ports[loser].submit(a.id, attempts[loser], 2, eventId), { status: 409, code: 'idempotency_conflict' });
    assert.deepEqual(await counts(), { submissions: 1, jobs: 1, debits: 0, reserved: 1, used: 0 }, 'replays and conflicts reserve nothing more');
    assert.equal(await w.world.store.worker.claim(result.submissionId), true);
    assert.equal(await w.world.store.worker.complete(result.submissionId, 'fixture'), true);
    assert.deepEqual(await counts(), { submissions: 1, jobs: 1, debits: 1, reserved: 0, used: 1 });
    const losingExam = loser === 0 ? TELC : SYNTH;
    assert.deepEqual(await w.balance(a.id, losingExam), { allowance: loser === 0 ? 10 : 3, used: 0, reserved: 0 }, 'losing exam credit remains untouched');
  } finally {
    held?.release();
    await Promise.allSettled(pending);
    await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
    await w.teardown();
  }
});

/*
 * A datastore port on its own restricted learner connection. `pauseAfter(text)` holds the FIRST matching
 * statement's transaction open (after the statement ran) until `release()`, so a test can place a second
 * transaction behind a lock deterministically. `pids` are the backend pids, for `waitForLockWait`.
 */
function gatedPort(w, pools, pauseAfter = () => false) {
  const realPool = rolePool(w.db.config, w.db.schema, w.db.roles.learner, 1);
  pools.push(realPool);
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  const pids = new Set();
  let paused = false;
  const pool = { connect: async () => {
    const client = await realPool.connect();
    pids.add(client.processID);
    return { release: () => client.release(), query: async (text, params) => {
      const result = await client.query(text, params);
      if (!paused && pauseAfter(String(text))) { paused = true; reached(); await gate; }
      return result;
    } };
  } };
  return { port: createPostgresDatastore({ pool, examCatalogue: catalogue }), pids, arrived, release: () => release() };
}

/** A missing lock statement or an early failure must fail the test instead of leaving a held gate forever. */
async function waitForGate(gated, operation) {
  let timer;
  try {
    await Promise.race([
      gated.arrived,
      operation.then(() => { throw new Error('operation completed without reaching the expected lock gate'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lock gate not reached within 10s')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Wait until `n` of the given backends are blocked on a heavyweight lock (pg_stat_activity), or fail. */
async function waitForLockWait(w, gated, n = 1) {
  for (let i = 0; i < 500; i += 1) {
    const pids = gated.flatMap((g) => [...g.pids]);
    const waiting = (await w.sql(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'", [pids])).rows[0].n;
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${n} backend(s) to wait on a row lock; none did within 10s`);
}

const draftRow = async (w, id) => (await w.sql(
  'SELECT a.deleted_at, d.revision, d.text FROM attempts a LEFT JOIN drafts d ON d.attempt_id = a.id WHERE a.id = $1', [id])).rows[0];

check('9. an archived preparation is read-only to drafts; history, export, retry and workers survive', async () => {
  const w = await makeWorld();
  try {
    const a = await w.learner('archive');
    const b = await w.learner('archive-other');
    const create = async (who) => {
      const created = await w.call('POST', '/api/v1/attempts', { cookie: who.cookie, body: { preparationId: who.telc.id, ...TELC_TASK } });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      return created.json.id;
    };
    const save = (who, id, expectedRevision, text) => w.call('PUT', `/api/v1/attempts/${id}`, { cookie: who.cookie, body: { expectedRevision, text } });
    const submit = async (id) => {
      assert.equal((await save(a, id, 1, LETTER)).status, 200);
      const sub = await w.call('POST', `/api/v1/attempts/${id}/submissions`, { cookie: a.cookie, body: { expectedRevision: 2, eventId: randomUUID() } });
      assert.equal(sub.status, 202, JSON.stringify(sub.json));
      return sub.json.submissionId;
    };

    const draft = await create(a);
    assert.equal((await save(a, draft, 1, 'Entwurf vor dem Archiv')).status, 200);
    const queuedAttempt = await create(a);
    const queued = await submit(queuedAttempt);
    const failed = await submit(await create(a));
    const running = await submit(await create(a));
    const store = w.world.store;
    assert.equal(await store.worker.claim(failed), true);
    assert.equal(await store.worker.fail(failed, 'provider_unavailable'), true);
    assert.equal(await store.worker.claim(running), true);
    const foreignDraft = await create(b);
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 0, reserved: 2 });

    const archived = await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 1, state: 'archived' } });
    assert.equal(archived.json.state, 'archived');

    // Refusals: none of them may write a row.
    const before = await store.inspect.fingerprint();
    const refused = async (label, res, status, code) => {
      assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.json)}`);
      assert.equal(res.json.error, code, `${label}: refusal token`);
    };
    await refused('archived save', await save(a, draft, 2, 'nach dem Archiv'), 409, 'preparation_archived');
    await refused('archived delete', await w.call('DELETE', `/api/v1/attempts/${draft}`, { cookie: a.cookie, body: {} }), 409, 'preparation_archived');
    await refused('archived submit', await w.call('POST', `/api/v1/attempts/${draft}/submissions`, { cookie: a.cookie, body: { expectedRevision: 2, eventId: randomUUID() } }), 409, 'preparation_archived');
    await refused('archived create', await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: a.telc.id, ...TELC_TASK } }), 409, 'preparation_archived');
    await refused('stale save', await save(a, draft, 1, 'veraltet'), 409, 'draft_conflict');
    // Submitted-snapshot semantics are unchanged by the archive.
    await refused('submitted save', await save(a, queuedAttempt, 2, 'nachträglich'), 409, 'revision_required');
    await refused('submitted delete', await w.call('DELETE', `/api/v1/attempts/${queuedAttempt}`, { cookie: a.cookie, body: {} }), 409, 'submitted_attempt');
    // Foreign and absent stay indistinguishable 404s.
    for (const id of [foreignDraft, randomUUID()]) {
      await refused('foreign/absent save', await save(a, id, 1, 'fremd'), 404, 'not_found');
      await refused('foreign/absent delete', await w.call('DELETE', `/api/v1/attempts/${id}`, { cookie: a.cookie, body: {} }), 404, 'not_found');
    }
    assert.equal(await store.inspect.fingerprint(), before, 'no refused request changed a draft, revision, attempt, balance or history row');
    assert.deepEqual(await draftRow(w, draft), { deleted_at: null, revision: 2, text: 'Entwurf vor dem Archiv' });

    // Reads survive the archive.
    const read = await w.call('GET', `/api/v1/attempts/${draft}`, { cookie: a.cookie });
    assert.equal(read.status, 200);
    assert.deepEqual([read.json.revision, read.json.text], [2, 'Entwurf vor dem Archiv']);
    const open = await w.call('GET', `/api/v1/attempts?open=1&preparationId=${a.telc.id}`, { cookie: a.cookie });
    assert.equal(open.status, 200);
    assert.deepEqual(open.json.attempts.map((x) => x.id), [draft], 'the archived draft is still listed as unfinished');
    const exported = await w.call('GET', '/api/v1/export', { cookie: a.cookie });
    assert.equal(exported.status, 200);
    assert.equal(exported.json.attempts.find((x) => x.id === draft).text, 'Entwurf vor dem Archiv');
    assert.equal(exported.json.preparations.find((p) => p.id === a.telc.id).state, 'archived');
    assert.equal(exported.json.submissions.length, 3);

    // Submitted work is finished under the original exam ledger: retry, running and queued all complete.
    assert.equal((await w.call('POST', `/api/v1/submissions/${failed}/retry`, { cookie: a.cookie, body: {} })).status, 202);
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 0, reserved: 3 });
    assert.equal(await store.worker.complete(running, 'fixture'), true, 'a running job completes after archive');
    for (const id of [queued, failed]) {
      assert.equal(await store.worker.claim(id), true);
      assert.equal(await store.worker.complete(id, 'fixture'), true);
    }
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 3, reserved: 0 }, 'every debit hit the original telc balance');
    for (const id of [queued, failed, running]) {
      const result = await w.call('GET', `/api/v1/submissions/${id}`, { cookie: a.cookie });
      assert.equal(result.status, 200);
      assert.equal(result.json.job.status, 'succeeded');
      assert.equal(result.json.preparation_id, a.telc.id);
    }

    // An explicit state edit restores safe draft work.
    const resumed = await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 2, state: 'active' } });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
    const resumedSave = await save(a, draft, 2, 'nach dem Fortsetzen');
    assert.equal(resumedSave.status, 200, JSON.stringify(resumedSave.json));
    assert.equal(resumedSave.json.revision, 3);
    assert.equal((await w.call('DELETE', `/api/v1/attempts/${draft}`, { cookie: a.cookie, body: {} })).status, 200);
    assert.ok((await draftRow(w, draft)).deleted_at, 'the resumed draft could be discarded');
    assert.deepEqual(await w.balance(a.id, TELC), { allowance: 10, used: 3, reserved: 0 }, 'discarding touched no balance');
  } finally { await w.teardown(); }
});

check('10. archive vs save/delete is serialised by row locks, in either order, without deadlock', async () => {
  const w = await makeWorld();
  const pools = [];
  const gated = [];
  const pending = [];
  try {
    const a = await w.learner('archive-race');
    const created = await w.call('POST', '/api/v1/attempts', { cookie: a.cookie, body: { preparationId: a.telc.id, ...TELC_TASK } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const draft = created.json.id;
    assert.equal((await w.call('PUT', `/api/v1/attempts/${draft}`, { cookie: a.cookie, body: { expectedRevision: 1, text: 'eins' } })).status, 200);
    const balanceBefore = await w.balance(a.id, TELC);

    // A: the save holds its preparation share lock; the archive must wait for it, and the save lands.
    const saver = gatedPort(w, pools, (text) => text.includes('FOR SHARE OF p'));
    const archiver = gatedPort(w, pools);
    gated.push(saver, archiver);
    const saving = saver.port.save(a.id, draft, 2, 'vor dem Archiv gespeichert');
    pending.push(saving);
    await waitForGate(saver, saving);
    const archiving = archiver.port.updatePreparation(a.id, a.telc.id, 1, { state: 'archived' });
    pending.push(archiving);
    await waitForLockWait(w, [archiver], 1);
    saver.release();
    const [saved, archivedA] = await Promise.all([saving, archiving]);
    assert.equal(saved.revision, 3, 'the save that held the lock first committed');
    assert.equal(archivedA.state, 'archived', 'and the archive committed after it');
    assert.deepEqual(await draftRow(w, draft), { deleted_at: null, revision: 3, text: 'vor dem Archiv gespeichert' });
    const late = await w.call('PUT', `/api/v1/attempts/${draft}`, { cookie: a.cookie, body: { expectedRevision: 3, text: 'danach' } });
    assert.equal(late.json.error, 'preparation_archived', 'after the archive commits, the next save refuses');

    const resumed = await w.call('PUT', `/api/v1/preparations/${a.telc.id}`, { cookie: a.cookie, body: { expectedRevision: 2, state: 'active' } });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.json));

    // Each restricted role permits five connections. Close phase A before allocating phase B's three
    // connections, so a connection-limit refusal cannot masquerade as a write blocked by the archive.
    await Promise.all(pools.splice(0).map((pool) => pool.end()));

    // B: an uncommitted archive holds the preparation; a save AND a delete wait, then both refuse.
    const archiver2 = gatedPort(w, pools, (text) => text.includes('UPDATE learner_preparation'));
    const saver2 = gatedPort(w, pools);
    const remover = gatedPort(w, pools);
    gated.push(archiver2, saver2, remover);
    const archiving2 = archiver2.port.updatePreparation(a.id, a.telc.id, 3, { state: 'archived' });
    pending.push(archiving2);
    await waitForGate(archiver2, archiving2);
    const outcomes = Promise.allSettled([saver2.port.save(a.id, draft, 3, 'zu spät'), remover.port.remove(a.id, draft)]);
    pending.push(outcomes);
    await waitForLockWait(w, [saver2, remover], 2);
    archiver2.release();
    assert.equal((await archiving2).state, 'archived');
    for (const outcome of await outcomes) {
      assert.equal(outcome.status, 'rejected', 'a write queued behind the archive must not land');
      assert.equal(outcome.reason.status, 409, String(outcome.reason && outcome.reason.stack));
      assert.equal(outcome.reason.code, 'preparation_archived');
    }
    assert.deepEqual(await draftRow(w, draft), { deleted_at: null, revision: 3, text: 'vor dem Archiv gespeichert' }, 'nothing written behind the archive');
    assert.deepEqual(await w.balance(a.id, TELC), balanceBefore, 'no balance touched');
  } finally {
    for (const g of gated) g.release();
    await Promise.allSettled(pending);
    await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
    await w.teardown();
  }
});

check('11. an unresolved legacy draft is readable and exportable but never edited under a guessed context', async () => {
  const db = await createFixture({ stopBefore: '0023-' });
  const sql = (text, params) => db.admin.query(text, params);
  try {
    const owner = `user-legacy-draft-${randomUUID().slice(0, 8)}`;
    await sql(`INSERT INTO "user"(id, name, email, "emailVerified", "createdAt", "updatedAt")
               VALUES($1, 'Legacy', $2, false, now(), now())`, [owner, `${owner}@example.invalid`]);
    const b = DEFAULT_TASK_BINDING;
    const bound = randomUUID();
    const unbound = randomUUID();
    await sql('INSERT INTO attempts(id, owner_id, task_id, task_version, rubric_id, rubric_version) VALUES($1, $2, $3, $4, $5, $6)',
      [bound, owner, b.taskId, b.taskVersion, b.rubricId, b.rubricVersion]);
    await sql("INSERT INTO attempts(id, owner_id, task_version, rubric_version) VALUES($1, $2, 'legacy', 'legacy')", [unbound, owner]);
    await sql("INSERT INTO drafts(attempt_id, revision, text) VALUES($1, 1, 'Gebundener Entwurf'), ($2, 1, 'Alter Entwurf')", [bound, unbound]);
    await db.applyRemaining();
    assert.equal((await sql('SELECT preparation_id FROM attempts WHERE id = $1', [unbound])).rows[0].preparation_id, null, 'precondition: unresolved');

    const port = createPostgresDatastore({ pool: db.learner });
    const read = await port.read(owner, unbound);
    assert.deepEqual([read.preparation_id, read.revision, read.text], [null, 1, 'Alter Entwurf'], 'readable without a guessed context');
    const fingerprint = async () => JSON.stringify((await sql(
      `SELECT a.id, a.deleted_at, a.preparation_id, d.revision, d.text FROM attempts a LEFT JOIN drafts d ON d.attempt_id = a.id
        WHERE a.owner_id = $1 ORDER BY a.id`, [owner])).rows);
    const before = await fingerprint();
    await assert.rejects(port.save(owner, unbound, 1, 'geraten'), { status: 422, code: 'preparation_unresolved' });
    await assert.rejects(port.remove(owner, unbound), { status: 422, code: 'preparation_unresolved' });
    await assert.rejects(port.save(`user-stranger-${randomUUID().slice(0, 8)}`, unbound, 1, 'fremd'), { status: 404, code: 'not_found' });
    assert.equal(await fingerprint(), before, 'refused legacy edits wrote nothing');
    const exported = await port.exportData(owner);
    const row = exported.attempts.find((x) => x.id === unbound);
    assert.deepEqual([row.preparation_id, row.exam_id, row.text], [null, null, 'Alter Entwurf'], 'exported with explicit null context');
    // The provably bound legacy draft lives in an active preparation and stays editable.
    assert.equal((await port.save(owner, bound, 1, 'weiter')).revision, 2);
  } finally {
    await db.cleanup();
  }
});

/* -------------------------------------------------------------------- run */

let passed = 0;
const selected = legs.filter((leg) => !ONLY || leg.name.includes(ONLY));
for (const leg of selected) {
  try {
    await leg.fn();
    passed += 1;
    console.log(`ok   ${leg.name}`);
  } catch (error) {
    console.log(`FAIL ${leg.name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`);
  }
}
console.log(`\nexam-s1-server-pg-check: ${passed}/${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
