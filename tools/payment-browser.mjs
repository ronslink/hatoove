/** Real rendered checkout over the disposable synthetic Compose caller. No provider request. */
import { randomUUID } from 'node:crypto';
import { launchBrowser, connectToPage } from './cdp.js';

export async function verifyPayments({ base, email, password, freePort, record, shot, viewport, theme,
  nav, setInputs, clickSel, overflow, query, webhook, changeMode }) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
    || !origin.port || ['4300', '55440'].includes(origin.port) || origin.origin !== base
    || !/^browser-[a-z0-9-]+@example\.test$/i.test(email)) throw Error('Isolated synthetic payment fixture required');
  const browsers = [], connections = [];
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); record(name, true); } catch (error) { record(name, false, error.stack || error.message); } };
  const launch = async () => {
    const port = await freePort(), browser = await launchBrowser(port); browsers.push(browser);
    const cdp = await connectToPage(port); connections.push(cdp);
    await cdp.send('Network.enable'); await viewport(cdp, 1440, 900, false); await theme(cdp, 'light'); return cdp;
  };
  const request = (cdp, route, method = 'GET', body) => cdp.evaluate(`return (async()=>{
    const r=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'content-type':'application/json'}${body === undefined ? '' : ',body:' + JSON.stringify(JSON.stringify(body))}});
    return {status:r.status,data:await r.json()};})()`);
  const ready = cdp => cdp.waitFor("document.querySelector('#app-shell') && !document.querySelector('#app-shell').hidden && document.querySelector('#preparation-picker').value", 20000);
  const state = (cdp, expected) => cdp.waitFor(`document.querySelector('#checkout-host')?.dataset.state===${JSON.stringify(expected)}`, 20000, 'checkout ' + expected);
  const signin = async cdp => {
    await setInputs(cdp, { 'si-email': email, 'si-password': password }); await clickSel(cdp, '#si-submit'); await ready(cdp);
  };
  const open = async (cdp, hash = '#/checkout') => {
    await nav(cdp, base + '/app/?paymentProbe=' + randomUUID() + hash); await ready(cdp);
    await cdp.waitFor("document.querySelector('#checkout-host')?.dataset.state", 15000);
  };
  const market = async cdp => {
    await cdp.waitFor("document.querySelector('#checkout-market')", 15000);
    await setInputs(cdp, { 'checkout-market': 'DE' });
  };
  const balance = () => JSON.parse(query(`SELECT row_to_json(e) FROM hatoove.entitlements e JOIN hatoove."user" u ON u.id=e.owner_id WHERE u.email='${email}' AND e.exam_id='telc-deutsch-b1'`));
  const eventFor = (id, type = 'checkout.session.completed', paymentStatus = 'paid') => ({
    id: 'evt_synthetic_' + randomUUID().replaceAll('-', ''), type, livemode: false,
    data: { object: { object: 'checkout.session', id: query(`SELECT provider_ref FROM hatoove.payment_order WHERE id='${id}'`), client_reference_id: id,
      metadata: { order_id: id }, payment_intent: 'pi_synthetic_' + id.replaceAll('-', ''),
      livemode: false, payment_status: paymentStatus, amount_total: 1000, currency: 'eur' } },
  });
  let cdp, orderId, paidEvent, beforeGrant;
  try {
    cdp = await launch(); await nav(cdp, base + '/signin'); await signin(cdp);
    await run('PAY-B1 no normal installation has a commercial offer', async () => {
      assert(query('SELECT count(*) FROM hatoove.payment_product') === '0', 'Commercial seed unexpectedly present');
      await open(cdp); await state(cdp, 'missing');
      assert(await cdp.evaluate("return !document.querySelector('#checkout-buy')"), 'Missing offer has buy control');
    });
    query("INSERT INTO hatoove.payment_product(id,exam_id,allowance,term_days,active) VALUES('synthetic-telc','telc-deutsch-b1',10,30,true)");
    query("INSERT INTO hatoove.payment_price(product_id,market,currency,amount_minor,display_price,stripe_price_id,active) VALUES('synthetic-telc','DE','EUR',1000,'10,00 €','price_synthetic',true)");
    await run('PAY-B2 market is an explicit choice and existing allowance prevents purchase', async () => {
      await open(cdp); await cdp.waitFor("document.querySelector('#checkout-market')");
      assert(await cdp.evaluate("return document.querySelector('#checkout-market').value==='' && !document.querySelector('#checkout-buy')"), 'Market was inferred');
      await market(cdp); await state(cdp, 'existing');
      assert(await cdp.evaluate("return !document.querySelector('#checkout-buy') && document.querySelector('#checkout-test-mode')?.textContent"), 'Existing balance or test label missing');
      await shot(cdp, 'payment-existing-desktop');
    });
    await run('PAY-B2a opening checkout flushes an unsaved writing draft', async () => {
      await cdp.evaluate("location.hash='#/schreiben';return true");
      await cdp.waitFor("document.querySelector('#skill-schreiben [data-write]')", 15000);
      await clickSel(cdp, '#skill-schreiben [data-write]'); await cdp.waitFor("document.querySelector('#writing-text')", 15000);
      const draft = 'Sehr geehrte Damen und Herren, dies ist mein gespeicherter Testentwurf. Vielen Dank.';
      await cdp.evaluate(`const textarea=document.querySelector('#writing-text');textarea.value=${JSON.stringify(draft)};
        textarea.dispatchEvent(new Event('input',{bubbles:true}));location.hash='#/checkout';return true`);
      await cdp.waitFor("document.querySelector('#checkout-market')", 15000);
      assert(query(`SELECT count(*) FROM hatoove.drafts d JOIN hatoove.attempts a ON a.id=d.attempt_id JOIN hatoove."user" u ON u.id=a.owner_id WHERE u.email='${email}' AND d.text='${draft}'`) === '1', 'Checkout navigation lost the draft');
    });
    query(`UPDATE hatoove.entitlements SET expires_at=now()-interval '1 day' WHERE owner_id=(SELECT id FROM hatoove."user" WHERE email='${email}') AND exam_id='telc-deutsch-b1'`);
    await run('PAY-B3 expired balance offers server-priced test checkout', async () => {
      await open(cdp); await market(cdp); await state(cdp, 'ready');
      assert(await cdp.evaluate("return document.querySelector('#checkout-host').textContent.includes('10,00') && document.querySelector('#checkout-buy') && document.querySelector('#checkout-test-mode')"), 'Offer/test badge differs from server');
      beforeGrant = balance();
    });
    await run('PAY-B3a delayed offers preserve deliberate outside focus and restore replaced controls', async () => {
      for (const moveOutside of [true, false]) {
        await open(cdp);
        const eventStart = cdp.events.length;
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: base + '/api/v1/checkout/offer*', requestStage: 'Request' }] });
        try {
          await cdp.evaluate("document.querySelector('#checkout-market').focus();return true");
          await market(cdp);
          const deadline = Date.now() + 10000;
          let paused;
          while (Date.now() < deadline && !paused) {
            paused = cdp.events.slice(eventStart).find(event => event.method === 'Fetch.requestPaused');
            if (!paused) await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert(paused, 'Offer request was not actually delayed');
          if (moveOutside) assert(await cdp.evaluate("document.querySelector('#lang-btn').focus();return document.activeElement.id==='lang-btn'"), 'Outside control was not focusable');
          await cdp.send('Fetch.continueRequest', { requestId: paused.params.requestId });
          await state(cdp, 'ready');
          const expected = moveOutside ? 'lang-btn' : 'checkout-market';
          assert(await cdp.evaluate(`return document.activeElement.id===${JSON.stringify(expected)}`), 'Delayed offer changed keyboard focus incorrectly');
        } finally { await cdp.send('Fetch.disable'); }
      }
    });
    await run('PAY-B4 offer fits desktop and narrow phones in light and dark', async () => {
      await state(cdp, 'ready');
      for (const width of [1440, 390, 320]) for (const appearance of ['light', 'dark']) {
        await viewport(cdp, width, width === 1440 ? 900 : 844, width !== 1440); await theme(cdp, appearance);
        const box = await overflow(cdp); assert(box.scrollWidth <= box.innerWidth + 2 && box.offenderCount === 0, JSON.stringify(box));
        assert(await cdp.evaluate("const r=document.querySelector('#checkout-buy').getBoundingClientRect();return r.width>0&&r.height>=40"), 'Unusable checkout touch target');
        await shot(cdp, `payment-offer-${width}-${appearance}`, width === 1440 ? null : '#checkout-host');
      }
      await viewport(cdp, 1440, 900, false); await theme(cdp, 'light');
    });
    await run('PAY-B5 stub return remains pending until signed confirmation', async () => {
      await clickSel(cdp, '#checkout-buy'); await state(cdp, 'pending');
      orderId = await cdp.evaluate("return new URLSearchParams(location.hash.split('?')[1]).get('order')");
      assert(/^[a-f0-9-]{36}$/i.test(orderId), 'Return lacks UUID');
      assert((await request(cdp, '/api/v1/orders/' + orderId)).data.order.status === 'pending', 'Return falsely confirms payment');
      assert(balance().allowance === beforeGrant.allowance, 'Return granted credits');
      await shot(cdp, 'payment-pending-desktop');
    });
    if (!orderId) return;
    await run('PAY-B6 fresh sign-in preserves only the owned checkout return', async () => {
      const fresh = await launch();
      await nav(fresh, base + '/app/#/checkout?order=' + orderId);
      await fresh.waitFor("document.querySelector('#si-submit')", 20000);
      assert(await fresh.evaluate("return location.search.includes('returnTo=') || location.hash.startsWith('#/checkout?order=')"), 'Sign-in lost payment return');
      await signin(fresh); await state(fresh, 'pending');
      assert(await fresh.evaluate(`return location.hash.includes(${JSON.stringify(orderId)})`), 'Sign-in replaced order identity');
      await shot(fresh, 'payment-return-after-signin');
    });
    await run('PAY-B6a uncertain order failure preserves its identity and recovers', async () => {
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        await clickSel(cdp, '#checkout-refresh'); await state(cdp, 'error');
        assert(await cdp.evaluate("return !/Es wurde nichts (gebucht|freigeschaltet)/.test(document.querySelector('#checkout-host').textContent)"), 'Network failure falsely claims no charge');
        await viewport(cdp, 390, 844, true); await shot(cdp, 'payment-network-error-mobile', '#checkout-host');
      } finally {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
      await clickSel(cdp, '#checkout-retry'); await state(cdp, 'pending');
      assert(await cdp.evaluate(`return location.hash.includes(${JSON.stringify(orderId)})`), 'Recovery changed the order');
    });
    await run('PAY-B7 invalid signature and unpaid completed event cannot activate', async () => {
      assert((await webhook(eventFor(orderId), false)).status === 400, 'Unsigned event accepted');
      assert((await webhook(eventFor(orderId, 'checkout.session.completed', 'unpaid'))).status === 200, 'Authentic unpaid disposition not acknowledged');
      assert((await request(cdp, '/api/v1/orders/' + orderId)).data.order.status === 'pending', 'Unpaid event activated');
      assert(balance().allowance === beforeGrant.allowance, 'Unpaid event granted credits');
    });
    await run('PAY-B8 signed delayed success activates once across concurrent redelivery', async () => {
      paidEvent = eventFor(orderId, 'checkout.session.async_payment_succeeded');
      const responses = await Promise.all([webhook(paidEvent), webhook(paidEvent), webhook(eventFor(orderId))]);
      assert(responses.every(r => r.status === 200), JSON.stringify(responses));
      await clickSel(cdp, '#checkout-refresh'); await state(cdp, 'paid');
      const after = balance();
      assert(after.allowance === beforeGrant.used + beforeGrant.reserved + 10, 'Grant amount duplicated or kept expired units');
      assert(after.used === beforeGrant.used && after.reserved === beforeGrant.reserved, 'Grant reset counters');
      assert(Date.parse(after.expires_at) > Date.now(), 'Term missing');
      await viewport(cdp, 1440, 900, false); await shot(cdp, 'payment-paid-desktop');
      await viewport(cdp, 390, 844, true); await shot(cdp, 'payment-paid-mobile', '#checkout-host');
    });
    await run('PAY-B9 refund records the fact without inventing removed access', async () => {
      const before = balance();
      const refund = { id: 'evt_refund_' + randomUUID().replaceAll('-', ''), type: 'charge.refunded', livemode: false,
        data: { object: { object: 'charge', id: 'ch_synthetic_' + orderId.replaceAll('-', ''), livemode: false,
          metadata: { order_id: orderId }, payment_intent: paidEvent.data.object.payment_intent,
          amount: 1000, amount_refunded: 1000, refunded: true, currency: 'eur' } } };
      assert((await webhook(refund)).status === 200, 'Refund not recorded');
      await clickSel(cdp, '#checkout-refresh');
      await cdp.waitFor("document.querySelector('#checkout-host').textContent.includes('zurückerstattet')", 15000);
      assert(await cdp.evaluate("return !document.querySelector('#checkout-host').textContent.includes('Es wurde nichts freigeschaltet')"), 'Refund copy falsely denies prior activation');
      assert(JSON.stringify(balance()) === JSON.stringify(before), 'Unapproved refund clawback');
      await shot(cdp, 'payment-refund-mobile', '#checkout-host');
      assert((await webhook(paidEvent)).status === 200 && JSON.stringify(balance()) === JSON.stringify(before), 'Late success regranted refunded order');
    });
    await run('PAY-B10 order remains readable when new payments are turned off', async () => {
      await changeMode('off'); await open(cdp); await state(cdp, 'unavailable');
      assert(await cdp.evaluate("return !document.querySelector('#checkout-buy')"), 'Off mode sells');
      await shot(cdp, 'payment-unavailable-mobile', '#checkout-host');
      assert((await request(cdp, '/api/v1/orders/' + orderId)).status === 200, 'Off mode hides owned receipt');
    });
    await run('PAY-B11 checkout creates no persisted browser state or uncaught error', async () => {
      for (const connection of connections) {
        assert(await connection.evaluate('return localStorage.length===0 && sessionStorage.length===0'), 'Checkout persisted browser state');
        assert(connection.events.filter(e => e.method === 'Runtime.exceptionThrown').length === 0, 'Uncaught browser exception');
      }
    });
  } finally {
    for (const connection of connections) connection.ws.close();
    for (const browser of browsers) await browser.cleanup();
  }
}
