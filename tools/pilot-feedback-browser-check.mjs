/** Source-only, disposable Compose + Chromium evidence. No physical-device claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, connectToPage, sleep } from './cdp.js';
import { browserEnvironment, copyBrowserSource, verifyBrowserProject, verifyBrowserCleanup } from './a11y-browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = 'hatoove-browser-' + Date.now() + '-' + process.pid;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), project + '-'));
const source = path.join(scratch, 'source'), envFile = path.join(scratch,'compose.env');
const shotArg = process.argv.indexOf('--shots');
if (shotArg >= 0 && !process.argv[shotArg + 1]) throw Error('--shots requires a directory');
const shots = shotArg >= 0 ? path.resolve(root, process.argv[shotArg + 1]) : path.join(root,'.qa','pilot-stabilize-20261008',project);
fs.mkdirSync(shots,{recursive:true});
const port = () => new Promise((resolve,reject) => {
  const server = net.createServer(); server.once('error',reject);
  server.listen(0,'127.0.0.1',() => { const value = server.address().port; server.close(() => resolve(value)); });
});
const appPort = await port(), dbPort = await port(), debugPort = await port();
assert.equal(new Set([appPort,dbPort,debugPort]).size,3);
assert.ok(![appPort,dbPort].some(p => [4300,55440].includes(p)));
const base = 'http://127.0.0.1:' + appPort;
const env = {...browserEnvironment(),HATOVE_APP_PORT:String(appPort),HATOVE_DB_PORT:String(dbPort),
  HATOVE_PUBLIC_ORIGIN:base,HATOVE_CONTENT_MODE:'internal-preview',HATOVE_PAYMENTS_MODE:'off',
  STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',OWNAPI_PG_PAYMENTS_PASSWORD:''};
const command = (name,args) => {
  const result = spawnSync(name,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:16e6});
  if (result.status !== 0) throw Error(name + ' failed: ' + (result.stderr || result.stdout).slice(-1800));
  return result.stdout.trim();
};
const compose = args => command('docker',['compose','--env-file',envFile,'-p',project,'-f',path.join(source,'compose.yaml'),...args]);
const query = sql => compose(['exec','-T','db','psql','-U','postgres','-d','hatoove','-At','-v','ON_ERROR_STOP=1','-c',sql]);
const verify = () => verifyBrowserProject({project,dbPort,compose,command});
const pass = label => console.log('PASS ' + label);
let browser, cdp, started = false;
try {
  verifyBrowserCleanup(project,command);
  copyBrowserSource(root,source);
  fs.writeFileSync(envFile,'HATOVE_APP_PORT='+appPort+'\nHATOVE_DB_PORT='+dbPort+'\nHATOVE_PUBLIC_ORIGIN='+base+'\n');
  started = true; compose(['up','-d','--build','--wait','--wait-timeout','180']); verify();
  // Match the released listening package; the original v1 blueprint deliberately has no playback contract.
  console.log('Listening package: '+compose(['run','--rm','--no-deps','-T','migrate','node','tools/import-exam-package.mjs',
    'content/exams/telc-deutsch-b1/listening-package.json','--media-root','/app/media']));
  browser = await launchBrowser(debugPort,{autoPlay:true}); cdp = await connectToPage(debugPort);
  await cdp.send('Network.enable');
  await cdp.send('Page.navigate',{url:base+'/signin?mode=signup'});
  await cdp.waitFor("document.querySelector('#su-submit')");
  await sleep(500);
  await cdp.click('#tab-signup');
  await cdp.waitFor("document.querySelector('#form-signup').getBoundingClientRect().height>0");
  const email = project+'@example.test';
  await cdp.evaluate(`for(const [id,value] of Object.entries(${JSON.stringify({'su-name':'Synthetic Feedback','su-email':email,'su-password':'Synthetic-feedback-pass-2026'})})){
    const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));}
    document.getElementById('su-submit').click();`);
  try { await cdp.waitFor("location.pathname.startsWith('/app') && document.querySelector('#account-email')?.textContent.includes('@')",20000); }
  catch (error) { console.log(await cdp.evaluate("return {path:location.href,error:document.getElementById('error')?.innerText,body:document.body.innerText.slice(-800)}"));throw error; }
  pass('synthetic account reaches the app');
  const round = 'browser-feedback-v1';
  query(`UPDATE hatoove."user" SET "createdAt"=now()-interval '8 days' WHERE email='${email}';
    SELECT hatoove.operator_seed_survey_round('${round}',now()-interval '1 hour',now()+interval '1 day',
    '[{"id":"ease","type":"scale","min":1,"max":5},{"id":"useful","type":"scale","min":1,"max":5},{"id":"explanations","type":"scale","min":1,"max":5},{"id":"recommend","type":"scale","min":0,"max":10},{"id":"next","type":"text","max_length":1000}]'::jsonb,7);`);
  const shot = async name => {
    const result = await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(result.data,'base64'));
  };
  for (const [width,height,label,locale] of [[1440,900,'desktop','de'],[390,844,'phone','ar']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
    await cdp.send('Page.navigate',{url:base+'/app/?feedbackFixture='+label+'#/heute'});
    await cdp.waitFor("document.querySelector('#account-email')?.textContent.includes('@')");
    await cdp.evaluate(`return (async()=>{const core=await import('/assets/i18n/core.js');core.setLocale('${locale}');return true;})()`);
    await cdp.waitFor("document.documentElement.lang === '"+locale+"'");
    await cdp.waitFor("!document.querySelector('#feedback-survey').hidden",15000);
    assert.ok(await cdp.evaluate(`return (async()=>{const {shellMessages}=await import('/assets/i18n/shell-messages.js');return document.querySelector('#feedback-survey h2').textContent===shellMessages['${locale}'].feedbackSurveyTitle;})()`));
    await shot(label+'-survey');
    assert.ok(await cdp.evaluate("return document.documentElement.scrollWidth<=innerWidth+1"));
    if(label==='desktop'){
      await cdp.click('[data-survey-later]');
      assert.equal(await cdp.evaluate("return document.querySelector('#feedback-survey').hidden"),true);
      assert.equal(query("SELECT count(*) FROM hatoove.pilot_feedback WHERE kind='survey'"),'0');
      pass('Later dismisses the card without persisting a skip');
    }
    await cdp.evaluate("location.hash='#/hoeren'");
    await cdp.waitFor("document.querySelector('[data-part-open=\"HV1\"]')?.getBoundingClientRect().height>0");
    await cdp.click('[data-part-open="HV1"]');
    try { await cdp.waitFor("document.querySelector('[data-listening-action]')",15000); }
    catch(error){
      await shot(label+'-part-open-failed');
      for(const event of cdp.events.filter(e=>e.method==='Network.responseReceived' && /practice\/(next|attempts)/.test(e.params.response.url))){
        const b=await cdp.send('Network.getResponseBody',{requestId:event.params.requestId});
        const data=JSON.parse(b.body);
        console.log('Practice response',event.params.response.status,{error:data.error,attempt:data.attempt,hasSet:!!data.set,items:data.items});
      }
      console.log(await cdp.evaluate("return {body:document.querySelector('[data-listening-status]')?.innerText,mount:document.querySelector('[data-listening-mount]')?.outerHTML.slice(0,500)}"));
      console.log(cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description));throw error;
    }
    if (await cdp.evaluate("return !!document.querySelector('[data-listening-action=\"load\"]')")) {
      await cdp.click('[data-listening-action="load"]');
    }
    try { await cdp.waitFor("document.querySelector('[data-listening-action=\"play\"]')",15000); }
    catch(error){
      await shot(label+'-listening-precondition-failed');
      for(const event of cdp.events.filter(e=>e.method==='Network.responseReceived' && /practice\/attempts\/.*\/playback/.test(e.params.response.url))){
        const b=await cdp.send('Network.getResponseBody',{requestId:event.params.requestId});
        console.log('Playback response',event.params.response.status,b.body);
      }
      console.log(await cdp.evaluate("return {text:document.querySelector('[data-listening-status]')?.innerText,buttons:[...document.querySelectorAll('[data-listening-action]')].map(b=>[b.dataset.listeningAction,b.disabled])}"));throw error;
    }
    await cdp.click('[data-listening-action="play"]');
    await cdp.waitFor("document.querySelector('[data-listening-audio]')?.currentTime > 0.1",15000);
    const before = await cdp.evaluate(`const a=document.querySelector('[data-listening-audio]');window.feedbackTestAudio=a;
      const main=document.getElementById('main'),input=document.createElement('input');
      input.id='feedback-test-secret';input.type='password';input.value='SYNTHETIC-PRIVATE-SENTINEL';main.prepend(input);
      window.feedbackTestDom=input.outerHTML;return {time:a.currentTime,src:a.src,paused:a.paused};`);
    await cdp.click('#feedback-open');
    await cdp.waitFor("document.querySelector('.feedback-scrim') && !document.querySelector('.feedback-scrim').hidden",7000);
    assert.ok(await cdp.evaluate("return !document.querySelector('#feedback-screenshot').hidden"),'capture must produce a preview');
    const privacy = await cdp.evaluate(`return (async()=>{
      const {snapshotForCapture}=await import('/app/screenshot.js');const s=snapshotForCapture(document.getElementById('main'));
      const masked=s.node.querySelectorAll('[data-feedback-masked]').length;
      const leak=s.node.outerHTML.includes('SYNTHETIC-PRIVATE-SENTINEL');s.remove();
      const input=document.getElementById('feedback-test-secret'),a=document.querySelector('[data-listening-audio]');
      return {masked,leak,value:input.value,domUnchanged:input.outerHTML===window.feedbackTestDom,same:a===window.feedbackTestAudio,time:a.currentTime,paused:a.paused};
    })()`);
    assert.equal(privacy.leak,false);assert.ok(privacy.masked>0);
    assert.equal(privacy.value,'SYNTHETIC-PRIVATE-SENTINEL');assert.equal(privacy.domUnchanged,true);
    assert.equal(privacy.same,true);assert.equal(privacy.paused,false);assert.ok(privacy.time>before.time);
    await shot(label+'-feedback-listening');
    await cdp.evaluate(`document.querySelector('input[name="feedback-category"][value="audio"]').checked=true;
      document.querySelector('#feedback-body').value='Synthetic audio continuity report';
      document.querySelector('#feedback-send').click();`);
    await cdp.waitFor("document.querySelector('#feedback-send').dataset.mode==='close'",15000);
    const after = await cdp.evaluate("return {same:document.querySelector('[data-listening-audio]')===window.feedbackTestAudio,time:window.feedbackTestAudio.currentTime,paused:window.feedbackTestAudio.paused}");
    assert.equal(after.same,true);assert.equal(after.paused,false);assert.ok(after.time>privacy.time);
    assert.equal(query("SELECT count(*) FROM hatoove.pilot_feedback_screenshot"),label==='desktop'?'1':'2');
    assert.ok(await cdp.evaluate("return document.documentElement.scrollWidth<=innerWidth+1"));
    await shot(label+'-feedback-sent');
    await cdp.click('#feedback-close');
    assert.equal(await cdp.evaluate("return document.activeElement.id"),'feedback-open');
    pass(label+' real audio advances through capture, report save and image upload; source DOM/private input intact');
  }
  // Owner export includes the actual stored image bytes; operator notes never enter the browser.
  const exported = await cdp.evaluate(`return (async()=>{const {api}=await import('/app/api.js');
    const r=await api.account.export();return {ok:r.ok,data:r.data};})()`);
  assert.ok(exported.ok);
  const text = JSON.stringify(exported.data); assert.ok(text.includes('feedback_screenshots'));assert.ok(!text.includes('operator_note'));
  pass('learner export includes image files and excludes operator notes');
  await cdp.evaluate("location.hash='#/heute'");
  await cdp.waitFor("!document.querySelector('#feedback-survey').hidden");
  await cdp.click('[data-survey-skip]');
  await cdp.waitFor("!document.querySelector('#feedback-survey form')");
  assert.equal(query("SELECT count(*) FROM hatoove.pilot_feedback WHERE kind='survey' AND survey_answers IS NULL"),'1');
  await cdp.send('Page.navigate',{url:base+'/app/?feedbackFixture=skip-reload#/heute'});
  await cdp.waitFor("document.querySelector('#account-email')?.textContent.includes('@')");
  await sleep(800);
  assert.equal(await cdp.evaluate("return document.querySelector('#feedback-survey').hidden"),true);
  pass('skip persists across a fresh document');
  query(`UPDATE hatoove.survey_round SET closes_at=now()-interval '1 second' WHERE round_id='${round}';
    SELECT hatoove.operator_seed_survey_round('${round}-answers',now()-interval '1 hour',now()+interval '1 day',
    '[{"id":"ease","type":"scale","min":1,"max":5},{"id":"useful","type":"scale","min":1,"max":5},{"id":"explanations","type":"scale","min":1,"max":5},{"id":"recommend","type":"scale","min":0,"max":10},{"id":"next","type":"text","max_length":1000}]'::jsonb,7);`);
  await cdp.send('Page.navigate',{url:base+'/app/?feedbackFixture=answers#/heute'});
  await cdp.waitFor("!document.querySelector('#feedback-survey').hidden",15000);
  await cdp.evaluate(`const form=document.querySelector('#feedback-survey form');
    for(const name of ['ease','useful','explanations','recommend'])form.querySelector('[name="'+name+'"]').checked=true;
    form.querySelector('textarea').value='Synthetic survey answer';
    form.querySelector('button[type="submit"]').click();`);
  await cdp.waitFor("!document.querySelector('#feedback-survey form')");
  assert.equal(query("SELECT count(*) FROM hatoove.pilot_feedback WHERE kind='survey' AND survey_answers->>'next'='Synthetic survey answer'"),'1');
  pass('all five answers persist through the actual survey form');
  const boundaries=await cdp.evaluate(`return (async()=>{
    const {api}=await import('/app/api.js');const session=await api.session();
    const owner=session.data.user.id, headers={'X-Hatoove-Account':owner,'Content-Type':'image/png'};
    const target='/api/v1/feedback/11111111-2222-4333-8444-555555555555/screenshot';
    const status=async(method,path,body,type)=> (await fetch(path,{method,credentials:'same-origin',
      headers:{...headers,...(type?{'Content-Type':type}:{})},body})).status;
    return {tooBig:await status('PUT',target,new Uint8Array(1572865)),
      ordinary:await status('POST','/api/v1/feedback','x'.repeat(70000),'application/json'),
      wrongMethod:await status('POST',target,new Uint8Array(70000)),
      malformed:await status('PUT',target,new Uint8Array([1,2,3]))};
  })()`);
  assert.deepEqual(boundaries,{tooBig:413,ordinary:413,wrongMethod:415,malformed:415});
  pass('real HTTP server keeps the exact PUT binary ceiling and ordinary JSON/method limits');
  await cdp.click('[data-view="einstellungen"]');
  await cdp.waitFor("!document.querySelector('#view-einstellungen').hidden");
  const accountMask=await cdp.evaluate(`return (async()=>{
    const email=document.getElementById('account-email-2'),before=email.outerHTML;
    const {snapshotForCapture}=await import('/app/screenshot.js');const s=snapshotForCapture(document.getElementById('main'));
    const leak=s.node.textContent.includes(email.textContent);s.remove();return {leak,unchanged:email.outerHTML===before,marked:email.hasAttribute('data-feedback-private')};
  })()`);
  assert.deepEqual(accountMask,{leak:false,unchanged:true,marked:true});
  pass('visible Konto email is masked in the snapshot while its live markup stays intact');
  // A new synthetic DOM isolates component failure cases after the actual listening journey.
  const tree=await cdp.send('Page.getFrameTree');
  await cdp.send('Page.setDocumentContent',{frameId:tree.frameTree.frame.id,html:'<!doctype html><html lang="de"><head><link rel="stylesheet" href="/app/feedback.css"></head><body><header class="topbar"></header><main id="main"><button id="invoker">Report</button><input id="secret" type="password" value="SYNTHETIC-PRIVATE"></main></body></html>'});
  const lifecycle=await cdp.evaluate(`return (async()=>{
    const {createFeedbackSheet}=await import('/app/feedback.js');
    const {capturePage}=await import('/app/screenshot.js');
    const {shellMessages}=await import('/assets/i18n/shell-messages.js');
    let creates=0,uploads=0;
    const sheet=createFeedbackSheet({route:()=> 'heute',uiText:k=>shellMessages.de[k],esc:s=>String(s),
      capture:async()=>({blob:new Blob(['synthetic'],{type:'image/png'}),previewUrl:'data:image/png;base64,iVBORw0KGgo='}),
      api:{feedback:{create:async()=>{creates++;return {ok:true,data:{feedback_id:'11111111-2222-4333-8444-555555555555'}};},
        uploadScreenshot:async()=>{uploads++;return {ok:uploads>1};}}}});
    await sheet.open(document.getElementById('invoker'));
    const root=document.querySelector('.feedback-scrim');
    root.querySelector('[name="feedback-category"]').checked=true;root.querySelector('#feedback-body').value='Synthetic';
    root.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,30));const retry=root.querySelector('#feedback-send').dataset.mode;
    root.querySelector('#feedback-send').click();await new Promise(r=>setTimeout(r,30));
    const done=root.querySelector('#feedback-send').dataset.mode;
    sheet.close();await sheet.open();const reset=root.querySelector('#feedback-send').type;sheet.unmount();
    const fallback=createFeedbackSheet({route:()=> 'heute',uiText:k=>shellMessages.de[k],esc:s=>String(s),
      capture:async()=>{throw Error('synthetic capture failure');},api:{feedback:{create:async()=>({ok:true,data:{feedback_id:'11111111-2222-4333-8444-555555555555'}})}}});
    await fallback.open();const usable=!document.querySelector('.feedback-scrim').hidden && document.querySelector('#feedback-screenshot').hidden;fallback.unmount();
    const timeout=await capturePage({timeoutMs:25,library:{toCanvas:()=>new Promise(()=>{})}});
    return {creates,uploads,retry,done,reset,usable,timeout:timeout===null,secret:document.getElementById('secret').value,
      leftovers:document.querySelectorAll('[data-feedback-capture]').length};
  })()`);
  assert.deepEqual(lifecycle,{creates:1,uploads:2,retry:'retry-upload',done:'close',reset:'submit',usable:true,timeout:true,secret:'SYNTHETIC-PRIVATE',leftovers:0});
  pass('upload retry saves one report, reopen resets controls, capture failure/timeout preserve a usable form and live input');
  console.log('Screenshots: '+shots);
} finally {
  if(cdp) cdp.ws.close();
  if(browser) await browser.cleanup();
  if(started){verify();compose(['down','-v','--remove-orphans','--rmi','local']);verifyBrowserCleanup(project,command,{before:true});}
  const resolved=path.resolve(scratch);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(resolved).startsWith(project));
  fs.rmSync(resolved,{recursive:true,force:true});
}
