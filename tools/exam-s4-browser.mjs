/** Internal S4 writing acceptance; the caller supplies an isolated synthetic Compose stack. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';

export async function verifyExamS4({base,email,password,freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,query,runWorker}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(origin.hostname)
    || !origin.port || ['4300','55440'].includes(origin.port) || origin.origin !== base
    || !/^browser-[a-z0-9-]+@example\.test$/i.test(email)) throw Error('S4 requires an isolated loopback server and synthetic browser account');
  for (const callback of [freePort,record,shot,viewport,theme,nav,setInputs,clickSel,overflow,query,runWorker])
    if (typeof callback !== 'function') throw Error('S4 requires its complete fixture harness');
  const browsers=[], connections=[];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const run=async(name,test)=>{try{await test();record(name,true);}catch(error){record(name,false,error.stack||error.message);}};
  const launch=async()=>{const port=await freePort(),browser=await launchBrowser(port);browsers.push(browser);const cdp=await connectToPage(port);connections.push(cdp);await cdp.send('Network.enable');await viewport(cdp,1440,900,false);await theme(cdp,'light');return cdp;};
  const request=(cdp,route,method='GET',body)=>cdp.evaluate(`return (async()=>{const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'}${body===undefined?'':',body:'+JSON.stringify(JSON.stringify(body))}});return {status:response.status,data:await response.json()};})()`);
  const ready=cdp=>cdp.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value",20000);
  const signin=async cdp=>{await nav(cdp,base+'/signin');await setInputs(cdp,{'si-email':email,'si-password':password});await clickSel(cdp,'#si-submit');await cdp.waitFor("document.querySelector('#boot-choices') && !document.querySelector('#boot-choices').hidden || document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden",20000);};
  const fresh=async(cdp,hash)=>{const token=randomUUID();await cdp.evaluate(`window.__s4Document=${JSON.stringify(token)};return true;`);const result=await cdp.send('Page.navigate',{url:base+'/app/?s4Probe='+token+hash});assert(result.loaderId,'fresh document required');await cdp.waitFor(`window.__s4Document!==${JSON.stringify(token)} && document.readyState==='complete'`,20000);await ready(cdp);};
  const go=async(cdp,view)=>{await cdp.evaluate(`location.hash=${JSON.stringify('#/'+view)};return true;`);await cdp.waitFor(`location.hash.endsWith('/${view}') && !document.querySelector('#view-${view}').hidden`);};
  const select=async(cdp,id)=>{await cdp.evaluate(`const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(id)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);await cdp.waitFor(`document.querySelector('#preparation-picker').value===${JSON.stringify(id)} && !document.querySelector('#preparation-picker').disabled && location.hash.includes(${JSON.stringify(id)})`);};
  const current=async(cdp,id)=>{const r=await request(cdp,'/api/v1/mock-runs/'+id);assert(r.status===200,'run read failed '+JSON.stringify(r));return r.data;};
  const savedWriting=cdp=>cdp.waitFor("document.querySelector('#writing-state')?.textContent.includes('Gespeichert')",15000);
  const finaliseUI=async cdp=>{await clickSel(cdp,'[data-mock-action="confirm"]');await cdp.waitFor("document.querySelector('[data-mock-action=finalise]')");await clickSel(cdp,'[data-mock-action="finalise"]');await cdp.waitFor("document.querySelector('.mock-results') || document.querySelector('#writing-state')?.textContent.includes('Abgegeben') || document.querySelector('#writing-state')?.textContent.includes('Unbewertet')",15000);};
  let a,b,dtz,telc,forms,writingRun,combinedRun,originalText,originalSubmission,selectedTask,telcCredits;
  try {
    a=await launch();await signin(a);
    await run('S4B1 internal two-exam entry and writing form catalogue',async()=>{
      const choice=await a.evaluate("return Boolean(document.querySelector('[data-preparation=\"new:dtz-a2-b1\"]'))");
      if(choice){await clickSel(a,'[data-preparation="new:dtz-a2-b1"]');await ready(a);} else await ready(a);
      let list=await request(a,'/api/v1/preparations');
      let rows=list.data.preparations||list.data;
      telc=rows.find(p=>p.exam_id==='telc-deutsch-b1');dtz=rows.find(p=>p.exam_id==='dtz-a2-b1');
      if(!dtz){const made=await request(a,'/api/v1/preparations','POST',{examId:'dtz-a2-b1'});assert([200,201].includes(made.status),'DTZ preparation refused');dtz=made.data.preparation||made.data;await fresh(a,'#/prep/'+dtz.id+'/ueben');}
      await select(a,dtz.id);
      telcCredits=(await request(a,'/api/v1/preparations/'+telc.id+'/credits')).data;
      query(`INSERT INTO hatoove.entitlements(owner_id,exam_id,allowance,used,reserved) SELECT id,'dtz-a2-b1',1,0,0 FROM hatoove."user" WHERE email='${email}' ON CONFLICT(owner_id,exam_id) DO UPDATE SET allowance=1`);
      const response=await request(a,'/api/v1/mock-forms?preparationId='+dtz.id);forms=response.data.forms;
      assert(response.status===200&&forms.length===2,'S4 must expose two internal partial forms');
      assert(forms.every(f=>f.release_version==='v3'&&f.release_state==='internal'&&f.scope==='section'),'S4 exposed complete or public form');
      await go(a,'abschnitt');await a.waitFor("document.querySelectorAll('[data-mock-start]').length===2");
      assert(await a.evaluate("return document.querySelector('#view-abschnitt').textContent.includes('Fachliche Prüfung ausstehend')"),'missing unreviewed label');
    });
    if(!dtz||!forms)return;
    await run('S4B2 A/B prompts are shown before immutable selection',async()=>{
      const index=forms.findIndex(f=>f.form_id==='dtz-a2-b1.writing.original01');assert(index>=0,'writing-only form missing');
      await clickSel(a,`[data-mock-start="${index}"]`);
      await a.waitFor("location.hash.includes('/abschnitt/') && document.querySelector('[data-mock-choice-option=\"A\"]')");
      writingRun=await a.evaluate("return location.hash.split('/').at(-1)");
      const before=await current(a,writingRun);assert(before.writing===null&&before.writing_choices[0].options.length===2,'choice already bound before selection');
      selectedTask=before.writing_choices[0].options.find(o=>o.id==='A').task;
      await shot(a,'s4-choice-desktop-light');
      await clickSel(a,'[data-mock-choice-group="SA1"][data-mock-choice-option="A"]');
      await a.waitFor("document.querySelector('#writing-text') && !document.querySelector('#writing-text').readOnly");
      const chosen=await current(a,writingRun);assert(chosen.writing.selected_option_id==='A'&&chosen.writing.attempt_id,'A binding absent');
      const refusal=await request(a,'/api/v1/mock-runs/'+writingRun+'/writing-choice','POST',{expectedRevision:chosen.revision,eventId:randomUUID(),choiceGroupId:'SA1',optionId:'B'});
      assert(refusal.status===409,'B can overwrite the selected A prompt');
      assert((await current(a,writingRun)).writing.attempt_id===chosen.writing.attempt_id,'refused selection changed attempt');
    });
    if(!writingRun)return;
    await run('S4B3 acknowledged writing survives refresh, another tab and exam switch',async()=>{
      originalText='Sehr geehrte Damen und Herren,\n\nich schreibe Ihnen wegen meiner Anfrage. Bitte nennen Sie mir einen passenden Termin und die nötigen Unterlagen. Vielen Dank für Ihre Unterstützung.\n\nMit freundlichen Grüßen\nAlex Beispiel';
      await setInputs(a,{'writing-text':originalText});
      await savedWriting(a);
      const runDTO=await current(a,writingRun);const attempt=await request(a,'/api/v1/attempts/'+runDTO.writing.attempt_id);
      assert(attempt.data.text===originalText,'server draft differs from acknowledged text');
      b=await launch();await signin(b);await fresh(b,'#/lauf/'+writingRun);await b.waitFor("document.querySelector('#writing-text')");
      assert(await b.evaluate(`return document.querySelector('#writing-text').value===${JSON.stringify(originalText)}`),'fresh tab lost writing');
      await select(a,telc.id);await select(a,dtz.id);await fresh(a,'#/lauf/'+writingRun);await a.waitFor("document.querySelector('#writing-text')");
      assert(await a.evaluate(`return document.querySelector('#writing-text').value===${JSON.stringify(originalText)}`),'exam switch lost writing');
      assert((await current(a,writingRun)).writing.selected_option_id==='A','refresh changed choice');
    });
    await run('S4B4 writing and prompt fit desktop, narrow phones and both themes',async()=>{
      for(const width of [1440,390,320]){
        await viewport(a,width,width===1440?900:844,width!==1440);
        for(const mode of ['light','dark']){
          await theme(a,mode);const layout=await overflow(a);
          await shot(a,`s4-writing-${width}-${mode}`,'#writing-text');
          assert(layout.offenderCount===0,`${width}/${mode} overflow ${JSON.stringify(layout)}`);
        }
      }
      await viewport(a,1440,900,false);await theme(a,'light');
      await a.evaluate("document.querySelector('#writing-text').focus();return true;");
      assert(await a.evaluate("return document.activeElement.id==='writing-text'"),'writing keyboard focus missing');
      await shot(a,'s4-writing-keyboard-desktop-light','#writing-text');
    });
    await run('S4B5 failed save refuses exam switching and keeps the local letter visible',async()=>{
      const unsaved=originalText+'\nNoch eine kurze Frage zu meiner Anfrage.';
      await a.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
      await setInputs(a,{'writing-text':unsaved});
      await a.evaluate(`const picker=document.querySelector('#preparation-picker');picker.value=${JSON.stringify(telc.id)};picker.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
      await a.waitFor("document.querySelector('#writing-state')?.textContent.includes('nicht gespeichert')",15000);
      assert(await a.evaluate(`return document.querySelector('#writing-text').value===${JSON.stringify(unsaved)} && document.querySelector('#preparation-picker').value===${JSON.stringify(dtz.id)}`),'failed switch lost old context or local writing');
      await shot(a,'s4-offline-writing-preserved-desktop');
      await a.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
      await clickSel(a,'#writing-save-again');await savedWriting(a);originalText=unsaved;
    });
    await run('S4B6 a stale tab cannot overwrite an acknowledged writing revision',async()=>{
      await setInputs(b,{'writing-text':'Meine abweichende Fassung bleibt in diesem Fenster.'});
      await b.waitFor("document.querySelector('#writing-state')?.textContent.includes('anderen Fenster')",15000);
      assert(await b.evaluate("return document.querySelector('#writing-text').value==='Meine abweichende Fassung bleibt in diesem Fenster.'"),'conflict erased local text');
      const state=await current(a,writingRun);const remote=await request(a,'/api/v1/attempts/'+state.writing.attempt_id);
      assert(remote.data.text===originalText,'stale tab overwrote the server letter');
      await shot(b,'s4-writing-conflict-desktop');
    });
    await run('S4B7 finalised writing survives pending feedback and a fresh document',async()=>{
      await finaliseUI(a);
      let row=await current(a,writingRun);assert(row.state==='finalised'&&row.result===null&&row.writing.assessment_state==='pending','writing-only finalise invented objective result or lost pending state');
      originalSubmission=row.writing.submission_id;assert(originalSubmission,'submission missing');
      await fresh(a,'#/lauf/'+writingRun);await a.waitFor("document.querySelector('#writing-state')?.textContent.includes('Abgegeben')");
      assert(await a.evaluate(`return document.querySelector('.submitted-text').textContent===${JSON.stringify(originalText)}`),'pending submission original lost');
      await shot(a,'s4-pending-writing-desktop');
      const credit=(await request(a,'/api/v1/preparations/'+dtz.id+'/credits')).data;assert(credit.used===0&&credit.reserved===1,'pending assessment did not reserve exactly DTZ credit');
    });
    await run('S4B8 real worker failure keeps the original and refunds only its reservation',async()=>{
      const worker=runWorker('fail');assert(worker.outcome==='failed','injected failure did not use the real failure path');
      await clickSel(a,'#writing-refresh');await a.waitFor("document.querySelector('#writing-state')?.textContent.includes('Unbewertet')");
      assert(await a.evaluate(`return document.querySelector('.submitted-text').textContent===${JSON.stringify(originalText)}`),'failure erased submission');
      const credit=(await request(a,'/api/v1/preparations/'+dtz.id+'/credits')).data;assert(credit.used===0&&credit.reserved===0,'failure consumed DTZ credit');
      await shot(a,'s4-unassessed-failure-desktop');
      await clickSel(a,'#writing-retry');await a.waitFor("document.querySelector('#writing-state')?.textContent.includes('Abgegeben')");
      assert((await current(a,writingRun)).writing.submission_id===originalSubmission,'retry replaced immutable submission');
    });
    await run('S4B9 synthetic DTZ feedback has four bound criteria and one selected-exam debit',async()=>{
      const worker=runWorker('succeed');assert(worker.outcome==='succeeded','synthetic worker did not complete');
      await clickSel(a,'#writing-refresh');await a.waitFor("document.querySelectorAll('#writing-state .criterion').length===4",15000);
      assert(await a.evaluate("return document.querySelector('#writing-state').textContent.includes('Simulation') && !document.querySelector('#writing-state').textContent.includes('telc-Kriterien') && !document.querySelector('#writing-state').textContent.includes('/45')"),'DTZ feedback reused telc or omitted simulation warning');
      const result=await request(a,'/api/v1/submissions/'+originalSubmission);
      assert(result.data.assessment.feedback.kind==='dtz-writing-bands','wrong feedback policy');
      assert(result.data.assessment.feedback.criteria.every(c=>['B1_PLUS','B1','A2_PLUS','A2','A1','ZERO'].includes(c.band)),'unexpected DTZ position');
      const credit=(await request(a,'/api/v1/preparations/'+dtz.id+'/credits')).data;assert(credit.used===1&&credit.reserved===0,'successful feedback not debited exactly once');
      assert(JSON.stringify((await request(a,'/api/v1/preparations/'+telc.id+'/credits')).data)===JSON.stringify(telcCredits),'DTZ assessment touched telc allowance');
      for(const width of [1440,390,320]){
        await viewport(a,width,width===1440?900:844,width!==1440);await theme(a,width===320?'dark':'light');
        const layout=await overflow(a);assert(layout.offenderCount===0,'feedback overflow');
        const collisions=await a.evaluate(`return [...document.querySelectorAll('#writing-state .criterion-head')].flatMap(head=>{
          const label=head.querySelector('strong'),band=head.querySelector('.band');if(!label||!band)return ['missing criterion heading'];
          const boxes=el=>{const range=document.createRange();range.selectNodeContents(el);return [...range.getClientRects()];};
          if(boxes(band).length!==1)return ['band label must stay together: '+band.textContent];
          return boxes(label).some(l=>boxes(band).some(b=>Math.min(l.right,b.right)-Math.max(l.left,b.left)>1&&Math.min(l.bottom,b.bottom)-Math.max(l.top,b.top)>1))?[label.textContent]:[];
        });`);
        await shot(a,`s4-feedback-${width}`,'#writing-state');
        assert(collisions.length===0,`${width}px criterion title/band overlap: ${JSON.stringify(collisions)}`);
      }
      await viewport(a,1440,900,false);await theme(a,'light');
    });
    await run('S4B10 revision preserves the selected prompt and original submission',async()=>{
      await clickSel(a,'#writing-revise');await a.waitFor("document.querySelector('#writing-text') && !document.querySelector('#writing-text').readOnly");
      await setInputs(a,{'writing-text':originalText+'\nDies ist meine überarbeitete Fassung.'});await savedWriting(a);
      const history=await request(a,'/api/v1/attempts?preparationId='+dtz.id);
      const child=history.data.attempts.find(item=>item.parent_submission_id===originalSubmission);
      assert(child,'linked revision missing from owned history');
      const revision=await request(a,'/api/v1/attempts/'+child.id);
      assert(revision.data.task_id===selectedTask.task_id&&revision.data.task_version===selectedTask.version
        &&revision.data.rubric_id===selectedTask.rubric_id&&revision.data.rubric_version===selectedTask.rubric_version
        &&revision.data.parent_submission_id===originalSubmission&&revision.data.exam_id==='dtz-a2-b1'
        &&!revision.data.mock_run_id,'revision changed the immutable selected prompt/rubric or rewrote the run attachment');
      const result=await request(a,'/api/v1/submissions/'+originalSubmission);assert(result.data.submission.text===originalText,'revision rewrote original');
      assert((await current(a,writingRun)).writing.submission_id===originalSubmission,'revision replaced frozen mock attachment');
      await shot(a,'s4-independent-revision-desktop','#writing-text');
    });
    await run('S4B11 exhausted writing credit preserves completed objective work without spending telc',async()=>{
      await go(a,'abschnitt');await a.waitFor("document.querySelectorAll('[data-mock-start]').length===2");
      const index=forms.findIndex(f=>f.form_id==='dtz-a2-b1.reading-writing.internal01');
      await clickSel(a,`[data-mock-start="${index}"]`);await a.waitFor("document.querySelector('[data-mock-choice-option=\"B\"]')");
      combinedRun=await a.evaluate("return location.hash.split('/').at(-1)");
      await clickSel(a,'[data-mock-choice-option="B"]');await a.waitFor("document.querySelector('#writing-text')");
      await setInputs(a,{'writing-text':'Liebe Nachbarin, ich möchte dir eine kurze Nachricht zu unserem Vorhaben schreiben. Bitte melde dich, sobald du Zeit hast. Viele Grüße, Alex'});await savedWriting(a);
      await a.evaluate("const input=document.querySelector('input[name=mock-answer]');if(!input)throw Error('reading answer missing');input.click();return true;");
      await a.waitFor("document.querySelector('#mock-save-state')?.textContent.startsWith('Gespeichert') && document.querySelector('input[name=mock-answer]:checked')");
      const before=await current(a,combinedRun);assert(before.members.length===5,'combined partial form lost reading');
      assert(before.responses.length===1&&before.responses[0].answer!==null,'objective answer was not acknowledged before finalisation');
      await finaliseUI(a);const row=await current(a,combinedRun);
      assert(row.state==='finalised'&&row.result?.total===25&&row.writing.assessment_state==='unassessed'&&row.writing.failure_code==='allowance_exhausted','exhaustion lost completed objective work or fabricated writing assessment');
      assert(row.responses[0].answer===before.responses[0].answer&&row.result.items.some(item=>item.item_id===before.responses[0].itemId&&item.answer===before.responses[0].answer&&!item.unanswered),'unassessed writing lost the submitted objective answer');
      await fresh(a,'#/lauf/'+combinedRun);await a.waitFor("document.querySelector('#writing-state')?.textContent.includes('Unbewertet')");
      assert(await a.evaluate("return Boolean(document.querySelector('.submitted-text')?.textContent.trim())"),'unassessed text not retained');
      assert(JSON.stringify((await request(a,'/api/v1/preparations/'+telc.id+'/credits')).data)===JSON.stringify(telcCredits),'exhausted DTZ spent telc');
      await shot(a,'s4-objective-complete-writing-unassessed-desktop');
      await viewport(a,390,844,true);
      assert(await a.evaluate("const chip=document.querySelector('.writing-prompt .card-head .chip');const range=document.createRange();range.selectNodeContents(chip);return range.getClientRects().length===1;"),'writing prompt chip breaks into multiple lines');
      await shot(a,'s4-objective-complete-writing-unassessed-mobile','#writing-state');
    });
    await run('S4B12 history and export keep original exam, selected option and saved work',async()=>{
      await go(a,'fortschritt');await a.waitFor(`document.querySelector('[data-mock-run="${combinedRun}"]')`);
      const exported=await request(a,'/api/v1/export');
      assert(exported.status===200,'account export failed');
      const serialized=JSON.stringify(exported.data);assert(serialized.includes(originalSubmission)&&serialized.includes(writingRun)&&serialized.includes(combinedRun)&&serialized.includes('dtz-a2-b1'),'export lost writing/run identities');
      await select(a,telc.id);assert(await a.evaluate(`return !document.querySelector('[data-mock-run="${combinedRun}"]')`),'DTZ run leaked into telc history');
    });
  } finally {
    for(const cdp of connections)cdp.ws.close();
    for(const browser of browsers)await browser.cleanup();
  }
}
