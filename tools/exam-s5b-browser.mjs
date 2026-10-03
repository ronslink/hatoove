/** Rendered complete-form proof on technical source fixtures, not educational acceptance. */
import {randomUUID} from 'node:crypto';
import {launchBrowser,connectToPage} from './cdp.js';
import {objectiveItems} from '../server/package-contract.mjs';
export async function verifyExamS5B({base,email,password,freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,advanceClock,runWorker}) {
  const url=new URL(base);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||['4300','55440'].includes(url.port)||!email.endsWith('@example.test'))throw Error('Disposable source fixture required');
  const browsers=[],connections=[];let a,telc,dtz,tr,dr;
  const assert=(v,m)=>{if(!v)throw Error(m);};
  const check=async(name,fn)=>{try{await fn();record(name,true);}catch(e){if(a)try{await shot(a,'failure-'+name.slice(0,5));}catch{}record(name,false,e.stack||e.message);}};
  const api=(c,route,method='GET',body)=>c.evaluate(`return (async()=>{const r=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:r.status,data:await r.json()};})()`);
  const read=async(c,id)=>(await api(c,'/api/v1/mock-runs/'+id)).data;
  const launch=async()=>{const port=await freePort(),browser=await launchBrowser(port);browsers.push(browser);const c=await connectToPage(port);connections.push(c);await viewport(c,1440,900,false);await theme(c,'light');return c;};
  const ready=c=>c.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value",20000);
  const signIn=async c=>{await nav(c,base+'/signin');await setInputs(c,{'si-email':email,'si-password':password});await clickSel(c,'#si-submit');await c.waitFor("document.querySelector('#boot-choices') && !document.querySelector('#boot-choices').hidden || document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden",20000);};
  const fresh=async(c,id)=>{const sentinel=randomUUID();await c.evaluate(`window.__s5bDoc=${JSON.stringify(sentinel)};return true;`);const result=await c.send('Page.navigate',{url:base+'/app/?s5b='+sentinel+'#/lauf/'+id});assert(result.loaderId,'new document required');await c.waitFor(`window.__s5bDoc!==${JSON.stringify(sentinel)} && document.readyState==='complete'`,20000);await ready(c);await c.waitFor("document.querySelector('[data-mock-timing-status]')",15000);};
  const pointer=async(c,sel)=>{const box=await c.evaluate(`const el=document.querySelector(${JSON.stringify(sel)});if(!el||el.disabled)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`);assert(box,'control unavailable '+sel);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});};
  const waitGroup=(c,id)=>c.waitFor(`document.querySelector('[data-mock-group="${id}"]')?.closest('[data-mock-group-state]')?.dataset.mockGroupState==='active'`,15000);
  const waitCount=(c,id,n)=>c.waitFor(`(async()=>{const r=await fetch('/api/v1/mock-runs/${id}');return (await r.json()).responses?.length===${n};})()`,10000);
  const answer=async(c,id,n)=>{await pointer(c,'.mock-options input');await clickSel(c,'[data-mock-action=save]');await waitCount(c,id,n);};
  const start=async(c,prep)=>{const forms=(await api(c,'/api/v1/mock-forms?preparationId='+prep.id)).data.forms;assert(forms.length===1&&forms[0].scope==='complete_supported_written','full form unavailable');const f=forms[0];const r=await api(c,'/api/v1/mock-runs','POST',{preparationId:prep.id,formId:f.form_id,formVersion:f.version,releaseVersion:f.release_version,eventId:randomUUID()});assert(r.status===201,'start failed '+JSON.stringify(r));return r.data;};
  const nearEnd=async(c,id,index)=>{const run=await read(c,id),group=run.timing.groups[index];const seconds=Math.floor((Date.parse(group.deadline_at)-Date.parse(run.server_now))/1000)-4;assert(seconds>0,'fixture boundary already passed');advanceClock(id,seconds);await fresh(c,id);};
  const finalise=async(c,id)=>{await clickSel(c,'[data-mock-action=confirm]');await c.waitFor("document.querySelector('[data-mock-action=finalise]')",5000);await clickSel(c,'[data-mock-action=finalise]');await c.waitFor(`(async()=>{const r=await fetch('/api/v1/mock-runs/${id}');return (await r.json()).state==='finalised';})()`,15000);return read(c,id);};
  const write=async(c,text)=>{await c.waitFor("document.querySelector('#writing-text') && !document.querySelector('#writing-text').readOnly",10000);await setInputs(c,{'writing-text':text});await c.waitFor("document.querySelector('#writing-state')?.textContent.includes('Gespeichert')",15000);};
  try {
    a=await launch();await signIn(a);
    await check('S5B01 both internal complete formats are discoverable with separate writing models',async()=>{
      if(await a.evaluate("return Boolean(document.querySelector('[data-preparation=\"new:dtz-a2-b1\"]'))"))await clickSel(a,'[data-preparation="new:dtz-a2-b1"]');await ready(a);
      let preps=(await api(a,'/api/v1/preparations')).data.preparations;
      for(const examId of ['telc-deutsch-b1','dtz-a2-b1'])if(!preps.some(p=>p.exam_id===examId))await api(a,'/api/v1/preparations','POST',{examId});
      preps=(await api(a,'/api/v1/preparations')).data.preparations;telc=preps.find(p=>p.exam_id==='telc-deutsch-b1');dtz=preps.find(p=>p.exam_id==='dtz-a2-b1');assert(telc&&dtz,'preparations absent');
      tr=await start(a,telc);assert(tr.members.reduce((n,m)=>n+m.item_count,0)===60&&tr.writing.binding_kind==='assigned'&&tr.writing_task,'telc complete binding');
      assert(tr.timing.groups.length===3&&tr.timing.groups[0].sections.join(',')==='LV,SB','telc shared first group');await fresh(a,tr.id);
      assert(await a.evaluate("return document.querySelector('.mock-heading').textContent.includes('Schriftliche Probeprüfung')"),'section mislabeled as full or vice versa');
    });
    if(!tr)return;
    await check('S5B02 future listening and answers are server-gated while first-group answers persist',async()=>{
      const hv=tr.members.find(m=>m.section==='HV'),clip=hv.recordings[0];
      const refused=await api(a,`/api/v1/mock-runs/${tr.id}/media/${clip.media_id}/${clip.media_version}`);assert(refused.status===409&&refused.data.error==='mock_group_inactive','future audio exposed');
      const item=objectiveItems(hv.payload,hv.interaction)[0];const save=await api(a,'/api/v1/mock-runs/'+tr.id,'PUT',{expectedRevision:tr.revision,eventId:randomUUID(),position:{member:0,item:0},responses:[{setId:hv.set_id,version:hv.version,itemId:item.id,answer:item.options[0]}]});assert(save.status===409&&save.data.error==='mock_group_inactive','future response accepted '+JSON.stringify(save));
      await answer(a,tr.id,1);await pointer(a,'[data-mock-member="3"][data-mock-item="0"]');await a.waitFor("document.querySelector('[data-mock-member=\"3\"][data-mock-item=\"0\"][aria-current=step]') && !document.querySelector('[data-mock-action=save]').disabled",10000);await answer(a,tr.id,2);
      const saved=await read(a,tr.id);assert(saved.responses.length===2,'shared LV/SB save missing');
      await pointer(a,'[data-mock-group="writing-30"]');await a.waitFor("document.querySelector('#writing-text')?.readOnly",10000);
      assert(!(await a.evaluate("return Boolean(document.querySelector('[data-mock-choice-option]'))")),'assigned task shows A/B');await shot(a,'s5b-assigned-future-desktop');
    });
    await check('S5B03 natural first boundary switches to listening and preserves the shared budget',async()=>{
      await nearEnd(a,tr.id,0);await waitGroup(a,'hv-30');await a.waitFor("document.querySelector('[data-listening-status]')",10000);
      const saved=await read(a,tr.id);assert(saved.responses.length===2&&saved.timing.active_group_id==='hv-30','boundary lost work');
      const groups=JSON.stringify(saved.timing.groups);await fresh(a,tr.id);assert(JSON.stringify((await read(a,tr.id)).timing.groups)===groups,'fresh document reset windows');
      await pointer(a,'[data-mock-group="lv-sb-90"]');assert(await a.evaluate("return document.querySelector('.mock-options')?.disabled"),'closed group editable');await pointer(a,'[data-mock-group="hv-30"]');await a.waitFor("document.querySelector('[data-listening-status]') && !document.querySelector('.mock-options').disabled",10000);await answer(a,tr.id,3);
    });
    await check('S5B04 native audio stops at its group boundary and assigned writing becomes writable',async()=>{
      await nearEnd(a,tr.id,1);await pointer(a,'[data-listening-action=load]');await a.waitFor("document.querySelector('[data-listening-action=play]') && !document.querySelector('[data-listening-action=play]').disabled",10000);
      await a.evaluate("window.__boundaryAudio=document.querySelector('[data-listening-audio]');window.__boundaryProof={ended:false,duration:window.__boundaryAudio.duration,furthest:0,pauseAt:null};window.__boundaryAudio.addEventListener('ended',()=>{window.__boundaryProof.ended=true;});window.__boundaryAudio.addEventListener('timeupdate',()=>{window.__boundaryProof.furthest=Math.max(window.__boundaryProof.furthest,window.__boundaryAudio.currentTime);});window.__boundaryAudio.addEventListener('pause',()=>{window.__boundaryProof.pauseAt=window.__boundaryAudio.currentTime;});return true;");await pointer(a,'[data-listening-action=play]');
      await a.waitFor("window.__boundaryAudio?.currentTime>0.2",5000);await waitGroup(a,'writing-30');assert(await a.evaluate("return window.__boundaryAudio.paused && !window.__boundaryProof.ended && window.__boundaryProof.furthest>0.2 && window.__boundaryProof.pauseAt>0.2 && window.__boundaryProof.pauseAt < window.__boundaryProof.duration - 0.5"),'audio did not stop before its natural end at the writing boundary');
      await a.waitFor("document.querySelector('#writing-text') && !document.querySelector('#writing-text').readOnly",10000);
      assert(await a.evaluate("return document.querySelector('#mock-writing-binding').textContent.includes('Zugewiesene')"),'assigned prompt absent');await shot(a,'s5b-assigned-active-desktop');
    });
    await check('S5B05 full mock writing fits mobile themes and objective results stay separate',async()=>{
      const text='Sehr geehrte Frau Weber, vielen Dank für Ihre Nachricht. Ich kann am Freitag kommen und bringe die Unterlagen mit. Mit freundlichen Grüßen';await write(a,text);
      for(const width of [1440,390,320])for(const mode of ['light','dark']){await viewport(a,width,width===1440?900:844,width!==1440);await theme(a,mode);const layout=await overflow(a);await shot(a,`s5b-writing-${width}-${mode}`,'#mock-writing-binding');assert(layout.offenderCount===0,'full mock overflow '+JSON.stringify(layout));}
      await viewport(a,1440,900,false);await theme(a,'light');const done=await finalise(a,tr.id);assert(done.result.total===60&&done.result.answered===3&&done.writing.assessment_state==='pending','telc finalisation mismatch '+JSON.stringify({result:done.result,writing:done.writing}));
      const worker=runWorker();assert(worker.outcome==='succeeded','assigned worker failed '+JSON.stringify(worker));await fresh(a,tr.id);assert((await read(a,tr.id)).writing.assessment_state==='assessed','assigned assessment absent');await shot(a,'s5b-telc-result-desktop');
    });
    await check('S5B06 DTZ keeps once-only listening and its own HV/LV/SA sequence',async()=>{
      dr=await start(a,dtz);assert(dr.members.reduce((n,m)=>n+m.item_count,0)===45&&!dr.writing&&dr.writing_choices[0].options.length===2,'DTZ complete shape');await fresh(a,dr.id);await waitGroup(a,'dtz-hv-25');await answer(a,dr.id,1);
      assert(dr.members.filter(m=>m.section==='HV').every(m=>m.recordings.every(r=>r.max_plays===1)),'DTZ allowance changed');await nearEnd(a,dr.id,0);await waitGroup(a,'dtz-lv-45');await answer(a,dr.id,2);await shot(a,'s5b-dtz-reading-desktop');
    });
    await check('S5B07 DTZ writing chooses one prompt after the boundary and preserves empty/unassessed work',async()=>{
      assert(dr,'DTZ start prerequisite');await nearEnd(a,dr.id,1);await waitGroup(a,'dtz-sa-30');await pointer(a,'[data-mock-choice-option="B"]');await a.waitFor("document.querySelector('#writing-text') && !document.querySelector('#writing-text').readOnly",10000);
      const chosen=await read(a,dr.id);assert(chosen.writing.selected_option_id==='B','DTZ choice absent');const done=await finalise(a,dr.id);
      assert(done.result.total===45&&done.result.answered===2&&done.writing.assessment_state==='unassessed'&&done.writing.failure_code==='empty_submission','DTZ empty preservation failed');await shot(a,'s5b-dtz-empty-result-desktop');
    });
  } finally {for(const c of connections)try{c.ws.close();}catch{}for(const browser of browsers)try{await browser.cleanup();}catch{}}
}
