# F-03-H: independent auth/runtime spike review

Execution f03h-20260930-a; owner Hermes in Docker (slot 3, no children). Issue [#7](https://github.com/ronslink/hatoove/issues/7).
Branch `codex/f03-h-spike-review`; worktree `/opt/data/workspaces/hatoove-f03-h`.

## ACK (returned before any edit)

Acknowledged: independent diff review of base `48c3d21` → source commit `5e75ec59d1889fb46a161cdf1af0363ae68f0416` on `codex/f03-h-spike-review`, paths `spikes/auth-runtime/**`, `docs/contracts/PILOT-V0.1.md`, `.github/workflows/pilot-contracts.yml`.
Owner Hermes in Docker, slot 3, no children, no recursive delegation. Read `AGENTS.md`, `docs/AGENT_WORKFLOW.md`, `work/implementation/F-03-H.md` and the dispatch record before editing.
Write only `work/implementation/F-03-H-REPORT.md`; no code, contract, board or dependency changes; no `git checkout`; no `.env`, learner progress, other projects, live provider, server, browser, production or child runs; DB tests not run here (coordinator supplies local PostgreSQL results).
Deliverable: this report, staged alone, source guard run, one commit, branch bundle exported to `/projects/hatoove-handoff/f03h-20260930-a.bundle`. This is independent diff review, not human security signoff.

## Result

Reviewed the diff (`git diff --name-status 48c3d21 5e75ec5`: 17 files, +1228/-3) by reading the committed source, not the coordinator summary. No cross-owner access path, no allowance oversell, no double-release of a reservation, and no case where a late worker can write after deletion were found by static reading. Ten low-severity and informational findings below; none is a merge blocker on the strength of the evidence available to me, but F-01 and F-02 need a decision or a note in the contract before the pilot worker is deployed.

Evidence I actually produced in this worktree (Node v26.5.1):

```text
node tools/check.js                101 passed, 0 failed
node tools/writing-check.js          9 passed, 0 failed
node tools/feedback-check.js        14 passed, 0 failed   (124/124 baseline)
node --check spikes/auth-runtime/{auth,store,server,test}.mjs   OK (4/4)
node tools/repository-check.mjs     156 tracked files; 136 text blobs screened
```

I did not run `spikes/auth-runtime/test.mjs`: it requires the loopback PostgreSQL fixture, and the assignment forbids running the DB tests here. All database-behaviour statements below come from reading `store.mjs`, `schema.sql` and `test.mjs`, not from execution.

## Findings

### F-01 — Medium — A dead worker's reservation is never released when no worker polls again
`spikes/auth-runtime/store.mjs:21-30` (`reapExpired`) is invoked only from `claim()` (`store.mjs:86-87`). It reaps only `status='running' AND tries>=3 AND lease_until<clock_timestamp()`. A job that is claimed once or twice (`tries` 1–2) and whose worker then dies keeps `status='running'`, its expired lease, and its `+1` reservation indefinitely unless another worker calls `claim()` again.
Effect: `entitlements.reserved` drifts upward and the account is eventually refused with `409 allowance_exhausted` (`store.mjs:77`) although no work is running. This is not a race — it is a missing time-based sweep; nothing in the spike releases leases without a polling claim, and the test process itself calls the poller (`test.mjs:102,117,136,147,160`).
Recommendation: add an explicit sweep of expired `running` leases (reap to a classified failure and release the reservation, or requeue while `tries<3`) runnable independently of `claim`, and state the deferred-release window in the contract. Contract `docs/contracts/PILOT-V0.1.md:57` only asks for "polling, graceful shutdown and a reviewed lease renewal policy", which covers the deployed worker but not the accounting drift above.

### F-02 — Low — 64 KiB body cap can reject a draft that is legal under the 12,000-code-unit text rule
`spikes/auth-runtime/server.mjs:25-31` caps the raw body at 65536 bytes; `spikes/auth-runtime/store.mjs:50` accepts `text.length <= 12000` UTF-16 code units (contract `docs/contracts/PILOT-V0.1.md:21`). A text of 12,000 characters that JSON-escapes to six bytes each (e.g. `"\u0001"` repeated) produces a ~72 KB body and is rejected `413 body_too_large` even though `store.save` would have accepted it. Currently untested, and the two limits are documented as if independent.
Recommendation: either measure the cap after parse (or raise it with headroom), or state in the contract that the byte cap also bounds escapable text.

### F-03 — Low — Malformed UTF-8 is silently repaired instead of rejected
`spikes/auth-runtime/server.mjs:32` uses `Buffer.concat(chunks).toString('utf8')`, which substitutes U+FFFD for invalid byte sequences. A malformed body can then parse as JSON and be stored as altered learner text rather than failing as invalid input. Use `new TextDecoder('utf8',{fatal:true})` and map failure to `400 invalid_json`.

### F-04 — Low — Implemented request-parsing contract codes have no test evidence
`test.mjs` exercises 200/201/202, 401, 403 (bad and missing Origin), 404 (cross-owner and legacy route), 409 and 422-unknown-field. The contract's remaining codes are implemented but unverified: `413 body_too_large` (`server.mjs:29`), `415 json_required` (`server.mjs:24`), `400 invalid_json` (`server.mjs:49`), `422 invalid_parent` (`server.mjs:55`), `422 invalid_draft`/`invalid_submission` (`store.mjs:50,62`), `409 idempotency_conflict` (`store.mjs:70`, only the fingerprint-mismatch-for-a-different-revision case is covered indirectly at `test.mjs:93`), the `Cache-Control: no-store` header (`server.mjs:16,42`) and the `GET /api/auth/get-session` allowlist entry (`server.mjs:10-11`). Request parsing is the thinnest-evidenced part of the slice.
Minor related note: the Origin check (`server.mjs:21`) runs before routing, so a non-GET for an unknown path returns 403 rather than the contract's documented 404. Acceptable, but the contract table (`PILOT-V0.1.md:23-34`) does not say so.

### F-05 — Low — "Second migration is empty" is asserted with an unexplained literal
`test.mjs:43` asserts `(await migrateAuth(pool)).trim() === ';'`. That passes only if the pinned library's empty compile output is exactly `;`; it does not assert the absence of `CREATE` statements, so a library change to a different no-op string would keep the test green or make it fail for the wrong reason.
Recommendation: assert `!/create\s+(table|index|type)/i.test(sql)` and that applying twice succeeds, and record the observed literal in the README.
The same subtest's equality check against the committed snapshot (`test.mjs:42`) is the only thing tying `spikes/auth-runtime/auth-schema.sql` to "generated by `getMigrations().compileMigrations()`" (`spikes/auth-runtime/README.md:18`). I could not re-derive that snapshot: it needs the pinned packages and a live PostgreSQL, which this container does not have. The coordinator's local run is the sole evidence for that claim, and I cannot independently confirm the committed SQL byte-for-byte matches library 1.7.6.
I did verify the supporting facts statically: no auto-migration is reachable from the HTTP layer (`server.mjs:12` imports only `createAuth` and `store`; `migrateAuth` is used solely by `test.mjs:41`), and the snapshot contains only the four library tables `user`, `session`, `account`, `verification` with the two indexes the library expects (`auth-schema.sql:1-12`).

### F-06 — Low — Failed jobs are retryable regardless of failure class
Contract `docs/contracts/PILOT-V0.1.md:57` states "Permanent malformed output remains unassessed; retries are bounded and classified." `failJob` (`store.mjs:114-123`) records three distinct codes, but `retry` (`store.mjs:125-136`) admits any `failed` job with `tries<3`, and `test.mjs:118-124` deliberately retries a `malformed_feedback` job and completes it. So classification currently affects only the stored `failure_code`, not retry eligibility. Either narrow `retry` per code or record that the spike treats all codes as retryable within the bound.

### F-07 — Informational — Claim selection is unordered and unindexed
`store.mjs:89-90` selects with `ORDER BY id` over random UUIDs (no fairness/arrival order) and no index exists on `jobs(status, lease_until)`; `schema.sql:31-36` indexes only the `submission_id` unique constraint. Fine at fixture scale; note it before a polling deployment.

### F-08 — Informational — Startup window where the handler sees undefined `baseURL`/`auth`
`server.mjs:69-71` sets `baseURL` and `auth` only after `listen` resolves, while the request handler (lines 15-18, 45) uses both. A request delivered between the socket binding and those assignments throws a `TypeError`, which the catch at `server.mjs:67` turns into a bare `500 internal_error`. The tests cannot hit it (fetch starts after `start()` returns). Cheap hardening: build the request context before listening, or answer `503` while not ready.

### F-09 — Informational — Responses are raw rows; the contract defers DTO mapping
`store.read` (`store.mjs:47`) returns `{...attemptRow, revision, text}`, so `GET /api/v1/attempts/:id` exposes `owner_id`, `deleted_at`, `task_version` and `parent_submission_id`; `store.result` (`store.mjs:145`) returns the whole submission row including `owner_id`. Both are owner-scoped (404 verified at `test.mjs:63,130`), so there is no cross-owner leak, and `PILOT-V0.1.md:40` already requires versioned production DTOs. Recorded so the integration slice does not treat these shapes as the public contract.

### F-10 — Informational — Misleading migration constant and per-call default secret in `auth.mjs`
`spikes/auth-runtime/auth.mjs:23` compiles migrations against a hardcoded `http://127.0.0.1:55436`, a third port that matches neither the database (`55435`, line 9) nor the API's ephemeral port (`server.mjs:69-70`). Harmless while the library ignores `baseURL` for migrations, but it is a trap if `authOptions` validation (line 14) or callers start depending on it. Relatedly, `authOptions` mints a fresh random `secret` per call when none is passed (line 12); the tests always pass one (`test.mjs:10`), so nothing here hides a real defect — but an omitted secret would silently invalidate all sessions across restarts, which should be stated as an explicit non-goal rather than a default.

### F-11 — Informational — Immutability is update-only; deletion behaviour is partly untested
The guard is `BEFORE UPDATE` only (`schema.sql:28-30`), so nothing at the database level prevents deleting a submission/assessment; the spike relies on code never doing so, which matches the documented "logical deletion testing, not privacy erasure" (`PILOT-V0.1.md:73`). The contract's deletion precedence list includes "revision-parent links"; that path is implemented (`store.mjs:34-38`, `a.deleted_at IS NULL`) but is not covered by `test.mjs:157-166`, which tests stale save, replay and late completion only. Also note that `remove()` (`store.mjs:148-157`) deletes only the draft and keeps synthetic submissions/results, as documented.
Related minor wording issue: `PILOT-V0.1.md:50` says "Server-created allowance", while in the spike the allowance row is created by direct test SQL (`test.mjs:26,113`) and no route can create it. Worth a sentence so the row is not read as an implemented server behaviour.

### F-12 — Informational — CI workflow hardening and coverage
`.github/workflows/pilot-contracts.yml`: actions are pinned by SHA with `persist-credentials: false` (lines 24-27, good), but the `postgres:17-alpine` service image is tag-only (line 14) — inconsistent supply-chain posture; `POSTGRES_HOST_AUTH_METHOD: trust` on a published port (lines 15-19) is acceptable on an ephemeral GitHub runner and must not be copied to any shared or production runner (README already says this); the workflow runs only the spike test and never the 124 offline checks or `tools/repository-check.mjs`, so a PR can pass CI with the legacy baseline broken; and there is no `concurrency` group to cancel superseded runs. `node-version: '24'` matches the tested runtime; `engines.node >=22.16` (`spikes/auth-runtime/package.json:1`) is looser than what was actually run.

## Verified as correct (static reading)

- Lock order `entitlement → attempt → job` is consistent in `submit` (`store.mjs:66-67`), `complete` (`101-105`), `failJob` (`117-118`), `retry` (`127-131`), `remove` (`150-153`) and `reapExpired` (`25-26`). Every reservation mutation takes the owner's entitlement row `FOR UPDATE` first, so I found no path that can double-release or oversell `used + reserved <= allowance` (`schema.sql:17`); the DB check is a backstop.
- Authorization comes only from the verified session (`server.mjs:45-47`); ownership is never accepted from the body (`fields(...)` allowlists at `server.mjs:51,54,62-65`, asserted at `test.mjs:58`).
- Enqueue is one transaction: submission, job and reservation commit together, or none do (`store.mjs:64-84`), and the injected `reject_job` trigger confirms rollback (`test.mjs:79-86`).
- Immutable submission is enforced by trigger and by the stored revision lineage; save is blocked after submission (`store.mjs:56-57`) and the snapshot is written from the server-side draft, not the request (`store.mjs:80`).
- Completion is fenced on lease token, database time and the attempt tombstone, and commits assessment, ledger unit, counter update and job success atomically (`store.mjs:100-112`); deletion cancels queued/running work and releases only outstanding reservations (`store.mjs:152-155`), with late completion returning `false` (`test.mjs:164`).
- Scope discipline in the diff itself: root `package.json` is unchanged (no dependency change), `node_modules` is not committed, `spikes/auth-runtime/package-lock.json` is lockfileVersion 3 with `better-auth` 1.7.6, `pg` 8.23.1 and integrity hashes matching `package.json`, and a grep over the new files found no credentials, `.env` loader, learner data or absolute host paths. Coverage against the stated baseline is exactly 124 (101+9+14).

## Limitations of this review

- No database execution here, by assignment. Every statement about transactions, races, the library migration and the 11 subtests comes from reading `store.mjs`, `schema.sql`, `auth.mjs` and `test.mjs`. The coordinator's local PostgreSQL run remains the only execution evidence, and I could not re-verify the login/session, immutable-submission, lease and deletion subtests first-hand.
- The 124 offline checks validate legacy behaviour, not exam validity and not this spike; their pass does not corroborate any finding above.
- `node --check` confirms syntax only, for the four new `.mjs` files; `package-lock.json` consistency was checked by reading, not by `npm ci`.
- Findings F-01 to F-12 are static-reading results; each names the code path so the coordinator can reproduce it. Severity is my judgement for a local, documented, non-production slice; no item is a security signoff, and human security review of production sessions, recovery email, abuse controls, SQL roles/RLS and deployment configuration (`PILOT-V0.1.md:17`, `work/implementation/PRE-05.md`) is still outstanding.
- I did not review `work/BOARD.md` or the non-spike `work/implementation/*.md` task text as code: they are coordinator records outside the assigned file set, and no code, contract, board or dependency file was modified by this execution.
