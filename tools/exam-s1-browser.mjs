/** S1 learner evidence. Invoked only by the disposable Compose/browser harness; no CLI or live URL mode. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';
import { shellMessages } from '../public/assets/i18n/shell-messages.js';

// Compare visible messages in the confirmed interface language, including deliberate tr/uk switches.
const shellText = (selector, key, parameters = {}) => {
  const values = Object.fromEntries(Object.entries(shellMessages).map(([locale, messages]) => [locale,
    String(messages[key] ?? '').replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(parameters, name) ? String(parameters[name]) : match)]));
  return `(()=>{const node=document.querySelector(${JSON.stringify(selector)});const expected=${JSON.stringify(values)}[document.documentElement.lang];return Boolean(expected&&node&&node.getBoundingClientRect().height>0&&node.textContent.includes(expected));})()`;
};

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
    // A new query forces a new document before the old page can rewrite a hash-only destination.
    const navigation = await cdp.send('Page.navigate', { url: base + '/app/?s1Probe=' + token + hash });
    if (!navigation.loaderId) throw new Error('S1 fresh navigation did not create a document');
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
        await cdp.evaluate("return document.querySelector('#preparation-choice').hidden && document.querySelector('#boot-state').hidden && !!document.querySelector('#sidebar-exam').textContent")
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
      await cdp.waitFor("document.querySelector('#drill-host [data-drill-phase=answering] [data-drill-option]')");
      record('S1B3 retry opens the retained practice destination', await cdp.evaluate("return !document.querySelector('#view-ueben').hidden && document.querySelector('#drill-host [data-drill-item]').getBoundingClientRect().height>0"));
    });

    await run('S1B4 preparation date and global language', async () => {
      await go('einstellungen');
      await setInputs(cdp, { examDate: '2030-06-15', language: 'tr' });
      const mark = cdp.events.length;
      await clickSel(cdp, '#save-settings');
      await cdp.waitFor(shellText('#settings-state', 'm196'), 12000);
      const savedPrep = await request(prepPath), savedSettings = await request('/api/v1/settings');
      const settingsWrites = requestsSince(mark).filter(r => r.method === 'PUT' && new URL(r.url).pathname === '/api/v1/settings');
      record('S1B4 date belongs to preparation and language remains global', savedPrep.data.exam_date === '2030-06-15'
        && savedSettings.data.settings.language === 'tr' && settingsWrites.length === 1
        && !Object.hasOwn(JSON.parse(settingsWrites[0].postData).settings, 'examDate'));
      await fresh('#/einstellungen'); await ready();
      record('S1B5 reload retains preparation date and language', await cdp.evaluate("return document.querySelector('#examDate').value==='2030-06-15' && document.querySelector('#language').value==='tr' && document.querySelector('#exam-countdown').textContent.includes('15')"));
    });

    await run('S1B6 scoped drill answer and route re-entry', async () => {
      const mark = cdp.events.length;
      await go('ueben'); await cdp.waitFor("document.querySelector('#drill-host [data-drill-option]')");
      const next = cdp.events.slice(mark).find(event => event.method === 'Network.responseReceived'
        && new URL(event.params.response.url).pathname === '/api/v1/practice/drill/next');
      if (!next) throw new Error('Scoped drill response was not observed');
      const body = await cdp.send('Network.getResponseBody', { requestId: next.params.requestId });
      const served = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body);
      await clickSel(cdp, '#drill-host [data-drill-option]');
      await clickSel(cdp, '#drill-host [data-drill-check]');
      await cdp.waitFor("document.querySelector('#drill-host [data-drill-feedback]')");
      const answers = requestsSince(mark).filter(r => r.method === 'POST' && new URL(r.url).pathname === '/api/v1/practice/drill/check');
      const sent = answers.length === 1 ? JSON.parse(answers[0].postData) : null;
      record('S1B6 drill answer is bound to the selected preparation and exact served sitting', Boolean(sent)
        && sent.preparationId === preparationId && sent.attemptId === served.attempt?.attempt_id
        && sent.itemId === served.item?.item_id && Boolean(served.set?.version));
      await go('verlauf');
      record('S1B7 leaving practice removes the previous answering surface', await cdp.evaluate("return document.querySelector('#view-ueben').hidden && !document.querySelector('#drill-host [data-drill-option]')"));
      await go('ueben'); await cdp.waitFor("document.querySelector('#drill-host [data-drill-option]')");
      record('S1B8 re-entry presents a visible current drill', await cdp.evaluate("return !document.querySelector('#view-ueben').hidden && document.querySelector('#drill-host [data-drill-item]').getBoundingClientRect().height>0"));
      await shot(cdp, 's1-current-drill');
    });

    await run('S1B9 durable writing resume and scoped history', async () => {
      await go('schreiben'); await cdp.waitFor("document.querySelector('#skill-schreiben [data-write]')");
      const binding = await cdp.evaluate("const button=document.querySelector('#skill-schreiben [data-write]'); return {task:button.dataset.write,version:button.dataset.version};");
      await clickSel(cdp, '#skill-schreiben [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')");
      const text = 'Liebe Anna, dieser synthetische S1-Text bleibt beim Wechsel erhalten. Viele Grüße ' + randomUUID();
      await setInputs(cdp, { 'writing-text': text });
      await go('verlauf');
      await cdp.waitFor("document.querySelector('#history-list [data-attempt]')");
      const attempts = await request('/api/v1/attempts?open=1&preparationId=' + preparationId);
      const candidate = attempts.data.attempts?.find(a => a.task_id === binding.task && a.task_version === binding.version);
      if (!candidate) throw new Error('Saved S1 draft not found');
      const saved = await request('/api/v1/attempts/' + candidate.id);
      record('S1B9 leaving writing saves the selected preparation draft', saved.data.text === text);
      const mark = cdp.events.length;
      await fresh('#/prep/' + preparationId + '/verlauf'); await ready();
      await cdp.waitFor(`document.querySelector('[data-attempt="${candidate.id}"]')`);
      await clickSel(cdp, `[data-attempt="${candidate.id}"]`); await cdp.waitFor("document.querySelector('#writing-text')");
      const history = requestsSince(mark).filter(r => new URL(r.url).pathname === '/api/v1/attempts' && r.method === 'GET');
      record('S1B10 reload resumes saved text and history stays preparation-scoped', history.length > 0
        && history.every(r => new URL(r.url).searchParams.get('preparationId') === preparationId)
        && await cdp.evaluate(`return document.querySelector('#writing-text').value===${JSON.stringify(text)}`));
      const credits = await request(prepPath + '/credits');
      await go('schreiben'); await cdp.waitFor("document.querySelector('#preparation-credits')?.getBoundingClientRect().height>0");
      record('S1B11 displayed credits match the selected exam', credits.status === 200 && credits.data.examId === originalPreparation.exam_id
        && await cdp.evaluate('return ' + shellText('#preparation-credits', 'credits', { exam: originalPreparation.exam, available: credits.data.available, reserved: credits.data.reserved, used: credits.data.used })));
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
      record('S1 conflicting date never silently replaces unsaved form choices', await cdp.evaluate("return document.querySelector('#examDate').value==='2031-07-16' && document.querySelector('#language').value==='uk'")
        && await cdp.evaluate('return ' + shellText('#settings-state', 'm189')));
      await clickSel(cdp, '#settings-reload');
      await cdp.waitFor(shellText('#settings-state', 'm188'));
    });

    await run('S1 partial settings failure is explicitly reconciled', async () => {
      const before = await request('/api/v1/settings');
      await hook('*/api/v1/settings', async (event, controls) => {
        if (event.request.method === 'PUT') await controls.reply(event, 503, { error: 'synthetic_settings_unavailable' });
        else await controls.proceed(event);
      });
      await setInputs(cdp, { examDate: '2031-07-16', language: 'uk' });
      await clickSel(cdp, '#save-settings');
      await cdp.waitFor(shellText('#settings-state', 'reconciled'));
      const prep = await request(prepPath), settings = await request('/api/v1/settings');
      record('S1 partial save preserves committed date and restores the confirmed account language',
        prep.data.exam_date === '2031-07-16' && settings.data.settings.language === before.data.settings.language
        && await cdp.evaluate('return ' + shellText('#settings-state', 'm192'))
        && await cdp.evaluate(`return document.querySelector('#language').value===${JSON.stringify(before.data.settings.language)}
          && !document.querySelector('#save-settings').disabled`));
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
        await go('einstellungen'); await go('verlauf');
        await cdp.waitFor("document.querySelector('#history-list')?.getBoundingClientRect().height>0 && !document.querySelector('#history-list [data-i18n=\"shell.m161\"]')");
        await cdp.waitFor(`document.querySelector('#preparation-credits').textContent.includes(${JSON.stringify(otherPrep.data.exam)})`);
        const reads = requestsSince(mark).filter(r => new URL(r.url).pathname === '/api/v1/attempts');
        record('S1 late recovery response cannot replace picker, route, credit or API context', reads.length > 0
          && reads.every(r => new URL(r.url).searchParams.get('preparationId') === other)
          && await cdp.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(other)}
            && location.hash===${JSON.stringify('#/prep/' + other + '/verlauf')}
            && document.querySelector('#sidebar-exam').textContent===${JSON.stringify(otherPrep.data.exam)}
            && document.querySelector('#preparation-credits').textContent.includes(${JSON.stringify(otherPrep.data.exam)})
            && document.querySelector('#settings-state').textContent===''`));
        await shot(cdp, 's1-settings-recovery-after-switch');
        await select(preparationId);
      });

      await run('S1 latest deep link survives a delayed settings write', async () => {
        await fresh('#/prep/' + preparationId + '/einstellungen'); await ready();
        let receive, held = false;
        const write = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/settings', async (event, controls) => {
          if (!held && event.request.method === 'PUT') { held = true; receive({ event, controls }); }
          else await controls.proceed(event);
        });
        await setInputs(cdp, { language: 'uk' }); await clickSel(cdp, '#save-settings');
        const delayed = await paused(write);
        await changeHash('#/prep/' + preparationId + '/heute');
        await changeHash('#/prep/' + other + '/verlauf');
        const mark = cdp.events.length;
        await delayed.controls.proceed(delayed.event);
        await cdp.waitFor(`location.hash===${JSON.stringify('#/prep/' + other + '/verlauf')}
          && document.querySelector('#preparation-picker').value===${JSON.stringify(other)}
          && !document.querySelector('#preparation-picker').disabled && !document.querySelector('#view-verlauf').hidden`, 15000);
        await cdp.waitFor("document.querySelector('#history-list')?.getBoundingClientRect().height>0 && !document.querySelector('#history-list [data-i18n=\"shell.m161\"]')");
        const saved = await request('/api/v1/settings');
        const selected = await request('/api/v1/preparations/' + other);
        await cdp.waitFor(`document.querySelector('#preparation-credits').textContent.includes(${JSON.stringify(selected.data.exam)})`);
        const scoped = requestsSince(mark).filter(r => /\/api\/v1\/(tasks|objective-sets|practice\/|attempts$)/.test(new URL(r.url).pathname));
        record('S1 settings save persists the account choice then routes only to the latest queued preparation',
          saved.status === 200 && saved.data.settings.language === 'uk' && scoped.length > 0
          && scoped.every(r => new URL(r.url).searchParams.get('preparationId') === other));
        await shot(cdp, 's1-navigation-after-settings-save');
        await select(preparationId);
      });

      await run('S1 refused settings write preserves recovery and cancels queued navigation', async () => {
        await fresh('#/prep/' + preparationId + '/einstellungen'); await ready();
        const before = await request('/api/v1/settings');
        let receive, held = false;
        const write = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/settings', async (event, controls) => {
          if (!held && event.request.method === 'PUT') { held = true; receive({ event, controls }); }
          else await controls.proceed(event);
        });
        await setInputs(cdp, { language: 'tr' }); await clickSel(cdp, '#save-settings');
        const delayed = await paused(write);
        await changeHash('#/prep/' + other + '/verlauf');
        await changeHash('#/prep/' + preparationId + '/heute');
        await delayed.controls.reply(delayed.event, 503, { error: 'synthetic_settings_unavailable' });
        await cdp.waitFor(shellText('#settings-state', 'reconciled'));
        const after = await request('/api/v1/settings');
        record('S1 refused settings write cancels queued navigation and restores the confirmed language',
          JSON.stringify(before.data) === JSON.stringify(after.data)
          && await cdp.evaluate(`return location.hash===${JSON.stringify('#/prep/' + preparationId + '/einstellungen')}
            && document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)}
            && !document.querySelector('#view-einstellungen').hidden && document.querySelector('#language').value===${JSON.stringify(before.data.settings.language)}`));
        await shot(cdp, 's1-settings-write-navigation-recovery');
        await stopIntercept();
      });

      await run('S1 latest deep link survives a delayed autosave', async () => {
        await fresh('#/prep/' + preparationId + '/schreiben'); await ready();
        await cdp.waitFor("document.querySelector('#skill-schreiben [data-write]')");
        const binding = await cdp.evaluate("const button=document.querySelector('#skill-schreiben [data-write]'); return {task:button.dataset.write,version:button.dataset.version};");
        await clickSel(cdp, '#skill-schreiben [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')");
        let held = false, receive;
        const autosave = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/attempts/*', async (event, controls) => {
          if (!held && event.request.method === 'PUT') { held = true; receive({ event, controls }); }
          else await controls.proceed(event);
        });
        const text = 'Synthetischer Text vor zwei schnellen Navigationen ' + randomUUID();
        await setInputs(cdp, { 'writing-text': text });
        await changeHash('#/prep/' + other + '/verlauf');
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
        await go('ueben'); await cdp.waitFor("document.querySelector('#drill-host [data-drill-option]')");
        let held = false, receive;
        const prepRead = new Promise(resolve => { receive = resolve; });
        await hook('*/api/v1/preparations/' + other, async (event, controls) => {
          if (!held && event.request.method === 'GET') { held = true; receive({ event, controls }); }
          else await controls.proceed(event);
        });
        await changeHash('#/prep/' + other + '/verlauf');
        const delayed = await paused(prepRead);
        await cdp.evaluate("return new Promise(resolve=>{window.addEventListener('hashchange',()=>resolve(true),{once:true}); history.go(-2);});");
        await delayed.controls.reply(delayed.event, 503, { error: 'synthetic_obsolete_preparation_read' });
        await cdp.waitFor(`location.hash===${JSON.stringify('#/prep/' + preparationId + '/heute')}
          && document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)}
          && !document.querySelector('#preparation-picker').disabled && !document.querySelector('#view-heute').hidden`, 15000);
        record('S1 queued back navigation survives an obsolete read failure', await cdp.evaluate("return document.querySelector('#preparation-state').textContent===''") );
      });

      await run('S1 switch waits for a successful draft save', async () => {
        await go('schreiben'); await cdp.waitFor("document.querySelector('#skill-schreiben [data-write]')");
        const binding = await cdp.evaluate("const button=document.querySelector('#skill-schreiben [data-write]'); return {task:button.dataset.write,version:button.dataset.version};");
        await clickSel(cdp, '#skill-schreiben [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')");
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
        await cdp.waitFor('(' + shellText('#preparation-state', 'm033') + ' || ' + shellText('#preparation-state', 'm035') + ') && !document.querySelector("#preparation-picker").disabled', 12000);
        record('S1 failed autosave drops queued navigation and preserves the original context and visible draft', await cdp.evaluate(`return document.querySelector('#preparation-picker').value===${JSON.stringify(preparationId)} && location.hash===${JSON.stringify('#/prep/' + preparationId + '/schreiben')} && !document.querySelector('#view-schreiben').hidden && document.querySelector('#writing-text').value===${JSON.stringify(text)}`));
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
          && await cdp.evaluate(`return document.querySelector('#sidebar-exam').textContent===${JSON.stringify(selected.data.exam)}`));
        const otherCredits = await request('/api/v1/preparations/' + other + '/credits');
        const after = await request(prepPath + '/credits');
        record('S1 switching displays the other exam balance without transfer or refill', otherCredits.status === 200
          && otherCredits.data.examId === selected.data.exam_id && JSON.stringify(before.data) === JSON.stringify(after.data));
        if (selected.data.state === 'archived') {
          await go('ueben');
          await cdp.waitFor(shellText('#task-list', 'm146'));
          record('S1B13 archive exposes history without new objective controls', await cdp.evaluate("return !document.querySelector('#view-ueben').hidden && !document.querySelector('#view-ueben [data-drill-option],#view-ueben [data-drill-check],#view-ueben [data-open]') && document.querySelector('#task-list a[href=\"#/verlauf\"]')?.getBoundingClientRect().height>0")
            && await cdp.evaluate('return ' + shellText('#task-list', 'm147')));
          await go('schreiben');
          record('S1B13 archive exposes history without new writing controls', await cdp.evaluate("return !document.querySelector('#skill-schreiben [data-write]') && !document.querySelector('#view-schreiben').hidden")
            && await cdp.evaluate('return ' + shellText('#skill-schreiben', 'm146')));
        }
        await select(preparationId);
      });
    } else {
      record('S1 second-preparation fixture supplied for switching acceptance', false, 'PENDING coordinator-owned disposable second-package fixture; this leg is not a pass');
    }

    for (const width of [390, 320]) {
      await run('S1 mobile ' + width, async () => {
        await go('ueben'); await cdp.waitFor("document.querySelector('#drill-host [data-drill-option]')");
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
