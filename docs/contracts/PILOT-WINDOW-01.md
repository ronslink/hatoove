# PILOT-WINDOW-01 — the pilot free window as a runtime access decision

**Status:** contract frozen for implementation · **Base:** `252cd3d` (PR #139 merge) · **Slice:** `PILOT-WINDOW-ENFORCE-01`
**Owners:** coordinator authors this contract; the implementation and its check follow it. An author may not review
their own slice.

---

## 1. Why this exists

`PILOT_FREE_UNTIL=2027-01-14` is declared in `compose.production.yaml` and parsed by
`server.js#readPilotFreeUntil()`. That accessor is **read-only and consumed by nothing**: no route, entitlement or
payment decision branches on the date. The landing page shipped in PR #139 already states the commercial rule to
learners, so today the page makes a promise the runtime does not keep. This contract turns the promise into a
decision.

The promise, verbatim from the shipped copy (`public/assets/i18n/public-messages.js#faqFreeAnswer`, German):

> „Der Pilot ist bis zum 14. Januar 2027 kostenlos … Danach sind Guthaben-Pakete nötig … Ohne Kauf bleibt der
> kostenlose Test: das Übungsbeispiel auf dieser Seite und ein vollständiger Test in Lesen und Sprachbausteinen in
> deinem Konto, ohne Rückmeldung zum Schreiben."

Owner decision (Ron, 4 October 2026, recorded in `handoff/ron-agent/HANDOFF-20261004-pilot-tts-and-state.md` §4.1):
after the window, an account **without purchased credit packs** keeps the free test; credit packs are required for
the rest.

## 2. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | The window is bounded by **UTC calendar days** and the configured day is **inclusive**: open while the current UTC day `<= freeUntil`, closed from the following UTC day. | `PILOT_FREE_UNTIL` is a calendar day, not an instant. A host-local comparison would move a commercial boundary with the container's timezone; string comparison of ISO days is exact and needs no `Date` arithmetic. The boundary costs at most hours at the international date line, and determinism is worth more than those hours. |
| **D2** | An **unconfigured** window (`valid:false`) resolves to **FREE for an account without a purchase** and **FULL for an account with one**. It never throws, never inherits a fallback date, and never returns FULL without a purchase. | `readPilotFreeUntil()` deliberately refuses a hard-coded fallback. Failing closed (lock everyone out) would break the baseline the page promises; failing open (grant the paid surface) would give away the product on an operator typo. This resolution is the only one that is wrong in neither direction. |
| **D3** | **"Purchased" means a `payment_grant` row for the exam whose `expires_at` is in the future** — not a non-empty `entitlements.allowance`. | Registration may provision an allowance (`hatoove.registration_allowance`, migration 0023). That is a grant, not a purchase, and the rule keys on purchase. `payment_grant` (migration 0028) is the durable purchase record; `entitlements.expires_at` mirrors it. |
| **D4** | The free surface is the **public practice sample** (already unauthenticated, unaffected by this gate) plus **one complete reading + language-elements test**, with **no writing feedback**. | The exact promise in the copy above. |
| **D5** | The free test is designated by content, with an explicit marker on exactly one form whose sections cover **LV and SB** (`pilotFree: true`). The runtime does not invent a designation. | Which form is "the one complete test" is a content decision owned by human review, not a route mapping. Until the window closes, no designation is required; once it closes, the check fails loudly while the designation is missing rather than silently serving the sample alone. |
| **D6** | An **unclassified route is PAID** (fail closed). | A commercial gate whose default is "allowed" stops being a gate the moment a route is added. The check asserts every route in the router carries a classification, so a new route fails the build instead of quietly bypassing the window. |
| **D7** | **Writing feedback is already gated by the entitlement** (`submit`/`retry` answer `409 allowance_exhausted` with no purchasable balance). This slice does not change that, and post-window registration must not provision free credits (`hatoove.registration_allowance=0`) — an operator configuration, documented here, not a code path. | Two gates for one rule would create a second source of truth. |
| **D8** | The refusal is `402 pilot_window_closed` on the owned API, with a client-visible message in all five instruction languages. | `402` states "payment is required for this", which is exactly the case, and is distinct from `401` (not signed in), `403` (not allowed) and `409 allowance_exhausted` (you bought, but spent it). |

## 3. Window state

```js
pilotWindowState(env = process.env, now = new Date())
// -> { state: 'open' | 'closed' | 'unconfigured', freeUntil: 'YYYY-MM-DD' | null, reason: null | 'not_configured' | 'malformed' | 'impossible_date' }
```

* `open` — `now`'s UTC day is on or before `freeUntil`.
* `closed` — `now`'s UTC day is after `freeUntil`.
* `unconfigured` — `readPilotFreeUntil()` returned `valid:false`; `reason` is carried through unchanged.
* A malformed `now` is a caller bug and throws `TypeError`. Operator configuration never throws; programmer error does.

## 4. Access resolution

```js
resolvePilotAccess({ window: pilotWindowState(env, now), purchasedPass: boolean })
// -> { access: 'full' | 'free', reason: 'purchased_pass' | 'pilot_window_open' | 'pilot_window_closed' | 'pilot_window_unconfigured' }
```

| Window | `purchasedPass` | access | reason |
| --- | --- | --- | --- |
| open | either | `full` | `pilot_window_open` (*) |
| closed | `true` | `full` | `purchased_pass` |
| closed | `false` | `free` | `pilot_window_closed` |
| unconfigured | `true` | `full` | `purchased_pass` |
| unconfigured | `false` | `free` | `pilot_window_unconfigured` |

(*) A purchase is checked first so that `reason` names the durable entitlement rather than the calendar. The
resolved `access` is the same either way while the window is open.

## 5. Free surface (D4/D5)

`FREE_SURFACE` is one frozen value, so the gate, the check and the copy cannot drift:

```js
{ sections: ['LV', 'SB'], completeTests: 1, writingFeedback: false }
```

A `free` account may: sign in and manage its account, export and delete its data, view its preparations and credit
line, reach the public sample, and run the **one designated complete LV+SB test**. It may not reach any other
practice, listening, vocabulary, guide or mock surface, and it receives no writing feedback.

## 6. Route classification

Applied at the owned-API boundary after session verification and before dispatch. `open` = never gated by the
window; `free` = reachable by a `free` account; `paid` = requires `full`.

| Route | Method(s) | Surface | Note |
| --- | --- | --- | --- |
| `/api/auth/*` | any | open | Sign-in is not a product surface. |
| `/api/v1/account`, `/api/v1/account/password`, `/api/v1/sessions` | GET/PUT/DELETE | open | Account self-service. |
| `/api/v1/export` | GET | open | Data rights are never sold. |
| `/api/v1/settings` | GET/PUT | open | Instruction language and preferences. |
| `/api/v1/exams`, `/api/v1/preparations` | GET | open | Catalogue and the free test must be visible. |
| `/api/v1/checkout/offer`, `/api/v1/checkout/session`, `/api/v1/orders/*`, `/api/v1/payments/*` | GET/POST | open | A closed window is exactly when checkout must work. |
| `/api/v1/tasks` | GET | open | Navigation metadata, not practice. |
| `/api/v1/mock-forms` | GET | free | Filtered to the designated free form for a `free` account. |
| `/api/v1/mock-runs` | GET | free | Only runs of the designated free form. |
| `/api/v1/objective-sets` | GET | free | Only the designated free form's sets. |
| `/api/v1/attempts` | GET | free | The learner's own history and drafts (data rights). |
| `/api/v1/attempts` | POST | free | Creating an attempt on the free form only. |
| `/api/v1/practice/*` | GET | paid | Adaptive practice. |
| `/api/v1/vocab`, `/api/v1/nouns`, `/api/v1/guides` | GET | paid | Reference and drill surfaces. |
| `/api/v1/sentence-check` | POST | paid | Writing support without a purchase. |
| anything else | any | paid | D6: fail closed. |

## 7. Refusal contract

```json
HTTP/1.1 402 Payment Required
{ "error": "pilot_window_closed" }
```

The client shows one message per instruction language (de/en/uk/ar/tr) naming the date from
`readPilotFreeUntil()`, the free test and the checkout path. The date is never hard-coded in the client.

## 8. Non-goals

* No prices, markets, tax, withdrawal terms or live payment keys (D15 remains owner-gated).
* No change to content, scoring, review status or the writing rubric.
* No change to the public landing page, its sample or its copy beyond the message added in §7.
* No decision about whether an **expired** purchase returns the account to the free test: §4 treats "no unexpired
  grant" as `free`, which is the safe reading of "an account without purchased credit packs". A future pass-renewal
  slice may revisit it.
* No enforcement while the window is open: before 2027-01-15 every account resolves to `full`, so this slice changes
  no learner's access today.

## 9. Acceptance

1. `node tools/pilot-window-enforce-check.mjs` passes: window states, the D1 boundary, every `unconfigured` shape,
   the full access table of §4, and that `FREE_SURFACE` matches the shipped copy.
2. The gate is proven to fail by mutation in a `%TEMP%` copy: flipping a classification, the boundary or the D2
   resolution turns a leg red.
3. Every route in `server/owned-api.mjs` carries a classification (§6/D6); a new unclassified route fails the check.
4. A PostgreSQL leg proves D3: an account with a signup-provisioned allowance and no `payment_grant` resolves to
   `free`, and a paid, unexpired grant resolves to `full` — with exact disposable cleanup.
5. `node tools/pilot-window-check.mjs`, `tools/seo-check.mjs` and `tools/repository-check.mjs` stay green.

## 10. Implementation order

1. `server/pilot-window.mjs` — pure decision (D1–D3), no I/O. **Landed in this slice.**
2. `tools/pilot-window-enforce-check.mjs` — pure legs + copy agreement. **Landed in this slice.**
3. Route classification and the `402` gate in `server/owned-api.mjs`, the `payment_grant` predicate in the
   PostgreSQL adapter, the client message, and the PostgreSQL leg (acceptance 3–4). **Next checkpoint, same slice.**
