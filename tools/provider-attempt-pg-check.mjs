import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createPostgresAccountDeletion} from '../server/owned-postgres/adapter.mjs';
import {createWorker,stubGrade} from '../server/owned-postgres/worker.mjs';
import {validateProviderIdentity,normalizeUsageReceipt} from '../server/provider-attempt-contract.mjs';
import {beginProviderAttempt,appendProviderObservation,readProviderUsageSummary,readOwnProviderAttempts} from '../server/owned-postgres/provider-attempts.mjs';
import {syntheticContentReview,publishCompleteDtzFixture} from './exam-s6-fixture.mjs';
import {createExamCatalogue} from '../server/preparation-contract.mjs';

export function guardProviderFixture(env=process.env){
 const local=env.OWNAPI_PG_PORT==='62563'&&env.OWNAPI_PG_DATABASE==='hatoove_spike';
 const ci=env.CI==='true'&&env.GITHUB_ACTIONS==='true'&&env.OWNAPI_PG_PORT==='5432'&&env.OWNAPI_PG_DATABASE==='hatoove_ci';
 if(env.OWNAPI_PG_ALLOW!=='1'||env.OWNAPI_PG_HOST!=='127.0.0.1'||(!local&&!ci))throw Error('provider_fixture_refused');
}
const text='Sehr geehrte Frau Weber, vielen Dank für Ihre Nachricht. Ich komme am Freitag und bringe die Unterlagen mit. Mit freundlichen Grüßen';
const privateValue='private_fixture_sentinel_DO_NOT_STORE';
const identity=validateProviderIdentity({adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-usd-v1'},{builtin:false});
const raw={usageBasis:'reported',modelReported:'fixture-model-a',inputTokens:10,outputTokens:5,cachedInputTokens:2,reasoningOutputTokens:null};
const placeholder={transportStatus:'uncertain',disposition:'pending',failureCode:null,receipt:{modelReported:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,reasoningOutputTokens:null,usageBasis:'missing',receiptIssue:null},receiptCaptured:false,elapsedMs:null,elapsedIssue:'unavailable'};
const response={transportStatus:'response',disposition:'pending',failureCode:null,receipt:normalizeUsageReceipt(raw,identity),receiptCaptured:true,elapsedMs:12,elapsedIssue:null};
const gate=()=>{let open;const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('provider_fixture_gate_timeout')),15000);open=value=>{clearTimeout(timer);resolve(value);};});return {open,ready};};
async function tx(pool,work,{owner=null,readOnly=false}={}){const c=await pool.connect();try{await c.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');if(owner)await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[owner]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
export async function main(){
 guardProviderFixture();const pg=createRequire(new URL('../server/owned-postgres/bootstrap.mjs',import.meta.url))('pg');let db,world,port,observer,mediaRoot,passed=0;const saved=process.env.B1PREP_CONTENT_MODE;
 const catalogue=createExamCatalogue({enabled:['telc-deutsch-b1','dtz-a2-b1']});
 const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
 const one=async(sql,args=[])=>(await db.admin.query(sql,args)).rows[0];
 async function queued({owner=null,examId='telc-deutsch-b1',binding=null}={}){
  if(!owner){const signup=await world.sessions.signUp({name:'Synthetic invocation',email:'provider-'+randomUUID()+'@example.invalid',password:'synthetic-provider-password'});owner=(await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]})).userId;}
  let prep=(await port.listPreparations(owner)).find(p=>p.exam_id===examId);
  if(!prep){prep=(await port.createPreparation(owner,examId)).preparation;await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,10,0,0)',[owner,examId]);}
  const attempt=await port.create(owner,null,binding,prep.id);const draft=await port.save(owner,attempt.id,1,text);const receipt=await port.submit(owner,attempt.id,draft.revision,randomUUID(),'de');return {owner,attempt,submissionId:receipt.submissionId};
 }
 async function claim(q){const token=randomUUID();const job=await one("UPDATE jobs SET status='running',tries=tries+1,lease_token=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE submission_id=$1 AND status='queued' RETURNING *",[q.submissionId,token]);return {...q,job,token};}
 async function intent(q,i=identity){return tx(db.worker,c=>beginProviderAttempt(c,{jobId:q.job.id,leaseToken:q.token,identity:i}));}
 const command=(id,observation=response,revision=0,eventId=randomUUID())=>({attemptId:id,eventId,expectedRevision:revision,observation});
 async function rows(q){return (await db.admin.query('SELECT o.* FROM provider_attempt a LEFT JOIN provider_attempt_observation o USING(attempt_id) WHERE a.submission_id=$1 ORDER BY revision',[q.submissionId])).rows;}
 async function counts(q){return one('SELECT (SELECT count(*)::int FROM provider_attempt WHERE submission_id=$1) AS intents,(SELECT count(*)::int FROM assessments WHERE submission_id=$1) AS assessments,(SELECT count(*)::int FROM usage_ledger WHERE submission_id=$1) AS debits',[q.submissionId]);}
 function wrapped(intercept){return {query:(...args)=>db.worker.query(...args),async connect(){const c=await db.worker.connect();return {release:()=>c.release(),query:(sql,args)=>intercept(sql,args,c)};}};}
 async function blocking(blocker){for(let n=0;n<160;n++){const r=await one('SELECT pid,query,wait_event FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1',[blocker]);if(r?.wait_event==='advisory')return r;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Actual backend advisory wait not observed');}
 function pausedPool(match){const reached=gate(),release=gate();let once=false;return {reached:reached.ready,release:release.open,pool:wrapped(async(sql,args,c)=>{const r=await c.query(sql,args);if(!once&&match(String(sql))){once=true;reached.open((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.ready;}return r;})};}
 const currentWindow=()=>({from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()-1).toISOString()});
 async function review(q,decision){const c=await one('SELECT c.content_version_id,c.content_sha256,c.exam_id FROM task_version t JOIN content_version c USING(content_version_id) WHERE t.task_id=$1 AND t.version=$2',[q.attempt.task_id,q.attempt.task_version]);return tx(db.migration,client=>syntheticContentReview(db,client,{kind:'content',examId:c.exam_id,subjectId:c.content_version_id,version:'',sha256:c.content_sha256},{decision}));}
 async function historicalIntent(q,createdAt,selectedIdentity=identity){
  // Explicit synthetic temporal row, checked by the real insert guards; no trigger disabling/backfill path.
  const client=await db.worker.connect();let row;
  try{await client.query('BEGIN');const a=await beginProviderAttempt(client,{jobId:q.job.id,leaseToken:q.token,identity:selectedIdentity});row=(await client.query('SELECT to_jsonb(a) AS value FROM provider_attempt a WHERE attempt_id=$1',[a.attemptId])).rows[0].value;await client.query('ROLLBACK');}finally{client.release();}
  row.created_at=createdAt;await db.admin.query('INSERT INTO provider_attempt SELECT * FROM jsonb_populate_record(NULL::provider_attempt,$1::jsonb)',[JSON.stringify(row)]);return row.attempt_id;
 }
 try{
  process.env.B1PREP_CONTENT_MODE='internal-preview';db=await createFixture();world=await createPostgresWorld({fixture:db,examCatalogue:catalogue});port=world.store.port;
  observer=new pg.Pool({host:'127.0.0.1',port:Number(process.env.OWNAPI_PG_PORT),database:process.env.OWNAPI_PG_DATABASE,user:process.env.OWNAPI_PG_USER||'postgres',max:1});
  console.log('Fixture '+db.schema);
  await check('restricted roles deny every raw write and learner/auth/payment telemetry reads',async()=>{
   for(const role of ['learner','auth','payments'])for(const table of ['provider_attempt','provider_attempt_observation'])await assert.rejects(db[role].query('SELECT * FROM '+table),e=>e.code==='42501');
   for(const table of ['provider_attempt','provider_attempt_observation'])for(const sql of ['INSERT INTO '+table+' DEFAULT VALUES','UPDATE '+table+' SET owner_id=owner_id','DELETE FROM '+table,'TRUNCATE '+table])await assert.rejects(db.worker.query(sql),e=>e.code==='42501');
   assert.equal((await one("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('provider_attempt','provider_attempt_observation') AND relrowsecurity AND relforcerowsecurity",[db.schema])).n,2);
  });
  await check('actual default worker persists not-applicable receipt and five explanations with one debit',async()=>{
   const q=await queued();assert.equal((await createWorker({pool:db.worker}).runOnce()).outcome,'succeeded');assert.deepEqual(await counts(q),{intents:1,assessments:1,debits:1});const observed=await rows(q);assert.equal(observed.length,2);assert.equal(observed[1].disposition,'accepted');assert.equal(observed[1].cost_status,'not_applicable');assert.equal(observed[1].input_tokens,null);assert.equal((await one('SELECT count(*)::int AS n FROM writing_explanation_representation WHERE submission_id=$1',[q.submissionId])).n,5);
   const before=await counts(q);await port.result(q.owner,q.submissionId);await port.listAttempts(q.owner,{preparationId:q.attempt.preparation_id});const exported=await port.exportData(q.owner);assert.equal(exported.provider_attempts.length,1);assert(!JSON.stringify(exported.provider_attempts).includes('owner_id'));assert.deepEqual(await counts(q),before);
  });
  await check('synthetic captured receipt survives malformed feedback and arbitrary thrown error safely',async()=>{
   for(const malformed of [true,false]){const q=await queued();const result=await createWorker({pool:db.worker,providerIdentity:{adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-usd-v1'},grade:(_,ctx)=>{ctx.captureUsage(raw);if(malformed)return {feedback:{total:45}};throw Object.assign(Error(privateValue),{code:privateValue});}}).runOnce();assert.equal(result.code,malformed?'invalid_assessment':'grader_error');const r=(await rows(q)).at(-1);assert.equal(r.cost_status,'estimated');assert.equal(r.estimated_amount,'0.000037');assert.equal(r.input_tokens,'10');assert.equal(r.disposition,malformed?'rejected':'failed');assert(!JSON.stringify(r).includes(privateValue));assert.equal((await counts(q)).debits,0);}
  });
  await check('missing receipt and unknown reported model never become fabricated zero',async()=>{
   for(const unknown of [false,true]){const q=await queued();await createWorker({pool:db.worker,grade:(input,ctx)=>{if(unknown)ctx.captureUsage({...raw,modelReported:privateValue});return stubGrade(input);}}).runOnce();const r=(await rows(q)).at(-1);assert.equal(r.cost_status,'unknown');assert.equal(r.estimated_amount,null);assert.equal(r.model_reported,null);assert(!JSON.stringify(r).includes(privateValue));}
  });
  await check('every falsy grader throw maps to grader_error with captured or missing receipt',async()=>{
   for(const value of [null,undefined,false,0,''])for(const captured of [false,true]){const q=await queued();let calls=0;const result=await createWorker({pool:db.worker,providerIdentity:{adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-usd-v1'},grade:(_,ctx)=>{calls++;if(captured)ctx.captureUsage(raw);throw value;}}).runOnce();assert.equal(calls,1);assert.equal(result.code,'grader_error');assert.equal(result.outcome,'failed');const r=(await rows(q)).at(-1);assert.equal(r.failure_code,'grader_error');assert.equal(r.disposition,'failed');assert.equal(r.transport_status,captured?'response':'uncertain');assert.equal(r.input_tokens,captured?'10':null);assert.deepEqual(await counts(q),{intents:1,assessments:0,debits:0});}
  });
  await check('same-claim begin replay and changed identity cannot dispatch a second invocation',async()=>{
   const q=await claim(await queued()),a=await intent(q);assert.equal(a.created,true);assert.deepEqual(await intent(q),{attemptId:a.attemptId,created:false});await assert.rejects(intent(q,validateProviderIdentity(undefined,{builtin:false})),/provider_identity_invalid/);assert.equal((await counts(q)).intents,1);
   await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[q.job.id]);await createWorker({pool:db.worker}).reclaimExpired();await createWorker({pool:db.worker}).runOnce();assert.deepEqual(await counts(q),{intents:2,assessments:1,debits:1});
  });
  await check('event replay precedes later head CAS; changed replay and stale CAS fail',async()=>{
   const q=await claim(await queued()),a=await intent(q),first=command(a.attemptId);const recorded=await tx(db.worker,c=>appendProviderObservation(c,first));assert.equal(recorded.revision,1);
   const second=command(a.attemptId,{...response,disposition:'failed',failureCode:'grader_error'},1);await tx(db.worker,c=>appendProviderObservation(c,second));const replay=await tx(db.worker,c=>appendProviderObservation(c,first));assert.equal(replay.replay,true);assert.equal(replay.revision,1);
   await assert.rejects(tx(db.worker,c=>appendProviderObservation(c,{...first,observation:{...response,elapsedMs:99}})),/provider_event_conflict/);await assert.rejects(tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,response,0))),/provider_head_conflict/);
   await assert.rejects(tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,response,2))),/provider_observation_invalid/);
   await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[q.job.id]);await createWorker({pool:db.worker,maxTries:1}).reclaimExpired();assert.equal((await rows(q)).at(-1).disposition,'failed');
  });
  await check('standalone accepted append fails deferred persisted completion assertion',async()=>{
   const q=await claim(await queued()),a=await intent(q);await assert.rejects(tx(db.worker,c=>appendProviderObservation(c,{...command(a.attemptId,{...response,disposition:'accepted'}),leaseToken:q.token})),/provider_observation_invalid/);assert.equal((await rows(q))[0].event_id,null);
   await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[q.job.id]);await createWorker({pool:db.worker,maxTries:1}).reclaimExpired();
  });
  await check('malicious SQL registry/receipt/money/identity shapes fail and immutable raw owner writes are rejected',async()=>{
   const q=await claim(await queued());for(const delta of [{providerId:privateValue},{pricingCardId:privateValue},{promptVersion:privateValue},{pricingSha256:'0'.repeat(64)},{pricingCard:{...identity.pricingCard,inputRate:'99'}}])await assert.rejects(intent(q,{...identity,...delta}),/provider_identity_invalid/);
   const a=await intent(q);for(const value of [{...response,estimatedAmount:'0'},{...response,receipt:{...response.receipt,modelReported:privateValue}},{...response,receipt:{...response.receipt,inputTokens:'10'}},{...response,receipt:{...response.receipt,reasoningOutputTokens:99}},{...response,receiptCaptured:false},{...response,receipt:{...response.receipt,receiptIssue:privateValue}}])await assert.rejects(tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,value))),/provider_observation_invalid/);
   await tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,response)));for(const table of ['provider_attempt','provider_attempt_observation']){await assert.rejects(db.admin.query('UPDATE '+table+' SET owner_id=owner_id WHERE submission_id=$1',[q.submissionId]),/provider_(identity|observation)_invalid/);await assert.rejects(db.admin.query('TRUNCATE '+table+' CASCADE'),/provider_observation_invalid/);}
   assert(!JSON.stringify(await rows(q)).includes(privateValue));await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();assert.equal((await rows(q)).at(-1).input_tokens,'10');assert.equal((await rows(q)).at(-1).transport_status,'response');
  });
  await check('raw SQL rejects null claim authorization and normalizes integral numeric spellings before replay hash',async()=>{
   const q=await claim(await queued());await db.admin.query('UPDATE jobs SET lease_token=NULL WHERE id=$1',[q.job.id]);await assert.rejects(intent({...q,token:null}),/provider_intent_failed/);await db.admin.query('UPDATE jobs SET lease_token=$2 WHERE id=$1',[q.job.id,q.token]);const a=await intent(q),event=randomUUID();
   const decimal=JSON.stringify(response).replace('"inputTokens":10','"inputTokens":1e1').replace('"outputTokens":5','"outputTokens":5.0').replace('"elapsedMs":12','"elapsedMs":12.0');
   const row=await tx(db.worker,async c=>(await c.query('SELECT * FROM append_provider_observation($1,$2,0,$3::jsonb,NULL)',[a.attemptId,event,decimal])).rows[0]);assert.equal(row.revision,1);
   assert.equal((await tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,response,0,event)))).replay,true);
   await db.admin.query('UPDATE jobs SET lease_token=NULL WHERE id=$1',[q.job.id]);
   // This must fail at append, before the separate deferred completion assertion could run.
   const accepted=command(a.attemptId,{...response,disposition:'accepted'},1),client=await db.worker.connect();
   try{await client.query('BEGIN');await assert.rejects(appendProviderObservation(client,accepted),/provider_observation_invalid/);}finally{await client.query('ROLLBACK');client.release();}
   // Rollback-only old-behavior mutant proves that this exact query assertion distinguishes the token fix.
   const mutation=await db.admin.connect();try{await mutation.query('BEGIN');const definition=(await mutation.query("SELECT pg_get_functiondef('append_provider_observation(uuid,uuid,integer,jsonb,uuid)'::regprocedure) AS source")).rows[0].source;
    const needle="j.status<>'running' OR p_lease_token IS NULL OR j.lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token";assert(definition.includes(needle));await mutation.query(definition.replace(needle,"j.status<>'running' OR j.lease_token IS DISTINCT FROM p_lease_token"));await mutation.query('SET LOCAL ROLE "'+db.roles.worker+'"');const allowed=await appendProviderObservation(mutation,accepted);assert.equal(allowed.revision,2);
   }finally{await mutation.query('ROLLBACK');mutation.release();}
   await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();
  });
  await check('before-intent rollback and post-receipt pre-assessment fault remain explicit unknown/durable facts',async()=>{
   let q=await queued(),calls=0;let pool=wrapped(async(sql,args,c)=>{const value=await c.query(sql,args);if(String(sql).includes('begin_provider_attempt')){assert.equal(value.rows[0].created,true);throw Error(privateValue);}return value;});await assert.rejects(createWorker({pool,grade:input=>{calls++;return stubGrade(input);}}).runOnce(),/provider_intent_failed/);assert.equal(calls,0);assert.deepEqual(await counts(q),{intents:0,assessments:0,debits:0});await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();
   q=await queued();pool=wrapped((sql,args,c)=>{if(String(sql).includes('INSERT INTO assessments'))throw Error(privateValue);return c.query(sql,args);});await assert.rejects(createWorker({pool,grade:(input,ctx)=>{ctx.captureUsage(raw);return stubGrade(input);}}).runOnce(),/provider_observation_failed/);assert.deepEqual(await counts(q),{intents:1,assessments:0,debits:0});assert.equal((await rows(q)).at(-1).disposition,'pending');await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();const retired=(await rows(q)).at(-1);assert.equal(retired.disposition,'failed');assert.equal(retired.input_tokens,'10');
  });
  await check('two actual workers cannot dispatch one legitimate claim twice',async()=>{
   const q=await queued(),started=gate(),release=gate();let calls=0;const grade=async(input,ctx)=>{calls++;ctx.captureUsage(raw);started.open();await release.ready;return stubGrade(input);};const run=createWorker({pool:db.worker,grade}).runOnce();await started.ready;const other=await createWorker({pool:db.worker,grade}).runOnce();assert.equal(other.claimed,false);release.open();await run;assert.equal(calls,1);assert.equal((await counts(q)).debits,1);
  });
  await check('actual worker closure keeps late callbacks inert after fulfillment/rejection and sticky conflicts do not invalidate grades',async()=>{
   for(const throws of [false,true]){const q=await queued();let callback;const result=await createWorker({pool:db.worker,grade:(input,ctx)=>{callback=ctx.captureUsage;ctx.captureUsage(raw);if(throws)throw Error(privateValue);return stubGrade(input);}}).runOnce();assert.equal(result.outcome,throws?'failed':'succeeded');const before=JSON.stringify(await rows(q));assert.equal(callback({...raw,modelReported:privateValue}).code,'capture_closed');assert.equal(JSON.stringify(await rows(q)),before);}
   const q=await queued();await createWorker({pool:db.worker,providerIdentity:{adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-usd-v1'},grade:(input,ctx)=>{ctx.captureUsage(raw);ctx.captureUsage({...raw,inputTokens:11});ctx.captureUsage({usageBasis:privateValue});return stubGrade(input);}}).runOnce();const r=(await rows(q)).at(-1);assert.equal(r.disposition,'accepted');assert.equal(r.receipt_issue,'conflicting_receipt');assert.equal(r.input_tokens,'10');assert.equal(r.cost_status,'unknown');assert(!JSON.stringify(r).includes(privateValue));
  });
  await check('worker-known nondispatch remains definite and actual hard deletion drops original late completion',async()=>{
   const q=await claim(await queued()),a=await intent(q);await tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,{...placeholder,transportStatus:'definite_not_sent',disposition:'skipped',failureCode:'dispatch_not_started'})));
   await assert.rejects(tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,{...response,disposition:'skipped',failureCode:'dispatch_not_started'},1))),/provider_observation_invalid/);await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();assert.equal((await rows(q)).at(-1).transport_status,'definite_not_sent');
   const lateQ=await queued(),started=gate(),release=gate();const running=createWorker({pool:db.worker,grade:async(input,ctx)=>{ctx.captureUsage(raw);started.open();await release.ready;return stubGrade(input);}}).runOnce();await started.ready;assert.equal((await counts(lateQ)).intents,1);await createPostgresAccountDeletion({pool:db.deletion}).deleteAccount(lateQ.owner);release.open();assert.equal((await running).outcome,'stale');assert.deepEqual(await counts(lateQ),{intents:0,assessments:0,debits:0});
  });
  await check('receipt failure forbids assessment and leaves durable intent for bounded reclaim',async()=>{
   const q=await queued();const pool=wrapped((sql,args,c)=>{if(String(sql).includes('append_provider_observation'))throw Error(privateValue);return c.query(sql,args);});await assert.rejects(createWorker({pool}).runOnce(),/provider_observation_failed/);assert.deepEqual(await counts(q),{intents:1,assessments:0,debits:0});await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE submission_id=$1",[q.submissionId]);await createWorker({pool:db.worker,maxTries:1}).reclaimExpired();assert.equal((await rows(q))[0].cost_status,'unknown');
  });
  await check('unknown intent COMMIT acknowledgement never grants dispatch',async()=>{
   const q=await queued();let calls=0,fault=true;const pool=wrapped(async(sql,args,c)=>{const r=await c.query(sql,args);if(sql==='COMMIT'&&fault){fault=false;throw Error(privateValue);}return r;});await assert.rejects(createWorker({pool,grade:input=>{calls++;return stubGrade(input);}}).runOnce(),/provider_intent_failed/);assert.equal(calls,0);assert.equal((await counts(q)).intents,1);await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE submission_id=$1",[q.submissionId]);await createWorker({pool:db.worker,maxTries:1}).reclaimExpired();
  });
  await check('unknown observation and success acknowledgements replay without duplicate debit',async()=>{
   for(const loseCommit of [2,3]){const q=await queued();let commits=0,calls=0;const pool=wrapped(async(sql,args,c)=>{const r=await c.query(sql,args);if(sql==='COMMIT'&&++commits===loseCommit)throw Error(privateValue);return r;});const result=await createWorker({pool,grade:input=>{calls++;return stubGrade(input);}}).runOnce();assert.equal(result.outcome,'succeeded');assert.equal(calls,1);assert.deepEqual(await counts(q),{intents:1,assessments:1,debits:1});assert.equal((await rows(q)).length,2);}
  });
  await check('reclamation preserves actual response and late receipt enriches only original terminal intent',async()=>{
   const q=await queued(),started=gate(),release=gate();const run=createWorker({pool:db.worker,grade:async(input,ctx)=>{ctx.captureUsage(raw);started.open();await release.ready;return stubGrade(input);}}).runOnce();await started.ready;await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE submission_id=$1",[q.submissionId]);assert.equal((await createWorker({pool:db.worker}).reclaimExpired()).requeued,1);await createWorker({pool:db.worker}).runOnce();release.open();assert.equal((await run).outcome,'stale');assert.deepEqual(await counts(q),{intents:2,assessments:1,debits:1});const r=await rows(q);assert(r.some(x=>x.disposition==='stale'&&x.input_tokens==='10'&&x.receipt_captured));
  });
  await check('coherent report counts latest observations once and keeps unknown/null groups',async()=>{
   const report=await tx(db.worker,c=>readProviderUsageSummary(c,currentWindow()),{readOnly:true});assert(report.totals.intents>0);assert.equal(report.totals.intents,report.groups.reduce((n,g)=>n+g.attempts,0));assert(report.groups.some(g=>g.currency===null));assert.equal(report.realSpend.status,'not_measured');assert.equal(report.queue.workerLiveness,'unobserved');assert(!JSON.stringify(report).includes(privateValue));await assert.rejects(tx(db.worker,c=>readProviderUsageSummary(c,currentWindow())),/provider_report_invalid/);
  });
  await check('actual reclaim versus completion both orders observe owner waits with no duplicate debit',async()=>{
   // Completion commits first: its existing owner fence is held after assessment INSERT.
   let q=await queued();const completion=pausedPool(sql=>sql.includes('INSERT INTO assessments'));const run=createWorker({pool:completion.pool}).runOnce();const completionPid=await completion.reached;
   const reclaim=createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000)}).reclaimExpired();try{assert.match((await blocking(completionPid)).query,/7352/);}finally{completion.release();}
   assert.equal((await run).outcome,'succeeded');assert.deepEqual(await reclaim,{requeued:0,abandoned:0});assert.equal((await counts(q)).debits,1);
   // Reclaim commits first: the original grader is still running, then its receipt waits.
   q=await queued();const started=gate(),releaseGrade=gate();const late=createWorker({pool:db.worker,grade:async(input,ctx)=>{ctx.captureUsage(raw);started.open();await releaseGrade.ready;return stubGrade(input);}}).runOnce();await started.ready;
   const retirement=pausedPool(sql=>sql.includes('hashtextextended($1,7352)'));const retiring=createWorker({pool:retirement.pool,now:()=>new Date(Date.now()+3600000)}).reclaimExpired();const retirePid=await retirement.reached;releaseGrade.open();
   try{assert.match((await blocking(retirePid)).query,/7352/);}finally{retirement.release();}
   assert.equal((await retiring).requeued,1);assert.equal((await late).outcome,'stale');await createWorker({pool:db.worker}).runOnce();assert.deepEqual(await counts(q),{intents:2,assessments:1,debits:1});
  });
  await check('actual reclaim versus deletion both orders and late receipt versus deletion both orders',async()=>{
   for(const operation of ['reclaim','receipt'])for(const first of ['operation','deletion']){
    const q=await claim(await queued()),a=await intent(q),hold=gate(),release=gate();let operationRun,deletionRun,blocker;
    const deleteAccount=createPostgresAccountDeletion({pool:db.deletion,afterStep:async(_index,table,c)=>{if(first==='deletion'&&table==='provider_attempt_observation'){hold.open((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.ready;}}});
    const execute=()=>operation==='reclaim'?createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired():tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId)));
    if(first==='deletion'){
     deletionRun=deleteAccount.deleteAccount(q.owner);blocker=await hold.ready;operationRun=execute();try{assert.equal((await blocking(blocker)).wait_event,'advisory');}finally{release.open();}
    }else if(operation==='reclaim'){
     const pause=pausedPool(sql=>sql.includes('hashtextextended($1,7352)'));operationRun=createWorker({pool:pause.pool,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();blocker=await pause.reached;deletionRun=deleteAccount.deleteAccount(q.owner);try{assert.match((await blocking(blocker)).query,/7352/);}finally{pause.release();release.open();hold.open();}
    }else{
     operationRun=tx(db.worker,async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[q.owner]);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[q.job.exam_id]);await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[q.job.id]);
      await appendProviderObservation(c,command(a.attemptId));
      hold.open((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);await release.ready;
     });blocker=await hold.ready;deletionRun=deleteAccount.deleteAccount(q.owner);try{assert.match((await blocking(blocker)).query,/7352/);}finally{release.open();}
    }
    await Promise.all([operationRun,deletionRun]);assert.deepEqual(await counts(q),{intents:0,assessments:0,debits:0});
   }
  });
  await check('owner-first reclaim discriminator leaves job tuple free while owner blocked; tuple-first mutant fails',async()=>{
   for(const mutant of [false,true]){
    const q=await claim(await queued());await intent(q);const lock=await db.admin.connect();let running,mutantClient;
    try{
     await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[q.owner]);const pid=(await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
     if(mutant){mutantClient=await db.worker.connect();await mutantClient.query('BEGIN');await mutantClient.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[q.job.id]);running=mutantClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))',[q.owner]);}
     else running=createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();
     await blocking(pid);
     const probe=()=>tx(db.admin,c=>c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE NOWAIT',[q.job.id]));
     if(mutant)await assert.rejects(probe(),e=>e.code==='55P03');else await probe();
    }finally{await lock.query('ROLLBACK');lock.release();if(running)await running;if(mutantClient){await mutantClient.query('ROLLBACK');mutantClient.release();}}
    if(mutant)await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();
   }
  });
  await check('finite batch plus one, two reclaimers, and renewed discovery candidate are discriminated',async()=>{
   const list=[];for(let n=0;n<4;n++)list.push(await claim(await queued()));const worker=createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1,reclaimBatchSize:3});assert.equal((await worker.reclaimExpired()).abandoned,3);assert.equal((await worker.reclaimExpired()).abandoned,1);
   const q=await claim(await queued());const pair=await Promise.all([worker.reclaimExpired(),worker.reclaimExpired()]);assert.equal(pair.reduce((n,r)=>n+r.abandoned,0),1);
   const renewed=await claim(await queued());let changed=false;const pool={...db.worker,connect:()=>db.worker.connect(),query:async(sql,args)=>{const r=await db.worker.query(sql,args);if(!changed&&String(sql).includes('ORDER BY lease_until,id LIMIT')){changed=true;await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()+interval '2 hours' WHERE id=$1",[renewed.job.id]);}return r;}};
   assert.deepEqual(await createWorker({pool,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired(),{requeued:0,abandoned:0});await db.admin.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[renewed.job.id]);await worker.reclaimExpired();
  });
  await check('pre/post named-review and rights withdrawal preserve receipt but deny assessment including thrown graders',async()=>{
   for(const kind of ['review','rights'])for(const before of [true,false]){
    let q;if(kind==='rights'){
     mediaRoot??=await mkdtemp(path.join(tmpdir(),'hatoove-provider-usage-'));const pkg=await publishCompleteDtzFixture(db,{mediaRoot,version:before?'v9860':'v9862',availableVersion:before?'v9861':'v9863'}),task=pkg.internal.writingTasks[0];
     q=await queued({examId:'dtz-a2-b1',binding:{taskId:task.taskId,taskVersion:task.version,rubricId:task.rubricId,rubricVersion:task.rubricVersion}});
    }else{q=await queued();await review(q,'approve');}
    const cv=await one('SELECT content_version_id FROM task_version WHERE task_id=$1 AND version=$2',[q.attempt.task_id,q.attempt.task_version]);
    const withdraw=()=>kind==='review'?review(q,'withdraw'):db.migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic invocation test','Disposable rights withdrawal, no human approval')",[cv.content_version_id]);
    const restore=()=>kind==='review'?review(q,'approve'):Promise.resolve();
    let calls=0;try{
     if(before)await withdraw();const started=gate(),release=gate();const run=createWorker({pool:db.worker,examCatalogue:catalogue,grade:async(_,ctx)=>{calls++;ctx.captureUsage(raw);started.open();await release.ready;throw Object.assign(Error(privateValue),{code:privateValue});}}).runOnce();
     if(before){started.open();release.open();}else{await started.ready;await withdraw();release.open();}
     const result=await run;assert.equal(result.code,'content_unavailable');assert.equal(calls,before?0:1);assert.deepEqual(await counts(q),{intents:before?0:1,assessments:0,debits:0});
     if(!before){const row=(await rows(q)).at(-1);assert.equal(row.disposition,'rejected');assert.equal(row.failure_code,'content_unavailable');assert.equal(row.input_tokens,'10');}
    }finally{await restore();}
   }
  });
  await check('explicit historical soft-delete skips both returned and thrown completions without losing receipt',async()=>{
   for(const throws of [false,true]){const q=await queued(),started=gate(),release=gate();const run=createWorker({pool:db.worker,grade:async(input,ctx)=>{ctx.captureUsage(raw);started.open();await release.ready;if(throws)throw Error(privateValue);return stubGrade(input);}}).runOnce();await started.ready;
    // Only a synthetic historical fixture: normal remove(submitted) remains refused.
    await assert.rejects(port.remove(q.owner,q.attempt.id),e=>e.code==='submitted_attempt');await db.admin.query('UPDATE attempts SET deleted_at=clock_timestamp() WHERE id=$1',[q.attempt.id]);release.open();assert.equal((await run).outcome,'skipped');const r=(await rows(q)).at(-1);assert.equal(r.disposition,'skipped');assert.equal(r.failure_code,'attempt_deleted');assert.equal(r.input_tokens,'10');assert.equal((await counts(q)).debits,0);await createWorker({pool:db.worker,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired();
   }
  });
  await check('report exact intent window boundaries and left join preserve old unresolved queue scope',async()=>{
   const from='2026-01-01T00:00:00.000Z',to='2026-01-02T00:00:00.000Z';const dated=[];
   for(const date of ['2025-12-31T23:59:59.999Z',from,'2026-01-01T23:59:59.999Z',to]){const q=await claim(await queued());dated.push({q,id:await historicalIntent(q,date)});}
   const summary=await tx(db.worker,c=>readProviderUsageSummary(c,{from,to}),{readOnly:true});assert.equal(summary.totals.intents,2);assert.equal(summary.totals.withoutObservation,2);assert.equal(summary.totals.unknownCost,2);assert.equal(summary.groups[0].knownEstimatedSubtotal,null);assert.equal(summary.groups[0].latency.p50Ms,null);assert(summary.queue.unresolvedIntents>=4);assert(summary.queue.oldestUnresolvedIntentAgeMs>31*86400000);
   await tx(db.worker,c=>appendProviderObservation(c,command(dated[1].id,response)));const late=await tx(db.worker,c=>readProviderUsageSummary(c,{from,to}),{readOnly:true});assert.equal(late.totals.intents,2);assert.equal(late.totals.estimated,1);assert.equal(late.groups.reduce((n,g)=>n+g.latency.samples,0),1);
   // Queue age uses submission time. This guarded raw INSERT models an old queued historical job.
   const q=await queued();await tx(db.admin,async c=>{await c.query("SELECT set_config('hatoove.owner_id',$1,true)",[q.owner]);const sid=randomUUID();await c.query("INSERT INTO submissions(id,attempt_id,owner_id,event_id,draft_revision,text,task_version,rubric_version,created_at,explanation_language) SELECT $2,attempt_id,owner_id,$3,99,text,task_version,rubric_version,$4,explanation_language FROM submissions WHERE id=$1",[q.submissionId,sid,randomUUID(),from]);await c.query("INSERT INTO jobs(id,submission_id,owner_id,exam_id,status) VALUES($1,$2,$3,$4,'queued')",[randomUUID(),sid,q.owner,q.attempt.exam_id]);await c.query('UPDATE entitlements SET reserved=reserved+1 WHERE owner_id=$1 AND exam_id=$2',[q.owner,q.attempt.exam_id]);});
   const current=await tx(db.worker,c=>readProviderUsageSummary(c,currentWindow()),{readOnly:true});assert(current.queue.oldestQueuedAgeMs>31*86400000);
   for(const d of dated)await createPostgresAccountDeletion({pool:db.deletion}).deleteAccount(d.q.owner);await createPostgresAccountDeletion({pool:db.deletion}).deleteAccount(q.owner);
  });
  await check('concurrent append and account erasure cannot mix an aggregate snapshot',async()=>{
   const q=await claim(await queued()),a={attemptId:await historicalIntent(q,new Date(Date.now()-60000).toISOString())},started=gate(),release=gate();let firstQuery=true;
   const snapshot=tx(db.worker,c=>readProviderUsageSummary({query:async(sql,args)=>{const r=await c.query(sql,args);if(firstQuery){firstQuery=false;started.open();await release.ready;}return r;}},currentWindow()),{readOnly:true});await started.ready;
   await tx(db.worker,c=>appendProviderObservation(c,command(a.attemptId,response)));await createPostgresAccountDeletion({pool:db.deletion}).deleteAccount(q.owner);release.open();const before=await snapshot;const after=await tx(db.worker,c=>readProviderUsageSummary(c,currentWindow()),{readOnly:true});assert.equal(before.totals.intents,after.totals.intents+1);assert.equal(before.totals.withoutObservation,after.totals.withoutObservation+1);assert.equal(before.totals.estimated,after.totals.estimated);
  });
  await check('separate restricted report CLI emits complete safe JSON or fixed outage/configuration errors',async()=>{
   const window=currentWindow(),env={...process.env,OWNAPI_PG_SCHEMA:db.schema,OWNAPI_PG_ROLE_PREFIX:db.schema};const argv=['tools/provider-usage-report.mjs','--from='+window.from,'--to='+window.to];
   const good=spawnSync(process.execPath,argv,{encoding:'utf8',env,timeout:15000});assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(good.stdout).scope,'stub_only_engineering');assert(!good.stdout.includes('owner_id'));assert(!good.stdout.includes('submission_id'));
   const unavailable=spawnSync(process.execPath,argv,{encoding:'utf8',env:{...env,OWNAPI_PG_ROLE_PREFIX:db.schema+'_absent'},timeout:15000});assert.equal(unavailable.status,1);assert.equal(unavailable.stdout,'');assert.deepEqual(JSON.parse(unavailable.stderr),{event:'provider_report_error',code:'provider_report_unavailable'});
   for(const file of ['tools/provider-usage-report.mjs','server/worker.mjs']){const invalid=spawnSync(process.execPath,file.includes('provider')?argv:[file,'--once'],{encoding:'utf8',env:{...env,OWNAPI_PG_SCHEMA:privateValue+'!'},timeout:15000});assert.equal(invalid.status,2);assert(!invalid.stderr.includes(privateValue));assert(!invalid.stdout.includes(privateValue));}
  });
  await check('actual report currencies, zero, partial coverage and nearest-rank latency remain exact',async()=>{
   const window={from:'2026-02-01T00:00:00.000Z',to:'2026-02-02T00:00:00.000Z'},list=[];
   for(const currency of ['usd','eur'])for(const elapsed of [0,10,20,100]){const q=await claim(await queued());list.push(q);const i=validateProviderIdentity({adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-'+currency+'-v1'},{builtin:false}),id=await historicalIntent(q,window.from,i);await tx(db.worker,c=>appendProviderObservation(c,command(id,{...response,elapsedMs:elapsed,receipt:normalizeUsageReceipt({...raw,inputTokens:0,outputTokens:0,cachedInputTokens:0},i)})));}
   const report=await tx(db.worker,c=>readProviderUsageSummary(c,window),{readOnly:true});assert.equal(report.totals.intents,8);assert.deepEqual(report.groups.map(g=>g.currency),['EUR','USD']);for(const g of report.groups){assert.equal(g.knownEstimatedSubtotal,'0');assert.equal(g.usage.input.knownTotal,'0');assert.equal(g.usage.reasoningOutput.knownTotal,null);assert.deepEqual(g.latency,{samples:4,p50Ms:10,p95Ms:100,maxMs:100});}assert.deepEqual(report.realSpend,{status:'not_measured',amount:null});for(const q of list)await createPostgresAccountDeletion({pool:db.deletion}).deleteAccount(q.owner);
  });
  await check('owned export uses only protected snapshot and hard deletion rollback then absence',async()=>{
   const q=await queued();await createWorker({pool:db.worker}).runOnce();assert.equal((await tx(db.learner,c=>readOwnProviderAttempts(c),{owner:q.owner,readOnly:true})).length,1);assert.equal((await tx(db.learner,c=>readOwnProviderAttempts(c),{owner:'absent-owner',readOnly:true})).length,0);
   const before=await counts(q);const failing=createPostgresAccountDeletion({pool:db.deletion,afterStep:(_,table)=>{if(table==='provider_attempt')throw Error('synthetic rollback');}});await assert.rejects(failing.deleteAccount(q.owner));assert.deepEqual(await counts(q),before);
   const attemptId=(await one('SELECT attempt_id FROM provider_attempt WHERE submission_id=$1',[q.submissionId])).attempt_id;const deletion=createPostgresAccountDeletion({pool:db.deletion});assert.equal((await deletion.deleteAccount(q.owner)).verifiedAbsent,true);assert.deepEqual(await counts(q),{intents:0,assessments:0,debits:0});assert.equal((await tx(db.worker,c=>appendProviderObservation(c,command(attemptId)))).status,'deleted');
  });
  await check('same-owner expired jobs across both exams reclaim once with independently scoped refunds',async()=>{
   mediaRoot??=await mkdtemp(path.join(tmpdir(),'hatoove-provider-usage-'));const pkg=await publishCompleteDtzFixture(db,{mediaRoot,version:'v9850',availableVersion:'v9851'}),task=pkg.internal.writingTasks[0];
   const base=await queued(),owner=base.owner,items=[await claim(base),await claim(await queued({owner}))];const binding={taskId:task.taskId,taskVersion:task.version,rubricId:task.rubricId,rubricVersion:task.rubricVersion};
   for(let n=0;n<2;n++)items.push(await claim(await queued({owner,examId:'dtz-a2-b1',binding})));
   for(const q of items)await intent(q);const result=await createWorker({pool:db.worker,examCatalogue:catalogue,now:()=>new Date(Date.now()+3600000),maxTries:1,reclaimBatchSize:3}).reclaimExpired();assert.equal(result.abandoned,3);assert.equal((await createWorker({pool:db.worker,examCatalogue:catalogue,now:()=>new Date(Date.now()+3600000),maxTries:1}).reclaimExpired()).abandoned,1);
   const balances=(await db.admin.query('SELECT exam_id,reserved,used FROM entitlements WHERE owner_id=$1 ORDER BY exam_id',[owner])).rows;assert.equal(balances.length,2);assert(balances.every(b=>b.reserved===0&&b.used===0));assert.equal((await one('SELECT count(*)::int AS n FROM provider_attempt WHERE owner_id=$1',[owner])).n,4);
  });
  await check('actual over-limit intent cohort rejects the whole report without a partial result',async()=>{
   const q=await claim(await queued()),window={from:'2026-03-01T00:00:00.000Z',to:'2026-03-02T00:00:00.000Z'},id=await historicalIntent(q,window.from);
   // Explicit volume fixture, not dispatched calls: duplicate the validated immutable template with distinct claim identities.
   const template=(await one('SELECT to_jsonb(a) AS value FROM provider_attempt a WHERE attempt_id=$1',[id])).value;
   await db.admin.query('INSERT INTO provider_attempt SELECT r.* FROM generate_series(2,100001) n CROSS JOIN LATERAL jsonb_populate_record(NULL::provider_attempt,$1::jsonb||jsonb_build_object(\'attempt_id\',gen_random_uuid(),\'claim_number\',n)) r',[JSON.stringify(template)]);
   assert.equal((await counts(q)).intents,100001);let report;await assert.rejects(tx(db.worker,async c=>{report=await readProviderUsageSummary(c,window);},{readOnly:true}),/provider_report_too_large/);assert.equal(report,undefined);
   // The final fixture teardown removes this volume cohort; account deletion is independently exercised above.
  });
 }finally{
  const errors=[];if(world)try{await world.teardown();}catch(e){errors.push(e);}if(db)try{await db.cleanup();}catch(e){errors.push(e);}
  if(observer&&db)try{assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1',[db.schema])).rows[0].n,0);assert.equal((await observer.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1::text[])',[Object.values(db.roles)])).rows[0].n,0);}catch(e){errors.push(e);}
  if(observer)try{await observer.end();}catch(e){errors.push(e);}if(mediaRoot)try{const target=await realpath(mediaRoot),parent=await realpath(tmpdir());assert.equal(path.dirname(target),parent);assert(path.basename(target).startsWith('hatoove-provider-usage-'));await rm(target,{recursive:true,force:true});}catch(e){errors.push(e);}if(saved===undefined)delete process.env.B1PREP_CONTENT_MODE;else process.env.B1PREP_CONTENT_MODE=saved;if(errors.length)throw Error('provider_fixture_cleanup_failed');
 }
 console.log(`Provider attempts PostgreSQL: ${passed} groups passed; own schema/roles verified absent.`);return 0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error);process.exitCode=1;});
