/** S1 learner evidence. Invoked only by the disposable Compose/browser harness; no CLI or live URL mode. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';

export async function verifyExamS1({ base, email, password, freePort, record, shot, viewport, theme,
  nav, setInputs, clickSel, overflow, query, preparationFixtures = null }) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
      || !origin.port || ['4300', '55440'].includes(origin.port) || origin.origin !== base
      || !/^browser-\d+@example\.test$/.test(email) || typeof query !== 'function') {
    throw new Error('EXAM-S1 requires disposable loopback ports, a synthetic account and the harness SQL callback');
  }
  for (const callback of [freePort, record, shot, viewport, theme, nav, setInputs, clickSel, overflow]) {
    if (typeof callback !== 'function') throw new Error('EXAM-S1 requires the complete supplied browser harness');
  }
  // An optional second package must be installed by the coordinator's disposable SQL fixture.
  // This helper neither publishes DTZ nor invents learner preparations in intercepted responses.
  if (preparationFixtures !== null && typeof preparationFixtures !== 'function') throw new Error('Invalid S1 fixture callback');
  const port = await freePort(), browser = await launchBrowser(port);
  let cdp, originalSettings, originalPreparation, request, stopIntercept, fixtureCleanup;
  const run = async (name, action) => {
    try { await action(); } catch (error) { record(name, false, error.message); }
    finally { if (stopIntercept) await stopIntercept(); }
  };
  const hook = async (pattern, handler) => {
    let failure;
    const pending = new Map();
    const finish = async (event, method, extra = {}) => {
      if (!pending.has(event.requestId)) return;
      pending.delete(event.requestId);
      await cdp.send(method, { requestId: event.requestId, ...extra });
    };
    const controls = {
      proceed: event => finish(event, 'Fetch.continueRequest'),
      reply: (event, status, data) => finish(event, 'Fetch.fulfillRequest', { responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(data)).toString('base64') }),
    };
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Fetch.requestPaused') return;
      pending.set(message.params.requestId, message.params);
      Promise.resolve(handler(message.params, controls)).catch(async error => {
        failure = error.message;
        try { await controls.proceed(message.params); } catch { /* cleanup releases it */ }
      });
    };
    cdp.ws.addEventListener('message', listener);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
    stopIntercept = async () => {
      cdp.ws.removeEventListener('message', listener);
      for (const pendingEvent of pending.values()) { try { await controls.proceed(pendingEvent); } catch {} }
      await cdp.send('Fetch.disable');
      stopIntercept = null;
      if (failure) record('S1 request interception', false, failure);
    };
  };
  const fresh = async hash => {
    const token = randomUUID();
    await cdp.evaluate(`window.__s1Document=${JSON.stringify(token)}; return true;`);
    const navigation = await cdp.send('Page.navigate', { url: base + '/app/' + hash });
    if (!navigation.loaderId) await cdp.send('Page.reload', {});
    await cdp.waitFor(`window.__s1Document !== ${JSON.stringify(token)} && document.readyState === 'complete'`, 20000);
  };
  const go = async view => {
    await cdp.evaluate(`location.hash=${JSON.stringify('#/' + view)}; return true;`);
    await cdp.waitFor(`location.hash.startsWith('#/prep/') && location.hash.endsWith('/${view}') && document.querySelector('#view-${view}') && !document.querySelector('#view-${view}').hidden`);
  };
  const requestsSince = mark => cdp.events.slice(mark).filter(event => event.method === 'Network.requestWillBeSent').map(event => event.params.request);
  const paused = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('S1 delayed request did not reach interception')), 12000);
    })]); } finally { clearTimeout(timer); }
  };
  const responseFinished = async event => {
    if (!event.networkId) throw new Error('S1 delayed request has no Network correlation ID');
    const until = Date.now() + 12000;
    while (!cdp.events.some(item => item.method === 'Network.loadingFinished' && item.params.requestId === event.networkId)) {
      if (Date.now() >= until) throw new Error('S1 delayed response did not finish');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await cdp.evaluate('return new Promise(resolve=>requestAnimationFrame(()=>resolve(true)));');
  };
  // Resolve after the app has received the hashchange, so a held response is never released before
  // the new navigation is actually queued. CDP.evaluate wraps a synchronous function and awaits returns.
  const changeHash = hash => cdp.evaluate(`return new Promise(resolve=>{
    if(location.hash===${JSON.stringify(hash)}) { resolve(true); return; }
    window.addEventListener('hashchange',()=>resolve(true),{once:true});
    location.hash=${JSON.stringify(hash)};
  });`);
  const ready = () => cdp.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value", 15000);
  const select = async id => {
    await cdp.evaluate(`const picker=document.querySelector('#preparation-picker'); picker.value=${JSON.stringify(id)}; picker.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
    await cdp.waitFor(`document.querySelector('#preparation-picker').value===${JSON.stringify(id)} && !document.querySelector('#preparation-picker').disabled && location.hash.includes(${JSON.stringify(id)})`, 15000);
  };
  try {
    cdp = await connectToPage(port);
    await cdp.send('Network.enable');
    await viewport(cdp, 1440, 900, false); await theme(cdp, 'light');
    await nav(cdp, base + '/signin');
    await setInputs(cdp, { 'si-email': email, 'si-password': password }); await clickSel(cdp, '#si-submit');
    await ready();
    request = async (route, method = 'GET', body) => cdp.evaluate(`return (async()=>{const response=await fetch(${JSON.stringify(route)}, {
      method:${JSON.stringify(method)}, credentials:'same-origin', headers:{'content-type':'application/json'},
      ${body === undefined ? '' : 'body:' + JSON.stringify(JSON.stringify(body)) + ','}
    }); let data=null; try { data=await response.json(); } catch {} return {status:response.status,data};})()`);
    const preparationId = await cdp.evaluate("return document.querySelector('#preparation-picker').value");
    const prepPath = '/api/v1/preparations/' + preparationId;
    const preparation = await request(prepPath), settings = await request('/api/v1/settings');
    if (preparation.status !== 200 || settings.status !== 200) throw new Error('S1 synthetic preparation precondition failed');
    originalPreparation = preparation.data; originalSettings = settings.data.settings;

    await run('S1B1 single-exam bootstrap', async () => {
      const mark = cdp.events.length;
      await fresh('#/heute'); await ready();
      const requests = requestsSince(mark);
      const scopeReads = requests.filter(r => /\/api\/v1\/(tasks|objective-sets|practice\/|attempts)/.test(new URL(r.url).pathname));
      record('S1B1 sole exam resumes without chooser and every practice read is preparation-scoped',
        await cdp.evaluate("return document.querySelector('#preparation-choice').hidden && document.querySelector('#boot-state').hidden && !!document.querySelector('#preparation-exam').textContent")
        && scopeReads.length > 0 && scopeReads.every(r => new URL(r.url).searchParams.get('preparationId') === preparationId));
      await shot(cdp, 's1-preparation-desktop');
    });

    await run('S1B2 preparation load failure and retry', async () => {
      let refused = false;
      await hook('*/api/v1/preparations*', async (event, controls) => {
        if (!refused && event.request.method === 'GET' && new URL(event.request.url).pathname === '/api/v1/preparations') {
          refused = true; await controls.reply(event, 503, { error: 'synthetic_preparation_unavailable' });
        } else await controls.proceed(event);
      });
      const mark = cdp.events.length;
      await fresh('#/ueben');
      await cdp.waitFor("!document.querySelector('#boot-retry').hidden", 12000);
      const loader = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
      const scoped = cdp.events.slice(mark).filter(e => e.method === 'Network.requestWillBeSent' && e.params.loaderId === loader)
        .some(e => /\/api\/v1\/(tasks|objective-sets|practice\/|attempts)/.test(new URL(e.params.request.url).pathname));
      record('S1B2 failed preparation keeps practice locked', !scoped && await cdp.evaluate("return document.querySelector('#app-shell').hidden && document.querySelector('#app-shell').inert"));
      await shot(cdp, 's1-preparation-recovery');
      await clickSel(cdp, '#boot-retry'); await ready();
      await cdp.waitFor("document.querySelector('#task-list [data-open]')");
      record('S1B3 retry opens the retained catalogue destination', await cdp.evaluate("return !document.querySelector('#view-ueben').hidden && !document.querySelector('#skill-ueben-catalogue').hidden"));
    });

    await run('S1B4 preparation date and global language', async () => {
      await go('einstellungen');
      await setInputs(cdp, { examDate: '2030-06-15', language: 'tr' });
      const mark = cdp.events.length;
      await clickSel(cdp, '#save-settings');
      await cdp.waitFor("document.querySelector('#settings-state').textContent==='Gespeichert.'", 12000);
      const savedPrep = await request(prepPath), savedSettings = await request('/api/v1/settings');
      const settingsWrites = requestsSince(mark).filter(r => r.method === 'PUT' && new URL(r.url).pathname === '/api/v1/settings');
      record('S1B4 date belongs to preparation and language remains global', savedPrep.data.exam_date === '2030-06-15'
        && savedSettings.data.settings.language === 'tr' && settingsWrites.length === 1
        && !Object.hasOwn(JSON.parse(settingsWrites[0].postData).settings, 'examDate'));
      await fresh('#/einstellungen'); await ready();
      record('S1B5 reload retains preparation date and language', await cdp.evaluate("return document.querySelector('#examDate').value==='2030-06-15' && document.querySelector('#language').value==='tr' && document.querySelector('#exam-countdown').textContent.includes('15')"));
    });

    await run('S1B6 catalogue launch close and re-entry', async () => {
      await go('ueben'); await cdp.waitFor("document.querySelector('#task-list [data-open]')");
      const mark = cdp.events.length;
      await clickSel(cdp, '#task-list [data-open]');
      await cdp.waitFor("document.querySelector('#ueben-practice [data-answer]')");
      await clickSel(cdp, '#ueben-practice [data-answer]');
      await cdp.waitFor("/Richtig|Noch nicht richtig/.test(document.querySelector('#ueben-practice .result').textContent)");
      const answers = requestsSince(mark).filter(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/answers'));
      record('S1B6 catalogue answer is bound to preparation and exact version', answers.length === 1
        && JSON.parse(answers[0].postData).preparationId === preparationId && Boolean(JSON.parse(answers[0].postData).version));
      await clickSel(cdp, '#practice-close');
      record('S1B7 close restores the visible catalogue', await cdp.evaluate("return !document.querySelector('#skill-ueben-catalogue').hidden && document.querySelector('#task-list').getClientRects().length>0"));
      await clickSel(cdp, '#task-list [data-open]'); await cdp.waitFor("document.querySelector('#ueben-practice [data-answer]')");
      await go('fortschritt'); await go('ueben'); await cdp.waitFor("document.querySelector('#task-list [data-write]')");
      record('S1B8 re-entry restores the catalogue wrapper', await cdp.evaluate("return !document.querySelector('#skill-ueben-catalogue').hidden && document.querySelector('#ueben-practice').hidden && document.querySelector('#task-list').getClientRects().length>0"));
      await shot(cdp, 's1-direct-catalogue');
    });

    await run('S1B9 durable writing resume and scoped history', async () => {
      await go('ueben'); await cdp.waitFor("document.querySelector('#task-list [data-write]')");
      const binding = await cdp.evaluate("const button=document.querySelector('#task-list [data-write]'); return {task:button.dataset.write,version:button.dataset.version};");
      await clickSel(cdp, '#task-list [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')");
      const text = 'Liebe Anna, dieser synthetische S1-Text bleibt beim Wechsel erhalten. Viele Grüße ' + randomUUID();
      await setInputs(cdp, { 'writing-text': text });
      await go('fortschritt');
      await cdp.waitFor("document.querySelector('#history-list [data-attempt]')");
      const attempts = await request('/api/v1/attempts?open=1&preparationId=' + preparationId);
      const candidate = attempts.data.attempts?.find(a => a.task_id === binding.task && a.task_version === binding.version);
      if (!candidate) throw new Error('Saved S1 draft not found');
      const saved = await request('/api/v1/attempts/' + candidate.id);
      record('S1B9 leaving writing saves the selected preparation draft', saved.data.text === text);
      const mark = cdp.events.length;
      await fresh('#/prep/' + preparationId + '/fortschritt'); await ready();
      await cdp.waitFor(`document.querySelector('[data-attempt="${candidate.id}"]')`);
      await clickSel(cdp, `[data-attempt="${candidate.id}"]`); await cdp.waitFor("document.querySelector('#writing-text')");
      const history = requestsSince(mark).filter(r => new URL(r.url).pathname === '/api/v1/attempts' && r.method === 'GET');
      record('S1B10 reload resumes saved text and history stays preparation-scoped', history.length > 0
        && history.every(r => new URL(r.url).searchParams.get('preparationId') === preparationId)
        && await cdp.evaluate(`return document.querySelector('#writing-text').value===${JSON.stringify(text)}`));
      const credits = await request(prepPath + '/credits');
      record('S1B11 displayed credits match the selected exam', credits.status === 200 && credits.data.examId === originalPreparation.exam_id
        && await cdp.evaluate(`return document.querySelector('#preparation-credits').textContent.includes(${JSON.stringify(credits.data.available + ' verfügbar')})`));
    });

    await run('S1 date conflict preserves inputs', async () => {
      await go('einstellungen');
      const current = await request(prepPath);
      await hook('*' + prepPath, async (event, controls) => {
        if (event.request.method === 'PUT') await controls.reply(event, 409, { error: 'preparation_conflict', current: current.data });
        else await controls.proceed(event);
      });
      await setInputs(cdp, { examDate: '2031-07-16', language: 'uk' });
      await clickSel(cdp, '#save-settings');
      await cdp.waitFor("document.querySelector('#settings-reload')");
      record('S1 conflicting date never silently replaces unsaved form choices', await cdp.evaluate("return document.querySelector('#examDate').value==='2031-07-16' && document.querySelector('#language').value==='uk' && document.querySelector('#settings-state').textContent.includes('woanders')"));
      await clickSel(cdp, '#settings-reload');
      await cdp.waitFor("document.querySelector('#settings-state').textContent.includes('auf deinen Wunsch')");
    });

    await run('S1 partial settings failure is explicit', async () => {
      await hook('*/api/v1/settings', async (event, controls) => {
        if (event.request.method === 'PUT') await controls.reply(event, 503, { error: 'synthetic_settings_unavailable' });
        else await controls.proceed(event);
      });
      await setInputs(cdp, { examDate: '2031-07-16', language: 'uk' });
      await clickSel(cdp, '#save-settings');
      await cdp.waitFor("document.querySelector('#settings-reload')");
      const prep = await request(prepPath);
      record('S1 partial save reports committed date and retains unsaved language', prep.data.exam_date === '2031-07-16'
        && await cdp.evaluate("return document.querySelector('#language').value==='uk' && document.querySelector('#settings-state').textContent.includes('Prüfungsdatum ist gespeichert')"));
      await clickSel(cdp, '#settings-reload');
      await cdp.waitFor("document.querySelector('#settings-state').textContent.includes('auf deinen Wunsch')");
    });

    if (preparationFixtures) {
      // The coordinator supplies { otherPreparationId, cleanup? } after seeding through its own query.
      const fixture = await preparationFixtures({ query, email, preparationId });
      fixtureCleanup = fixture?.cleanup;
      if (!/^[0-9a-f-]{36}$/i.test(fixture?.otherPreparationId || '')) throw new Error('S1 second-preparation fixture missing');
      const other = fixture.otherPreparationId;
      await fresh('#/prep/' + preparationId + '/heute'); await ready();
      await run('S1 settings recovery belongs only to its original form context', async () => {
        await go('einstellungen');
        const current = await request(prepPath), otherPrep = await request('/api/v1/preparations/' + other);
        let holdRecovery = false, held = false, receive;
        const recoveryRead = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/preparations/*', async (event, controls) => {
          const path = new URL(event.request.url).pathname;
          if (path === prepPath && event.request.method === 'PUT') {
            await controls.reply(event, 409, { error: 'preparation_conflict', current: current.data });
          } else if (path === prepPath && event.request.method === 'GET' && holdRecovery && !held) {
            held = true; receive({ event, controls });
          } else await controls.proceed(event);
        });
        await setInputs(cdp, { examDate: '2032-08-17', language: 'en' });
        await clickSel(cdp, '#save-settings');
        await cdp.waitFor("document.querySelector('#settings-reload') && !document.querySelector('#preparation-picker').disabled");
        record('S1 conflict retains unsaved choices until an explicit recovery or context choice', await cdp.evaluate("return document.querySelector('#examDate').value==='2032-08-17' && document.querySelector('#language').value==='en'"));
        holdRecovery = true;
        await clickSel(cdp, '#settings-reload');
        const delayed = await paused(recoveryRead);
        await select(other);
        record('S1 successful context switch retires the previous settings recovery action', await cdp.evaluate("return !document.querySelector('#settings-reload') && document.querySelector('#settings-state').textContent===''") );
        await delayed.controls.proceed(delayed.event);
        await responseFinished(delayed.event);
        // An explicit scoped view read also proves the API transport selection agrees with the picker.
        const mark = cdp.events.length;
        await go('einstellungen'); await go('fortschritt');
        await cdp.waitFor("!document.querySelector('#history-list').textContent.includes('wird geladen')");
        await cdp.waitFor(`document.querySelector('#preparation-credits').textContent.includes(${JSON.stringify(otherPrep.data.exam)})`);
        const reads = requestsSince(mark).filter(r => new URL(r.url).pathname === '/api/v1/attempts');
        record('S1 late recovery response cannot replace picker, route, credit or API context', reads.length > 0
          && reads.every(r => new URL(r.url).searchParams.get('preparationId') === other)
          && await cdp.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(other)}
            && location.hash===${JSON.stringify('#/prep/' + other + '/fortschritt')}
            && document.querySelector('#preparation-exam').textContent===${JSON.stringify(otherPrep.data.exam)}
            && document.querySelector('#preparation-credits').textContent.includes(${JSON.stringify(otherPrep.data.exam)})
            && !document.querySelector('#settings-state').textContent.includes('auf deinen Wunsch')`));
        await shot(cdp, 's1-settings-recovery-after-switch');
        await select(preparationId);
      });

      await run('S1 latest deep link survives a delayed autosave', async () => {
        await fresh('#/prep/' + preparationId + '/ueben'); await ready();
        await cdp.waitFor("document.querySelector('#task-list [data-write]')");
        const binding = await cdp.evaluate("const button=document.querySelector('#task-list [data-write]'); return {task:button.dataset.write,version:button.dataset.version};");
        await clickSel(cdp, '#task-list [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')");
        let held = false, receive;
        const autosave = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/attempts/*', async (event, controls) => {
          if (!held && event.request.method === 'PUT') { held = true; receive({ event, controls }); }
          else await controls.proceed(event);
        });
        const text = 'Synthetischer Text vor zwei schnellen Navigationen ' + randomUUID();
        await setInputs(cdp, { 'writing-text': text });
        await changeHash('#/prep/' + other + '/fortschritt');
        const delayed = await paused(autosave);
        await cdp.waitFor("document.querySelector('#preparation-picker').disabled");
        await changeHash('#/prep/' + preparationId + '/einstellungen');
        const mark = cdp.events.length;
        await delayed.controls.proceed(delayed.event);
        await cdp.waitFor(`location.hash===${JSON.stringify('#/prep/' + preparationId + '/einstellungen')}
          && document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)}
          && !document.querySelector('#preparation-picker').disabled && !document.querySelector('#view-einstellungen').hidden`, 15000);
        const attempts = await request('/api/v1/attempts?open=1&preparationId=' + preparationId);
        const draft = attempts.data.attempts?.find(a => a.task_id === binding.task && a.task_version === binding.version);
        const saved = draft && await request('/api/v1/attempts/' + draft.id);
        const scopeReads = requestsSince(mark).filter(r => /\/api\/v1\/(tasks|objective-sets|practice\/|attempts$)/.test(new URL(r.url).pathname));
        record('S1 latest queued deep link wins after saving the original draft without intermediate context reads', saved?.status === 200 && saved.data.text === text
          && scopeReads.every(r => new URL(r.url).searchParams.get('preparationId') === preparationId));
        await shot(cdp, 's1-navigation-latest-destination');
      });

      await run('S1 browser history wins over an obsolete failed preparation read', async () => {
        await fresh('#/prep/' + preparationId + '/heute'); await ready();
        await go('ueben'); await cdp.waitFor("document.querySelector('#task-list [data-open]')");
        let held = false, receive;
        const prepRead = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/preparations/' + other, async (event, controls) => {
          if (!held && event.request.method === 'GET') { held = true; receive({ event, controls }); }
          else await controls.proceed(event);
        });
        await changeHash('#/prep/' + other + '/fortschritt');
        const delayed = await paused(prepRead);
        await cdp.evaluate("return new Promise(resolve=>{window.addEventListener('hashchange',()=>resolve(true),{once:true}); history.go(-2);});");
        await delayed.controls.reply(delayed.event, 503, { error: 'synthetic_obsolete_preparation_read' });
        await cdp.waitFor(`location.hash===${JSON.stringify('#/prep/' + preparationId + '/heute')}
          && document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)}
          && !document.querySelector('#preparation-picker').disabled && !document.querySelector('#view-heute').hidden`, 15000);
        record('S1 queued back navigation survives an obsolete read failure', await cdp.evaluate("return document.querySelector('#preparation-state').textContent===''") );
      });

      await run('S1 switch waits for a successful draft save', async () => {
        await go('ueben'); await cdp.waitFor("document.querySelector('#task-list [data-write]')");
        const binding = await cdp.evaluate("const button=document.querySelector('#task-list [data-write]'); return {task:button.dataset.write,version:button.dataset.version};");
        await clickSel(cdp, '#task-list [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')");
        let held = false, receive;
        const failedSave = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/attempts/*', async (event, controls) => {
          if (!held && event.request.method === 'PUT') { held = true; receive({ event, controls }); }
          else if (event.request.method === 'PUT') await controls.reply(event, 503, { error: 'synthetic_save_unavailable' });
          else await controls.proceed(event);
        });
        const text = 'Synthetischer Text vor dem Vorbereitungswechsel ' + randomUUID();
        await setInputs(cdp, { 'writing-text': text });
        await cdp.evaluate(`const picker=document.querySelector('#preparation-picker'); picker.value=${JSON.stringify(other)}; picker.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
        const delayed = await paused(failedSave);
        await changeHash('#/prep/' + preparationId + '/einstellungen');
        await delayed.controls.reply(delayed.event, 503, { error: 'synthetic_save_unavailable' });
        await cdp.waitFor("document.querySelector('#preparation-state').textContent.includes('angehalten') && !document.querySelector('#preparation-picker').disabled", 12000);
        record('S1 failed autosave drops queued navigation and preserves the original context and visible draft', await cdp.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)} && location.hash===${JSON.stringify('#/prep/' + preparationId + '/ueben')} && !document.querySelector('#view-ueben').hidden && document.querySelector('#writing-text').value===${JSON.stringify(text)}`));
        await shot(cdp, 's1-switch-unsaved-recovery');
        await stopIntercept();
        await select(other);
        const attempts = await request('/api/v1/attempts?open=1&preparationId=' + preparationId);
        const draft = attempts.data.attempts?.find(a => a.task_id === binding.task && a.task_version === binding.version);
        const saved = draft && await request('/api/v1/attempts/' + draft.id);
        record('S1 successful switch saves text under its original preparation', saved?.status === 200 && saved.data.text === text);
        await select(preparationId);
      });
      await run('S1B12 switch and read-only archive', async () => {
        const before = await request(prepPath + '/credits');
        await select(other);
        const selected = await request('/api/v1/preparations/' + other);
        record('S1B12 explicit switch selects the owned fixture context', selected.status === 200
          && await cdp.evaluate(`return document.querySelector('#preparation-exam').textContent===${JSON.stringify(selected.data.exam)}`));
        const otherCredits = await request('/api/v1/preparations/' + other + '/credits');
        const after = await request(prepPath + '/credits');
        record('S1 switching displays the other exam balance without transfer or refill', otherCredits.status === 200
          && otherCredits.data.examId === selected.data.exam_id && JSON.stringify(before.data) === JSON.stringify(after.data));
        if (selected.data.state === 'archived') {
          await go('ueben');
          record('S1B13 archive exposes history without new practice controls', await cdp.evaluate("return !document.querySelector('#task-list [data-open],#task-list [data-write]') && document.querySelector('#task-list').textContent.includes('archiviert')"));
        }
        await select(preparationId);
      });
    } else {
      record('S1 second-preparation fixture supplied for switching acceptance', false, 'PENDING coordinator-owned disposable second-package fixture; this leg is not a pass');
    }

    for (const width of [390, 320]) {
      await run('S1 mobile ' + width, async () => {
        await go('ueben'); await cdp.waitFor("document.querySelector('#task-list [data-open]')");
        await viewport(cdp, width, 844, true);
        for (const mode of ['light', 'dark']) {
          await theme(cdp, mode);
          record(`S1 ${width}px ${mode} preparation and catalogue fit`, (await overflow(cdp)).offenderCount === 0);
          await shot(cdp, `s1-preparation-${width}-${mode}`);
        }
      });
    }
  } finally {
    if (stopIntercept) { try { await stopIntercept(); } catch {} }
    try {
      if (request && originalPreparation && originalSettings) {
        const path = '/api/v1/preparations/' + originalPreparation.id;
        const prep = await request(path), settings = await request('/api/v1/settings');
        const restoredPrep = prep.status === 200 && await request(path, 'PUT', { expectedRevision: prep.data.revision, examDate: originalPreparation.exam_date });
        const restoredSettings = settings.status === 200 && await request('/api/v1/settings', 'PUT', { expectedRevision: settings.data.revision,
          settings: { language: originalSettings.language, ...(originalSettings.theme ? { theme: originalSettings.theme } : {}) } });
        record('S1 restores synthetic preparation date and account preferences', restoredPrep?.status === 200 && restoredSettings?.status === 200);
      }
      if (typeof fixtureCleanup === 'function') await fixtureCleanup();
    } catch (error) { record('S1 synthetic cleanup', false, error.message); }
    finally { if (cdp) cdp.ws.close(); await browser.cleanup(); }
  }
}
