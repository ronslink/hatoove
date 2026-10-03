/** Browser proof against technical PCM signals in a disposable source-only Compose stack. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';

export async function verifyExamS5({base,email,password,freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(origin.hostname) || !origin.port
    || ['4300','55440'].includes(origin.port) || origin.origin !== base || !/^browser-[a-z0-9-]+@example\.test$/i.test(email))
    throw Error('S5 requires an isolated loopback stack and synthetic account');
  const browsers=[], connections=[];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const run=async(name,work)=>{try{await work();record(name,true);}catch(error){record(name,false,error.stack||error.message);}};
  const request=(cdp,route,method='GET',body)=>cdp.evaluate(`return (async()=>{const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:response.status,data:await response.json()};})()`);
  const ready=cdp=>cdp.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value",20000);
  const launch=async()=>{const port=await freePort(),browser=await launchBrowser(port);browsers.push(browser);const cdp=await connectToPage(port);connections.push(cdp);await cdp.send('Network.enable');await viewport(cdp,1440,900,false);await theme(cdp,'light');return cdp;};
  const signin=async cdp=>{await nav(cdp,base+'/signin');await setInputs(cdp,{'si-email':email,'si-password':password});await clickSel(cdp,'#si-submit');await cdp.waitFor("document.querySelector('#boot-choices') && !document.querySelector('#boot-choices').hidden || document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden",20000);};
  const fresh=async(cdp,runId)=>{const token=randomUUID();await cdp.evaluate(`window.__s5Document=${JSON.stringify(token)};return true;`);const result=await cdp.send('Page.navigate',{url:base+'/app/?s5Probe='+token+'#/lauf/'+runId});assert(result.loaderId,'fresh document required');await cdp.waitFor(`window.__s5Document!==${JSON.stringify(token)} && document.readyState==='complete'`,20000);await ready(cdp);await cdp.waitFor("document.querySelector('[data-listening-status]')",15000);};
  const pointer=async(cdp,selector)=>{const box=await cdp.evaluate(`const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`);assert(box,'control unavailable '+selector);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});};
  const action=(cdp,name)=>pointer(cdp,`[data-listening-action="${name}"]`);
  const waitControl=(cdp,name)=>cdp.waitFor(`document.querySelector('[data-listening-action="${name}"]') && !document.querySelector('[data-listening-action="${name}"]').disabled`,15000);
  const playback=async(cdp,id)=>(await request(cdp,'/api/v1/mock-runs/'+id+'/playback')).data.items;
  const current=async(cdp,id)=>(await request(cdp,'/api/v1/mock-runs/'+id)).data;
  const waitPlayback=(cdp,id,mediaId,predicate)=>cdp.waitFor(`(async()=>{const r=await fetch('/api/v1/mock-runs/${id}/playback');const p=(await r.json()).items?.find(x=>x.media_id===${JSON.stringify(mediaId)});return p && (${predicate});})()`,20000);
  const start=async(cdp,prep,mode)=>{const listed=await request(cdp,'/api/v1/mock-forms?preparationId='+prep.id);const form=listed.data.forms.find(f=>f.form_id.endsWith('.'+mode));assert(form,'missing form '+mode);const made=await request(cdp,'/api/v1/mock-runs','POST',{preparationId:prep.id,formId:form.form_id,formVersion:form.version,releaseVersion:form.release_version,eventId:randomUUID()});assert(made.status===201,'start refused '+JSON.stringify(made));return made.data;};
  let a,b,telc,dtz,practice,first,paused;
  try {
    a=await launch();await signin(a);
    await run('S5B1 both internal listening catalogues contain honest section forms',async()=>{
      if(await a.evaluate("return Boolean(document.querySelector('[data-preparation=\"new:dtz-a2-b1\"]'))"))await clickSel(a,'[data-preparation="new:dtz-a2-b1"]');
      await ready(a);
      let rows=(await request(a,'/api/v1/preparations')).data.preparations;
      dtz=rows.find(p=>p.exam_id==='dtz-a2-b1');telc=rows.find(p=>p.exam_id==='telc-deutsch-b1');
      for(const examId of ['telc-deutsch-b1','dtz-a2-b1'])if(!rows.some(p=>p.exam_id===examId))await request(a,'/api/v1/preparations','POST',{examId});
      rows=(await request(a,'/api/v1/preparations')).data.preparations;dtz=rows.find(p=>p.exam_id==='dtz-a2-b1');telc=rows.find(p=>p.exam_id==='telc-deutsch-b1');
      assert(dtz&&telc,'both preparations absent');
      for(const prep of [dtz,telc]){const forms=(await request(a,'/api/v1/mock-forms?preparationId='+prep.id)).data.forms;assert(forms.length===3&&forms.every(f=>f.scope==='section'&&f.release_state==='internal'&&f.item_count===20),'bad section/public catalogue');}
      practice=await start(a,dtz,'practice');first=practice.members[0].recordings[0];
      assert(practice.attempt_mode==='practice'&&practice.members.length===4,'practice mode or members absent');
      assert(!/"(?:correct_answer|answers|script|transcript|path)"/.test(JSON.stringify(practice.members)),'private fields in active DTO');
      await fresh(a,practice.id);
      assert(await a.evaluate("return document.body.textContent.includes('Technikprobe')"),'technical fixture label missing');
    });
    if(!practice)return;
    const mediaRoute='/api/v1/mock-runs/'+practice.id+'/media/'+first.media_id+'/'+first.media_version;
    await run('S5B2 owner media supports HEAD/range without consumption and refuses anonymous access',async()=>{
      const probe=await a.evaluate(`return (async()=>{const h=await fetch(${JSON.stringify(mediaRoute)},{method:'HEAD'});const r=await fetch(${JSON.stringify(mediaRoute)},{headers:{range:'bytes=0-43'}});return {head:h.status,size:h.headers.get('content-length'),status:r.status,range:r.headers.get('content-range'),type:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength,cache:r.headers.get('cache-control')};})()`);
      assert(probe.head===200&&probe.status===206&&probe.bytes===44&&probe.type?.startsWith('audio/wav')&&probe.cache?.includes('no-store'),'media HEAD/range mismatch '+JSON.stringify(probe));
      assert((await fetch(base+mediaRoute)).status===401,'anonymous media was readable');
      assert((await playback(a,practice.id)).every(p=>p.plays_used===0),'preloading consumed allowance');
    });
    await run('S5B3 failed pre-play network loading retains every allowance',async()=>{
      await a.send('Network.setBlockedURLs',{urls:['*/api/v1/mock-runs/*/media/*']});
      try {
        await action(a,'load');
        await a.waitFor("document.querySelector('[data-listening-status].err')?.textContent.includes('nicht geladen') && document.querySelector('[data-listening-action=load]')?.disabled===false",12000);
        assert((await playback(a,practice.id)).every(p=>p.plays_used===0),'failed media load consumed play');
        await shot(a,'s5-load-failure-desktop');
      } finally { await a.send('Network.setBlockedURLs',{urls:[]}); }
      const retry=await a.evaluate("return Boolean(document.querySelector('[data-listening-action=load]'))");await action(a,retry?'load':'retry');await waitControl(a,'play');
    });
    await run('S5B4 actual HTML audio begins once and persists a pause',async()=>{
      await action(a,'play');await waitPlayback(a,practice.id,first.media_id,"p.plays_used===1 && p.state==='playing'");
      await a.waitFor("document.querySelector('[data-listening-audio]')?.currentTime>0.25",10000);
      await action(a,'pause');await waitPlayback(a,practice.id,first.media_id,"p.state==='paused' && p.position_ms>0");
      paused=(await playback(a,practice.id)).find(p=>p.media_id===first.media_id);
      assert(paused.plays_used===1&&paused.position_ms>0,'pause not durable');await shot(a,'s5-paused-desktop');
    });
    await run('S5B5 fresh document and second device cannot buy a restart',async()=>{
      assert(paused,'actual playback prerequisite');b=await launch();await signin(b);await fresh(b,practice.id);
      const copy=(await playback(b,practice.id)).find(p=>p.media_id===first.media_id);
      assert(copy.plays_used===1&&copy.position_ms>=paused.position_ms,'fresh document reset allowance/position');
      const restart=await request(b,'/api/v1/mock-runs/'+practice.id+'/playback','POST',{eventId:randomUUID(),mediaId:first.media_id,mediaVersion:first.media_version,expectedRevision:copy.revision,action:'begin'});
      assert(restart.status===409,'existing consumed play restarted');
      await fresh(a,practice.id);await action(a,'load');await waitControl(a,'recover');await shot(a,'s5-recovery-desktop');
    });
    await run('S5B6 explicit recovery completes same DTZ play with no additional allowance',async()=>{
      await a.evaluate("window.__s5Resumed=[];window.__s5Ended=false;const el=document.querySelector('[data-listening-audio]');el.addEventListener('timeupdate',()=>{if(!el.paused)window.__s5Resumed.push(el.currentTime)});el.addEventListener('ended',()=>{window.__s5Ended=true});return true;");
      await action(a,'recover');
      await a.waitFor("window.__s5Resumed?.length>=2 && Math.max(...window.__s5Resumed)-Math.min(...window.__s5Resumed)>0.25",10000);
      const resumed=await a.evaluate("return {first:window.__s5Resumed[0],last:window.__s5Resumed.at(-1)};");
      assert(resumed.first*1000>=paused.position_ms-100,'recovery resumed before durable pause');
      await a.waitFor("window.__s5Ended && document.querySelector('[data-listening-audio]')?.ended",12000);
      await waitPlayback(a,practice.id,first.media_id,"p.state==='completed'");
      const completed=(await playback(a,practice.id)).find(p=>p.media_id===first.media_id);
      assert(completed.plays_used===1,'recovery added a play');
      const restart=await request(a,'/api/v1/mock-runs/'+practice.id+'/playback','POST',{eventId:randomUUID(),mediaId:first.media_id,mediaVersion:first.media_version,expectedRevision:completed.revision,action:'begin'});
      assert(restart.status===409,'completed DTZ playback restarted');await shot(a,'s5-exhausted-desktop');
    });
    await run('S5B7 answers survive new document and finalise separately from playback',async()=>{
      await pointer(a,'.mock-options input');await clickSel(a,'[data-mock-action="save"]');await a.waitFor("document.querySelector('#mock-save-state')?.textContent.includes('Gespeichert')",15000);
      const saved=await current(a,practice.id);assert(saved.responses.length===1,'objective answer not saved');
      await fresh(a,practice.id);assert(await a.evaluate("return Boolean(document.querySelector('.mock-options input:checked'))"),'new document lost answer');
      await clickSel(a,'[data-mock-action="confirm"]');await a.waitFor("document.querySelector('[data-mock-action=finalise]')");await clickSel(a,'[data-mock-action="finalise"]');await a.waitFor("document.querySelector('.mock-results')",15000);
      const finished=await current(a,practice.id);assert(finished.state==='finalised'&&finished.result.total===20&&finished.result.answered===1,'objective final snapshot wrong');
      const refused=await a.evaluate(`return fetch(${JSON.stringify(mediaRoute)}).then(r=>r.status);`);assert(refused===409,'finalised media still readable');await shot(a,'s5-result-desktop');
    });
    await run('S5B8 separate mock attempt receives its own once-only DTZ allowance',async()=>{
      const mock=await start(a,dtz,'mock');assert(mock.id!==practice.id&&mock.attempt_mode==='mock'&&mock.deadline_at,'separate timed mock missing');
      assert((await playback(a,mock.id)).every(p=>p.plays_used===0&&p.max_plays===1),'mock did not receive its own bounded allowance');
      await fresh(a,mock.id);await action(a,'load');await waitControl(a,'play');
      const deadline=(await current(a,mock.id)).deadline_at;await fresh(a,mock.id);assert((await current(a,mock.id)).deadline_at===deadline,'refresh reset clock');
      practice=mock;first=mock.members[0].recordings[0];
    });
    await run('S5B9 player fits desktop and 390/320px light/dark with keyboard labels',async()=>{
      for(const width of [1440,390,320])for(const mode of ['light','dark']){await viewport(a,width,width===1440?900:844,width!==1440);await theme(a,mode);const layout=await overflow(a);await shot(a,`s5-player-${width}-${mode}`,'.listening-player');assert(layout.offenderCount===0,`${width}/${mode} overflow ${JSON.stringify(layout)}`);}
      await a.evaluate("document.querySelector('[data-listening-action]').focus();return true;");assert(await a.evaluate("return document.activeElement.hasAttribute('data-listening-action')"),'keyboard focus missing');
      await viewport(a,1440,900,false);await theme(a,'light');
      await a.send('Page.bringToFront');
      await a.evaluate("document.querySelector('[data-listening-action=load]').focus();return true;");
      await a.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await a.send('Input.dispatchKeyEvent',{type:'char',text:'\r',unmodifiedText:'\r',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      await a.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await waitControl(a,'play');
      await a.evaluate("document.documentElement.style.zoom='2';return true;");
      try {const layout=await overflow(a);assert(layout.offenderCount===0,'200% CSS zoom overflow');await shot(a,'s5-player-200percent-css-zoom','.listening-player');}
      finally {await a.evaluate("document.documentElement.style.zoom='';return true;");}
    });
    await run('S5B10 expiry during real playback preserves answers and permits leaving and finalising',async()=>{
      const expiring=await start(a,dtz,'expiry');await fresh(a,expiring.id);
      await pointer(a,'.mock-options input');await clickSel(a,'[data-mock-action="save"]');
      await a.waitFor("document.querySelector('#mock-save-state')?.textContent.includes('Gespeichert')",10000);
      await action(a,'load');await waitControl(a,'play');await action(a,'play');
      await a.waitFor("document.querySelector('[data-listening-audio]')?.currentTime>0.2",5000);
      await a.waitFor("document.querySelector('#mock-deadline')?.textContent==='Zeit abgelaufen' && document.querySelector('[data-listening-audio]')?.paused",10000);
      await shot(a,'s5-expired-desktop');
      await clickSel(a,'a[href="#/abschnitt"]');await a.waitFor("!document.querySelector('#mock-deadline') && document.querySelector('[data-mock-refresh]')",10000);
      await fresh(a,expiring.id);await clickSel(a,'[data-mock-action="confirm"]');await clickSel(a,'[data-mock-action="finalise"]');
      await a.waitFor("document.querySelector('.mock-results')",10000);
      const closed=await current(a,expiring.id);assert(closed.state==='finalised'&&closed.result.answered===1,'expired finalisation lost confirmed answer');
    });
    await run('S5B11 telc blueprint retains one/two/two and cross-exam media is refused',async()=>{
      const tc=await start(a,telc,'practice');assert(tc.members.map(m=>m.recordings[0].max_plays).join(',')==='1,2,2','telc policy replaced with DTZ');
      const alien='/api/v1/mock-runs/'+tc.id+'/media/'+first.media_id+'/'+first.media_version;
      assert((await a.evaluate(`return fetch(${JSON.stringify(alien)}).then(r=>r.status);`))===404,'cross-exam recording readable');
      assert(!tc.members.some(m=>m.recordings.some(r=>r.media_id===first.media_id)),'cross-exam binding leaked');
    });
  } finally { for(const c of connections)try{c.ws.close();}catch{} for(const browser of browsers)try{await browser.cleanup();}catch{} }
}
