> **Status update — attempt b (`ocli-r1b-20260930-a`, 2026-09-30 19:28 UTC):** the delivery blocker below is
> resolved; the candidate is fetchable from `origin`, the substantive review is complete, and the current
> verdict is **ACCEPT-WITH-NOTES** (see "Attempt b — substantive review" at the end of this file). The
> blocked record is preserved unchanged underneath.

# OCLI-R1 — independent review of Hermes OWNED-CLI-01 (execution `ocli-r1-20260930-a`)

- Reviewer: OpenClaw/Hetzner, slot 3 — independent reviewer, **not** the author.
- Issued: 2026-09-30 19:28 UTC · checkpoint 19:50 UTC · expires 20:30 UTC.
- Issue: https://github.com/ronslink/hatoove/issues/23
- Task record: `/tmp/ocli-r1-20260930-a.md`
- Review branch: `codex/ocli-r1-review` (this branch), report start 2026-09-30 19:23 UTC.
- Host: `ron-openclaw-server`, node `v22.23.2`, repo clone `/root/workspaces/hatoove` (worktree `/root/workspaces/hatoove-ocli-r1-review`).

## Verdict

**BLOCKED — delivery failure. No candidate code was available to review.**

This is **not** an `accept`, `accept-with-notes` or `reject` of the candidate. The candidate under review
(branch `codex/owned-client-01` @ `009d93139bf6157a2637a2dab07f69e969d7ef3a`) was **not present on this host
in any reachable form**: not on `origin`, not in the local git object database, and not on disk as a bundle or
files. Because the artifact is absent I could not run the author's checker, extract the tree, or write any
adversarial probe. Every one of the eight required focus items is therefore reported as **NOT ASSESSED**, not
as a pass. I am deliberately not emitting per-item findings or an accept/reject for code I never saw.

The toolchain is healthy (see "Actual test counts"): the blocker is purely that the candidate was never
delivered to this reviewer.

## Candidate availability (verified independently)

Expected: `codex/owned-client-01` @ `009d93139bf6157a2637a2dab07f69e969d7ef3a`, based on
`074aebf9697d9a2b047a59b993a3178d94f1fb9f` (`origin/main`).

Observed on this host:

| Check | Command | Result |
|---|---|---|
| Commit object present locally | `git cat-file -t 009d93139bf6157a2637a2dab07f69e969d7ef3a` | `fatal: could not get object info` |
| Commit in any local object | `git cat-file --batch-all-objects --batch-check \| grep 009d931` (539 objects) | no match |
| Branch on origin | `git ls-remote --heads origin` | 16 heads, no `codex/owned-client-01` |
| Any origin ref at that SHA | `git ls-remote origin \| grep -iE '009d931\|owned\|ocli'` | no match (`rc=1`) |
| Bundle on disk | `find / -xdev -name '*.bundle'` | only unrelated `evidence-trader` bundles |
| Candidate files on disk | `find / -xdev \( -name 'owned-client.js' -o -name 'OWNED-CLIENT.md' -o -name 'owned-client-check.mjs' \)` | none |
| Candidate source text on disk | `grep -rl 'createOwnedClient' /` (excluding node_modules/.git/proc/sys) | only `/tmp/ocli-r1-20260930-a.md` (the task) and this agent's own session store |
| Documented handoff path | `ls /projects/hatoove-handoff/ocli-20260930-a.bundle` | `/projects` does not exist on this host |
| Local worktree | `git rev-parse HEAD` in review worktree | `074aebf…` (= `origin/main`); candidate paths absent |

The candidate files are absent from the checked-out base tree as well:

```
ABSENT  public/js/owned-client.js
ABSENT  tools/owned-client-check.mjs
ABSENT  docs/contracts/OWNED-CLIENT.md
```

Only `origin` is configured (`https://github.com/ronslink/hatoove.git`); there is no second remote or bundle
remote that could hold the candidate. Issue #23 itself carries no bundle link or attachment; the coordinator's
own text places the export at `/projects/hatoove-handoff/ocli-20260930-a.bundle`, which exists on the
Hermes/Ron handoff host, not here.

## Actual test counts (base tree `074aebf`)

Run on this host to prove the toolchain is functional and that the candidate checker is genuinely missing:

| Command | Result |
|---|---|
| `node tools/check.js` | `101 passed, 0 failed` |
| `node tools/writing-check.js` | `9 passed, 0 failed` |
| `node tools/feedback-check.js` | `14 passed, 0 failed` |
| `node tools/owned-client-check.mjs` (author's checker) | **not run — file does not exist on any reachable tree** |

The offline baseline matches the recorded `101 + 9 + 14`. The reported candidate checker count (28/28) is
**not reproduced or verified here**; I make no claim about it. These baseline numbers describe legacy behaviour
on the base commit only; they are not evidence about the candidate.

## Per-item status (required focus 1–8)

| # | Focus | Status |
|---|---|---|
| 1 | Account-generation fencing (late responses, stale 401, synchronous invalidation, post-await re-check) | **NOT ASSESSED** |
| 2 | Ignored `AbortSignal` (fence holds with a never-aborting fake) | **NOT ASSESSED** |
| 3 | Stale 401 vs current 401 | **NOT ASSESSED** |
| 4 | Sign-out failure semantics (local identity cleared, failure reported honestly) | **NOT ASSESSED** |
| 5 | Payload allowlists (no injected `owner_id`/revision/score/model/prompt via args or nested objects) | **NOT ASSESSED** |
| 6 | No automatic POST retries (exactly-once mutation, same `eventId` left to caller) | **NOT ASSESSED** |
| 7 | Exact contract responses vs `docs/contracts/PILOT-V0.1.md` and `spikes/auth-runtime/*` | **NOT ASSESSED** |
| 8 | Boundary hygiene (no DOM/storage/timers/module-scope network/`baseURL`; routes confined to `/api/auth` + `/api/v1`) | **NOT ASSESSED** |

All eight remain open. No probe was written because there is no candidate to probe; writing "pass" or "defect"
here would be fabricated evidence.

## Required to proceed

Any one of the following makes the review runnable from this host:

1. **Push the candidate branch** so it is fetchable:
   `git push origin codex/owned-client-01` with head `009d93139bf6157a2637a2dab07f69e969d7ef3a` (preferred — the
   other reviewers' candidates arrived this way), **or**
2. **Place the Hermes bundle at a path reachable from this host** and state the absolute path
   (the documented `/projects/hatoove-handoff/ocli-20260930-a.bundle` is not present here), **or**
3. Fetch the bundle into the local object store (`git fetch <bundle> codex/owned-client-01`) and report the
   resulting ref.

Once delivered I will, within the remaining assignment window: extract read-only via
`git archive 009d931` into an ignored scratch path, run `node tools/owned-client-check.mjs` and the offline
baseline, then write separate adversarial probes for items 1–8 and replace this report with the full
per-item findings and an explicit accept / accept-with-notes / reject.

## Decisions for the coordinator

1. **Re-deliver the artifact** (method above), or **re-dispatch OCLI-R1 under a new execution ID** if the
   current lease is considered spent. This blocked attempt should not be counted as evidence for or against
   the candidate.
2. Confirm whether the author's claimed checker output (28/28) and the coordinator's prior bundle verification
   are to be treated as provisional until an independent run exists, or re-run independently.
3. The delivery gap is process, not code: the OCLI handoff documented an export path on the Hermes/Ron host but
   no pull/push path to reach this reviewer. Worth fixing for subsequent Hermes bundles (e.g. always also push
   the candidate branch to `origin`).

## Boundaries honoured

- Read-only review; the candidate branch was not edited, checked out, merged, rebased or force-pushed.
- No writes to any `public/**`, `tools/**`, `docs/**`, `tests/**`, `spikes/**` path. The only new file is this
  report.
- No browser, server, database, `.env`, provider, live-AI or device run. Only the offline baseline checkers
  were executed.
- No merge. This report is a delivery-blocker record, not a code review.

## Appendix — exact commands and raw results

```
$ git -C /root/workspaces/hatoove-ocli-r1-review rev-parse HEAD
074aebf9697d9a2b047a59b993a3178d94f1fb9f
$ git rev-parse --abbrev-ref HEAD
codex/ocli-r1-review
$ git cat-file -t 009d93139bf6157a2637a2dab07f69e969d7ef3a
fatal: git cat-file: could not get object info
$ git cat-file --batch-all-objects --batch-check | wc -l
539
$ git cat-file --batch-all-objects --batch-check | grep -i '009d931\|7a2637a2dab07'
(no output)
$ git ls-remote --heads origin
… 16 heads: codex/c01-discovery, codex/coord-takeover-01, codex/coordinator-cadence,
codex/e01-sources-user03, codex/f02-a01-local-isolation, codex/f02-a01-role-review,
codex/f03-a-legacy-audit, codex/pilot-01-css-user02, codex/pre-02-openclaw, codex/pre-03-hermes-b,
codex/pre-05-runtime-contracts, codex/progress-20260930, codex/user04-r2-review, codex/user04-r2b-review,
codex/user04-source-fixtures, main
$ git ls-remote origin | grep -iE '009d931|owned|ocli'   # (exit 1, no match)
$ find / -xdev -name '*.bundle'
/root/evidence-trader-remediation-20260824T132420847Z/predeploy-*/….bundle   (unrelated)
/root/et-sync.bundle                                                        (unrelated)
$ find / -xdev \( -name 'owned-client.js' -o -name 'OWNED-CLIENT.md' -o -name 'owned-client-check.mjs' \)
(no output)
$ grep -rl 'createOwnedClient' /   # excluding node_modules/.git/proc/sys
/tmp/ocli-r1-20260930-a.md
/tmp/openclaw-agent-exec-*/agents/main/agent/openclaw-agent.sqlite   (this reviewer's own session store)
$ ls /projects
ls: cannot access '/projects': No such file or directory
$ node tools/check.js            => 101 passed, 0 failed
$ node tools/writing-check.js    => 9 passed, 0 failed
$ node tools/feedback-check.js   => 14 passed, 0 failed
```

Environment: `date -u` = `Wed Sep 30 19:23:05 PM UTC 2026`, node `v22.23.2`, shell `bash`.

---

# Attempt b — substantive review (execution `ocli-r1b-20260930-a`)

Candidate delivery is now fixed: the branch is fetchable from `origin`. This section supersedes the blocked
record **only as far as delivery goes**. The blocked record above is preserved unchanged.

- Reviewer: OpenClaw/Hetzner, slot 3 — independent reviewer, **not** the author (Hermes/Docker wrote the candidate).
- Execution: `ocli-r1b-20260930-a` · issued 2026-09-30 19:28 UTC · checkpoint 19:50 UTC · expires 20:30 UTC.
- Issue: https://github.com/ronslink/hatoove/issues/23 · task `/tmp/ocli-r1b-20260930-a.md`.
- Pinned head: `codex/owned-client-01` @ **`009d93139bf6157a2637a2dab07f69e969d7ef3a`** — verified on origin and
  by extracting that exact object (`git rev-parse origin/codex/owned-client-01` → matches; `git archive <sha>`).
- Base: `074aebf9697d9a2b047a59b993a3178d94f1fb9f` (`origin/main`).
- Changed paths vs base: exactly the three allowed files, all **added**, nothing else touched —
  `docs/contracts/OWNED-CLIENT.md`, `public/js/owned-client.js`, `tools/owned-client-check.mjs`.

## Verdict

**ACCEPT-WITH-NOTES.**

The candidate is a genuine transport boundary and it does what it claims. Above all, the item-1 property holds:
I could not construct a case where a late response belonging to a superseded identity is exposed, **including
with a transport that ignores `AbortSignal` entirely and with `AbortController` removed**. The three notes
below are low severity, none is an identity/authority leak, and none blocks integration. Two of them are
documentation wording that only the author/coordinator may change.

## Method and actual counts

- Extracted read-only with `git archive 009d931… | tar -x -C <scratch>` inside an ignored scratch path; never
  checked out over this report branch; candidate branch untouched.
- Ran the author's checker and the offline baseline on the extracted tree, then wrote my **own** adversarial
  suite (fakes that never honour `AbortSignal`, race-free call capture, deferred gates).

| Command | Result |
|---|---|
| `node tools/owned-client-check.mjs` (author's checker) | **28 passed, 0 failed** (28 `check()` blocks) |
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |
| reviewer's adversarial suite (`.openclaw/tmp/probes/`, scratch, not committed) | **180 passed, 0 failed** |

Baseline `101 + 9 + 14` is unchanged from the recorded count; the candidate adds only new files and does not
modify any legacy module or existing test. Node `v22.23.2`.

## Per-item findings (required focus 1–8)

### 1. Account-generation fencing — PASS (one low note)

Probed every learner method (`createAttempt`, `readAttempt`, `saveDraft`, `submit`, `readResult`, `retry`,
`deleteAttempt`) against every transition (`clear()`, `signOut()`, `refreshAccount()` A→B):

- late **success** after `clear()` / `signOut()` / account transition → every one rejects `stale_session`;
  the identity stays cleared / stays the new account; the generation advanced exactly once (7 × 3 probes);
- late **errors** after `clear()` — `401`, `500`, non-JSON `200`, empty `200`, `204`, and a network rejection —
  all reject `stale_session` rather than the underlying error, adopting/clearing nothing;
- a late `401` delivered after the caller re-authenticated as another account left that newer account intact and
  did **not** bump the generation again;
- `clear()` and `signOut()` call `invalidate()` **synchronously** before awaiting; a `refreshAccount()` identity
  transition (changed id, or current-generation 401) invalidates synchronously before its promise settles, because
  the superseded check runs *before* `adopt()`/`invalidate()`;
- a `refreshAccount()` confirming the **same** account is correctly not a transition: it neither aborts nor fences
  a valid in-flight save (verified for all seven methods).

The post-`await` re-check (`superseded(gen, id)`) is present and correct in the learner `call()` path and in both
`refreshAccount()` paths.

> **Note 1 (low, robustness — no exposure).** The internal `authRequest()` used by `signIn`/`signUp` is the one
> place that does **not** re-check the generation on its *catch* path; it relies on `toClientError()` consulting
> `signal.aborted`. Proven with a minimal case: remove `AbortController`, supersede the call before the auth POST
> settles, and make the POST reject — the result is `network_error` instead of `stale_session`. With
> `AbortController` present (all real browsers, Node ≥ 18) the same case yields `stale_session` because
> `invalidate()` aborts the captured controller. No identity or authority is exposed in either case, so this is
> optional hardening, not a defect.

### 2. Ignored `AbortSignal` — PASS

The reviewer's fakes never read `init.signal`. All 180 probes pass on the generation fence alone
(`generation !== gen || currentId() !== id`), so the fence does not depend on the abort firing. The whole item-1
matrix also passes with `AbortController` deleted. (The controller abort still fires — `signal.aborted === true` —
but the rejection is driven by the post-await re-check.)

### 3. Stale 401 vs current 401 — PASS (one low note)

- An old-generation `401` (arriving after the identity moved to another account) → `stale_session`; the newer
  account survives and the generation is untouched.
- A current-generation `401` on a learner call → `unauthenticated` with `status: 401`, and the local identity is
  invalidated.

> **Note 3 (low, doc wording / decision).** A `401` from the auth POSTs (`/api/auth/sign-in|sign-up`) is reported
> `unauthenticated` but does **not** clear an already-verified identity. `docs/contracts/OWNED-CLIENT.md` says "a
> current-generation 401 invalidates the local context", which reads as if it would. The behaviour is defensible
> (a failed re-auth need not drop a live session); the wording should be tightened. Coordinator decision.

### 4. Sign-out failure — PASS

`signOut()` invalidates first (identity cleared, generation bumped, old-generation work aborted) and then posts
`/api/auth/sign-out` exactly once. A `500` → `server_error` (with a sanitized detail token), a transport failure →
`network_error`, a `401` → `unauthenticated`; in every case `getAccount()` stays `null`. No half-invalidated
state, no fabricated success.

### 5. Payload allowlists — PASS

23 injection attempts across every method (extra arguments, nested objects, and privileged keys: `owner_id`,
`revision`, `score`, `model`, `prompt`, `status`, `assessment`, `role`, `user_id`, `attempt_id`, `entitlement`,
`grade`, plus `baseURL`/`ownerID`/`origin`/bad `fetchImpl` on the factory) all reject `invalid_request` and send
**zero** requests. Inherited (`Object.create`) keys and `Symbol` keys are ignored by `Object.keys` and cannot reach
a body — the real guarantee is that request bodies are built field-by-field and never spread from caller input, so
even a bypass of the allowlist could not add a field. No route segment is caller-controllable: ids are validated
canonical UUIDs before path construction.

### 6. No automatic retries — PASS

Every mutation (`createAttempt`, `saveDraft`, `submit`, `retry`, `deleteAttempt`, `signOut`) is attempted exactly
once on `500`, network failure and malformed `200`; `send()` contains no retry loop. An uncertain `submit` is
reported to the caller, and an explicit second `submit` reuses the caller's `eventId` verbatim (both requests
carried the same id). The client never generates or substitutes an event id.

### 7. Exact contract responses — PASS

- **Request shapes** match `spikes/auth-runtime/server.mjs`: create `{}`/`{parentSubmissionId}`; save
  `{expectedRevision,text}`; submit `{expectedRevision,eventId}`; retry/delete `{}`; GETs bodiless.
  `credentials:'same-origin'`, `cache:'no-store'`, `content-type: application/json` on every non-GET, `accept`
  everywhere, no manual `Origin`.
- **Response shapes** match `spikes/auth-runtime/store.mjs`: `201` create, `200` read/save, `202`
  `{submissionId,replay}`, `200` result `{submission,job,assessment}`, `202` `{queued}`, `200` `{deleted}`, and the
  account `{contractVersion,id,email}`.
- **No silent success**: empty `200`, `204`, non-JSON, `null`, array, missing / non-integer `revision`, missing /
  non-string `text`, over-limit `text`, id mismatch, unknown `job.status`, mismatched `submission.id`, scalar
  `assessment`, non-boolean `replay`/`queued`/`deleted`, account `contractVersion` mismatch (→
  `unsupported_contract`, no identity adopted), missing / blank account id and empty body are all rejected. A
  `json()`-only body path is also handled.

### 8. Boundary hygiene — PASS (one low doc note)

No `window`/`document`/storage/`indexedDB`/timers/`requestAnimationFrame`/`navigator`/`new URL`/absolute
URL/`process`/`require` in the module. `fetch` is not referenced at module scope: with `globalThis.fetch`
instrumented before import, zero calls occur. `createOwnedClient` rejects `baseURL`/`ownerID`/`origin` and a
non-function `fetchImpl`. Every observed URL matches the fixed allowlist
(`/api/auth/{sign-in,sign-up}/email`, `/api/auth/sign-out`, `/api/v1/account`, `/api/v1/attempts[/:uuid[/submissions]]`,
`/api/v1/submissions/:uuid[/retry]`); no legacy `/api/progress`, `/api/ai` or `/api/config` is reachable.

> **Note 2 (low, doc nit).** The module doc says `config.fetchImpl` "is read **per call**"; the code reads it once,
> at `createOwnedClient()`. Consequence: a client built before a fetch polyfill exists stays `transport_unavailable`
> even after `globalThis.fetch` appears. The essential claim — no module-scope network work — holds. Doc-only fix.

## Decisions for the coordinator

1. **Accept the transport boundary.** No stale-identity exposure was found, including under an abort-ignoring
   transport and with `AbortController` removed.
2. **Confirm Note 3.** Decide whether an auth-POST `401` should invalidate an existing verified identity, or whether
   the "current-generation 401 invalidates" sentence in `docs/contracts/OWNED-CLIENT.md` should be scoped to learner
   calls. Not observable without a server.
3. **Note 2 (doc wording).** Have the author/coordinator change "read per call" to "read at factory creation" in
   `docs/contracts/OWNED-CLIENT.md`. I must not touch that file.
4. **Note 1 (optional hardening).** Add the same superseded re-check to `authRequest()`'s catch path for symmetry;
   no defect in practice while `AbortController` exists.

## Limits of this review

- Transport-level only, on injected fakes. This proves **transport** behaviour on fakes, not the server contract: it
  says nothing about whether a real server answers these DTOs, enforces ownership/origin, uses `no-store` or keeps
  the 12,000-code-unit bound. This is not an educational, content, exam-validity, security or privacy approval.
- The author's 28 checks were executed and reported as a count, but are deliberately **not** treated as evidence for
  items 1–8; the findings above rest on the reviewer's own probes.
- Hermes is a peer agent; the artifact was reviewed on its merits. The candidate is sound as delivered.

## Boundaries honoured

- Candidate branch not edited, not checked out over this report branch, not merged, rebased or force-pushed;
  read-only extraction via `git archive`.
- Only one path on this branch: `work/implementation/OCLI-R1-REPORT.md` (preserved blocked record + this section).
- No browser, server, database, `.env`, provider, live-AI or device run; no writes to any
  `public/**`, `tools/**`, `docs/**`, `tests/**` or `spikes/**` path.

## Reviewer probe inventory (scratch, not committed)

- `.openclaw/tmp/probes/ocli-r1b-probes.mjs` — 180 assertions, 0 failed.
- `.openclaw/tmp/probes/edge.mjs` — the Note 1 / Note 3 minimal reproductions.
- Harness: fakes that never honour `AbortSignal`; call captured at fetch time (not indexed later); deferred gates
  for settable resolve/reject. All probe files live in the reviewer's scratch workspace and are not part of the branch.
