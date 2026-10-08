import { fixturePreparation, scopedFixtureRoute } from './browser-preparation-fixtures.mjs';
/** Additional real-browser journey legs, called only inside app-browser-check's disposable stack. */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, connectToPage, sleep } from './cdp.js';

export async function verifyLearnerCompletion({ base, email, password, freePort, record, shot, viewport, theme, nav, setInputs, clickSel, overflow, shots, axe }) {
  const port = await freePort();
  const browser = await launchBrowser(port); // Fresh profile: no copied cookies or browser state.
  let cdp;
  try {
    cdp = await connectToPage(port);
    await cdp.send('Network.enable');
    await viewport(cdp, 1440, 900, false);
    await nav(cdp, base + '/signin');
    await setInputs(cdp, { 'si-email': email, 'si-password': password });
    await clickSel(cdp, '#si-submit');
    await cdp.waitFor("location.pathname.startsWith('/app') && document.querySelector('#account-email')?.innerText.includes('@')", 15000);
    const cookies = (await cdp.send('Network.getCookies', { urls: [base] })).cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const prepResponse=await fetch(base+'/api/v1/preparations',{headers:{cookie:cookies}});
    if (!prepResponse.ok) throw new Error('synthetic preparation lookup failed');
    const preparationId=fixturePreparation(await prepResponse.json());
    const request = async (route, method = 'GET', body) => {
      const res = await fetch(base + scopedFixtureRoute(route, preparationId), { method, headers: { cookie: cookies, origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json() };
    };
    const history = (await request('/api/v1/attempts')).data.attempts;
    const assessed = history.find(a => a.status === 'assessed');
    if (!assessed) throw new Error('precondition: no assessed writing from the main journey');
    const original = (await request('/api/v1/submissions/' + assessed.submission_id)).data;
    await clickSel(cdp, '.side [data-view="fortschritt"]');
    await cdp.waitFor("document.querySelectorAll('#history-list [data-attempt]').length > 0", 12000);
    const count = await cdp.evaluate("return document.querySelectorAll('#history-list [data-attempt]').length");
    record('C1 a fresh browser rediscovers all saved writing through history', count === history.length && count > 0, `${count} UI rows, ${history.length} server rows`);
    await shot(cdp, '25-history-fresh-browser-desktop');
    await axe.scan(cdp, 'history-list', "document.querySelector('#history-list [data-attempt]')?.getBoundingClientRect().height>0");
    await clickSel(cdp, `[data-attempt="${assessed.id}"]`);
    await cdp.waitFor("document.querySelectorAll('#history-detail .criterion').length === 3", 12000);
    const savedText = await cdp.evaluate("return document.querySelector('#history-detail .submitted-text')?.textContent");
    record('C2 historical feedback opens with its exact immutable submitted text', savedText === original.submission.text, `${savedText?.length} preserved characters; three criteria`);
    await shot(cdp, '26-history-result-desktop');
    await axe.scan(cdp, 'history-detail', "document.querySelectorAll('#history-detail .criterion').length===3 && document.querySelector('#history-detail .submitted-text')?.getBoundingClientRect().height>0");
    await clickSel(cdp, '#writing-revise');
    await cdp.waitFor("document.querySelector('#history-detail #writing-text')", 12000);
    const inherited = await cdp.evaluate("return document.querySelector('#writing-text').value");
    record('C3 revision starts with the original text', inherited === original.submission.text);
    let revisedText = inherited + '\nDies ist meine gespeicherte Überarbeitung.';
    const freshRevision = (await request('/api/v1/attempts')).data.attempts.find(a => a.parent_submission_id === assessed.submission_id && !history.some(old => old.id === a.id));
    if (!freshRevision) throw new Error('precondition: a new revision must exist on the server');
    const absentBeforeClose = await cdp.evaluate(`return !document.querySelector('[data-attempt="${freshRevision.id}"]')`);
    await setInputs(cdp, { 'writing-text': revisedText });
    await clickSel(cdp, '#writing-close');
    await cdp.waitFor(`document.querySelector('#history-detail').hidden && document.querySelector('[data-attempt="${freshRevision.id}"]')`, 12000);
    record('C3b closing a brand-new revision refreshes history without any intervening navigation', absentBeforeClose && (await request('/api/v1/attempts/' + freshRevision.id)).data.text === revisedText);
    await clickSel(cdp, `[data-attempt="${freshRevision.id}"]`);
    await cdp.waitFor("document.querySelector('#writing-text')", 12000);
    revisedText += '\nDiese Änderung wird beim Wechsel der Ansicht gespeichert.';
    await setInputs(cdp, { 'writing-text': revisedText });
    await clickSel(cdp, '.side [data-view="heute"]'); // Deliberately before the debounce expires.
    await cdp.waitFor("!document.querySelector('#view-heute').hidden", 12000);
    const updatedHistory = (await request('/api/v1/attempts')).data.attempts;
    const revision = updatedHistory.find(a => a.parent_submission_id === assessed.submission_id);
    const draft = (await request('/api/v1/attempts/' + revision.id)).data;
    const unchanged = (await request('/api/v1/submissions/' + assessed.submission_id)).data;
    record('C4 immediate navigation saves the revision without changing the original', draft.text === revisedText && unchanged.submission.text === inherited && revision.task_version === assessed.task_version);

    await clickSel(cdp, '.side [data-view="fortschritt"]');
    await cdp.waitFor(`document.querySelector('[data-attempt="${revision.id}"]')`, 12000);
    await clickSel(cdp, `[data-attempt="${revision.id}"]`);
    await cdp.waitFor("document.querySelector('#writing-text')", 12000);
    const remoteText = revisedText + '\nÄnderung aus einem anderen Fenster.';
    const remote = await request('/api/v1/attempts/' + revision.id, 'PUT', { expectedRevision: draft.revision, text: remoteText });
    if (remote.status !== 200) throw new Error('precondition: second writer did not save');
    let mine = revisedText + '\nMeine eigene Fassung bleibt hier.';
    await setInputs(cdp, { 'writing-text': mine });
    await cdp.waitFor("document.querySelector('#writing-compare')", 12000);
    mine += ' Noch ein Satz nach dem Konflikt.';
    await setInputs(cdp, { 'writing-text': mine });
    await sleep(750);
    record('C5a typing after a conflict preserves the resolution controls', await cdp.evaluate("return Boolean(document.querySelector('#writing-compare'))"));
    // Load the dark logo while online so a deliberate network loss does not fabricate a missing asset.
    await theme(cdp, 'dark');
    await cdp.waitFor("[...document.images].every(i => i.complete && i.naturalWidth > 0)", 12000);
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await clickSel(cdp, '#writing-compare');
    await cdp.waitFor("document.querySelector('#writing-state').innerText.includes('Versuche den Vergleich erneut')", 12000);
    record('C5b a failed conflict comparison still offers retry', await cdp.evaluate("return Boolean(document.querySelector('#writing-compare'))"));
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const conflictText = await cdp.evaluate("return document.querySelector('#writing-text').value");
    record('C5 a concurrent writer causes a visible conflict and no automatic overwrite', conflictText === mine && (await request('/api/v1/attempts/' + revision.id)).data.text === remoteText);
    await clickSel(cdp, '#writing-compare');
    await cdp.waitFor("document.querySelector('#writing-keep')", 12000);
    const comparison = await cdp.evaluate("return document.querySelector('#writing-state .submitted-text').textContent");
    record('C6 the conflict comparison shows the actual server version', comparison === remoteText);
    await shot(cdp, '27-writing-conflict-desktop');
    await axe.scan(cdp, 'recovery-conflict', "document.querySelector('#writing-keep')?.getBoundingClientRect().height>0 && document.querySelector('#writing-state .submitted-text')");
    await clickSel(cdp, '#writing-keep');
    await cdp.waitFor("document.querySelector('#writing-state').innerText.includes('Gespeichert.')", 12000);
    record('C7 only an explicit conflict choice replaces the server draft', (await request('/api/v1/attempts/' + revision.id)).data.text === mine);

    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const offlineText = mine + '\nAuch ohne Verbindung geht mein Text nicht verloren.';
    await setInputs(cdp, { 'writing-text': offlineText });
    await clickSel(cdp, '#writing-close');
    await cdp.waitFor("document.querySelector('#writing-save-again')", 12000);
    record('C8 closing offline keeps the unsaved letter and a retry action', await cdp.evaluate(`return document.querySelector('#writing-text').value === ${JSON.stringify(offlineText)} && !document.querySelector('#history-detail').hidden`));
    await viewport(cdp, 390, 844, true);
    await theme(cdp, 'dark');
    await shot(cdp, '28-writing-offline-mobile-dark');
    await axe.scan(cdp, 'recovery-offline', "document.querySelector('#writing-save-again')?.getBoundingClientRect().height>0 && document.querySelector('#writing-text')?.value.length>0");
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await clickSel(cdp, '#writing-save-again');
    await cdp.waitFor("document.querySelector('#writing-state').innerText.includes('Gespeichert.')", 12000);
    record('C9 retry saves the exact offline text', (await request('/api/v1/attempts/' + revision.id)).data.text === offlineText);
    await clickSel(cdp, '#writing-close');
    await cdp.waitFor(`document.querySelector('#history-detail').hidden && document.querySelector('[data-attempt="${revision.id}"]')`, 12000);
    record('C9b a saved revision is discoverable immediately after closing it', true);
    await clickSel(cdp, `[data-attempt="${revision.id}"]`);
    await cdp.waitFor("document.querySelector('#writing-text')", 12000);

    // Deliver the first POST to the real server, then lose only its response. The UI must reuse its event ID.
    const posts = [];
    let firstReply, interceptFailure;
    const intercept = async event => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Fetch.requestPaused') return;
      const p = message.params;
      try {
        if (p.request.method === 'GET') {
          await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"synthetic_unavailable"}').toString('base64') });
          return;
        }
        const body = JSON.parse(p.request.postData);
        posts.push(body.eventId);
        if (posts.length === 1) {
          firstReply = await request(new URL(p.request.url).pathname, 'POST', body);
          await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' });
        } else await cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch (error) { interceptFailure = error.message; }
    };
    cdp.ws.addEventListener('message', intercept);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/attempts/*/submissions', requestStage: 'Request' }, { urlPattern: '*/api/v1/submissions/*', requestStage: 'Request' }] });
    await clickSel(cdp, '#writing-submit');
    await cdp.waitFor("document.querySelector('#writing-submit').textContent.includes('erneut')", 12000);
    record('C10a uncertain submission cannot be discarded as a draft', await cdp.evaluate("return document.querySelector('#writing-new').disabled"));
    await axe.scan(cdp, 'recovery-uncertain-save', "document.querySelector('#writing-submit')?.textContent.includes('erneut') && document.querySelector('#writing-new')?.disabled");
    await clickSel(cdp, '#writing-submit');
    await cdp.waitFor("Boolean(document.querySelector('#writing-refresh'))", 12000);
    record('C10b accepted submission remains protected when result loading fails', await cdp.evaluate("return document.querySelector('#writing-new').hidden && document.querySelector('#writing-new').disabled"));
    await cdp.send('Fetch.disable');
    cdp.ws.removeEventListener('message', intercept);
    await clickSel(cdp, '#writing-refresh');
    const replayId = await cdp.evaluate("return document.querySelector('#writing-state').dataset.submissionId");
    const finalHistory = (await request('/api/v1/attempts')).data.attempts;
    record('C10 a lost submission response retries the same event and returns one saved submission', !interceptFailure && firstReply.status === 202 && posts.length === 2 && posts[0] === posts[1] && replayId === firstReply.data.submissionId && finalHistory.filter(a => a.id === revision.id && a.submission_id === replayId).length === 1, interceptFailure || `${posts.length} POSTs, one event, one submission`);
    record('C11 the writing result fits a narrow dark screen', (await overflow(cdp)).offenderCount === 0);
    await shot(cdp, '29-revision-submitted-mobile-dark');

    await clickSel(cdp, '.tabbar [data-view="mehr"]');
    await cdp.waitFor("!document.querySelector('#view-mehr').hidden", 12000);
    await clickSel(cdp, '#view-mehr [data-view="einstellungen"]');
    await cdp.waitFor("!document.querySelector('#view-einstellungen').hidden", 12000);
    const downloadPath = path.join(shots, 'synthetic-export');
    fs.mkdirSync(downloadPath, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
    await clickSel(cdp, '#export-data');
    await cdp.waitFor("document.querySelector('#export-state').innerText.includes('Download')", 12000);
    let files = [];
    for (let i = 0; i < 60; i++) { files = fs.readdirSync(downloadPath).filter(f => f.endsWith('.json')); if (files.length) break; await sleep(100); }
    const exported = files.length ? JSON.parse(fs.readFileSync(path.join(downloadPath, files[0]), 'utf8')) : null;
    record('C12 export downloads the original, revision and results without session credentials', exported?.format === 'hatoove-learner-export-v1' && exported.submissions.some(s => s.text === inherited) && exported.submissions.some(s => s.text === offlineText) && !/password|sessionToken|passwordHash|"cookie"/.test(JSON.stringify(exported)));
    await clickSel(cdp, '.tabbar [data-view="mehr"]');
    await cdp.waitFor("!document.querySelector('#view-mehr').hidden", 12000);
    await clickSel(cdp, '#view-mehr [data-view="nachschlagen"]');
    await cdp.waitFor("document.querySelector('[data-guide=\"writing-guide\"]')", 12000);
    await clickSel(cdp, '[data-guide="writing-guide"]');
    await cdp.waitFor("document.querySelectorAll('.guide-bad').length > 0", 12000);
    record('C13 reference guides clearly distinguish authored wrong examples', await cdp.evaluate("return document.querySelectorAll('.guide-bad').length === 15 && document.querySelectorAll('.guide-good').length === 17 && !document.querySelector('#guide-body pre')"));
    await cdp.evaluate("document.querySelector('.guide-bad').scrollIntoView({block:'center'}); return true");
    await shot(cdp, '30-guide-examples-mobile-dark');
    record('C13b the readable guide fits a phone', (await overflow(cdp)).offenderCount === 0);
    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');
    await shot(cdp, '31-guide-examples-desktop');
    await clickSel(cdp, '.side [data-view="satzbau"]');
    await cdp.waitFor("!document.querySelector('#view-satzbau').hidden", 12000);
    await setInputs(cdp, { 'sentence-text': 'Ich bleibe zu Hause, weil ich morgen arbeiten muss.' });
    await clickSel(cdp, '#sentence-submit');
    await cdp.waitFor("document.querySelectorAll('#sentence-result article').length === 2", 12000);
    const hints = await cdp.evaluate("return document.querySelector('#sentence-result').innerText");
    record('C14 sentence analysis returns bounded structural hints with its limitation', /Hauptsatz/i.test(hints) && /Nebensatz/i.test(hints) && /keine vollständige Grammatikprüfung/.test(hints) && /muss/.test(hints), hints.slice(0, 180));
    await shot(cdp, '32-sentence-structure-desktop');
    await viewport(cdp, 390, 844, true);
    await theme(cdp, 'dark');
    record('C14b sentence hints fit mobile', (await overflow(cdp)).offenderCount === 0);
    await shot(cdp, '33-sentence-structure-mobile-dark');
    await clickSel(cdp, '.tabbar [data-view="mehr"]');
    await cdp.waitFor("!document.querySelector('#view-mehr').hidden", 12000);
    await clickSel(cdp, '#view-mehr [data-view="sprachbausteine"]');
    const drill = 'telc-deutsch-b1.sb1.grammar-wortstellung-v1';
    await cdp.waitFor(`document.querySelector('[data-open="${drill}"]')`, 12000);
    await clickSel(cdp, `[data-open="${drill}"]`);
    await cdp.waitFor("document.querySelectorAll('#view-sprachbausteine [data-item]').length === 12", 12000);
    const firstPrompt = await cdp.evaluate("return document.querySelector('#view-sprachbausteine [data-item]').innerText");
    record('C15 recovered drills show readable prompts and twelve real questions', firstPrompt.includes('Ich weiß, dass') && !firstPrompt.includes('g_wortstellung') && (await overflow(cdp)).offenderCount === 0);
    await shot(cdp, '34-grammar-drill-mobile-dark');
    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');
    await shot(cdp, '35-grammar-drill-desktop');
  } finally {
    if (cdp) { try { await cdp.send('Fetch.disable'); } catch {} cdp.ws.close(); }
    await browser.cleanup();
  }
}
