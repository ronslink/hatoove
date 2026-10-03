/** Rendered public admission and pinned-history proof; all content and accounts are synthetic. */
import {randomUUID} from 'node:crypto';
import {launchBrowser,connectToPage} from './cdp.js';

export async function verifyExamS6({base,email,newcomerEmail,password,fixture,availableVersion,incompleteVersion,freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,publishAvailable,publishIncomplete,withdrawPinned}) {
  const url=new URL(base);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||['4300','55440'].includes(url.port)||![email,newcomerEmail].every(value=>value.endsWith('@example.test')))throw Error('Disposable source fixture required');
  const browsers=[],connections=[],DTZ='dtz-a2-b1';let a,b,prep,run,startBody,savedResponses;
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const check=async(name,work)=>{try{await work();record(name,true);}catch(error){if(a)try{await shot(a,'failure-'+name.slice(0,4));}catch{}record(name,false,error.stack||error.message);throw error;}};
  const api=(c,route,method='GET',body)=>c.evaluate(`return (async()=>{const session=await (await fetch('/api/auth/get-session',{credentials:'same-origin'})).json();const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json','X-Hatoove-Account':session.user.id}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:response.status,data:await response.json()};})()`);
  const ready=c=>c.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value",20000);
  const booted=c=>c.waitFor("document.querySelector('#boot-choices') && !document.querySelector('#boot-choices').hidden || document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden",20000);
  const signIn=async(c,address)=>{await nav(c,base+'/signin');await setInputs(c,{'si-email':address,'si-password':password});await clickSel(c,'#si-submit');await booted(c);if(await c.evaluate("return !document.querySelector('#boot-choices').hidden"))await clickSel(c,'[data-preparation]');await ready(c);};
  const launch=async()=>{const port=await freePort(),browser=await launchBrowser(port);browsers.push(browser);const c=await connectToPage(port);connections.push(c);await viewport(c,1440,900,false);await theme(c,'light');return c;};
  const fresh=async(c,hash='')=>{const sentinel=randomUUID();await c.evaluate(`window.__s6Doc=${JSON.stringify(sentinel)};return true;`);const result=await c.send('Page.navigate',{url:base+'/app/?s6='+sentinel+hash});assert(result.loaderId,'Fresh document required');await c.waitFor(`window.__s6Doc!==${JSON.stringify(sentinel)} && document.readyState==='complete'`,20000);await booted(c);};
  const pointer=async(c,selector)=>{const point=await c.evaluate(`const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'center'});const rect=el.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};`);assert(point,'Unavailable control '+selector);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});};
  const read=async()=>{const result=await api(a,'/api/v1/mock-runs/'+run.id);assert(result.status===200,'Pinned run read refused');return result.data;};
  const answer=async(count)=>{await pointer(a,'.mock-options input');await clickSel(a,'[data-mock-action=save]');await a.waitFor(`(async()=>{const r=await fetch('/api/v1/mock-runs/${run.id}');return (await r.json()).responses?.length===${count};})()`,10000);};
  async function layouts(label,selector){for(const width of [1440,390,320])for(const mode of ['light','dark']){await viewport(a,width,width===1440?900:844,width!==1440);await theme(a,mode);const layout=await overflow(a);await shot(a,`${label}-${width}-${mode}`,selector);assert(layout.offenderCount===0&&layout.scrollWidth<=layout.innerWidth+2,'Horizontal overflow '+JSON.stringify(layout));}await viewport(a,1440,900,false);await theme(a,'light');}
  try{
    a=await launch();await signIn(a,email);b=await launch();await signIn(b,newcomerEmail);
    await check('S6B1 public runtime hides and refuses a full but internal DTZ release',async()=>{
      const exams=await api(a,'/api/v1/exams');assert(exams.status===200&&!exams.data.exams.some(exam=>exam.exam_id===DTZ),'Internal DTZ was advertised');
      assert(!(await a.evaluate("return [...document.querySelector('#preparation-picker').options].some(option=>option.value==='new:dtz-a2-b1')")),'Internal DTZ visible in selector');
      const prepResult=await api(a,'/api/v1/preparations','POST',{examId:DTZ});assert(prepResult.status===422&&prepResult.data.error==='exam_unavailable','Internal preparation admitted');
      assert((await api(a,'/api/v1/checkout/offer?exam='+DTZ+'&market=DE')).status===404,'Internal offer admitted');
      assert((await api(a,'/api/v1/checkout/session','POST',{examId:DTZ,market:'DE',eventId:randomUUID()})).status===404,'Internal checkout admitted');
      await shot(a,'s6-internal-hidden-desktop');
    });
    await check('S6B2 exact synthetic approval and normal reference publication enable visible DTZ discovery',async()=>{
      publishAvailable();await fresh(a);
      if(await a.evaluate("return !document.querySelector('#boot-choices').hidden"))await clickSel(a,'[data-preparation="new:dtz-a2-b1"]');
      else {await ready(a);await a.evaluate("const picker=document.querySelector('#preparation-picker');if(![...picker.options].some(option=>option.value==='new:dtz-a2-b1'))throw Error('Missing new DTZ option');picker.value='new:dtz-a2-b1';picker.dispatchEvent(new Event('change',{bubbles:true}));return true;");}
      await a.waitFor("document.querySelector('#preparation-picker')?.selectedOptions[0]?.textContent.includes('DTZ') && !document.querySelector('#preparation-picker').disabled",15000);
      prep=(await api(a,'/api/v1/preparations')).data.preparations.find(row=>row.exam_id===DTZ);assert(prep,'DTZ preparation absent');
      const exams=(await api(a,'/api/v1/exams')).data.exams;assert(exams.some(row=>row.exam_id===DTZ),'Available DTZ absent');
      const forms=(await api(a,'/api/v1/mock-forms?preparationId='+prep.id)).data.forms;assert(forms.length===1&&forms[0].item_count===45&&forms[0].scope==='complete_supported_written','Not exactly a complete45-item form');
      assert((await api(a,'/api/v1/tasks?preparationId='+prep.id)).data.length===2,'Approved A/B prompts absent');
      assert((await api(a,'/api/v1/objective-sets?preparationId='+prep.id)).data.length===5,'Approved reading absent');
      const offer=await api(a,'/api/v1/checkout/offer?exam='+DTZ+'&market=DE');assert(offer.status===200&&offer.data.offer.purchasable,'Available purchase offer absent');
      await nav(a,base+'/app/#/prep/'+prep.id+'/abschnitt');await ready(a);await a.waitFor("document.querySelector('[data-mock-start]')",10000);await shot(a,'s6-public-full-catalogue-desktop','#mock-host');
    });
    await check('S6B3 learner starts the public45-item mock, saves an HV response and loads protected fixed audio',async()=>{
      await pointer(a,'[data-mock-start]');await a.waitFor("/[a-f0-9-]{36}$/.test(location.hash) && document.querySelector('.mock-options input') && document.querySelector('[data-mock-action=save]')",15000);
      const id=await a.evaluate("return location.hash.split('/').at(-1)");run=(await api(a,'/api/v1/mock-runs/'+id)).data;
      assert(run.members.reduce((sum,member)=>sum+member.item_count,0)===45&&run.release_version===availableVersion&&!run.blocked_reason,'Wrong public pinned run');
      assert(run.timing.active_group_id==='dtz-hv-25'&&run.members[0].recordings.every(recording=>recording.max_plays===1),'Wrong DTZ timing/allowance');
      startBody={preparationId:prep.id,formId:run.form_id,formVersion:run.form_version,releaseVersion:run.release_version,eventId:randomUUID()};
      await answer(1);savedResponses=(await read()).responses;assert(savedResponses[0].setId===run.members[0].set_id,'HV response missing');
      await pointer(a,'[data-listening-action=load]');await a.waitFor("document.querySelector('[data-listening-action=play]') && !document.querySelector('[data-listening-action=play]').disabled",10000);
      assert(await a.evaluate("return document.querySelector('[data-listening-audio]').duration>0 && document.querySelector('[data-listening-audio]').paused"),'Native audio was not ready');
      await layouts('s6-public-player','.listening-player');
    });
    await check('S6B4 malformed available current head closes all new DTZ admission routes',async()=>{
      publishIncomplete();
      const query='?preparationId='+prep.id,set=fixture.sets.find(row=>row.family==='LV1'),task=fixture.writingTasks[0];
      const question=set.payload.questions[0],binding={taskId:task.taskId,taskVersion:task.version,rubricId:task.rubricId,rubricVersion:task.rubricVersion};
      assert(!(await api(a,'/api/v1/exams')).data.exams.some(row=>row.exam_id===DTZ),'Incomplete DTZ discovery remains open');
      assert((await api(a,'/api/v1/mock-forms'+query)).data.forms.length===0,'Incomplete mock catalogue remains open');
      assert((await api(a,'/api/v1/objective-sets'+query)).data.length===0,'Incomplete objective catalogue remains open');
      assert((await api(a,'/api/v1/tasks'+query)).data.length===0,'Incomplete writing catalogue remains open');
      assert((await api(a,'/api/v1/practice/next'+query)).data.reason==='nothing_available','Incomplete next practice remains open');
      assert((await api(a,'/api/v1/objective-sets/'+set.setId+query+'&version='+set.version)).status===404,'Direct objective remains open');
      assert((await api(a,'/api/v1/objective-sets/'+set.setId+'/answers','POST',{preparationId:prep.id,version:set.version,itemId:String(question.n),answer:Object.keys(question.options)[0]})).status===404,'New objective answer remains open');
      assert((await api(a,'/api/v1/rubrics/'+task.rubricId+'?version='+task.rubricVersion)).status===404,'Direct rubric remains open');
      const writing=await api(a,'/api/v1/attempts','POST',{preparationId:prep.id,...binding});assert(writing.status===422&&writing.data.error==='task_not_servable','New writing remains open');
      assert((await api(a,'/api/v1/mock-runs','POST',{...startBody,releaseVersion:incompleteVersion,eventId:randomUUID()})).status===404,'New mock remains open');
      assert((await api(a,'/api/v1/checkout/offer?exam='+DTZ+'&market=DE')).status===404,'Incomplete offer remains open');
      assert((await api(a,'/api/v1/checkout/session','POST',{examId:DTZ,market:'DE',eventId:randomUUID()})).status===404,'Incomplete checkout remains open');
      const refused=await api(b,'/api/v1/preparations','POST',{examId:DTZ});assert(refused.status===422&&refused.data.error==='exam_unavailable','New preparation remains open');
      const continuation=await api(a,'/api/v1/preparations','POST',{examId:DTZ});assert(continuation.status===200&&continuation.data.id===prep.id,'Existing preparation was blocked');
    });
    await check('S6B5 fresh-document pinned run keeps answers and permits saved-run continuation after head closure',async()=>{
      await fresh(a,'#/lauf/'+run.id);await ready(a);await a.waitFor("document.querySelector('.mock-options input:checked')",10000);
      const pinned=await read();assert(!pinned.blocked_reason&&pinned.release_version===availableVersion&&JSON.stringify(pinned.responses)===JSON.stringify(savedResponses),'Pinned content or answer lost');
      await pointer(a,'[data-mock-member="0"][data-mock-item="1"]');await a.waitFor("document.querySelector('[data-mock-member=\"0\"][data-mock-item=\"1\"][aria-current=step]') && !document.querySelector('[data-mock-action=save]').disabled",10000);
      await answer(2);const continued=await read();assert(JSON.stringify(continued.responses[0])===JSON.stringify(savedResponses[0]),'Original response changed');savedResponses=continued.responses;
      await layouts('s6-pinned-after-closure','.mock-options');
      await nav(a,base+'/app/#/prep/'+prep.id+'/abschnitt');await ready(a);await a.waitFor("document.querySelector('#mock-host').textContent.includes('Zurzeit ist kein Lauf')",10000);
      assert(await a.evaluate(`return Boolean(document.querySelector('[data-mock-run="${run.id}"]'))`),'Saved run history lost');await shot(a,'s6-closed-new-start-preserved-history','#mock-host');
    });
    await check('S6B6 exact media rights withdrawal blocks the protected bundle while retaining answers and history',async()=>{
      withdrawPinned();const blocked=await read();assert(blocked.blocked_reason==='rights_blocked'&&blocked.members.length===0,'Withdrawn content exposed');assert(JSON.stringify(blocked.responses)===JSON.stringify(savedResponses),'Withdrawal lost answers');
      const clip=run.members[0].recordings[0],media=await api(a,`/api/v1/mock-runs/${run.id}/media/${clip.media_id}/${clip.media_version}`);
      assert(media.status===409&&media.data.error==='mock_rights_blocked','Withdrawn media was not rights-refused');
      const history=(await api(a,'/api/v1/mock-runs?preparationId='+prep.id)).data.runs;assert(history.some(row=>row.id===run.id),'Blocked run absent from history');
      await fresh(a,'#/lauf/'+run.id);await ready(a);await a.waitFor("document.querySelector('#mock-host').textContent.includes('Dieser Lauf ist zurzeit gesperrt')",10000);await shot(a,'s6-rights-blocked-preserved-desktop','#mock-content > section.card');
    });
  }finally{for(const c of connections)try{c.ws.close();}catch{}for(const browser of browsers)try{await browser.cleanup();}catch{}}
}
