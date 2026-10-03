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
 *   4. an authenticated synthetic learner marks an exact seeded telc item in an owner-bound
 *      transaction: authored answer -> true, wrong -> false, unknown -> `unknown_item`; missing
 *      owner is separately refused before marking. DTZ publication admission has its own suite.
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
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';

const env=process.env;
const local=env.OWNAPI_PG_PORT==='62563'&&env.OWNAPI_PG_DATABASE==='hatoove_spike';
const ci=env.CI==='true'&&env.GITHUB_ACTIONS==='true'&&env.OWNAPI_PG_PORT==='5432'&&env.OWNAPI_PG_DATABASE==='hatoove_ci';
if(env.OWNAPI_PG_ALLOW!=='1'||env.OWNAPI_PG_HOST!=='127.0.0.1'||(!local&&!ci))throw Error('objective_key_fixture_refused');
const policyKeys=['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'];
const previousPolicy=Object.fromEntries(policyKeys.map(key=>[key,process.env[key]]));
process.env.B1PREP_CONTENT_MODE='internal-preview';
delete process.env.B1PREP_SERVE_REVIEW;
delete process.env.B1PREP_SERVE_RIGHTS;

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

let db,world,observer;
async function asOwner(pool,owner,work) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner??'']);
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
try {
  db=await createFixture();
  const pg=createRequire(new URL('../server/owned-postgres/bootstrap.mjs',import.meta.url))('pg');
  observer=new pg.Pool({...db.config,max:1});
  world=await createPostgresWorld({fixture:db});
  console.log('Fixture '+db.schema+' (synthetic account; seeded telc key; no human review claim)');
  assert.notEqual(db.schema, process.env.OWNAPI_PG_SCHEMA || 'hatoove', 'must be a scratch schema');
  const signup=await world.sessions.signUp({name:'Synthetic key-access fixture',email:`key-${randomUUID()}@example.invalid`,password:'synthetic-key-access-password'});
  const session=await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]});
  assert.ok(session?.userId,'actual synthetic account session required');
  const owner=session.userId;
  assert.ok((await world.store.port.listPreparations(owner)).some(row=>row.exam_id==='telc-deutsch-b1'&&row.state==='active'),'synthetic owner has an active telc preparation');
  const item = (await db.admin.query(`
    SELECT k.set_id,k.version,s.exam_id,i.item_id,k.answers -> i.item_id AS expected
      FROM objective_key k JOIN objective_set s USING(set_id,version)
      CROSS JOIN LATERAL effective_content_review(s.content_version_id) review
      CROSS JOIN LATERAL (SELECT min(x) AS item_id FROM jsonb_object_keys(k.answers) x) i
     WHERE s.exam_id='telc-deutsch-b1' AND NOT review.blocked
     ORDER BY k.set_id,k.version LIMIT 1`)).rows[0];
  assert.ok(item && item.item_id, 'the scratch schema holds no answer key (vacuous)');
  assert.equal(item.exam_id,'telc-deutsch-b1','this key-access control does not bypass DTZ admission');
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
    await assert.rejects(asOwner(db.worker,owner,client=>mark(client,item.expected)), denied);
    return '42501';
  });
  await leg('the learner marks through the SECURITY DEFINER function: right -> true, wrong -> false, unknown -> error', async () => {
    await assert.rejects(asOwner(db.learner,null,client=>mark(client,item.expected)),e=>e.code==='P0002'&&e.message==='not_found');
    assert.equal((await asOwner(db.learner,owner,client=>mark(client,item.expected))).rows[0].correct, true);
    assert.equal((await asOwner(db.learner,owner,client=>mark(client,{ synthetic: 'wrong' }))).rows[0].correct, false);
    await assert.rejects(asOwner(db.learner,owner,client=>mark(client,item.expected,'no-such-item')),e=>e.code==='P0002'&&e.message==='unknown_item');
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
  const errors=[];
  if(world)try{await world.teardown();}catch(error){errors.push(error);}
  if(db)try{await db.cleanup();}catch(error){errors.push(error);}
  if(observer&&db)try{
    assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1',[db.schema])).rows[0].n,0);
    assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1::text[])',[Object.values(db.roles)])).rows[0].n,0);
  }catch(error){errors.push(error);}
  if(observer)try{await observer.end();}catch(error){errors.push(error);}
  for(const key of policyKeys){if(previousPolicy[key]===undefined)delete process.env[key];else process.env[key]=previousPolicy[key];}
  if(errors.length)throw Error('objective_key_fixture_cleanup_failed');
}
console.log('Disposable fixture schema and roles verified absent; policy environment restored.');

const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length && results.length === 5 ? 0 : 1);
