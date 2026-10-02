/** Called only with app-browser-check's disposable Compose stack and synthetic accounts. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage, CDP } from './cdp.js';

export async function verifyAccountContext({ base, freePort, record, shot, viewport, theme, nav, setInputs, clickSel }) {
  const port = await freePort();
  const browser = await launchBrowser(port);
  let a, other;
  const password = 'synthetic-context-browser-password';
  const accounts = [];
  async function raw(cookie, path, method = 'GET', body, expected) {
    const res = await fetch(base + path, { method, headers: { cookie, origin: base, 'content-type': 'application/json', ...(expected ? { 'X-Hatoove-Account': expected } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    for (const label of ['a', 'b']) {
      const email = `context-${label}-${randomUUID()}@example.invalid`;
      const created = await raw('', '/api/auth/sign-up/email', 'POST', { name: 'Synthetic Context', email, password });
      if (created.status !== 200) throw new Error('Synthetic account setup failed: ' + created.status);
      const identity = await raw(created.cookie, '/api/v1/account');
      accounts.push({ email, cookie: created.cookie, id: identity.data.id });
    }
    a = await connectToPage(port);
    await a.send('Network.enable');
    await viewport(a, 1440, 900, false);
    await nav(a, base + '/signin');
    await setInputs(a, { 'si-email': accounts[0].email, 'si-password': password });
    await clickSel(a, '#si-submit');
    await a.waitFor("document.querySelector('#account-email')?.textContent.includes('@')", 15000);
    await clickSel(a, '.side [data-view="einstellungen"]');
    await a.waitFor("!document.querySelector('#view-einstellungen').hidden");
    const settingsA = (await raw(accounts[0].cookie, '/api/v1/settings')).data;
    const settingsB = (await raw(accounts[1].cookie, '/api/v1/settings')).data;
    const target = await a.send('Target.createTarget', { url: base + '/signin' });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const ws = new WebSocket(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    other = new CDP(ws); await other.send('Runtime.enable'); await other.send('Page.enable');
    async function loginOther(index) {
      // The second real tab shares the browser cookie jar but has its own page/module state.
      return other.evaluate(`return (async()=>{const r=await fetch('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:${JSON.stringify(accounts[index].email)},password:${JSON.stringify(password)}})}); return r.status})()`);
    }
    if (await loginOther(1) !== 200) throw new Error('Second-tab sign-in failed');
    await setInputs(a, { language: 'tr' }); await clickSel(a, '#save-settings');
    await a.waitFor("document.querySelector('#error').textContent.includes('Konto wurde')");
    record('A1 stale settings tab cannot change either account after another tab signs in',
      JSON.stringify((await raw(accounts[0].cookie, '/api/v1/settings')).data) === JSON.stringify(settingsA)
      && JSON.stringify((await raw(accounts[1].cookie, '/api/v1/settings')).data) === JSON.stringify(settingsB));
    await a.evaluate("window.confirm=()=>true; document.querySelector('#delete-account').click(); return true");
    await a.waitFor("document.querySelector('#error a') && !document.querySelector('#error').hidden");
    const guardedDelete = await raw(accounts[1].cookie, '/api/v1/account', 'DELETE', {}, accounts[0].id);
    record('A2 stale delete is refused at the server and both synthetic accounts survive', guardedDelete.status === 409
      && guardedDelete.data.error === 'account_changed'
      && (await raw(accounts[0].cookie, '/api/v1/account')).status === 200
      && (await raw(accounts[1].cookie, '/api/v1/account')).status === 200);
    await clickSel(a, '#signout');
    record('A3 stale sign-out leaves the newer account session active', await other.evaluate(`return (async()=>{const r=await fetch('/api/auth/get-session'); const d=await r.json(); return d?.user?.id===${JSON.stringify(accounts[1].id)}})()`));
    await shot(a, '36-account-changed-settings-desktop');

    // Rebind only by reloading after a deliberate login. Create a normal unsubmitted draft.
    if (await loginOther(0) !== 200) throw new Error('Restoring synthetic A failed');
    await nav(a, base + '/signin'); // Changing only the app hash deliberately does not unfreeze the old page.
    await nav(a, base + '/app/#/schreiben');
    await a.waitFor("document.querySelector('#skill-schreiben [data-write]')", 15000);
    await clickSel(a, '#skill-schreiben [data-write]');
    await a.waitFor("document.querySelector('#writing-text')", 15000);
    const submittedText = 'Liebe Anna, vielen Dank für deine Einladung. Ich komme am Samstag. Viele Grüße!';
    await setInputs(a, { 'writing-text': submittedText });
    await a.waitFor("document.querySelector('#writing-state').textContent.includes('Gespeichert.')", 12000);
    const pendingDraft = (await raw(accounts[0].cookie, '/api/v1/attempts')).data.attempts.find(row => row.status === 'draft');
    const pendingData = (await raw(accounts[0].cookie, '/api/v1/attempts/' + pendingDraft.id)).data;
    const submitted = await other.evaluate(`return (async()=>{const r=await fetch(${JSON.stringify('/api/v1/attempts/' + pendingDraft.id + '/submissions')},{method:'POST',headers:{'content-type':'application/json','X-Hatoove-Account':${JSON.stringify(accounts[0].id)}},body:JSON.stringify({expectedRevision:${pendingData.revision},eventId:${JSON.stringify(randomUUID())}})}); return {status:r.status,data:await r.json()}})()`);
    if (submitted.status !== 202) throw new Error('Second-tab submission failed');
    await a.evaluate("window.confirm=()=>true; document.querySelector('#writing-new').click(); return true");
    await a.waitFor("document.querySelector('#writing-state').textContent.includes('bereits in einem anderen Fenster abgegeben')");
    const kept = await raw(accounts[0].cookie, '/api/v1/submissions/' + submitted.data.submissionId);
    record('A4 a stale draft window cannot discard a submission accepted in another tab', kept.status === 200 && kept.data.submission.text === submittedText && kept.data.job.status !== 'cancelled');
    record('A5 refused discard stays in history and explains where to find the submission',
      (await raw(accounts[0].cookie, '/api/v1/attempts')).data.attempts.some(row => row.submission_id === submitted.data.submissionId)
      && await a.evaluate("return document.querySelector('#writing-new').disabled && document.querySelector('#writing-state').textContent.includes('Verlauf')"));
    await shot(a, '39-submitted-draft-preserved-desktop');
    await clickSel(a, '#writing-close');
    await clickSel(a, '#skill-schreiben [data-write]');
    await a.waitFor("document.querySelector('#writing-text')", 15000);
    const attempts = (await raw(accounts[0].cookie, '/api/v1/attempts')).data.attempts;
    const draft = attempts.find(row => row.status === 'draft');
    if (!draft) throw new Error('Synthetic draft missing');
    const original = (await raw(accounts[0].cookie, '/api/v1/attempts/' + draft.id)).data;
    const text = 'SYNTHETISCHER NICHT GESPEICHERTER TEXT: Ich möchte meinen Brief behalten.';
    await a.evaluate(`document.querySelector('#writing-text').value=${JSON.stringify(text)}; return true`);
    if (await loginOther(1) !== 200) throw new Error('Second account switch failed');
    await clickSel(a, '#writing-submit'); // Presave awaits the refused request; it must not re-enable this editor.
    await a.waitFor("document.querySelector('#error').textContent.includes('Konto wurde')");
    record('A6 account change preserves unsaved text and does not offer a false draft conflict', await a.evaluate(`return document.querySelector('#writing-text').value===${JSON.stringify(text)} && document.querySelector('#writing-text').readOnly && document.querySelector('#writing-submit').disabled && !document.querySelector('#writing-compare') && Boolean(document.querySelector('#error a'))`));
    record('A7 stale submission presave changed neither saved A draft nor B history',
      (await raw(accounts[0].cookie, '/api/v1/attempts/' + draft.id)).data.text === original.text
      && (await raw(accounts[1].cookie, '/api/v1/attempts')).data.attempts.length === 0);
    await shot(a, '37-account-changed-draft-desktop');
    await viewport(a, 390, 844, true); await theme(a, 'dark');
    await a.evaluate("document.querySelector('#error').scrollIntoView({block:'start'}); return true");
    await shot(a, '38-account-changed-draft-mobile-dark');
    record('A8 account recovery and retained text fit a phone', await a.evaluate('return document.documentElement.scrollWidth <= innerWidth'));
  } finally {
    a?.ws.close(); other?.ws.close(); await browser.cleanup();
  }
}
