/** Real restricted-role PostgreSQL checks; --live additionally makes one provider request. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {createPostgresWorld} from '../server/owned-postgres/fixture.mjs';
import {createWorker} from '../server/owned-postgres/worker.mjs';
import {validateProviderIdentity,normalizeUsageReceipt,estimateAttemptCost} from '../server/provider-attempt-contract.mjs';
import {DEEPSEEK_PROVIDER_SELECTOR,readDeepSeekConfig,createDeepSeekGrader} from '../server/writing-grader-deepseek.mjs';
import {guardProviderFixture} from './provider-attempt-pg-check.mjs';
guardProviderFixture();
process.env.B1PREP_CONTENT_MODE='internal-preview';
let db,world;
try {
 db=await createFixture();
 const identity=validateProviderIdentity(DEEPSEEK_PROVIDER_SELECTOR);
 const sqlIdentity=(await db.admin.query('SELECT provider_identity($1::jsonb) AS value',[JSON.stringify(identity)])).rows[0].value;
 assert.deepEqual(Object.fromEntries(Object.entries(sqlIdentity).filter(([key])=>key!=='identitySha256')),identity);
 const receipt=normalizeUsageReceipt({usageBasis:'reported',modelReported:'deepseek-flash',inputTokens:1000,cachedInputTokens:200,outputTokens:500,reasoningOutputTokens:null},identity);
 const observation={transportStatus:'response',disposition:'pending',failureCode:null,receipt,receiptCaptured:true,elapsedMs:10,elapsedIssue:null};
 const record={adapter_id:identity.adapterId,transport_mode:identity.transportMode,prompt_version:identity.promptVersion,pricing_card:identity.pricingCard,pricing_sha256:identity.pricingSha256};
 const sqlCost=(await db.admin.query('SELECT provider_observation_value(jsonb_populate_record(NULL::provider_attempt,$1::jsonb),$2::jsonb) AS value',[JSON.stringify(record),JSON.stringify(observation)])).rows[0].value;
 const jsCost=estimateAttemptCost(identity,observation);
 for(const k of ['costStatus','costReason','currency','estimatedAmount','pricingSha256'])assert.equal(sqlCost[k],jsCost[k]);
 await assert.rejects(db.learner.query('SELECT provider_identity($1::jsonb)',[JSON.stringify(identity)]),e=>e.code==='42501');
 await assert.rejects(db.admin.query('SELECT provider_identity($1::jsonb)',[JSON.stringify({...identity,providerId:'synthetic'})]));
 console.log('PASS live identity SQL/JS hash, cost and restricted-role parity');
 world=await createPostgresWorld({fixture:db});
 const port=world.store.port;
 const signup=await world.sessions.signUp({name:'Grading validation',email:`grading-${randomUUID()}@example.invalid`,password:'isolated-grading-validation-only'});
 const owner=(await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]})).userId;
 let prep=(await port.listPreparations(owner)).find(p=>p.exam_id==='telc-deutsch-b1');
 if(!prep)prep=(await port.createPreparation(owner,'telc-deutsch-b1')).preparation;
 await db.admin.query('INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,$2,10,0,0) ON CONFLICT(owner_id,exam_id) DO NOTHING',[owner,'telc-deutsch-b1']);
 const text='Sehr geehrte Damen und Herren, ich schreibe Ihnen wegen meiner Monatskarte. Letzte Woche wurde sie an der Haltestelle nicht erkannt. Der Busfahrer konnte mir leider nicht helfen. Deshalb musste ich ein zusätzliches Ticket kaufen. Ich bitte Sie, meine Karte zu prüfen und mir eine neue zu senden. Bitte teilen Sie mir außerdem mit, ob Sie die zusätzlichen Kosten erstatten können. Die Quittung habe ich aufbewahrt und kann sie Ihnen zusenden. Vielen Dank für Ihre Unterstützung. Mit freundlichen Grüßen';
 const enqueue=async()=>{const a=await port.create(owner,null,null,prep.id);const d=await port.save(owner,a.id,1,text);return port.submit(owner,a.id,d.revision,randomUUID(),'en');};
 const refused=await enqueue();
 const deny=createDeepSeekGrader({apiKey:'isolated-not-used',estimateSpendUsdToday:async()=>15,fetchImpl:()=>{throw Error('must not dispatch');}});
 assert.equal((await createWorker({pool:db.worker,grade:deny,providerIdentity:DEEPSEEK_PROVIDER_SELECTOR}).runOnce()).outcome,'failed');
 const rejected=(await db.admin.query('SELECT o.* FROM provider_attempt a JOIN provider_attempt_observation o USING(attempt_id) WHERE a.submission_id=$1 ORDER BY revision DESC LIMIT 1',[refused.submissionId])).rows[0];
 assert.equal(rejected.transport_status,'definite_not_sent');
 assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM usage_ledger WHERE submission_id=$1',[refused.submissionId])).rows[0].n,0);
 console.log('PASS pre-dispatch refusal preserves submission, refunds credit and records definite_not_sent');
 if(process.argv.includes('--live')){
  const config=readDeepSeekConfig(process.env);assert.equal(config.mode,'live');
  const queued=await enqueue();
  const grade=createDeepSeekGrader({...config,pool:db.worker,dailyUsdLimit:0.05});
  const worker=createWorker({pool:db.worker,grade,providerIdentity:DEEPSEEK_PROVIDER_SELECTOR});
  const result=await worker.runOnce();assert.equal(result.outcome,'succeeded');
  const row=(await db.admin.query('SELECT a.provider_id,a.transport_mode,o.cost_status,o.estimated_amount,o.model_reported FROM provider_attempt a JOIN provider_attempt_observation o USING(attempt_id) WHERE a.submission_id=$1 AND o.disposition=$2',[queued.submissionId,'accepted'])).rows[0];
  assert.equal(row.provider_id,'deepseek');assert.equal(row.transport_mode,'https');assert.equal(row.cost_status,'estimated');
  assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM assessments WHERE submission_id=$1',[queued.submissionId])).rows[0].n,1);
  assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM usage_ledger WHERE submission_id=$1',[queued.submissionId])).rows[0].n,1);
  assert.equal((await worker.runOnce()).claimed,false);
  console.log(JSON.stringify({passed:true,flow:'submission → restricted worker → real provider → saved assessment → one debit',...row}));
 }
}catch(error){console.error(JSON.stringify({passed:false,code:error?.code==='ERR_ASSERTION'?'assertion_failed':'grading_database_check_failed',message:error?.code==='ERR_ASSERTION'?error.message:undefined}));process.exitCode=1;}
finally{await world?.teardown?.();await db?.cleanup?.();}
