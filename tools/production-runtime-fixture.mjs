/** Synthetic hosting acceptance only. No import-time I/O, credentials or database connections. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createCompleteFixture} from './exam-s5b-fixture.mjs';
import {createListeningFixture} from './exam-s5-fixture.mjs';

export const EXAM = 'telc-deutsch-b1';
export const VERSION = 'v9880';
export const RELEASE = 'v9881';
export const fixturePath = 'content/exams/telc-deutsch-b1/hosting-fixture.json';
const marker = 'hosting_upgrade_rollback_marker';
const pending = '9999-hosting-synthetic-failure';
const tables = ['user','attempts','drafts','submissions','jobs','assessments','usage_ledger','entitlements','provider_attempt','provider_attempt_observation',
  'mock_run','mock_run_event','mock_writing','mock_run_time_group','listening_playback','listening_playback_event','writing_explanation_head','writing_explanation_representation'];
const hash = value => createHash('sha256').update(value).digest('hex');

/** Writes technical media only into the caller's already validated source copy. */
export async function writeSourceFixture(source) {
  assert.ok(path.isAbsolute(source));
  const mediaRoot = path.join(source,'content/exams');
  const complete = await createCompleteFixture({examId:EXAM,mediaRoot,version:VERSION,releaseVersion:VERSION,blueprintVersion:VERSION,durationMs:2000});
  const listening = await createListeningFixture({examId:EXAM,mediaRoot,version:VERSION,releaseVersion:VERSION,blueprintVersion:VERSION,durationMs:2000});
  const practice = listening.forms.find(form=>form.attemptMode==='practice');
  assert.ok(practice && practice.mode==='untimed');
  complete.forms.push(practice);
  for(const row of [...complete.sets,...complete.media,...complete.writingTasks])
    row.source='synthetic:hosting-runtime; technical acceptance only, no human approval';
  await fs.writeFile(path.join(source,fixturePath),JSON.stringify(complete));
  return {examId:EXAM,version:VERSION,releaseVersion:RELEASE,practiceFormId:practice.id,formVersion:practice.version};
}

async function openFixture() {
  const binding = JSON.parse(await fs.readFile('/fixture/binding.json','utf8'));
  assert.match(binding.project,/^hatoove-hosting-[0-9]+-[0-9]+-(local|managed)$/);
  assert.match(binding.schema,/^ownapi_hosting_[0-9]+_[0-9]+_(local|managed)$/);
  assert.equal(binding.database,'hatoove_hosting_synthetic');
  assert.equal(process.env.HOSTING_FIXTURE_ID,binding.project);
  assert.equal(process.env.OWNAPI_PG_ALLOW,'1');
  assert.equal(process.env.B1PREP_CONTENT_MODE,'public');
  const {persistentConfig,createAdminPool,persistentRolePool} = await import('../server/owned-postgres/provision.mjs');
  const config=persistentConfig();
  assert.equal(config.schema,binding.schema);
  assert.equal(config.admin.database,binding.database);
  assert.equal(config.admin.host,binding.variant==='local'?'db':'tls-db.fixture.invalid');
  assert.ok(Object.values(config.roles).every(role=>role.startsWith(binding.schema+'_')));
  const pools=[],errors=[];
  try {
    const admin=createAdminPool(config);pools.push(admin);
    const migration=persistentRolePool(config,'migration');pools.push(migration);
    for(const pool of pools)pool.on('error',()=>errors.push('fixture_pool_error'));
    for(const pool of pools) {
      const row=(await pool.query('SELECT current_schema() AS schema,current_database() AS database')).rows[0];
      assert.equal(row.schema,binding.schema);assert.equal(row.database,binding.database);
    }
    assert.equal((await migration.query('SELECT current_user AS role')).rows[0].role,config.roles.migration);
    return {binding,config,admin,migration,errors,async close(){
      const results=await Promise.allSettled(pools.map(pool=>pool.end()));
      assert.ok(results.every(result=>result.status==='fulfilled'),'fixture_pool_cleanup');
      assert.equal(errors.length,0,'fixture_pool_error');
    }};
  } catch(error) { await Promise.allSettled(pools.map(pool=>pool.end()));throw error; }
}

async function seed(db) {
  const {importPackage} = await import('../server/owned-postgres/package-importer.mjs');
  const {syntheticContentReview} = await import('./exam-s6-fixture.mjs');
  const pkg=JSON.parse(await fs.readFile(new URL('../'+fixturePath,import.meta.url),'utf8'));
  assert.equal(pkg.exam.id,EXAM);assert.equal(pkg.release.version,VERSION);
  assert.equal(pkg.blueprint.version,VERSION);assert.equal(pkg.forms.length,2);
  const mediaRoot=path.resolve('content/exams');
  await importPackage(db.migration,pkg,{mediaRoot});
  // Exact references of these two forms only, including the unchanged seed LV/SB/rubric
  // dependencies. Named review exists solely in this fresh disposable installation.
  const ids=new Set(pkg.forms.flatMap(form=>form.members.map(member=>member.setId+'@'+member.version)));
  for(const task of pkg.writingTasks){ids.add(task.taskId+'@'+task.version);ids.add(task.rubricId+'@'+task.rubricVersion);}
  for(const media of pkg.media)ids.add(media.mediaId+'@'+media.version);
  assert.ok(ids.size>20&&ids.size<100);
  const fixture={schema:db.config.schema,roles:db.config.roles,admin:db.admin,migration:db.migration};
  const client=await db.migration.connect();
  try {
    await client.query('BEGIN');
    for(const id of [...ids].sort()) {
      const row=(await client.query('SELECT exam_id,content_sha256 FROM content_version WHERE content_version_id=$1',[id])).rows[0];
      assert.equal(row?.exam_id,EXAM,'exact fixture reference must exist');
      await syntheticContentReview(fixture,client,{kind:'content',examId:EXAM,subjectId:id,version:'',sha256:row.content_sha256},{mediaRoot});
    }
    const bp=(await client.query('SELECT sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[EXAM,VERSION])).rows[0];
    await syntheticContentReview(fixture,client,{kind:'blueprint',examId:EXAM,subjectId:EXAM,version:VERSION,sha256:bp.sha256},{mediaRoot});
    for(const form of pkg.forms) {
      const row=(await client.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[EXAM,form.id,form.version])).rows[0];
      await syntheticContentReview(fixture,client,{kind:'form',examId:EXAM,subjectId:form.id,version:form.version,sha256:row.sha256},{mediaRoot});
    }
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  await importPackage(db.migration,{...pkg,release:{version:RELEASE,state:'available',resumeBlockedReleases:[]},sets:[],media:[],writingTasks:[],rubrics:[]},{mediaRoot});
  return {reviewedSyntheticTargets:ids.size,releaseVersion:RELEASE};
}

async function snapshot(db) {
  const fields=tables.map(table=>"'"+table+"',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') FROM "+(table==='user'?'"user"':table)+' t)');
  const fingerprints=(await db.admin.query('SELECT jsonb_build_object('+fields.join(',')+') AS value')).rows[0].value;
  const ledger=(await db.migration.query('SELECT id,checksum FROM hatoove_migrations ORDER BY id')).rows;
  const event=(await db.admin.query("SELECT count(*)::integer AS n FROM payment_event WHERE id='evt_hosting_synthetic_bytes'")).rows[0].n;
  const markerPresent=(await db.migration.query('SELECT to_regclass($1) IS NOT NULL AS present',[marker])).rows[0].present;
  return {fingerprints,ledgerHash:hash(JSON.stringify(ledger)),ledgerCount:ledger.length,eventCount:event,markerPresent,pendingRecorded:ledger.some(row=>row.id===pending)};
}

export async function main(args=process.argv.slice(2)) {
  assert.equal(args.length,1);assert.ok(['seed','snapshot','connections'].includes(args[0]));
  const db=await openFixture();let result;
  try {
    if(args[0]==='seed')result=await seed(db);
    else if(args[0]==='snapshot')result=await snapshot(db);
    else {
      assert.match(db.binding.workerAddress,/^\d{1,3}(?:\.\d{1,3}){3}$/);
      const rows=(await db.admin.query('SELECT a.usename AS role,a.client_addr::text AS address,s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.datname=$1 AND a.usename=ANY($2::text[])',[db.binding.database,Object.values(db.config.roles)])).rows;
      result={workerConnected:rows.some(row=>row.role===db.config.roles.worker&&row.address===db.binding.workerAddress),runtimeConnections:rows.length,allTls:rows.length>0&&rows.every(row=>row.ssl)};
    }
  } finally {await db.close();}
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(()=>{console.error('hosting_fixture_failed');process.exitCode=1;});
