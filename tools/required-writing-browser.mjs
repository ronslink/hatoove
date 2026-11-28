/** Browser → authenticated API → PostgreSQL drafts in a disposable Compose stack. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {launchBrowser,connectToPage} from './cdp.js';
export async function verifyRequiredWriting({base,email,password,freePort,record,shot,viewport,nav,setInputs,clickSel,overflow,query}){
 const origin=new URL(base);assert.equal(origin.hostname,'127.0.0.1');assert(origin.port&&!['4300','55440'].includes(origin.port));
 const debugPort=await freePort(),browser=await launchBrowser(debugPort);let cdp;
 try{
  cdp=await connectToPage(debugPort);await viewport(cdp,1440,900,false);
  const request=(route,method='GET',body)=>cdp.evaluate(`return (async()=>{const s=await(await fetch('/api/auth/get-session')).json();const r=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json','X-Hatoove-Account':s.user.id}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:r.status,data:await r.json()};})()`);
  await nav(cdp,base+'/signin');await setInputs(cdp,{'si-email':email,'si-password':password});await clickSel(cdp,'#si-submit');
  await cdp.waitFor("document.querySelector('#boot-choices')&&!document.querySelector('#boot-choices').hidden||document.querySelector('#app-shell')&&!document.querySelector('#app-shell').hidden",25000);
  const created=await request('/api/v1/preparations','POST',{examId:'ielts-academic'});assert([200,201].includes(created.status),JSON.stringify(created));const prep=created.data.preparation??created.data;
  query(`INSERT INTO hatoove.entitlements(owner_id,exam_id,allowance,used,reserved) SELECT id,'ielts-academic',10,0,0 FROM hatoove."user" WHERE email='${email}' ON CONFLICT(owner_id,exam_id) DO UPDATE SET allowance=10`);
  await nav(cdp,base+'/app/?required-preparation=1#/prep/'+prep.id+'/ueben');
  await cdp.waitFor("document.querySelector('#boot-choices')&&!document.querySelector('#boot-choices').hidden||document.querySelector('#app-shell')&&!document.querySelector('#app-shell').hidden",25000);
  await clickSel(cdp,'#boot-choices [data-preparation="'+prep.id+'"]');
  await cdp.waitFor("document.querySelector('#app-shell')&&!document.querySelector('#app-shell').hidden",25000);
  const made=await request('/api/v1/mock-runs','POST',{preparationId:prep.id,formId:'ielts-academic.writing.original01',formVersion:'v1',releaseVersion:'v1',eventId:randomUUID()});assert([200,201].includes(made.status),JSON.stringify(made));const run=made.data.run??made.data;
  await nav(cdp,base+'/app/#/lauf/'+run.id);await cdp.waitFor("document.querySelector('#writing-text')&&!document.querySelector('#writing-text').readOnly",25000);
  assert.equal(await cdp.evaluate("return document.querySelectorAll('[data-mock-writing-binding]').length"),2);
  assert.equal(await cdp.evaluate("return document.querySelectorAll('.writing-data-table tbody tr').length"),4);
  assert.equal(await cdp.evaluate("return document.querySelector('#mock-writing-host [data-instruction-original]')?.lang"),'en');
  assert(await cdp.evaluate("return document.querySelector('#mock-writing-host [data-instruction-original]')?.textContent.length>10"));
  assert.equal(await cdp.evaluate("return document.body.textContent.includes('ielts-band-scale')"),false);
  await shot(cdp,'ielts-task1-desktop','#mock-writing-host');
  await viewport(cdp,390,844,true);assert((await overflow(cdp)).offenderCount===0);await shot(cdp,'ielts-task1-mobile','#mock-writing-host');
  record('IELTS report table and both required tasks render on desktop and mobile',true);
  const first='Overall, car travel decreased while cycling became more common. Bus use rose modestly, and walking changed only slightly.';
  const second='Public funding can make practical education accessible to people who cannot afford fees. A mixed funding model should preserve access to basic courses while asking participants to contribute to specialised training.';
  await setInputs(cdp,{'writing-text':first});await clickSel(cdp,'[data-mock-writing-binding="task2"]');
  await cdp.waitFor("document.querySelector('#writing-text')&&document.querySelector('.writing-prompt').textContent.includes('Public funding')");
  await setInputs(cdp,{'writing-text':second});await clickSel(cdp,'[data-mock-writing-binding="task1"]');
  await cdp.waitFor(`document.querySelector('#writing-text')?.value===${JSON.stringify(first)}`);
  await nav(cdp,base+'/app/?required-writing-reload=1#/lauf/'+run.id);await cdp.waitFor(`document.querySelector('#writing-text')?.value===${JSON.stringify(first)}`);
  await clickSel(cdp,'[data-mock-writing-binding="task2"]');await cdp.waitFor(`document.querySelector('#writing-text')?.value===${JSON.stringify(second)}`);
  await shot(cdp,'ielts-task2-mobile','#mock-writing-host');record('Both task drafts survive switching and a fresh document',true);
  await clickSel(cdp,'[data-mock-action="confirm"]');await clickSel(cdp,'[data-mock-action="finalise"]');
  await cdp.waitFor("!document.querySelector('[data-mock-action=\"confirm\"]')",20000);
  const saved=await request('/api/v1/mock-runs/'+run.id);assert.equal(saved.data.state,'finalised');assert.equal(saved.data.writing_attachments.length,2);assert(saved.data.writing_attachments.every(a=>a.submission_id));
  await viewport(cdp,1440,900,false);await shot(cdp,'ielts-submitted-desktop','#mock-writing-host');record('Finalisation preserves two separate pending submissions',true);
 }catch(error){if(cdp){await shot(cdp,'required-writing-failure').catch(()=>{});console.log(await cdp.evaluate("return JSON.stringify({route:location.pathname+location.hash,boot:document.querySelector('#boot-message')?.textContent,error:document.querySelector('#error')?.textContent,choices:[...document.querySelectorAll('[data-preparation]')].map(e=>e.dataset.preparation)})").catch(()=>''));}throw error;
 }finally{cdp?.ws.close();await browser.cleanup();}
}
