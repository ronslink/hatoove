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
import http from 'node:http';
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
    '/assets/design/..%2f..%2findex.html',
    '/assets/design/..%2f..%2fapp%2fapp.js',
    '/assets/design/%2e%2e/%2e%2e/data/seed.json',
    '/data%2fseed.json',
  ];
  for(const p of traversals){
    const res=await fetch(base+p,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    assert.ok([401,403,404].includes(res.status),'encoded traversal '+p+' must be refused, got '+res.status);
  }
  passed('encoded path traversal reaches nothing: the gate sees the resolved file, not the URL');
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
  const nav=await fetch(base+'/',{headers:{accept:'text/html,application/xhtml+xml'},redirect:'manual',signal:AbortSignal.timeout(10000)});
  assert.equal(nav.status,302,'a logged-out navigation must be REDIRECTED, not refused; a 401 shows a browser a blank page');
  assert.ok((nav.headers.get('location')||'').endsWith('/signin'),'the redirect must target /signin, got '+nav.headers.get('location'));
  const signinPage=await request('GET','/signin');
  assert.equal(signinPage.status,200);
  assert.ok(signinPage.text.includes('id="form-signin"'),'the redirect target must actually serve the sign-in form');
  assert.equal((await request('GET','/')).status,401,'a script must still be refused 401 rather than handed HTML');
  passed('a logged-out browser is redirected to a real sign-in form; a script is refused 401');

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
  /*
   * PILOT-04 — the exam-scoped catalogue and its serving policy.
   *
   * The shell's Ueben view has been an honest empty state because NO learner-facing route could
   * reach the catalogue: `GET /api/v1/tasks` did not exist. These legs define what it must do, and
   * they are the reason the route cannot be faked.
   *
   * L4 and L5 are a PAIR and neither is sufficient alone. Every seeded row is `unreviewed`, so the
   * fail-closed default must serve NOTHING — a check expecting six rows there would be asserting a
   * leak. But "returns an empty array" is also satisfied by a route that ALWAYS returns an empty
   * array, so L5 re-runs the same route under the pilot policy and requires the seeded versions to
   * appear. One leg without the other measures nothing.
   */
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

  const closed=await request('GET','/api/v1/tasks?family=writing',undefined,cookie);
  assert.equal(closed.status,200,'the task route must exist and answer a signed-in learner, got '+closed.status);
  assert.ok(Array.isArray(closed.json),'the task list must be a JSON array');
  assert.equal(closed.json.length,0,'with the fail-closed policy and only unreviewed rows the list must be EMPTY, got '+closed.json.length);
  passed('the fail-closed default serves NOTHING while every seeded row is unreviewed');

  // The same route under the pilot policy, in a separate container so the default stays fail-closed.
  const probePort=await freePort();
  const probeName='hatoove-p04-'+process.pid;
  const appImage=project+'-app';
  spawnSync('docker',['rm','-f',probeName],{encoding:'utf8',windowsHide:true});
  spawnSync('docker',['run','-d','--name',probeName,'--network',project+'_default',
    '-p','127.0.0.1:'+probePort+':4321',
    '-e','B1PREP_BIND=0.0.0.0','-e','B1PREP_SAAS=1','-e','B1PREP_ACCOUNTS=1','-e','B1PREP_PORT=4321',
    '-e','B1PREP_PUBLIC_ORIGIN=http://127.0.0.1:'+probePort,
    '-e','B1PREP_SERVE_REVIEW=approved+unreviewed',
    '-e','OWNAPI_PG_HOST=db','-e','OWNAPI_PG_PORT=5432','-e','OWNAPI_PG_DATABASE=hatoove','-e','OWNAPI_PG_USER=postgres',
    appImage,'node','server.js'],{encoding:'utf8',windowsHide:true});
  try{
    const probeBase='http://127.0.0.1:'+probePort;
    const deadline=Date.now()+60000;
    let up=false;
    while(Date.now()<deadline){
      try{ if((await fetch(probeBase+'/api/ready',{signal:AbortSignal.timeout(4000)})).ok){ up=true; break; } }catch{}
      await new Promise(r=>setTimeout(r,500));
    }
    assert.ok(up,'the permissive-policy probe did not become ready');
    const signIn=await fetch(probeBase+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:probeBase},body:JSON.stringify({email:credentials.email,password:credentials.password}),signal:AbortSignal.timeout(10000)});
    assert.equal(signIn.status,200,'sign-in against the probe failed');
    const probeCookie=signIn.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const open=await fetch(probeBase+'/api/v1/tasks?family=writing',{headers:{cookie:probeCookie},signal:AbortSignal.timeout(10000)});
    assert.equal(open.status,200);
    const listed=await open.json();
    assert.ok(Array.isArray(listed)&&listed.length>0,'under approved+unreviewed the seeded task versions must appear, got '+JSON.stringify(listed).slice(0,200));
    assert.ok(listed.every(t=>typeof t.review_status==='string'),'every listed task must carry its review_status so a learner can be told the truth');
    // Keys are never served with a task: they live in a table granted to no runtime role.
    const serialised=JSON.stringify(listed);
    for(const leak of ['leitpunkte_answers','answer_key','answerKey','correctAnswer']){
      assert.ok(!serialised.includes(leak),'a task payload must not carry '+leak);
    }
    passed('the same route under the pilot policy serves '+listed.length+' task version(s), each with its review_status and no answer key');
  } finally {
    spawnSync('docker',['rm','-f',probeName],{encoding:'utf8',windowsHide:true});
  }
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
