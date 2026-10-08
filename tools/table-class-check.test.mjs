/**
 * MFP-14 — the mutation proof for `tools/table-class-check.mjs`.
 *
 * THIS IS WHAT MAKES THE CHECK EVIDENCE RATHER THAN DECORATION. Each mutation is
 * applied to a **scratch** schema (a random `ownapi_<hex>` schema built by `bootstrap.mjs`,
 * dropped afterwards), and the check is **required to fail** on it. The real installation
 * schema (`OWNAPI_PG_SCHEMA`, default `hatoove`) is never touched.
 *
 *   1. drop one owner policy                 -> the owned rule must catch it
 *   2. remove one table from ACCOUNT_TABLES  -> the owned rule must catch it
 *      (precisely the drift that lets delete stop covering a table while `deletion-check`
 *       stays green)
 *   3. grant INSERT on `task_version` to the learner role -> the shared-content rule must catch it
 *   4. add an unclassified table             -> the unclassified rule must catch it
 *   5. grant SELECT on `objective_key` to the worker -> the answer-key rule must catch it
 *      (the grant 0010 made and 0021 revoked)
 *   6. drop the deletion role's `item_evidence` policy -> the owned rule must catch it
 *      (under FORCE RLS the deletion read-back would otherwise be vacuous)
 *   7. grant INSERT on `vocab_entry` to the learner role -> the catalogue rule must catch it
 *   8. drop the deletion role's `learner_preparation` policy -> the owned rule must catch it (EXAM-S1)
 *   C-03: leak private editorial table/column privileges to each runtime role or PUBLIC,
 *         or remove/disable append-only guards and the baseline insert seal -> must fail
 *
 * A check that passes on both the tree and a mutant proves nothing. The control leg proves the
 * opposite failure mode is impossible: the same fixture PASSES before any mutation, so a
 * mutation failing is the mutation, not a broken run.
 *
 * Safety: disposable PostgreSQL only (`OWNAPI_PG_*`). Synthetic data. No provider call.
 *
 * Run: node --test tools/table-class-check.test.mjs
 *      (or `node tools/table-class-check.test.mjs`, which runs the same legs.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { ACCOUNT_TABLES } from '../server/owned-postgres/adapter.mjs';
import { runTableClassCheck } from './table-class-check.mjs';
import { PRIVATE_REVIEW_TABLES } from './lib/catalogue.mjs';
import { providerFixtureAllowed } from './provider-table-class-check.mjs';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

test('telemetry fixture guard: exact local and Actions targets only, without connecting', () => {
  const local = {OWNAPI_PG_ALLOW:'1', OWNAPI_PG_HOST:'127.0.0.1', OWNAPI_PG_PORT:'62563', OWNAPI_PG_DATABASE:'hatoove_spike'};
  const actions = {...local, OWNAPI_PG_PORT:'5432', OWNAPI_PG_DATABASE:'hatoove_ci', CI:'true', GITHUB_ACTIONS:'true'};
  assert.equal(providerFixtureAllowed(local), true);
  assert.equal(providerFixtureAllowed(actions), true);
  for (const valid of [local,actions]) for (const change of [
    {OWNAPI_PG_ALLOW:undefined}, {OWNAPI_PG_ALLOW:'true'}, {OWNAPI_PG_HOST:'localhost'},
    {OWNAPI_PG_HOST:'192.0.2.1'}, {OWNAPI_PG_PORT:'55440'}, {OWNAPI_PG_PORT:'4300'},
    {OWNAPI_PG_PORT:undefined}, {OWNAPI_PG_DATABASE:'hatoove'}, {OWNAPI_PG_DATABASE:undefined},
  ]) assert.equal(providerFixtureAllowed({...valid,...change}), false, JSON.stringify(change));
  for (const change of [{CI:undefined}, {GITHUB_ACTIONS:undefined}, {CI:'1'}, {GITHUB_ACTIONS:'1'},
    {OWNAPI_PG_DATABASE:'hatoove_spike'}, {OWNAPI_PG_PORT:'62563'}]) {
    assert.equal(providerFixtureAllowed({...actions,...change}), false, JSON.stringify(change));
  }
  assert.equal(providerFixtureAllowed({...local,OWNAPI_PG_PORT:'5432'}), false);
  assert.equal(providerFixtureAllowed({...local,OWNAPI_PG_DATABASE:'hatoove_ci'}), false);
});

/** A fresh disposable schema + roles, dropped afterwards. Never the installation schema. */
async function withFixture(run) {
  assert.equal(providerFixtureAllowed(process.env), true, 'Explicit assigned disposable PostgreSQL required before creating a fixture');
  const db = await createFixture();
  try {
    assert.notEqual(db.schema, process.env.OWNAPI_PG_SCHEMA || 'hatoove',
      'the fixture must be a scratch schema, not the installation schema');
    return await run(db);
  } finally {
    await db.cleanup();
    const verifier = new db.admin.constructor({ ...db.config, max: 1 });
    try {
      const remaining = await verifier.query(`SELECT
        EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS schema_exists,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles_exist`, [db.schema, Object.values(db.roles)]);
      assert.deepEqual(remaining.rows[0], { schema_exists: false, roles_exist: false }, 'fixture schema and every generated role were removed');
    } finally { await verifier.end(); }
  }
}

const classify = (db, options = {}) =>
  runTableClassCheck({ db: db.admin, schema: db.schema, roles: db.roles, ...options });

const failureFor = (report, table) => report.failures.find((r) => r.table === table);

/** The original mutation verdicts remain separate from the C-03 controls. */
const detected = [];

test('control: the check passes on the unmutated scratch schema', async () => {
  await withFixture(async (db) => {
    const report = await classify(db);
    assert.equal(report.ok, true, `the unmutated fixture must pass; failures: ${JSON.stringify(report.failures)}`);
    assert.ok(report.rows.length >= 15, 'every table is reported');
    assert.equal(report.findings.length, 0, 'a disposable fixture has no migration ledger to find a checksum on');
  });
});

test('mutation 1: dropping one owner policy must fail the owned rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    await db.admin.query(`DROP POLICY owned_attempts ON ${quote(db.schema)}.attempts`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail after dropping a policy');
    const failure = failureFor(report, 'attempts');
    assert.ok(failure, 'attempts must be flagged');
    assert.match(failure.detail, /no owner policy for the learner role/);
    detected.push('drop one owner policy');
  });
});

test('mutation 2: removing a table from ACCOUNT_TABLES must fail the owned rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    // The drift, exactly: `ACCOUNT_TABLES` is hand-maintained, so a table can be owned and
    // still missing from the deletion read-back. Simulate it by removing `attempts`.
    const withDrift = ACCOUNT_TABLES.filter(([table]) => table !== 'attempts');
    assert.equal(withDrift.length, ACCOUNT_TABLES.length - 1, 'the copy really differs');
    const report = await classify(db, { accountTables: withDrift });
    assert.equal(report.ok, false, 'the check must fail when a table leaves ACCOUNT_TABLES');
    const failure = failureFor(report, 'attempts');
    assert.ok(failure, 'attempts must be flagged');
    assert.match(failure.detail, /absent from ACCOUNT_TABLES/);
    detected.push('remove one table from ACCOUNT_TABLES');
  });
});

test('mutation 3: granting INSERT on task_version to the learner role must fail the shared-content rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    await db.admin.query(`GRANT INSERT ON ${quote(db.schema)}.task_version TO ${quote(db.roles.learner)}`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail after a runtime DML grant on shared content');
    const failure = failureFor(report, 'task_version');
    assert.ok(failure, 'task_version must be flagged');
    assert.match(failure.detail, /shared content grants INSERT/);
    detected.push('grant INSERT on task_version to the learner role');
  });
});

test('mutation 4: adding an unclassified table must fail the unclassified rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    await db.admin.query(`CREATE TABLE ${quote(db.schema)}.mystery_table (id integer PRIMARY KEY)`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail on an unclassified table');
    const failure = failureFor(report, 'mystery_table');
    assert.ok(failure, 'mystery_table must be flagged');
    assert.match(failure.detail, /unclassified table/);
    detected.push('add an unclassified table');
  });
});

test('mutation 5: re-granting SELECT on objective_key to the worker must fail the answer-key rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    // Exactly the grant 0010 made and 0021 revoked: no runtime role may read the key table.
    await db.admin.query(`GRANT SELECT ON ${quote(db.schema)}.objective_key TO ${quote(db.roles.worker)}`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail when a runtime role can read the answer keys');
    const failure = report.failures.find((r) => r.table === 'objective_key' && /answer-key table grants SELECT/.test(r.detail));
    assert.ok(failure, `objective_key must be flagged; failures: ${JSON.stringify(report.failures)}`);
    detected.push('grant SELECT on objective_key to the worker role');
  });
});

test('mutation 6: dropping the deletion role\'s item_evidence policy must fail the owned rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    // Under FORCE RLS the deletion role would then read zero rows, and its read-back would pass
    // whether or not the evidence was gone.
    await db.admin.query(`DROP POLICY deletion_item_evidence ON ${quote(db.schema)}.item_evidence`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail when the deletion read-back would be vacuous');
    const failure = failureFor(report, 'item_evidence');
    assert.ok(failure, 'item_evidence must be flagged');
    assert.match(failure.detail, /no owner-scoped policy for the deletion role/);
    detected.push('drop the deletion policy on item_evidence');
  });
});

test('mutation 7: granting INSERT on a catalogue table to the learner role must fail the catalogue rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    await db.admin.query(`GRANT INSERT ON ${quote(db.schema)}.vocab_entry TO ${quote(db.roles.learner)}`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail after a runtime DML grant on the catalogue');
    const failure = failureFor(report, 'vocab_entry');
    assert.ok(failure, 'vocab_entry must be flagged');
    assert.match(failure.detail, /catalogue grants INSERT/);
    detected.push('grant INSERT on vocab_entry to the learner role');
  });
});

test('mutation 8: dropping the deletion role\'s learner_preparation policy must fail the owned rule', async () => {
  await withFixture(async (db) => {
    assert.equal((await classify(db)).ok, true, 'control: passes before the mutation');
    // EXAM-S1 (0023): preparations are account rows; the deletion read-back must be able to see them.
    await db.admin.query(`DROP POLICY deletion_learner_preparation ON ${quote(db.schema)}.learner_preparation`);
    const report = await classify(db);
    assert.equal(report.ok, false, 'the check must fail when the preparation read-back would be vacuous');
    const failure = failureFor(report, 'learner_preparation');
    assert.ok(failure, 'learner_preparation must be flagged');
    assert.match(failure.detail, /no owner-scoped policy for the deletion role/);
    detected.push('drop the deletion policy on learner_preparation');
  });
});

test('payment mutations: browser ledger authority and service overreach are detected', async () => {
  await withFixture(async db => {
    assert.equal((await classify(db)).ok,true);
    await db.admin.query(`GRANT INSERT ON payment_grant TO ${quote(db.roles.learner)}`);
    assert.match(failureFor(await classify(db),'payment_grant').detail,/payment ledger grants mutation/);
    await db.admin.query(`REVOKE INSERT ON payment_grant FROM ${quote(db.roles.learner)}`);
    await db.admin.query(`GRANT SELECT(email) ON "user" TO ${quote(db.roles.payments)}`);
    assert.match(failureFor(await classify(db),'user').detail,/only user.id/);
    await db.admin.query(`REVOKE SELECT(email) ON "user" FROM ${quote(db.roles.payments)}`);
    await db.admin.query(`GRANT UPDATE(used) ON entitlements TO ${quote(db.roles.payments)}`);
    assert.match(failureFor(await classify(db),'entitlements').detail,/only allowance and expiry/);
  });
});

test('mutation proof: 8/8 original mutations are detected', () => {
  assert.deepEqual(detected, [
    'drop one owner policy',
    'remove one table from ACCOUNT_TABLES',
    'grant INSERT on task_version to the learner role',
    'add an unclassified table',
    'grant SELECT on objective_key to the worker role',
    'drop the deletion policy on item_evidence',
    'grant INSERT on vocab_entry to the learner role',
    'drop the deletion policy on learner_preparation',
  ], 'every mutation must have been applied and caught');
  console.log(`\nmutation proof: ${detected.length}/8 mutations detected\n`);
});

/** Real SQL mutations are rolled back on the same connection used to inspect their catalogue. */
async function withMutation(db, sql, verify) {
  const client = await db.admin.connect();
  // readCatalogue batches independent reads; serialize them on this one transaction connection.
  let pending = Promise.resolve();
  const transaction = { query: (...args) => {
    const result = pending.then(() => client.query(...args));
    pending = result.catch(() => {});
    return result;
  } };
  try {
    await transaction.query('BEGIN');
    assert.equal((await classify(db, { db: transaction })).ok, true, 'control: clean before each private mutation');
    await transaction.query(sql);
    await verify(await classify(db, { db: transaction }), transaction);
  } finally {
    try { await transaction.query('ROLLBACK'); } finally { client.release(); }
  }
  assert.equal((await classify(db)).ok, true, 'control: rollback restores the clean classifier');
}

const privateDetected = [];
async function withPrivateFixture(run) {
  await withFixture(async db => {
    // Persistent deployments also have a provisioner role; exercise it without changing bootstrap.
    const provisioner = `${db.schema}_provisioner`;
    let created = false;
    try {
      await db.admin.query(`CREATE ROLE ${quote(provisioner)} NOLOGIN`);
      created = true;
      db.roles.provisioner = provisioner;
      await run(db);
    } finally {
      if (created) await db.admin.query(`DROP ROLE ${quote(provisioner)}`);
    }
  });
}

for (const table of PRIVATE_REVIEW_TABLES) {
  test(`private editorial: ${table} rejects runtime/PUBLIC table and column access`, async () => {
    await withPrivateFixture(async db => {
      const column = { content_review_authority: 'reviewer_name', content_review_decision: 'rationale', content_review_baseline: 'subject_sha256', explanation_review_target: 'packet_sha256' }[table];
      const target = `${quote(db.schema)}.${quote(table)}`;
      const roles = [...Object.entries(db.roles).filter(([kind]) => kind !== 'migration').map(([, role]) => role), 'PUBLIC'];
      const control = (await classify(db)).rows.find(row => row.table === table);
      assert.equal(control.cls, 'private editorial');
      assert.equal(control.verdict, 'OK');
      for (const role of roles) {
        for (const level of ['table', 'column']) {
          const grantee = role === 'PUBLIC' ? 'PUBLIC' : quote(role);
          const privilege = level === 'column' ? `SELECT(${quote(column)})` : 'SELECT';
          await withMutation(db, `GRANT ${privilege} ON ${target} TO ${grantee}`, async (report, client) => {
            // Verify a real effective read grant, including PUBLIC leaking to an actual runtime role.
            const affectedRole = role === 'PUBLIC' ? db.roles.learner : role;
            const effective = level === 'column'
              ? await client.query('SELECT has_column_privilege($1,$2,$3,\'SELECT\') AS allowed', [affectedRole, target, column])
              : await client.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed', [affectedRole, target]);
            assert.equal(effective.rows[0].allowed, true);
            assert.equal(report.ok, false);
            assert.match(failureFor(report, table)?.detail || '', /private editorial grants SELECT/);
            assert.ok(failureFor(report, table).detail.includes(`to ${role}`));
            privateDetected.push(`${table}:${role}:${level}:SELECT`);
          });
        }
      }
      // The private rule forbids every privilege, not only reads or the existing INSERT/UPDATE/DELETE list.
      for (const role of [db.roles.worker, 'PUBLIC']) {
        await withMutation(db, `GRANT TRUNCATE ON ${target} TO ${role === 'PUBLIC' ? 'PUBLIC' : quote(role)}`, async report => {
          assert.equal(report.ok, false);
          assert.match(failureFor(report, table)?.detail || '', /private editorial grants TRUNCATE/);
          privateDetected.push(`${table}:${role}:TRUNCATE`);
        });
      }
    });
  });

  test(`private editorial: ${table} requires enabled complete immutability guards`, async () => {
    await withFixture(async db => {
      const target = `${quote(db.schema)}.${quote(table)}`;
      const immutable = quote(`${table}_immutable`), truncate = quote(`${table}_no_truncate`);
      const column = { content_review_authority: 'reviewer_name', content_review_decision: 'rationale', content_review_baseline: 'subject_sha256', explanation_review_target: 'packet_sha256' }[table];
      const cases = [
        [`DROP TRIGGER ${immutable} ON ${target}`, /BEFORE UPDATE/, 'drop update/delete'],
        [`ALTER TABLE ${target} DISABLE TRIGGER ${immutable}`, /BEFORE UPDATE/, 'disable update/delete'],
        [`ALTER TABLE ${target} ENABLE REPLICA TRIGGER ${immutable}`, /BEFORE UPDATE/, 'replica-only update/delete'],
        [`DROP TRIGGER ${immutable} ON ${target}; CREATE TRIGGER ${immutable} BEFORE DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION ${quote(db.schema)}.content_immutable()`, /BEFORE UPDATE/, 'delete-only guard'],
        [`DROP TRIGGER ${immutable} ON ${target}; CREATE TRIGGER ${immutable} BEFORE UPDATE OF ${quote(column)} ON ${target} FOR EACH ROW EXECUTE FUNCTION ${quote(db.schema)}.content_immutable(); CREATE TRIGGER c03_delete_guard BEFORE DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION ${quote(db.schema)}.content_immutable()`, /BEFORE UPDATE/, 'column-limited update guard'],
        [`DROP TRIGGER ${immutable} ON ${target}; CREATE TRIGGER ${immutable} BEFORE UPDATE OR DELETE ON ${target} FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${quote(db.schema)}.content_immutable()`, /BEFORE UPDATE/, 'conditional guard'],
        [`DROP TRIGGER ${truncate} ON ${target}`, /BEFORE TRUNCATE/, 'drop truncate'],
        [`ALTER TABLE ${target} DISABLE TRIGGER ${truncate}`, /BEFORE TRUNCATE/, 'disable truncate'],
      ];
      for (const [sql, expected, label] of cases) await withMutation(db, sql, async report => {
        assert.equal(report.ok, false);
        assert.match(failureFor(report, table)?.detail || '', expected);
        privateDetected.push(`${table}:${label}`);
      });
    });
  });
}

test('private editorial: compatibility baseline cannot lose its insert seal', async () => {
  await withFixture(async db => {
    const target = `${quote(db.schema)}.content_review_baseline`;
    for (const sql of [`DROP TRIGGER review_baseline_no_insert ON ${target}`, `ALTER TABLE ${target} DISABLE TRIGGER review_baseline_no_insert`]) {
      await withMutation(db, sql, async report => {
        assert.equal(report.ok, false);
        assert.match(failureFor(report, 'content_review_baseline')?.detail || '', /no enabled baseline seal/);
        privateDetected.push('baseline insert seal');
      });
    }
  });
});

test('private editorial: explanation target requires exact enabled row validation before insert', async () => {
  await withFixture(async db => {
    const target = `${quote(db.schema)}.explanation_review_target`;
    const trigger = 'explanation_review_target_insert';
    const validation = `${quote(db.schema)}.validate_explanation_review_target()`;
    const replace = definition => `DROP TRIGGER ${trigger} ON ${target}; CREATE TRIGGER ${trigger} ${definition}`;
    const cases = [
      [`DROP TRIGGER ${trigger} ON ${target}`, 'missing'],
      [`ALTER TABLE ${target} DISABLE TRIGGER ${trigger}`, 'disabled'],
      [`ALTER TABLE ${target} ENABLE REPLICA TRIGGER ${trigger}`, 'replica-only'],
      [replace(`BEFORE INSERT ON ${target} FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${validation}`), 'conditional'],
      [replace(`AFTER INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION ${validation}`), 'after-only'],
      [replace(`BEFORE INSERT ON ${target} FOR EACH STATEMENT EXECUTE FUNCTION ${validation}`), 'statement-only'],
      [replace(`BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION ${quote(db.schema)}.content_immutable()`), 'wrong function'],
    ];
    for (const [sql, label] of cases) await withMutation(db, sql, async report => {
      assert.equal(report.ok, false);
      assert.match(failureFor(report, 'explanation_review_target')?.detail || '', /no enabled explanation target validation/);
      privateDetected.push(`explanation target insert:${label}`);
    });
  });
});

test('private editorial mutation proof: every privilege and immutability control ran', () => {
  assert.equal(privateDetected.length, 113, '64 SELECT grants including the operator, 8 TRUNCATE grants, 32 immutability faults, 2 baseline seal faults and 7 target validation faults');
  console.log(`\nprivate editorial mutation proof: ${privateDetected.length}/113 mutations detected\n`);
});
