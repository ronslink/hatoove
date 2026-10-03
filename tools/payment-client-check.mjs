import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// --against=<commit> exercises the same contracts against a historical source snapshot.
const revision = process.argv.find(value => value.startsWith('--against='))?.slice(10);
const source = path => revision ? execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' }) : readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const load = async path => import('data:text/javascript;base64,' + Buffer.from(source(path)).toString('base64'));
const checkout = await load('public/app/checkout.js');
const { createApi } = await load('public/app/api.js');
const { createCheckoutState, checkoutReturnPath, checkoutAuthReturn, checkoutRoute, checkoutRedirect, checkoutMarkup, checkoutBalance, checkoutError } = checkout;
const ID = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const PREP = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'http://localhost:4615';
const RETURN = `/app/#/checkout?order=${ID}`;
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ok = data => ({ ok: true, status: 200, data });
const markets = [{ market: 'TR', currency: 'TRY' }, { market: 'DE', currency: 'EUR' }];
const offer = market => ({ examId: 'telc-deutsch-b1', market, currency: market === 'TR' ? 'TRY' : 'EUR', amountMinor: 1500, displayPrice: market === 'TR' ? '15,00 TRY' : '15,00 €', allowance: 12, termDays: 30, productId: 'synthetic', purchasable: true, existing: null, testMode: true });
const order = (status = 'pending') => ({ id: ID, status, examId: 'telc-deutsch-b1', currency: 'EUR', amountMinor: 1500, testMode: true, entitlement: { allowance: 12, used: 2, reserved: 1, expiresAt: null } });
let passed = 0, failed = 0;
async function check(name, test) { try { await test(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message.split('\n')[0]); } }
function fixture(options = {}) {
  const calls = [], redirects = [], timers = new Map(); let nextTimer = 0, reply = options.reply;
  const api = { payments: {
    offer: async (examId, market) => { calls.push({ kind: 'offer', examId, market }); return reply ? reply('offer', { examId, market }) : ok({ markets, offer: market ? offer(market) : null, testMode: true }); },
    startSession: async body => { calls.push({ kind: 'start', body }); return reply ? reply('start', body) : ok({ orderId: ID, checkoutUrl: ORIGIN + RETURN + '&checkout=stub', testMode: true }); },
    order: async id => { calls.push({ kind: 'order', id }); return reply ? reply('order', id) : ok({ order: order() }); },
  } };
  const session = createCheckoutState({ api, eventId: () => OTHER, origin: () => ORIGIN, navigate: url => redirects.push(url), schedule: fn => { timers.set(++nextTimer, fn); return nextTimer; }, cancel: id => timers.delete(id), ...options });
  return { session, calls, redirects, timers, reply(fn) { reply = fn; }, async ready() { await session.open({ examId: 'telc-deutsch-b1' }); await session.loadOffer('DE'); } };
}

// Small DOM boundary for the public controller. These tests execute unchanged against the old
// controller too, so discrimination is behavioral rather than just a newly exported helper name.
async function rendered(api, run) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const redirects = []; let html = '', nodes = new Map();
  const host = { isConnected: true, hidden: true, dataset: {}, contains: () => false,
    get innerHTML() { return html; }, set innerHTML(value) { html = value; nodes = new Map([...value.matchAll(/id="([^"]+)"/g)].map(match => [match[1], { id: match[1], focus() {} }])); },
    querySelector(selector) { return nodes.get(selector.slice(1)) || null; }, replaceChildren() { this.innerHTML = ''; } };
  globalThis.window = { location: { origin: ORIGIN, assign: value => redirects.push(value) } }; globalThis.document = { activeElement: null };
  const controller = checkout.createCheckoutController({ api: { payments: api }, esc });
  try { await run({ controller, host, redirects }); } finally { controller.dispose(); globalThis.window = previousWindow; globalThis.document = previousDocument; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const compatibleOffer = async (examId, market) => ok({ markets, offer: market === null ? null : offer(market || 'DE'), testMode: true });
async function selectRendered(host) { const picker = host.querySelector('#checkout-market'); if (picker) { picker.onchange({ target: { value: 'DE' } }); await tick(); } }

await check('rendered controller offers a market selector for an omitted-market response', async () => {
  await rendered({ offer: async () => ok({ markets, offer: null, testMode: true }) }, async ({ controller, host }) => {
    await controller.open(host, { examId: 'telc-deutsch-b1' }); assert.ok(host.querySelector('#checkout-market'), 'explicit market selector must be rendered');
  });
});
await check('rendered controller refuses a provider-supplied arbitrary redirect', async () => {
  await rendered({ offer: compatibleOffer, startSession: async () => ok({ orderId: ID, checkoutUrl: 'https://evil.example/checkout', testMode: true }) }, async ({ controller, host, redirects }) => {
    await controller.open(host, { examId: 'telc-deutsch-b1', market: 'DE' }); await selectRendered(host);
    host.querySelector('#checkout-buy').onclick(); await tick(); assert.deepEqual(redirects, [], 'unsafe destination must not navigate');
  });
});
await check('rendered uncertain retry repeats the original checkout POST and keeps its event identity', async () => {
  const requests = [];
  await rendered({ offer: compatibleOffer, startSession: async body => { requests.push(body); return { ok: false, status: 502, error: 'provider_unavailable' }; } }, async ({ controller, host }) => {
    await controller.open(host, { examId: 'telc-deutsch-b1', market: 'DE' }); await selectRendered(host);
    host.querySelector('#checkout-buy').onclick(); await tick();
    assert.equal(/nichts gebucht|nichts freigeschaltet/i.test(host.innerHTML), false, 'uncertain outcome must not claim no charge');
    host.querySelector('#checkout-retry').onclick(); await tick(); assert.equal(requests.length, 2); assert.equal(requests[0].eventId, requests[1].eventId); assert.ok(requests[0].eventId);
  });
});
await check('rendered refund copy never says nothing was previously granted', async () => {
  await rendered({ order: async () => ok({ order: order('refunded') }) }, async ({ controller, host }) => {
    await controller.open(host, { examId: 'telc-deutsch-b1', orderId: ID }); assert.equal(/nichts freigeschaltet|nicht aktiv/i.test(host.innerHTML), false, 'refund must not invent a balance removal');
  });
});

await check('an offer starts with an explicit market choice even when only one market exists', async () => {
  const f = fixture({ reply: async () => ok({ markets: [markets[1]], offer: null, testMode: true }) });
  await f.session.open({ examId: 'telc-deutsch-b1' });
  assert.equal(f.calls[0].market, null); assert.equal(f.session.snapshot().market, null); assert.equal(f.session.snapshot().mode, 'market');
  const html = checkoutMarkup(f.session.snapshot(), esc); assert.match(html, /id="checkout-market"/); assert.match(html, /Bitte ausdrücklich wählen/); assert.doesNotMatch(html, /id="checkout-buy"/);
});
await check('market choice is independent of German exam language and is sent only after explicit selection', async () => {
  const f = fixture(); await f.session.open({ examId: 'telc-deutsch-b1' }); await f.session.loadOffer('TR');
  assert.deepEqual(f.calls.map(call => call.market), [null, 'TR']); assert.equal(f.session.snapshot().offer.currency, 'TRY');
  assert.equal(await f.session.loadOffer('US'), false); assert.equal(f.calls.length, 2);
});
await check('the API carries explicit market and one stable event ID while dropping commercial fields', async () => {
  const calls = [];
  const api = createApi({ onSessionInvalid: () => {}, fetchImpl: async (url, init) => { calls.push({ url, ...init }); return { ok: true, status: 200, json: async () => url.includes('get-session') ? { user: { id: 'owner' } } : {} }; } });
  await api.session(); await api.payments.offer('telc-deutsch-b1'); assert.equal(calls.at(-1).url, '/api/v1/checkout/offer?exam=telc-deutsch-b1');
  await api.payments.offer('telc-deutsch-b1', 'TR'); assert.match(calls.at(-1).url, /&market=TR$/);
  await api.payments.startSession({ examId: 'telc-deutsch-b1', market: 'TR', eventId: ID, amountMinor: 1, currency: 'EUR', ownerId: 'other' });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { examId: 'telc-deutsch-b1', market: 'TR', eventId: ID });
  const count = calls.length; assert.equal((await api.payments.startSession({ examId: 'x', market: 'DE' })).ok, false); assert.equal((await api.payments.offer('x', 'xx')).ok, false); assert.equal(calls.length, count);
});
await check('uncertain session creation retries the identical request and locks its market', async () => {
  const f = fixture(); await f.ready(); let first = true;
  f.reply(async kind => kind === 'start' && first ? (first = false, { ok: false, status: 502, error: 'provider_unavailable' }) : ok({ orderId: ID, checkoutUrl: ORIGIN + RETURN, testMode: true }));
  assert.equal(await f.session.start(), false); assert.equal(f.session.snapshot().mode, 'error'); assert.equal(await f.session.loadOffer('TR'), false);
  assert.match(checkoutMarkup(f.session.snapshot(), esc), /Bestellstand ist unklar/); assert.equal(await f.session.retry(), true);
  assert.deepEqual(f.calls.filter(c => c.kind === 'start').map(c => c.body), [{ examId: 'telc-deutsch-b1', market: 'DE', eventId: OTHER }, { examId: 'telc-deutsch-b1', market: 'DE', eventId: OTHER }]);
});
await check('double activation creates one request and stale responses never redirect a new preparation', async () => {
  const f = fixture(); await f.ready(); let release;
  f.reply(() => new Promise(resolve => { release = () => resolve(ok({ orderId: ID, checkoutUrl: ORIGIN + RETURN, testMode: true })); }));
  const pending = f.session.start(); assert.equal(await f.session.start(), false); f.session.dispose(); release(); assert.equal(await pending, false); assert.equal(f.redirects.length, 0);
  assert.equal(f.calls.filter(c => c.kind === 'start').length, 1);
});
await check('redirect waits for saved drafts and never navigates after a failed flush', async () => {
  let release; const f = fixture({ beforeRedirect: () => new Promise(resolve => { release = resolve; }) }); await f.ready();
  const pending = f.session.start(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.redirects.length, 0);
  release(false); assert.equal(await pending, false); assert.match(f.session.snapshot().error, /Entwurf/); assert.equal(f.redirects.length, 0);
});
await check('disposal during a draft flush prevents an otherwise successful redirect', async () => {
  let release; const f = fixture({ beforeRedirect: () => new Promise(resolve => { release = resolve; }) }); await f.ready();
  const pending = f.session.start(); await new Promise(resolve => setImmediate(resolve)); f.session.dispose(); release(true); assert.equal(await pending, false); assert.equal(f.redirects.length, 0);
});
await check('a temporarily blocked context cancels redirect but leaves the same checkout retry usable', async () => {
  let allowed = true, release;
  const f = fixture({ canContinue: () => allowed }); await f.ready();
  f.reply(() => new Promise(resolve => { release = () => resolve(ok({ orderId: ID, checkoutUrl: ORIGIN + RETURN, testMode: true })); }));
  const pending = f.session.start(); allowed = false; release(); assert.equal(await pending, false); assert.equal(f.redirects.length, 0); assert.equal(f.session.snapshot().busy, false);
  allowed = true; f.reply(async () => ok({ orderId: ID, checkoutUrl: ORIGIN + RETURN, testMode: true })); assert.equal(await f.session.retry(), true);
  const posts = f.calls.filter(call => call.kind === 'start'); assert.deepEqual(posts[0].body, posts[1].body);
});
await check('only HTTPS Stripe or the exact same-origin order-bound app return is accepted', async () => {
  assert.equal(checkoutRedirect(ORIGIN + RETURN + '&checkout=stub', ID, ORIGIN), ORIGIN + RETURN + '&checkout=stub');
  assert.equal(checkoutRedirect('https://checkout.stripe.com/c/pay/test', ID, ORIGIN), 'https://checkout.stripe.com/c/pay/test');
  for (const raw of ['javascript:alert(1)', 'http://checkout.stripe.com/c/test', 'https://checkout.stripe.com.evil.test/x', 'https://user@checkout.stripe.com/x', 'https://checkout.stripe.com:444/x', ORIGIN + '/#/checkout?order=' + ID, ORIGIN + RETURN.replace(ID, OTHER), ORIGIN + RETURN + '&order=' + ID, ORIGIN + '/other/../app/#/checkout?order=' + ID, ORIGIN + RETURN + '&next=https://bad.test', ORIGIN + RETURN + '%00', ' ' + ORIGIN + RETURN, ORIGIN + '/app/?extra=1#/checkout?order=' + ID]) assert.equal(checkoutRedirect(raw, ID, ORIGIN), null, raw);
});
await check('unsafe or unlabelled sessions expose recovery without navigation', async () => {
  for (const response of [{ orderId: ID, checkoutUrl: 'javascript:alert(1)', testMode: true }, { orderId: ID, checkoutUrl: ORIGIN + RETURN, testMode: false }]) {
    const f = fixture(); await f.ready(); f.reply(async () => ok(response)); assert.equal(await f.session.start(), false); assert.equal(f.redirects.length, 0); assert.equal(f.session.snapshot().orderId, ID); assert.equal(f.session.snapshot().retry, 'order');
  }
});
await check('terminal session replay reads the owned order instead of trusting POST status or a provider URL', async () => {
  const f = fixture(); await f.ready();
  f.reply(async kind => kind === 'start' ? ok({ orderId: ID, status: 'paid', checkoutUrl: null, testMode: true }) : ok({ order: order('pending') }));
  assert.equal(await f.session.start(), true); assert.equal(f.session.snapshot().mode, 'pending'); assert.equal(f.redirects.length, 0);
  assert.deepEqual(f.calls.slice(-2).map(call => call.kind), ['start', 'order']);
});
await check('strict auth handoff rejects arbitrary, duplicated, encoded and malformed targets', async () => {
  assert.equal(checkoutReturnPath(RETURN), RETURN); assert.equal(checkoutAuthReturn('?returnTo=' + encodeURIComponent(RETURN)), RETURN);
  assert.equal(checkoutAuthReturn('?mode=signup&returnTo=' + encodeURIComponent(RETURN + '&checkout=stub')), RETURN + '&checkout=stub');
  assert.equal(checkoutAuthReturn(''), '/app/');
  for (const path of ['//evil.test' + RETURN, 'https://evil.test' + RETURN, '/app/../app/#/checkout?order=' + ID, RETURN + '&order=' + ID, RETURN + '&returnTo=' + RETURN, RETURN.replace('checkout', 'CHECKOUT'), RETURN.replace(ID, '%31' + ID.slice(1)), RETURN + '#extra', '/app/#/checkout?order=invalid']) assert.equal(checkoutAuthReturn('?returnTo=' + encodeURIComponent(path)), '/app/', path);
  assert.equal(checkoutAuthReturn('?returnTo=' + encodeURIComponent(RETURN) + '&returnTo=' + encodeURIComponent(RETURN)), '/app/');
  assert.equal(checkoutAuthReturn('?returnTo=' + encodeURIComponent(encodeURIComponent(RETURN))), '/app/');
});
await check('public auth and app return validators agree without an authenticated module dependency', async () => {
  const documentBefore = globalThis.document, locationBefore = globalThis.location;
  globalThis.document = { body: { dataset: { page: 'probe' } } }; globalThis.location = { search: '', hash: '' };
  let auth;
  try { auth = await load('public/auth/entry.js'); } finally { globalThis.document = documentBefore; globalThis.location = locationBefore; }
  assert.equal(/import .*app\/checkout/.test(source('public/auth/entry.js')), false);
  const cases = [ ['', RETURN.slice(5)], ['', RETURN.slice(5) + '&checkout=stub'], ['?mode=signup', RETURN.slice(5)], ['?returnTo=' + encodeURIComponent(RETURN), '#/checkout?order=bad'], ['?returnTo=bad', RETURN.slice(5)], ['?returnTo=', RETURN.slice(5)], ['?returnTo=' + encodeURIComponent(RETURN) + '&returnTo=' + encodeURIComponent(RETURN), RETURN.slice(5)], ['', '#/checkout?order=bad'], ['', '//evil.test'], ['', RETURN.slice(5) + '&next=bad'] ];
  for (const [search, hash] of cases) assert.equal(auth.checkoutAuthReturn(search, hash), checkoutAuthReturn(search, hash));
  assert.equal(auth.checkoutAuthReturn('', RETURN.slice(5)), RETURN);
  assert.equal(auth.checkoutAuthReturn('?returnTo=bad', RETURN.slice(5)), '/app/');
});
await check('return routing preserves only its exact owned order request and never infers payment', async () => {
  assert.deepEqual(checkoutRoute(RETURN.slice(5)), { isCheckout: true, orderId: ID, invalid: false, path: RETURN });
  assert.equal(checkoutRoute('#/checkout?order=bad').invalid, true); assert.equal(checkoutRoute('#/checkout?order=' + ID + '&paid=1').invalid, true);
  const f = fixture(); await f.session.open({ orderId: ID }); assert.equal(f.calls[0].kind, 'order'); assert.equal(f.session.snapshot().mode, 'pending');
});
await check('orders remain readable without a preparation and for an exam other than the active one', async () => {
  const f = fixture({ reply: async () => ok({ order: order('paid') }) }); await f.session.open({ examId: 'dtz-a2-b1', orderId: ID }); assert.equal(f.session.snapshot().mode, 'paid'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, ID);
  const other = fixture({ reply: async () => ok({ order: { ...order('paid'), id: OTHER } }) }); await other.session.open({ orderId: ID }); assert.equal(other.session.snapshot().mode, 'error');
});
await check('pending polling is bounded and disposal cancels the remaining timer', async () => {
  const f = fixture(); await f.session.open({ orderId: ID });
  while (f.timers.size) { const [id, task] = f.timers.entries().next().value; f.timers.delete(id); task(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.calls.length, 6); assert.equal(f.session.snapshot().mode, 'pending'); assert.equal(f.session.snapshot().autoChecks, 5);
  const disposed = fixture(); await disposed.session.open({ orderId: ID }); assert.equal(disposed.timers.size, 1); disposed.session.dispose(); assert.equal(disposed.timers.size, 0);
});
await check('late order reads cannot replace a reopened checkout and paid appears only after owned confirmation', async () => {
  const f = fixture(); let release; f.reply(() => new Promise(resolve => { release = () => resolve(ok({ order: order('paid') })); }));
  const pending = f.session.open({ orderId: ID }); f.session.dispose(); release(); await pending; assert.equal(f.session.snapshot(), null);
});
await check('409 states and uncertain transport errors have distinct sanitized recovery copy', async () => {
  const values = ['checkout_pending', 'checkout_expired', 'event_conflict'].map(error => checkoutError({ status: 409, error }, 'start'));
  assert.equal(new Set(values).size, 3);
  for (const error of values) assert.doesNotMatch(error, /checkout_|event_conflict|Fehler 409/);
  const text = checkoutError({ status: 502, error: 'secret_provider_details' }, 'start'); assert.match(text, /unklar/); assert.doesNotMatch(text, /nichts gebucht|secret_provider_details/);
});
await check('refund and dispute states preserve truthful balance copy without claiming a clawback', async () => {
  for (const status of ['refunded', 'disputed']) { const f = fixture({ reply: async () => ok({ order: order(status) }) }); await f.session.open({ orderId: ID }); const html = checkoutMarkup(f.session.snapshot(), esc); assert.doesNotMatch(html, /nichts freigeschaltet|nicht aktiv|entfernt|entzogen/); assert.match(html, /verfügbar/); }
});
await check('legacy indefinite balance and missing counters are described without fabricated zeroes', async () => {
  const html = checkoutBalance({ allowance: 12, used: 2, reserved: 1, expiresAt: null }, esc); assert.match(html, /Ohne festes Ablaufdatum/); assert.match(html, /<dd>9<\/dd>/);
  assert.match(checkoutBalance({ allowance: 12, used: 2, expiresAt: 'bad' }, esc), /unbekannt/);
  const expired = checkoutBalance({ allowance: 12, used: 2, reserved: 1, expiresAt: '2001-01-01T00:00:00Z' }, esc);
  assert.match(expired, /Abgelaufen am/); assert.match(expired, /<dt>verfügbar<\/dt><dd>0<\/dd>/);
});
await check('all UI values are escaped and only verified test offers display an actionable buy control', async () => {
  const f = fixture(); await f.session.open({ examId: 'telc-deutsch-b1', examLabel: '<img src=x>' }); await f.session.loadOffer('DE');
  const html = checkoutMarkup(f.session.snapshot(), esc); assert.match(html, /&lt;img src=x&gt;/); assert.match(html, /Testmodus/); assert.match(html, /id="checkout-buy"/);
  const rejected = fixture({ reply: async (kind, input) => ok({ markets, offer: input.market ? { ...offer(input.market), testMode: false } : null }) }); await rejected.ready(); assert.equal(rejected.session.snapshot().mode, 'error'); assert.doesNotMatch(checkoutMarkup(rejected.session.snapshot(), esc), /id="checkout-buy"/);
});
await check('shell and auth use the strict handoff while preserving S4 writing and mock flushes', async () => {
  const shell = source('public/app/app.js'), auth = source('public/auth/entry.js');
  assert.match(auth, /location\.replace\(checkoutAuthReturn\(location\.search, location\.hash\)\)/);
  assert.match(shell, /location\.replace\(checkoutSignInPath\(\)\)/); assert.match(shell, /checkout\.open\(el\('checkout-boot-host'\), returnInfo\)/);
  assert.match(shell, /if \(info\.view !== 'checkout'\) history\.replaceState/);
  assert.match(shell, /await writing\.flush\(\) && await mock\.flush\(\) && currentContext\(ticket\)/);
  assert.match(shell, /createWritingController, writingCriterion, writingFeedbackState/);
  assert.doesNotMatch(shell, /market: 'DE'/);
});
console.log(`${passed} passed, ${failed} failed; offline synthetic checkout checks${revision ? ' against ' + revision : ''}.`);
process.exitCode = failed ? 1 : 0;
