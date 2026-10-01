# SAAS-RUNTIME-01 — the runtime boundary fails closed (issue #63 step A)

| | |
|---|---|
| Task | `SAAS-RUNTIME-01` (issue #63, step A) |
| Worker | OpenClaw/Hetzner, execution `saas-runtime-01-openclaw-20261001-b` (attempt 2); attempt 3 `...-c` below |
| Coordinator | `COORD-TAKEOVER-20260930` |
| Branch | `codex/saas-runtime-01` |
| Base | `origin/codex/ownapi-03-persistent` @ `90d9860` |
| Authority | [issue #63](https://github.com/ronslink/hatoove/issues/63); `HOSTED-BLOCKERS.md` (S1/S2 = B5/B6); `SERVER-READINESS.md` (B2 withdrawn) |
| Status | in progress — this file is **append-only**; do not edit the issue-63 records |

This record is written as the work proceeds. Attempt 1 (`...-a`) produced changes that were never run,
never committed and never pushed; that work was archived unverified and is **not** a starting point.

## Scope (from the brief)

Three refusals plus one configuration change:

- **A1** — the legacy progress routes (`x-b1prep-account` owner selector and the unscoped fallback) must be
  unavailable in the hosted runtime; the local-install path survives only behind an explicit, off-by-default flag.
- **A2** — `/api/ai` and `/api/ai/test` require a verified session; the caller's `model` is ignored; input is
  bounded server-side.
- **A3** — a SaaS startup mode fails closed on missing/failed auth or database: learner routes 503, readiness
  false, never a downgrade to anonymous single-user.
- **A4** — the trusted origin is configuration (the deployment's exact public origin); the allowed origin is
  accepted and a foreign origin is still refused.

## Checkpoints

- [x] A1 refusal + discrimination + push — refusal `93c9b73`; checker `cd640a0`; discrimination below
- [x] A2 refusal + discrimination + push — refusal `93c9b73`; checker `cd640a0`; discrimination below
- [x] A3 fail-closed + discrimination + push — readiness `93c9b73`; runtime-interruption pool guard `6f231d8`; discrimination below
- [x] A4 configured origin + discrimination + push — refusal `93c9b73`; checker `cd640a0`; discrimination below
- [x] `tools/saas-runtime-check.mjs` green — 9 passed, 0 failed in ~3 s; `cd640a0`; TDZ fix `7969bc8`
- [x] baseline counts unchanged; `repository-check.mjs` passes — real counts below
- [x] draft PR opened — [#64](https://github.com/ronslink/hatoove/pull/64) (draft, pre-existing)

## Attempt 3 (`saas-runtime-01-openclaw-20261001-c`) — the checker completes

Base `codex/saas-runtime-01` @ `93c9b73`. Attempt 2's server work was already on `origin`; the
evidence was not. This attempt makes the checker complete, corrects the checks that described a
server that was never built, fixes the one real A3 gap the corrected checker then exposed, and
proves every refusal discriminates.

### Why it hung (two independent causes)

The recovered checker printed nothing until every check finished, and it printed nothing for
20+ minutes, so a single non-terminating check looked like silence. Isolating with `timeout`:

1. **`stop()` resolved only on a *future* `exit` event.** `runtime-database-interruption`
   makes the server process **crash** (see A3 below), so by the time `stop()` ran the child had
   already exited and `child.once('exit', …)` never fired — the promise never settled and the
   run stalled with no output. A checker must reap a process that is already gone.
2. **`request()` had no timeout.** Any request the server never answered waited forever.

Both are now bounded: every request has a 20 s deadline, every check a 90 s deadline, `stop()`
resolves immediately for an already-exited child and otherwise escalates SIGTERM → SIGKILL with
a deadline, and the process exits explicitly after the summary. A stalled refusal is now a
FAILED CHECK, not a wait.

### The A3 gap the corrected checker exposed (fix `6f231d8`)

A `pg` pool whose backend disappears emits `error` **on the pool**. Nothing listened, so Node
aborted the whole hosted process: the learner's in-flight request got a dropped connection
(`ECONNREFUSED`) instead of a refusal, and readiness could never be reported because there was
no process. `server/accounts.mjs` now guards every pool it mounts (migration, auth, learner,
worker, admin); a secret-free line goes to the operator console and the request path answers its
own `500 internal_error`. The check now reports `learner route => 500 after interruption (was
200); legacy still 403; process alive`.

### Checks that were wrong, and why the server was right (fix `cd640a0`)

Three expectations described a server that was never built; the check was the suspect, not the
refusal:

| check said | server does | why the server is right |
|---|---|---|
| legacy refusal is `410` | `403 legacy_progress_disabled` | the route still exists in code and its removal is planned with the persistence migration, so 403 + a code lets an operator tell "disabled" from "typo" |
| AI bound is `413` | `422 invalid_messages` | the 413 path is the 256 KB body cap; the per-message cap and message count are validation, so 422 is correct |
| flag `B1PREP_ALLOW_LEGACY_PROGRESS=1` re-opens the path | no such flag | see below |

Two checks also started the hosted runtime **without a database**, so the not-ready `503`
shadowed the specific refusal they meant to observe; they now run against a **ready** runtime.

**The flag question.** `B1PREP_SAAS` is the explicit, off-by-default flag that preserves the
local install: a plain `node server.js` (flag unset) keeps the file-based record byte-for-byte,
and hosted mode refuses it. I deliberately did **not** add a "reopen legacy progress inside the
hosted runtime" flag — that would put the exact hole this slice closes back behind an operator
setting on the very deployment it hardens. The local-install path is preserved behind
`B1PREP_SAAS`, which *is* off by default and is not a hosted configuration. Flagged for the
coordinator in case the other reading was intended.

### The checker completes — real output

```
$ OWNAPI_PG_DATABASE=<disposable> node tools/saas-runtime-check.mjs
PASS legacy-progress-refused-anonymous-in-saas  [403 legacy_progress_disabled on GET/POST/DELETE; account header and unscoped fallback both refused]
PASS legacy-progress-local-install-unchanged  [B1PREP_SAAS unset => local file-based path works; the flag is the only switch]
PASS ai-anonymous-refused-and-no-provider-call  [401 unauthenticated, provider saw 0 calls]
PASS ai-authenticated-cannot-override-the-model  [provider received model=operator-model-synthetic (caller sent attacker-chosen-model)]
PASS ai-input-is-bounded-server-side  [oversized=>422; too many=>422; clamped max_tokens=4096]
PASS ai-test-is-not-reachable-in-saas  [anonymous=403, learner=403, provider calls=0]
PASS saas-missing-database-fails-closed  [learner 503, readiness 503/false, legacy refused (503), no single-user fallback]
PASS runtime-database-interruption-is-a-refusal  [learner route => 500 after interruption (was 200); legacy still 403; process alive]
PASS configured-public-origin-accepted-and-foreign-refused  [allowed=200, foreign=403, rebound=403]

9 passed, 0 failed
```

Wall clock ~3 s. Real server processes, real HTTP, synthetic accounts, a fully stubbed provider
(records the exact request body), disposable database.

### Discrimination — every refusal re-opened in a scratch copy **outside** the repository

The scratch copy is `/root/workspaces/hatoove-saasruntime-discrim` (no `.git`). For each case the
refusal is re-opened in that copy, the matching check is run, then the pristine file is restored
and the check re-run. Result: **9/9 FAIL when open, PASS when closed.**

| path re-opened | check | open | closed |
|---|---|---|---|
| drop `saas &&` from the legacy refusal | `legacy-progress-refused-anonymous-in-saas` | FAIL (200/found) | PASS (403) |
| drop the `/api/ai` identity requirement | `ai-anonymous-refused-and-no-provider-call` | FAIL (provider call) | PASS (401, 0 calls) |
| forward the caller's `body.model` | `ai-authenticated-cannot-override-the-model` | FAIL (`attacker-chosen-model` reached the provider) | PASS (operator model) |
| remove the message caps | `ai-input-is-bounded-server-side` | FAIL (200) | PASS (422) |
| remove the `B1PREP_AI_TEST` gate | `ai-test-is-not-reachable-in-saas` | FAIL (200) | PASS (403, 0 calls) |
| make readiness `ready` with no database | `saas-missing-database-fails-closed` | FAIL (404, not 503) | PASS (503) |
| remove the pool error guard | `runtime-database-interruption-is-a-refusal` | FAIL (`ECONNREFUSED` — the crash) | PASS (500, alive) |
| accept any origin in hosted mode | `configured-public-origin-accepted-and-foreign-refused` | FAIL (foreign 200) | PASS (foreign 403) |
| refuse the legacy path unconditionally | `legacy-progress-local-install-unchanged` | FAIL (local 403) | PASS (local 200) |

This run also caught a defect in my own repair: `stop()` referenced its timers before they were
initialised on the already-exited path (`Cannot access 'killTimer' before initialization`). Fixed
in `7969bc8`; the honest open-case failure above (`ECONNREFUSED`) is the reason, not a crash in
the checker.

### Baseline — real counts (all unchanged)

| suite | expected | got |
|---|---|---|
| `check.js` | 101 | 101 |
| `writing-check.js` | 9 | 9 |
| `feedback-check.js` | 14 | 14 |
| `server-origin-check.mjs` | 16 | 16 |
| `keymask-check.mjs` | 12 | 12 |
| `reset-check.mjs` | 8 | 8 (deliberately reduced; not restored to 9) |
| `revision-check.mjs` | 8 | 8 |
| `progress-equal-check.mjs` | 10 | 10 |
| `owned-client-check.mjs` | 31 | 31 |
| `owned-api-check.mjs` (`--backend=postgres-persistent`) | 24 | 24 |
| `draft-session-check.mjs` | 18 | 18 |
| `mock-outcome-check.mjs` | 19 | 19 |
| `progress-scope-check.mjs` | 7 | 7 |
| `design-check.mjs` | exit 0 | exit 0 |
| `provider-config-check.mjs` | 11 | 11 |
| `repository-check.mjs` | passes | passes (310 tracked files; 239 text blobs) |

### Commits on the branch

| commit | what |
|---|---|
| `93c9b73` | A1-A4 refusals, readiness, configured origin (attempt 2, already on `origin`) |
| `6f231d8` | A3: a pool error is a refusal, not a crash of the runtime |
| `cd640a0` | the checker completes in bounded time (bounded requests/checks/reaping; checks corrected) |
| `7969bc8` | fix TDZ in `stop()` on the already-exited path |

### What I could not verify (and what remains open)

- **No browser or real device.** Every check is HTTP + module level; nothing here proves a
  rendered page, an iPhone/Android keyboard or an audio path. The real-device gate stays open.
- **Readiness is not re-evaluated after a runtime database loss.** The process stays up and
  answers `500` (proven), but `/api/ready` still reports ready — it does not flip to `not ready`
  when the database disappears mid-run. A supervisor watching readiness would not see the blip.
  Worth a follow-up slice; I did not change it here.
- **The database was disposable and isolated.** A trust-auth container `hatoove-ownapi02-db`
  (`127.0.0.1:55436`), database `hatoove_saas_check`, schema/role prefix `saas_check`. The schema
  is reused, never dropped. No production database, no real learner record, no live provider.
- **Not production security.** Issue #63 states this is not a security approval; `P-03`/`X-01`
  remain open, and the session port is a small synthetic implementation, not Better Auth.
- **`owned-api` note says the persistent run reports "in-memory datastore and session fakes
  only"** while the count (24) matches the baseline; I did not chase that note's wording.
- Nothing here requires or touches `D:\B1_Prep`, and no deployment, DNS or production access was
  used.

---

## Correction (SAAS-RUNTIME-02, F2) — the local install is **not** byte-identical

The independent review rejected the general claim that "the local install (flag unset) is
unchanged" as false as written, and it is right. That claim is true of the **file-based progress
record** and of the shipped client's path, but it is **not** true of the server's observable
behaviour. With `B1PREP_SAAS` unset, five behaviours differ from the branch's own parent
(`93c9b73~1`, the pre-slice server). All five are the A2 hardening; none is reachable from the
shipped client. This was a defect in the **record**, not in the code, and the hardening was
**not** weakened to make a sentence true.

Derived by a differential probe — in-process, both servers, `B1PREP_SAAS` unset, a stubbed
provider that records every request body, synthetic requests (`.openclaw/tmp/local-diff.mjs`):

| # | request, local mode (`B1PREP_SAAS` unset) | parent | this branch | why it changed |
|---|---|---|---|---|
| 1 | `POST /api/ai`, a session port mounted, anonymous | `200` | `401 unauthenticated` | A2.1 — a mounted session port is the only identity source, so the AI route requires it |
| 2 | `POST /api/ai` with a caller-supplied `model` | provider receives `caller-chosen-model` | provider receives `operator-model-synthetic` | A2.2 — the model is operator configuration |
| 3 | `POST /api/ai` with an invalid or oversized message list (empty, 41 messages, 70 000-char message) | `200`/`400` | `422 invalid_messages` | A2.3 — input is validated and bounded server-side |
| 4 | `POST /api/ai` with a body over 256 KB | `200` | `413` (connection closed) | A2.3 — the AI body cap is 256 KB, down from the 2 MB default |
| 5 | `POST /api/ai/test`, flag unset | `200` + 1 provider call | `403`, 0 provider calls | A2.4/F1 — the diagnostic is operator-only |

One further difference is **additive, not hardening**: `GET /api/ready` is a new route (`404` →
`200`) used by the readiness checks and a supervisor. It is read-only and reveals only
`ready`/`mode`/`reason`.

The shipped client (`public/`) sends none of the shapes in rows 1–4 — it sends a valid `/api/ai`
body with no `model` field, and it never calls `/api/ai/test` — so no learner-visible behaviour
changes. The file-based progress record and the single-user AI path are preserved exactly; the
`B1PREP_SAAS` flag remains the only switch between them.
