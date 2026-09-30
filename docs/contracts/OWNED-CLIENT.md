# Owned client transport — public API (contract 0.1.0)

Coordinator-specified browser transport boundary for the owned draft API. Consumed by
PILOT-02; the route and error semantics come from [PILOT-V0.1.md](PILOT-V0.1.md).

Source: `public/js/owned-client.js`
Checks: `node tools/owned-client-check.mjs`
Execution `ocli-20260930-a`, base `074aebf9697d9a2b047a59b993a3178d94f1fb9f`, branch `codex/owned-client-01`.

This module is transport only. It does not store drafts, does not render UI, does not approve
content, does not change the server and does not pick a grading model. It also keeps **no draft
text or session cache**: a later coordinator-owned cache can key on the explicit boundaries below.

## Module

```js
import { createOwnedClient, OwnedClientError, ERROR_CODES, CONTRACT_VERSION, DRAFT_TEXT_LIMIT }
  from './owned-client.js';
```

| Export | Value / signature |
|---|---|
| `createOwnedClient(config?)` | factory; returns the client object described below |
| `OwnedClientError` | error class: `code`, `status`, `detail`, `message`, `isStaleSession`, `isUnauthenticated`, `isConflict`, `isNetworkError` |
| `ERROR_CODES` | frozen list of every code below |
| `CONTRACT_VERSION` | `'0.1.0'` (the only account contract version this client accepts) |
| `DRAFT_TEXT_LIMIT` | `12000` UTF-16 code units, matching the server draft bound |

### `createOwnedClient(config?)`

```js
const client = createOwnedClient();                          // uses globalThis.fetch
const client = createOwnedClient({ fetchImpl: fakeFetch });  // injected transport
```

`config.fetchImpl` defaults to `globalThis.fetch` and is captured **once, when `createOwnedClient()` is
called** — never at module scope and never re-read per call — so importing the module performs no
network work, and replacing `globalThis.fetch` afterwards does not change an existing client. No other
option is accepted: an unknown option (for example `baseURL`, `ownerID`, `origin`) is refused with
`invalid_request`. A missing or non-function transport fails every call with `transport_unavailable`.

The returned object is frozen. Every method is closed: unexpected extra arguments are refused with
`invalid_request` instead of being ignored.

## Methods

All learner methods require a verified account (see `refreshAccount`). Without one they reject with
`unauthenticated` **before** any request is sent.

| Method | Request | Notes |
|---|---|---|
| `getAccount()` | none | copy of `{contractVersion, id, email}` or `null`. Mutating the copy cannot change internal authority. |
| `refreshAccount()` | `GET /api/v1/account` | verifies `contractVersion === '0.1.0'` and a non-empty `id`; adopts the identity and returns its copy; returns `null` on 401. Deliberate boundary call, never automatic. |
| `signIn({email,password})` | `POST /api/auth/sign-in/email` then `refreshAccount()` | returns the verified account copy |
| `signUp({name,email,password})` | `POST /api/auth/sign-up/email` then `refreshAccount()` | returns the verified account copy |
| `signOut()` | `POST /api/auth/sign-out` | clears the local identity and cancels work immediately, then reports any server failure honestly |
| `clear()` | none | invalidates the local context only; no request, no server session change |
| `createAttempt({parentSubmissionId}={})` | `POST /api/v1/attempts` | body `{}` or `{parentSubmissionId}` |
| `readAttempt(id)` | `GET /api/v1/attempts/:id` | returned `id` must match the requested attempt |
| `saveDraft(id,{expectedRevision,text})` | `PUT /api/v1/attempts/:id` | body `{expectedRevision,text}` |
| `submit(id,{expectedRevision,eventId})` | `POST /api/v1/attempts/:id/submissions` | body `{expectedRevision,eventId}`; sent exactly once |
| `readResult(submissionId)` | `GET /api/v1/submissions/:id` | returned `submission.id` must match the request |
| `retry(submissionId)` | `POST /api/v1/submissions/:id/retry` | body `{}` |
| `deleteAttempt(id)` | `DELETE /api/v1/attempts/:id` | body `{}` |

`client.generation` is a read-only number: it increases on every invalidation and identity
transition. It is exposed so a caller-owned cache can be keyed to the same session boundary.

### The auth POSTs

`signIn`/`signUp` are the only methods that establish a verified identity from credentials: they POST the
credentials and then take identity **only** from `GET /api/v1/account`. A non-2xx answer is reported with
its documented code (`401` → `unauthenticated`), and a `401` from an auth POST does **not** clear an
existing verified identity — the learner's other session may still be valid — so `getAccount()` keeps
returning that account (it stays `null` only when no identity had been verified).

### Request shape (identical for every call)

- URL: a fixed, same-origin path built from a validated UUID. `/api/auth/sign-in/email`,
  `/api/auth/sign-up/email`, `/api/auth/sign-out`, `/api/v1/account`, `/api/v1/attempts`,
  `/api/v1/attempts/:uuid`, `/api/v1/attempts/:uuid/submissions`, `/api/v1/submissions/:uuid`,
  `/api/v1/submissions/:uuid/retry`. Nothing else is reachable.
- `credentials: 'same-origin'`, `cache: 'no-store'` on every request.
- Mutations (including `DELETE` and the auth POSTs) send `content-type: application/json` with a
  JSON body; `GET` sends no body. `accept: application/json` is sent everywhere.
- **No `origin` header is ever set** — the browser supplies it, and an untrusted mutation is the
  server's 403 to give.
- No automatic retry of `POST`/`PUT`/`DELETE`, no fallback to `/api/progress`, `/api/config` or
  `/api/ai`, and no client-side success fabrication: a caller only sees values that a 2xx response
  actually carried.

### Input validation (rejected with `invalid_request`, no request sent)

- UUIDs (attempt ids, submission ids, `eventId`, `parentSubmissionId`) must be canonical
  `8-4-4-4-12` hex, case-insensitive, passed through unchanged. Path-like or absolute values are
  refused, so no caller can redirect a request.
- `expectedRevision` must be an integer `>= 1`; `text` must be a string of at most 12000 UTF-16
  code units.
- Payload keys are allowlisted per method (`email`/`password`, `name`/`email`/`password`,
  `expectedRevision`/`text`, `expectedRevision`/`eventId`, `parentSubmissionId`). An unknown key —
  including `owner_id` or any other privileged field — is refused, so it can never reach a body.
- `email` must be a single address without surrounding whitespace (≤ 254 chars); `password` must be
  a non-empty string ≤ 256 chars; `name` a non-empty string ≤ 200 chars. Server policy still wins.

### Response validation

A 2xx body is parsed and checked against the spike shapes of contract 0.1.0; anything else is
`malformed_response` rather than an invented success. The account route must return
`contractVersion === '0.1.0'` and a non-empty `id` (`unsupported_contract` otherwise, and no
identity is adopted). Attempts must carry a UUID `id`, an integer `revision >= 1` and a string
`text`; submissions `submissionId` + boolean `replay`; results `submission.id`/`submission.text`,
a known `job.status` and `assessment` object-or-null; retry `queued`; delete `deleted`. Returned
resources are deep copies.

## Errors

Every rejection is an `OwnedClientError` with a documented `code`, an HTTP `status` (or `null`) and
a `detail` that is either `null` or a sanitized `{error: token}` value from the contract envelope
(`/^[a-z][a-z0-9_]{0,47}$/`). Raw response text, SQL, stack traces and credentials are never copied
into the error, and the raw response is not attached.

| `code` | `status` | Meaning |
|---|---|---|
| `invalid_request` | `null` | caller-side validation failed; nothing was sent |
| `transport_unavailable` | `null` | no usable `fetch` implementation |
| `network_error` | `null` | the transport rejected the request (offline, DNS, CORS) |
| `malformed_response` | HTTP status | 2xx body empty, non-JSON or off-contract |
| `unsupported_contract` | HTTP status | account reported another `contractVersion` |
| `stale_session` | `null` | the response belongs to a superseded session generation |
| `unauthenticated` | 401 or `null` | server 401, or a learner call with no verified account |
| `forbidden` | 403 | rejected by the server |
| `not_found` | 404 | unavailable resource or route |
| `conflict` | 409 | draft revision, idempotency, allowance or retry conflict |
| `bad_request` | 400 | server rejected the request as invalid |
| `too_large` | 413 | body limit |
| `unsupported_media_type` | 415 | non-JSON request |
| `unprocessable` | 422 | invalid fields or content |
| `server_error` | 5xx | redacted unexpected failure |
| `http_error` | other | any other non-2xx |

409, 401, network and malformed-response stay distinct so the UI can preserve the learner's text and
offer compare/reload. **Conflict never silently overwrites text**: the transport holds no text at
all, so a 409 leaves the caller's buffer untouched and simply reports the conflict. A 404/403/5xx
does not change the verified identity.

## Session boundaries

A monotonic local `generation` fences every awaited result:

- `clear()`, `signOut()`, a `refreshAccount()` identity transition and a current-generation `401` from a
  **learner call** (`refreshAccount`, `createAttempt`, `readAttempt`, `saveDraft`, `submit`, `readResult`,
  `retry`, `deleteAttempt`) invalidate the local context: the identity is dropped, the generation increases
  and the in-flight requests of the superseded generation are aborted. An auth POST is **not** one of these
  boundaries — see the auth POST note above.
- Each learner call captures the verified identity and generation on entry and re-checks them after
  the `await`, **before** exposing a value or an error. A response that belongs to a superseded
  generation rejects as `stale_session` even when the transport ignores the `AbortSignal`. The
  `signIn`/`signUp` POSTs carry the same re-check, so a superseded sign-in/sign-up failure is also
  `stale_session` rather than `network_error`.
- A late response from an old account can therefore never populate or restore the new account.
- A learner-call `401` seen at the current generation invalidates the account; a `401` that arrives at an
  older generation is reported as `stale_session` and does not sign out the newer account.
- A network failure is not an identity change: it never clears or replaces the verified identity.
- `refreshAccount()` confirming the *same* account is not a transition, so it neither aborts nor
  fences a valid in-flight save. Only a changed/cleared identity is a boundary.
- A `401` from `POST /api/auth/sign-out` or a transport failure there still leaves the local
  identity cleared — the caller learns about the failure instead of a fabricated success.

## Out of scope / limits (not implemented here)

- No draft cache, no autosave scheduling, no retry/backoff, no offline queue, no optimistic UI.
- No `GET /api/auth/get-session` call: identity is verified only through `GET /api/v1/account`.
- No server, dependency, CI, board or master-plan change; no live API/provider/browser/database run.
- Written against the contract and the executable spike shapes
  (`spikes/auth-runtime/{server,store}.mjs`); a real server that answers with a different DTO must be
  versioned in the contract before the client is adjusted.
- `DELETE` requires the documented JSON body (`{deleted:true}`); a bodyless `204` is reported as
  `malformed_response` rather than assumed to be success.
