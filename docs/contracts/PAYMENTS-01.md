# Payments implementation contract

Execution: **PAYMENTS-01-20261003-A**, 3 October 2026. Coordinator: local root.
Base: reviewed S4 `c2e2163ff02deabe95367742b8bb21769f720d74` (PR 114 is still unmerged because hosted CI could not start).
This contract supersedes conflicting prototype details in PAYMENTS-SLICE-01.

## Scope and language

Complete the one-time payment path with an optional provider port, test-only Stripe adapter,
PostgreSQL orders/event receipts/grants, owned HTTP routes, expiry enforcement and checkout UI.
Code, technical route names, comments, logs, documentation and coordination are English.
Required German learner interface copy and exam content retain their specified languages.
The technical route is `/app/#/checkout`; no exam language determines a purchasing market.

Default payment mode is `off`. `stub` is explicit and requires a supplied webhook secret and public
origin. `stripe-test` accepts only test credentials and refuses live events/sessions. No live mode,
provider calls, real keys, real charges, production operations or migration of learner data are
part of this execution. Synthetic fixtures demonstrate the path; they are not commercial offers.
Prices, markets, currencies, allowance, term, tax display and refund policy remain owner decisions.
No commercial rows are seeded in a normal installation. Existing pilot records and balances survive.
Runtime configuration is `PAYMENTS_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the existing
`B1PREP_PUBLIC_ORIGIN`. Safe offer/session/order DTOs carry `testMode:true`; the UI labels the test flow.

## HTTP interface

All responses use existing JSON and Fault conventions. Except for the exact webhook POST,
routes require the verified session, existing account-context guard, same-origin mutations and
bounded JSON bodies. No owner, amount, currency, price ID or provider secret is accepted from a browser.
Payments are an optional capability; an unwired port disables only payment routes with
`503 payments_unavailable`.

* `GET /api/v1/checkout/offer?exam=<examId>[&market=<XX>]` returns
  `{ markets: [{ market, currency }], offer: null | { examId, market, currency, amountMinor,
  displayPrice, termDays, allowance, productId, purchasable, existing } }`.
  Omitted market lists configured choices and returns a null offer. The learner explicitly selects
  a market, even if only one exists. No configured offer, disabled/unknown exam or unconfigured market
  returns `404 not_found`. An available legacy or paid balance makes `purchasable:false` with
  `existing:{allowance,used,reserved,expiresAt}`; an exhausted or expired balance permits purchase.
  Purchasable exams must be available under the runtime exam catalogue; internal DTZ is not a public offer.
* `POST /api/v1/checkout/session` accepts exactly `{examId,market,eventId}` (UUID eventId) and returns
  `201 {orderId,checkoutUrl,expiresAt}`. Snapshot the server's active offer before calling the provider.
  A repeat event with the same inputs resumes the same order; changed inputs return `409 event_conflict`.
  A terminal replay returns the same 201 order ID with `status`, `checkoutUrl:null`, historical
  `expiresAt` and `testMode:true`. The client reads that owned order immediately; it never navigates
  a finished external checkout or treats this POST response alone as activation proof.
  Concurrent requests for the same owner/exam reuse the matching pending order, or return
  `409 checkout_pending` for different market terms. Never open two unresolved sessions for that exam.
  `409 already_entitled` means a usable balance already exists. `502 provider_unavailable` is an
  uncertain provider outcome, never proof that no purchase was created. Retry the existing order with
  the same provider idempotency key; do not hold a database transaction across a network call.
  Expired/unrecoverable pending sessions fail closed with `409 checkout_expired`; their rows remain
  auditable. A separate recovery policy is required before automatic replacement sessions are enabled.
* `GET /api/v1/orders/:id` returns `{order:{id,status,examId,currency,amountMinor,createdAt,paidAt,
  entitlement}}`. Status is `pending|paid|failed|refunded|disputed`.
  Another owner's order and a nonexistent order both return 404. Do not expose raw provider events,
  secrets, emails or another owner's records. Order reads remain available when new purchases are off.
* `POST /api/v1/payments/stripe/webhook` is the only payment auth/origin exemption. Read the bounded
  exact raw UTF-8 body, verify signature and timestamp before parsing/normalizing, then transact.
  Invalid signature/payload: 400; oversized body: 413; unavailable persistence: 503.
  Authentic irrelevant, duplicate or permanently refused events: 200 after durable disposition.
  Transient database failures remain retryable 5xx. All sibling paths/methods retain normal guards.

The provider return URL is exactly `<publicOrigin>/app/#/checkout?order=<uuid>`; the stub may add
`&checkout=stub`. Return and cancel URLs do not prove payment. The client validates UUIDs and reads
owned order status. Redirects accept only HTTPS `checkout.stripe.com` or an exact same-origin
`/app/` checkout return bound to that order. No user-derived host or open redirect.

## Provider boundary

`createPaymentsPort({mode,secretKey,webhookSecret,publicOrigin,now,fetchImpl})` exposes
`configured`, `mode`, `createCheckoutSession`, `verifyWebhook` and `readEvent`.
`createCheckoutSession({orderId,ownerId,examId,market,price})` returns
`{url,providerSessionId,expiresAt}`. Price is the persisted server snapshot including
`stripePriceId,amountMinor,currency`. Bind order ID in client_reference_id, session metadata and
payment_intent_data metadata. Send quantity 1, mode payment, explicit German learner locale (`de`) and
an order-based Idempotency-Key. Pin the API version and reject non-test provider responses.
Do not log provider bodies or credentials. A bounded request timeout and sanitized errors are required.

Normalized events contain `id,type,kind,orderId,providerRef,paymentIntentRef,amountMinor,currency,
paymentStatus,livemode`. Recognize completed and async success only when `payment_status=paid`;
unpaid/no-payment-required are not grants in this slice. Require well-formed event/session identity,
`livemode:false`, an exact order ID/session binding, amount and currency on grants.
Refund/dispute events use payment intent plus server-set order metadata to find and cross-check the
order; never equate a charge/dispute ID with a Checkout Session ID. Missing mappings on an otherwise
authentic refund/dispute remain retryable until binding is available; do not permanently discard an
early reversal and then grant its later success. Partial refunds are recorded, not presented as a full refund.

`decideActivation({event,order,entitlement,now})` is pure policy, not an exactly-once guarantee.
It must reject absent money, mismatched identity/reference/currency, live or unpaid events.
A session reference already saved on a pending order is its expected identity, not a duplicate grant.
Refund/dispute/failure never grant. Record these facts without inventing a balance-clawback policy;
learner copy must not claim access was removed or never granted when it was previously granted.

## PostgreSQL and expiry

Add forward migration **0028-payments.sql**; never modify released migrations.
Use shared product/market-price tables, owner-scoped orders, event receipts and unique per-order
grant ledger entries. Orders snapshot commercial terms. Foreign keys, FORCE RLS, restricted role
grants and explicit transaction locks must enforce ownership and prevent browser-side grants.
Use a dedicated restricted payments role, not learner, worker, auth, provisioner or migration authority.
Normal runtime never migrates. Update persistent and disposable pool wiring and classification checks.

Signed event handling atomically locks the order/balance, writes the unique event receipt, updates
the order and records one grant. Unique event IDs and unique grant order IDs cover redelivery,
different successful events for one session, concurrency and crash/retry. Refuse a session/provider
reference bound to another order. Deletion and payment locks must have a consistent order, and
account deletion must prevent a late webhook from recreating any owner record.
Include owned payment rows in account export/deletion and prove RLS with two synthetic owners.
Raw provider payloads are not stored; retain only normalized necessary disposition fields.

Add nullable `expires_at` to the existing exam-scoped entitlement. Null preserves the existing
pilot's validity. A finite expiry blocks new submission/retry/mock-writing reservations at or after
expiry, without blocking saved work reads or completion of an already reserved assessment.
Expose expiry in credits and checkout responses. A grant after expiry sets allowance to
`used + reserved + purchased allowance`, preserving counters and excluding unused expired units.
An unexpired renewal adds purchased allowance and extends from existing finite expiry; legacy
indefinite allowance is not silently erased by migration. No reset or cross-exam refill.

## Evidence and open gates

Required: provider and activation negatives; raw-body HTTP guard checks; real PostgreSQL upgrade,
RLS, concurrent replay/exactly-once, rollback, expiry and deletion tests; desktop/mobile rendered
checkout states, delayed confirmation, error recovery, safe redirects and saved-draft navigation.
Run applicable retained S4/telc contracts and the repository's seven offline baseline checks.
Verify new regression checks discriminate against the old implementation. Independent review must
come from an agent other than the author. Hosted CI, merge and product acceptance are separate.
Commercial/legal/security human review, genuine Stripe sandbox integration and physical-device
keyboard/audio evidence remain explicit gates beyond synthetic implementation evidence.
