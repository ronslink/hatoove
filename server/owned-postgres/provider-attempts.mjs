import {MAX_REPORT_WINDOW_MS,MAX_REPORT_ATTEMPTS,MAX_USAGE_COUNT,sumAmounts} from '../provider-attempt-contract.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const writeCodes=new Set(['provider_identity_invalid','provider_observation_invalid','provider_event_conflict','provider_head_conflict','provider_parent_deleted']);
async function write(client,sql,args,fallback){try{return (await client.query(sql,args)).rows[0];}catch(error){fail(writeCodes.has(error?.message)?error.message:fallback);}}
export async function beginProviderAttempt(client,{jobId,leaseToken,identity}){
 const row=await write(client,'SELECT * FROM begin_provider_attempt($1,$2,$3::jsonb)',[jobId,leaseToken,JSON.stringify(identity)],'provider_intent_failed');
 if(!row?.attempt_id||typeof row.created!=='boolean')fail('provider_intent_failed');return {attemptId:row.attempt_id,created:row.created};
}
export async function appendProviderObservation(client,{attemptId,eventId,expectedRevision,observation,leaseToken=null}){
 const row=await write(client,'SELECT * FROM append_provider_observation($1,$2,$3,$4::jsonb,$5)',[attemptId,eventId,expectedRevision,JSON.stringify(observation),leaseToken],'provider_observation_failed');
 if(!['recorded','deleted'].includes(row?.status))fail('provider_observation_failed');
 return {status:row.status,eventId:row.event_id,revision:row.revision,replay:row.replay};
}
export async function readOwnProviderAttempts(client){try{return (await client.query('SELECT export_owned_provider_attempts() AS value')).rows.map(row=>row.value);}catch{fail('provider_report_unavailable');}}
export function validateReportWindow({from,to},asOf=null){
 const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
 if(!valid(from)||!valid(to)||Date.parse(from)>=Date.parse(to)||Date.parse(to)-Date.parse(from)>MAX_REPORT_WINDOW_MS||(asOf!==null&&Date.parse(to)>Date.parse(asOf)))fail('provider_report_invalid');
 return {from,to};
}
const count=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('provider_report_unavailable');return n;};
const usage=value=>{if(value===null)return null;const n=count(value);if(n>MAX_USAGE_COUNT)fail('provider_report_unavailable');return n;};
export async function readProviderUsageSummary(client,window){
 validateReportWindow(window);
 try{
  // This first materializing statement pins both the MVCC snapshot and its labelled cutoff.
  const snapshot=(await client.query("SELECT date_trunc('milliseconds',statement_timestamp()) AS as_of,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly")).rows[0];
  if(snapshot.isolation!=='repeatable read'||snapshot.readonly!=='on')fail('provider_report_invalid');
  const asOf=new Date(snapshot.as_of).toISOString();validateReportWindow(window,asOf);
  const total=count((await client.query('SELECT count(*) AS n FROM provider_attempt WHERE created_at >= $1 AND created_at < $2 AND created_at <= $3',[window.from,window.to,asOf])).rows[0].n);
  if(total>MAX_REPORT_ATTEMPTS)fail('provider_report_too_large');
  const rows=(await client.query(`SELECT a.provider_id,a.requested_model,a.operation,a.transport_mode,a.pricing_card->>'currency' AS pinned_currency,o.* FROM provider_attempt a
   LEFT JOIN LATERAL(SELECT * FROM provider_attempt_observation o WHERE o.attempt_id=a.attempt_id AND o.recorded_at<=$3 ORDER BY revision DESC LIMIT 1)o ON true
   WHERE a.created_at >= $1 AND a.created_at < $2 AND a.created_at <= $3 ORDER BY a.created_at,a.attempt_id`,[window.from,window.to,asOf])).rows;
  const totals={intents:total,withoutObservation:0,responses:0,uncertain:0,definiteNotSent:0,dispositions:{pending:0,accepted:0,rejected:0,stale:0,failed:0,skipped:0},estimated:0,unknownCost:0,notApplicable:0};
  const groups=new Map(),failures=new Map();
  for(const row of rows){
   const observed=row.event_id!==null,transport=observed?row.transport_status:'uncertain',disposition=observed?row.disposition:'pending',cost=observed?row.cost_status:'unknown';
   if(!observed)totals.withoutObservation++;totals[{response:'responses',uncertain:'uncertain',definite_not_sent:'definiteNotSent'}[transport]]++;totals.dispositions[disposition]++;totals[{estimated:'estimated',unknown:'unknownCost',not_applicable:'notApplicable'}[cost]]++;
   const identity={providerId:row.provider_id,requestedModel:row.requested_model,reportedModel:row.model_reported??null,operation:row.operation,transportMode:row.transport_mode,currency:observed?row.currency:row.pinned_currency};
   const key=JSON.stringify(Object.values(identity));let g=groups.get(key);
   if(!g){g={...identity,attempts:0,withoutObservation:0,estimatedCount:0,unknownCostCount:0,notApplicableCount:0,amounts:[],dimensions:[[],[],[],[]],times:[]};groups.set(key,g);}
   g.attempts++;if(!observed)g.withoutObservation++;g[{estimated:'estimatedCount',unknown:'unknownCostCount',not_applicable:'notApplicableCount'}[cost]]++;
   if(cost==='estimated')g.amounts.push(row.estimated_amount);
   ['input_tokens','output_tokens','cached_input_tokens','reasoning_output_tokens'].forEach((k,index)=>{const n=usage(row[k]??null);if(n!==null)g.dimensions[index].push(BigInt(n));});
   if(row.elapsed_ms!==null&&row.elapsed_ms!==undefined)g.times.push(count(row.elapsed_ms));
   if(row.failure_code)failures.set(row.failure_code,(failures.get(row.failure_code)||0)+1);
  }
  const output=[...groups.values()].sort((a,b)=>{for(const k of ['providerId','requestedModel','reportedModel','operation','transportMode','currency']){if(a[k]===b[k])continue;if(a[k]===null)return -1;if(b[k]===null)return 1;return a[k]<b[k]?-1:1;}return 0;}).map(g=>{
   const {amounts,dimensions,times,...identity}=g;times.sort((a,b)=>a-b);
   return {...identity,knownEstimatedSubtotal:amounts.length?sumAmounts(amounts):null,estimateCompleteness:g.estimatedCount===g.attempts?'complete':g.notApplicableCount===g.attempts?'not_applicable':'partial',
    usage:Object.fromEntries(['input','output','cachedInput','reasoningOutput'].map((k,index)=>[k,{knownTotal:dimensions[index].length?dimensions[index].reduce((sum,n)=>sum+n,0n).toString():null,knownCount:dimensions[index].length,unknownCount:g.attempts-dimensions[index].length}])),
    latency:{samples:times.length,p50Ms:times.length?times[Math.ceil(times.length*.5)-1]:null,p95Ms:times.length?times[Math.ceil(times.length*.95)-1]:null,maxMs:times.length?times.at(-1):null}};
  });
  const queue=(await client.query(`SELECT count(*) FILTER(WHERE j.status='queued') AS queued,count(*) FILTER(WHERE j.status='running') AS running,
   count(*) FILTER(WHERE j.status='running' AND j.lease_until<=$1) AS expired,
   min(s.created_at) FILTER(WHERE j.status='queued') AS oldest_queued,min(j.lease_until) FILTER(WHERE j.status='running' AND j.lease_until<=$1) AS oldest_expired
   FROM jobs j JOIN submissions s ON s.id=j.submission_id WHERE j.status IN ('queued','running') AND s.created_at<=$1`,[asOf])).rows[0];
  const unresolved=(await client.query(`SELECT count(*) AS n,min(a.created_at) AS oldest FROM provider_attempt a LEFT JOIN LATERAL(SELECT transport_status,disposition FROM provider_attempt_observation o WHERE o.attempt_id=a.attempt_id AND o.recorded_at<=$1 ORDER BY revision DESC LIMIT 1)o ON true
   WHERE a.created_at<=$1 AND (o.transport_status IS NULL OR o.transport_status='uncertain' OR o.disposition='pending')`,[asOf])).rows[0];
  const age=value=>value===null?null:Math.max(0,Date.parse(asOf)-new Date(value).getTime());
  return {schemaVersion:1,asOf,window:{...window,basis:'intent_created_at',bounds:'[from,to)'},scope:'stub_only_engineering',totals,groups:output,
   queue:{scope:'all_current_outstanding',queued:count(queue.queued),running:count(queue.running),expiredRunning:count(queue.expired),oldestQueuedAgeMs:age(queue.oldest_queued),oldestExpiredAgeMs:age(queue.oldest_expired),unresolvedIntents:count(unresolved.n),oldestUnresolvedIntentAgeMs:age(unresolved.oldest),workerLiveness:'unobserved'},
   failures:[...failures].sort(([a],[b])=>a.localeCompare(b)).map(([code,n])=>({code,count:n})),realSpend:{status:'not_measured',amount:null}};
 }catch(error){fail(['provider_report_invalid','provider_report_too_large'].includes(error?.code)?error.code:'provider_report_unavailable');}
}
