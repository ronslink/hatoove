import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {validateProviderIdentity,normalizeUsageReceipt,estimateAttemptCost,createUsageCapture,MAX_USAGE_COUNT,sumAmounts} from '../server/provider-attempt-contract.mjs';
import {validateReportWindow,readProviderUsageSummary} from '../server/owned-postgres/provider-attempts.mjs';
import {createWorker,stubGrade} from '../server/owned-postgres/worker.mjs';
import {guardProviderFixture} from './provider-attempt-pg-check.mjs';
const identity=validateProviderIdentity({adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-usd-v1'},{builtin:false});
const raw={modelReported:'fixture-model-a',inputTokens:10,outputTokens:5,cachedInputTokens:2,reasoningOutputTokens:null,usageBasis:'reported'};
const obs=(receipt=normalizeUsageReceipt(raw,identity),extra={})=>({transportStatus:'response',receiptCaptured:true,receipt,...extra});
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const privateValue='private_fixture_sentinel_DO_NOT_STORE';
await check('closed registry and trusted builtin versus injected lookalike',()=>{
 assert.equal(validateProviderIdentity(undefined,{builtin:true}).providerId,'none');assert.equal(validateProviderIdentity(undefined,{builtin:false}).providerId,'synthetic');
 for(const selector of [{adapterId:privateValue,pricingCardId:null},{adapterId:'synthetic-grader-v1',pricingCardId:privateValue},{adapterId:'local-telc-stub-v1',pricingCardId:null}])assert.throws(()=>validateProviderIdentity(selector,{builtin:false}),/provider_identity_invalid/);
 assert.throws(()=>createWorker({pool:{connect(){}},grade:stubGrade,providerIdentity:{adapterId:'local-telc-stub-v1',pricingCardId:null}}),/provider_identity_invalid/);
 assert(Object.isFrozen(identity.pricingCard.modelIds));
});
await check('receipt full strict record shapes and known-field privacy',()=>{
 for(const value of [null,[],{...raw,extra:privateValue},{...raw,inputTokens:true},{...raw,inputTokens:'10'},{...raw,inputTokens:NaN},{...raw,inputTokens:Infinity},{...raw,inputTokens:1.1},{...raw,inputTokens:-0},{...raw,inputTokens:MAX_USAGE_COUNT+1},{...raw,inputTokens:Number.MAX_SAFE_INTEGER+1},{...raw,cachedInputTokens:11},{...raw,inputTokens:null,cachedInputTokens:1},{...raw,usageBasis:'not_applicable'},Object.defineProperty({...raw},'modelReported',{get(){throw Error(privateValue);}})])assert.throws(()=>normalizeUsageReceipt(value,identity),/invalid_receipt/);
 assert.equal(normalizeUsageReceipt({...raw,inputTokens:MAX_USAGE_COUNT},identity).inputTokens,MAX_USAGE_COUNT);
 const sanitized=normalizeUsageReceipt({...raw,modelReported:privateValue},identity);assert.equal(sanitized.modelReported,null);assert.equal(sanitized.receiptIssue,'unrecognised_model');assert(!JSON.stringify(sanitized).includes(privateValue));
});
await check('capture clones immediately and duplicate replay differs from conflict',()=>{
 const capture=createUsageCapture(identity),input={...raw};assert.deepEqual(capture.captureUsage(input),{accepted:true,replay:false});input.inputTokens=900;
 assert.deepEqual(capture.captureUsage(raw),{accepted:true,replay:true});assert.equal(capture.captureUsage({...raw,inputTokens:11}).code,'conflicting_receipt');
 const r=capture.close();assert.equal(r.inputTokens,10);assert.equal(r.receiptIssue,'conflicting_receipt');assert(Object.isFrozen(r));assert.equal(capture.close(),r);assert.equal(capture.captureUsage({modelReported:privateValue}).code,'capture_closed');
});
await check('invalid then valid and valid then invalid retain counters with sticky issue',()=>{
 for(const order of [0,1]){const c=createUsageCapture(identity);if(order)c.captureUsage(raw);c.captureUsage({inputTokens:privateValue});if(!order)c.captureUsage(raw);assert.equal(c.close().inputTokens,10);assert.equal(c.close().receiptIssue,'invalid_receipt');}
 assert.equal(createUsageCapture(identity).close().usageBasis,'missing');const c=createUsageCapture(identity);c.captureUsage({});assert.equal(c.close().usageBasis,'unsupported');
});
await check('worker settlement closure model covers fulfill reject sync throw and held late callback',async()=>{
 for(const mode of ['sync','resolve','reject','throw']){const c=createUsageCapture(identity);let after;const fn=()=>{after=()=>c.captureUsage({...raw,inputTokens:99});c.captureUsage(raw);if(mode==='throw')throw Error(privateValue);return mode==='reject'?Promise.reject(Error(privateValue)):mode==='resolve'?Promise.resolve({}):{};};try{await fn();}catch{}finally{c.close();}assert.equal(after().code,'capture_closed');assert.equal(c.close().inputTokens,10);}
});
await check('exact cost zero is distinct from missing and nullable dimensions',()=>{
 assert.equal(estimateAttemptCost(identity,obs()).estimatedAmount,'0.000037');
 assert.equal(estimateAttemptCost(identity,obs(normalizeUsageReceipt({...raw,inputTokens:0,outputTokens:0,cachedInputTokens:0},identity))).estimatedAmount,'0');
 assert.equal(estimateAttemptCost(identity,null).costReason,'missing_observation');
 for(const key of ['inputTokens','outputTokens','cachedInputTokens'])assert.equal(estimateAttemptCost(identity,obs({...normalizeUsageReceipt(raw,identity),[key]:null,...key==='inputTokens'?{cachedInputTokens:null}:{}})).costReason,'missing_billable_dimension');
 assert.equal(estimateAttemptCost(identity,obs(undefined,{transportStatus:'uncertain'})).costReason,'uncertain_transport');
});
await check('cost confidence and model buckets retain pinned currency',()=>{
 for(const value of [undefined,Object.defineProperty({},'receipt',{get(){throw Error(privateValue);}}),new Proxy({}, {getPrototypeOf(){throw Error(privateValue);}})])assert.throws(()=>estimateAttemptCost(identity,value),e=>e.message==='provider_observation_invalid');
 for(const value of [obs(undefined,{receiptCaptured:false}),obs({...normalizeUsageReceipt(raw,identity),reasoningOutputTokens:99}),obs({...normalizeUsageReceipt(raw,identity),receiptIssue:'unregistered'})])assert.throws(()=>estimateAttemptCost(identity,value),/provider_observation_invalid/);
 for(const [receipt,reason] of [[{...normalizeUsageReceipt(raw,identity),receiptIssue:'invalid_receipt'},'invalid_receipt'],[normalizeUsageReceipt({usageBasis:'unsupported'},identity),'unsupported_usage'],[normalizeUsageReceipt({usageBasis:'missing'},identity),'missing_usage'],[normalizeUsageReceipt({...raw,modelReported:privateValue},identity),'model_unknown'],[normalizeUsageReceipt({...raw,modelReported:'fixture-model-b'},identity),'model_mismatch']]){const c=estimateAttemptCost(identity,obs(receipt));assert.equal(c.costReason,reason);assert.equal(c.currency,'USD');assert.equal(c.estimatedAmount,null);}
 const builtin=validateProviderIdentity(undefined,{builtin:true});assert.equal(estimateAttemptCost(builtin,{transportStatus:'response',receiptCaptured:true,receipt:normalizeUsageReceipt({usageBasis:'not_applicable',modelReported:'stub-grader-v2'},builtin)}).costStatus,'not_applicable');assert.equal(estimateAttemptCost(builtin,null).costStatus,'unknown');
});
function alternate(changes){const card={...identity.pricingCard,...changes};return {...identity,pricingCard:card,pricingSha256:createHash('sha256').update(JSON.stringify(card)).digest('hex')};}
await check('decimal entire input including trailing newline and denominator grammar',()=>{
 const models=[];Object.defineProperty(models,'0',{get(){throw Error(privateValue);},enumerable:true});for(const ids of [models,new Proxy(['fixture-model-a'],{get(){throw Error(privateValue);}})])assert.throws(()=>estimateAttemptCost({...identity,pricingCard:{...identity.pricingCard,modelIds:ids}},obs()),e=>e.message==='provider_identity_invalid');
 assert.throws(()=>estimateAttemptCost({...identity,pricingCardId:null},obs()),/provider_identity_invalid/);assert.throws(()=>estimateAttemptCost(alternate({currency:'EUR'}),obs()),/provider_identity_invalid/);
 const inherited=['fixture-model-a'];let iterated=false;Object.setPrototypeOf(inherited,{[Symbol.iterator](){iterated=true;throw Error(privateValue);}});assert.equal(estimateAttemptCost({...identity,pricingCard:{...identity.pricingCard,modelIds:inherited}},obs()).estimatedAmount,'0.000037');assert.equal(iterated,false);
 for(const rate of ['2\n',' 2','2\r','2e3','01','1.0','-1','+1','1.','0.0000000000001','1000000000000',2])assert.throws(()=>estimateAttemptCost(alternate({inputRate:rate}),obs()),/provider_identity_invalid/);
 for(const unit of [0,2,10,1e9,'1000'])assert.throws(()=>estimateAttemptCost(alternate({unit}),obs()),/provider_identity_invalid/);
});
await check('subset equal-rate collapse and exact independent integer reference at bound',()=>{
 const i=alternate({inputRate:'0.000000000001',cachedInputRate:null,outputRate:'999999999999.999999999999',reasoningOutputRate:null});
 const receipt={...normalizeUsageReceipt(raw,identity),inputTokens:MAX_USAGE_COUNT,outputTokens:MAX_USAGE_COUNT,cachedInputTokens:null,reasoningOutputTokens:null};
 assert.equal(estimateAttemptCost(i,obs(receipt)).estimatedAmount,'1000000000000000000');
 const equal=alternate({cachedInputRate:'2'});assert.equal(estimateAttemptCost(equal,obs({...normalizeUsageReceipt(raw,identity),cachedInputTokens:null})).estimatedAmount,'0.00004');
 const diff=alternate({reasoningOutputRate:'3'});assert.equal(estimateAttemptCost(diff,obs()).costReason,'missing_billable_dimension');
 assert.equal(sumAmounts(['999999999999999999.999999999999999999','0.000000000000000001']),'1000000000000000000');
});
await check('synthetic currencies remain separate immutable snapshots',()=>{
 const eur=validateProviderIdentity({adapterId:'synthetic-grader-v1',pricingCardId:'synthetic-eur-v1'},{builtin:false});assert.equal(estimateAttemptCost(eur,obs()).currency,'EUR');assert.notEqual(eur.pricingSha256,identity.pricingSha256);assert.equal(estimateAttemptCost(identity,obs()).currency,'USD');
});
await check('report bounds reject invalid duplicate-shaped dates and future cutoff',()=>{
 for(const window of [{from:'2026-02-30T00:00:00.000Z',to:'2026-03-01T00:00:00.000Z'},{from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00.000Z'},{from:'2026-01-01T00:00:00.000Z',to:'2026-02-02T00:00:00.000Z'}])assert.throws(()=>validateReportWindow(window),/provider_report_invalid/);
 assert.throws(()=>validateReportWindow({from:'2026-01-01T00:00:00.000Z',to:'2026-01-02T00:00:00.000Z'},'2026-01-01T01:00:00.000Z'),/provider_report_invalid/);
});
await check('actual fixture guard accepts only assigned local and exact Actions alternative without I/O',()=>{
 const local={OWNAPI_PG_ALLOW:'1',OWNAPI_PG_HOST:'127.0.0.1',OWNAPI_PG_PORT:'62563',OWNAPI_PG_DATABASE:'hatoove_spike'};guardProviderFixture(local);guardProviderFixture({...local,CI:'true',GITHUB_ACTIONS:'true',OWNAPI_PG_PORT:'5432',OWNAPI_PG_DATABASE:'hatoove_ci'});
 for(const delta of [{OWNAPI_PG_ALLOW:'0'},{OWNAPI_PG_HOST:'localhost'},{OWNAPI_PG_PORT:'55440'},{OWNAPI_PG_DATABASE:'hatoove'},{OWNAPI_PG_PORT:'5432',OWNAPI_PG_DATABASE:'hatoove_ci',CI:'true'},{OWNAPI_PG_PORT:'5432',OWNAPI_PG_DATABASE:'hatoove_ci',GITHUB_ACTIONS:'true'}])assert.throws(()=>guardProviderFixture({...local,...delta}),/provider_fixture_refused/);
});
await check('CLI argument/config errors expose fixed JSON without private sentinel',()=>{
 for(const file of ['server/worker.mjs','tools/provider-usage-report.mjs']){const p=spawnSync(process.execPath,[file,'--'+privateValue],{encoding:'utf8',env:{...process.env,OWNAPI_PG_DATABASE:'',OWNAPI_PG_USER:''}});assert.equal(p.status,2);assert(!p.stdout.includes(privateValue)&&!p.stderr.includes(privateValue));assert.doesNotThrow(()=>JSON.parse(p.stderr.trim()));}
});
await check('actual out-of-band pool emitter errors are sanitized and cleanup still runs; removed-handler mutation leaks',()=>{
 for(const file of ['server/worker.mjs','tools/provider-usage-report.mjs'])for(const mutant of [false,true]){
  let source=readFileSync(new URL('../'+file,import.meta.url),'utf8').replace(/^#!.*\n/,'');
  source=source.replace(/import \{persistentConfig,persistentRolePool\} from '[^']+';/,"const persistentConfig=()=>({}),persistentRolePool=()=>globalThis.__pool;");
  source=source.replace(/import \{createWorker\} from '[^']+';/,"const createWorker=()=>({reclaimExpired:async()=>{await new Promise(r=>setTimeout(r,10));return {requeued:0,abandoned:0};},runOnce:async()=>({claimed:false})});");
  source=source.replace(/import \{readProviderUsageSummary,validateReportWindow\} from '[^']+';/,"const validateReportWindow=()=>{},readProviderUsageSummary=async()=>({synthetic:true});");
  if(mutant)source=source.replace(/pool\.on\('error',\(\)=>\{[^}]+\}\);/,'');
  const script=`import {EventEmitter} from 'node:events';const pool=new EventEmitter();globalThis.__pool=pool;let closed=false;pool.connect=async()=>{process.nextTick(()=>pool.emit('error',Error(${JSON.stringify(privateValue)})));return {query:async()=>new Promise(r=>setTimeout(()=>r({rows:[]}),10)),release(){}};};pool.end=async()=>{closed=true;};${file==='server/worker.mjs'?`setTimeout(()=>pool.emit('error',Error(${JSON.stringify(privateValue)})),5);`:''}const mod=await import('data:text/javascript;base64,'+${JSON.stringify(Buffer.from(source).toString('base64'))});const code=await mod.main(${JSON.stringify(file==='server/worker.mjs'?['--once']:['--from=2026-01-01T00:00:00.000Z','--to=2026-01-02T00:00:00.000Z'])});console.log(JSON.stringify({closed,code}));process.exitCode=code;`;
  const p=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,OWNAPI_PG_DATABASE:'synthetic',OWNAPI_PG_USER:'synthetic'}});
  assert.equal(p.status,1);if(mutant)assert(p.stderr.includes(privateValue));else{assert(!p.stderr.includes(privateValue));assert(p.stdout.includes('"closed":true'));assert(!p.stdout.includes('"synthetic":true'));}
 }
});
await check('report rejects outage and oversized cohort without partial output',async()=>{
 const window={from:'2026-01-01T00:00:00.000Z',to:'2026-01-02T00:00:00.000Z'};await assert.rejects(readProviderUsageSummary({query(){throw Error(privateValue);}},window),/provider_report_unavailable/);
 let n=0;await assert.rejects(readProviderUsageSummary({async query(){n++;return {rows:n===1?[{as_of:new Date('2026-01-03T00:00:00Z'),isolation:'repeatable read',readonly:'on'}]:[{n:'100001'}]};}},window),/provider_report_too_large/);assert.equal(n,2);
});
console.log(`Provider attempts pure: ${passed} groups passed; synthetic arithmetic only.`);
