// Offline provider contract checks. Every HTTP adapter call receives an injected fetch fixture.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPaymentsPort, ProviderError, InvalidPayload, InvalidSignature } from '../server/payments/port.mjs';
import { readEvent } from '../server/payments/events.mjs';
import { decideActivation } from '../server/payments/activation.mjs';
import { verifySignature, buildSignatureHeader } from '../server/payments/signature.mjs';
import { STRIPE_API_VERSION } from '../server/payments/stripe.mjs';

const NOW = new Date('2026-10-03T12:00:00Z');
const now = () => new Date(NOW);
const timestamp = Math.floor(NOW.getTime() / 1000);
const orderId = '5f1d2c3b-4a59-4c7e-9f10-2b3c4d5e6f70';
const otherId = '8f1d2c3b-4a59-4c7e-9f10-2b3c4d5e6f70';
const secret = 'whsec_offline_fixture';
const key = 'sk_test_offlineFixture';
const publicOrigin = 'http://127.0.0.1:62591';
const configuration = { now, webhookSecret: secret, publicOrigin };
const input = () => ({ orderId, ownerId: 'synthetic-owner', examId: 'telc-deutsch-b1', market: 'DE',
  price: { stripePriceId: 'price_synthetic', amountMinor: 1900, currency: 'EUR' } });
const order = (extra = {}) => ({ id: orderId, status: 'pending', providerRef: 'cs_test_synthetic',
  paymentIntentRef: 'pi_synthetic', amountMinor: 1900, currency: 'EUR', allowance: 10, termDays: 56, ...extra });
const rawEvent = (objectExtra = {}, eventExtra = {}) => ({ id: 'evt_synthetic', type: 'checkout.session.completed', livemode: false,
  data: { object: { object: 'checkout.session', id: 'cs_test_synthetic', client_reference_id: orderId,
    metadata: { order_id: orderId }, payment_intent: 'pi_synthetic', amount_total: 1900, currency: 'eur',
    payment_status: 'paid', livemode: false, ...objectExtra } }, ...eventExtra });
const normalized = (extra = {}) => ({ ...readEvent(rawEvent()), ...extra });
// Real-shaped public example from https://docs.stripe.com/api/disputes/object; all transaction data is synthetic.
const disputeId = 'du_1MtJUT2eZvKYlo2CNaw2HvEv';
const disputeEvent = (id = disputeId) => rawEvent({}, { type: 'charge.dispute.created', data: { object: {
  object: 'dispute', id, payment_intent: 'pi_synthetic', amount: 500, currency: 'eur',
  livemode: false, metadata: { order_id: orderId },
} } });
const session = (extra = {}) => ({ id: 'cs_test_synthetic', object: 'checkout.session', mode: 'payment',
  livemode: false, client_reference_id: orderId, metadata: { order_id: orderId }, amount_total: 1900,
  currency: 'eur', status: 'open', payment_status: 'unpaid', expires_at: timestamp + 1800,
  url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic', ...extra });
const response = body => new Response(JSON.stringify(body), { status: 200 });
const stripe = (fetchImpl, extra = {}) => createPaymentsPort({ mode: 'stripe-test', secretKey: key, ...configuration, fetchImpl, ...extra });
const signed = rawBody => ({ rawBody, signatureHeader: buildSignatureHeader({ rawBody, secret, timestamp }) });
const decide = (eventExtra = {}, orderExtra = {}, entitlement = null) => decideActivation({ event: normalized(eventExtra), order: order(orderExtra), entitlement, now });
const reason = (type, expected) => error => error instanceof type && error.reason === expected;
const withUrlCredentials = base => {
  const url = new URL(base); url.username = 'synthetic'; url.password = 'synthetic'; return url.href;
};
const cases = [];
const check = (name, run) => cases.push({ name, run });

check('payment modes fail closed without breaking optional app startup', async () => {
  for (const options of [{}, { mode: 'off' }, { mode: 'stripe' }, { mode: 'unknown' }, { mode: 'stub' },
    { mode: 'stub', webhookSecret: secret }, { mode: 'stripe-test', ...configuration },
    { mode: 'stripe-test', ...configuration, secretKey: 'sk_live_refused' },
    { mode: 'stripe-test', ...configuration, secretKey: key, timeoutMs: 0 }]) {
    const port = createPaymentsPort(options);
    assert.equal(port.configured, false);
    assert.throws(() => port.createCheckoutSession(input()), reason(ProviderError, 'payments_unavailable'));
  }
  assert.equal(createPaymentsPort({ mode: 'stub', ...configuration }).configured, true);
  assert.equal(stripe(() => {}, { secretKey: 'rk_test_offlineFixture' }).configured, true);
});

check('origins reject credentials, paths and non-loopback cleartext', () => {
  for (const origin of ['https://a.test/path', withUrlCredentials('https://a.test'), 'https://a.test/?x=1',
    'https://a.test/#x', 'http://a.test', 'javascript:alert(1)', 'not-a-url']) {
    assert.equal(createPaymentsPort({ mode: 'stub', ...configuration, publicOrigin: origin }).configured, false);
  }
});

check('explicit stub binds a stable session and deep-copies its snapshot', async () => {
  let clock = NOW.getTime();
  const port = createPaymentsPort({ mode: 'stub', ...configuration, now: () => new Date(clock) });
  const first = await port.createCheckoutSession(input());
  clock += 15000;
  assert.deepEqual(await port.createCheckoutSession(input()), first);
  assert.equal(first.url, `${publicOrigin}/app/#/checkout?order=${orderId}&checkout=stub`);
  assert.match(first.providerSessionId, /^cs_test_stub_/);
  const copied = port.recordedSessions();
  copied.get(first.providerSessionId).snapshot.price.amountMinor = 1;
  assert.equal(port.recordedSessions().get(first.providerSessionId).snapshot.price.amountMinor, 1900);
  assert.equal('webhookSecret' in port, false);
  await assert.rejects(() => port.createCheckoutSession({ ...input(), market: 'FR' }), reason(InvalidPayload, 'order_snapshot_changed'));
});

check('session input requires a complete server price and explicit market', async () => {
  let calls = 0;
  const port = stripe(async () => { calls++; return response(session()); });
  for (const patch of [{ orderId: 'x' }, { ownerId: '' }, { examId: '' }, { market: undefined },
    { market: 'de' }, { price: { amountMinor: 1900, currency: 'eur' } },
    { price: { ...input().price, amountMinor: 0 } }, { price: { ...input().price, currency: 'eur' } },
    { price: { ...input().price, amountMinor: 19.5 } }, { price: { ...input().price, stripePriceId: 'not-price' } }]) {
    await assert.rejects(() => port.createCheckoutSession({ ...input(), ...patch }), InvalidPayload);
  }
  assert.equal(calls, 0);
});

check('signature authenticates exact bytes, including non-ASCII and whitespace', async () => {
  const port = createPaymentsPort({ mode: 'stub', ...configuration });
  const rawBody = Buffer.from('{ "id":"evt_synthetic", "text":"Grüße العربية" }\n');
  assert.deepEqual(await port.verifyWebhook(signed(rawBody)), JSON.parse(rawBody));
  const changed = Buffer.from(rawBody.toString().trim());
  await assert.rejects(() => port.verifyWebhook({ ...signed(rawBody), rawBody: changed }), InvalidSignature);
  assert.doesNotThrow(() => verifySignature({ ...signed(rawBody.toString()), secret, now }));
});

check('signature rejects tamper, missing configuration and timestamp skew', () => {
  const payload = '{}';
  const good = signed(payload);
  for (const patch of [{ rawBody: '{ }' }, { signatureHeader: '' }, { secret: 'whsec_wrong' },
    { secret: '' }, { rawBody: undefined }, { toleranceSeconds: 0 }, { toleranceSeconds: 301 }]) {
    assert.throws(() => verifySignature({ ...good, secret, now, ...patch }), InvalidSignature);
  }
  for (const delta of [-301, 301]) {
    const header = buildSignatureHeader({ rawBody: payload, secret, timestamp: timestamp + delta });
    assert.throws(() => verifySignature({ rawBody: payload, signatureHeader: header, secret, now }), reason(InvalidSignature, 'timestamp_out_of_tolerance'));
  }
});

check('signature accepts valid rotation and rejects non-64-hex suffixes', () => {
  const good = signed('{}');
  assert.doesNotThrow(() => verifySignature({ ...good, signatureHeader: good.signatureHeader + ',v1=' + '0'.repeat(64), secret, now }));
  assert.doesNotThrow(() => verifySignature({ ...good, signatureHeader: good.signatureHeader + ' ', secret, now }));
  for (const suffix of ['zz', '0', 'ff', '=extra']) {
    assert.throws(() => verifySignature({ ...good, signatureHeader: good.signatureHeader + suffix, secret, now }), InvalidSignature);
  }
  assert.throws(() => verifySignature({ ...good, signatureHeader: good.signatureHeader + `,t=${timestamp}`, secret, now }), InvalidSignature);
});

check('timestamp grammar excludes exponent, sign, decimal and unsafe integers', () => {
  for (const token of [String(timestamp) + '.0', '+' + timestamp, `${timestamp}e0`, '0' + timestamp, '9007199254740992']) {
    const digest = createHmac('sha256', secret).update(`${token}.{}`).digest('hex');
    assert.throws(() => verifySignature({ rawBody: '{}', signatureHeader: `t=${token},v1=${digest}`, secret, now }), InvalidSignature);
  }
});

check('UTF-8 decoding and JSON parsing occur only after authentication', async () => {
  const port = createPaymentsPort({ mode: 'stub', ...configuration });
  const malformedUtf8 = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  await assert.rejects(() => port.verifyWebhook(signed(malformedUtf8)), reason(InvalidPayload, 'invalid_json_utf8'));
  await assert.rejects(() => port.verifyWebhook({ ...signed(malformedUtf8), signatureHeader: '' }), InvalidSignature);
  await assert.rejects(() => port.verifyWebhook(signed('{bad')), InvalidPayload);
  await assert.rejects(() => port.verifyWebhook(signed('[]')), InvalidPayload);
});

check('normalization preserves exact event, order, session and intent identities', () => {
  const event = readEvent(rawEvent());
  assert.equal(event.orderId, orderId); assert.equal(event.providerRef, 'cs_test_synthetic');
  assert.equal(event.paymentIntentRef, 'pi_synthetic'); assert.equal(event.paymentStatus, 'paid');
  assert.equal(event.livemode, false); assert.equal(event.amountMinor, 1900);
  assert.equal(event.currency, 'EUR');
  assert.throws(() => readEvent(rawEvent({ metadata: { order_id: otherId } })), InvalidPayload);
  assert.throws(() => readEvent(rawEvent({ client_reference_id: '' })), InvalidPayload);
  assert.throws(() => readEvent(rawEvent({ payment_intent: 'cs_test_wrong' })), InvalidPayload);
  assert.throws(() => readEvent(rawEvent({ object: 'charge' })), InvalidPayload);
  assert.throws(() => readEvent(rawEvent({ id: 'cs_live_wrong' })), InvalidPayload);
  assert.throws(() => readEvent(rawEvent({}, { id: '' })), InvalidPayload);
  assert.equal(readEvent(rawEvent({}, { type: 'customer.created' })).kind, 'ignored');
});

check('pending order with its saved session grants; settled orders never grant again', () => {
  const first = decide();
  assert.equal(first.action, 'grant');
  assert.deepEqual(first.grant, { allowance: 10, termDays: 56, expiresAt: '2026-11-28T12:00:00.000Z' });
  for (const status of ['paid', 'failed', 'refunded', 'disputed']) {
    assert.equal(decide({ id: 'evt_other' }, { status }).action, 'ignore_duplicate');
  }
  assert.equal(decide({ kind: 'delayed_paid', type: 'checkout.session.async_payment_succeeded' }).action, 'grant');
});

check('unpaid, live, missing-money and wrong-identity events cannot grant', () => {
  for (const paymentStatus of ['unpaid', 'no_payment_required', null, undefined]) {
    assert.equal(decide({ paymentStatus }).reason, 'payment_not_settled');
  }
  for (const livemode of [true, null, undefined]) assert.equal(decide({ livemode }).reason, 'non_test_event');
  for (const amountMinor of [null, undefined, 0, -1, 19.1, '1900', NaN, Infinity]) assert.equal(decide({ amountMinor }).action, 'refuse');
  for (const patch of [{ orderId: otherId }, { providerRef: 'cs_test_other' }, { paymentIntentRef: 'pi_other' },
    { paymentIntentRef: null }, { amountMinor: 1901 }, { currency: 'usd' }, { currency: null },
    { kind: 'delayed_paid' }, { id: '' }]) assert.equal(decide(patch).action, 'refuse');
  assert.equal(decide({}, { providerRef: null }).reason, 'session_mismatch');
});

check('event and object must both explicitly identify test mode', () => {
  for (const [objectPatch, eventPatch] of [[{ livemode: true }, {}], [{ livemode: undefined }, {}], [{}, { livemode: true }], [{}, { livemode: undefined }]]) {
    assert.equal(decideActivation({ event: readEvent(rawEvent(objectPatch, eventPatch)), order: order(), now }).reason, 'non_test_event');
  }
});

check('expiry policy preserves input counters and extends only unexpired finite terms', () => {
  const entitlement = { allowance: 20, used: 12, reserved: 3, expiresAt: '2026-11-01T12:00:00Z' };
  const copy = structuredClone(entitlement);
  const renewal = decide({}, {}, entitlement);
  assert.equal(renewal.action, 'extend'); assert.equal(renewal.grant.expiresAt, '2026-12-27T12:00:00.000Z');
  assert.deepEqual(entitlement, copy);
  assert.equal(decide({}, {}, { ...entitlement, expiresAt: NOW.toISOString() }).action, 'grant');
  assert.equal(decide({}, {}, { ...entitlement, expiresAt: null }).action, 'grant');
  assert.equal(decide({}, {}, { ...entitlement, expiresAt: 'invalid' }).action, 'refuse');
  for (const patch of [{ allowance: undefined }, { allowance: -1 }, { termDays: 0 }, { termDays: 1.5 }, { termDays: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(decide({}, patch).action, 'refuse');
  }
});

check('delayed failure changes only pending matching orders', () => {
  const failure = { kind: 'failed', type: 'checkout.session.async_payment_failed', paymentStatus: 'unpaid' };
  assert.equal(decide(failure).action, 'fail_order');
  assert.equal(decide(failure, { status: 'paid' }).action, 'ignore_duplicate');
  assert.equal(decide({ ...failure, providerRef: 'cs_test_other' }).action, 'refuse');
});

check('refunds bind payment intent and distinguish partial from full refund', () => {
  const raw = rawEvent({}, { type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_synthetic',
    payment_intent: 'pi_synthetic', amount: 1900, amount_refunded: 500, currency: 'eur', livemode: false } } });
  const partial = readEvent(raw);
  assert.equal(partial.providerRef, 'ch_synthetic'); assert.equal(partial.orderId, ''); assert.equal(partial.fullRefund, false);
  assert.deepEqual(decideActivation({ event: partial, order: order({ status: 'paid' }), now }), { action: 'ignore', reason: 'partial_refund', grant: null });
  const full = { ...partial, amountRefunded: 1900, fullRefund: true };
  assert.equal(decideActivation({ event: full, order: order(), now }).action, 'refund');
  for (const patch of [{ paymentIntentRef: 'pi_other' }, { orderId: otherId }, { amountRefunded: 1901 }, { fullRefund: false }]) {
    assert.equal(decideActivation({ event: { ...full, ...patch }, order: order(), now }).action, 'refuse');
  }
  assert.equal(decideActivation({ event: full, order: order({ paymentIntentRef: null }), now }).reason, 'payment_intent_unbound');
});

check('real-shaped Stripe du disputes normalize and activate without a grant', () => {
  const event = readEvent(disputeEvent());
  assert.equal(event.providerRef, disputeId);
  assert.equal(event.kind, 'disputed');
  assert.deepEqual(decideActivation({ event, order: order({ status: 'paid' }), now }), { action: 'dispute', reason: 'provider_dispute', grant: null });
  assert.equal(decideActivation({ event: { ...event, amountMinor: 1901 }, order: order(), now }).action, 'refuse');
});

check('invented dp dispute identifiers fail normalization and policy independently', () => {
  const wrongId = disputeId.replace(/^du_/, 'dp_');
  assert.throws(() => readEvent(disputeEvent(wrongId)), reason(InvalidPayload, 'invalid_provider_object'));
  const event = { ...readEvent(disputeEvent()), providerRef: wrongId };
  assert.deepEqual(decideActivation({ event, order: order({ status: 'paid' }), now }), {
    action: 'refuse', reason: 'invalid_provider_reference', grant: null,
  });
});

check('Stripe request binds price, German learner locale, metadata and stable idempotency', async () => {
  const calls = [];
  const port = stripe(async (url, options) => { calls.push({ url, options }); return response(session()); });
  const first = await port.createCheckoutSession(input());
  assert.deepEqual(await port.createCheckoutSession(input()), first);
  assert.equal(calls.length, 2);
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions'); assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error'); assert.equal(options.headers['Stripe-Version'], STRIPE_API_VERSION);
  assert.equal(options.headers['Idempotency-Key'], `hatoove-checkout-${orderId}`);
  assert.equal(options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('line_items[0][price]'), 'price_synthetic'); assert.equal(body.get('line_items[0][quantity]'), '1');
  assert.equal(body.get('mode'), 'payment'); assert.equal(body.get('locale'), 'de');
  for (const key of ['adaptive_pricing[enabled]', 'automatic_tax[enabled]', 'allow_promotion_codes']) assert.equal(body.get(key), 'false');
  assert.equal(body.get('success_url'), `${publicOrigin}/app/#/checkout?order=${orderId}`);
  assert.equal(body.get('cancel_url'), body.get('success_url'));
  assert.equal(body.get('client_reference_id'), orderId);
  for (const key of ['metadata[order_id]', 'payment_intent_data[metadata][order_id]']) assert.equal(body.get(key), orderId);
  assert.equal(body.has('amount'), false); assert.equal(body.has('payment_method_types[0]'), false);
  assert.equal('secretKey' in port, false);
});

check('Stripe responses reject live sessions, mismatched snapshot and expired identity', async () => {
  for (const patch of [{ livemode: true }, { livemode: undefined }, { id: 'cs_live_bad' },
    { object: 'payment_intent' }, { client_reference_id: otherId }, { metadata: {} },
    { amount_total: null }, { amount_total: 1901 }, { currency: 'usd' }, { mode: 'subscription' },
    { status: 'expired' }, { payment_status: 'no_payment_required' }, { expires_at: timestamp }, { expires_at: 'tomorrow' }]) {
    await assert.rejects(() => stripe(async () => response(session(patch))).createCheckoutSession(input()), ProviderError);
  }
});

check('Stripe redirects are bounded to the exact HTTPS checkout host', async () => {
  for (const url of ['http://checkout.stripe.com/x', 'https://checkout.stripe.com.evil.test/x',
    withUrlCredentials('https://checkout.stripe.com/x'), 'https://checkout.stripe.com:444/x', 'javascript:alert(1)', '/app/#/checkout']) {
    await assert.rejects(() => stripe(async () => response(session({ url }))).createCheckoutSession(input()), reason(ProviderError, 'invalid_checkout_url'));
  }
});

check('provider failures are sanitized and bounded without reading error bodies', async () => {
  const failurePorts = [stripe(async () => { throw new Error(`private provider body ${key}`); }),
    stripe(async () => new Response(`private ${key}`, { status: 500 })),
    stripe(async () => new Response('{bad', { status: 200 })),
    stripe(async () => new Response(' '.repeat(65537), { status: 200 }))];
  for (const port of failurePorts) await assert.rejects(() => port.createCheckoutSession(input()), error => {
    assert.ok(error instanceof ProviderError); assert.ok(!String(error).includes(key)); return true;
  });
  let aborted = false;
  const port = stripe(async (_, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }, { timeoutMs: 15 });
  await assert.rejects(() => port.createCheckoutSession(input()), reason(ProviderError, 'provider_timeout'));
  assert.equal(aborted, true);
});

check('Stripe and stub share verified-byte webhook behavior', async () => {
  const port = stripe(async () => { throw new Error('webhook must not fetch'); });
  const rawBody = Buffer.from(JSON.stringify(rawEvent()));
  assert.equal(port.readEvent(await port.verifyWebhook(signed(rawBody))).paymentStatus, 'paid');
  await assert.rejects(() => port.verifyWebhook({ ...signed(rawBody), rawBody: Buffer.from('{}') }), InvalidSignature);
});

const realFetch = globalThis.fetch;
let unexpectedNetworkCalls = 0;
globalThis.fetch = () => { unexpectedNetworkCalls++; throw new Error('real HTTP is forbidden in payment checks'); };
let failed = 0;
try {
  for (const { name, run } of cases) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
} finally { globalThis.fetch = realFetch; }
assert.equal(unexpectedNetworkCalls, 0, 'a payment check attempted real HTTP');

// Optional historical discrimination is read-only and never part of shallow-clone CI.
const compareBase = process.argv.find(arg => arg.startsWith('--compare-base='))?.split('=')[1];
if (compareBase) {
  assert.match(compareBase, /^[0-9a-f]{7,40}$/);
  const oldSource = name => execFileSync('git', ['show', `${compareBase}:server/payments/${name}.mjs`], { encoding: 'utf8' });
  const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const oldEvents = moduleUrl(oldSource('events'));
  const oldPolicy = await import(moduleUrl(oldSource('activation').replace("'./events.mjs'", JSON.stringify(oldEvents))));
  const oldSignature = await import(moduleUrl(oldSource('signature')));
  const regressions = [
    ['saved pending session grants', policy => assert.equal(policy({ event: normalized(), order: order(), now }).action, 'grant')],
    ['unpaid must explicitly refuse', policy => assert.equal(policy({ event: normalized({ paymentStatus: 'unpaid' }), order: order(), now }).action, 'refuse')],
    ['live must explicitly refuse', policy => assert.equal(policy({ event: normalized({ livemode: true }), order: order(), now }).action, 'refuse')],
    ['missing amount must explicitly refuse', policy => assert.equal(policy({ event: normalized({ amountMinor: null }), order: order(), now }).action, 'refuse')],
    ['wrong order must explicitly refuse', policy => assert.equal(policy({ event: normalized({ orderId: otherId }), order: order(), now }).action, 'refuse')],
  ];
  for (const [name, assertion] of regressions) {
    assertion(decideActivation);
    assert.throws(() => assertion(oldPolicy.decideActivation), `old source unexpectedly passes: ${name}`);
    console.log(`DISCRIMINATES ${name}`);
  }
  const hexAssertion = verify => assert.throws(() => verify({ ...signed('{}'), signatureHeader: signed('{}').signatureHeader + 'zz', secret, now }));
  hexAssertion(verifySignature);
  assert.throws(() => hexAssertion(oldSignature.verifySignature));
  console.log('DISCRIMINATES malformed hexadecimal signature suffix');
}
const disputeBase = process.argv.find(arg => arg.startsWith('--compare-dispute-base='))?.split('=')[1];
if (disputeBase) {
  assert.match(disputeBase, /^[0-9a-f]{7,40}$/);
  const oldSource = name => execFileSync('git', ['show', `${disputeBase}:server/payments/${name}.mjs`], { encoding: 'utf8' });
  const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const eventUrl = moduleUrl(oldSource('events'));
  const priorEvents = await import(eventUrl);
  const priorPolicy = await import(moduleUrl(oldSource('activation').replace("'./events.mjs'", JSON.stringify(eventUrl))));
  const normalizedDispute = readEvent(disputeEvent());
  assert.equal(normalizedDispute.providerRef, disputeId);
  assert.equal(decideActivation({ event: normalizedDispute, order: order({ status: 'paid' }), now }).action, 'dispute');
  assert.throws(() => priorEvents.readEvent(disputeEvent()), error => error.reason === 'invalid_provider_object');
  assert.deepEqual(priorPolicy.decideActivation({ event: normalizedDispute, order: order({ status: 'paid' }), now }), {
    action: 'refuse', reason: 'invalid_provider_reference', grant: null,
  });
  const priorInventedEvent = priorEvents.readEvent(disputeEvent(disputeId.replace(/^du_/, 'dp_')));
  assert.equal(priorPolicy.decideActivation({ event: priorInventedEvent, order: order({ status: 'paid' }), now }).action, 'dispute');
  console.log(`DISCRIMINATES ${disputeBase}: real du dispute rejected by prior normalizer and prior policy`);
}
console.log(`${cases.length - failed}/${cases.length} payment checks passed; unexpected HTTP calls: ${unexpectedNetworkCalls}`);
if (failed) process.exitCode = 1;
