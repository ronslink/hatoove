# STRIPE-PAYMENT-PATH-01 — Stripe as the payment provider (proposal)

**Implementation update:** [PAYMENTS-01](../../docs/contracts/PAYMENTS-01.md), execution
PAYMENTS-01-20261003-A / issue 115, governs the current bounded work. Migration 0028 follows the
reviewed S4 migration 0027. Earlier migration numbers and prototype details below are historical.
Commercial values remain undecided; only synthetic fixtures contain example prices.

**Status: adopted as direction (Ron, 3 October 2026); the provider-agnostic port layer is built and
checked, the schema and routes are next, and no keys exist.** The former "no purchase UI / no live
payments" stipulation has been **removed** from [AGENTS.md](../../AGENTS.md),
[PILOT_BUILD_PLAN.md](../../PILOT_BUILD_PLAN.md), [MASTER-PLAN.md](../../MASTER-PLAN.md) (**D15**) and the
design reference. What remains authorization-only is **charging real money**: live keys and live mode need
Ron's explicit go-ahead, and P-03 (legal/privacy) still gates a public offer. This record exists so the next
bounded slice can be specified against a real decision instead of a mockup.

Recorded decision, verbatim:

> Ron, 3 October 2026: "we will be using stripe as the payment method."

## 1. What this changes, and what it does not

`upgrade.html` in the design reference named Stripe already, and its README previously said *"No checkout in
the pilot. Invite-only with a configured allowance."* — **amended 3 October 2026** to put checkout in scope
while keeping the commercial terms open (`work/design-reference/README.md:32`). That note was about
**pixels**, not about the provider choice. Naming Stripe settles the provider; it settles none of the
commercial terms.

Still undecided and required before a price can be displayed: market list, currencies, price
amounts, term length, allowance per pass, tax display, refund wording. See §7.

## 2. Where this sits in the existing plan

| Plan item | What it already says |
| --- | --- |
| [INTEGRATIONS-01.md](INTEGRATIONS-01.md):55 | *"Payments / entitlement — a provider port plus an owned ledger — and this is the thing that bounds the inference cost"* |
| [INTEGRATIONS-01.md](INTEGRATIONS-01.md):97-98 | each external integration is *"one port, a stub for development, a real adapter"* |
| [INTEGRATIONS-01.md](INTEGRATIONS-01.md):119-123 | *"payments are in scope with Stripe as the provider … built and tested in the provider's test mode until live keys are authorized"* |
| [MASTER-PLAN.md](../../MASTER-PLAN.md) PILOT-16 | payments behind one port, stubbed for development, *"needs R5/R10 and owner authorization"* |
| [MASTER-PLAN.md](../../MASTER-PLAN.md) PILOT-20 | entitlements keyed by `(owner_id, exam_id, term)` plus a product/price record (only `exam_id` landed, in 0023) |
| [MASTER-PLAN.md](../../MASTER-PLAN.md) D14 + **D15** | per-exam pass **with a term, sold through Stripe**; the "free with a configured allowance" half is superseded (3 October 2026) |
| [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md):222-223 | P-01/P-02 acceptance: test-mode purchases store price/currency/market; the learner can inspect and correct market and price; P-03 is the legal gate |

So Stripe is the **real adapter behind the payments port that was already planned** — not a new
architecture. The stub-first rule still applies.

## 3. Proposed Stripe shape

**Stripe-hosted Checkout, one-time payment.** Hosted Checkout keeps card data off our origin
(SAQ A scope), handles SCA/3DS, wallets and local methods, and needs no client-side framework —
which matters because the client is vanilla modules under `public/app/`.

- `mode: 'payment'` — one-off prepaid pass, matching the *"one payment · no subscription"* mock.
  No Stripe subscription objects: the term is our own entitlement expiry, not recurring billing.
- `line_items[0][price]` = a Stripe Price id from our server-side catalogue, so the client can never
  choose its own price.
- `client_reference_id` = our `order.id`; `metadata` = owner, exam package, term, market.
- `success_url` = our origin with `{CHECKOUT_SESSION_ID}`; `cancel_url` = the offer page.
- Taxes and localized prices are supported by Checkout; which one we use is a decision (§7).

**Activation is webhook-first.** Stripe's own guidance is that fulfillment cannot rely on the landing
page — a learner can pay and lose the connection before it loads — and delayed-notification payment
methods only settle after the session completes. The landing page may *additionally* trigger
fulfillment for a faster screen, but the webhook is the source of truth.

Events to handle:

| Event | Action |
| --- | --- |
| `checkout.session.completed` | fulfill if `payment_status != 'unpaid'` |
| `checkout.session.async_payment_succeeded` | fulfill for delayed methods (SEPA/ACH-style) |
| `checkout.session.async_payment_failed` | mark the order failed, tell the learner |
| `charge.refunded` / `refund.updated` | record the refund; expire or claw back the unused allowance per policy |
| `charge.dispute.created` | flag the order, stop granting, surface for support |

**Fulfillment must be safe to run more than once, even concurrently, for the same session.** Stripe
retries deliveries and events can be re-sent manually. The idempotency key is the Stripe event id
(and, behind it, the Checkout Session id), enforced by a unique constraint — not by application
checks. Exactly-once grant is a database property.

## 4. Repo-specific constraints this path must satisfy

Verified in the current code; each one is a real failure mode, not a style preference.

1. **The same-origin guard rejects webhooks.** `server.js:605-609` refuses every non-`GET`/`HEAD`
   API request whose `Origin` does not match. Stripe sends no `Origin` header, so the endpoint must
   be handled *before* that check. This exemption is the single most security-sensitive line in the
   slice: it must be limited to one exact path and must be authenticated by the signature instead.
2. **The session wrap rejects webhooks.** Everything except `/api/health` and `/api/ready` requires
   a verified session (`server.js:636-667`). The webhook must be mounted outside that wrap, or no
   Stripe call would ever authenticate.
3. **Signature verification needs the raw body.** `readBody` (`server.js:175-191`) concatenates
   chunks and `toString('utf8')`. Verification is HMAC over the exact received payload, so the
   handler must use those bytes and must never re-serialize the JSON before verifying.
4. **Readiness fails closed.** While the database is not ready, non-liveness routes answer `503`
   (`server.js:615-620`). A webhook during an outage should return a retryable status (not a
   silent `200`), and the fulfillment transaction must be replayable.
5. **Checkout waits on the webhook.** For hosted Checkout with a `success_url`, Stripe waits up to
   10 seconds for the response to `checkout.session.completed` before redirecting. The handler must
   be fast: record the event and commit the grant; do not call the Stripe API recursively and do not
   render anything.
6. **Keys stay server-side.** The provider-key rule already applies (server configuration, never
   settable or readable from a browser). The Stripe secret key and the webhook signing secret are
   the same class of secret: server environment only, never in the repository, never in the image,
   never in learner-visible responses. Only `.env.example` placeholders may be committed.
7. **CI stays offline.** The gates in `npm run check` make no network calls. Stripe is checked
   against the stub adapter and fixture events; nothing in the offline or PostgreSQL check set may
   call Stripe, and no test card may reach a live account.
8. **Schema changes go through forward migrations.** The runtime never migrates and holds no
   migration credentials; the ledger checksums frozen migrations. New tables arrive as numbered
   migrations with the runtime left read-only over the schema.
9. **Deletion must revoke.** Hard-deleting an account settles its ledger and revokes access
   ([INTEGRATIONS-01.md](INTEGRATIONS-01.md):82). The deletion path needs the payment records
   included, and we should store Stripe identifiers rather than any personal or card data.

## 5. Data model this needs (all new, none built)

| Object | Purpose | Notes |
| --- | --- | --- |
| `product` | what is sold: exam package + term + allowance | server-controlled, never client-chosen |
| `market_price` | product × market × currency → amount, tax behavior, Stripe Price id | the price catalogue the plan already names |
| `order` | one purchase attempt: owner, product, market, price/currency **snapshot**, `stripe_checkout_session_id` (unique), payment intent, status (`pending`/`paid`/`failed`/`refunded`/`disputed`), `paid_at` | snapshot is what the learner agreed to pay |
| `payment_event` | `stripe_event_id` primary key, type, order, received/processed timestamps | the idempotency ledger |
| `entitlement` | existing `(owner_id, exam_id, allowance, used, reserved)` **plus term/expiry and the granting order** | today there is no `term` and no `expires_at`, so an eight-week pass cannot be expressed |

The debit path itself does not change: reservation at submit, debit on success, refund on failure
already exist and are exam-scoped. A purchase only *adds* allowance for a term.

## 6. Smallest honest first slice (for the coordinator to assign)

1. Payments **port** with a stub adapter and the event/idempotency contract — no Stripe call, fully
   checkable offline (this is the part INTEGRATIONS-01 already authorized).
2. `order`, `payment_event` and `entitlement` term columns as forward migrations, plus a check that
   a duplicate activation grants exactly once.
3. Stripe adapter in **test mode only**, behind the port, with signature verification and the
   single-path guard exemptions; local testing through the Stripe CLI.
4. The three session routes and the checkout screen, exercised end to end in the provider's **test mode**
   behind a configuration switch — an installation with no payment configuration still renders "not
   available" rather than a dead buy button.

Explicitly **not** in the slice: live keys, a public buy button, price display, tax configuration and
any production authorization.

## 7. Decisions only Ron can make

1. **Markets and currencies**: which countries are on sale at launch, and is the price list per
   market in local currency?
2. **Tax**: does Stripe Tax compute VAT, and are displayed prices tax-inclusive (the normal EU B2C
   presentation)? This changes the product page and the receipt.
3. **Term and allowance**: pass duration (the eight-week hypothesis) and how many writing
   assessments it includes; what the free tier grants.
4. **Products**: one pass per exam (D14) — and are telc and DTZ separately purchasable, or is DTZ
   included?
5. **Refunds and withdrawal**: the withdrawal/refund window and wording (the mock says 14 days), and
   whether a refund claws back remaining credits or only stops future access.
6. **Stripe account**: which legal entity owns the account, who holds dashboard access, and which
   test account the work is developed against.
7. **Activation**: is the pilot's buy button visible at all, or is Stripe built dark until P-03 and
   the content gates close?

## 8. The money path is API and database, never a file

Ron, 3 October 2026: *"we need to move away from file based architecture — the application is web
based so we should have an api solution to effect payments; this is no longer a one user app."*

That is already the state of the runtime, and payments must not regress it:

- Learner state has no file path at all. `/api/progress`, its account selector and its
  one-generation backup are retired, and `/data/**` is refused for everybody
  (`server.js:694-721`). The reason is recorded in the file: a file store cannot exist on a platform
  with an ephemeral filesystem (`server.js:46`).
- The retirement is **negatively checked**, not merely documented:
  `tools/retired-surface-check.mjs` fails if the file store or the retired client reappears, and
  asserts that `public/js` holds the owned API client and nothing else.
- The filesystem holds no learner state. Across `server.js` and the 25 modules under `server/`, the
  only file reads are: `.env` (operator configuration) and static assets, both in `server.js`; the
  frozen migration `.sql` files the migration engine applies and hashes (`provision.mjs`,
  `bootstrap.mjs`); and the one-off importer that seeds the database from the authored `content/`
  tree (`package-importer.mjs`). Not one of them reads or writes a learner record, order,
  entitlement or assessment — those exist only as PostgreSQL rows.
- The corpus is already database-resident and API-served: the image deliberately does not contain
  `data/`, and the client has no `fetch('/data/…')` — `public/app/api.js` is the only place that
  knows a URL.

The payment path therefore looks like this, and nothing else:

| Step | Surface | Durable state |
| --- | --- | --- |
| Learner opens the offer | `GET /api/v1/checkout/offer` (session-authenticated) | `product` + `market_price` **rows**, read server-side |
| Learner starts a purchase | `POST /api/v1/checkout/session` (session-authenticated) | `order` row with the price/currency snapshot; the price is never accepted from the client |
| Stripe finishes the payment | `POST /api/v1/payments/stripe/webhook` (no session; signature-verified) | one transaction: `payment_event` (idempotency), `order` state, entitlement grant, ledger row |
| Learner sees the result | `GET /api/v1/orders/:id` (session-authenticated) | read from PostgreSQL |
| Learner asks for a refund | operator action in Stripe + `charge.refunded` → `order` state and allowance per policy | PostgreSQL |

Two rules follow, both learned from this repository's own history:

1. **No commercial fact is file-configured.** The retired `/api/config` wrote `EXAM_DATE` into the
   shared `.env` for every visitor (`server.js:526`) — the exact shape a price or allowance must
   never take. Which products are on sale, in which market, at which price and with which allowance
   are `market_price` rows, so a purchase can be audited against the row it was sold from.
2. **Only the provider secrets are configuration.** The Stripe secret key and the webhook signing
   secret belong in the operator environment, in the same class as the model provider key: server
   side only, never learner-settable or learner-readable, never in the image.

This also fixes an existing gap in the same spirit: the current sign-up allowance is a code default
(`10`, `server/owned-postgres/fixture.mjs:43`), not an operator setting and not a priced product.
Once a pass is sold, the allowance must come from the purchased product row and be granted by the
same ledgered transaction that activates the order.

## 9. Sources

- [Fulfill orders after payment](https://docs.stripe.com/payments/checkout/fulfill-orders) — webhook-first fulfillment, `checkout.session.completed`, `async_payment_succeeded`/`async_payment_failed`, "make this function safe to run multiple times, even concurrently", the 10-second wait on `success_url`, idempotent fulfillment keyed on the Checkout Session.
- [Webhook endpoint](https://docs.stripe.com/webhooks) — signature verification with the raw body and endpoint secret, `400` on invalid signature, retries and manual resend.
- [Stripe-hosted checkout page](https://docs.stripe.com/checkout/quickstart?lang=node) — `mode=payment`, `line_items[0][price]`, `success_url` with `{CHECKOUT_SESSION_ID}`.
