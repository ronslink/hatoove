/**
 * The answer keys are readable by NO runtime role, and marking still works (migration 0021).
 *
 * 0010 granted `objective_key` SELECT to the worker "for marking". Marking never went that way: 0015
 * marks inside `mark_objective_item`, a SECURITY DEFINER function owned by the migration role, and the
 * worker marks writing only. 0021 revokes the grant. `table-class-check` proves the GRANT is gone from
 * the catalogue; this proves the BEHAVIOUR, by executing as each role:
 *
 *   1. the learner role cannot read objective_key (42501)
 *   2. the worker role cannot read objective_key (42501)
 *   3. the worker role cannot use the marking function as an oracle either (42501)
 *   4. the learner marks through the function: the authored answer -> true, a wrong one -> false,
 *      an unknown item -> `unknown_item` (an error, not a silent false)
 *   5. DISCRIMINATION: with the 0010 grant put back in this scratch schema, the worker read SUCCEEDS
 *      and returns keys — so legs 1-2 fail on a tree without 0021, and their 42501 is the missing
 *      grant rather than a broken connection.
 *
 * Safety: a scratch `ownapi_<hex>` schema from `bootstrap.mjs` (every tracked migration from 0010 on,
 * applied from the files), dropped afterwards. The installation schema is never touched. Synthetic only;
 * no provider call. The expected answer is read on the superuser pool solely to drive leg 4.
 *
 * Usage: OWNAPI_PG_* pointing at a disposable database; node tools/objective-key-access-check.mjs
 */

import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const results = [];
async function leg(name, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS ${name}${detail ? `  [${detail}]` : ''}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${name}\n     ${String(error && error.message || error).split('\n')[0]}`);
  }
}
const denied = (e) => e && e.code === '42501';

const db = await createFixture();
try {
  assert.notEqual(db.schema, process.env.OWNAPI_PG_SCHEMA || 'hatoove', 'must be a scratch schema');
  const item = (await db.admin.query(`
    SELECT set_id, version, item_id, answers -> item_id AS expected
      FROM (SELECT set_id, version, answers, (SELECT min(x) FROM jsonb_object_keys(answers) x) AS item_id
              FROM objective_key ORDER BY set_id, version LIMIT 1) k`)).rows[0];
  assert.ok(item && item.item_id, 'the scratch schema holds no answer key (vacuous)');
  const mark = (pool, answer, itemId = item.item_id) => pool.query(
    'SELECT mark_objective_item($1, $2, $3, $4::jsonb) AS correct',
    [item.set_id, item.version, itemId, JSON.stringify(answer)]);

  await leg('the learner role cannot read objective_key', async () => {
    await assert.rejects(db.learner.query('SELECT answers FROM objective_key LIMIT 1'), denied);
    return '42501';
  });
  await leg('the worker role cannot read objective_key', async () => {
    await assert.rejects(db.worker.query('SELECT answers FROM objective_key LIMIT 1'), denied);
    return '42501';
  });
  await leg('the worker role cannot execute the marking function (no answer oracle)', async () => {
    await assert.rejects(mark(db.worker, item.expected), denied);
    return '42501';
  });
  await leg('the learner marks through the SECURITY DEFINER function: right -> true, wrong -> false, unknown -> error', async () => {
    assert.equal((await mark(db.learner, item.expected)).rows[0].correct, true);
    assert.equal((await mark(db.learner, { synthetic: 'wrong' })).rows[0].correct, false);
    await assert.rejects(mark(db.learner, item.expected, 'no-such-item'), /unknown_item/);
    return `${item.set_id}@${item.version} item ${item.item_id}`;
  });
  await leg('DISCRIMINATION: with the 0010 grant restored, the worker read succeeds (legs 1-2 are the grant, not a dead pool)', async () => {
    await db.admin.query(`GRANT SELECT ON ${quote(db.schema)}.objective_key TO ${quote(db.roles.worker)}`);
    try {
      const read = await db.worker.query('SELECT answers FROM objective_key LIMIT 1');
      assert.equal(read.rowCount, 1, 'with the grant, the worker must read a key row');
    } finally {
      await db.admin.query(`REVOKE ALL ON ${quote(db.schema)}.objective_key FROM ${quote(db.roles.worker)}`);
    }
    await assert.rejects(db.worker.query('SELECT 1 FROM objective_key LIMIT 1'), denied);
    return 'granted -> 1 row; revoked again -> 42501';
  });
} finally {
  await db.cleanup();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length && results.length === 5 ? 0 : 1);
