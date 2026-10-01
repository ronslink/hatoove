/**
 * MFP-14 — the mutation proof for `tools/table-class-check.mjs`.
 *
 * THIS IS WHAT MAKES THE CHECK EVIDENCE RATHER THAN DECORATION. Each of four mutations is
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
 *
 * A check that passes on both the tree and a mutant proves nothing. The control leg proves the
 * opposite failure mode is impossible: the same fixture PASSES before any mutation, so a
 * mutation failing is the mutation, not a broken run.
 *
 * Safety: disposable PostgreSQL only (`OWNAPI_PG_*`). Synthetic data. No provider call.
 *
 * Run: node --test tools/table-class-check.test.mjs
 *      (or `node tools/table-class-check.test.mjs`, which runs the same legs and prints 4/4.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { ACCOUNT_TABLES } from '../server/owned-postgres/adapter.mjs';
import { runTableClassCheck } from './table-class-check.mjs';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** A fresh disposable schema + roles, dropped afterwards. Never the installation schema. */
async function withFixture(run) {
  const db = await createFixture();
  try {
    assert.notEqual(db.schema, process.env.OWNAPI_PG_SCHEMA || 'hatoove',
      'the fixture must be a scratch schema, not the installation schema');
    return await run(db);
  } finally {
    await db.cleanup();
  }
}

const classify = (db, options = {}) =>
  runTableClassCheck({ db: db.admin, schema: db.schema, roles: db.roles, ...options });

const failureFor = (report, table) => report.failures.find((r) => r.table === table);

/** The four mutation verdicts, so the summary can print `4/4`. */
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

test('mutation proof: 4/4 mutations are detected', () => {
  assert.deepEqual(detected, [
    'drop one owner policy',
    'remove one table from ACCOUNT_TABLES',
    'grant INSERT on task_version to the learner role',
    'add an unclassified table',
  ], 'every mutation must have been applied and caught');
  console.log(`\nmutation proof: ${detected.length}/4 mutations detected\n`);
});
