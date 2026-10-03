import { fixturePreparation, scopedFixtureRoute } from './browser-preparation-fixtures.mjs';
/**
 * EXAM-S0 browser discrimination, invoked only by app-browser-check's disposable Compose stack.
 * No standalone URL/CLI entry point. All content below is synthetic test data, not approved teaching
 * material. query(sql) executes against that harness-owned hatoove schema, returns raw JSON text from
 * the final SELECT, and throws on SQL errors. The caller owns stack/volume disposal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage, sleep } from './cdp.js';

const sql = value => "'" + String(value).replaceAll("'", "''") + "'";
const jsonSql = value => sql(JSON.stringify(value)) + '::jsonb';

export async function verifyExamS0({ base, email, password, freePort, record, shot, viewport, theme,
  nav, setInputs, clickSel, overflow, query }) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
      || !origin.port || ['4300', '55440'].includes(origin.port) || origin.origin !== base
      || !/^browser-\d+@example\.test$/.test(email) || typeof query !== 'function') {
    throw new Error('EXAM-S0 requires app-browser-check disposable ports, synthetic account and SQL callback');
  }
  const fixturePreparationId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const exam = `exam-s0-${suffix}`;
  const setId = `${exam}.lv2`;
  const title = `Synthetische Fassungsprüfung ${suffix}`;
  const payloads = {
    v1: { text: 'S0 Fassung eins: Der Treffpunkt ist der Bahnhof.', questions: [
      { n: 1, question: 'Wo ist der Treffpunkt in Fassung eins?', options: { a: 'Am Bahnhof', b: 'Im Park' } },
    ] },
    v2: { text: 'S0 Fassung zwei: Der Treffpunkt ist der Park.', questions: [
      { n: 1, question: 'Wo ist der Treffpunkt in Fassung zwei?', options: { a: 'Am Bahnhof', b: 'Im Park' } },
    ] },
  };
  const rows = Object.entries(payloads).map(([version, payload]) => `(${sql(version)}, ${jsonSql(payload)}, `
    + `${sql(createHash('sha256').update(JSON.stringify(payload)).digest('hex'))}, `
    + `${jsonSql({ 1: version === 'v1' ? 'a' : 'b' })})`).join(',');
  const seeded = JSON.parse(await query(`WITH fixture(version,payload,digest,answers) AS (VALUES ${rows}),
    exam AS (
      INSERT INTO hatoove.exam_package (exam_id,exam,level,exam_language,blueprint_version)
      VALUES (${sql(exam)},'Synthetic S0 browser fixture','B1','de','synthetic-v1') RETURNING exam_id
    ), content AS (
      INSERT INTO hatoove.content_version
        (content_version_id,kind,family,source_path,review_status,rights_status,content_sha256,exam_id)
      SELECT ${sql(setId + '@')}||f.version,'task','lv','tools/exam-s0-browser.mjs#synthetic',
        'approved','generated',f.digest,e.exam_id FROM fixture f CROSS JOIN exam e
      RETURNING content_version_id,exam_id
    ), sets AS (
      INSERT INTO hatoove.objective_set
        (set_id,version,exam_id,family,section,part,title,payload,item_count,media_required,content_version_id)
      SELECT ${sql(setId)},f.version,c.exam_id,'LV2','LV',2,${sql(title)},f.payload,1,false,c.content_version_id
      FROM fixture f JOIN content c ON c.content_version_id=${sql(setId + '@')}||f.version
      RETURNING set_id,version
    ), keys AS (
      INSERT INTO hatoove.objective_key (set_id,version,answers,explanations,transcript)
      SELECT s.set_id,s.version,f.answers,'{}'::jsonb,NULL FROM sets s JOIN fixture f USING(version)
      RETURNING set_id
    ), rights AS (
      INSERT INTO hatoove.content_rights (content_version_id,basis,decided_by,note)
      SELECT content_version_id,'generated','Synthetic test harness',
        'Disposable synthetic fixture only; approved status tests serving, not educational approval.' FROM content
      RETURNING content_version_id
    ) SELECT row_to_json(result) FROM (SELECT (SELECT count(*) FROM sets) AS sets,
      (SELECT count(*) FROM keys) AS keys,(SELECT count(*) FROM rights) AS rights) result`));
  if (seeded.sets !== 2 || seeded.keys !== 2 || seeded.rights !== 2) throw new Error('S0 fixture insertion failed');

  const port = await freePort();
  const browser = await launchBrowser(port);
  let cdp, cookie, originalSettings, originalPreparation, preparationPath, request, intercept;
  const checks = async (name, run) => {
    try { await run(); }
    catch (error) { record(name, false, error.message); }
    finally { if (intercept) await intercept.stop(); }
  };
  const until = async (predicate, label) => {
    const end = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(40); }
  };
  const bindingRows = async () => JSON.parse(await query(`SELECT COALESCE(array_to_json(array_agg(row_to_json(e))), '[]'::json)
    FROM (SELECT version,item_id,answer,correct FROM hatoove.item_evidence
      WHERE set_id=${sql(setId)} AND owner_id=(SELECT id FROM hatoove."user" WHERE email=${sql(email)})
      ORDER BY answered_at,evidence_id) e`));
  const hook = async (patterns, handle) => {
    let failure = null;
    const pending = new Map();
    const finish = async (p, method, args = {}) => {
      if (!pending.has(p.requestId)) return;
      pending.delete(p.requestId);
      await cdp.send(method, { requestId: p.requestId, ...args });
    };
    const controls = {
      proceed: p => finish(p, 'Fetch.continueRequest'),
      reply: (p, status, body) => finish(p, 'Fetch.fulfillRequest', { responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64') }),
    };
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.method !== 'Fetch.requestPaused') return;
      const p = message.params;
      pending.set(p.requestId, p);
      Promise.resolve().then(() => handle(p, controls)).catch(async error => {
        failure = error.message;
        try { await controls.proceed(p); } catch { /* cleanup also releases interception */ }
      });
    };
    cdp.ws.addEventListener('message', listener);
    await cdp.send('Fetch.enable', { patterns: patterns.map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
    intercept = { ...controls, assert: () => { if (failure) throw new Error(failure); }, stop: async () => {
      cdp.ws.removeEventListener('message', listener);
      for (const p of pending.values()) { try { await controls.proceed(p); } catch {} }
      await cdp.send('Fetch.disable');
      intercept = null;
      if (failure) record('S0 interception completed without harness errors', false, failure);
    } };
    return intercept;
  };
  const ownedRequests = (mark, loaderId) => cdp.events.slice(mark).filter(e => e.method === 'Network.requestWillBeSent'
    && (!loaderId || e.params.loaderId === loaderId)
    && new URL(e.params.request.url).pathname.startsWith('/api/v1/')).map(e => e.params.request);
  const go = async hash => {
    await cdp.evaluate(`location.hash=${JSON.stringify('#/' + hash)}; return true;`);
    await cdp.waitFor(`document.querySelector('#view-${hash}') && !document.querySelector('#view-${hash}').hidden`);
  };
  const freshApp = async hash => {
    // Hash-only Page.navigate keeps the current document. Bootstrap assertions require a new one.
    const token = randomUUID();
    await cdp.evaluate(`window.__s0DocumentProbe=${JSON.stringify(token)}; return true;`);
    const navigation = await cdp.send('Page.navigate', { url: base + '/app/?s0Probe=' + token + '#/' + hash });
    if (!navigation.loaderId) throw new Error('S0 fresh navigation did not create a document');
    await cdp.waitFor(`window.__s0DocumentProbe !== ${JSON.stringify(token)} && document.readyState === 'complete'`, 25000);
  };
  const openVersion = async version => {
    // Real server catalogue narrowed only to this fixture/version. Payload, grading and storage remain real.
    await hook(['*/api/v1/objective-sets*'], async (p, h) => {
      const url = new URL(p.request.url);
      if (p.request.method === 'GET' && url.pathname === '/api/v1/objective-sets') {
        const listing = await request(url.pathname + url.search);
        if (listing.status !== 200 || !Array.isArray(listing.data)) throw new Error('S0 catalogue precondition failed');
        await h.reply(p, 200, listing.data.filter(s => s.set_id === setId && s.version === version));
      } else await h.proceed(p);
    });
    await go('heute');
    await go('lesen');
    await cdp.waitFor(`document.querySelector('#skill-lesen [data-open="${setId}"]')`);
    await clickSel(cdp, `#skill-lesen [data-open="${setId}"]`);
    await cdp.waitFor("document.querySelector('#view-lesen .skill-practice [data-item]')");
    await intercept.stop();
  };
  const answerB = async () => {
    await clickSel(cdp, '#view-lesen [data-item="1"] [data-answer="b"]');
    await cdp.waitFor("/^(Richtig\\.|Noch nicht richtig)/.test(document.querySelector('#view-lesen [data-item=\"1\"] .result')?.textContent || '')");
  };

  try {
    cdp = await connectToPage(port);
    await cdp.send('Network.enable');
    await viewport(cdp, 1440, 900, false);
    await theme(cdp, 'light');
    await nav(cdp, base + '/signin');
    await setInputs(cdp, { 'si-email': email, 'si-password': password });
    await clickSel(cdp, '#si-submit');
    await cdp.waitFor("location.pathname.startsWith('/app') && document.querySelector('#account-email')?.textContent.includes('@')", 15000);
    cookie = (await cdp.send('Network.getCookies', { urls: [base] })).cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const prepResponse=await fetch(base+'/api/v1/preparations',{headers:{cookie:cookie}});
    if (!prepResponse.ok) throw new Error('synthetic preparation lookup failed');
    let preparationId=fixturePreparation(await prepResponse.json());
    request = async (route, method = 'GET', body) => {
      const res = await fetch(base + scopedFixtureRoute(route, preparationId), { method, headers: { cookie, origin: base, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, data: await res.json() };
    };
    const settings = await request('/api/v1/settings');
    if (settings.status !== 200) throw new Error('S0 synthetic account settings unavailable');
    originalSettings = settings.data.settings;
    const wanted = { ...originalSettings, language: 'en' };
    delete wanted.examDate;
    preparationPath='/api/v1/preparations/'+preparationId;
    originalPreparation=(await request(preparationPath)).data;
    const targetDate='2030-06-15';
    const dated=await request(preparationPath,'PUT',{expectedRevision:originalPreparation.revision,examDate:targetDate});
    if(dated.status!==200) throw new Error('S0 preparation date fixture failed');
    const saved = await request('/api/v1/settings', 'PUT', { expectedRevision: settings.data.revision, settings: wanted });
    if (saved.status !== 200) throw new Error('S0 synthetic preference setup failed');

    await checks('S0B1 delayed preferences gate first render and early writes', async () => {
      let held;
      const mark = cdp.events.length;
      await hook(['*/api/v1/settings'], async (p, h) => {
        if (p.request.method === 'GET' && !held) held = p;
        else await h.proceed(p);
      });
      await freshApp('heute');
      await until(() => held, 'settings request paused');
      const loaderId = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
      await cdp.evaluate(`location.hash='#/woerterbuch';
        document.querySelector('#language').value='tr';
        document.querySelector('#settings-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true;`);
      await sleep(150);
      const blocked = await cdp.evaluate("const shell=document.querySelector('#app-shell'), loading=document.querySelector('#boot-state'); return { hidden:shell?.hidden, inert:shell?.inert, concealed:!!shell && shell.getClientRects().length===0, loading:!!loading && !loading.hidden && loading.getClientRects().length>0 }");
      // Ignore requests still finishing in the previous document during the reload transition.
      const early = ownedRequests(mark, loaderId);
      record('S0B1 loading keeps shell inert and blocks hash-driven practice and settings writes',
        blocked.hidden === true && blocked.inert === true && blocked.concealed === true && blocked.loading === true
        && !early.some(r => r.method !== 'GET' || /\/vocab|\/nouns|\/practice\//.test(new URL(r.url).pathname)),
        JSON.stringify({ ...blocked, requests: early.map(r => `${r.method} ${new URL(r.url).pathname}`) }));
      await intercept.proceed(held);
      await cdp.waitFor("document.querySelector('#dict-results [lang=\"en\"]') && document.querySelector('#language').value==='en'", 12000);
      const first = await cdp.evaluate("return { hash:location.hash, title:document.querySelector('#page-title').textContent, language:document.querySelector('#lang-label').textContent, date:document.querySelector('#examDate').value, countdown:document.querySelector('#exam-countdown').textContent, english:document.querySelector('#dict-results [lang=\"en\"]')?.textContent, shell:!document.querySelector('#app-shell')?.hidden }");
      const after = await request('/api/v1/settings');
      record('S0B2 first view uses saved language/date and the latest requested hash', first.hash === '#/prep/'+preparationId+'/woerterbuch'
        && first.title === 'Wörterbuch' && first.language.includes('English') && first.date === targetDate
        && first.countdown.includes('Prüfung am') && first.countdown.includes('15') && Boolean(first.english) && first.shell
        && after.data.revision === saved.data.revision && after.data.settings.language === 'en');
      intercept.assert();
      await shot(cdp, 's0-preferences-first-render-desktop');
    });

    await checks('S0B3 failed settings load and retry', async () => {
      let failed = false;
      await hook(['*/api/v1/settings'], async (p, h) => {
        if (p.request.method === 'GET' && !failed) { failed = true; await h.reply(p, 503, { error: 'synthetic_settings_unavailable' }); }
        else await h.proceed(p);
      });
      await viewport(cdp, 390, 844, true);
      await freshApp('woerterbuch');
      await cdp.waitFor("document.querySelector('#boot-retry') && !document.querySelector('#boot-retry').hidden", 8000);
      record('S0B3 settings failure is recoverable without exposing default preferences', await cdp.evaluate("const shell=document.querySelector('#app-shell'); return shell.hidden && shell.inert && shell.getClientRects().length===0 && document.querySelector('#boot-message').textContent.includes('erneut')"));
      await shot(cdp, 's0-settings-recovery-mobile');
      await clickSel(cdp, '#boot-retry');
      await cdp.waitFor("document.querySelector('#dict-results [lang=\"en\"]') && !document.querySelector('#app-shell').hidden", 12000);
      record('S0B4 retry renders the retained destination and saved preferences on mobile',
        await cdp.evaluate("return location.hash==='#/prep/'+document.querySelector('#preparation-picker').value+'/woerterbuch' && document.querySelector('#language').value==='en' && document.querySelector('#boot-state').hidden")
        && (await overflow(cdp)).offenderCount === 0);
      intercept.assert();
      await shot(cdp, 's0-preferences-recovered-mobile');
    });

    await checks('S0V version-specific objective practice', async () => {
      // A separate owned context keeps this version test's synthetic exam isolated from real seed sets.
      await query(`INSERT INTO hatoove.learner_preparation(id,owner_id,exam_id,state,revision)
        SELECT ${sql(fixturePreparationId)},id,${sql(exam)},'active',1 FROM hatoove."user" WHERE email=${sql(email)}`);
      preparationId=fixturePreparationId;
      await viewport(cdp, 1440, 900, false);
      await freshApp('prep/'+preparationId+'/heute');
      await cdp.waitFor("document.querySelector('#account-email')?.textContent.includes('@')", 15000);
      await openVersion('v1');
      await answerB(); // Wrong in v1; identical item ID and answer are correct in v2.
      const firstRows = await bindingRows();
      record('S0V1 v1 wrong answer is stored against its exact version', firstRows.length === 1
        && firstRows[0].version === 'v1' && firstRows[0].item_id === '1' && firstRows[0].answer === 'b' && firstRows[0].correct === false);
      const next = await request(`/api/v1/practice/next?exam=${exam}`);
      record('S0V2 v1 evidence does not mark v2 as seen', next.status === 200 && next.data.set?.set_id === setId
        && next.data.set?.version === 'v2' && next.data.set?.seen_items === 0);
      const mark = cdp.events.length;
      await openVersion('v2');
      const text = await cdp.evaluate("return document.querySelector('#view-lesen .skill-practice').textContent");
      const reads = ownedRequests(mark).filter(r => new URL(r.url).pathname === `/api/v1/objective-sets/${setId}`);
      record('S0V3 discovery opens the exact v2 payload and visible version', text.includes(payloads.v2.text)
        && !text.includes(payloads.v1.text) && text.includes('Fassung v2') && reads.length === 1
        && new URL(reads[0].url).searchParams.get('version') === 'v2');
      await answerB();
      const posts = ownedRequests(mark).filter(r => r.method === 'POST' && new URL(r.url).pathname === `/api/v1/objective-sets/${setId}/answers`);
      const rows = await bindingRows();
      record('S0V4 v2 answer is marked and persisted as v2, never inferred v1', posts.length === 1
        && JSON.parse(posts[0].postData).version === 'v2' && rows.length === 2
        && rows[1].version === 'v2' && rows[1].item_id === '1' && rows[1].answer === 'b' && rows[1].correct === true
        && await cdp.evaluate("return document.querySelector('#view-lesen [data-item=\"1\"] .result').textContent==='Richtig.'"));
      await shot(cdp, 's0-objective-v2-desktop');
      await viewport(cdp, 390, 844, true);
      record('S0V5 versioned objective form fits mobile', (await overflow(cdp)).offenderCount === 0);
      await shot(cdp, 's0-objective-v2-mobile');
      const mistakes = await request(`/api/v1/practice/mistakes?exam=${exam}`);
      const own = (mistakes.data.items || []).filter(m => m.set_id === setId);
      await go('fehler');
      await cdp.waitFor(`document.querySelector('#mistake-list')?.textContent.includes(${JSON.stringify(title)})`, 8000);
      const visible = await cdp.evaluate(`return [...document.querySelectorAll('#mistake-list .list-item')].filter(e=>e.textContent.includes(${JSON.stringify(title)})).map(e=>e.textContent)`);
      record('S0V6 v2 success leaves the independent v1 mistake with its version label', mistakes.status === 200
        && own.length === 1 && own[0].version === 'v1' && own[0].your_answer === 'b'
        && visible.length === 1 && visible[0].includes('Fassung v1'));
      await shot(cdp, 's0-versioned-mistake-mobile');
    });

    await checks('S0V7 mismatched read binding is refused', async () => {
      await viewport(cdp, 1440, 900, false);
      const before = await bindingRows();
      const old = await request(`/api/v1/objective-sets/${setId}?version=v1`);
      if (old.status !== 200) throw new Error('Mismatch fixture unavailable');
      await hook(['*/api/v1/objective-sets*'], async (p, h) => {
        const u = new URL(p.request.url);
        if (p.request.method === 'GET' && u.pathname === '/api/v1/objective-sets') {
          const list = await request(u.pathname);
          await h.reply(p, 200, list.data.filter(s => s.set_id === setId && s.version === 'v2'));
        } else if (p.request.method === 'GET' && u.pathname === `/api/v1/objective-sets/${setId}`) await h.reply(p, 200, old.data);
        else await h.proceed(p);
      });
      await go('heute'); await go('lesen');
      await cdp.waitFor(`document.querySelector('#skill-lesen [data-open="${setId}"]')`);
      await clickSel(cdp, `#skill-lesen [data-open="${setId}"]`);
      await cdp.waitFor("document.querySelector('#error')?.textContent.includes('Fassung')", 8000);
      record('S0V7 a mismatched version cannot render answer controls or write evidence',
        await cdp.evaluate("return !document.querySelector('#view-lesen [data-answer]') && !document.querySelector('#skill-lesen').hidden")
        && JSON.stringify(await bindingRows()) === JSON.stringify(before));
      intercept.assert();
      await shot(cdp, 's0-mismatched-version-desktop');
    });
  } finally {
    if (intercept) { try { await intercept.stop(); } catch {} }
    try {
      if (request && originalSettings) {
        const current = await request('/api/v1/settings');
        const restored = current.status === 200 && await request('/api/v1/settings', 'PUT', {
          expectedRevision: current.data.revision, settings: Object.fromEntries(Object.entries(originalSettings).filter(([key])=>key!=='examDate')),
        });
        const currentPrep=await request(preparationPath);
        const restoredPrep=await request(preparationPath,'PUT',{expectedRevision:currentPrep.data.revision,examDate:originalPreparation.exam_date});
        record('S0 cleanup restores the synthetic account preferences', restored?.status === 200 && restoredPrep.status===200);
      }
    } catch (error) {
      record('S0 cleanup restores the synthetic account preferences', false, error.message);
    } finally {
      await query(`DELETE FROM hatoove.item_evidence WHERE preparation_id=${sql(fixturePreparationId)};
        DELETE FROM hatoove.learner_preparation WHERE id=${sql(fixturePreparationId)};`);
      if (cdp) cdp.ws.close();
      await browser.cleanup();
    }
  }
}
