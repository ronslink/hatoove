/**
 * PAYMENTS-SLICE-01 — the offline payments check.
 *
 * WHAT IT PROVES, and why each leg exists:
 *
 *   1. the stub adapter is deterministic and makes NO network call (proved by removing `fetch`);
 *   2. webhook signature verification discriminates — valid, tampered, wrong secret, absent, stale;
 *   3. exactly-once activation: the same paid event delivered twice grants ONCE;
 *   4. an event for an unknown order is refused, never granted;
 *   5. an event that disagrees with the order about the money is refused;
 *   6. refunds and disputes never grant;
 *   7. a grant always carries an explicit expiry, and a second purchase extends rather than replaces;
 *   8. the port fails closed: `off` refuses to sell, and `stripe` refuses to pretend;
 *   9. no payments module touches the filesystem and the stub needs no provider key.
 *
 * It needs no database, no provider key and no network, so it belongs in the offline baseline. The
 * PostgreSQL half of the contract — the migration, the table classification and the single-grant
 * transaction — is a separate acceptance step recorded in work/implementation/PAYMENTS-SLICE-01.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createPaymentsPort, ProviderError, InvalidPayload } from '../server/payments/port.mjs';
import { createStubPayments } from '../server/payments/stub.mjs';
import { verifySignature, signPayload, InvalidSignature } from '../server/payments/signature.mjs';
import { readEvent } from '../server/payments/events.mjs';
import { decideActivation } from '../server/payments/activation.mjs';

const MODULES = ['signature.mjs', 'events.mjs', 'port.mjs', 'stub.mjs', 'activation.mjs'];
const FIXED_NOW = () => new Date('2026-10-03T12:00:00.000Z');
const ORDER_ID = '5f1d2c3b-4a59-4c7e-9f10-2b3c4d5e6f70';

/** A paid provider event, exactly as `readEvent` would normalise one. */
function paidEvent(overrides = {}) {
  return {
    id: 'evt_paid_1', type: 'checkout.session.completed', kind: 'paid',
    orderId: ORDER_ID, providerRef: 'cs_stub_1', amountMinor: 1900, currency: 'eur',
    ...overrides,
  };
}

/** A pending order with its purchased snapshot. */
function order(overrides = {}) {
  return {
    id: ORDER_ID, status: 'pending', amountMinor: 1900, currency: 'eur',
    allowance: 10, termDays: 56, providerRef: null,
    ...overrides,
  };
}

// Legs are collected and then run in order with `await`, because several of them are async and a
// synchronous runner would record them as passing before their assertions had run at all.
const legs = [];
function leg(name, fn) { legs.push({ name, fn }); }

/* ---------------------------------------------- 1. the stub: deterministic, offline --------------- */

leg('stub adapter is deterministic and never touches the network', async () => {
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls += 1; throw new Error('the payments stub must not use the network'); };
  try {
    const port = createPaymentsPort({ mode: 'stub', now: FIXED_NOW, publicOrigin: 'http://localhost:4300' });
    assert.equal(port.configured, true, 'a stub port must report itself configured');
    assert.equal(port.mode, 'stub');

    const price = { amountMinor: 1900, currency: 'eur', priceId: 'price_test_1' };
    const first = await port.createCheckoutSession({ orderId: ORDER_ID, ownerId: 'owner-1', examId: 'telc-deutsch-b1', price });
    const second = await port.createCheckoutSession({ orderId: ORDER_ID, ownerId: 'owner-1', examId: 'telc-deutsch-b1', price });
    assert.deepEqual(first, second, 'the same order must produce the same session');
    assert.equal(first.providerSessionId, `cs_stub_${ORDER_ID}`);
    assert.ok(first.url.includes(ORDER_ID), 'the return url must name the order');

    // The price the provider was given is the server-resolved one, and it is recorded.
    const recorded = port.recordedSessions().get(first.providerSessionId);
    assert.equal(recorded.amountMinor, 1900);
    assert.equal(recorded.clientReferenceId, ORDER_ID);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(networkCalls, 0, 'the stub made a network call');
  return 'no fetch call, stable ids';
});

leg('the stub refuses a session without a server-resolved price', async () => {
  const port = createPaymentsPort({ mode: 'stub', now: FIXED_NOW });
  await assert.rejects(() => port.createCheckoutSession({ orderId: ORDER_ID }), InvalidPayload,
    'a missing price must be refused, never defaulted');
  await assert.rejects(
    () => port.createCheckoutSession({ orderId: ORDER_ID, price: { amountMinor: '19.00', currency: 'eur' } }),
    InvalidPayload, 'a non-integer amount must be refused');
  await assert.rejects(() => port.createCheckoutSession({ price: { amountMinor: 1900, currency: 'eur' } }),
    InvalidPayload, 'an order id is required');
  return 'missing or malformed price refused';
});

/* ---------------------------------------------- 2. signature verification ------------------------- */

leg('signature verification accepts only a valid, fresh signature', async () => {
  const port = createPaymentsPort({ mode: 'stub', now: FIXED_NOW });
  const rawBody = JSON.stringify({ id: 'evt_paid_1', type: 'checkout.session.completed', data: { object: { client_reference_id: ORDER_ID } } });
  const good = port.signForTest(rawBody);

  const event = await port.verifyWebhook({ rawBody, signatureHeader: good });
  assert.equal(event.type, 'checkout.session.completed');

  // Tampered body: the signature was computed for different bytes.
  await assert.rejects(
    () => port.verifyWebhook({ rawBody: rawBody.replace(ORDER_ID, 'another-order'), signatureHeader: good }),
    InvalidSignature, 'a tampered body must be refused');

  // Absent and malformed headers.
  await assert.rejects(() => port.verifyWebhook({ rawBody, signatureHeader: '' }), InvalidSignature);
  await assert.rejects(() => port.verifyWebhook({ rawBody, signatureHeader: 'nonsense' }), InvalidSignature);

  // A signature made with a different secret — the wrong-environment case. The timestamp is the
  // valid one, so the refusal is specifically a mismatch and not our own staleness window.
  const ts = Math.floor(FIXED_NOW().getTime() / 1000);
  const other = signPayload({ rawBody, secret: 'whsec_somewhere_else', timestamp: ts });
  await assert.rejects(
    () => port.verifyWebhook({ rawBody, signatureHeader: `t=${ts},v1=${other}` }),
    (error) => error instanceof InvalidSignature && error.reason === 'signature_mismatch',
    'a signature from another secret must be refused as a mismatch');

  // Stale: outside the tolerance window.
  const stale = port.signForTest(rawBody, Math.floor(FIXED_NOW().getTime() / 1000) - 4000);
  await assert.rejects(() => port.verifyWebhook({ rawBody, signatureHeader: stale }), InvalidSignature,
    'a stale signature must be refused');

  // An empty secret must never make an attacker-supplied signature verifiable.
  assert.throws(() => verifySignature({ rawBody, signatureHeader: good, secret: '', now: FIXED_NOW }),
    InvalidSignature, 'an unconfigured secret must fail closed');
  return 'valid, tampered, absent, wrong-secret, stale, unconfigured';
});

/* ---------------------------------------------- 3. exactly once ----------------------------------- */

leg('the same paid event delivered twice grants exactly once', () => {
  const event = paidEvent();
  const first = decideActivation({ event, order: order(), now: FIXED_NOW });
  assert.equal(first.action, 'grant');
  assert.deepEqual(first.grant, { allowance: 10, termDays: 56, expiresAt: '2026-11-28T12:00:00.000Z' });

  // The order is now paid; the identical event arrives again (Stripe retry, or a manual resend).
  const second = decideActivation({ event, order: order({ status: 'paid', providerRef: 'cs_stub_1' }), now: FIXED_NOW });
  assert.equal(second.action, 'ignore_duplicate');
  assert.equal(second.grant, null, 'a duplicate must carry no grant');
  // The REASON is asserted, not just the action: two different guards can both answer
  // `ignore_duplicate`, and a leg that accepts either cannot tell "this order was already paid"
  // from "this order is not pending", which is the distinction the code is making.
  assert.equal(second.reason, 'order_already_paid', 'the refusal must name why it refused');

  // The same provider session seen under a NEW event id — a resend after the order was re-read, or a
  // second subscription delivery. Still one purchase.
  const replay = decideActivation({
    event: paidEvent({ id: 'evt_paid_other_id' }), order: order({ providerRef: 'cs_stub_1' }), now: FIXED_NOW,
  });
  assert.equal(replay.action, 'ignore_duplicate');
  assert.equal(replay.reason, 'provider_reference_reused');
  assert.equal(replay.grant, null, 'a reused provider reference must not grant again');
  return 'grant then ignore_duplicate, by event id and by provider reference';
});

leg('a second purchase extends the remaining term instead of replacing it', () => {
  const active = { allowance: 10, used: 4, reserved: 0, expiresAt: '2026-11-01T12:00:00.000Z' };
  const decision = decideActivation({ event: paidEvent({ id: 'evt_paid_2' }), order: order(), entitlement: active, now: FIXED_NOW });
  assert.equal(decision.action, 'extend');
  // 2026-11-01 plus 56 days, NOT 2026-10-03 plus 56 days.
  assert.equal(decision.grant.expiresAt, '2026-12-27T12:00:00.000Z');

  const expired = { ...active, expiresAt: '2026-09-01T12:00:00.000Z' };
  const regrant = decideActivation({ event: paidEvent({ id: 'evt_paid_3' }), order: order(), entitlement: expired, now: FIXED_NOW });
  assert.equal(regrant.action, 'grant', 'an expired pass starts a new term from now');
  return 'extend from the remaining time, regrant after expiry';
});

/* ---------------------------------------------- 4. refusals --------------------------------------- */

leg('an event for an unknown order is refused, never granted', () => {
  const decision = decideActivation({ event: paidEvent(), order: null, now: FIXED_NOW });
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.reason, 'unknown_order');
  assert.equal(decision.grant, null);

  const noId = decideActivation({ event: paidEvent({ id: '' }), order: order(), now: FIXED_NOW });
  assert.equal(noId.action, 'refuse');
  assert.equal(noId.reason, 'event_without_id', 'without an idempotency key nothing may be granted');
  return 'unknown order and missing event id refused';
});

leg('an event that disagrees with the order about the money is refused', () => {
  const amount = decideActivation({ event: paidEvent({ amountMinor: 100 }), order: order(), now: FIXED_NOW });
  assert.equal(amount.action, 'refuse');
  assert.equal(amount.reason, 'amount_mismatch');

  const currency = decideActivation({ event: paidEvent({ currency: 'usd' }), order: order(), now: FIXED_NOW });
  assert.equal(currency.action, 'refuse');
  assert.equal(currency.reason, 'currency_mismatch');

  const noTerms = decideActivation({ event: paidEvent(), order: order({ allowance: undefined }), now: FIXED_NOW });
  assert.equal(noTerms.action, 'refuse');
  assert.equal(noTerms.reason, 'order_missing_allowance', 'a snapshot-less order must not be granted');
  return 'amount, currency and missing snapshot refused';
});

leg('refunds and disputes never grant', () => {
  for (const kind of ['refunded', 'disputed']) {
    const decision = decideActivation({ event: paidEvent({ kind, id: `evt_${kind}` }), order: order({ status: 'paid' }), now: FIXED_NOW });
    assert.equal(decision.action, kind === 'refunded' ? 'refund' : 'dispute');
    assert.equal(decision.grant, null, `${kind} must never carry a grant`);
  }
  // A delayed failure only fails an order that is still waiting.
  const failPending = decideActivation({ event: paidEvent({ kind: 'failed', id: 'evt_failed' }), order: order(), now: FIXED_NOW });
  assert.equal(failPending.action, 'fail_order');
  const failPaid = decideActivation({ event: paidEvent({ kind: 'failed', id: 'evt_failed' }), order: order({ status: 'paid' }), now: FIXED_NOW });
  assert.equal(failPaid.action, 'ignore_duplicate', 'a paid order is never un-paid by a later failure');
  return 'refund, dispute, delayed failure';
});

leg('an unrelated event type is ignored rather than treated as an error', () => {
  assert.equal(readEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } }).kind, 'ignored');
  const decision = decideActivation({ event: readEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } }), order: order(), now: FIXED_NOW });
  assert.equal(decision.action, 'ignore');
  // And the normaliser maps the types we act on.
  assert.equal(readEvent({ id: 'e', type: 'checkout.session.completed', data: { object: {} } }).kind, 'paid');
  assert.equal(readEvent({ id: 'e', type: 'checkout.session.async_payment_succeeded', data: { object: {} } }).kind, 'delayed_paid');
  assert.equal(readEvent({ id: 'e', type: 'charge.refunded', data: { object: {} } }).kind, 'refunded');
  assert.equal(readEvent({ id: 'e', type: 'charge.dispute.created', data: { object: {} } }).kind, 'disputed');
  // `client_reference_id` wins over metadata, and metadata is the fallback.
  assert.equal(readEvent({ id: 'e', type: 'checkout.session.completed', data: { object: { client_reference_id: 'o1', metadata: { order_id: 'o2' } } } }).orderId, 'o1');
  assert.equal(readEvent({ id: 'e', type: 'checkout.session.completed', data: { object: { metadata: { order_id: 'o2' } } } }).orderId, 'o2');
  return 'unknown ignored, known mapped, order resolution ordered';
});

/* ---------------------------------------------- 5. fail closed ------------------------------------ */

leg('the port fails closed when it is not configured', async () => {
  const off = createPaymentsPort({ mode: 'off' });
  assert.equal(off.configured, false);
  assert.equal(off.reason, 'payments_off');
  // `async () =>` matters: the unconfigured port throws synchronously, and `assert.rejects` treats a
  // synchronous throw from a plain function as the assertion itself failing.
  await assert.rejects(async () => off.createCheckoutSession({}),
    (error) => error instanceof ProviderError && error.reason === 'payments_unavailable');
  await assert.rejects(async () => off.verifyWebhook({ rawBody: '{}', signatureHeader: 'x' }),
    (error) => error instanceof ProviderError && error.reason === 'payments_unavailable');

  const unknown = createPaymentsPort({ mode: 'something-else' });
  assert.equal(unknown.configured, false);

  // The Stripe adapter is deliberately absent: pretending would be worse than refusing.
  assert.throws(() => createPaymentsPort({ mode: 'stripe' }),
    (error) => error instanceof ProviderError && error.reason === 'stripe_adapter_not_built');
  return 'off refuses to sell, stripe refuses to pretend';
});

/* ---------------------------------------------- 6. no files, no keys ------------------------------- */

leg('no payments module reads or writes a file, and the stub needs no provider key', () => {
  const dir = new URL('../server/payments/', import.meta.url);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort(), [...MODULES].sort(),
    'the payments module list changed — update this check deliberately');
  for (const file of MODULES) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.ok(!/from 'node:fs|from 'node:fs\/promises|require\('node:fs|readFile|writeFile/.test(source),
      `${file} must not touch the filesystem: the money path is API and database only`);
    assert.ok(!/\bfetch\s*\(/.test(source), `${file} must not use the network in the stub path`);
  }
  // The stub is constructible with no key at all, which is what the pilot relies on.
  const port = createStubPayments({ now: FIXED_NOW });
  assert.equal(port.configured, true);
  assert.equal(typeof port.webhookSecret, 'string');
  return `${MODULES.length} modules scanned, stub keyless`;
});

/* ---------------------------------------------- report -------------------------------------------- */

let failed = 0;
for (const entry of legs) {
  try {
    const detail = await entry.fn();
    console.log(`PASS ${entry.name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${entry.name} — ${error && error.message ? error.message : String(error)}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${legs.length} payments leg(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nOK: ${legs.length}/${legs.length} payments legs passed — the stub is offline, the signature discriminates, and one paid event grants once.`);
}
