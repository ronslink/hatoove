# INTEGRATIONS-01 — why a multi-user app needs entirely different integrations

**Status: PROPOSAL. Not a decision, not dispatched, not built.**

Ron, 1 October 2026:

> "different from what we currently have or had at the time if we have a multi user app vs a single
> user app the integrations have to be entirely different"

---

## 1. The principle

**In a single-user app, an integration is a convenience the local user configures. In a multi-user
app, an integration is a shared, costed, owner-attributed resource that must be bounded, reviewable
and revocable per account.**

That is not a difference of degree. It is a difference of kind, and it is why the previous
integrations cannot be adapted — they were built on an assumption (one person, one process, one
machine, no accounting) that no longer holds.

Every rule below is a consequence of that sentence.

---

## 2. The old shape, and why it cannot be reused

The application we have was a single-user program with a server bolted on:

- **Inference was a browser feature.** The page called a generic `/api/ai` proxy, unmetered, and
  graded writing client-side. There was no account to attribute cost to, because there were no
  accounts. At one point the *browser* could write the provider key and base URL into the server's
  `.env` through `/api/config`.
- **Persistence was a file.** `progress.json`, a browser blob and a file-sync engine. One learner's
  data was one file, and the file *was* the identity.
- **Speech was the learner's own device.** The Web Speech API, in the browser, so no two learners
  heard the same audio and nothing could be reviewed or reproduced.
- **Content was public.** Static JSON served to anyone who asked — including the answer keys, which
  is exactly what PILOT-01c had to close.

None of that is a defect *in a single-user app*. All of it is fatal in a multi-user one.

---

## 3. The mapping

| Integration | Single-user (what we had) | Multi-user (what is required) |
|---|---|---|
| **Inference** | browser → generic proxy; unmetered; client-side grading; provider config writable from the page | server-side **port only**; **worker-queued**, never in the request path; per-account **allowance + exactly one debit**; prompts server-owned; outputs versioned and stored |
| **Identity** | the file *was* the user; an optional account header | session-derived ownership, one shared schema, **FORCE RLS**; no default local user |
| **Persistence** | `progress.json` + localStorage blob + file sync | PostgreSQL only; no file store, no sync engine, no blob |
| **Content** | static JSON, publicly served, keys included | versioned shared content, delivered **per entitlement**, keys in a table granted to no runtime role |
| **Speech / TTS** | browser voice, per device, unreviewable | **Two jobs, two answers.** A learner's *own on-screen text* may use the browser voice — free, private, and its per-device inconsistency does not matter for a single view. Anything **pooled, shared, reviewed or scored** must be **server-side**, cached per `(text, language, voice)`, because the bytes have to be identical for every learner and reviewable once. MASTER-PLAN §5 reconciles this with the master plan's earlier "browser first" |
| **Email** | none | a provider **port** (verify, reset), stubbed in development; a data processor for P-03 |
| **Payments / entitlement** | none | a provider port plus an owned ledger — and this is the thing that *bounds the inference cost* |
| **Secrets / config** | `.env` read **and written** through a route | deployment-scoped environment only; **no route may read or write provider configuration** |
| **Abuse control** | unnecessary — one user | DB-backed limits per account and per IP, shared across instances rather than per-process memory |
| **Provenance / usage** | none | a usage ledger attributing every external call to an owner, its model and prompt version |

---

## 4. The five rules that follow

1. **No integration call without an owner.** Every external call runs inside a request or job that
   has already resolved a verified session, and the owner is recorded with the result.
2. **No integration call without an allowance check and a ledger row.** If it can cost money, it is
   bounded by an entitlement and it debits exactly once — the pattern the worker already proves.
3. **Costed work is asynchronous.** Anything expensive goes through the worker with a lease, so it
   is attributable, idempotent and recoverable. A synchronous provider call in the request path is a
   single-user pattern.
4. **Integrations are shared, so their outputs are pooled.** This is why CONTENT-POOL-01 applies to
   TTS audio and explanations, not just to questions: a shared resource should be paid for once and
   reviewed once.
5. **Nothing an integration produces is configurable from a learner session.** No key, no endpoint,
   no model, no prompt. In a multi-user app, one learner editing provider configuration is not a
   convenience — it is spending the operator's money against the operator's account.

Two corollaries worth stating plainly:

- **Failure must be per-account isolated.** One learner's provider timeout must not fail another's
  request, and must not consume another's allowance.
- **Deletion must revoke.** Hard-deleting an account has to settle its ledger and revoke its access
  to shared resources — including work already queued.

---

## 5. The encouraging part

The repository **already has this pattern for its data integrations**, and it is proven:

- `server/owned-postgres/*` is a set of ports behind one provisioning path — datastore, sessions,
  settings, deletion — each backed by restricted roles with FORCE RLS.
- The worker already **leases, fences, retries boundedly and debits exactly once**, and its grader is
  a **deterministic stub** behind a port.

So the multi-user shape is not alien to this codebase; it is the half that works. What is missing is
the *external* half — inference, speech, email, payments, object storage — and each of those needs
the same discipline the data ports already have: one port, a stub for development, a real adapter
gated behind a human decision, and no credential anywhere near a learner.

---

## 6. What this means for the API-based shape

"The API is the product" and "multi-user integrations" are the same statement seen twice. A thin
client that holds no state, no key and no grading logic is *what makes* an owner-attributable,
poolable, reviewable integration possible. The client submits a reference and receives a result; the
server decides what may be generated, what it costs, who pays and what is stored.

This is also why the page surface is auth-gated: in a multi-user app, content delivered to an
unauthenticated request is content delivered to an owner that does not exist.

---

## 7. LIMITS

- **Nothing here is built.** No integration port exists for inference, speech, email, payments or
  object storage. This record describes the shape they must take; it does not create them.
- **No provider is authorized.** Live inference is **R10**, email is **R5** and a data processor for
  P-03, payments are not authorized at all. Every port here can be built and checked against a stub
  first, which is the only way to prove the allowance, ledger and isolation behaviour before money
  or a real account is involved.
- **The `(text, language, voice)` TTS cache is a design, not a measurement** — per-language voice
  availability is already known to be uneven for uk/ar/tr, so "pooled audio" may be honest for some
  languages and impossible for others until a server-side voice is chosen.
- **Writing feedback is the one integration that cannot be pooled.** It is about a specific learner's
  text. It stays per-submission, owned, and allowance-bounded — while the criteria explanations that
  accompany it can still be pooled.
