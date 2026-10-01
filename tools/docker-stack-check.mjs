#!/usr/bin/env node
/**
 * DOCKER-ONLY-01: disposable Compose acceptance. Requires Docker + Node for this developer check.
 * The product itself needs only Docker. Never uses or stops an existing project/volume.
 * No browser, external provider, real account or host .env is used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const project='hatoove-check-'+Date.now()+'-'+process.pid;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),project+'-'));
const envFile=path.join(scratch,'compose.env');
const marker='DOCKER-ONLY-SYNTHETIC-'+project;
const sentinels=['progress-'+project+'.json','public/progress-'+project+'.json'];
let started=false;
let count=0;
const passed=label=>console.log('PASS '+(++count)+' '+label);
function docker(args) {
  const r=spawnSync('docker',args,{cwd:root,env:{...process.env,HATOVE_APP_PORT:String(appPort),HATOVE_DB_PORT:String(dbPort),HATOVE_PUBLIC_ORIGIN:base},encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:8*1024*1024});
  if(r.error || r.status!==0) throw new Error('docker '+args[0]+': '+(r.error?.message || r.stderr || r.stdout).slice(-2400));
  return r.stdout.trim();
}
const compose=args=>docker(['compose','--env-file',envFile,'-p',project,'-f',path.join(root,'compose.yaml'),...args]);
async function freePort(){
  const s=net.createServer();
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}
const appPort=await freePort();
let dbPort=await freePort();
while(dbPort===appPort) dbPort=await freePort();
const base='http://127.0.0.1:'+appPort;
fs.writeFileSync(envFile,'HATOVE_APP_PORT='+appPort+'\nHATOVE_DB_PORT='+dbPort+'\nHATOVE_PUBLIC_ORIGIN='+base+'\n');
async function request(method,url,body,cookie){
  const headers={origin:base};
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
  assert.equal(String(config.services.app.ports[0].published),String(appPort));
  assert.equal(String(config.services.db.ports[0].published),String(dbPort));
  assert.equal(config.services.app.environment.B1PREP_PUBLIC_ORIGIN,base);
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
  assert.equal(rows,'6');
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.task_version']).trim(),'6');
  const elevated=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',"SELECT count(*) FROM pg_roles WHERE rolname LIKE 'hatoove_%' AND (rolsuper OR rolbypassrls)"]).trim();
  assert.equal(elevated,'0');
  passed('six numbered migrations and six task versions; application roles not superuser/BYPASSRLS');
  const rejected=['/app/.git','/app/work','/app/research','/app/tools','/app/handoff','/app/.env',...sentinels.map(p=>'/app/'+p)];
  const audit="const fs=require('node:fs');const bad="+JSON.stringify(rejected)+".filter(p=>fs.existsSync(p));if(bad.length)throw Error('private/unneeded image paths: '+bad.join(','));";
  compose(['exec','-T','app','node','-e',audit]);
  const workerId=compose(['ps','-q','worker']);
  assert.ok(workerId);
  assert.equal(JSON.parse(docker(['inspect',workerId]))[0].Config.Healthcheck,undefined);
  passed('built image excludes synthetic private files; worker inherits no HTTP probe');
  compose(['run','--rm','--no-deps','migrate']);
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.hatoove_migrations']).trim(),'6');
  passed('re-running migrations leaves the ledger at six entries');
  assert.equal((await request('GET','/')).status,401);
  const credentials={name:'Docker check',email:project+'@example.invalid',password:'Synthetic-password-2026'};
  const signup=await request('POST','/api/auth/sign-up/email',credentials);
  assert.equal(signup.status,200,signup.text);
  let cookie=signup.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  assert.ok(cookie);
  const accountBefore=await request('GET','/api/v1/account',undefined,cookie);
  assert.equal(accountBefore.status,200);
  assert.equal((await request('GET','/',undefined,cookie)).status,200);
  const settings=await request('GET','/api/v1/settings',undefined,cookie);
  assert.equal(settings.status,200);
  const saved=await request('PUT','/api/v1/settings',{expectedRevision:settings.json.revision,settings:{examDate:'2026-12-01',language:'en'}},cookie);
  assert.equal(saved.status,200,saved.text);
  passed('synthetic signup, protected shell and owned settings work at configured origin');
  compose(['restart','app','worker']);
  await ready();
  const login=await request('POST','/api/auth/sign-in/email',{email:credentials.email,password:credentials.password});
  assert.equal(login.status,200,login.text);
  cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const after=await request('GET','/api/v1/settings',undefined,cookie);
  assert.equal(after.json.settings.examDate,'2026-12-01');
  assert.equal(after.json.settings.language,'en');
  passed('fresh sign-in after container restart restores saved account settings');
  console.log(count+' passed; product journeys, auth attack cases and model validity are separate gates.');
} finally {
  if(started){
    // Only this check's unique project is removed; no prune and no existing project is touched.
    try{compose(['down','--volumes','--remove-orphans']);console.log('Removed disposable project '+project);}
    catch(error){console.error('Cleanup failed for '+project+': '+error.message);process.exitCode=1;}
  }
  for(const file of sentinels){
    const full=path.join(root,file);
    if(fs.existsSync(full)&&fs.readFileSync(full,'utf8')===marker)fs.unlinkSync(full);
  }
  assert.equal(path.dirname(path.resolve(scratch)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith(project+'-'));
  fs.rmSync(scratch,{recursive:true,force:true});
}
