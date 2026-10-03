/** EXAM-S2 browser evidence. Only callable from the disposable Compose test harness. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';

export async function verifyExamS2({ base, email, password, freePort, record, shot, viewport, theme, nav, setInputs, clickSel, overflow, query }) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || !origin.port
    || ['4300', '55440'].includes(origin.port) || origin.origin !== base || !/^browser-\d+@example\.test$/.test(email)
    || typeof query !== 'function') throw new Error('EXAM-S2 requires disposable loopback ports, a synthetic account and the harness SQL callback');
  for (const callback of [freePort, record, shot, viewport, theme, nav, setInputs, clickSel, overflow]) {
    if (typeof callback !== 'function') throw new Error('EXAM-S2 requires the complete supplied browser harness');
  }
  const port = await freePort(), browser = await launchBrowser(port);
  let cdp, stopIntercept = null;
  const assert = (value, detail) => { if (!value) throw new Error(detail); };
  const run = async (name, action) => { try { await action(); record(name, true); } catch (error) { record(name, false, error.message); } };
  const fresh = async hash => {
    const token = randomUUID(); await cdp.evaluate(`window.__s2Document=${JSON.stringify(token)};return true;`);
    const result = await cdp.send('Page.navigate', {url:base+'/app/?s2Probe='+token+hash});
    assert(result.loaderId, 'fresh navigation must create a new document');
    await cdp.waitFor(`window.__s2Document!==${JSON.stringify(token)} && document.readyState==='complete' && document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden`,20000);
  };
  const go = async view => {
    await cdp.evaluate(`location.hash=${JSON.stringify('#/'+view)};return true;`);
    await cdp.waitFor(`document.querySelector('#view-${view}') && !document.querySelector('#view-${view}').hidden && location.hash.endsWith('/${view}')`);
  };
  const choose = async value => {
    await cdp.evaluate(`const radio=document.querySelector('input[name="mock-answer"][value=${JSON.stringify(value)}]');if(!radio)throw Error('radio missing');radio.click();return true;`);
  };
  const saved = () => cdp.waitFor("document.querySelector('#mock-save-state')?.textContent.startsWith('Gespeichert') && !document.querySelector('[data-mock-action=save]')?.disabled");
  const intercept = async (stage, handler, pattern = '*/api/v1/mock-runs/*') => {
    const pending = new Set(); let failure;
    const listener = event => {
      const value=JSON.parse(event.data);if(value.method!=='Fetch.requestPaused')return;
      const item=value.params;pending.add(item.requestId);
      Promise.resolve(handler(item)).then(async handled=>{
        if(!handled)await cdp.send('Fetch.continueRequest',{requestId:item.requestId});pending.delete(item.requestId);
      }).catch(async error=>{failure=error.message;try{await cdp.send('Fetch.continueRequest',{requestId:item.requestId});}catch{}pending.delete(item.requestId);});
    };
    cdp.ws.addEventListener('message',listener);await cdp.send('Fetch.enable',{patterns:[{urlPattern:pattern,requestStage:stage}]});
    stopIntercept=async()=>{cdp.ws.removeEventListener('message',listener);for(const requestId of pending){try{await cdp.send('Fetch.continueRequest',{requestId});}catch{}}await cdp.send('Fetch.disable');stopIntercept=null;if(failure)throw Error(failure);};
  };
  try {
    cdp=await connectToPage(port);await cdp.send('Network.enable');await viewport(cdp,1440,900,false);await theme(cdp,'light');
    await nav(cdp,base+'/signin');await setInputs(cdp,{'si-email':email,'si-password':password});await clickSel(cdp,'#si-submit');
    await cdp.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value",15000);
    const request = (route, method='GET', body) => cdp.evaluate(`return (async()=>{const r=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:r.status,data:await r.json()};})()`);
    const preparationId=await cdp.evaluate("return document.querySelector('#preparation-picker').value");
    let runId, firstChoice, secondChoice;
    const reply = (event, data, status = 200) => cdp.send('Fetch.fulfillRequest', {requestId:event.requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(data)).toString('base64')});
    await run('S2B0 loading, empty and unavailable states (synthetic responses)',async()=>{
      let release;const held=new Promise(resolve=>{release=resolve;});let reached;const requested=new Promise(resolve=>{reached=resolve;});
      await intercept('Request',async event=>{
        if(event.request.method!=='GET')return false;
        if(event.request.url.includes('/mock-forms?')){reached();await held;await reply(event,{forms:[]});return true;}
        if(event.request.url.includes('/mock-runs?')){await reply(event,{runs:[]});return true;}return false;
      },'*/api/v1/mock-*');
      try {
        await go('abschnitt');await Promise.race([requested,new Promise((_,reject)=>setTimeout(()=>reject(Error('loading fixture request missing')),10000))]);
        assert(await cdp.evaluate("return document.querySelector('#mock-host').textContent.includes('werden geladen')"),'loading state missing');await shot(cdp,'s2-loading-desktop-light');release();
        await cdp.waitFor("document.querySelector('#mock-host').textContent.includes('Zurzeit ist kein Abschnitt') && document.querySelector('#mock-host').textContent.includes('Noch keine gespeicherten')");await shot(cdp,'s2-empty-desktop-light');
      } finally {release();await stopIntercept();}
      await intercept('Request',async event=>{if(event.request.method==='GET'){await reply(event,{error:'unavailable'},503);return true;}return false;},'*/api/v1/mock-*');
      try {await clickSel(cdp,'[data-mock-refresh]');await cdp.waitFor("document.querySelector('#mock-host').textContent.includes('konnten nicht geladen')");await shot(cdp,'s2-unavailable-desktop-light');}finally{await stopIntercept();}
      await clickSel(cdp,'[data-mock-refresh]');
    });
    await run('S2B1 section entry creates exact pinned twenty-item reading run',async()=>{
      await go('abschnitt');await cdp.waitFor("document.querySelector('[data-mock-start]')");await shot(cdp,'s2-section-index-desktop-light');
      await clickSel(cdp,'[data-mock-start]');await cdp.waitFor("document.querySelector('input[name=mock-answer]') && location.hash.includes('/abschnitt/')");
      runId=await cdp.evaluate("return location.hash.split('/').at(-1)");const result=await request('/api/v1/mock-runs/'+runId);
      assert(result.status===200 && result.data.preparation_id===preparationId && result.data.members.reduce((n,m)=>n+m.item_count,0)===20,'owned pinned reading form required');
      assert(result.data.release_version&&result.data.form_version&&result.data.result===null,'versions and deferred result required');
      [firstChoice,secondChoice]=await cdp.evaluate("return [...document.querySelectorAll('input[name=mock-answer]')].slice(0,2).map(n=>n.value)");
    });
    if(!runId) return;
    await run('S2B2 answer stays visible and feedback remains deferred',async()=>{
      await choose(firstChoice);await saved();const result=await request('/api/v1/mock-runs/'+runId);
      assert(result.data.responses.length===1 && result.data.result===null,'server must save without result');
      assert(await cdp.evaluate("return !document.querySelector('#mock-result') && !document.querySelector('.mock-results') && document.querySelector('input[name=mock-answer]:checked')!==null"),'selected radio and no result');
      await shot(cdp,'s2-saved-desktop-light');
    });
    await run('S2B3 keyboard focus survives saved-state repaint',async()=>{
      await cdp.evaluate("document.querySelector('input[name=mock-answer]:checked').focus();return true;");
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      await saved();assert(await cdp.evaluate("return document.activeElement?.name==='mock-answer'"),'radio focus lost during save');
    });
    await run('S2B4 Heute prioritises saved section and a fresh document resumes it',async()=>{
      await go('heute');await cdp.waitFor(`document.querySelector('.hero-next a').getAttribute('href')==='#/lauf/${runId}'`);
      await clickSel(cdp,'.hero-next a');await cdp.waitFor("document.querySelector('input[name=mock-answer]:checked')");
      const choice=await cdp.evaluate("return document.querySelector('input[name=mock-answer]:checked').value");
      await fresh('#/lauf/'+runId);await cdp.waitFor("document.querySelector('input[name=mock-answer]:checked')");
      assert(await cdp.evaluate(`return document.querySelector('input[name=mock-answer]:checked').value===${JSON.stringify(choice)} && document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)}`),'fresh document did not resolve original preparation and response');
    });
    await run('S2B4a queued run link survives a delayed settings save',async()=>{
      await go('einstellungen');let release;const held=new Promise(resolve=>{release=resolve;});let reached;const requested=new Promise(resolve=>{reached=resolve;});
      await intercept('Request',async event=>{if(event.request.method==='PUT'&&new URL(event.request.url).pathname==='/api/v1/settings'){reached();await held;}return false;},'*/api/v1/settings');
      try {
        await clickSel(cdp,'#save-settings');await Promise.race([requested,new Promise((_,reject)=>setTimeout(()=>reject(Error('delayed settings request missing')),10000))]);
        await cdp.evaluate(`return new Promise(resolve=>{window.addEventListener('hashchange',()=>resolve(true),{once:true});location.hash='#/lauf/${runId}';});`);
        assert(await cdp.evaluate("return !document.querySelector('#view-einstellungen').hidden"),'navigation was not queued behind settings');release();
        await cdp.waitFor(`location.hash.endsWith('/abschnitt/${runId}') && document.querySelector('input[name=mock-answer]') && !document.querySelector('#view-abschnitt').hidden`);
      }finally{release();await stopIntercept();}
    });
    await run('S2B5 all three parts render with complete choices at 390/320 in both themes',async()=>{
      for(const width of [390,320]) {
        await viewport(cdp,width,844,true);
        for(const mode of ['light','dark']) {
          await theme(cdp,mode);
          for(const member of [0,1,2]) {
            await clickSel(cdp,`[data-mock-member="${member}"][data-mock-item="0"]`);await saved();
            assert((await overflow(cdp)).offenderCount===0,`${width}px ${mode} part ${member+1} overflows`);
            await shot(cdp,`s2-part-${member+1}-${width}-${mode}`);
          }
        }
      }
      assert(await cdp.evaluate("return !!document.querySelector('input[value=x]')"),'no-match option missing');
    });
    await run('S2B6 lost save acknowledgement retains selection and retries exact event',async()=>{
      await viewport(cdp,1440,900,false);await theme(cdp,'light');await clickSel(cdp,'[data-mock-member="0"][data-mock-item="0"]');await saved();
      const prior=await cdp.evaluate("return document.querySelector('input[name=mock-answer]:checked')?.value");const next=prior===firstChoice?secondChoice:firstChoice;let failed=false;const mark=cdp.events.length;
      await intercept('Response',async event=>{if(event.request.method==='PUT'&&!failed){failed=true;await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Failed'});return true;}return false;});
      try {
        await choose(next);await cdp.waitFor("document.querySelector('#mock-save-state')?.textContent==='Noch nicht bestätigt'");
        assert(await cdp.evaluate(`return document.querySelector('input[name=mock-answer]:checked').value===${JSON.stringify(next)}`),'local answer lost');
        await shot(cdp,'s2-lost-ack-desktop-light');await clickSel(cdp,'[data-mock-action=retry]');await saved();
        const puts=cdp.events.slice(mark).filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='PUT'&&e.params.request.url.includes('/mock-runs/')).map(e=>JSON.parse(e.params.request.postData));
        assert(puts.length===2&&JSON.stringify(puts[0])===JSON.stringify(puts[1]),'retry event/body changed');
      } finally {await stopIntercept();}
    });
    await run('S2B7 stale-tab conflict blocks navigation and explicit reload preserves local copy',async()=>{
      const current=await request('/api/v1/mock-runs/'+runId);const changed=await request('/api/v1/mock-runs/'+runId,'PUT',{expectedRevision:current.data.revision,eventId:randomUUID(),responses:current.data.responses,position:current.data.position});assert(changed.status===200,'synthetic second-tab save failed');
      const prior=await cdp.evaluate("return document.querySelector('input[name=mock-answer]:checked')?.value");await choose(prior===firstChoice?secondChoice:firstChoice);
      await cdp.waitFor("document.querySelector('#mock-save-state')?.textContent==='Noch nicht bestätigt'");
      await cdp.evaluate("location.hash='#/heute';return true;");await cdp.waitFor(`location.hash.endsWith('/abschnitt/${runId}')`);
      assert(await cdp.evaluate("return !document.querySelector('#view-abschnitt').hidden && !!document.querySelector('input[name=mock-answer]:checked')"),'conflict allowed navigation');
      await clickSel(cdp,'[data-mock-action=reload]');await saved();assert(await cdp.evaluate("return document.querySelector('.mock-copy').open && document.querySelector('#mock-local-copy').value.includes('answer')"),'reload omitted local copy');await shot(cdp,'s2-conflict-copy-desktop-light');
    });
    await run('S2B8 finalise confirms unanswered items and locks exact result',async()=>{
      await clickSel(cdp,'[data-mock-action=confirm]');assert(await cdp.evaluate("return document.querySelector('.mock-finish').textContent.includes('unbeantwortet')"),'unanswered confirmation missing');
      await clickSel(cdp,'[data-mock-action=finalise]');await cdp.waitFor("document.querySelector('#mock-result')");
      const result=await request('/api/v1/mock-runs/'+runId);assert(result.data.state==='finalised'&&result.data.result.total===20&&result.data.result.unanswered>0,'finalised result is incomplete');
      assert(await cdp.evaluate("return document.querySelectorAll('.mock-results li').length===20 && !document.querySelector('input[name=mock-answer]')"),'result missing rows or remains writable');await shot(cdp,'s2-finalised-desktop-light');
      await fresh('#/lauf/'+runId);await cdp.waitFor("document.querySelector('#mock-result')");
    });
    await run('S2B9 history retains the original form and retake has a new identity',async()=>{
      await go('fortschritt');await cdp.waitFor(`document.querySelector('#mock-history [data-mock-run="${runId}"]')`);
      await go('abschnitt');await cdp.waitFor("document.querySelector('[data-mock-start]')");await clickSel(cdp,'[data-mock-start]');await cdp.waitFor("document.querySelector('input[name=mock-answer]')");
      assert(await cdp.evaluate(`return location.hash.split('/').at(-1)!==${JSON.stringify(runId)}`),'retake reused original identity');
    });
    await run('S2B10 real archived preparation keeps run readable and blocks controls',async()=>{
      const activeRun=await cdp.evaluate("return location.hash.split('/').at(-1)");const prep=await request('/api/v1/preparations/'+preparationId);
      const archived=await request('/api/v1/preparations/'+preparationId,'PUT',{expectedRevision:prep.data.revision,state:'archived'});assert(archived.status===200,'synthetic archive failed');
      try {await fresh('#/lauf/'+activeRun);await cdp.waitFor("document.querySelector('#mock-host').textContent.includes('schreibgeschützt')");assert(await cdp.evaluate("return [...document.querySelectorAll('input[name=mock-answer]')].every(n=>n.disabled||n.closest('fieldset').disabled) && !document.querySelector('[data-mock-action=confirm]')"),'archived answer controls writable');await shot(cdp,'s2-archived-desktop-light');}
      finally {const current=await request('/api/v1/preparations/'+preparationId);const restored=await request('/api/v1/preparations/'+preparationId,'PUT',{expectedRevision:current.data.revision,state:'active'});assert(restored.status===200,'synthetic preparation restore failed');await fresh('#/lauf/'+activeRun);await cdp.waitFor("document.querySelector('input[name=mock-answer]')");}
    });
    await run('S2B11 rights block and elapsed deadline retain identity (synthetic responses)',async()=>{
      const activeRun=await cdp.evaluate("return location.hash.split('/').at(-1)");const original=await request('/api/v1/mock-runs/'+activeRun);
      const blocked={...original.data,blocked_reason:'rights_blocked',members:[],result:null};
      await intercept('Request',async event=>{if(event.request.method==='GET'){await reply(event,blocked);return true;}return false;});
      try {await fresh('#/lauf/'+activeRun);await cdp.waitFor("document.querySelector('#mock-host').textContent.includes('zurzeit gesperrt')");assert(await cdp.evaluate("return !document.querySelector('input[name=mock-answer]') && !document.querySelector('[data-mock-action=confirm]') && !!document.querySelector('#mock-local-copy')"),'rights block exposes content or loses response copy');await shot(cdp,'s2-rights-blocked-desktop-light');}finally{await stopIntercept();}
      const timed={...original.data,mode:'timed',server_now:new Date().toISOString(),deadline_at:new Date(Date.now()-1000).toISOString(),expired:false};
      await intercept('Request',async event=>{if(event.request.method==='GET'){await reply(event,timed);return true;}return false;});
      try {await fresh('#/lauf/'+activeRun);await cdp.waitFor("document.querySelector('#mock-host').textContent.includes('Die Zeit ist abgelaufen')");assert(await cdp.evaluate("return [...document.querySelectorAll('input[name=mock-answer]')].every(n=>n.disabled||n.closest('fieldset').disabled)"),'expired answers writable');await clickSel(cdp,'[data-mock-member="1"][data-mock-item="0"]');assert(await cdp.evaluate("return document.querySelector('[data-mock-member=\"1\"][data-mock-item=\"0\"]').getAttribute('aria-current')==='step'"),'elapsed deadline prevented readonly navigation before server refresh');await shot(cdp,'s2-expired-desktop-light');}finally{await stopIntercept();}
      await fresh('#/lauf/'+activeRun);await cdp.waitFor("document.querySelector('input[name=mock-answer]')");
    });
    await run('S2B12 account-expiry refusal keeps current answer and copy recovery',async()=>{
      await intercept('Request',async event=>{if(event.request.method==='PUT'){await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:401,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:'unauthenticated'})).toString('base64')});return true;}return false;});
      try {await choose(firstChoice);await cdp.waitFor("document.querySelector('#mock-save-state')?.textContent==='Noch nicht bestätigt'");assert(await cdp.evaluate("return !!document.querySelector('input[name=mock-answer]:checked') && !document.querySelector('#error').hidden && document.querySelector('#mock-local-copy').value.includes('answer')"),'expiry lost answers or recovery');await shot(cdp,'s2-session-expired-desktop-light');}finally{await stopIntercept();}
    });
  } finally {
    if(stopIntercept){try{await stopIntercept();}catch{}}
    if(cdp)cdp.ws.close();await browser.cleanup();
  }
}
