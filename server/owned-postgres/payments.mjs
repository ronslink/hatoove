import { randomUUID } from 'node:crypto';
import { Fault } from '../owned-api.mjs';
import { createExamCatalogue } from '../preparation-contract.mjs';
import { decideActivation } from '../payments/activation.mjs';
import { InvalidSignature, InvalidPayload } from '../payments/port.mjs';
import { entitlementDto, entitlementExpired } from './entitlement.mjs';
import { readCurrentReleaseEligibility } from './release-eligibility.mjs';

const fail = (status, code) => { throw new Fault(status, code); };
const first = result => result.rows[0];
const iso = value => value == null ? null : new Date(value).toISOString();
const usable = (row, now) => row && !entitlementExpired(row, now) && row.allowance > row.used + row.reserved;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trusted provider service. It never uses provider-supplied ownership or commercial terms. */
export function createPostgresPayments({ pool, provider, publicOrigin, examCatalogue = createExamCatalogue(),
  now = () => new Date(), activation = decideActivation, afterGrant = null } = {}) {
  if (!pool?.connect) throw new TypeError('payments pool required');
  const enabled = () => { if (!provider?.configured) fail(503, 'payments_unavailable'); };
  const ownerLock = (client, owner) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7352))', [owner]);
  async function transaction(owner, work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (owner) {
        await client.query("SELECT set_config('hatoove.owner_id',$1,true)", [owner]);
        await ownerLock(client, owner);
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function balance(client, owner, examId) {
    return first(await client.query('SELECT * FROM entitlements WHERE owner_id=$1 AND exam_id=$2 FOR UPDATE', [owner, examId]));
  }
  async function prices(client, examId) {
    if (!examCatalogue.ids.includes(examId)) fail(404, 'not_found');
    return (await client.query(`SELECT p.id AS product_id,p.exam_id,p.allowance,p.term_days,q.*
      FROM payment_product p JOIN payment_price q ON q.product_id=p.id
      WHERE p.exam_id=$1 AND p.active AND q.active ORDER BY q.market,p.id`, [examId])).rows;
  }
  function chosen(rows, market) {
    const selected = rows.filter(row => row.market === market);
    if (selected.length !== 1) fail(404, 'not_found');
    return selected[0];
  }
  function safeCheckout(row) {
    if (row.status !== 'pending') return { orderId:row.id,status:row.status,checkoutUrl:null,
      expiresAt:iso(row.session_expires_at),testMode:true };
    if (new Date(row.session_expires_at ?? row.created_at).getTime() <= now().getTime()) {
      fail(409, 'checkout_expired');
    }
    return { orderId: row.id, checkoutUrl: row.checkout_url, expiresAt: iso(row.session_expires_at), testMode: true };
  }
  function validUrl(value, orderId) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      if (url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password && !url.port) return true;
      const base = new URL(publicOrigin);
      return url.origin === base.origin && url.pathname === '/app/' && !url.search &&
        (url.hash === `#/checkout?order=${orderId}` || url.hash === `#/checkout?order=${orderId}&checkout=stub`);
    } catch { return false; }
  }
  return Object.freeze({
    async offer(owner, { examId, market }) {
      enabled();
      return transaction(owner, async client => {
        if (!(await readCurrentReleaseEligibility(client, examId, { catalogue: examCatalogue, lock: true })).eligible) fail(404, 'not_found');
        const rows = await prices(client, examId);
        if (!rows.length) fail(404, 'not_found');
        const markets = rows.map(({ market, currency }) => ({ market, currency }));
        if (!market) return { markets, offer: null, testMode: true };
        const price = chosen(rows, market), existing = await balance(client, owner, examId);
        return { markets, testMode: true, offer: { examId, market, currency: price.currency,
          amountMinor: price.amount_minor, displayPrice: price.display_price, termDays: price.term_days,
          allowance: price.allowance, productId: price.product_id, purchasable: !usable(existing, now().getTime()),
          existing: entitlementDto(existing), testMode: true } };
      });
    },
    async checkout(owner, { examId, market, eventId }) {
      enabled();
      const order = await transaction(owner, async client => {
        // Deletion takes the same owner gate before removing the FK anchor.
        if (!first(await client.query('SELECT id FROM "user" WHERE id=$1', [owner]))) fail(404, 'not_found');
        const previous = first(await client.query(`SELECT o.* FROM payment_checkout_event e
          JOIN payment_order o ON o.id=e.order_id WHERE e.owner_id=$1 AND e.event_id=$2`, [owner, eventId]));
        if (previous) {
          if (previous.exam_id !== examId || previous.market !== market) fail(409, 'event_conflict');
          return previous;
        }
        const price = chosen(await prices(client, examId), market);
        if (usable(await balance(client, owner, examId), now().getTime())) fail(409, 'already_entitled');
        let row = first(await client.query("SELECT * FROM payment_order WHERE owner_id=$1 AND exam_id=$2 AND status='pending' FOR UPDATE", [owner, examId]));
        if (row) {
          if (['market','product_id','currency','amount_minor','allowance','term_days','stripe_price_id'].some(key => row[key] !== price[key])) fail(409, 'checkout_pending');
          safeCheckout(row);
        } else {
          // Existing receipts and pending orders are continuations; only a new order is admitted here.
          if (!(await readCurrentReleaseEligibility(client, examId, { catalogue: examCatalogue, lock: true })).eligible) fail(404, 'not_found');
          row = first(await client.query(`INSERT INTO payment_order(id,owner_id,exam_id,product_id,market,currency,
            amount_minor,display_price,stripe_price_id,allowance,term_days,session_expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [randomUUID(),owner,examId,price.product_id,market,price.currency,price.amount_minor,price.display_price,
            price.stripe_price_id,price.allowance,price.term_days,new Date(now().getTime()+30*60*1000)]));
        }
        await client.query('INSERT INTO payment_checkout_event(owner_id,event_id,order_id) VALUES($1,$2,$3)', [owner,eventId,row.id]);
        return row;
      });
      safeCheckout(order);
      if (order.checkout_url || order.status !== 'pending') return safeCheckout(order);
      let session;
      try {
        session = await provider.createCheckoutSession({ orderId: order.id, ownerId: owner, examId, market,
          price: { stripePriceId: order.stripe_price_id, amountMinor: order.amount_minor, currency: order.currency } });
      } catch { fail(502, 'provider_unavailable'); }
      if (!session || typeof session.providerSessionId !== 'string' || !/^cs_test_[A-Za-z0-9_]+$/.test(session.providerSessionId)
        || !validUrl(session.url, order.id) || !Number.isFinite(Date.parse(session.expiresAt))
        || Date.parse(session.expiresAt) <= now().getTime()) fail(502, 'provider_unavailable');
      return transaction(owner, async client => {
        const row = first(await client.query('SELECT * FROM payment_order WHERE id=$1 AND owner_id=$2 FOR UPDATE', [order.id,owner]));
        if (!row) fail(404, 'not_found');
        safeCheckout(row);
        if (row.provider_ref && row.provider_ref !== session.providerSessionId) fail(502, 'provider_unavailable');
        if (row.provider_ref) return safeCheckout(row);
        if (!row.provider_ref) {
          const other = first(await client.query('SELECT id FROM payment_order WHERE provider_ref=$1', [session.providerSessionId]));
          if (other && other.id !== row.id) fail(502, 'provider_unavailable');
          await client.query(`UPDATE payment_order SET provider_ref=$2,checkout_url=$3,session_expires_at=$4 WHERE id=$1`,
            [row.id,session.providerSessionId,session.url,session.expiresAt]);
        }
        return safeCheckout({ ...row, checkout_url: session.url, session_expires_at: session.expiresAt });
      });
    },
    async order(owner, id) {
      return transaction(owner, async client => {
        const row = first(await client.query('SELECT * FROM payment_order WHERE id=$1 AND owner_id=$2', [id,owner]));
        if (!row) fail(404, 'not_found');
        return { order: { id: row.id, status: row.status, examId: row.exam_id, currency: row.currency,
          amountMinor: row.amount_minor, createdAt: iso(row.created_at), paidAt: iso(row.paid_at),
          entitlement: entitlementDto(await balance(client,owner,row.exam_id)), testMode: true }, testMode: true };
      });
    },
    async webhook(raw, signature) {
      enabled();
      let event;
      try {
        const verified = await provider.verifyWebhook({ rawBody: raw, signatureHeader: signature });
        event = provider.readEvent(verified);
      } catch (error) {
        if (error instanceof InvalidSignature || error instanceof InvalidPayload) fail(400, 'invalid_webhook');
        fail(503, 'payments_unavailable');
      }
      if (!event || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]+$/.test(event.id)) fail(400, 'invalid_webhook');
      try {
        return await transaction(null, async client => {
          // Event serialization precedes owner serialization; deletion never takes an event lock.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7353))', [event.id]);
          if (first(await client.query('SELECT id FROM payment_event WHERE id=$1', [event.id]))) return { received: true };
          let order = uuid.test(event.orderId ?? '') ? first(await client.query('SELECT * FROM payment_order WHERE id=$1', [event.orderId])) : null;
          if (!order && !event.orderId && event.paymentIntentRef && ['refunded','disputed'].includes(event.kind)) {
            order = first(await client.query('SELECT * FROM payment_order WHERE payment_intent_ref=$1', [event.paymentIntentRef]));
            if (order) event = { ...event, orderId: order.id };
          }
          if (!order && event.livemode === false && event.paymentIntentRef && ['refunded','disputed'].includes(event.kind)) fail(503, 'payment_binding_pending');
          if (order) {
            await ownerLock(client, order.owner_id);
            await client.query("SELECT set_config('hatoove.owner_id',$1,true)", [order.owner_id]);
            // Account deletion may have removed it while the owner gate was awaited.
            order = first(await client.query('SELECT * FROM payment_order WHERE id=$1 FOR UPDATE', [order.id]));
          }
          let decision;
          const refund = ['refunded','disputed'].includes(event.kind);
          if (order && event.livemode === false && refund && event.paymentIntentRef && !order.payment_intent_ref) fail(503, 'payment_binding_pending');
          if (order && event.livemode === false && !refund && !order.provider_ref && event.kind !== 'ignored') fail(503, 'payment_binding_pending');
          const existing = order ? await balance(client,order.owner_id,order.exam_id) : null;
          const mismatch = order && (refund ? event.paymentIntentRef !== order.payment_intent_ref : event.providerRef !== order.provider_ref);
          if (event.livemode !== false || mismatch) decision = { action: 'refuse', reason: 'identity_mismatch' };
          else decision = activation({ event, order: order ? { id: order.id, status: order.status, amountMinor: order.amount_minor,
            currency: order.currency, allowance: order.allowance, termDays: order.term_days,
            providerRef: order.provider_ref, paymentIntentRef: order.payment_intent_ref } : null, entitlement: entitlementDto(existing), now });
          if (['grant','extend'].includes(decision.action)) {
            // Defense in depth: pure policy is not the persistence/identity boundary.
            if (!order || order.status !== 'pending' || event.paymentStatus !== 'paid'
              || event.amountMinor !== order.amount_minor || event.currency !== order.currency
              || !/^pi_[A-Za-z0-9_]+$/.test(event.paymentIntentRef ?? '')) decision = { action:'refuse', reason:'invalid_grant' };
            else if (first(await client.query('SELECT id FROM payment_order WHERE payment_intent_ref=$1 AND id<>$2', [event.paymentIntentRef,order.id]))) {
              decision = { action:'refuse', reason:'payment_intent_reused' };
            }
          }
          await client.query('INSERT INTO payment_event(id,owner_id,order_id,kind,disposition) VALUES($1,$2,$3,$4,$5)',
            [event.id,order?.owner_id??null,order?.id??null,event.kind??'ignored',`${decision.action}:${decision.reason}`]);
          if (['grant','extend'].includes(decision.action)) {
            const old = entitlementDto(existing), expired = entitlementExpired(existing,now().getTime());
            const allowance = !old ? order.allowance : (expired ? old.used+old.reserved : old.allowance)+order.allowance;
            const expiresAt = old && old.expiresAt === null ? null : decision.grant.expiresAt;
            await client.query(`INSERT INTO entitlements(owner_id,exam_id,allowance,used,reserved,expires_at) VALUES($1,$2,$3,0,0,$4)
              ON CONFLICT(owner_id,exam_id) DO UPDATE SET allowance=EXCLUDED.allowance,expires_at=EXCLUDED.expires_at`,
            [order.owner_id,order.exam_id,allowance,expiresAt]);
            await client.query('INSERT INTO payment_grant(order_id,owner_id,event_id,exam_id,allowance,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
              [order.id,order.owner_id,event.id,order.exam_id,order.allowance,expiresAt]);
            await client.query("UPDATE payment_order SET status='paid',paid_at=$2,payment_intent_ref=$3 WHERE id=$1", [order.id,now(),event.paymentIntentRef]);
            if (afterGrant) await afterGrant(client,order);
          } else if (order && ['fail_order','refund','dispute'].includes(decision.action)) {
            await client.query('UPDATE payment_order SET status=$2 WHERE id=$1', [order.id,{fail_order:'failed',refund:'refunded',dispute:'disputed'}[decision.action]]);
          }
          return { received: true };
        });
      } catch (error) { if (error instanceof Fault) throw error; fail(503,'payments_unavailable'); }
    },
  });
}
