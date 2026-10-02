# HOSTED-BLOCKERS — two paths that trust the caller, reproduced before hosted use

| | |
|---|---|
| Reported by | Ron, 2026-10-01: *"the legacy progress API still trusts a caller-supplied account ID, and the AI proxy still accepts anonymous requests and a caller-selected model. I reproduced both in an isolated copy using synthetic data and a stubbed provider. No learner data or live AI service was used. These paths need to be replaced or disabled before hosted use; the new account APIs don't protect them."* |
| Status | **confirmed in the code, and a hard blocker for hosted use.** These sit **beside** the new account boundary, not behind it, so nothing the account work does protects them |
| Read from | `origin/codex/ownapi-03-persistent` @ `2bbcd21` when first recorded, and **re-confirmed at the reviewed head `90d9860`** on 2026-10-01. **Correction:** this record previously cited `d445f3b`, which was an unreferenced duplicate merge commit from a failed push; it is not on the branch and cannot be verified, so it has been replaced with the two heads that can be. The independent platform review found this and was right to |

## B5. The legacy progress API trusts a caller-supplied account id

`server.js:51-76`:

```js
const ACCOUNT_HEADER = 'x-b1prep-account';           // a request header
function accountPaths(req) {
  const raw = req.headers[ACCOUNT_HEADER];           // caller-controlled
  if (raw === undefined) return LEGACY_PATHS;
  const id = value.trim();
  if (!ACCOUNT_ID_RE.test(id)) throw ... 'invalid_account';
  return { accountId: id, progress: `${PROGRESS_PATH}.${id}`, rev: `${PROGRESS_PATH}.${id}.rev` };
}
```

The comment says it plainly — *"attribution/isolation of accounts that share one machine, **NOT an
authentication boundary**"* — and that was **correct for a local install**. Hosted, the header is an unauthenticated
claim that selects the file:

- `GET /api/progress` with `x-b1prep-account: <someone-else>` **reads that learner's record**;
- `DELETE /api/progress` with the same header **deletes it**;
- and a request with **no** header falls back to `LEGACY_PATHS` — the shared unscoped record — so the default
  behaviour on a server is worse than the scoped one.

The new `owned-api` attempts/drafts routes are properly session-scoped, so they are unaffected. **The problem is
that this older path still exists next to them**, which is exactly what Ron means by "the new account APIs don't
protect them".

### Remediation — and it is a deletion, not a patch

Do **not** try to authenticate this route. It is the file-based persistence model being retired anyway
(`PROGRESS-MERGE-DECISION.md`), so:

1. **Disable it for hosted use** as the immediate step: the legacy progress routes (or at least the
   account-header branch and the unscoped fallback) must be **refused** unless an explicit local-only flag is set,
   so an unconfigured deployment cannot serve them at all.
2. **Delete it** as part of "the stateful views move to the account record": the client's `store.js` writes through
   owned attempts with revisions, and these routes have no callers left.
3. **Any interim state must fail closed.** If the routes remain reachable for any reason, a request naming an
   account must require a **verified session for that same account**, and a request naming none must be refused
   rather than falling back to a shared record.

## B6. The AI proxy accepts anonymous requests and a caller-selected model

`server.js:709-716`:

```js
if (pathname === '/api/ai' && method === 'POST') {
  ...
  model: body.model,          // caller-controlled
```

with `server.js:466` (`model: model || s.model`) falling back to the operator's configured model, `:516`
(`model: payload.model || body.model`), and `callDeepSeek` sending `Authorization: Bearer <operator key>`
(`:456`).

On a local single-user install this is the learner using their own key. Hosted, it is:

- **an open proxy to the operator's provider key** — any unauthenticated caller can spend the operator's money;
- **with a caller-chosen model**, so the tenant picks what the operator pays for;
- **with caller-supplied prompt content**, which is also the prompt-injection surface, and
- **with no per-account allowance** — the `entitlements`/`usage_ledger` accounting that exists in the database is
  **not on this path at all**.

D1 removed the ability to *choose the provider*, and left `/api/ai` unchanged **deliberately** — the record says so
in §5.1. This finding shows that leaving it unchanged is not tenable for a hosted service.

### Remediation

1. **Require a verified session** on `/api/ai` and `/api/ai/test`. Anonymous is refused. This is small and has no
   product cost: a signed-in learner sends their cookie, and `owned-client.js` already sends `credentials:
   'same-origin'`.
2. **Ignore `body.model`.** The model is operator configuration (`DEEPSEEK_MODEL`). Accepting it from a request
   contradicts D1's own premise — the provider is the operator's, so the model is too.
3. **Attribute the spend to the account** through the existing allowance/ledger model, or refuse when the
   entitlement is exhausted. Without this, one tenant can consume the service.
4. **Decide the local-install case explicitly.** If a single-user local mode is still wanted, it needs a flag that
   is off by default and a documented statement that it is not a hosted configuration — otherwise the two
   behaviours drift apart again.

## What this changes about the plan

`SERVER-READINESS.md` listed four hard blockers (**B1** origin check, **B2** loopback bind, **B3** file config,
**B4** cookies). **These are B5 and B6, and they are the two that a hosted deployment is actively unsafe on**, rather
than unable to run.

| Order | Slice | Why here |
|---|---|---|
| 0 | **B5 and B6 — refuse the legacy progress account path and lock down `/api/ai`** | **before anything else.** These are reachable **now** by an unauthenticated caller on any shared host, and neither needs a design decision: one is "refuse unless local-only", the other is "require a session and ignore the caller's model". Both need a checker with discrimination |
| 1 | **SERVER-READY-01 (B1, B2)** | still the prerequisite for testing anything on a real host |
| 2 | **D1 follow-ups, D3 hard delete, D2 settings** | as already ordered |
| 3 | **Delete the legacy progress API entirely** | with the persistence migration, which retires `mergeProgress` at the same time |

**No gate is closed by this record.** It is a confirmation of a reported defect with the exact code paths, and the
remediation is stated as work rather than as a fix already made.
