/** REDESIGN-01: actual source-only Compose/Chromium evidence, synthetic account and isolated ports. */
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
const sourceRoot = path.resolve(process.argv.find(arg => arg.startsWith('--source-root='))?.slice(14) || root);
const cases = [[1280,1000,'desktop','de','light'],[390,844,'phone','de','light'],[320,844,'narrow','de','light'],[390,844,'arabic-dark','ar','dark'],[1280,1000,'desktop-dark','de','dark'],[320,844,'narrow-dark','de','dark'],[390,844,'phone-dark','de','dark'],[390,844,'english','en','light'],[390,844,'ukrainian','uk','light'],[390,844,'turkish','tr','light']];
const selectedCase = process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
assert.ok(!selectedCase || cases.some(row=>row[2]===selectedCase),'Unknown browser case');
const project = 'hatoove-browser-' + Date.now() + '-' + process.pid;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), project + '-'));
const source = path.join(scratch, 'source'), envFile = path.join(scratch, 'compose.env');
const shots = path.join(root, '.qa', 'redesign-20261009', project);
fs.mkdirSync(shots, { recursive: true });
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const appPort = await port(), dbPort = await port(), debugPort = await port();
assert.equal(new Set([appPort, dbPort, debugPort]).size, 3);
assert.ok(![appPort, dbPort].some(value => [4300, 55440].includes(value)));
const base = 'http://127.0.0.1:' + appPort;
const env = { ...browserEnvironment(), HATOVE_APP_PORT: String(appPort), HATOVE_DB_PORT: String(dbPort), HATOVE_PUBLIC_ORIGIN: base, HATOVE_CONTENT_MODE: 'internal-preview', HATOVE_PAYMENTS_MODE: 'off', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', OWNAPI_PG_PAYMENTS_PASSWORD: '' };
const command = (name, args) => { const result = spawnSync(name, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16e6 }); if (result.status !== 0) throw Error(name + ' failed: ' + (result.stderr || result.stdout).slice(-1200)); return result.stdout.trim(); };
const compose = args => command('docker', ['compose', '--env-file', envFile, '-p', project, '-f', path.join(source, 'compose.yaml'), ...args]);
const verify = () => verifyBrowserProject({ project, dbPort, compose, command });
let browser, cdp, started = false, passes = 0, failures = 0;
const axePath = path.join(root, 'tools/a11y/node_modules/axe-core/axe.min.js');
if (process.argv.includes('--axe')) {
  const entry = JSON.parse(fs.readFileSync(path.join(root, 'tools/a11y/package-lock.json'), 'utf8')).packages['node_modules/axe-core'];
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'tools/a11y/node_modules/axe-core/package.json'), 'utf8'));
  assert.equal(entry.version, '4.13.0'); assert.equal(installed.version, entry.version);
  assert.equal(entry.integrity, 'sha512-UzGt8zg7Ny8djbYMhxl2zuEevVa7r2gJjYY5Lwr1xM7+XU2nd6CkIWFTVcCIbAP63vSz71NaVyyuSk9lHKcy0A==');
}
const axeSource = process.argv.includes('--axe') ? fs.readFileSync(axePath, 'utf8') : null;
const check = async (name, run) => { try { await run(); passes++; console.log('PASS ' + name); } catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.message.split('\n')[0]); } };
try {
  verifyBrowserCleanup(project, command); copyBrowserSource(sourceRoot, source);
  fs.writeFileSync(envFile, 'HATOVE_APP_PORT=' + appPort + '\nHATOVE_DB_PORT=' + dbPort + '\nHATOVE_PUBLIC_ORIGIN=' + base + '\n');
  started = true; compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']); verify();
  await check('released part availability PostgreSQL boundaries',async()=>{
    const result=spawnSync(process.execPath,[path.join(root,'tools/redesign-parts-check.mjs'),'--postgres'],{cwd:root,env:{...env,REDESIGN_TEST_PROJECT:project,OWNAPI_PG_ALLOW:'1',OWNAPI_PG_HOST:'127.0.0.1',OWNAPI_PG_PORT:String(dbPort),OWNAPI_PG_DATABASE:'hatoove',OWNAPI_PG_USER:'postgres'},encoding:'utf8',windowsHide:true,timeout:180000});
    fs.writeFileSync(path.join(shots,'part-availability.txt'),result.stdout+'\n'+result.stderr);
    assert.equal(result.status,0,(result.stderr||result.stdout).slice(-1000));
  });
  await check('owned PostgreSQL retry boundaries',async()=>{
    const result=spawnSync(process.execPath,[path.join(root,'tools/redesign-owned-check.mjs')],{cwd:root,env:{...env,REDESIGN_TEST_PROJECT:project,OWNAPI_PG_ALLOW:'1',OWNAPI_PG_HOST:'127.0.0.1',OWNAPI_PG_PORT:String(dbPort),OWNAPI_PG_DATABASE:'hatoove',OWNAPI_PG_USER:'postgres'},encoding:'utf8',windowsHide:true,timeout:180000});
    fs.writeFileSync(path.join(shots,'owned-retry.txt'),result.stdout+'\n'+result.stderr);
    assert.equal(result.status,0,(result.stderr||result.stdout).slice(-1000));
  });
  await check('unreviewed product capture translation fixture',async()=>{
    const result=spawnSync(process.execPath,[path.join(root,'tools/redesign-product-fixture.mjs')],{cwd:root,env:{...env,REDESIGN_TEST_PROJECT:project,OWNAPI_PG_HOST:'127.0.0.1',OWNAPI_PG_PORT:String(dbPort)},encoding:'utf8',windowsHide:true,timeout:30000});
    fs.writeFileSync(path.join(shots,'product-fixture.txt'),result.stdout+'\n'+result.stderr);
    assert.equal(result.status,0,(result.stderr||result.stdout).slice(-1000));
  });
  browser = await launchBrowser(debugPort); cdp = await connectToPage(debugPort);
  await cdp.send('Network.enable');
  await cdp.send('Page.navigate', { url: base + '/signin?mode=signup' });
  await cdp.waitFor("document.querySelector('#su-submit')"); await sleep(350); await cdp.click('#tab-signup');
  await cdp.waitFor("document.querySelector('#form-signup').getBoundingClientRect().height>0");
  const email = project + '@example.test';
  await cdp.evaluate(`for (const [id,value] of Object.entries(${JSON.stringify({ 'su-name': 'Synthetic Redesign', 'su-email': email, 'su-password': 'Synthetic-redesign-pass-2026' })})) { const node=document.getElementById(id); node.value=value; node.dispatchEvent(new Event('input',{bubbles:true})); } document.getElementById('su-submit').click();`);
  await cdp.waitFor("location.pathname.startsWith('/app') && document.querySelector('#account-email')?.textContent.includes('@')", 20000);
  const shot = async name => { const value = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(value.data, 'base64')); };
  const scan = async name => {
    if(!axeSource)return;
    await check(name+' axe',async()=>{
      await cdp.send('Runtime.evaluate',{expression:axeSource});
      const result=await cdp.evaluate("return axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})");
      fs.writeFileSync(path.join(shots,name+'-axe.json'),JSON.stringify(result));
      assert.deepEqual(result.violations.map(row=>row.id+':'+row.nodes.map(node=>node.target.join(',')).join(';')),[]);
    });
  };
  const checkGoAction = async (name, required = false) => {
    await check(name + ' continuation uses the orange face and readable ink', async () => {
      const actions = await cdp.evaluate("return [...document.querySelectorAll('.btn-go')].filter(node=>node.getBoundingClientRect().width>0 && node.getBoundingClientRect().height>0).map(node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,color:style.color};});");
      assert.ok(actions.length <= 1, 'at most one visible continuation action');
      if (required) assert.equal(actions.length, 1, 'the main continuation action is present');
      for (const action of actions) {
        assert.equal(action.background, 'rgb(255, 107, 43)');
        assert.equal(action.color, 'rgb(35, 22, 15)');
      }
    });
  };
  const openPart = async family => {
    await cdp.evaluate("location.hash='#/pruefungsteile'");
    await cdp.waitFor("document.querySelector('[data-part-open=\"" + family + "\"]')?.getBoundingClientRect().height>0");
    await cdp.click('[data-part-open="' + family + '"]');
    await cdp.waitFor("document.querySelector('[data-runner-phase=answering] [data-answer-item]')");
  };
  const freshPreparation = async () => cdp.evaluate(`return (async()=>{
    const {api}=await import('/app/api.js'); const id=location.hash.match(/\\/prep\\/([^/]+)/)[1];
    const prior=await api.preparations.read(id); if(!prior.ok) throw Error('Synthetic preparation read failed');
    const archived=await api.preparations.update(id,prior.data.revision,{state:'archived'}); if(!archived.ok) throw Error('Synthetic archive failed');
    const created=await api.preparations.create(prior.data.exam_id); if(!created.ok) throw Error('Synthetic new preparation failed');
    return {active:created.data.id,archived:id};
  })()`);
  const dialogAction = async (expression, accept) => {
    const from = cdp.events.length;
    const pending = cdp.send('Runtime.evaluate', {expression, awaitPromise:false});
    let opening;
    for(let turn=0;turn<100;turn++){opening=cdp.events.slice(from).find(row=>row.method==='Page.javascriptDialogOpening');if(opening)break;await sleep(25);}
    assert.ok(opening,'native leave dialog opened'); assert.equal(opening.params.type,'confirm');
    await cdp.send('Page.handleJavaScriptDialog',{accept}); await pending;
    await sleep(250);
  };
  for (const [width, height, label, locale, theme] of cases.filter(row=>!selectedCase||row[2]===selectedCase)) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    const preparation = await freshPreparation();
    await cdp.send('Page.navigate', { url: base + '/app/?redesignFixture=' + label + '#/prep/' + preparation.active + '/heute' });
    await cdp.waitFor("document.querySelector('#account-email')?.textContent.includes('@')");
    await cdp.evaluate(`return (async()=>{ const core=await import('/assets/i18n/core.js'); core.setLocale('${locale}'); document.documentElement.dataset.theme='${theme}'; return true; })()`);
    await checkGoAction(label + ' dashboard', true);
    await shot(label + '-dashboard');
    await check(label+' report icon has a visible stroke and contrasting surface',async()=>{
      const flag=await cdp.evaluate("const icon=document.querySelector('#feedback-open svg'),style=getComputedStyle(icon),button=getComputedStyle(icon.parentElement);return {stroke:style.stroke,color:style.color,background:button.backgroundColor,width:icon.getBoundingClientRect().width};");
      assert.ok(flag.width>0);assert.notEqual(flag.stroke,'none');assert.notEqual(flag.color,flag.background);
    });
    for (const family of ['LV1', 'LV2', 'LV3', 'SB1', 'SB2', 'HV1']) {
      await openPart(family);
      await check(label + ' ' + family + ' task shape and no overflow', async () => {
        const actual = await cdp.evaluate("return {banks:document.querySelectorAll('[data-layout-bank]').length,pickers:document.querySelectorAll('.part-runner select[data-answer-item]').length,slots:document.querySelectorAll('[data-gap-open]').length,drill:!!document.querySelector('[data-runner-disclosure]'),overflow:document.documentElement.scrollWidth-innerWidth,raw:document.querySelector('.part-runner').innerText.includes('{21}')};");
        assert.ok(actual.overflow <= 1, 'horizontal overflow: ' + actual.overflow);
        if (['LV1', 'LV3', 'SB2'].includes(family)) { assert.equal(actual.banks, 1); assert.ok(actual.pickers >= 5); }
        if (family === 'SB1') { assert.ok(actual.slots >= 10, 'this viewport must show the authored inline letter'); assert.equal(actual.raw, false); }
      });
      if (family === 'SB1' && await cdp.evaluate("return !!document.querySelector('[data-gap-open]')")) {
        await cdp.click('[data-gap-open]');
        await check(label + ' inline gap keyboard focus and Escape', async () => {
          assert.equal(await cdp.evaluate("return document.activeElement.matches('.layout-gap-options input')"), true);
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
          assert.equal(await cdp.evaluate("return document.activeElement.matches('[data-gap-open]') && document.activeElement.getAttribute('aria-expanded')==='false'"), true);
        });
        await cdp.click('[data-gap-open]');
        await check(label + ' Enter chooses first gap option; arrows reach third without closing', async () => {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
          assert.equal(await cdp.evaluate("return document.querySelector('.layout-gap-options input').checked && document.activeElement.matches('[data-gap-open]')"), true);
          await cdp.click('[data-gap-open]');
          for (let index=0; index<2; index++) await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
          assert.equal(await cdp.evaluate("return document.activeElement===document.querySelectorAll('.layout-gap-options input')[2] && !document.querySelector('.layout-gap-options').hidden"), true);
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        });
      }
      if (family === 'LV1') await check(label + ' clearing a native picker clears the held choice', async () => {
        await cdp.evaluate("const node=document.querySelector('[data-answer-item]'); node.value=node.options[1].value;node.dispatchEvent(new Event('change',{bubbles:true})); node.value='';node.dispatchEvent(new Event('change',{bubbles:true}));");
        assert.equal(await cdp.evaluate("return document.querySelector('[data-runner-progress]').dataset.answered"), '0');
        assert.equal(await cdp.evaluate("return document.querySelector('[data-runner-evaluate]').disabled"), true);
      });
      if (family === 'LV1') await check(label + ' native route and preparation leave confirmations preserve picks', async () => {
        await cdp.evaluate("const pick=document.querySelector('[data-answer-item]');pick.value=pick.options[1].value;pick.dispatchEvent(new Event('change',{bubbles:true}));location.hash='#/pruefungsteile';");
        await sleep(250);
        assert.equal(await cdp.evaluate("return document.querySelector('[data-runner-progress]')?.dataset.answered"),'1');
        await dialogAction("location.hash='#/heute'",false);
        assert.equal(await cdp.evaluate("return document.querySelector('[data-runner-progress]')?.dataset.answered"),'1');
        if(width<500) await cdp.click('#mobile-exam-level');
        const picker=width<500?'mobile-preparation-picker':'preparation-picker';
        await dialogAction(`const pick=document.getElementById('${picker}');pick.value='${preparation.archived}';pick.dispatchEvent(new Event('change',{bubbles:true}));`,false);
        assert.equal(await cdp.evaluate(`return document.getElementById('${picker}').value`),preparation.active);
        assert.equal(await cdp.evaluate("return document.querySelector('[data-runner-progress]')?.dataset.answered"),'1');
        if(width<500) await cdp.click('#close-preparation-dialog');
        await dialogAction("location.hash='#/heute'",true);
        await cdp.waitFor("!document.querySelector('[data-part-runner]')");
        await openPart('LV1');
      });
      if (axeSource) await check(label + ' ' + family + ' answering axe', async () => {
        await cdp.send('Runtime.evaluate', { expression: axeSource });
        const result = await cdp.evaluate("return axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})");
        fs.writeFileSync(path.join(shots,label+'-'+family+'-axe-answering.json'),JSON.stringify(result));
        assert.ok(result.passes.length>0); assert.deepEqual(result.violations.map(row=>row.id+':'+row.nodes.map(node=>node.target.join(',')).join(';')),[]);
      });
      if(family==='LV2')await check(label+' item navigator focuses the selected native control',async()=>{
        await cdp.click('[data-item-navigator] button:nth-child(2)');
        assert.ok(await cdp.evaluate("return document.activeElement.matches('input[data-answer-item]') && document.activeElement.dataset.answerItem===document.querySelectorAll('[data-runner-jump]')[1].dataset.runnerJump"));
      });
      await shot(label + '-' + family.toLowerCase());
      // Input events change choices, never the rendered DOM, CSS or server answer key.
      await cdp.evaluate(`const groups = new Map(); for (const node of document.querySelectorAll('[data-answer-item]')) { if(!groups.has(node.dataset.answerItem)) groups.set(node.dataset.answerItem,node); } for(const node of groups.values()) { if(node.tagName==='SELECT') node.value=node.options[1].value; else node.checked=true; node.dispatchEvent(new Event('change',{bubbles:true})); }`);
      await cdp.click('[data-runner-evaluate]');
      await cdp.waitFor("document.querySelector('[data-runner-phase=review]')", 15000);
      await check(label + ' ' + family + ' server review, labels and focus', async () => {
        const actual = await cdp.evaluate("return {chosen:document.querySelectorAll('[data-option-marker=chosen]').length,key:document.querySelectorAll('[data-option-marker=key]').length,items:document.querySelectorAll('[data-review-item]').length,focused:document.activeElement.matches('[data-review-verdict]'),overflow:document.documentElement.scrollWidth-innerWidth,correct:Number(document.querySelector('[data-runner-result]').dataset.correct),count:document.querySelectorAll('[data-review-item][data-verdict=correct]').length};");
        assert.ok(actual.items > 0); assert.equal(actual.chosen, actual.items); assert.equal(actual.key, actual.items); assert.equal(actual.correct, actual.count); assert.equal(actual.focused, true); assert.ok(actual.overflow <= 1, 'horizontal overflow: ' + actual.overflow);
      });
      if(['LV2','HV1'].includes(family))await check(label+' '+family+' review navigator focuses the requested saved verdict',async()=>{
        assert.ok(await cdp.evaluate("const button=document.querySelector('[data-item-navigator] button:nth-child(2)');button.focus();button.click();return document.activeElement.matches('[data-review-verdict]') && document.activeElement.closest('[data-review-item]').dataset.reviewItem===button.dataset.runnerJump"));
      });
      await checkGoAction(label + ' ' + family + ' saved result', true);
      await shot(label + '-' + family.toLowerCase() + '-review');
      if(label==='desktop'&&family==='LV2') await check('real wrong-answer product capture candidates',async()=>{
        await cdp.evaluate("return (async()=>{const core=await import('/assets/i18n/core.js');core.setLocale('uk');})()");
        await cdp.evaluate("const language=document.querySelector('[data-runner-explanation-language]');language.value='uk';language.dispatchEvent(new Event('change',{bubbles:true}));");
        await cdp.waitFor("document.querySelector('[data-review-item]')?.innerText.includes('У першому абзаці')",15000);
        for(const [captureWidth,captureHeight,name]of [[1400,900,'product-wide-candidate'],[900,1200,'product-narrow-candidate'],[1200,630,'og-product-candidate']]){
          await cdp.send('Emulation.setDeviceMetricsOverride',{width:captureWidth,height:captureHeight,deviceScaleFactor:1,mobile:false});
          await cdp.evaluate("document.querySelector('[data-review-item]').scrollIntoView({block:'center'});"); await sleep(150);
          const value=await cdp.send('Page.captureScreenshot',{format:'jpeg',quality:65});const bytes=Buffer.from(value.data,'base64');
          assert.ok(bytes.length<200000,'product capture must stay below 200 KB');fs.writeFileSync(path.join(shots,name+'.jpg'),bytes);
          if(name.startsWith('product-')) {
            const webp=await cdp.send('Page.captureScreenshot',{format:'webp',quality:65});
            const pixels=Buffer.from(webp.data,'base64');assert.ok(pixels.length<200000);
            fs.writeFileSync(path.join(shots,name+'.webp'),pixels);
          }
        }
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
        await cdp.evaluate("return (async()=>{const core=await import('/assets/i18n/core.js');core.setLocale('de');})()");
        await cdp.evaluate("const language=document.querySelector('[data-runner-explanation-language]');language.value='de';language.dispatchEvent(new Event('change',{bubbles:true}));");
      });
      if (axeSource) await check(label + ' ' + family + ' review axe', async () => {
        const result = await cdp.evaluate("return axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})");
        fs.writeFileSync(path.join(shots,label+'-'+family+'-axe-review.json'),JSON.stringify(result));
        assert.ok(result.passes.length>0); assert.deepEqual(result.violations.map(row=>row.id+':'+row.nodes.map(node=>node.target.join(',')).join(';')),[]);
      });
      await cdp.click('[data-runner-action=index]');
      await cdp.waitFor("document.querySelector('[data-part-open]')");
    }
    await cdp.evaluate("location.hash='#/fehler'");
    await cdp.waitFor("document.querySelector('[data-mistake-card]')",15000);
    await check(label + ' contextual mistakes and exact owned-item retry',async()=>{
      const before = await cdp.evaluate("return (async()=>{ const {api}=await import('/app/api.js'); const result=await api.practice.mistakes();return result.data.items[0];})()");
      assert.ok(before.task?.options.length && before.evidence_id);
      const text=await cdp.evaluate("return document.querySelector('[data-mistake-card]').innerText");
      assert.ok(text.includes(before.task.prompt)||before.material?.letter);
      assert.ok(!text.includes(before.set_id)&&!text.includes('JSON.stringify'));
      assert.equal(await cdp.evaluate("return document.querySelectorAll('[data-mistake-card] .mistake-your').length>0 && document.querySelectorAll('[data-mistake-card] .mistake-key').length>0"),true);
      await shot(label+'-mistakes');
      await cdp.click('[data-mistake-retry="0"]');
      await cdp.waitFor("document.querySelector('[data-runner-phase=answering] [data-answer-item]')");
      assert.equal(await cdp.evaluate("return [...document.querySelectorAll('[data-answer-item]')].every(node=>node.dataset.answerItem==='"+before.item_id+"')"),true);
      assert.equal(await cdp.evaluate("return document.querySelectorAll('[data-option-marker=key]').length"),0);
      await check(label+' retry rejects substituted item and foreign context',async()=>{
        const results=await cdp.evaluate(`return (async()=>{const {api}=await import('/app/api.js');
          const opened=await api.practice.next('${before.family}','${before.evidence_id}');
          const id=opened.data.attempt.attempt_id;
          const wrong=await api.practice.check({attemptId:id,answers:[{item_id:'not-the-served-item',answer:'a'}]});
          const archived=await fetch('/api/v1/practice/next?preparationId=${preparation.archived}&family=${before.family}&evidenceId=${before.evidence_id}').then(r=>r.status);
          const missing=await api.practice.next('${before.family}','00000000-0000-4000-8000-000000000000');
          const malformed=await api.practice.next('${before.family}','not-a-uuid');
          const checked=await api.practice.check({attemptId:id,answers:[{item_id:'${before.item_id}',answer:${JSON.stringify(before.correct_answer)}}]});
          return {wrong:wrong.status,archived,missing:missing.status,malformed:malformed.status,checked:checked.ok,correct:checked.data?.correct_count};})()`);
        assert.deepEqual(results,{wrong:422,archived:409,missing:404,malformed:422,checked:true,correct:1});
      });
    });
    await cdp.send('Page.navigate',{url:base+'/app/#/prep/'+preparation.active+'/heute'});
    await cdp.waitFor("document.querySelector('#account-email')?.textContent.includes('@')");
    if(width>=390 && label!=='arabic-dark'){
      await cdp.evaluate("location.hash='#/ueben'");
      await cdp.waitFor("document.querySelector('[data-drill-phase=answering] [data-drill-option]')");
      await cdp.click('[data-drill-option]'); await cdp.click('[data-drill-check]');
      await cdp.waitFor("document.querySelector('[data-drill-phase=feedback]')");
      await check(label+' shared drill review tiles',async()=>{
        assert.ok(await cdp.evaluate("return document.querySelectorAll('[data-option-marker=chosen]').length>0 && document.querySelectorAll('[data-option-marker=key]').length>0"));
      });
      await shot(label+'-drill-review'); await scan(label+'-drill-review');
      await cdp.evaluate("location.hash='#/heute'"); await sleep(250);
      // The currently released section-mock catalogue supplies LV, not an HV-only form.
      // Boolean shared review is covered by focused renderer fixtures, without inventing a release.
      for(const mockSection of ['LV']){
      const runId=await cdp.evaluate(`return (async()=>{const {api}=await import('/app/api.js');const result=await api.mock.forms();
        const form=result.data.forms.find(row=>row.sections?.includes('${mockSection}')&&row.scope!=='complete_supported_written'&&!row.writing_task_count&&!row.writing_choice_count);
        if(!form)throw Error('No released ${mockSection} form for shared review check');
        const opened=await api.mock.start({formId:form.form_id,formVersion:form.version,releaseVersion:form.release_version,eventId:crypto.randomUUID()});
        if(!opened.ok)throw Error('Synthetic mock start failed '+opened.error);return opened.data.id;})()`);
      await cdp.evaluate("location.hash='#/lauf/"+runId+"'");
      await cdp.waitFor("document.querySelector('input[data-mock-answer]')");
      await cdp.click(mockSection==='HV'?'input[data-mock-answer][value=false]':'input[data-mock-answer]'); await sleep(300);
      await cdp.waitFor(`(async()=>{const {api}=await import('/app/api.js');const saved=await api.mock.read('${runId}');return saved.data.responses.some(row=>row.answer!==null);})()`);
      await cdp.waitFor("document.querySelector('[data-mock-action=confirm]:not([disabled])')");
      const finalised=await cdp.evaluate(`return (async()=>{const {api}=await import('/app/api.js');const current=await api.mock.read('${runId}');return api.mock.finalise('${runId}',{expectedRevision:current.data.revision,eventId:crypto.randomUUID(),explanationLanguage:'de'});})()`);
      assert.ok(finalised.ok,'Synthetic reading finalise: '+finalised.error);
      await cdp.send('Page.navigate',{url:base+'/app/?redesignMockReview='+label+'#/lauf/'+runId});
      try { await cdp.waitFor("document.querySelector('#mock-result [data-option-marker=key]')",15000); }
      catch(error){
        await shot(label+'-mock-debug');
        const debug=await cdp.evaluate(`return (async()=>{const {api}=await import('/app/api.js');const read=await api.mock.read('${runId}');return {hash:location.hash,text:document.querySelector('main')?.innerText.slice(0,1200),state:read.data?.state,results:read.data?.result?.items.slice(0,2),responses:read.data?.responses.slice(0,2)};})()`);
        fs.writeFileSync(path.join(shots,'mock-debug.json'),JSON.stringify(debug,null,2));
        console.log('MOCK DEBUG '+JSON.stringify({hash:debug.hash,state:debug.state,text:debug.text})); throw error;
      }
      await cdp.evaluate(`return (async()=>{ const core=await import('/assets/i18n/core.js');core.setLocale('${locale}');document.documentElement.dataset.theme='${theme}'; })()`);
      await check(label+' '+mockSection+' finalised mock shares locked answer tiles',async()=>{
        assert.ok(await cdp.evaluate("return document.querySelectorAll('#mock-result .answer-tile input').length>0 && [...document.querySelectorAll('#mock-result .answer-tile input')].every(node=>node.disabled) && document.querySelectorAll('#mock-result [data-option-marker=chosen]').length>0"));
      });
      await shot(label+'-'+mockSection+'-mock-review'); await scan(label+'-'+mockSection+'-mock-review');
      await cdp.evaluate("document.querySelector('#mock-result [data-review-item]').scrollIntoView({block:'start'});");
      await shot(label+'-'+mockSection+'-mock-review-tiles');
      const flagDetails=await cdp.evaluate("const svg=document.querySelector('#feedback-open svg'),path=svg.querySelector('path'),a=getComputedStyle(svg),b=getComputedStyle(path),rect=svg.getBoundingClientRect(),box=path.getBBox();return {color:a.color,stroke:a.stroke,pathStroke:b.stroke,strokeWidth:b.strokeWidth,display:a.display,visibility:a.visibility,opacity:a.opacity,width:rect.width,height:rect.height,bbox:{width:box.width,height:box.height},viewBox:svg.getAttribute('viewBox'),path:path.getAttribute('d')};");
      fs.writeFileSync(path.join(shots,label+'-mock-flag.json'),JSON.stringify(flagDetails,null,2));
      await check(label+' mock header report icon retains visible geometry',async()=>{
        assert.ok(flagDetails.width>=18&&flagDetails.height>=18);assert.notEqual(flagDetails.pathStroke,'none');
        if(width<500)assert.equal(flagDetails.pathStroke,'rgb(246, 248, 252)');
      });
      }
    }
    await cdp.evaluate("location.hash='#/mehr'"); await cdp.waitFor("!document.querySelector('#view-mehr').hidden");
    await shot(label+'-more');await scan(label+'-more');
  }
  for(const width of [1280,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});
    await cdp.send('Page.navigate',{url:base+'/'}); await cdp.waitFor("document.querySelector('#hero-start')"); await sleep(300);
    await checkGoAction(width + ' public start', true);
    await shot(width+'-landing'); await scan(width+'-landing');
    await cdp.send('Page.navigate',{url:base+'/signin'}); await cdp.waitFor("document.querySelector('#form-signin')"); await sleep(300);
    await shot(width+'-auth'); await scan(width+'-auth');
  }
  console.log(`${passes} passed, ${failures} failed. Screenshots: ${shots}`);
  fs.writeFileSync(path.join(shots, 'receipt.json'), JSON.stringify({ sourceRoot, passes, failures, physicalDevices: false }, null, 2));
  process.exitCode = failures ? 1 : 0;
} finally {
  if (cdp) cdp.ws.close(); if (browser) await browser.cleanup();
  if (started) { verify(); compose(['down', '-v', '--remove-orphans', '--rmi', 'local']); verifyBrowserCleanup(project, command); }
  const resolved = path.resolve(scratch); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith(project)); fs.rmSync(resolved, { recursive: true, force: true });
}
