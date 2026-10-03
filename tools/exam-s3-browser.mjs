/** S3 browser evidence. The caller owns its disposable source-only server and two-exam catalogue seam. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';

export async function verifyExamS3({base,email,password,freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,query,fixtureSetup}) {
  const origin=new URL(base);
  if(origin.protocol!=='http:'||!['localhost','127.0.0.1'].includes(origin.hostname)||!origin.port||['4300','55440'].includes(origin.port)||origin.origin!==base||!/^browser-[a-z0-9-]+@example\.test$/i.test(email)) throw Error('S3 requires an isolated loopback server and synthetic browser account');
  for(const callback of [freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,query,fixtureSetup]) if(typeof callback!=='function') throw Error('S3 requires the complete supplied fixture/browser harness');
  // The normal signup path provisions telc. Do not delete its preparation to manufacture choice.
  const fixture=await fixtureSetup({email});
  if(!/^browser-[a-z0-9-]+@example\.test$/i.test(fixture?.emptyEmail||'')||typeof fixture.emptyPassword!=='string'||!fixture.emptyPassword) throw Error('S3 fixture must supply a fresh normal synthetic signup');
  const browsers=[], connections=[];let a,b,stopIntercept=null;
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const run=async(name,test)=>{try{await test();record(name,true);}catch(error){record(name,false,error.message);}};
  const launch=async()=>{const port=await freePort(),browser=await launchBrowser(port);browsers.push(browser);const cdp=await connectToPage(port);connections.push(cdp);await cdp.send('Network.enable');await viewport(cdp,1440,900,false);await theme(cdp,'light');return cdp;};
  const request=(cdp,route,method='GET',body)=>cdp.evaluate(`return (async()=>{const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:response.status,data:await response.json()};})()`);
  const signin=async cdp=>{await nav(cdp,base+'/signin');await setInputs(cdp,{'si-email':fixture.emptyEmail,'si-password':fixture.emptyPassword});await clickSel(cdp,'#si-submit');await cdp.waitFor("document.querySelector('#boot-choices') && !document.querySelector('#boot-choices').hidden || document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden",20000);};
  const ready=cdp=>cdp.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value",20000);
  const go=async(cdp,view)=>{await cdp.evaluate(`location.hash=${JSON.stringify('#/'+view)};return true;`);await cdp.waitFor(`location.hash.endsWith('/${view}') && !document.querySelector('#view-${view}').hidden`);};
  const fresh=async(cdp,hash)=>{const token=randomUUID();await cdp.evaluate(`window.__s3Document=${JSON.stringify(token)};return true;`);const result=await cdp.send('Page.navigate',{url:base+'/app/?s3Probe='+token+hash});assert(result.loaderId,'new document required');await cdp.waitFor(`window.__s3Document!==${JSON.stringify(token)} && document.readyState==='complete'`,20000);await ready(cdp);};
  const select=async(cdp,id)=>{await cdp.evaluate(`const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(id)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);await cdp.waitFor(`document.querySelector('#preparation-picker').value===${JSON.stringify(id)} && !document.querySelector('#preparation-picker').disabled && location.hash.includes(${JSON.stringify(id)})`);};
  const saved=cdp=>cdp.waitFor("document.querySelector('#mock-save-state')?.textContent.startsWith('Gespeichert') && !document.querySelector('[data-mock-action=save]')?.disabled");
  const answer=async(cdp,value)=>{await cdp.evaluate(`const input=document.querySelector('input[name="mock-answer"][value=${JSON.stringify(value)}]');if(!input)throw Error('answer option missing');input.click();return true;`);};
  const openItem=async(cdp,member,item)=>{await clickSel(cdp,`[data-mock-member="${member}"][data-mock-item="${item}"]`);await saved(cdp);};
  const waitNode=async promise=>{let timeout;try{return await Promise.race([promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('held fixture request missing')),12000);})]);}finally{clearTimeout(timeout);}};
  const intercept=async(cdp,pattern,stage,handler)=>{
    const pending=new Set();let failure;
    const listener=event=>{const message=JSON.parse(event.data);if(message.method!=='Fetch.requestPaused')return;const eventData=message.params;pending.add(eventData.requestId);Promise.resolve(handler(eventData)).then(async handled=>{if(!pending.delete(eventData.requestId))return;if(!handled)await cdp.send('Fetch.continueRequest',{requestId:eventData.requestId});}).catch(async error=>{failure=error.message;try{await cdp.send('Fetch.continueRequest',{requestId:eventData.requestId});}catch{}pending.delete(eventData.requestId);});};
    cdp.ws.addEventListener('message',listener);await cdp.send('Fetch.enable',{patterns:[{urlPattern:pattern,requestStage:stage}]});
    stopIntercept=async()=>{cdp.ws.removeEventListener('message',listener);for(const requestId of pending){pending.delete(requestId);try{await cdp.send('Fetch.continueRequest',{requestId});}catch{}}await cdp.send('Fetch.disable');stopIntercept=null;if(failure)throw Error(failure);};
  };
  let telcId,dtzId,runId,runDTO,grouped,cloze,creditsBefore;
  try {
    a=await launch();await signin(a);
    await run('S3B1 normal signup explicitly chooses between two exams before practice',async()=>{
      await a.waitFor("document.querySelector('#app-shell').hidden && !document.querySelector('#boot-choices').hidden && document.querySelectorAll('#boot-choices [data-preparation]').length===2");
      const preps=await request(a,'/api/v1/preparations');assert(preps.status===200&&preps.data.preparations.length===1,'normal signup must retain its single provisioned telc preparation');telcId=preps.data.preparations[0].id;
      assert(preps.data.preparations[0].exam_id==='telc-deutsch-b1','expected provisioned telc preparation');
      for(const width of [1440,390,320]){await viewport(a,width,width===1440?900:844,width!==1440);assert((await overflow(a)).offenderCount===0,'chooser overflows at '+width);await shot(a,'s3-exam-choice-'+width+'-light');}
      await clickSel(a,'[data-preparation="new:dtz-a2-b1"]');await ready(a);dtzId=await a.evaluate("return document.querySelector('#preparation-picker').value");assert(dtzId!==telcId,'DTZ must get its own preparation');await viewport(a,1440,900,false);
    });
    if(!telcId||!dtzId)return;
    await run('S3B2 dates and credits stay attached to their original exam',async()=>{
      const telcCredits=await request(a,'/api/v1/preparations/'+telcId+'/credits'),dtzCredits=await request(a,'/api/v1/preparations/'+dtzId+'/credits');assert(telcCredits.status===200&&dtzCredits.status===200,'credit reads unavailable');creditsBefore={telc:telcCredits.data,dtz:dtzCredits.data};assert(dtzCredits.data.allowance===0,'fixture must not grant DTZ writing credits');
      await go(a,'einstellungen');await setInputs(a,{examDate:'2026-12-21'});await clickSel(a,'#save-settings');await a.waitFor("document.querySelector('#settings-state').textContent==='Gespeichert.'");
      await select(a,telcId);assert(await a.evaluate("return document.querySelector('#examDate').value===''") ,'DTZ date leaked into telc');await setInputs(a,{examDate:'2026-12-09'});await clickSel(a,'#save-settings');await a.waitFor("document.querySelector('#settings-state').textContent==='Gespeichert.'");
      await select(a,dtzId);assert(await a.evaluate("return document.querySelector('#examDate').value==='2026-12-21'"),'DTZ date not retained');
    });
    await run('S3B3 standalone DTZ uses exact interaction metadata and keeps cloze in reading',async()=>{
      const catalog=await request(a,'/api/v1/objective-sets?preparationId='+dtzId);assert(catalog.status===200&&catalog.data.length===5&&catalog.data.every(set=>set.section==='LV'),'DTZ catalogue must contain five reading parts');
      const groupSet=catalog.data.find(set=>set.interaction==='grouped_choice'),clozeSet=catalog.data.find(set=>set.interaction==='gap_choice'),directory=catalog.data.find(set=>set.part===1);assert(groupSet&&clozeSet&&directory,'interaction metadata missing');
      grouped=(await request(a,'/api/v1/objective-sets/'+encodeURIComponent(groupSet.set_id)+'?version='+groupSet.version+'&preparationId='+dtzId)).data;cloze=(await request(a,'/api/v1/objective-sets/'+encodeURIComponent(clozeSet.set_id)+'?version='+clozeSet.version+'&preparationId='+dtzId)).data;
      await go(a,'lesen');await a.waitFor("document.querySelectorAll('#skill-lesen [data-open]').length===5");await a.waitFor("[...document.querySelectorAll('[data-view=sprachbausteine]')].every(link=>link.hidden)");
      await clickSel(a,`[data-open="${directory.set_id}"]`);await a.waitFor("document.querySelector('#practice-items [data-item=\"21\"] [data-answer]')");await clickSel(a,'#practice-close');
      await clickSel(a,`[data-open="${grouped.set_id}"]`);await a.waitFor("document.querySelectorAll('#practice-items [data-item]').length===6");
      for(const group of grouped.payload.groups)for(const question of group.questions)assert(await a.evaluate(`return document.querySelector('#practice-items [data-item="${question.n}"] .mock-passage').textContent===${JSON.stringify(group.text)}`),'standalone question lost its group passage');
      await shot(a,'s3-grouped-standalone-desktop-light');await clickSel(a,'#practice-close');await clickSel(a,`[data-open="${cloze.set_id}"]`);await a.waitFor("document.querySelector('#practice-items [data-item=\"40\"] [data-answer]')");
      assert(await a.evaluate("return !document.querySelector('#view-lesen').hidden && document.querySelectorAll('#practice-items [data-item]').length===6"),'cloze moved out of reading');await shot(a,'s3-cloze-reading-desktop-light');
    });
    await run('S3B4 start pins the internal unreviewed 25-item DTZ form',async()=>{
      await go(a,'abschnitt');await a.waitFor("document.querySelector('[data-mock-start]')");assert(await a.evaluate("return document.querySelector('.mock-form .mock-review-status').textContent.includes('Interner Entwurf') && document.querySelector('.mock-form .mock-review-status').textContent.includes('Prüfung ausstehend')"),'form lacks internal/unreviewed label');
      await clickSel(a,'[data-mock-start]');await a.waitFor("document.querySelector('input[name=mock-answer]') && location.hash.includes('/abschnitt/')");runId=await a.evaluate("return location.hash.split('/').at(-1)");runDTO=(await request(a,'/api/v1/mock-runs/'+runId)).data;
      assert(runDTO.exam_id==='dtz-a2-b1'&&runDTO.release_version==='v2'&&runDTO.form_version==='v1'&&runDTO.members.reduce((n,m)=>n+m.item_count,0)===25&&runDTO.result===null,'wrong exact DTZ form');
      assert(await a.evaluate("return document.querySelector('.mock-heading .mock-review-status').textContent.includes('Prüfung ausstehend') && document.querySelector('.mock-heading').textContent.includes('Ohne Zeitlimit')"),'run labels incomplete');
    });
    if(!runId)return;
    await run('S3B5 grouped questions keep their own passage through navigation and fresh resume',async()=>{
      const member=runDTO.members.findIndex(item=>item.interaction==='grouped_choice'),groups=runDTO.members[member].payload.groups;let flat=0;
      for(const group of groups)for(const question of group.questions){await openItem(a,member,flat++);assert(await a.evaluate(`return document.querySelector('.mock-question .mock-passage').textContent===${JSON.stringify(group.text)}`),'saved question displays another group passage');}
      await openItem(a,member,2);await answer(a,'falsch');await saved(a);await fresh(a,'#/lauf/'+runId);await a.waitFor("document.querySelector('input[name=mock-answer]:checked')");assert(await a.evaluate(`return document.querySelector('.mock-question .mock-passage').textContent===${JSON.stringify(groups[1].text)} && document.querySelector('input[name=mock-answer]:checked').value==='falsch'`),'fresh resume lost group/answer');
    });
    await run('S3B6 grouped and cloze controls fit desktop, 390 and 320 in both themes',async()=>{
      for(const width of [1440,390,320]){await viewport(a,width,width===1440?900:844,width!==1440);for(const mode of ['light','dark']){await theme(a,mode);for(const [member,item,label] of [[2,0,'group-one'],[2,2,'group-two'],[4,0,'reading-cloze']]){await openItem(a,member,item);assert((await overflow(a)).offenderCount===0,`${width} ${mode} ${label} overflow`);await shot(a,`s3-${label}-${width}-${mode}`);}}}
      await viewport(a,1440,900,false);await theme(a,'light');await openItem(a,2,2);await a.evaluate("document.querySelector('input[name=mock-answer]').focus();return true;");await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await a.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await saved(a);assert(await a.evaluate("return document.activeElement.name==='mock-answer' && getComputedStyle(document.activeElement.closest('.option')).outlineStyle!=='none'"),'keyboard focus lost or invisible');await shot(a,'s3-keyboard-focus-desktop-light');
    });
    await run('S3B7 dirty run saves before switching and preserves the original visible context while pending',async()=>{
      await openItem(a,2,3);let release;const held=new Promise(resolve=>{release=resolve;});let reached;const requested=new Promise(resolve=>{reached=resolve;});
      await intercept(a,'*/api/v1/mock-runs/*','Response',async event=>{if(event.request.method==='PUT'){reached();await held;}return false;});
      try{
        await a.evaluate(`document.querySelector('input[name=mock-answer][value=c]').click();const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(telcId)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);await waitNode(requested);
        assert(await a.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(dtzId)} && document.querySelector('input[name=mock-answer]:checked').value==='c'`),'pending switch replaced original preparation or answer');await shot(a,'s3-switch-saving-desktop-light');release();
        await a.waitFor(`document.querySelector('#preparation-picker').value===${JSON.stringify(telcId)} && !document.querySelector('#preparation-picker').disabled`);
        const result=(await request(a,'/api/v1/mock-runs/'+runId)).data;assert(result.preparation_id===dtzId&&result.responses.some(row=>row.itemId==='34'&&row.answer==='c'),'switch lost durable DTZ answer');
      }finally{release();await stopIntercept();}
    });
    await run('S3B8 independent documents retain separate exam selections',async()=>{
      b=await launch();await signin(b);await fresh(b,'#/lauf/'+runId);await b.waitFor("document.querySelector('input[name=mock-answer]')");
      assert(await b.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(dtzId)}`),'second document failed original run preparation');assert(await a.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(telcId)}`),'other document changed first selection');
    });
    await run('S3B9 real second-document conflict refuses switching and preserves the local answer',async()=>{
      await fresh(a,'#/lauf/'+runId);await a.waitFor("document.querySelector('input[name=mock-answer]')");await answer(b,'a');await saved(b);await answer(a,'b');await a.waitFor("document.querySelector('#mock-save-state')?.textContent==='Noch nicht bestätigt'");
      await a.evaluate(`const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(telcId)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);await a.waitFor("!document.querySelector('#preparation-picker').disabled && document.querySelector('#preparation-state').textContent.includes('angehalten')");
      assert(await a.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(dtzId)} && document.querySelector('input[name=mock-answer]:checked').value==='b' && location.hash.endsWith('/abschnitt/${runId}')`),'conflict switched or lost answer');await shot(a,'s3-switch-conflict-desktop-light');
      await clickSel(a,'[data-mock-action=reload]');await saved(a);assert(await a.evaluate("return document.querySelector('.mock-copy').open && JSON.parse(document.querySelector('#mock-local-copy').value).responses.some(row=>row.itemId==='34' && row.answer==='b') && document.querySelector('input[name=mock-answer]:checked').value==='a'"),'explicit recovery did not preserve local copy or adopt server answer');
    });
    await run('S3B10 obsolete run read cannot replace a later preparation/navigation choice',async()=>{
      await select(a,telcId);await go(a,'heute');let release;const held=new Promise(resolve=>{release=resolve;});let reached;const requested=new Promise(resolve=>{reached=resolve;});
      await intercept(a,'*/api/v1/mock-runs/'+runId,'Response',async event=>{if(event.request.method==='GET'){reached();await held;}return false;});
      try{await a.evaluate(`location.hash='#/lauf/${runId}';return true;`);await waitNode(requested);await go(a,'ueben');release();await stopIntercept();await a.evaluate('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));');assert(await a.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(telcId)} && !document.querySelector('#view-ueben').hidden && !document.querySelector('#mock-host input[name=mock-answer]')`),'late run read replaced selected telc view');}finally{release();if(stopIntercept)await stopIntercept();}
    });
    await run('S3B11 finalised feedback retains each grouped passage and explicit draft status',async()=>{
      await fresh(a,'#/lauf/'+runId);await a.waitFor("document.querySelector('input[name=mock-answer]')");await clickSel(a,'[data-mock-action=confirm]');await clickSel(a,'[data-mock-action=finalise]');await a.waitFor("document.querySelector('#mock-result')");
      assert(await a.evaluate("return document.querySelectorAll('#mock-result > .mock-results > li').length===25 && document.querySelector('#mock-result .mock-review-status').textContent.includes('Prüfung ausstehend')"),'feedback labels/count incomplete');
      for(const group of grouped.payload.groups)for(const question of group.questions){const selector=`[data-review-item="${question.n}"]`;await a.evaluate(`document.querySelector(${JSON.stringify(selector)}).open=true;return true;`);assert(await a.evaluate(`return document.querySelector(${JSON.stringify(selector+' .mock-passage')}).textContent===${JSON.stringify(group.text)}`),'review uses another group passage');}
      for(const width of [1440,390,320]){await viewport(a,width,width===1440?900:844,width!==1440);for(const mode of ['light','dark']){await theme(a,mode);assert((await overflow(a)).offenderCount===0,'review overflow '+width+' '+mode);await shot(a,`s3-grouped-feedback-${width}-${mode}`);}}
      await fresh(b,'#/lauf/'+runId);await b.waitFor("document.querySelector('#mock-result')");assert(await b.evaluate("return !document.querySelector('input[name=mock-answer]')"),'second document did not resume readonly result');
    });
    await run('S3B12 history and allowances remain exam-specific after both documents and finalisation',async()=>{
      await viewport(a,1440,900,false);await theme(a,'light');await go(a,'fortschritt');await a.waitFor(`document.querySelector('#mock-history [data-mock-run="${runId}"]')`);await select(a,telcId);await a.waitFor("document.querySelector('#mock-history').textContent.includes('Noch keine gespeicherten')");assert(await a.evaluate(`return !document.querySelector('#mock-history [data-mock-run="${runId}"]')`),'DTZ history leaked into telc');
      const telc=await request(a,'/api/v1/preparations/'+telcId+'/credits'),dtz=await request(a,'/api/v1/preparations/'+dtzId+'/credits');assert(JSON.stringify(telc.data)===JSON.stringify(creditsBefore.telc)&&JSON.stringify(dtz.data)===JSON.stringify(creditsBefore.dtz),'switching or reading changed an exam allowance');
      assert(await b.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(dtzId)}`),'independent document selection leaked');
    });
  } finally {
    if(stopIntercept){try{await stopIntercept();}catch{}}
    for(const cdp of connections)cdp.ws.close();for(const browser of browsers)await browser.cleanup();
    if(typeof fixture.cleanup==='function')await fixture.cleanup();
  }
}
