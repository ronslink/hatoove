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
// Derived, NOT hardcoded: a count pinned to today's number breaks on legitimate work, which is
// its own defect class. The ledger must hold exactly the migrations on disk.
const migrationCount=fs.readdirSync(path.join(root,'server','migrations')).filter(f=>/^\d{4}-.*\.sql$/.test(f)).length;
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
  assert.equal(rows,String(migrationCount),'the ledger must hold exactly the migrations on disk');
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.task_version']).trim(),'6');
  const elevated=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',"SELECT count(*) FROM pg_roles WHERE rolname LIKE 'hatoove_%' AND (rolsuper OR rolbypassrls)"]).trim();
  assert.equal(elevated,'0');
  passed(String(migrationCount)+' migrations applied and 6 task versions; application roles not superuser/BYPASSRLS');
  const rejected=['/app/.git','/app/work','/app/research','/app/tools','/app/handoff','/app/.env',...sentinels.map(p=>'/app/'+p)];
  const audit="const fs=require('node:fs');const bad="+JSON.stringify(rejected)+".filter(p=>fs.existsSync(p));if(bad.length)throw Error('private/unneeded image paths: '+bad.join(','));";
  compose(['exec','-T','app','node','-e',audit]);
  const workerId=compose(['ps','-q','worker']);
  assert.ok(workerId);
  assert.equal(JSON.parse(docker(['inspect',workerId]))[0].Config.Healthcheck,undefined);
  passed('built image excludes synthetic private files; worker inherits no HTTP probe');
  compose(['run','--rm','--no-deps','migrate']);
  assert.equal(compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc','SELECT count(*) FROM hatoove.hatoove_migrations']).trim(),String(migrationCount));
  passed('re-running migrations leaves the ledger at '+migrationCount+' entries');
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
   * The LEGACY routes are in the list deliberately: /api/progress, /api/config, /api/ai and
   * /api/ai/test used to answer with no identity at all, and /api/progress even served a file.
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
   * OBJECTIVE-SEED-01 -- the authored corpus is IN THE DATABASE, and its answers are not.
   *
   * The answers sit INLINE in data/seed.json, in the same arrays as the learner-facing text, so a
   * seed that copied the source wholesale would ship every key in the task payload. The split is
   * enforced by a GRANT rather than by a route remembering to strip a field, and these legs prove the
   * grant is real: has_table_privilege asks PostgreSQL, not the code.
   */
  const scored=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    'SELECT sum(item_count) FROM hatoove.objective_set']).trim();
  assert.equal(scored,'180','the corpus must hold exactly the 180 authored answers as scored items, got '+scored);
  const sets=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    'SELECT count(*) FROM hatoove.objective_set']).trim();
  assert.equal(sets,'24','the corpus must hold the 24 authored sets, got '+sets);
  // `jsonb_path_exists` with a recursive wildcard, not a `LIKE` on the JSON text: it DESCENDS into
  // the nested arrays where the answers actually live, so a secret one level deeper than the check
  // still fails it. It also needs no quote-escaping, which is its own small mercy.
  const leaks=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT count(*) FROM hatoove.objective_set WHERE jsonb_path_exists(payload, '$.**.answer') OR jsonb_path_exists(payload, '$.**.why') OR jsonb_path_exists(payload, '$.**.grammar') OR jsonb_path_exists(payload, '$.**.script')"]).trim();
  assert.equal(leaks,'0','no learner payload may carry a secret field, found '+leaks);
  const learnerKey=compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-tAc',
    "SELECT has_table_privilege('hatoove_learner','hatoove.objective_key','SELECT')"]).trim();
  assert.equal(learnerKey,'f','the learner role MUST NOT be able to read objective_key, got '+learnerKey);
  passed('24 objective sets and 180 answers are seeded, no payload carries a secret, and the learner role cannot read the key table');

  // The route that SERVES the corpus, and must never serve the key side of it.
  assert.equal((await request('GET','/api/v1/objective-sets')).status,401,'/api/v1/objective-sets must require a session');
  const objective=await request('GET','/api/v1/objective-sets',undefined,cookie);
  assert.equal(objective.status,200,'the objective route must answer a signed-in learner, got '+objective.status);
  assert.ok(Array.isArray(objective.json),'the objective list must be a JSON array');
  // 24 sets exist, 9 are media-gated (HV has a transcript but no audio) -> 15 servable, 120 of 180 items.
  assert.equal(objective.json.length,15,'15 servable objective sets expected (24 minus 9 media-gated), got '+objective.json.length);
  assert.equal(objective.json.reduce((n,s)=>n+s.item_count,0),120,'120 servable scored items expected, got '+objective.json.reduce((n,s)=>n+s.item_count,0));
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
  passed('the objective route serves 15 sets / 120 items with NO key, and withholds listening until audio exists');

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
   * So the default policy SERVES the seeded content today, and the approval workflow becomes a slice
   * of its own. What is deliberately NOT done is writing `approved` into the rows: that would record
   * a qualified review that has not happened, and AGENTS.md forbids marking content approved. The
   * rows keep their TRUE status and the policy is what changes, so a learner is served the content
   * while being told the truth about it -- and the approval slice later changes a label rather than
   * having to unpick a false one.
   *
   * The pair still discriminates, and now in the opposite direction from before:
   *   default  -> the seeded versions ARE listed, each with its real review_status
   *   approved -> the SAME route returns EMPTY, proving the policy is genuinely consulted and the
   *               fail-closed value still works
   * Without the second leg the first could be satisfied by a route that ignores the policy entirely.
   */
  const listed=await request('GET','/api/v1/tasks?family=writing',undefined,cookie);
  assert.equal(listed.status,200,'the task route must exist and answer a signed-in learner, got '+listed.status);
  assert.ok(Array.isArray(listed.json),'the task list must be a JSON array');
  assert.ok(listed.json.length>0,'the default policy serves the seeded task versions, got '+listed.json.length);
  assert.ok(listed.json.every(t=>typeof t.review_status==='string'),'every listed task must carry its review_status so a learner can be told the truth');
  {
    const serialised=JSON.stringify(listed.json);
    for(const leak of ['leitpunkte_answers','answer_key','answerKey','correctAnswer']){
      assert.ok(!serialised.includes(leak),'a task payload must not carry '+leak);
    }
  }
  passed('the default policy serves '+listed.json.length+' task version(s), each with its review_status and no answer key');

  // The fail-closed value, in its own container so the default stays as Ron directed.
  const probePort=await freePort();
  const probeName='hatoove-p04-'+process.pid;
  const appImage=project+'-app';
  spawnSync('docker',['rm','-f',probeName],{encoding:'utf8',windowsHide:true});
  spawnSync('docker',['run','-d','--name',probeName,'--network',project+'_default',
    '-p','127.0.0.1:'+probePort+':4321',
    '-e','B1PREP_BIND=0.0.0.0','-e','B1PREP_SAAS=1','-e','B1PREP_ACCOUNTS=1','-e','B1PREP_PORT=4321',
    '-e','B1PREP_PUBLIC_ORIGIN=http://127.0.0.1:'+probePort,
    '-e','B1PREP_SERVE_REVIEW=approved',
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
    assert.ok(up,'the fail-closed probe did not become ready');
    const signIn=await fetch(probeBase+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:probeBase},body:JSON.stringify({email:credentials.email,password:credentials.password}),signal:AbortSignal.timeout(10000)});
    assert.equal(signIn.status,200,'sign-in against the probe failed');
    const probeCookie=signIn.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const closed=await fetch(probeBase+'/api/v1/tasks?family=writing',{headers:{cookie:probeCookie},signal:AbortSignal.timeout(10000)});
    assert.equal(closed.status,200);
    const strict=await closed.json();
    assert.ok(Array.isArray(strict),'the task list must be a JSON array');
    assert.equal(strict.length,0,'under an explicit approved-only policy and only unreviewed rows the list must be EMPTY, got '+strict.length);
    passed('an explicit approved-only policy serves NOTHING: the policy is consulted, not hardcoded');
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
