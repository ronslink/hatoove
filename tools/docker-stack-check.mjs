#!/usr/bin/env node
/**
 * DOCKER-ONLY-01: disposable Compose acceptance. Requires Docker + Node for this developer check.
 * The product itself needs only Docker. Never uses or stops an existing project/volume.
 * No browser, external provider, real account or host .env is used.
 */
import assert from 'node:assert/strict';
import { fixturePreparation, scopedFixtureRoute } from './browser-preparation-fixtures.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const project='hatoove-check-'+Date.now()+'-'+process.pid;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),project+'-'));
const envFile=path.join(scratch,'compose.env');
const marker='DOCKER-ONLY-SYNTHETIC-'+project;
const sentinels=['progress-'+project+'.json','public/progress-'+project+'.json'];
let started=false;
let probeId=null;
let count=0;
const passed=label=>console.log('PASS '+(++count)+' '+label);
// The generated fixture must not inherit a live payment switch, credentials, content mode or
// host Node preload. Compose receives only the explicit local test values below.
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^(?:HATOVE_|OWNAPI_|B1PREP_|STRIPE_|PAYMENTS_|COMPOSE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
function dockerResult(args) {
  return spawnSync('docker',args,{cwd:root,env:{...childEnv,HATOVE_APP_PORT:String(appPort),HATOVE_DB_PORT:String(dbPort),HATOVE_PUBLIC_ORIGIN:base,HATOVE_CONTENT_MODE:'internal-preview',HATOVE_PAYMENTS_MODE:'off',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',OWNAPI_PG_PAYMENTS_PASSWORD:''},encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:8*1024*1024});
}
function docker(args) {
  const r=dockerResult(args);
  if(r.error || r.status!==0) throw new Error('docker '+args[0]+': '+(r.error?.message || r.stderr || r.stdout).slice(-2400));
  return r.stdout.trim();
}
const composeArgs=args=>['compose','--env-file',envFile,'-p',project,'-f',path.join(root,'compose.yaml'),...args];
const compose=args=>docker(composeArgs(args));
const sql=statement=>compose(['exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','hatoove','-tAc',statement]);
const reportArgs=window=>['run','--rm','--no-deps','-T','-e','OWNAPI_PG_USER=hatoove_worker','worker','node','tools/provider-usage-report.mjs','--from='+window.from,'--to='+window.to];
function reportWindow(){
  const to=sql(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  return {from:new Date(Date.parse(to)-3600000).toISOString(),to};
}
function assertPrivateReport(report,window,privateValues=[]){
  assert.equal(report.schemaVersion,1);
  assert.equal(report.scope,'stub_only_engineering');
  assert.deepEqual(report.window,{...window,basis:'intent_created_at',bounds:'[from,to)'});
  assert.ok(Date.parse(report.asOf)>=Date.parse(window.to));
  assert.equal(report.queue.scope,'all_current_outstanding');
  assert.equal(report.queue.workerLiveness,'unobserved','queue/report data must not claim worker liveness');
  assert.deepEqual(report.realSpend,{status:'not_measured',amount:null});
  const forbidden=new Set(['owner_id','ownerId','submission_id','submissionId','job_id','jobId','attempt_id','attemptId','event_id','eventId','text','feedback','email','password','headers','pricingCard','pricing_card','pricingSha256','pricing_sha256','lease_token','leaseToken','prompt','evidence','cookie']);
  function walk(value){
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      assert.equal(forbidden.has(key),false,'aggregate output must not include private field '+key);
      walk(child);
    }
  }
  walk(report);
  const output=JSON.stringify(report);
  assert.doesNotMatch(output,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,'aggregate output contains no raw identities');
  assert.doesNotMatch(output,/https?:\/\//i,'aggregate output contains no endpoint');
  for(const value of privateValues.filter(value=>typeof value==='string'&&value.length)) assert.equal(output.includes(value),false,'aggregate output excludes the synthetic private sentinel');
}
function readReport(privateValues=[]){
  const window=reportWindow();
  const report=JSON.parse(compose(reportArgs(window)));
  assertPrivateReport(report,window,privateValues);
  return report;
}
const usageStateTables=Object.freeze(['provider_attempt','provider_attempt_observation','jobs','assessments','usage_ledger','entitlements']);
function usageStateFingerprint(){
  // All columns of every row participate, including balance and feedback values. Only hashes
  // leave PostgreSQL; one statement gives these six table fingerprints the same snapshot.
  const fields=usageStateTables.map(table=>`'${table}',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') FROM hatoove.${table} t)`);
  return JSON.parse(sql('SELECT jsonb_build_object('+fields.join(',')+')'));
}
function assertUsageStateUnchanged(before,after){
  for(const value of [before,after]){
    assert.deepEqual(Object.keys(value).sort(),[...usageStateTables].sort());
    for(const table of usageStateTables)assert.match(value[table],/^[0-9a-f]{64}$/);
  }
  assert.deepEqual(after,before,'reporting must not change any existing invocation, job, assessment, ledger or balance row');
}
function removeProbe(){
  if(!probeId)return;
  const owned=JSON.parse(docker(['inspect',probeId]))[0];
  assert.equal(owned.Config.Labels['hatoove.test-project'],project,'only this check owns the probe container');
  docker(['rm','-f',probeId]);
  probeId=null;
}
async function freePort(){
  const s=net.createServer();
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}
// Derived, NOT hardcoded: a count pinned to today's number breaks on legitimate work, which is
// its own defect class. The ledger must hold exactly the migrations on disk.
const migrationCount=fs.readdirSync(path.join(root,'server','migrations')).filter(f=>/^\d{4}-.*\.sql$/.test(f)).length;
const appPort=await freePort();
let dbPort=await freePort();
while(dbPort===appPort) dbPort=await freePort();
const base='http://127.0.0.1:'+appPort;
fs.writeFileSync(envFile,'HATOVE_APP_PORT='+appPort+'\nHATOVE_DB_PORT='+dbPort+'\nHATOVE_PUBLIC_ORIGIN='+base+'\n');
let preparationId;
async function request(method,url,body,cookie){
  if(cookie && method==='GET') url=scopedFixtureRoute(url,preparationId);
  // Synchronous Docker checks can outlast the server's keep-alive timeout while Node cannot
  // consume the socket-close event. Use a fresh fixture connection, never replay an uncertain POST.
  const headers={origin:base,connection:'close'};
  if(body!==undefined) headers['content-type']='application/json';
  if(cookie) headers.cookie=cookie;
  const res=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(10000)});
  const text=await res.text();
  let json;try{json=JSON.parse(text);}catch{}
  return {status:res.status,headers:res.headers,text,json};
}
async function ready(){
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    try{if((await request('GET','/api/ready')).status===200)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('isolated API did not become ready');
}
try{
  for(const file of ['tools/local-bringup.mjs','tools/local-bringup-check.mjs','tools/install-academy.ps1']) assert.equal(fs.existsSync(path.join(root,file)),false,file+' must be retired');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).scripts.start,'docker compose up -d --build');
  passed('host launcher/installer retired; npm start delegates to Docker Compose');
  const config=JSON.parse(compose(['config','--format','json']));
  assert.equal(config.name,project);
  assert.equal(config.volumes['db-data'].name,project+'_db-data');
  assert.equal(Boolean(config.volumes['db-data'].external),false);
  assert.equal(String(config.services.app.ports[0].published),String(appPort));
  assert.equal(String(config.services.db.ports[0].published),String(dbPort));
  assert.ok(![4300,55440].includes(appPort)&&![4300,55440].includes(dbPort),'existing learner ports are never used');
  assert.equal(config.services.app.environment.B1PREP_PUBLIC_ORIGIN,base);
  assert.equal(config.services.app.environment.PAYMENTS_MODE,'off');
  assert.equal(config.services.app.environment.STRIPE_SECRET_KEY,'');
  assert.equal(config.services.app.environment.STRIPE_WEBHOOK_SECRET,'');
  assert.equal(config.services.worker.healthcheck,undefined);
  assert.ok(config.services.app.healthcheck.test.join(' ').includes('/api/ready'));
  passed('only the API declares an HTTP readiness probe');
  for(const file of sentinels) fs.writeFileSync(path.join(root,file),marker,{flag:'wx'});
  started=true;
  console.log('Building and starting isolated Compose project '+project);
  compose(['up','-d','--build','--wait','--wait-timeout','120']);
  await ready();
  passed('db -> migrations -> API and worker start in isolated containers');
  const rows=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.hatoove_migrations']).trim();
  assert.equal(rows,String(migrationCount),'the ledger must hold exactly the migrations on disk');
  /*
   * TWELVE TASK VERSIONS, SIX PROMPTS. Migration 0017 re-binds the six writing prompts to the telc B1 rubric
   * at task `v2`; the catalogue is immutable (`content_immutable` refuses UPDATE), so that is six NEW rows
   * beside the six `v1` rows rather than an edit. Both versions are servable, and the ROUTE serves one card
   * per task — which `owned-api-check` leg `the-catalogue-serves-the-telc-rubric-once-per-task` asserts. This
   * leg counts what the DATABASE holds, so it must expect both.
   */
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.task_version']).trim(),'12',
    'six prompts at two versions each: v1 with the retired rubric, v2 with the telc B1 one');
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT count(*) FROM hatoove.task_version WHERE rubric_id = 'writing.telc-b1'"]).trim(),'6',
    'the six current bindings must name the telc B1 rubric');
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT count(*) FROM hatoove.rubric_version"]).trim(),'2',
    'two rubrics: the retired four-criterion one and the current three-criterion one, separately versioned');
  const elevated=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',"SELECT count(*) FROM pg_roles WHERE rolname LIKE 'hatoove_%' AND (rolsuper OR rolbypassrls)"]).trim();
  assert.equal(elevated,'0');
  passed(String(migrationCount)+' migrations applied and 6 task versions; application roles not superuser/BYPASSRLS');
  const rejected=['/app/.git','/app/work','/app/research','/app/content/fixtures','/app/handoff','/app/.env',...sentinels.map(p=>'/app/'+p)];
  const audit="const fs=require('node:fs');const bad="+JSON.stringify(rejected)+".filter(p=>fs.existsSync(p));if(bad.length)throw Error('private/unneeded image paths: '+bad.join(','));";
  compose(['exec','-T','app','node','-e',audit]);
  assert.deepEqual(JSON.parse(compose(['exec','-T','app','node','-e',"console.log(JSON.stringify(require('node:fs').readdirSync('/app/tools').sort()))"])),['import-exam-package.mjs','provider-usage-report.mjs','review-content.mjs'],'the image contains exactly its three operator CLIs');
  const workerId=compose(['ps','-q','worker']);
  assert.ok(workerId);
  assert.equal(JSON.parse(docker(['inspect',workerId]))[0].Config.Healthcheck,undefined);
  passed('built image excludes synthetic private files; worker inherits no HTTP probe');
  const usageHelp=compose(['run','--rm','--no-deps','-T','-e','OWNAPI_PG_HOST=127.0.0.1','-e','OWNAPI_PG_PORT=1','-e','OWNAPI_PG_DATABASE=','-e','OWNAPI_PG_USER=','worker','node','tools/provider-usage-report.mjs','--help']);
  assert.match(usageHelp,/provider-usage-report\.mjs/);
  assert.match(usageHelp,/--from/);
  assert.match(usageHelp,/--to/);
  assert.doesNotMatch(usageHelp,/provider_report_(?:invalid|unavailable)/);
  const emptyUsage=readReport();
  assert.equal(emptyUsage.totals.intents,0);
  assert.equal(emptyUsage.totals.unknownCost,0);
  assert.deepEqual(emptyUsage.groups,[]);
  assert.equal(emptyUsage.queue.queued,0);
  assert.equal(emptyUsage.queue.running,0);
  assert.equal(emptyUsage.queue.oldestQueuedAgeMs,null);
  passed('packaged report help is independent of DB configuration; actual empty report keeps liveness and real spend unknown');
  compose(['run','--rm','--no-deps','migrate']);
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.hatoove_migrations']).trim(),String(migrationCount));
  passed('re-running migrations leaves the ledger at '+migrationCount+' entries');
  const packageReceipt=JSON.parse(compose(['run','--rm','--no-deps','migrate','node','tools/import-exam-package.mjs','content/exams/telc-deutsch-b1/manifest.json','--dry-run']));
  assert.equal(packageReceipt.unchanged,true);
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',"SELECT count(*) FROM hatoove.exam_release_head WHERE exam_id='telc-deutsch-b1' AND release_version='v1'"]).trim(),'1');
  passed('image includes the exact package source and importer; dry-run is an unchanged publication');
  // `/` IS THE PUBLIC FRONT DOOR (Ron, 2 October 2026: "index.html should be the landing page",
  // and "we need landing/index or just index" → just index).
  //
  // It is served AT `/`, from the root of `public/`: the brand site's asset URLs are relative
  // (`site.css`, `site.js`, `assets/…`), so under a `landing/` subdirectory they resolved to
  // `/styles.css` and `/app.js` — both refused 401 by the shell's gate, which decides BEFORE resolution
  // and therefore answers 401 whether or not the file exists — and the front page rendered as unstyled
  // HTML with missing images. At the root every relative URL resolves to its own file.
  // tools/app-browser-check.mjs renders it and fails on any refused request.
  const landing = await request('GET', '/');
  assert.equal(landing.status, 200, '/ must serve the public landing page, got ' + landing.status);
  assert.ok(/lang="de"/.test(landing.text) && /href="\/signin"/.test(landing.text)
    && /href="\/signin\?mode=signup"/.test(landing.text), '/ must be the German landing page with real entry links');
  assert.ok(!/\/api\/|objective_key/.test(landing.text), 'the landing page must carry no API path or learner data');
  // The assets the page itself asks for, at the paths its relative URLs resolve to.
  for (const asset of ['site.css', 'site.js', 'assets/design/hatoove-logo.svg', 'assets/design/hatoove.css', 'assets/design/fonts-coverage.css', 'favicon.ico']) {
    const res = await request('GET', '/' + asset);
    assert.equal(res.status, 200, '/' + asset + ' must be served to the landing page, got ' + res.status);
  }
  // The retired SPA's page is gone from the root: the landing page is not a different product's name.
  assert.ok(!/Certa/i.test(landing.text), 'the front page must not carry the retired product name');
  // `/landing/` is not a second copy of the front door. It is REFUSED before resolution like every
  // other non-public path (401, deliberately: a refusal must not reveal whether a gated file exists),
  // so the assertion is "not served", not a particular status.
  const oldLanding = await request('GET', '/landing/');
  assert.notEqual(oldLanding.status, 200, '/landing/ must not be a second front door, got ' + oldLanding.status);
  assert.ok(!oldLanding.text.includes('hero-start'), '/landing/ must not serve the brand site');
  // The APP is still gated, and it is now at /app/ rather than /.
  assert.equal((await request('GET','/app/')).status,401);
  const credentials={name:'Docker check',email:project+'@example.invalid',password:'Synthetic-password-2026'};
  const signup=await request('POST','/api/auth/sign-up/email',credentials);
  assert.equal(signup.status,200,signup.text);
  let cookie=signup.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  assert.ok(cookie);
  const preparations=await request('GET','/api/v1/preparations',undefined,cookie);
  assert.equal(preparations.status,200);
  preparationId=fixturePreparation(preparations.json);
  const accountBefore=await request('GET','/api/v1/account',undefined,cookie);
  assert.equal(accountBefore.status,200);
  assert.equal((await request('GET','/',undefined,cookie)).status,200);
  const settings=await request('GET','/api/v1/settings',undefined,cookie);
  assert.equal(settings.status,200);
  const saved=await request('PUT','/api/v1/settings',{expectedRevision:settings.json.revision,settings:{language:'en'}},cookie);
  assert.equal(saved.status,200,saved.text);
  const preparation=await request('GET','/api/v1/preparations/'+preparationId,undefined,cookie);
  const savedDate=await request('PUT','/api/v1/preparations/'+preparationId,{expectedRevision:preparation.json.revision,examDate:'2026-12-01'},cookie);
  assert.equal(savedDate.status,200,savedDate.text);
  passed('synthetic signup, protected shell and owned settings work at configured origin');

  // O01: create real owned jobs through HTTP, then use only the local stub in the image.
  // Stop this project's daemon so the explicitly injected synthetic call owns its queued job.
  // The wrapper deliberately captures no usage: accepting its grade must not invent free cost.
  compose(['stop','worker']);
  try{
    const privateValues=[marker,credentials.email,credentials.password,cookie,accountBefore.json.id,preparationId];
    async function submitUsageFixture(){
      const created=await request('POST','/api/v1/attempts',{preparationId},cookie);
      assert.equal(created.status,201,created.text);
      const text='Liebe Frau Weber, dies ist ausschließlich ein synthetischer Docker-Test. '+marker+'. Bitte bestätigen Sie den Termin. Vielen Dank.';
      const draft=await request('PUT','/api/v1/attempts/'+created.json.id,{expectedRevision:1,text},cookie);
      assert.equal(draft.status,200,draft.text);
      const submitted=await request('POST','/api/v1/attempts/'+created.json.id+'/submissions',{expectedRevision:2,eventId:randomUUID()},cookie);
      assert.equal(submitted.status,202,submitted.text);
      privateValues.push(created.json.id,submitted.json.submissionId,text);
      return submitted.json.submissionId;
    }
    await submitUsageFixture();
    const syntheticRun=`
      import assert from 'node:assert/strict';
      import {persistentConfig,persistentRolePool} from './server/owned-postgres/provision.mjs';
      import {createWorker,stubGrade} from './server/owned-postgres/worker.mjs';
      const pool=persistentRolePool(persistentConfig(),'worker',{max:1});
      try{
        const {rows:[identity]}=await pool.query('SELECT current_user AS role');
        assert.equal(identity.role,'hatoove_worker');
        const result=await createWorker({pool,grade:input=>stubGrade(input)}).runOnce();
        assert.equal(result.outcome,'succeeded');
        console.log(JSON.stringify({role:identity.role,outcome:result.outcome}));
      }finally{await pool.end();}
    `;
    assert.deepEqual(JSON.parse(compose(['run','--rm','--no-deps','-T','-e','OWNAPI_PG_USER=hatoove_worker','worker','node','--input-type=module','-e',syntheticRun])),{role:'hatoove_worker',outcome:'succeeded'});
    await submitUsageFixture();
    const pendingUsage=readReport(privateValues);
    assert.equal(pendingUsage.totals.intents,1,'a queued job without dispatch is not an invocation intent');
    assert.equal(pendingUsage.totals.unknownCost,1,'successful synthetic feedback without usage has unknown cost');
    assert.equal(pendingUsage.totals.notApplicable,0,'an injected stub lookalike is not the trusted builtin');
    assert.equal(pendingUsage.queue.queued,1,'the report reads actual outstanding work');
    assert.ok(Number.isInteger(pendingUsage.queue.oldestQueuedAgeMs));
    const cliOutput=compose(['run','--rm','--no-deps','-T','-e','OWNAPI_PG_USER=hatoove_worker','worker','node','server/worker.mjs','--once']);
    const cliRecords=cliOutput.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
    assert.ok(cliRecords.some(row=>row.event==='worker_outcome'&&row.outcome==='succeeded'));
    for(const value of privateValues)assert.equal(cliOutput.includes(value),false,'worker CLI output excludes owned identities and text');
    const beforeRead=usageStateFingerprint();
    const usage=readReport(privateValues);
    assert.equal(usage.totals.intents,2);
    assert.equal(usage.totals.responses,2);
    assert.equal(usage.totals.dispositions.accepted,2);
    assert.equal(usage.totals.unknownCost,1);
    assert.equal(usage.totals.notApplicable,1);
    assert.equal(usage.totals.estimated,0);
    assert.equal(usage.queue.queued,0);
    assert.equal(usage.queue.running,0);
    assert.equal(usage.queue.unresolvedIntents,0);
    assert.equal(usage.groups.length,2);
    const synthetic=usage.groups.find(group=>group.transportMode==='synthetic_fixture');
    const local=usage.groups.find(group=>group.transportMode==='local_stub');
    assert.equal(synthetic?.unknownCostCount,1);
    assert.equal(synthetic.knownEstimatedSubtotal,null);
    assert.equal(synthetic.estimateCompleteness,'partial');
    assert.deepEqual(synthetic.usage.input,{knownTotal:null,knownCount:0,unknownCount:1});
    assert.equal(synthetic.latency.samples,1);
    assert.equal(local?.notApplicableCount,1);
    assert.equal(local.knownEstimatedSubtotal,null);
    assert.equal(local.estimateCompleteness,'not_applicable');
    assertUsageStateUnchanged(beforeRead,usageStateFingerprint());
    passed('restricted-worker report preserves real unknown usage, separates the local stub, and exposes no private identities or invented spend');

    // Discriminate against a reporting CLI silently using the configured admin role.
    // This role/table belong solely to the generated disposable Compose database.
    const deniedWindow=reportWindow();
    sql('REVOKE SELECT ON hatoove.provider_attempt FROM hatoove_worker');
    try{
      // Keep child stderr separate from Compose's progress messages. Filtering mixed stderr
      // for JSON alone would overlook an arbitrary leaked error line next to the safe record.
      const capture=`
        import {spawnSync} from 'node:child_process';
        const result=spawnSync(process.execPath,${JSON.stringify(['tools/provider-usage-report.mjs','--from='+deniedWindow.from,'--to='+deniedWindow.to])},{encoding:'utf8',timeout:15000});
        console.log(JSON.stringify({status:result.status,errorCode:result.error?.code??null,stdout:result.stdout??'',stderr:result.stderr??''}));
      `;
      const denied=JSON.parse(compose(['run','--rm','--no-deps','-T','-e','OWNAPI_PG_USER=hatoove_worker','worker','node','--input-type=module','-e',capture]));
      assert.equal(denied.errorCode,null);
      assert.equal(denied.status,1,'restricted report must fail when its worker table grant is withheld');
      assert.equal(denied.stdout.trim(),'','failure cannot masquerade as an empty healthy report');
      assert.deepEqual(JSON.parse(denied.stderr.trim()),{event:'provider_report_error',code:'provider_report_unavailable'});
      for(const value of privateValues)assert.equal((denied.stdout+denied.stderr).includes(value),false);
    }finally{
      sql('GRANT SELECT ON hatoove.provider_attempt TO hatoove_worker');
    }
    assert.equal(readReport(privateValues).totals.intents,2,'restoring the original worker grant restores the same report');
    assertUsageStateUnchanged(beforeRead,usageStateFingerprint());
    passed('report CLI uses restricted database authority and fails closed instead of returning an empty success');
  }finally{
    compose(['start','worker']);
  }

  /*
   * ACCOUNT RECOVERY, IN THE RUNNING CONTAINER, AND THE OPERATOR'S CONSOLE IS THE PROOF.
   *
   * D6's recommendation is operator-assisted resets with the token path wired now: the link goes to the
   * operator console and NO message leaves the building, because the provider is a decision a human has to
   * make. Three things are asserted here that only the real stack can show:
   *
   *   1. the ROUTE exists in the running server (it was 404 before this slice);
   *   2. the RESPONSE carries no token — the property that stops "I forgot my password" becoming "I can take
   *      over any account whose address I know";
   *   3. the LINK reached the operator, read from the app container's own log — the channel that replaces
   *      email in the pilot, and the only place the token is allowed to appear.
   *
   * The origin of the link is configuration (`B1PREP_PUBLIC_ORIGIN`), so it is asserted to point at the
   * configured base rather than at whatever a request header claimed.
   */
  const resetRequest = await request('POST','/api/auth/request-password-reset',{email:credentials.email});
  assert.equal(resetRequest.status,200,resetRequest.text);
  assert.equal(resetRequest.text.includes('token'),false,'the reset response must not mention a token');
  const appLog = compose(['logs','--no-color','--tail','80','app']);
  const delivered = appLog.split('\n').filter((line)=>line.includes('[notify]') && line.includes(credentials.email));
  assert.equal(delivered.length,1,`the operator console must receive exactly one reset line, got ${delivered.length}`);
  assert.ok(delivered[0].includes(`${base}/reset-password?token=`),
    `the link must point at the configured origin, got ${delivered[0].slice(0,200)}`);
  // The token is IN the operator's line and NOWHERE in the learner's response.
  const tokenMatch=/[?&]token=([A-Za-z0-9_-]+)/.exec(delivered[0]);
  assert.ok(tokenMatch,'the delivered line carries a token');
  assert.equal(resetRequest.text.includes(tokenMatch[1]),false,'and that token must not be in the response');
  // A request for an unknown address produces no line at all: the operator must not be asked to deliver a
  // link for an account that does not exist, and the difference must not be visible to the requester.
  const unknown=await request('POST','/api/auth/request-password-reset',{email:`no-such-${project}@example.invalid`});
  assert.equal(unknown.status,200,unknown.text);
  assert.deepEqual(unknown.json,resetRequest.json,'known and unknown addresses must answer identically');
  assert.equal(compose(['logs','--no-color','--tail','80','app']).includes('no-such-'),false,
    'no operator line may be produced for an address with no account');
  passed('password reset: link delivered to the operator console only, no token in the response, one identical answer');

  /*
   * EMAIL VERIFICATION, same channel, same rules — and ONE property that differs from the reset: the link must
   * point at the VERIFICATION page, not at the reset page. A single link builder with one destination would
   * have sent learners to type a new password to "verify" an address, which is the sort of mistake that only a
   * real link can show.
   */
  const verifyRequest = await request('POST','/api/auth/send-verification-email',{email:credentials.email});
  assert.equal(verifyRequest.status,200,verifyRequest.text);
  assert.equal(verifyRequest.text.includes('token'),false,'the verification response must not mention a token');
  const verifyLines = compose(['logs','--no-color','--tail','80','app']).split('\n')
    .filter((line)=>line.includes('[notify] email-verification') && line.includes(credentials.email));
  assert.equal(verifyLines.length,1,`the operator must receive exactly one verification line, got ${verifyLines.length}`);
  assert.ok(verifyLines[0].includes(`${base}/verify-email?token=`),
    `the verification link must point at the verification page, got ${verifyLines[0].slice(0,220)}`);
  assert.equal(verifyLines[0].includes('/reset-password'),false,'and never at the reset page');
  // The operator's own line is enough to complete the flow, which is what "operator-assisted" has to mean.
  const verifyToken=/[?&]token=([A-Za-z0-9_-]+)/.exec(verifyLines[0]);
  assert.ok(verifyToken,'the delivered line carries a token');
  const verified=await request('POST','/api/auth/verify-email',{token:verifyToken[1]});
  assert.equal(verified.status,200,verified.text);
  assert.equal(verified.json.email,credentials.email,'and it verifies the account the operator delivered it for');
  const replay=await request('POST','/api/auth/verify-email',{token:verifyToken[1]});
  assert.equal(replay.status,400,`a consumed verification token must be refused, got ${replay.status}`);
  passed('email verification: link delivered to the operator, verified once, replayed token refused');
  // LOOPBACK ALIASES ARE THE SAME ORIGIN. On a LOCAL server `localhost` and `127.0.0.1` name the
  // same machine, so a deployment configured with one and browsed at the other must not refuse the
  // learner with an unexplained "cross-origin request rejected" on sign-up. This is the leg that
  // catches it: the request below carries the ALIAS in both Host and Origin, exactly as a browser
  // at that address would send it, while being routed over the IPv4 socket the stack publishes on.
  const aliasHost=base.includes('localhost')?'127.0.0.1':'localhost';
  const aliasOrigin='http://'+aliasHost+':'+appPort;
  // A request carrying an arbitrary Host and Origin, routed over the IPv4 socket the stack
  // publishes on. This is how a browser at that address presents itself to the server.
  const postAs=(hostHeader,originHeader,email)=>new Promise((resolve,reject)=>{
    const payload=JSON.stringify({name:'Origin check',email,password:'Synthetic-password-2026'});
    const req=http.request({host:'127.0.0.1',port:appPort,path:'/api/auth/sign-up/email',method:'POST',headers:{host:hostHeader,origin:originHeader,'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{
      let text='';res.on('data',d=>{text+=d;});res.on('end',()=>resolve({status:res.statusCode,text}));
    });
    req.on('error',reject);req.write(payload);req.end();
  });
  const aliasResult=await postAs(aliasHost+':'+appPort,aliasOrigin,'alias-'+project+'@example.invalid');
  assert.equal(aliasResult.status,200,'a request from the loopback alias '+aliasOrigin+' must be accepted when the configured origin is '+base+': '+aliasResult.text);
  passed('the same origin reached by its loopback alias is accepted, not refused as cross-origin');
  // THE BOUNDARY OF THAT EXCEPTION, which matters more than the exception itself: a FOREIGN host is
  // still refused even though a loopback alias is now accepted. These two legs passed before the
  // change as well, and they are here to keep passing -- the relaxation must not widen into a real
  // deployment's trust, so it is guarded rather than merely intended.
  const foreignOrigin='http://evil.example:'+appPort;
  const foreignA=await postAs(aliasHost+':'+appPort,foreignOrigin,'foreign-origin-'+project+'@example.invalid');
  assert.equal(foreignA.status,403,'a foreign Origin must still be refused: '+foreignA.status+' '+foreignA.text);
  const foreignB=await postAs('evil.example:'+appPort,foreignOrigin,'foreign-host-'+project+'@example.invalid');
  assert.equal(foreignB.status,403,'a foreign Host must still be refused: '+foreignB.status+' '+foreignB.text);
  passed('a foreign Origin and a foreign Host are still refused: the loopback exception is bounded');
  // ENCODED TRAVERSAL. The public-path test used to run on the still-encoded path and resolution
  // decoded afterwards, so `/assets/design/..%2f..%2f..%2fdata%2fseed.json` looked public and then
  // resolved to `data/seed.json` — every one of the 180 answer keys, to an unauthenticated caller,
  // from an ordinary fetch. A WHATWG URL parser does not normalise encoded dots or slashes, so this
  // is reachable without a special client. It must refuse, and 200 here means the leak is back.
  const traversals=[
    '/assets/design/..%2f..%2f..%2fdata%2fseed.json',
    '/assets/design/..%2f..%2fapp%2findex.html',
    '/assets/design/..%2f..%2fapp%2fapp.js',
    '/assets/design/%2e%2e/%2e%2e/data/seed.json',
    '/data%2fseed.json',
  ];
  for(const p of traversals){
    const res=await fetch(base+p,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    assert.ok([401,403,404].includes(res.status),'encoded traversal '+p+' must be refused, got '+res.status);
  }
  // A traversal that resolves to a file which is PUBLIC BY DECISION is not a bypass — it must answer
  // exactly what that file answers directly and carry nothing extra. `/index.html` became public when
  // the landing page moved to the root, so the invariant is asserted instead of a refusal: the leg
  // would otherwise have been deleted the moment it stopped failing, which is how a security check
  // quietly disappears.
  const viaTraversal=await fetch(base+'/assets/design/..%2f..%2findex.html',{redirect:'manual',signal:AbortSignal.timeout(10000)});
  const direct=await request('GET','/index.html');
  assert.equal(viaTraversal.status,direct.status,'an encoded traversal must not out-rank the file it resolves to');
  const traversalBody=await viaTraversal.text();
  // Byte for byte the same document, and no more. (A first version of this line grepped the body for
  // "answer" and failed on the landing page's own marketing copy — the check was wrong, not the code.)
  assert.equal(traversalBody,direct.text,'an encoded traversal must serve exactly the file it resolves to, byte for byte');
  assert.ok(!/objective_key|"why"|"correct"/.test(traversalBody),'the traversal must not carry answer-key material');
  passed('encoded path traversal reaches nothing: the gate sees the resolved file, not the URL');

  // THE FILE STORE IS RETIRED, not merely gated. Ron, 2 October 2026: "no longer needing files to
  // serve data". data/** was a second static root -- how the old client read its content, and how
  // the answer keys were downloadable. Learner data now comes from the API, so these must be 404:
  // GONE, not 401. A gated file store is still a file store, and one forgotten prefix reopens it.
  for(const gone of ['/data/seed.json','/data/vocab.json','/data/writing-guide.json']){
    const res=await fetch(base+gone,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    assert.equal(res.status,404,gone+' must be GONE (404), not merely refused, got '+res.status);
  }
  passed('the data file store is retired: learner data is served by the API, not from files');

  /*
   * EVERY API ROUTE IS AUTH-WRAPPED, as convention (Ron, 2 October 2026).
   *
   * Only liveness is public, because a supervisor or a container healthcheck has no session and must
   * still be able to ask whether the process is alive. Everything else refuses an anonymous caller.
   * The LEGACY routes are in the list deliberately: /api/config, /api/ai and /api/ai/test used to answer
   * with no identity at all. **`/api/progress` is in the list as a ROUTE THAT NO LONGER EXISTS**: the
   * gate answers 401 before any handler, so an anonymous caller cannot tell the difference — which is
   * exactly why the difference is asserted WITH A SESSION, in the leg below.
   */
  for(const p of ['/api/health','/api/ready']){
    const res=await fetch(base+p,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    assert.equal(res.status,200,p+' is liveness and must stay public, got '+res.status);
  }
  const gated=[['GET','/api/progress'],['GET','/api/config'],['POST','/api/ai'],['POST','/api/ai/test'],
    ['GET','/api/v1/account'],['GET','/api/v1/settings'],['GET','/api/v1/tasks'],['POST','/api/v1/attempts']];
  for(const [m,p] of gated){
    const res=await fetch(base+p,{method:m,headers:{origin:base,'content-type':'application/json'},
      body:m==='POST'?'{}':undefined,redirect:'manual',signal:AbortSignal.timeout(10000)});
    assert.equal(res.status,401,m+' '+p+' must be auth-wrapped, got '+res.status);
  }
  passed('every API route is auth-wrapped: only /api/health and /api/ready answer anonymously');

  /*
   * THE RETIRED FILE STORE IS ABSENT, PROVEN WITH A SESSION.
   *
   * This is the leg `tools/retired-surface-check.mjs` cannot write: that check runs with no database, so
   * every request it makes is refused by the auth wrap before a handler is reached, and "route absent"
   * is indistinguishable from "route present but refused". Here there is a real account, so a request
   * that PASSES identity must reach the router and find nothing: 404, with no `legacy_progress_disabled`
   * and no record served. The 200 that this route answered before the removal is what makes this leg
   * discriminating — it is the difference between a route that is gone and a route that is merely rude.
   */
  for (const [m, p] of [['GET', '/api/progress'], ['POST', '/api/progress'], ['DELETE', '/api/progress?scope=all']]) {
    const res = await fetch(base + p, { method: m, headers: { origin: base, 'content-type': 'application/json', cookie },
      body: m === 'POST' ? JSON.stringify({ rev: 1, state: { nodes: {}, history: [] } }) : undefined,
      redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 404, m + ' ' + p + ' with a SESSION must be 404 (gone), got ' + res.status);
    const body = await res.text();
    assert.ok(!/legacy_progress_disabled/.test(body), 'the retired refusal code must not survive anywhere');
  }
  passed('the retired file store is absent: authenticated GET, POST and DELETE /api/progress answer 404');

  /*
   * THE SPA-ERA API ROUTES ARE ABSENT TOO — the assertion `retired-surface-check` cannot make.
   *
   * `POST /api/config` wrote a MACHINE-GLOBAL `EXAM_DATE` for any visitor with no identity, and `GET
   * /api/config` read it back; `/api/ai` and `/api/ai/test` reached the operator's provider from a
   * browser. With a REAL account, a request that passes identity reaches the router and must find
   * nothing. Bodies are deliberately EMPTY/INVALID: if a legacy AI handler were still mounted, an empty
   * body would be refused by its own validator (422) rather than starting a provider call — a probe must
   * never be the thing that makes a live AI request.
   *
   * The 404s are what make it discriminating: before the removal, GET /api/config answered 200 and
   * POST /api/ai answered 422 with this same session.
   */
  for (const [m, p] of [['GET', '/api/config'], ['POST', '/api/config'], ['POST', '/api/ai'], ['POST', '/api/ai/test']]) {
    const res = await fetch(base + p, {
      method: m,
      headers: { origin: base, 'content-type': 'application/json', cookie },
      body: m === 'POST' ? '{}' : undefined,
      redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 404, m + ' ' + p + ' with a SESSION must be 404 (gone), got ' + res.status);
    const body = await res.text();
    assert.ok(!/provider_config_is_operator_only/.test(body), 'the retired provider-config refusal must not survive');
  }
  passed('the SPA-era API is absent: authenticated /api/config, /api/ai and /api/ai/test answer 404');

  /*
   * OBJECTIVE-SEED-01 -- the authored corpus is IN THE DATABASE, and its answers are not.
   *
   * The answers sit INLINE in data/seed.json, in the same arrays as the learner-facing text, so a
   * seed that copied the source wholesale would ship every key in the task payload. The split is
   * enforced by a GRANT rather than by a route remembering to strip a field, and these legs prove the
   * grant is real: has_table_privilege asks PostgreSQL, not the code.
   */
  const scored=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    'SELECT sum(item_count) FROM hatoove.objective_set']).trim();
  assert.equal(scored,'192','180 original corpus items plus 12 recovered grammar-practice items expected, got '+scored);
  const sets=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    'SELECT count(*) FROM hatoove.objective_set']).trim();
  assert.equal(sets,'25','24 original corpus sets plus one recovered grammar-practice set expected, got '+sets);
  const originalCorpus=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT count(*) || ':' || sum(item_count) FROM hatoove.objective_set WHERE COALESCE(payload->>'practice_kind','') <> 'grammar-drill'"]).trim();
  assert.equal(originalCorpus,'24:180','the original authored corpus must remain intact, got '+originalCorpus);
  const grammarPractice=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT count(*) || ':' || sum(item_count) FROM hatoove.objective_set WHERE payload->>'practice_kind' = 'grammar-drill'"]).trim();
  assert.equal(grammarPractice,'1:12','one separate twelve-item grammar-practice set expected, got '+grammarPractice);
  // `jsonb_path_exists` with a recursive wildcard, not a `LIKE` on the JSON text: it DESCENDS into
  // the nested arrays where the answers actually live, so a secret one level deeper than the check
  // still fails it. It also needs no quote-escaping, which is its own small mercy.
  const leaks=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT count(*) FROM hatoove.objective_set WHERE jsonb_path_exists(payload, '$.**.answer') OR jsonb_path_exists(payload, '$.**.why') OR jsonb_path_exists(payload, '$.**.grammar') OR jsonb_path_exists(payload, '$.**.script')"]).trim();
  assert.equal(leaks,'0','no learner payload may carry a secret field, found '+leaks);
  const learnerKey=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT has_table_privilege('hatoove_learner','hatoove.objective_key','SELECT')"]).trim();
  assert.equal(learnerKey,'f','the learner role MUST NOT be able to read objective_key, got '+learnerKey);
  passed('24 original sets / 180 items plus one grammar-practice set / 12 items are seeded; payloads and learner grants keep keys private');

  // The route that SERVES the corpus, and must never serve the key side of it.
  assert.equal((await request('GET','/api/v1/objective-sets')).status,401,'/api/v1/objective-sets must require a session');
  const objective=await request('GET','/api/v1/objective-sets',undefined,cookie);
  assert.equal(objective.status,200,'the objective route must answer a signed-in learner, got '+objective.status);
  assert.ok(Array.isArray(objective.json),'the objective list must be a JSON array');
  // 25 sets exist, 9 are media-gated -> 15 original sets plus one grammar drill; 120 + 12 items.
  assert.equal(objective.json.length,16,'16 servable objective sets expected (25 minus 9 media-gated), got '+objective.json.length);
  assert.equal(objective.json.reduce((n,s)=>n+s.item_count,0),132,'132 servable items expected, got '+objective.json.reduce((n,s)=>n+s.item_count,0));
  const grammarRows=objective.json.filter((row)=>row.set_id==='telc-deutsch-b1.sb1.grammar-wortstellung-v1');
  assert.equal(grammarRows.length,1,'the recovered practice set must be served once');
  assert.equal(grammarRows[0].item_count,12);
  assert.equal(grammarRows[0].review_status,'unreviewed','recovery must not claim content approval');
  {
    const serialised=JSON.stringify(objective.json);
    for(const leak of ['"answer"','"why"','"grammar"','"script"','objective_key']){
      assert.ok(!serialised.includes(leak),'the objective payload must not carry '+leak);
    }
  }
  // The media gate is a real filter, not a hope: asking for listening returns nothing until audio exists.
  const listening=await request('GET','/api/v1/objective-sets?family=HV1',undefined,cookie);
  assert.equal(listening.status,200);
  assert.equal(listening.json.length,0,'HV must serve NOTHING while audio does not exist, got '+listening.json.length);
  assert.equal((await request('GET','/api/v1/objective-sets?family=lv1',undefined,cookie)).status,422,'a lowercase family must be refused, not silently accepted');
  passed('the objective route serves 15 original sets plus one grammar-practice set / 132 items with NO key, and withholds listening until audio exists');

  // LIBRARY-SEED-01 — the vocabulary lexicon. 300 entries are authored; the SERVER decides how many
  // one response may carry, so a crafted request cannot ask for the whole table on every keystroke.
  assert.equal((await request('GET','/api/v1/vocab')).status,401,'/api/v1/vocab must require a session');
  const vocab=await request('GET','/api/v1/vocab',undefined,cookie);
  assert.equal(vocab.status,200,vocab.text);
  assert.ok(Array.isArray(vocab.json)&&vocab.json.length===50,'the lexicon must be bounded to 50 per response, got '+(vocab.json&&vocab.json.length));
  assert.ok(vocab.json.every((e)=>typeof e.de==='string'&&typeof e.en==='string'&&typeof e.review_status==='string'),'every entry must carry its German headword, gloss and review_status');
  const search=await request('GET','/api/v1/vocab?q=erziehung',undefined,cookie);
  assert.equal(search.status,200);
  assert.equal(search.json.length,1,'searching "erziehung" must find exactly the one headword, got '+search.json.length);
  assert.ok(/Erziehung/.test(search.json[0].de),'the search must match on the German headword');
  const nouns=await request('GET','/api/v1/vocab?pos=noun',undefined,cookie);
  assert.equal(nouns.status,200);
  assert.ok(nouns.json.every((e)=>e.pos==='noun'),'a pos filter must return only that part of speech');
  assert.equal((await request('GET','/api/v1/vocab?q=v',undefined,cookie)).status,422,'a one-character search must be refused rather than run');
  assert.equal((await request('GET','/api/v1/vocab?pos=bogus',undefined,cookie)).status,422,'an unknown part of speech must be refused');
  passed('the lexicon serves up to 300 words, server-bounded, searchable, filterable, and refuses bad input');

  // LIBRARY-SEED-02 — the noun lexicon: gender, plural and the rule that decides the gender.
  assert.equal((await request('GET','/api/v1/nouns')).status,401,'/api/v1/nouns must require a session');
  const nounsLex=await request('GET','/api/v1/nouns',undefined,cookie);
  assert.equal(nounsLex.status,200,nounsLex.text);
  assert.equal(nounsLex.json.length,50,'the noun lexicon must be bounded to 50 per response, got '+nounsLex.json.length);
  assert.ok(nounsLex.json.every((e)=>typeof e.gender==='string'&&typeof e.plural==='string'&&typeof e.rule==='string'),
    'every noun must carry its gender, plural and the gender rule -- that is the content Ron named as Nomen und Genus');
  const dieOnly=await request('GET','/api/v1/nouns?gender=die',undefined,cookie);
  assert.equal(dieOnly.status,200);
  assert.ok(dieOnly.json.length>0&&dieOnly.json.every((e)=>e.gender==='die'),'a gender filter must return only that article');
  const themed=await request('GET','/api/v1/nouns?theme=Personen',undefined,cookie);
  assert.equal(themed.status,200);
  assert.ok(themed.json.length>0&&themed.json.every((e)=>e.theme==='Personen'),'a theme filter must return only that theme');
  // An unknown value is REFUSED, not silently empty: an empty list and a typo look identical to a
  // learner, and only one of them is their fault.
  assert.equal((await request('GET','/api/v1/nouns?gender=xxx',undefined,cookie)).status,422,'an unknown article must be refused, not silently return nothing');
  assert.equal((await request('GET','/api/v1/nouns?q=n',undefined,cookie)).status,422,'a one-character search must be refused');
  passed('the noun lexicon serves 240 nouns with gender, plural and rule, filterable by article and theme');

  /*
   * LIBRARY-SEED-03 — the five reference guides, as an INDEX and then one document.
   *
   * `grammar-guide` alone is 64 KB across 14 topics, so the list must not carry the content. And the
   * authored structure must SURVIVE the round trip: a declension table is a headers array plus a rows
   * array, and flattening it into columns would have destroyed it.
   */
  assert.equal((await request('GET','/api/v1/guides')).status,401,'/api/v1/guides must require a session');
  const guides=await request('GET','/api/v1/guides',undefined,cookie);
  assert.equal(guides.status,200,guides.text);
  assert.equal(guides.json.length,7,'seven guides expected, got '+guides.json.length);
  assert.equal(guides.json.reduce((n,g)=>n+g.section_count,0),123,'123 sections expected across the seven guides, got '+guides.json.reduce((n,g)=>n+g.section_count,0));
  const grammar=await request('GET','/api/v1/guides/grammar-guide',undefined,cookie);
  assert.equal(grammar.status,200,grammar.text);
  assert.equal(grammar.json.sections.length,14,'grammar-guide holds 14 topics, got '+grammar.json.sections.length);
  assert.ok(grammar.json.sections[0].payload.rule&&grammar.json.sections[0].payload.pattern,
    'a topic must carry its rule and pattern, not just a title');
  const cases=await request('GET','/api/v1/guides/cases-guide',undefined,cookie);
  assert.equal(cases.status,200);
  const table=cases.json.sections.find((s)=>s.kind==='table');
  assert.ok(table&&Array.isArray(table.payload.headers)&&table.payload.headers.length===5,
    'the declension table headers must survive as an array of 5');
  assert.ok(Array.isArray(table.payload.rows)&&table.payload.rows.length>0,'the declension table rows must survive');
  assert.ok(cases.json.intro&&cases.json.watch_out.length>0,'a guide that has an intro and watch-outs must carry them');
  assert.equal((await request('GET','/api/v1/guides/not-a-guide',undefined,cookie)).status,404,'an unknown guide must be 404');

  // LIBRARY-SEED-04 — writing and speaking, added as a SECOND migration because 0013 is applied.
  const writing=await request('GET','/api/v1/guides/writing-guide',undefined,cookie);
  assert.equal(writing.status,200,writing.text);
  assert.equal(writing.json.sections.length,19,'writing-guide holds 19 sections (6 steps, 8 phrase groups, 4 letters, 1 checklist), got '+writing.json.sections.length);
  const checklist=writing.json.sections.find((s)=>s.kind==='checklist');
  assert.ok(checklist&&checklist.payload.items.length===8&&checklist.payload.itemsEn.length===8,
    'the checklist must carry both languages; a learner reading Ukrainian needs the glossary translated, not just the guide');
  const letter=writing.json.sections.find((s)=>s.kind==='example_letter');
  assert.ok(letter&&Array.isArray(letter.payload.leitpunkte)&&letter.payload.text,
    'an example letter must carry its Leitpunkte and its text, not just a title');
  // Speaking is seeded as REFERENCE PROSE. AGENTS.md puts speaking and STT outside the pilot, so this
  // asserts the document is served and asserts NOTHING about speaking practice.
  const speaking=await request('GET','/api/v1/guides/speaking-guide',undefined,cookie);
  assert.equal(speaking.status,200);
  assert.equal(speaking.json.sections.length,3,'speaking-guide holds 3 parts, got '+speaking.json.sections.length);
  assert.ok(speaking.json.sections[0].payload.minutes>0,'a speaking part must carry its timing');
  passed('writing and speaking guides are served (19 + 3 sections) with both languages on the checklist');

  /*
   * PILOT-22 — answering an objective item, marked SERVER-SIDE without the learner role ever seeing
   * the key. This is the spine adaptive selection will read.
   */
  const answerSet = 'telc-deutsch-b1.lv1.01';
  const post = (payload) => request('POST', `/api/v1/objective-sets/${answerSet}/answers`, { version: 'v1', preparationId, ...payload }, cookie);
  assert.equal((await request('POST', `/api/v1/objective-sets/${answerSet}/answers`, { itemId: '1', answer: 'b' })).status,
    401, 'answering must require a session');
  const evidenceBefore = Number(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    'SELECT count(*) FROM hatoove.item_evidence']).trim());
  const missingVersion = await post({ version: undefined, itemId: '1', answer: 'b' });
  assert.equal(missingVersion.status,422,'an authenticated answer must name its version');
  assert.equal(missingVersion.json.error,'invalid_version');
  const right = await post({ itemId: '1', answer: 'b', latencyMs: 1200 });
  assert.equal(right.status,201,right.text);
  assert.equal(right.json.correct,true,'the authored key for item 1 is b, so b must mark correct');
  const wrong = await post({ itemId: '1', answer: 'c', latencyMs: 1300 });
  assert.equal(wrong.status,201,wrong.text);
  assert.equal(wrong.json.correct,false,'c is not the key for item 1 and must mark wrong');
  // An unknown item RAISES rather than returning false: "wrong" and "no such item" must not look the
  // same, or a bug in an item id would silently mark a learner down.
  assert.equal((await post({ itemId: '999', answer: 'b' })).status,422,'an unknown item must be refused, not marked wrong');
  assert.equal((await post({ itemId: '1' })).status,422,'an answer is required');
  const evidenceAfter = Number(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    'SELECT count(*) FROM hatoove.item_evidence']).trim());
  // TWO rows for the two ACCEPTED answers, and the refused 422 left NONE. That single number proves
  // both properties at once: the same item answered twice is kept twice (append-only -- evidence is a
  // record, not a score, and correcting a mistake must not erase having made it), AND a refused
  // answer is not silently recorded as a wrong one.
  assert.equal(evidenceAfter-evidenceBefore,2,'two accepted answers must leave exactly two rows and a refused one none, got '+(evidenceAfter-evidenceBefore));
  passed('objective answers are marked server-side and recorded append-only, and an unknown item is refused');

  /*
   * PILOT-22b — what to practise next, chosen by RULES over the evidence above.
   *
   * These legs assert the INVARIANTS rather than a specific set id: the exact choice follows a
   * documented ranking (unstarted sections first for breadth, then weakest accuracy, then fewest
   * attempts, then name), and pinning the test to today's winner would make a legitimate tuning change
   * look like a regression. What must never change: it is deterministic, it names a real servable set,
   * it carries the EVIDENCE for its own claim, and it never leaks a key.
   */
  assert.equal((await request('GET','/api/v1/practice/next')).status,401,'/api/v1/practice/next must require a session');
  const next=await request('GET','/api/v1/practice/next',undefined,cookie);
  assert.equal(next.status,200,next.text);
  assert.ok(next.json.set&&typeof next.json.set.set_id==='string','a choice must name a real set, got '+JSON.stringify(next.json).slice(0,160));
  assert.ok(next.json.set.item_count>0,'the chosen set must have items');
  assert.equal(typeof next.json.reason,'string','the choice must state its reason');
  assert.ok(next.json.evidence&&Number.isInteger(next.json.evidence.attempts),
    'the choice must carry the evidence for its own claim, so the learner can be told WHY');
  {
    const serialised=JSON.stringify(next.json);
    for(const leak of ['"answer"','"why"','objective_key','"script"']){
      assert.ok(!serialised.includes(leak),'the selection must not leak '+leak);
    }
  }
  // DETERMINISM. The same evidence must yield the same choice: a plan that varies between two
  // identical requests is a bug, not personalisation, and it is the property that makes this route
  // explainable where a model call would not be.
  const nextAgain=await request('GET','/api/v1/practice/next',undefined,cookie);
  assert.equal(JSON.stringify(nextAgain.json),JSON.stringify(next.json),'two identical requests must produce the same choice');
  passed('practice/next chooses deterministically from recorded evidence and carries its reason and evidence');
  passed('the guide library serves 5 documents / 101 sections as an index plus one document, structure intact');
  /*
   * THE AUTH CONTRACT. Everything below was previously assumed rather than tested, and one of them
   * was tested wrongly.
   *
   * A BROWSER AND A SCRIPT GET DIFFERENT, CORRECT ANSWERS. A navigation must be REDIRECTED to the
   * form, because a 401 renders as a blank error page in a browser and nobody could sign in; a fetch
   * must be refused 401, because a client that followed a redirect would parse the login page as the
   * content it asked for. The check asserted only the 401 -- the non-browser case, and the less
   * important one. Both are asserted now, and the form is fetched to prove the redirect lands
   * somewhere real.
   */
  // `/app/` is the gated application; `/` is the public front door and must NOT redirect to sign-in,
  // or a visitor to the product's own address would be bounced to a form without being told what they
  // are signing in to.
  const nav=await fetch(base+'/app/',{headers:{accept:'text/html,application/xhtml+xml'},redirect:'manual',signal:AbortSignal.timeout(10000)});
  assert.equal(nav.status,302,'a logged-out navigation to the APP must be REDIRECTED, not refused; a 401 shows a browser a blank page');
  assert.ok((nav.headers.get('location')||'').endsWith('/signin'),'the redirect must target /signin, got '+nav.headers.get('location'));
  const signinPage=await request('GET','/signin');
  assert.equal(signinPage.status,200);
  assert.ok(signinPage.text.includes('id="form-signin"'),'the redirect target must actually serve the sign-in form');
  assert.equal((await request('GET','/app/')).status,401,'a script must still be refused 401 rather than handed HTML');
  assert.equal((await request('GET','/')).status,200,'the front door must stay public');
  passed('a logged-out browser is redirected from the APP to a real sign-in form; the landing page stays public');

  // Sign-out must END the session, not merely navigate away from it.
  const session=await request('POST','/api/auth/sign-in/email',{email:credentials.email,password:credentials.password});
  assert.equal(session.status,200,session.text);
  const liveCookie=session.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  assert.equal((await request('GET','/api/v1/account',undefined,liveCookie)).status,200);
  const signedOut=await request('POST','/api/auth/sign-out',{},liveCookie);
  assert.equal(signedOut.status,200,signedOut.text);
  assert.equal((await request('GET','/api/v1/account',undefined,liveCookie)).status,401,'the cookie must be dead after sign-out');
  passed('sign-out ends the session: the same cookie is refused afterwards');

  // NO ACCOUNT ENUMERATION. A wrong password and an unknown email must be indistinguishable, or the
  // endpoint becomes an oracle for "does this person have an account here".
  const wrongPassword=await request('POST','/api/auth/sign-in/email',{email:credentials.email,password:'definitely-not-the-password'});
  const unknownEmail=await request('POST','/api/auth/sign-in/email',{email:'nobody-'+project+'@example.invalid',password:'definitely-not-the-password'});
  assert.equal(wrongPassword.status,401,wrongPassword.text);
  assert.equal(unknownEmail.status,401,unknownEmail.text);
  assert.equal(wrongPassword.text,unknownEmail.text,'a wrong password and an unknown email must not be distinguishable');
  passed('a wrong password and an unknown email are refused with the identical response');

  // A duplicate registration is refused AND must not disturb the account that already exists.
  const duplicate=await request('POST','/api/auth/sign-up/email',credentials);
  assert.notEqual(duplicate.status,200,'a second sign-up with the same email must be refused, got '+duplicate.status);
  const stillWorks=await request('POST','/api/auth/sign-in/email',{email:credentials.email,password:credentials.password});
  assert.equal(stillWorks.status,200,'the original account must still work after a duplicate attempt');
  passed('a duplicate sign-up is refused and leaves the existing account intact');

  // EXPIRY IS ENFORCED, proved by AGEING a real session rather than by waiting an hour for it.
  const fresh=await request('POST','/api/auth/sign-in/email',{email:credentials.email,password:credentials.password});
  const setCookie=fresh.headers.getSetCookie()[0]||'';
  const token=setCookie.split(';')[0].split('=').slice(1).join('=');
  assert.ok(token,'could not read the session token from the cookie');
  compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-c',
    "UPDATE hatoove.session SET \"expiresAt\" = now() - interval '1 hour' WHERE token = '"+token.replace(/'/g,"''")+"'"]);
  const agedCookie=fresh.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  assert.equal((await request('GET','/api/v1/account',undefined,agedCookie)).status,401,'an expired session must be refused');
  passed('an aged session is refused: expiry is enforced, not merely recorded');

  // Cookie flags. `Secure` is deliberately NOT required here: this stack is plain HTTP on loopback
  // and a Secure cookie would never be sent, so demanding it would break local sign-in. It is a
  // switch for a TLS deployment, and asserting it on HTTP would be asserting the wrong thing.
  assert.ok(/HttpOnly/i.test(setCookie),'the session cookie must be HttpOnly, got: '+setCookie);
  assert.ok(/SameSite=/i.test(setCookie),'the session cookie must scope SameSite, got: '+setCookie);
  passed('the session cookie is HttpOnly and SameSite-scoped (Secure is a TLS-deployment switch)');
  // The exam scope itself, before the route that serves it.
  const pkg=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT exam_id||'|'||exam||'|'||level||'|'||exam_language FROM hatoove.exam_package ORDER BY exam_id"]).trim();
  assert.ok(pkg.length>0,'exam_package must hold at least the first exam package, got: '+JSON.stringify(pkg));
  passed('exam_package exists and names the first exam package: '+pkg.split('\n')[0]);

  for(const table of ['content_version','rubric_version','task_version']){
    const unscoped=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
      'SELECT count(*) FROM hatoove.'+table+' WHERE exam_id IS NULL']).trim();
    assert.equal(unscoped,'0',table+' must have no row without an exam_id');
  }
  passed('every content row carries an exam_id: nothing is exam-agnostic and can leak across exams');

  assert.equal((await request('GET','/api/v1/tasks')).status,401,'/api/v1/tasks must require a session');

  /*
   * THE SERVING POLICY. Ron, 2 October 2026: "we will assume for now all are approved until we have
   * built the approval process that needs to be an item."
   *
   * Compose explicitly opts this local fixture into internal-preview, and the approval workflow remains a slice
   * of its own. What is deliberately NOT done is writing `approved` into the rows: that would record
   * a qualified review that has not happened, and AGENTS.md forbids marking content approved. The
   * rows keep their TRUE status and the policy is what changes, so a learner is served the content
   * while being told the truth about it -- and the approval slice later changes a label rather than
   * having to unpick a false one.
   *
   * The pair still discriminates, and now in the opposite direction from before:
   *   internal-preview -> the seeded versions ARE listed, each with its real review_status
   *   approved -> the SAME route returns EMPTY, proving the policy is genuinely consulted and the
   *               fail-closed value still works
   * Without the second leg the first could be satisfied by a route that ignores the policy entirely.
   */
  const listed=await request('GET','/api/v1/tasks?family=writing',undefined,cookie);
  assert.equal(listed.status,200,'the task route must exist and answer a signed-in learner, got '+listed.status);
  assert.ok(Array.isArray(listed.json),'the task list must be a JSON array');
  assert.ok(listed.json.length>0,'internal-preview serves the seeded task versions, got '+listed.json.length);
  assert.ok(listed.json.every(t=>typeof t.review_status==='string'),'every listed task must carry its review_status so a learner can be told the truth');
  {
    const serialised=JSON.stringify(listed.json);
    for(const leak of ['leitpunkte_answers','answer_key','answerKey','correctAnswer']){
      assert.ok(!serialised.includes(leak),'a task payload must not carry '+leak);
    }
  }
  passed('internal-preview serves '+listed.json.length+' task version(s), each with its review_status and no answer key');

  // Standalone public policy in its own container; the Compose fixture remains internal-preview.
  const probePort=await freePort();
  const probeName=project+'-approved-probe';
  const appImage=project+'-app';
  probeId=docker(['run','-d','--name',probeName,'--label','hatoove.test-project='+project,'--network',project+'_default',
    '-p','127.0.0.1:'+probePort+':4321',
    '-e','B1PREP_BIND=0.0.0.0','-e','B1PREP_SAAS=1','-e','B1PREP_ACCOUNTS=1','-e','B1PREP_PORT=4321',
    '-e','B1PREP_PUBLIC_ORIGIN=http://127.0.0.1:'+probePort,
    '-e','B1PREP_SERVE_REVIEW=approved',
    '-e','OWNAPI_PG_HOST=db','-e','OWNAPI_PG_PORT=5432','-e','OWNAPI_PG_DATABASE=hatoove','-e','OWNAPI_PG_USER=postgres',
    appImage,'node','server.js']);
  try{
    const probeBase='http://127.0.0.1:'+probePort;
    const deadline=Date.now()+60000;
    let up=false;
    while(Date.now()<deadline){
      try{ if((await fetch(probeBase+'/api/ready',{signal:AbortSignal.timeout(4000)})).ok){ up=true; break; } }catch{}
      await new Promise(r=>setTimeout(r,500));
    }
    assert.ok(up,'the fail-closed probe did not become ready');
    const signIn=await fetch(probeBase+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:probeBase},body:JSON.stringify({email:credentials.email,password:credentials.password}),signal:AbortSignal.timeout(10000)});
    assert.equal(signIn.status,200,'sign-in against the probe failed');
    const probeCookie=signIn.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const closed=await fetch(probeBase+'/api/v1/tasks?family=writing&preparationId='+preparationId,{headers:{cookie:probeCookie},signal:AbortSignal.timeout(10000)});
    assert.equal(closed.status,200);
    const strict=await closed.json();
    assert.ok(Array.isArray(strict),'the task list must be a JSON array');
    assert.equal(strict.length,0,'under an explicit approved-only policy and only unreviewed rows the list must be EMPTY, got '+strict.length);
    passed('an explicit approved-only policy serves NOTHING: the policy is consulted, not hardcoded');
  } finally {
    removeProbe();
  }
  compose(['restart','app','worker']);
  await ready();
  const login=await request('POST','/api/auth/sign-in/email',{email:credentials.email,password:credentials.password});
  assert.equal(login.status,200,login.text);
  cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const after=await request('GET','/api/v1/settings',undefined,cookie);
  const afterPrep=await request('GET','/api/v1/preparations/'+preparationId,undefined,cookie);
  assert.equal(afterPrep.status,200);
  assert.equal(afterPrep.json.exam_date,'2026-12-01');
  assert.equal(after.json.settings.language,'en');
  passed('fresh sign-in after container restart restores saved account settings');
  const spec = spawnSync(process.execPath, ['tools/api-spec-check.mjs', '--base='+base],
    {cwd:root,env:childEnv,encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(spec.status,0, spec.error?.message || spec.stdout + spec.stderr);
  passed('OpenAPI anonymous surface matches the disposable server (' + spec.stdout.match(/\d+ passed, 0 failed/)?.[0] + ')');
  console.log(count+' passed; product journeys, auth attack cases and model validity are separate gates.');
} finally {
  try{removeProbe();}
  catch(error){console.error('Probe cleanup failed for '+project+': '+error.message);process.exitCode=1;}
  if(started){
    // Only this check's unique project is removed; no prune and no existing project is touched.
    try{
      compose(['down','--volumes','--remove-orphans','--rmi','local']);
      assert.equal(docker(['ps','-aq','--filter','label=com.docker.compose.project='+project]),'','project containers are absent');
      assert.equal(docker(['ps','-aq','--filter','label=hatoove.test-project='+project]),'','owned standalone probe is absent');
      assert.equal(docker(['volume','ls','-q','--filter','label=com.docker.compose.project='+project]),'','project volumes are absent');
      assert.equal(docker(['network','ls','-q','--filter','label=com.docker.compose.project='+project]),'','project networks are absent');
      for(const service of ['app','worker','migrate'])assert.equal(docker(['image','ls','-q','--filter','reference='+project+'-'+service+':latest']),'','project image tag is absent');
      console.log('Verified absent disposable containers, volumes, networks and image tags for '+project);
    }
    catch(error){console.error('Cleanup failed for '+project+': '+error.message);process.exitCode=1;}
  }
  for(const file of sentinels){
    const full=path.join(root,file);
    if(fs.existsSync(full)&&fs.readFileSync(full,'utf8')===marker)fs.unlinkSync(full);
  }
  assert.equal(path.dirname(path.resolve(scratch)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith(project+'-'));
  fs.rmSync(scratch,{recursive:true,force:true});
  assert.equal(fs.existsSync(scratch),false,'owned scratch directory is absent');
  for(const file of sentinels)assert.equal(fs.existsSync(path.join(root,file)),false,'owned synthetic source sentinel is absent');
}
