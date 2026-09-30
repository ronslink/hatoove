# OWNAPI-01 — owned attempts API (module, checks, opt-in mount)

Execution `ownapi-01-claude-20260930-a`, worker Claude for Windows, coordinator `COORD-TAKEOVER-20260930`.
Branch `codex/ownapi-01`. Assigned base `origin/main` 0ee7e13; main moved to f5bc4be (SEC-05, #47) during the task,
so the branch was rebased onto **f5bc4be151a6c8555f178e67a80f12e5e9a5575f** before `server.js` was touched.

## What was built

| Path | Content |
|---|---|
| `server/owned-api.mjs` | `createOwnedApi({datastore, sessions})` → `{handle, handleNode, matches, configured}`. All contract 0.1.0 routes the client calls, plus `GET /api/auth/get-session`. |
| `tools/owned-api-check.mjs` | 24 checks; the in-memory **test-only** datastore and session fakes live here, not under `server/`. |
| `tools/owned-api-check.test.mjs` | `node:test` wrapper (25 tests). |
| `server.js` | Opt-in mount, separate commit: `createServer({ ownedApi })` plus one clearly-marked line after the SEC-01 gate. |

Behaviour:

- **Identity** comes only from `sessions.getSession(headers)`. Identity fields in a body are refused with `422 unknown_field`, and a query string is ignored.
- **Ownership** is the datastore port's duty: another owner's record must be the same `404 not_found` as an absent record. The checks compare the two error details directly.
- **Fail-closed behaviour**: unless both ports implement every method, each owned route answers `503 not_configured` without calling a port.
- **Origin**: a mutation is `403 origin_rejected` unless the caller asserts `originChecked: true`. `server.js` asserts it only after `isSameOriginRequest()` has already rejected foreign requests. If someone forgets the gate, the module refuses the mutation rather than accepting it.
- **Error envelope** is `{error: token}`. Unexpected failures return `500 {"error":"internal_error"}` with nothing else in the body. The limits are 64 KiB (`413`), 12,000 UTF-16 code units (`422`), non-JSON (`415`), and invalid JSON or UTF-8 (`400`). Every response is `Cache-Control: no-store`.
- Resource shapes reproduce `spikes/auth-runtime/store.mjs`, including its snake_case fields.

## Evidence

The real `public/js/owned-client.js` is driven through a fake `fetchImpl` with a per-browser cookie jar, and then over real
HTTP through `server.js` on an ephemeral loopback port. Requests the client refuses to build are sent raw: unknown fields,
415, 413, invalid UTF-8 and ungated mutations.

| Suite | Result |
|---|---|
| `node tools/owned-api-check.mjs` | **24 passed, 0 failed** |
| `node --test tools/owned-api-check.test.mjs` | **25/25** |
| `node tools/check.js` | 101 passed |
| `node tools/writing-check.js` | 9 passed |
| `node tools/feedback-check.js` | 14 passed |
| `node tools/server-origin-check.mjs` | 16/16 |
| `node tools/reset-check.mjs` | 9/9 |
| `node tools/owned-client-check.mjs` | 31 passed |

### Discrimination (each break was made in a scratch copy, run, then deleted; nothing committed)

| Break | Result |
|---|---|
| D1: removed `owner_id !== owner` from the in-memory `ownedAttempt`/`ownedSubmission` | **22/24**: `cross-owner-is-404-for-every-route` and `identity-is-never-accepted-from-input` fail |
| D2: removed the module's `originChecked` precondition | **23/24**: `error-403-mutation-without-origin-gate` fails |
| D3: forced `configured = true` (no fail-closed port check) | **23/24**: `fail-closed-without-ports` fails |
| D4: moved the `server.js` mount line ahead of the SEC-01 gate | **23/24**: `server-mount-behind-sec01-origin-gate` fails (a foreign-origin sign-up got through) |

Without ownership scoping, account B can read, overwrite, submit, read results for, retry, delete and use as a parent
the records of account A. The cross-owner check covers all seven routes and fails when scoping is removed (D1).

## Limits and what is deliberately deferred

- **No PostgreSQL adapter, no RLS, no roles.** The only datastore is in memory and test-only. These checks provide **no**
  evidence about the guarantees proven in `spikes/auth-runtime/isolation.test.mjs`. The follow-up adapter should wrap
  `store(pool, {ownerId})`, including its transaction, lock order and forced RLS. The same suite should then run against it.
- **No real sessions.** The session port is a synthetic fake. Better Auth integration, secure cookie attributes,
  expiry, abuse controls and recovery remain A-01/F-02 work.
- **The mount is programmatic only.** `node server.js` passes no `ownedApi`, so learner behaviour is unchanged and
  `/api/v1/*` still returns 404 in the running app (checked by `server-mount-off-by-default`). No environment flag was added,
  because nothing is safe to wire yet. **Never wire the legacy JSON progress store behind this port.**
- **No worker, provider or grading.** Job transitions use worker hooks that exist only in the test datastore.

## Where the design may be wrong (for review)

1. **DTOs expose spike row fields**, including `owner_id` (the caller's own id), `event_id` and snake_case names. The
   contract says production DTO mapping must be versioned before browser integration. That mapping is not done here.
2. **The legacy `server.js` gate uses a different envelope.** Its 403/415 responses are `{ok:false, code, error:"text"}`, not
   `{error: token}`. Through `server.js`, the client therefore sees `forbidden` with `detail: null` rather than `origin_rejected`.
   The gate was left alone.
3. The `server.js` 415 gate covers POST/PUT/PATCH. The module also requires JSON on DELETE, as the spike did.
4. Sign-up, sign-in and sign-out return `{ok:true}`. The client ignores auth bodies and trusts only `/api/v1/account`.
5. `GET /api/auth/get-session` answers `200 null` when signed out. This mirrors Better Auth, but no client uses it yet.

This task closes no security, privacy or educational gate.
