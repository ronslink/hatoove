/** In-container transport assertions. Only the generated fixture's internal ingress is reachable. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {buildSignatureHeader} from '../server/payments/signature.mjs';
import {EXAM,VERSION,RELEASE,fixturePath,PROBE_CHECKS,PROBE_STEPS} from './production-runtime-fixture.mjs';

const mode=process.argv[2];
if(process.argv.length!==3||!Object.hasOwn(PROBE_CHECKS,mode)){console.error('hosting_probe_arguments_invalid');process.exit(2);}
let ca,step='probe_setup',httpStatus=null;
const ownErrors=new WeakMap();
function transportError(kind){const error=Error('hosting_probe_transport_failed');ownErrors.set(error,kind);return error;}
function enter(next,status=null){assert.ok(PROBE_STEPS.includes(next));step=next;httpStatus=status;}
function errorClass(error) {
  try {
    if(ownErrors.has(error))return ownErrors.get(error);
    if(error instanceof assert.AssertionError)return 'assertion_failed';
    const code=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:null;
    if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code))return 'tls_failed';
    if(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE'].includes(code))return 'transport_failed';
  } catch {}
  return 'unexpected_failure';
}
const checks=[];
const origin='https://hatoove.com';
async function check(name,work){enter(name);await work();checks.push(name);}
function request(url,{method='GET',headers={},body,plain=false}={}) {
  assert.ok(url.startsWith('/')&&!url.startsWith('//'));
  const bytes=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  httpStatus=null;
  return new Promise((resolve,reject)=>{
    const req=(plain?http:https).request({hostname:'ingress',port:plain?80:443,servername:'hatoove.com',ca,
      rejectUnauthorized:true,method,path:url,headers:{host:'hatoove.com',connection:'close',...(bytes?{'content-type':'application/json','content-length':bytes.length}:{}),...headers}},
      res=>{httpStatus=Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null;const parts=[];let length=0;res.on('data',part=>{length+=part.length;if(length>3*1024*1024)res.destroy(transportError('response_bound'));else parts.push(part);});
        res.on('error',reject);res.on('end',()=>{const raw=Buffer.concat(parts);let json;try{json=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,raw,json});});});
    req.setTimeout(8000,()=>req.destroy(transportError('request_timeout')));req.on('error',reject);req.end(bytes??undefined);
  });
}
const authHeaders=account=>({cookie:account.cookie,'x-hatoove-account':account.id,origin});
async function account(suffix) {
  enter('account_'+suffix+'_signup');
  const credentials={name:'Synthetic hosting '+suffix,email:'hosting-'+randomUUID()+'@example.invalid',password:'synthetic-hosting-password-1'};
  const created=await request('/api/auth/sign-up/email',{method:'POST',headers:{origin},body:credentials});
  assert.equal(created.status,200);
  enter('account_'+suffix+'_cookie',created.status);
  const cookies=created.headers['set-cookie'];assert.ok(Array.isArray(cookies));
  const issued=cookies.find(value=>value.startsWith('hatoove_owned_session='));
  assert.ok(issued);for(const pattern of [/;\s*Secure(?:;|$)/i,/;\s*HttpOnly(?:;|$)/i,/;\s*SameSite=Lax(?:;|$)/i,/;\s*Path=\/(?:;|$)/i])assert.match(issued,pattern);
  const cookie=issued.split(';')[0];enter('account_'+suffix+'_read');
  const result=await request('/api/v1/account',{headers:{cookie}});
  assert.equal(result.status,200);assert.equal(typeof result.json.id,'string');
  return {id:result.json.id,cookie,credentials};
}
function privateHeaders(result,prefix) {
  enter(prefix+'_cache_no_store',result.status);assert.match(result.headers['cache-control'],/no-store/);
  enter(prefix+'_cache_private',result.status);assert.match(result.headers['cache-control'],/private/);
  enter(prefix+'_nosniff',result.status);assert.equal(result.headers['x-content-type-options'],'nosniff');
}
async function readiness() {
  const ready=await request('/api/ready');assert.equal(ready.status,200);assert.equal(ready.json.ready,true);
}

try {
  const binding=JSON.parse(await fs.readFile('/fixture/binding.json','utf8'));
  assert.match(binding.project,/^hatoove-hosting-[0-9]+-[0-9]+-(local|managed)$/);
  assert.equal(process.env.HOSTING_FIXTURE_ID,binding.project);
  ca=await fs.readFile('/fixture/ca.crt');
  if(mode==='unavailable') {
    await check('stopped_runtime_is_not_served',async()=>{enter('unavailable_readiness');assert.equal((await request('/api/ready')).status,502);});
  } else if(mode==='stale') {
    await check('stale_schema_refuses_without_migrating',async()=>{
      enter('stale_health');assert.equal((await request('/api/health')).status,200);
      enter('stale_readiness');const ready=await request('/api/ready');assert.equal(ready.status,503);assert.equal(ready.json.reason,'schema_behind');
      enter('stale_protected_route');assert.equal((await request('/api/v1/account')).status,503);
    });
  } else {
    await check('canonical_https_ready',readiness);
    if(mode==='initial') {
      await check('canonical_host_and_origin_and_forwarding_boundaries',async()=>{
        enter('foreign_https_host');
        assert.equal((await request('/api/health',{headers:{host:'foreign.invalid'}})).status,421);
        enter('foreign_http_host');
        const foreignHttp=await request('/signin',{plain:true,headers:{host:'foreign.invalid'}});
        assert.equal(foreignHttp.status,421);assert.equal(foreignHttp.headers.location,undefined);
        enter('foreign_origin_and_forwarding');const refused=await request('/api/auth/sign-up/email',{method:'POST',headers:{origin:'https://foreign.invalid','x-forwarded-host':'hatoove.com','x-forwarded-proto':'https',forwarded:'host=hatoove.com;proto=https'},body:{}});
        assert.equal(refused.status,403);assert.equal(refused.json.code,'origin_rejected');
        enter('canonical_http_redirect');const redirected=await request('/signin',{plain:true});assert.equal(redirected.status,308);
        assert.equal(redirected.headers.location,origin+'/signin');
        enter('security_headers');const headers=(await request('/signin')).headers;
        assert.equal(headers['x-content-type-options'],'nosniff');assert.equal(headers['referrer-policy'],'no-referrer');assert.equal(headers['x-frame-options'],'DENY');
      });
      const a=await account('initial');
      await check('public_default_withholds_unreviewed_and_payments_are_off',async()=>{
        enter('public_preparations');
        const preps=await request('/api/v1/preparations',{headers:authHeaders(a)});
        assert.equal(preps.status,200);const prep=preps.json.preparations.find(p=>p.exam_id===EXAM);assert.ok(prep);
        enter('public_tasks_withheld');const tasks=await request('/api/v1/tasks?preparationId='+prep.id,{headers:authHeaders(a)});
        assert.equal(tasks.status,200);assert.deepEqual(tasks.json,[]);
        enter('payments_off');const off=await request('/api/v1/payments/stripe/webhook',{method:'POST',body:Buffer.from('{}')});
        assert.equal(off.status,503);assert.equal(off.json.error,'payments_unavailable');
      });
      await check('secure_logout_invalidates_and_secure_signin_reissues',async()=>{
        enter('logout');
        const out=await request('/api/auth/sign-out',{method:'POST',headers:authHeaders(a),body:{}});
        assert.equal(out.status,200);assert.ok(out.headers['set-cookie'].some(value=>/hatoove_owned_session=/.test(value)&&/;\s*Secure(?:;|$)/i.test(value)&&/Max-Age=0/.test(value)));
        enter('logout_old_cookie');assert.equal((await request('/api/v1/account',{headers:authHeaders(a)})).status,401);
        enter('signin');
        const signed=await request('/api/auth/sign-in/email',{method:'POST',headers:{origin,'x-forwarded-proto':'http'},body:{email:a.credentials.email,password:a.credentials.password}});
        assert.equal(signed.status,200);assert.ok(signed.headers['set-cookie'].some(value=>/;\s*Secure(?:;|$)/i.test(value)));
      });
    } else if(mode==='public') {
      const a=await account('media'),b=await account('foreign');
      await check('named_public_fixture_and_owned_media_range_transport',async()=>{
        enter('media_fixture_read');
        const pkg=JSON.parse(await fs.readFile(new URL('../'+fixturePath,import.meta.url),'utf8'));
        const form=pkg.forms.find(row=>row.attemptMode==='practice');assert.ok(form);
        enter('media_preparations');
        const preps=(await request('/api/v1/preparations',{headers:authHeaders(a)})).json.preparations;
        const prep=preps.find(row=>row.exam_id===EXAM);assert.ok(prep);
        enter('media_forms_status');
        const forms=await request('/api/v1/mock-forms?preparationId='+prep.id,{headers:authHeaders(a)});
        assert.equal(forms.status,200);enter('media_forms_presence',forms.status);assert.ok(forms.json.forms.some(row=>row.form_id===form.id));
        enter('media_start');
        const started=await request('/api/v1/mock-runs',{method:'POST',headers:authHeaders(a),body:{preparationId:prep.id,formId:form.id,formVersion:VERSION,releaseVersion:RELEASE,eventId:randomUUID()}});
        assert.equal(started.status,201);const run=started.json.run??started.json;
        enter('media_recording',started.status);
        const recording=run.members.flatMap(member=>member.recordings??[])[0];assert.ok(recording);
        enter('media_metadata');
        const metadata=pkg.media.find(row=>row.mediaId===recording.media_id&&row.version===recording.media_version);assert.ok(metadata);
        enter('media_expected_bytes');
        const expected=await fs.readFile(pathForMedia(metadata.path));
        const url='/api/v1/mock-runs/'+run.id+'/media/'+recording.media_id+'/'+recording.media_version;
        enter('media_full_status');const full=await request(url,{headers:authHeaders(a)});assert.equal(full.status,200);
        privateHeaders(full,'media_full');
        enter('media_full_bytes',full.status);assert.deepEqual(full.raw,expected);
        enter('media_full_etag',full.status);assert.equal(full.headers.etag,'"sha256-'+createHash('sha256').update(expected).digest('hex')+'"');
        enter('media_full_length',full.status);assert.equal(Number(full.headers['content-length']),expected.length);
        enter('media_full_accept_ranges',full.status);assert.equal(full.headers['accept-ranges'],'bytes');
        enter('media_head_status');const head=await request(url,{method:'HEAD',headers:authHeaders(a)});assert.equal(head.status,200);
        enter('media_head_body',head.status);assert.equal(head.raw.length,0);
        enter('media_head_length',head.status);assert.equal(Number(head.headers['content-length']),expected.length);
        privateHeaders(head,'media_head');
        enter('media_range_status');const part=await request(url,{headers:{...authHeaders(a),range:'bytes=2-19'}});assert.equal(part.status,206);
        enter('media_range_bytes',part.status);assert.deepEqual(part.raw,expected.subarray(2,20));
        enter('media_range_header',part.status);assert.equal(part.headers['content-range'],'bytes 2-19/'+expected.length);
        privateHeaders(part,'media_range');
        enter('media_suffix_status');const tail=await request(url,{headers:{...authHeaders(a),range:'bytes=-11'}});assert.equal(tail.status,206);
        enter('media_suffix_bytes',tail.status);assert.deepEqual(tail.raw,expected.subarray(-11));
        enter('media_unsatisfiable_status');const invalid=await request(url,{headers:{...authHeaders(a),range:'bytes='+expected.length+'-'}});assert.equal(invalid.status,416);
        enter('media_unsatisfiable_header',invalid.status);assert.equal(invalid.headers['content-range'],'bytes */'+expected.length);
        enter('media_unsatisfiable_body',invalid.status);assert.equal(invalid.raw.length,0);
        privateHeaders(invalid,'media_unsatisfiable');
        enter('media_anonymous');assert.equal((await request(url)).status,401);
        enter('media_foreign_owner');assert.equal((await request(url,{headers:authHeaders(b)})).status,404);
        enter('media_account_generation');const stale=await request(url,{headers:{...authHeaders(a),'x-hatoove-account':b.id}});assert.equal(stale.status,409);assert.equal(stale.json.error,'account_changed');
        enter('media_forged_forwarding');const forged=await request(url,{headers:{'x-forwarded-for':'127.0.0.1','cf-connecting-ip':'127.0.0.1','x-hatoove-account':a.id}});assert.equal(forged.status,401);
        enter('media_static_path');assert.equal((await request('/content/exams/'+EXAM+'/s5-technical/'+VERSION+'/hv1-1.wav',{headers:authHeaders(a)})).status,404);
      });
    } else {
      await check('synthetic_signed_raw_bytes_and_replay',async()=>{
        enter('stub_secret_read');
        const secret=await fs.readFile('/fixture/webhook-secret','utf8');
        const raw=Buffer.from(' { "id": "evt_hosting_synthetic_bytes", "type": "hosting.synthetic", "livemode": false, "data": {"object": {"note":"Grüße العربية"}} }\n');
        enter('stub_signature_build');
        const signature=buildSignatureHeader({rawBody:raw,secret,timestamp:Math.floor(Date.now()/1000)});
        const send=(body,signatureHeader=signature,url='/api/v1/payments/stripe/webhook')=>request(url,{method:'POST',headers:{'stripe-signature':signatureHeader,origin:'https://foreign.invalid'},body});
        enter('stub_invalid_signature');assert.equal((await send(raw+' ','bad')).status,400);
        enter('stub_modified_bytes');assert.equal((await send(Buffer.concat([raw,Buffer.from(' ')]))).status,400);
        for(let n=0;n<2;n++){enter(n===0?'stub_first_delivery':'stub_replay');const result=await send(raw);assert.equal(result.status,200);assert.equal(result.json.received,true);}
        enter('stub_sibling_path');assert.equal((await send(raw,signature,'/api/v1/payments/stripe/webhook/')).status,403);
        enter('stub_body_limit');assert.equal((await send(Buffer.alloc(65537))).status,413);
      });
    }
  }
  console.log(JSON.stringify({mode,checks,passed:checks.length,outcome:'passed',failure:null}));
} catch(error) {console.log(JSON.stringify({mode,checks,passed:checks.length,outcome:'failed',failure:{step,class:errorClass(error),httpStatus}}));process.exitCode=1;}
function pathForMedia(value){assert.ok(value.startsWith('content/exams/'+EXAM+'/s5-technical/'+VERSION+'/')&&!value.includes('..'));return new URL('../'+value,import.meta.url);}
