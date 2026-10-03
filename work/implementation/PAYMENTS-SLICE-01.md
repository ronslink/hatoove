# PAYMENTS-SLICE-01 — frozen API contract and slice plan

**Prototype record, superseded for implementation:** [PAYMENTS-01](../../docs/contracts/PAYMENTS-01.md)
now governs the English technical route, explicit market selection, idempotency, test-only provider,
signature/activation requirements, database transactions, expiry and rendered acceptance. The original
draft below is preserved as design history; its pure policy checks do not establish database exactly-once behavior.

**Status: in progress.** Ron, 3 October 2026: *"start working on it since it can be done independently;
we need a frontend ui addition as well."* Provider decision: Stripe
([STRIPE-PAYMENT-PATH-01.md](STRIPE-PAYMENT-PATH-01.md)).

This file is the **contract**. The server work and the client work are independent only while these
shapes stay fixed; change them here first.

## 1. Scope of this slice

| In | Out |
| --- | --- |
| The payments **port** and a deterministic **stub adapter** (no network) | Live Stripe keys, live mode, any real charge |
| The **activation decision** — exactly-once grant, refund, dispute, failure | Prices, markets, currencies, tax rules (undecided, see STRIPE-PAYMENT-PATH-01 §7) |
| The four HTTP routes below, with the two guard exemptions | Applying anything to the live local database |
| A client **checkout view** with its real states | Rendered desktop/mobile evidence (needs the Docker stack) |

Prices stay database rows and Stripe Price ids. Nothing in this slice is file-configured, and the
client never supplies an amount.

**Authority (3 October 2026).** The earlier "no purchase UI / no live payments" stipulation is **removed**
— MASTER-PLAN **D15**, with AGENTS.md, PILOT_BUILD_PLAN.md and the design reference amended to match. What
stays gated is real money: this slice runs only against the stub, and live keys need Ron's explicit
go-ahead.

## 2. HTTP contract

All routes are JSON and sit under the existing session wrap (`/api/v1/**`) **except** the webhook.
Failures use the existing `{ error: "<token>" }` shape.

### 2.1 `GET /api/v1/checkout/offer?exam=<examId>`

```json
{ "offer": {
    "examId": "telc-deutsch-b1",
    "market": "DE",
    "currency": "EUR",
    "amountMinor": 1900,
    "displayPrice": "19,00 €",
    "termDays": 56,
    "allowance": 10,
    "productId": "telc-b1-pass-8w",
    "purchasable": true,
    "existing": null
} }
```

- `purchasable: false` with `existing: { allowance, used, reserved, expiresAt }` when an unexpired
  pass already covers the exam — the screen shows the balance instead of a buy button.
- `404 not_found` when no price row exists for the market.
- `503 payments_unavailable` when the payments port is not wired (the pilot's default).

### 2.2 `POST /api/v1/checkout/session`

Request `{ "examId": "telc-deutsch-b1", "market": "DE" }` — **no amount, no price id, no currency**.
Unknown fields are refused (`422 invalid_field`), exactly as the other mutating routes do.

- `201 { "orderId": "<uuid>", "checkoutUrl": "https://…", "expiresAt": "<iso>" }`
- `409 already_entitled` when §2.1 would have returned `purchasable: false`.
- `503 payments_unavailable` unwired; `502 provider_unavailable` when the provider call fails.

The order row is written **before** the provider call, so a crash between the two leaves a `pending`
order rather than a paid learner with no record.

**Return URL (pinned).** The provider must be given this exact shape:

```text
<publicOrigin>/#/checkout?order=<orderId>
```

The client reads a **validated UUID** from `order`, and tolerates `orderId`/`order_id` and a
pre-hash query for robustness — but the server-side adapter emits the pinned form and nothing else, so
the two cannot drift. The client deliberately does **not** remember the last order id in memory: that
memory does not survive the provider's redirect, so it could only resurface later and show a finished
purchase over an ordinary visit. Losing the id costs one "Angebot neu laden".

### 2.3 `GET /api/v1/orders/:id`

```json
{ "order": {
    "id": "<uuid>", "status": "pending|paid|failed|refunded|disputed",
    "examId": "telc-deutsch-b1", "currency": "EUR", "amountMinor": 1900,
    "createdAt": "<iso>", "paidAt": null,
    "entitlement": { "allowance": 10, "used": 0, "reserved": 0, "expiresAt": "<iso>" }
} }
```

Another owner's order is `404` — indistinguishable from absent, like every other owned route.

### 2.4 `POST /api/v1/payments/stripe/webhook`

Mounted **outside** the session wrap and **before** the same-origin guard, because Stripe sends no
session and no `Origin`. Authenticated by the signature over the raw body; nothing else.

- `200 { "received": true }` — accepted, including a duplicate (idempotent, no second grant).
- `400 invalid_signature` / `400 invalid_payload`.
- `404` for any sibling path — the exemption is one exact path, never a prefix.
- `503` when the database is not ready: a retryable answer, never a silent `200`.

## 3. Port contract (`server/payments/port.mjs`)

```js
createPaymentsPort({ mode, secretKey, webhookSecret, publicOrigin, now, fetchImpl }) => {
  configured: boolean,
  createCheckoutSession({ orderId, ownerId, examId, market, price, successUrl, cancelUrl })
    => { url, providerSessionId, expiresAt },
  verifyWebhook({ rawBody, signatureHeader }) => { id, type, data },   // throws InvalidSignature
  readEvent(event) => {
    kind: 'paid' | 'delayed_paid' | 'failed' | 'refunded' | 'disputed' | 'ignored',
    orderId, providerRef, amountMinor, currency
  }
}
```

- `mode: 'stub'` is the default and makes **no network call**; `mode: 'stripe'` is test-mode only in
  this slice and is built from the operator environment.
- `orderId` travels as the Checkout Session `client_reference_id`, so activation can find the order
  even if metadata is missing.

## 4. Activation contract (`server/payments/activation.mjs`)

Pure — no database, no clock, no network — so exactly-once is provable without PostgreSQL:

```js
decideActivation({ event, order, entitlement, now })
  => { action: 'grant' | 'extend' | 'ignore_duplicate' | 'fail_order' | 'refund' | 'dispute' | 'refuse',
       reason, grant: { allowance, termDays, expiresAt } | null }
```

Rules:

1. An event whose `orderId` matches no order is **refused**, never granted.
2. A `paid` event for an order already `paid` (or already having a grant from this provider
   reference) is `ignore_duplicate` — the second delivery of the same event, or a replayed event,
   changes nothing.
3. `delayed_paid` behaves as `paid`; a `failed` event only moves a `pending` order to `failed`.
4. `refunded` and `disputed` never grant; they set state and leave the entitlement to policy.
5. A grant always carries an explicit `expiresAt` derived from the product term — the entitlement
   model has no expiry today, which is why an eight-week pass cannot be expressed yet.

## 5. Files

| File | Owner of this slice | State |
| --- | --- | --- |
| `server/payments/signature.mjs` (Stripe-compatible HMAC, zero-dependency) | server | **done** |
| `server/payments/events.mjs` (event vocabulary and normaliser) | server | **done** |
| `server/payments/port.mjs` (mode switch, fail-closed shape) | server | **done** |
| `server/payments/stub.mjs` (deterministic, offline adapter) | server | **done** |
| `server/payments/activation.mjs` (pure exactly-once decision) | server | **done** |
| `tools/payment-path-check.mjs` + `package.json` `check` | server | **done — 11/11 legs** |
| `public/app/checkout.js`, `public/app/api.js`, `public/app/index.html`, `public/app/app.js`, `public/app/app.css` | client | **done at logic level** — 5 files, gates green; no committed check for the state branches and **no rendered evidence** yet |
| `.github/workflows/ci.yml` step | server | **deferred to the commit**: `repository-check` asserts every `node tools/….mjs` a workflow names is a *tracked* file, so the step lands with the same commit as the check |
| `server/migrations/0026-payments.sql` | server | next: needs `tools/lib/catalogue.mjs` classification and `ACCOUNT_DELETION_STEPS`, verified on a disposable database |
| `server/owned-api.mjs` routes, `server.js` guard exemptions | server | next (depends on the migration) |
| `server/payments/stripe.mjs` (zero-dependency REST adapter) | server | next (unexerciseable without test keys) |

## 6. Acceptance criteria

**Now (offline, no database):**

1. The stub port creates a session deterministically and **calls no network**.
2. A valid signature verifies; a tampered body, a wrong secret and an absent header are refused.
3. The same paid event delivered twice grants **once** — the second is `ignore_duplicate`.
4. An event for an unknown order is refused, not granted.
5. Refund and dispute events never grant.
6. A grant always carries an explicit expiry.
7. No path in the payments code writes a file, and the stub needs no provider key.

**Next (with a disposable database):** the migration applies, every new table is classified, account
deletion removes payment rows, and duplicate webhook delivery leaves exactly one grant.

## 7. What the client must not do

- Never send an amount, currency or price id — the server resolves the price from its own row.
- Never treat the `success_url` return as proof of payment; the order status is read from the API.
- Never render a buy button when `purchasable` is false or the port is unwired (`503`).
- **Never invent the market.** The buy request carries the `market` from the §2.1 offer response. The
  client's `'DE'` is a placeholder that exists only between opening the view and the offer arriving;
  the buy button cannot render before then, so a session is never created with a market the server
  did not name. A market the learner can *correct* (D9/D14) still needs a field or route — that
  remains an open decision, and this placeholder must not be mistaken for it.
