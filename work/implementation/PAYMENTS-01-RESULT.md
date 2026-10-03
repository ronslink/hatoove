# PAYMENTS-01 implementation evidence

Execution **PAYMENTS-01-20261003-A**, 3 October 2026; [issue115](https://github.com/ronslink/hatoove/issues/115). Implemented and independently reviewed; hosted CI, merge and product acceptance are separate. The candidate is based on reviewed S4 c2e2163 (PR114 is still unmerged); integration source787d151 plus the reviewed screenshot-positioning correction. Subsequent closeout changes are documentation only.

## Delivered behavior

The optional payment path uses a server-owned product/market price snapshot, durable checkout intent, strict owned order reads, exact raw-byte signed webhooks and atomic receipt/order/credit grants. A completed but unpaid checkout never activates access. Concurrent and repeated success deliveries grant once. Early unmapped refund/dispute events remain retryable; partial refund, full refund and dispute records do not invent a credit-clawback policy. A corrected real-shaped Stripe `du_` dispute is tested through the HTTP server and restricted PostgreSQL role.

The new checkout uses an explicit purchasing-market choice, stable retry identity, safe hosted URLs, strict sign-in return, saved-draft navigation, owned confirmation, truthful uncertain/refund states and a visible test-mode label. Delayed responses respect keyboard focus moved outside checkout. Exam package, exam language, instruction language and market remain separate. Code, routes, comments, logs and technical records are English; required German learner copy remains German.

Forward migration0028 seeds no commercial offers, preserves legacy indefinite balances and introduces finite expiry. Expiry blocks new reservations while saved work and already-reserved completion survive. Payments use a dedicated restricted role; owned export/deletion includes the payment ledger, and a late event cannot recreate a deleted learner.

## Independent review

| Slice | Author commit | Review |
| --- | --- | --- |
| Provider | 53e64ff, corrected ecb2b4c | Author-separated source approval; wrong dispute prefix repaired;23 focused checks and old-source discrimination |
| Backend | 0b5885f | Coordinator independent source inspection and actual local-PC OpenClaw source review/recheck; no remaining actionable findings |
| Signed dispute test | 19e8c22 | Separate test-delta approval; real HTTP/raw signature/PG and old-provider failure evidence inspected |
| Client | 57c6e8e, corrected4f9f7fe | Author-separated approval; stale focus restoration repaired;28 checks, old version fails exactly the new negative |
| Integration | 787d151 and instant-scroll test delta | Separate reviewer approved wiring, API/CI contracts, retained checks, browser isolation and reported evidence |

Local OpenClaw is the installed local Clawdbot CLI, actually invoked in bounded read-only sessions. Its initial concern about malformed events was withdrawn after source and primary-documentation review: unknown event types have durable ignored receipts, while malformed known payloads return400 as specified. [Stripe documents failed delivery retries and invalid-payload handling](https://docs.stripe.com/webhooks). An additional database test proves the distinction. Raw agent reports and source-discrimination logs remain in the ignored coordinator handoff/QA records.

## Validation

| Check | Result |
| --- | --- |
| Provider/signature/policy |23/23; zero unexpected HTTP calls |
| Payment owned API/raw HTTP boundary |5/5 |
| Checkout client |28/28; focus regression fails against57c6e8e |
| Payment PostgreSQL |18/18, synthetic isolated database |
| Payment rendered journey |14/14 |
| Retained default telc rendered journey |199/199 |
| Docker Compose/runtime |37/37, including OpenAPI47/47 |
| Retained S4 / S3 / S1 PostgreSQL |17/17;10/10;11/11 |
| Account deletion |20/20 |
| Submission preservation |9/9 PostgreSQL;7/7 offline |
| Table-class mutation checks |11/11 |
| Workflow-shape checks |12/12; CI/OpenAPI YAML parsed independently |
| Offline baseline |Repository guard, design14, retired surface10, origin8, keymask14, owned API34 and owned client32 pass; two existing design warnings retained |

The seven-command offline baseline and the focused payment scripts are wired into the existing CI jobs; the payment browser is a local Docker/browser acceptance check, not a pull-request gate. Root staged guard at787d151 screened547 tracked files/460 text blobs; final closeout is screened again before push.

Evidence is preserved under the ignored local `.qa/payments-20261003/` directory: `root-final-payment-offline.log`, `root-final-payments-pg-check.mjs.log`, retained check logs, `root-default-browser.log`, `root-docker-stack.log` and `root-payment-browser-final.log`. Final screenshots are in `browser-final-framing/`, including1440px desktop and390/320px light/dark offers, pending/paid, sign-in return, network-error, refund and unavailable states. Frames show the actual scrollable mobile layout; viewport screenshots are not physical-device evidence.

The browser fixture uses a source-only copy, fresh profiles, explicit synthetic credentials/prices/webhook secret, free loopback ports and its own Compose project. Initial harness-only failures (hidden focus target and cleanup method) were repaired; the complete rerun passes. Screenshots were then positioned deterministically and the14 checks passed again. The older S1 expected DTO now asserts `expiresAt:null`; retained S3/S4 migration expectations include0028; export checks assert ownership for all four payment exports. No security assertion was removed.

## Limits and next action

Payment mode defaults to `off`; optional modes are explicit `stub` and `stripe-test`. No real keys, charges, Stripe API requests, production publication, DNS changes or learner-runtime/data migration occurred. Synthetic fixtures do not validate actual Stripe account configuration or SCA/local payment methods. Empty catalogue, undecided prices/markets/currencies/terms/tax/refund policy and human commercial/legal/security approval still gate a public offer. Physical iPhone/Android keyboard/audio checks and product acceptance remain open.

Expired or unrecoverable pending checkout intents intentionally block automatic replacement until a separate recovery policy is approved. Legacy indefinite credit validity is preserved. No automatic refund/dispute clawback is implemented.

Merge order is S4 PR114 first, then retarget this payment branch to main and run current-base hosted CI. Do not merge payment work into S4 merely to bypass that dependency. GitHub Actions was blocked by account billing/spending limits on S4; record the payment PR's actual check status separately. Original canonical payment draft, unrelated diagrams, paused work, learner ports4300/55440 and existing volumes remain preserved. All task browser/Compose fixtures are disposed; the dedicated payment test database is removed after validation. Worktrees and ignored evidence remain recoverable for review.