#!/usr/bin/env node
/** Saved explanations in a uniquely named source-only Compose fixture; no real approval or provider. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCompleteFixture } from './exam-s5b-fixture.mjs';
import { verifyExplanations } from './explanation-browser.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stamp=Date.now()+'_'+process.pid,project='hatoove-explanation-browser-'+stamp.replace('_','-'),schema='ownapi_explanation_browser_'+stamp;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),project+'-')),source=path.join(scratch,'source'),envFile=path.join(scratch,'compose.env');
const index=process.argv.indexOf('--shots'),shots=index<0?path.join(root,'.qa','exam-s6',project):path.resolve(process.argv[index+1]);
const results=[],fixtureVersion='v9800',availableVersion='v9801';
let workerProviderCalls=0;
let appPort,dbPort,base,started=false,cleaned=false,fixture,contentIds;
const testSecret='whsec_synthetic_s6_'+randomUUID().replaceAll('-','');
const commandEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(B1PREP_|OWNAPI_|STRIPE_|PAYMENTS_|HATOVE_|COMPOSE_)/i.test(key)));
const sourceRevision=command('git',['rev-parse','HEAD']),sourceChanges=command('git',['status','--porcelain']);
function command(binary,args,cwd=root,env=commandEnv) {
  const result=spawnSync(binary,args,{cwd,env,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:16*1024*1024});
  if(result.error||result.status!==0)throw Error(`${binary} ${args[0]}: ${(result.error?.message||result.stderr||result.stdout||'').slice(-2500)}`);
  return (result.stdout||'').trim();
}
const compose=args=>command('docker',['compose','--env-file',envFile,'-p',project,'-f',path.join(source,'compose.yaml'),...args],source,
  {...commandEnv,HATOVE_APP_PORT:String(appPort),HATOVE_DB_PORT:String(dbPort),HATOVE_PUBLIC_ORIGIN:base,HATOVE_CONTENT_MODE:'public',
    HATOVE_PAYMENTS_MODE:'stub',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:testSecret,OWNAPI_PG_PAYMENTS_PASSWORD:''});
function record(name,ok,detail=''){results.push({name,ok,detail});fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(path.join(shots,'checkpoint.json'),JSON.stringify({sourceRevision,project,base,dbPort,schema,scratch,started,cleaned,results},null,2));console.log(`${ok?'PASS':'FAIL'} ${name}${detail?': '+detail:''}`);}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function replaceOnce(file,needle,replacement){const text=fs.readFileSync(file,'utf8');if(text.split(needle).length!==2)throw Error('Fixture seam changed: '+path.basename(file));fs.writeFileSync(file,text.replace(needle,replacement));}
function labelled(kind){const list={container:['ps','-a'],volume:['volume','ls'],network:['network','ls'],image:['image','ls']}[kind];if(!list)throw Error('Unknown resource kind');return command('docker',[...list,'-q','--filter','label=com.docker.compose.project='+project]).split(/\s+/).filter(Boolean);}
function verifyProject(){
  if(!/^hatoove-explanation-browser-\d+-\d+$/.test(project)||[4300,55440].includes(appPort)||[4300,55440].includes(dbPort))throw Error('Unsafe disposable project identity');
  const id=compose(['ps','-q','db']);if(!id||/\s/.test(id))throw Error('Exactly one fixture database required');
  const row=JSON.parse(command('docker',['inspect',id]))[0];
  if(row.Config.Labels['com.docker.compose.project']!==project||row.Config.Labels['com.docker.compose.service']!=='db')throw Error('Database label mismatch');
  const ports=row.NetworkSettings.Ports['5432/tcp'];
  if(ports?.length!==1||ports[0].HostIp!=='127.0.0.1'||ports[0].HostPort!==String(dbPort))throw Error('Database port mismatch');
}
function migrateProgram(body){
  verifyProject();
  const program=`import fs from 'node:fs/promises';import {persistentConfig,persistentRolePool,createAdminPool} from './server/owned-postgres/provision.mjs';import {importPackage} from './server/owned-postgres/package-importer.mjs';import {createHash,randomUUID} from 'node:crypto';import {recordReviewerAuthority,recordContentReview} from './server/owned-postgres/content-review.mjs';
const config=persistentConfig();if(process.env.B1PREP_CONTENT_MODE!=='public'||config.schema!==${JSON.stringify(schema)}||config.admin.host!=='db'||config.admin.database!=='hatoove'||process.env.OWNAPI_PG_ALLOW!=='1')throw Error('Wrong synthetic migrate target');
const admin=createAdminPool(config),migration=persistentRolePool(config,'migration');
try{for(const pool of [admin,migration])if((await pool.query('SELECT current_schema() AS schema')).rows[0].schema!==config.schema)throw Error('Wrong synthetic connection schema');
const internal=JSON.parse(await fs.readFile('./content/exams/dtz-a2-b1/s6-fixture.json','utf8'));const ids=${JSON.stringify(contentIds)};
if(internal.release.version!==${JSON.stringify(fixtureVersion)}||internal.exam.id!=='dtz-a2-b1'||ids.length!==new Set(ids).size)throw Error('Wrong synthetic content identities');
async function transaction(fn){const c=await migration.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function review(kind,id,version='',decision='approve'){
 return transaction(async c=>{
 const row=kind==='content'?(await c.query('SELECT content_sha256 AS sha256,kind FROM content_version WHERE exam_id=$1 AND content_version_id=$2',[internal.exam.id,id])).rows[0]:kind==='blueprint'?(await c.query('SELECT sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[id,version])).rows[0]:(await c.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[internal.exam.id,id,version])).rows[0];
 if(!row||kind==='content'&&!ids.includes(id)||!['content','blueprint','form'].includes(kind))throw Error('Unknown synthetic review target '+kind+' '+id+' '+version);
 const category=kind!=='content'?'exam_format':row.kind==='media'?'audio':'educational',language=category==='audio'?'de':'';
 let auth=(await c.query('SELECT authority_id,action FROM content_review_authority WHERE reviewer_id=$1 AND exam_id=$2 AND category=$3 AND language=$4 ORDER BY revision DESC LIMIT 1',['synthetic.browser-review',internal.exam.id,category,language])).rows[0];
 if(!auth)auth={authority_id:(await recordReviewerAuthority(c,{eventId:randomUUID(),reviewerId:'synthetic.browser-review',reviewerName:'Synthetic browser fixture — no human approval',examId:internal.exam.id,category,language,action:'grant',expectedAuthorityId:null,evidenceRef:'fixture://browser/appointment',evidenceSha256:'c'.repeat(64),rationale:'Isolated synthetic browser verification only'})).authorityId,action:'grant'};
 if(auth.action!=='grant')throw Error('Synthetic authority revoked');
 const projection=kind==='content'?(await c.query('SELECT * FROM effective_content_review($1)',[id])).rows[0]:(await c.query('SELECT * FROM effective_format_review($1,$2,$3,$4)',[internal.exam.id,kind,id,version])).rows[0];
 return recordContentReview(c,{eventId:randomUUID(),subject:{kind,examId:internal.exam.id,subjectId:id,version,sha256:row.sha256},category,language,authorityId:auth.authority_id,expectedDecisionId:projection.decision_ids[0]||null,decision,evidenceRef:'fixture://browser/decision',evidenceSha256:'c'.repeat(64),rationale:'Isolated synthetic browser verification only; not educational approval',packetSha256:null});
 });
}
${body}
}finally{await Promise.allSettled([admin.end(),migration.end()]);}`;
  return compose(['run','--rm','--no-deps','-T','migrate','node','--input-type=module','-e',program]);
}
async function sourceFixture(){
  const listed=command('git',['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  for(const name of listed){
    if(/^(\.git|\.qa|handoff|design)(\/|$)/i.test(name)||/(^|\/)(\.env(?:\..*)?|node_modules)(\/|$)/i.test(name))continue;
    const from=path.resolve(root,name),to=path.resolve(source,name);
    if(!from.startsWith(root+path.sep)||!to.startsWith(source+path.sep))throw Error('Unsafe source path');
    if(!fs.existsSync(from))continue;if(!fs.lstatSync(from).isFile())throw Error('Non-file source entry: '+name);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
  }
  // Source-only fixture instrumentation. Any external fetch is counted and refused before network I/O.
  fs.writeFileSync(path.join(source,'server/explanation-fixture-provider-probe.mjs'), `import fs from 'node:fs';const native=globalThis.fetch;globalThis.__explanationProviderCalls=0;globalThis.fetch=(input,...args)=>{const url=new URL(typeof input==='string'?input:input.url);if(!['localhost','127.0.0.1','::1'].includes(url.hostname)){globalThis.__explanationProviderCalls++;fs.appendFileSync('/tmp/explanation-provider-count','x');throw Error('Synthetic fixture refuses external provider I/O');}return native(input,...args);};`);
  const appEntry=path.join(source,'server.js');fs.writeFileSync(appEntry,"import './server/explanation-fixture-provider-probe.mjs';\n"+fs.readFileSync(appEntry,'utf8'));
  replaceOnce(path.join(source,'server/accounts.mjs'),'const world = await createPostgresWorld({ fixture });',
    "const {createExamCatalogue}=await import('./preparation-contract.mjs');\n  const world = await createPostgresWorld({ fixture,examCatalogue:createExamCatalogue({enabled:['telc-deutsch-b1','dtz-a2-b1']}) });");
  replaceOnce(path.join(source,'compose.yaml'),'OWNAPI_PG_SCHEMA: hatoove','OWNAPI_PG_SCHEMA: '+schema);
  replaceOnce(path.join(source,'compose.yaml'),'OWNAPI_PG_ROLE_PREFIX: hatoove','OWNAPI_PG_ROLE_PREFIX: '+schema);
  fixture=await createCompleteFixture({examId:'dtz-a2-b1',mediaRoot:path.join(source,'content/exams'),version:fixtureVersion,releaseVersion:fixtureVersion,blueprintVersion:fixtureVersion});
  for(const set of fixture.sets)set.version=fixtureVersion;
  for(const rubric of fixture.rubrics)rubric.version=fixtureVersion;
  for(const task of fixture.writingTasks){task.version=fixtureVersion;task.rubricVersion=fixtureVersion;}
  for(const form of fixture.forms){for(const member of form.members)member.version=fixtureVersion;for(const group of form.writingChoices)for(const option of group.options)option.taskVersion=fixtureVersion;}
  for(const row of [...fixture.sets,...fixture.media,...fixture.writingTasks,...fixture.rubrics])row.source='synthetic:exam-s6-browser; test-only review simulation, no actual educational approval';
  contentIds=[...fixture.sets.map(x=>x.setId+'@'+x.version),...fixture.media.map(x=>x.mediaId+'@'+x.version),...fixture.writingTasks.map(x=>x.taskId+'@'+x.version),...fixture.rubrics.map(x=>x.rubricId+'@'+x.version)];
  fs.writeFileSync(path.join(source,'content/exams/dtz-a2-b1/s6-fixture.json'),JSON.stringify(fixture));
}
async function nav(cdp,url){await cdp.send('Page.navigate',{url});await cdp.waitFor("document.readyState==='complete'",25000,url);}
async function viewport(cdp,width,height,mobile){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:mobile?2:1,mobile});await cdp.send('Emulation.setTouchEmulationEnabled',mobile?{enabled:true,maxTouchPoints:5}:{enabled:false});}
const theme=(cdp,value)=>cdp.send('Emulation.setEmulatedMedia',{media:'screen',features:[{name:'prefers-color-scheme',value}]});
async function shot(cdp,name,selector=null){fs.mkdirSync(shots,{recursive:true});if(selector)await cdp.evaluate(`const el=document.querySelector(${JSON.stringify(selector)});if(!el?.getBoundingClientRect().height)throw Error('Missing screenshot target');el.scrollIntoView({block:'start'});scrollBy(0,-88);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));`);const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});const file=path.join(shots,name+'.png');fs.writeFileSync(file,Buffer.from(data,'base64'));return file;}
const setInputs=(cdp,values)=>cdp.evaluate(`for(const [id,value] of Object.entries(${JSON.stringify(values)})){const el=document.getElementById(id);if(!el)throw Error('Missing input '+id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}return true;`);
const clickSel=(cdp,selector)=>cdp.evaluate(`const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Unavailable control');el.click();return true;`);
const overflow=cdp=>cdp.evaluate(`const width=innerWidth,offenders=[];const clipped=el=>{for(let p=el.parentElement;p&&p!==document.documentElement;p=p.parentElement)if(['auto','scroll','hidden'].includes(getComputedStyle(p).overflowX))return true;return false;};for(const el of document.querySelectorAll('body *')){const r=el.getBoundingClientRect();if(r.width&&r.height&&r.right>width+2&&!clipped(el))offenders.push(el.tagName+'.'+el.className);}return {scrollWidth:document.documentElement.scrollWidth,innerWidth:width,offenders:offenders.slice(0,6),offenderCount:offenders.length};`);

try{
  appPort=await freePort();dbPort=await freePort();while(dbPort===appPort)dbPort=await freePort();
  if([4300,55440].includes(appPort)||[4300,55440].includes(dbPort))throw Error('Reserved learner port');
  base='http://127.0.0.1:'+appPort;
  if(['container','volume','network','image'].some(kind=>labelled(kind).length))throw Error('Generated project already exists');
  fs.writeFileSync(envFile,`HATOVE_APP_PORT=${appPort}\nHATOVE_DB_PORT=${dbPort}\nHATOVE_PUBLIC_ORIGIN=${base}\nHATOVE_CONTENT_MODE=public\n`);
  await sourceFixture();console.log(`Saved-explanation source fixture: ${project}, ${base}, database127.0.0.1:${dbPort}, schema=${schema}`);
  started=true;compose(['up','--build','-d']);compose(['stop','worker']);verifyProject();
  let ready=false;const deadline=Date.now()+60000;
  while(Date.now()<deadline){try{if((await fetch(base+'/api/ready',{signal:AbortSignal.timeout(3000)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  if(!ready)throw Error('Disposable saved-explanation stack not ready');
  migrateProgram(`await importPackage(migration,internal,{publisher:'synthetic-s6-browser-internal'});console.log('internal fixture imported');`);
  const email=`browser-${stamp}@example.test`,newcomerEmail=`newcomer-${stamp}@example.test`,password='synthetic-browser-pass-1';
  for(const address of [email,newcomerEmail]){const signup=await fetch(base+'/api/auth/sign-up/email',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({email:address,password,name:'Saved Explanation Browser Evidence'})});if(signup.status!==200)throw Error('Synthetic signup failed: '+signup.status);}
  record('P07 isolated source runtime has synthetic named content and refuses external provider I/O',true);
  await verifyExplanations({base,email,newcomerEmail,password,fixture,freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,
    publishAvailable:()=>migrateProgram(`for(const id of ids)await review('content',id);await review('blueprint',internal.exam.id,internal.blueprint.version);for(const form of internal.forms)await review('form',form.id,form.version);const published={...internal,release:{version:${JSON.stringify(availableVersion)},state:'available',resumeBlockedReleases:[]},sets:[],media:[],writingTasks:[],rubrics:[]};await importPackage(migration,published,{publisher:'synthetic-s6-browser-public-simulation'});console.log('named synthetic decisions and reference-only available fixture published');`),
    drainWorker:()=>{const result=migrateProgram(`await import('./server/explanation-fixture-provider-probe.mjs');const {createWorker}=await import('./server/owned-postgres/worker.mjs');const {createExamCatalogue}=await import('./server/preparation-contract.mjs');const pool=persistentRolePool(config,'worker');try{await createWorker({pool,examCatalogue:createExamCatalogue({enabled:['telc-deutsch-b1','dtz-a2-b1']})}).runOnce();console.log('PROVIDER_COUNT='+globalThis.__explanationProviderCalls);}finally{await pool.end();}`);const match=/PROVIDER_COUNT=(\d+)/.exec(result);if(!match)throw Error('Worker provider counter missing');workerProviderCalls+=Number(match[1]);},
    snapshot:()=>{const db=JSON.parse(migrateProgram(`const snapshot={};for(const table of ['submissions','assessments','jobs','usage_ledger','entitlements']){const r=await admin.query('SELECT row_to_json(t) AS value FROM '+table+' t');snapshot[table]=r.rows.map(row=>JSON.stringify(row.value)).sort();}console.log(JSON.stringify(snapshot));`));const count=Number(compose(['exec','-T','app','node','-e',"const fs=require('node:fs');console.log(fs.existsSync('/tmp/explanation-provider-count')?fs.readFileSync('/tmp/explanation-provider-count','utf8').length:0)"]));return {...db,providerAttempts:count+workerProviderCalls};},
    grantCredits:prepId=>migrateProgram(`const p=(await admin.query("SELECT owner_id FROM learner_preparation WHERE id=$1 AND exam_id='dtz-a2-b1'",[${JSON.stringify(prepId)}])).rows[0];if(!p)throw Error('Synthetic preparation missing');await admin.query("INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved) VALUES($1,'dtz-a2-b1',10,0,0)",[p.owner_id]);`),
    withdrawWritingRights:()=>migrateProgram(`const id=internal.writingTasks[0].taskId+'@'+internal.writingTasks[0].version;if(!ids.includes(id))throw Error('Unknown synthetic task');await migration.query("INSERT INTO content_rights(content_version_id,basis,decided_by,note) VALUES($1,'unknown','synthetic C03 browser','Test-only rights withdrawal')",[id]);`),
  });
}catch(error){record('Explanation isolated browser execution completes',false,error.stack||error.message);}
finally{
  if(started)try{
    // Every removable volume must belong to this unique project; no global pruning or fixed names.
    for(const id of labelled('volume')){const row=JSON.parse(command('docker',['volume','inspect',id]))[0];if(row.Labels?.['com.docker.compose.project']!==project)throw Error('Unsafe cleanup volume');}
    for(const id of labelled('image')){const row=JSON.parse(command('docker',['image','inspect',id]))[0];if(row.Config.Labels?.['com.docker.compose.project']!==project||!(row.RepoTags||[]).every(tag=>['app','worker','migrate'].some(service=>tag===project+'-'+service+':latest')))throw Error('Unsafe cleanup image');}
    compose(['down','-v','--remove-orphans','--rmi','local']);if(['container','volume','network','image'].some(kind=>labelled(kind).length))throw Error('Disposable resources remain');cleaned=true;console.log('Removed and verified disposable project '+project);
  }catch(error){record('Explanation fixture cleanup',false,error.message);}
  const resolved=fs.realpathSync(scratch);
  if((!started||cleaned)&&path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith(project+'-'))fs.rmSync(resolved,{recursive:true,force:true});else console.log('Preserved source/Compose recovery files at '+scratch);
  fs.mkdirSync(shots,{recursive:true});fs.writeFileSync(path.join(shots,'results.json'),JSON.stringify({mode:'saved-explanations',sourceRevision,sourceChanges,project,base,dbPort,schema,cleaned,finishedAt:new Date().toISOString(),screenshots:fs.readdirSync(shots).filter(name=>name.endsWith('.png')).sort(),limits:['Synthetic technical content; no human educational approval','Headless Chromium emulation; no physical-device or screen-reader acceptance','Synthetic pending/failed/representation refusal fixtures test only rendering'],results},null,2));
  const failures=results.filter(result=>!result.ok);console.log(`${results.length-failures.length} passed, ${failures.length} failed; screenshots ${shots}`);
  console.log('Headless Chromium and synthetic technical content only; physical devices and human approval remain pending.');process.exitCode=failures.length?1:0;
}
