# F-02/A-01-R: independent SQL-boundary design review
- **Task:** F-02/A-01-R, independent review of F-02/A-01 ([issue #13](https://github.com/ronslink/hatoove/issues/13))
- **Execution ID:** `f02r-20260930-a` · **Owner/host:** OpenClaw on Hetzner, slot 2 — no children, no recursive delegation
- **Base commit:** `a9a4cfd95992df95dc76bdbab3bbb690efe4841f` · **Branch:** `codex/f02-a01-role-review` · **Worktree:** `/root/workspaces/hatoove-f02-a01-review`
- **Issued:** 2026-09-30 18:15 UTC · **Checkpoint:** 18:30 UTC · **Expires:** 19:15 UTC
- **Revision:** 1 — **design review only**; the implementation commit is not inspected and not approved here (separate final checkpoint).

## Scope, inputs and method
Read `AGENTS.md`, `docs/AGENT_WORKFLOW.md`, `docs/contracts/PILOT-V0.1.md` (0.1.0), `docs/REPOSITORY_BASELINE.md`, issue #13 and `spikes/auth-runtime/*` at base `a9a4cfd`. Read-only: no source/board/`.env` edits, no server, no database, no live provider, no cloud/production access; the only written artifact is this file.

| Command | Result |
|---|---|
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |
| `node tools/repository-check.mjs` (staged snapshot) | run before commit; see PR body |

124/124 matches the recorded legacy baseline; it tests legacy behaviour, not exam validity and not the unimplemented role/RLS boundary. Nothing else ran.

## Design under review
Objective (issue #13): four local roles — migration, auth, learner, worker — with **no** superuser/`CREATEROLE`/`CREATEDB`/`BYPASSRLS`/runtime DDL; `FORCE ROW LEVEL SECURITY` on learner tables; owner context via transaction-local `set_config` **after** server session verification (`server.mjs:47`); explicit worker processing policies; auth limited to library CRUD on `user`/`session`/`account`/`verification`.
**Verdict: the shape is right and should be implemented.** `FORCE RLS` + `NOBYPASSRLS` + transaction-local context + separate logins is the correct local least-privilege pattern, and the spike already supplies the invariants it must preserve: composite FKs carrying `owner_id` (`schema.sql:24,27,35,40,45`), immutable submissions (`schema.sql:28-30`), lease fencing (`store.mjs:21-29`), idempotent enqueue and exactly-once debit. The findings below decide whether the boundary holds.

## Findings
**R-01 (high) — `WITH CHECK` must pin the row owner.** Learner INSERT/UPDATE policies need `WITH CHECK (owner_id = current_setting('app.owner_id', true))`, not only `USING`; otherwise a context can write rows stamped with another owner's id (`submissions`, `usage_ledger`, an `attempts` row for another user) while reads stay filtered. Every learner-writable table needs both clauses; SELECT/DELETE need `USING` only.
**R-02 (high) — a policy is per-table and must not read back into itself.** If `jobs`/`assessments`/`usage_ledger`/`drafts` lack a policy, a learner context reads other owners' rows via a join or a direct `SELECT`. Conversely, a `submissions` policy probing `attempts.deleted_at` is itself subject to `attempts`' policy; a cycle raises `infinite recursion detected in policy`. Keep tombstone visibility in the owning query (as the spike does, `store.mjs:14,45,113`) or an invoker-rights helper, never in a second policy.
**R-03 (high) — a role that can set `app.owner_id` is not an isolation boundary.** PostgreSQL lets any role set a custom `app.*` GUC. With direct learner grants, `SET LOCAL app.owner_id='<other>'` returns the other account. This stops an application bug or missing predicate from returning cross-owner rows; it does not stop a backend that chooses its own context, or a client holding the learner credential with SQL. Record that boundary in `LOCAL-ISOLATION.md`; never claim resistance to a compromised trusted backend.
**R-04 (medium) — membership and `SET ROLE` escalate past RLS.** A runtime login that is a member of the migration/owner role can `SET ROLE` to the owner; the owner is subject to policies only because of `FORCE RLS`, and any `BYPASSRLS` silently voids everything. Grant no membership to runtime logins, set `NOBYPASSRLS` on all four, and assert the attributes (R-14).
**R-05 (medium) — context leaks through the pool unless strictly local.** `set_config(..., true)` must wrap the same transaction as the queries, on the checked-out client, after `getSession`. Session-scoped `set_config(..., false)`, a bare `SET`, a reset gap across checkouts, or a helper that commits and continues on the same client all leak the previous owner. Test both directions (R-11).
**R-06 (medium) — grant surface, default privileges, unbounded `EXECUTE`.** `GRANT ... ON ALL TABLES` is a snapshot: a table added by a later migration is invisible → runtime 500; use `ALTER DEFAULT PRIVILEGES` from the creating (migration) role. Revoke `EXECUTE ... FROM PUBLIC` on any helper, `CREATE` on the app schema, and `UPDATE` on `entitlements` from the learner — a learner-owned row is still rewritable (`used`/`reserved`/`allowance` must be server/worker-only, ideally column-scoped). The auth role inherently needs `account.password`/`session.token`/`verification.value`; it is the credential-bearing role, so learner/worker need **zero** privileges on the auth tables (and on `"user"`, since RI checks need no grant).
**R-07 (medium) — cross-table FKs must carry `owner_id`; RI checks bypass RLS.** The composite keys (`FOREIGN KEY(attempt_id, owner_id) REFERENCES attempts(id, owner_id)`, `schema.sql:24,27,35,40,45`, with `UNIQUE(id, owner_id)` at `:6,25`) are load-bearing: RI validation runs without RLS, so a single-column FK would let a learner attach a row to another owner's attempt by guessing a UUID. Keep them; add the mirror test (R-13).
**R-08 (medium) — `FOR UPDATE`/`SKIP LOCKED` policies diverge per role, and locks outlive context.** The worker needs a processing policy over all owners' `queued`/expired-`running` jobs (`SKIP LOCKED`); the learner policy must not. `FOR UPDATE` on a policy-hidden row returns nothing, so the existing 404-on-missing behaviour (`store.mjs:14`) stays correct. Claim and completion are separate transactions (`store.mjs:95-104,105-122`); the lease token, not `app.owner_id`, is the fence — do not assume context across them.
**R-09 (medium) — deletion and retry are policy cases, not only query cases.** A tombstoned attempt must stay invisible to saves, idempotent replays and late completions under the learner policy; the retry endpoint touches `jobs` and may run on the worker pool, so fix which role serves it and locate the tombstone predicate there. Retry re-queue plus exactly-once debit must stay atomic against the ledger PK; the counter update must not become silently skippable drift.
**R-10 (low) — migration ordering and the generated snapshot.** Order: roles → library tables → app tables (FK to `"user"`) → grants/policies. Keep generated `auth-schema.sql` separate from the reviewed isolation SQL so a library regeneration cannot overwrite role/RLS DDL and the byte-equality test still means "library output unchanged".

## Focused negative tests (exact; disposable loopback DB only)
Against synthetic random schema/roles on the fixture container; none may touch `progress.json`, `.env`, ports 4321/4381 or production. Assert exact outcomes:
- **R-11 context lifecycle** — as learner login: `BEGIN; SELECT count(*) FROM attempts;` → `0` (or error), never all rows; `BEGIN; SELECT set_config('app.owner_id',$alice,true); SELECT count(*) FROM attempts;` → alice only; on the **same** pooled connection after `COMMIT` → `0`; same transaction then `ROLLBACK` → next select `0`.
- **R-12 no-context write** — context absent: `INSERT INTO attempts(owner_id,...)` → rejected, 0 rows.
- **R-13 cross-owner write/link** — context alice: `INSERT INTO submissions(...,owner_id=$bob,...)` → error; `UPDATE attempts SET owner_id=$bob WHERE id=$alice` → 0 rows/error; `INSERT` with `parent_submission_id=$bob_sub` → FK/policy failure.
- **R-14 role attributes** — `SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolcanlogin FROM pg_roles` → all false except the intended logins; `pg_class.relrowsecurity/relforcerowsecurity` true on every learner table; as learner/worker/auth: `CREATE TABLE t(i int)` denied, `ALTER TABLE attempts DISABLE ROW LEVEL SECURITY` denied, `SET ROLE hatoove_migration` denied.
- **R-15 privilege probes** — `has_table_privilege('hatoove_learner','"user"','SELECT')` false; `has_table_privilege('hatoove_auth','attempts','SELECT')` false; `has_table_privilege('hatoove_learner','entitlements','UPDATE')` false; `has_function_privilege('hatoove_learner',<helper>,'EXECUTE')` false for a revoked helper.
- **R-16 `row_security` off-GUC** — as learner: `SET row_security = off; SELECT ...` → error ("query would be affected by row-level security policy"), not a bypass.
- **R-17 cross-table join** — context alice, with a bob row present: `SELECT count(*) FROM submissions s JOIN jobs j USING(submission_id) JOIN assessments a USING(submission_id) JOIN usage_ledger u USING(submission_id)` → alice only.
- **R-18 worker scope** — as worker login: see two owners' `queued` jobs, claim exactly one via `SKIP LOCKED`; write `assessments` + `usage_ledger` + counter update in one transaction; a second completion with the stale lease token → no effect; assert its draft-read policy.
- **R-19 deletion** — after tombstone: alice-context reads/saves/replays/late-completion → `404`/no row/no effect; reservation released, ledger unchanged; retry → `409 retry_unavailable`; attempt not resurrected.
- **R-20 default privileges** — a table created by the migration role after the initial grant is reachable by the learner per `ALTER DEFAULT PRIVILEGES` (or explicitly re-granted), so no silent runtime 500.
- **R-21 migration idempotence/snapshot** — the isolation migration applies twice successfully; regenerated `auth-schema.sql` still equals the committed snapshot and still contains only the four library tables (isolation DDL lives elsewhere).

## Required boundary distinction
This design is **defence in depth**: it constrains the application's own SQL so a missing predicate or join bug cannot read/write another account, and it fails closed on absent context. It is **not** a boundary against a compromised backend that chooses `app.owner_id`, nor against anyone holding a runtime role's credentials and SQL — custom GUCs are settable by that role, RI checks run outside RLS, and owner/`BYPASSRLS` escapes exist. No production-isolation or anti-tamper claim is made.

## Limitations and non-claims
- Design review at base `a9a4cfd`; **no implementation was inspected** and none is approved. R-01…R-10 are risks/tests handed to the implementation commit and its final checkpoint.
- No database, role, policy or migration was executed here; DB statements are expectations to test, not results. The 124 checks do not exercise roles/RLS.
- Human security review of production sessions, recovery, abuse and deployment remains a gate; this report is not that review.

## Next action
Coordinator: fold R-01…R-21 into `docs/contracts/LOCAL-ISOLATION.md` and F-02/A-01, then supply the implementation commit. Reviewer: at the final checkpoint, inspect that diff and verify R-11…R-21 against actual role connections before any approval.
