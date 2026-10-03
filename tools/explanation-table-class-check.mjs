#!/usr/bin/env node
/** Actual catalogue mutation proof on disposable PostgreSQL only. */
import assert from 'node:assert/strict';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {ACCOUNT_TABLES} from '../server/owned-postgres/adapter.mjs';
import {PROTECTED_EXPLANATION_TABLES,PRIVATE_REVIEW_TABLES} from './lib/catalogue.mjs';
import {runTableClassCheck} from './table-class-check.mjs';

if(process.env.OWNAPI_PG_ALLOW!=='1'||process.env.OWNAPI_PG_HOST!=='127.0.0.1'
  ||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))
  throw Error('Explicit local disposable PostgreSQL required');
const q=value=>'"'+String(value).replaceAll('"','""')+'"';
let db,provisioner,passed=0,failure;
const classify=(client,options={})=>runTableClassCheck({db:client,schema:db.schema,roles:db.roles,...options});
async function mutation(table,sql,expected,options={}){
  const client=await db.admin.connect();
  try{
    await client.query('BEGIN');
    if(sql)await client.query(sql);
    const report=await classify(client,options);
    assert.equal(report.ok,false,'mutation must fail');
    assert.match(report.failures.find(row=>row.table===table)?.detail??'',expected);
    passed++;
  }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
}
try{
  db=await createFixture();assert.match(db.schema,/^ownapi_[a-z0-9_]+$/);
  provisioner=db.schema+'_explanation_provisioner';
  await db.admin.query(`CREATE ROLE ${q(provisioner)} NOLOGIN`);db.roles.provisioner=provisioner;
  const baseline=await classify(db.admin);
  assert.equal(baseline.ok,true,JSON.stringify(baseline.failures));
  const runtime=[...Object.entries(db.roles).filter(([kind])=>kind!=='migration').map(([,role])=>role),'PUBLIC'];
  for(const table of PROTECTED_EXPLANATION_TABLES){
    const target=`${q(db.schema)}.${q(table)}`;
    assert.equal(baseline.rows.find(row=>row.table===table).cls,'protected explanation');
    for(const role of runtime)for(const privilege of ['SELECT','SELECT(language)','TRUNCATE']){
      await mutation(table,`GRANT ${privilege} ON ${target} TO ${role==='PUBLIC'?'PUBLIC':q(role)}`,/protected explanation grants/);
    }
  }
  // C06's reusable review identities are private editorial rows, never learner/account data.
  const reviewTable='explanation_review_target',reviewTarget=`${q(db.schema)}.${q(reviewTable)}`;
  assert(PRIVATE_REVIEW_TABLES.includes(reviewTable),'C06 target must be explicitly classified');
  assert.equal(baseline.rows.find(row=>row.table===reviewTable)?.cls,'private editorial');
  assert(!ACCOUNT_TABLES.some(([table])=>table===reviewTable),'shared review targets must not join owner deletion');
  for(const role of runtime)for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER',
    'SELECT(language)','INSERT(language)','UPDATE(language)','REFERENCES(language)']){
    await mutation(reviewTable,`GRANT ${privilege} ON ${reviewTarget} TO ${role==='PUBLIC'?'PUBLIC':q(role)}`,/private editorial grants/);
  }
  const reviewGuards=[
    ['explanation_review_target_immutable',/immutability trigger/, 'BEFORE UPDATE OR DELETE','content_immutable'],
    ['explanation_review_target_no_truncate',/immutability trigger/, 'BEFORE TRUNCATE','content_immutable'],
    ['explanation_review_target_insert',/explanation target.*(?:validator|INSERT|guard)/i, 'BEFORE INSERT','validate_explanation_review_target'],
  ];
  for(const [name,expected,events,fn] of reviewGuards){
    const row=(await db.admin.query(`SELECT t.tgtype,t.tgenabled,p.proname,n.nspname FROM pg_trigger t
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE t.tgrelid=$1::regclass AND t.tgname=$2 AND NOT t.tgisinternal`,[reviewTarget,name])).rows[0];
    assert(row&&row.proname===fn&&row.nspname===db.schema&&['O','A'].includes(row.tgenabled),'Exact C06 guard missing '+name);
    for(const change of [`DISABLE TRIGGER ${q(name)}`,`ENABLE REPLICA TRIGGER ${q(name)}`])
      await mutation(reviewTable,`ALTER TABLE ${reviewTarget} ${change}`,expected);
    await mutation(reviewTable,`DROP TRIGGER ${q(name)} ON ${reviewTarget}`,expected);
    const each=events==='BEFORE TRUNCATE'?'STATEMENT':'ROW';
    await mutation(reviewTable,`DROP TRIGGER ${q(name)} ON ${reviewTarget}; CREATE TRIGGER ${q(name)} ${events} ON ${reviewTarget}
      FOR EACH ${each} WHEN (false) EXECUTE FUNCTION ${q(db.schema)}.${q(fn)}()`,expected);
    await mutation(reviewTable,`DROP TRIGGER ${q(name)} ON ${reviewTarget}; CREATE TRIGGER ${q(name)} ${events} ON ${reviewTarget}
      FOR EACH ${each} EXECUTE FUNCTION ${q(db.schema)}.sealed_review_baseline()`,expected);
  }
  const shared='objective_explanation_representation',target=`${q(db.schema)}.${q(shared)}`;
  const triggers=(await db.admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal`,[target])).rows;
  for(const {tgname} of triggers){
    // Only immutability guards are relevant; any extra provenance trigger is tested by core checks.
    const definition=(await db.admin.query('SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2',[target,tgname])).rows[0].def;
    if(!/guard_explanation_(representation|truncate)/.test(definition))continue;
    for(const change of [`DISABLE TRIGGER ${q(tgname)}`,`ENABLE REPLICA TRIGGER ${q(tgname)}`])
      await mutation(shared,`ALTER TABLE ${target} ${change}`,/explanation immutability trigger/);
  }
  for(const table of ['writing_explanation_representation','writing_explanation_head']){
    const ownedTarget=`${q(db.schema)}.${q(table)}`;
    const cases=[[db.roles.auth,'SELECT'],[provisioner,'SELECT'],['PUBLIC','SELECT(language)'],
      [db.roles.learner,'INSERT'],[db.roles.learner,'DELETE'],[db.roles.worker,'UPDATE'],
      [db.roles.worker,'TRUNCATE'],[db.roles.deletion,'INSERT']];
    for(const [role,privilege]of cases)await mutation(table,`GRANT ${privilege} ON ${ownedTarget} TO ${role==='PUBLIC'?'PUBLIC':q(role)}`,/owned explanation grants unexpected/);
    await mutation(table,null,/absent from ACCOUNT_TABLES/,{accountTables:ACCOUNT_TABLES.filter(([name])=>name!==table)});
    await mutation(table,`ALTER TABLE ${ownedTarget} NO FORCE ROW LEVEL SECURITY`,/must FORCE ROW LEVEL SECURITY/);
  }
  assert.equal((await classify(db.admin)).ok,true,'all mutations rolled back to green control');
}catch(error){failure=error;}
finally{
  if(db){
    try{if(provisioner)await db.admin.query(`DROP ROLE IF EXISTS ${q(provisioner)}`);}catch(error){failure??=error;}
    delete db.roles.provisioner;
    try{await db.cleanup();}catch(error){failure??=error;}
    const verifier=new db.admin.constructor({...db.config,max:1});
    try{
      const row=(await verifier.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS schema_exists,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS roles_exist`,[db.schema,[...Object.values(db.roles),provisioner].filter(Boolean)])).rows[0];
      assert.deepEqual(row,{schema_exists:false,roles_exist:false});
    }catch(error){failure??=error;}finally{try{await verifier.end();}catch(error){failure??=error;}}
  }
}
if(failure)throw failure;
console.log(`PASS explanation table classification: ${passed} actual mutations detected; fixture cleanup verified`);
