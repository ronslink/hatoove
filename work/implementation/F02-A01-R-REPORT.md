# F-02/A-01-R: independent SQL-boundary review
- **Task:** F-02/A-01-R, independent review of F-02/A-01 ([issue #13](https://github.com/ronslink/hatoove/issues/13))
- **Execution ID:** `f02r-20260930-a` · **Owner/host:** OpenClaw on Hetzner, slot 2 — no children, no recursive delegation
- **Base commit:** `a9a4cfd95992df95dc76bdbab3bbb690efe4841f` · **Branch:** `codex/f02-a01-role-review` · **Worktree:** `/root/workspaces/hatoove-f02-a01-review`
- **Lease expires:** 19:15 UTC (issued 18:27, checkpoint 18:40, 2026-09-30)
- **Revision:** 2 — **final implementation checkpoint.** Inspected commit `082524afe276a32c443957ca96fb13f0617c0bf9` on `codex/f02-a01-local-isolation` against `a9a4cfd` by `git show`/`git diff` only; the implementation branch was never checked out over this report worktree.

## Method and what actually ran
Read the full diff (`spikes/auth-runtime/**`, `docs/contracts/LOCAL-ISOLATION.md`, workflow, board) at `082524a`; read `schema.sql`, `store.mjs`, `server.mjs`, `auth.mjs`, `isolation.sql`, `isolation-fixture.mjs`, `isolation.test.mjs` in full. Read-only: no source/board/`.env` edits; the only written artifact is this file (plus an ignored source-only archive and one offline script under `.qa/`).

| Run here (Hetzner) | Result |
|---|---|
| `node --check` on the six changed/new `spikes/auth-runtime/*.mjs` | all parse (offline) |
| `node tools/check.js` / `writing-check.js` / `feedback-check.js` | 101 / 9 / 14 passed, 0 failed |
| `.qa/static-check.mjs` (offline grant/policy cross-check of `schema.sql` + `isolation.sql`) | 7 tables ENABLE+FORCE; 15 policies; 24 grants; **no DML grant without a matching policy**; no table without a policy |
| `node tools/repository-check.mjs` on the staged report | see PR body |

**Not run here:** no PostgreSQL, role, migration or HTTP journey. No DB is authorized on this host and none was installed or started. The coordinator's reported results — 10 isolation runner checks (9 scenarios + parent), 13 original contract checks (12 scenarios), 124 baseline — are taken as reported, **not reproduced**. `LOCAL-ISOLATION.md` and the test file are inspected coverage, not execution evidence from this host.

## Verdict (local fixture scope)
The four-role least-privilege boundary is **correctly implemented as inspected**: `FORCE RLS` on all seven tables, per-table learner policies with matching `WITH CHECK` on every writable command, explicit (non-`BYPASSRLS`) worker policies, transaction-local owner context set from the verified server session, and column-scoped grants that keep allowance/used/results/immutability outside learner reach. I found **no cross-owner read or write leak** in the reviewed SQL, and no grant that exceeds its policy. The residual findings below concern fixture lifecycle, one code/doc mismatch and evidence scope — not isolation defects. This is **not** a production approval and does not replace the human security review.

## Findings — actual defects
**I-01 (low; code/doc mismatch, real).** `reapExpired()` issues its first `SELECT id,owner_id FROM jobs …` through `pool.query` outside the `tx()` helper (`store.mjs:39-40`), so that statement carries no `hatoove.owner_id`. It is the only path that breaks the "always set the context, empty when unscoped" rule (`store.mjs:14-15`). Impact today is nil because the worker policy is `worker_jobs USING(true)` (`isolation.sql:73`), but `LOCAL-ISOLATION.md` ("an unscoped call explicitly sets an empty value and fails closed") is broader than the code. Fix: run it inside `tx()`, or narrow the sentence.

**I-02 (medium; fixture state not restored, and the test depends on it).** `isolation-fixture.mjs:23` revokes `CREATE,TEMPORARY` on database `hatoove_spike` from PUBLIC on every run and never restores it. The `CREATE TEMP TABLE` denial (`isolation.test.mjs:39`) therefore asserts **fixture-database state, not the role model**. A production boundary must make its own explicit CONNECT/TEMPORARY/CREATE decision on the database; the fixture silently supplies one, which can mask a missing grant decision in reviewed SQL.

**I-03 (medium; database-global catalog mutation can leak on abort).** `isolation.sql:7` changes default privileges database-wide for the migration role; `cleanup` restores it (`isolation-fixture.mjs:17`) only if cleanup runs. A killed/OOM/cancelled run leaves PUBLIC EXECUTE revoked for migration-created functions — and the `future_helper()` negative test (`isolation.test.mjs:101-102`) then passes for the wrong reason, or a real regression becomes invisible if ambient state already matches. Prefer asserting the DDL itself: read `pg_default_acl`/`pg_proc.proacl` before and after, or create the helper in a fresh schema and inspect its ACL.

**I-04 (low; fixture lifecycle not idempotent/concurrency-safe).** Random `spike_<hex>` schemas/roles leak if a run aborts, and `DROP ROLE` (`isolation-fixture.mjs:18`) fails when a leftover role owns objects (no reassign/CASCADE). Acceptable on a dedicated fixture DB, but the runbook should state that aborted fixtures need manual cleanup, and that two isolation runs share the `pg_default_acl` mutation from I-03.

**I-05 (medium; strong guarantee proven only at `max:1`).** The fixture pins the learner pool to a single connection (`isolation-fixture.mjs:27`), which proves reuse/clearing on one client. The production shape — several pooled clients serving concurrent requests, each transaction setting its own LOCAL context — is not exercised, and the cross-request bleed test cannot exist at `max:1`. Suggest `max:3` with two concurrent two-owner request bursts asserting no cross-owner result.

## Test-coverage gaps (inspected, not executed here)
- **M-01** Credential-table denial is asserted only for `account` and `session.token` (`isolation.test.mjs:50-54`); `"user"`, `verification` (learner/worker) and `attempts` (auth) are not probed, although the doc claims the full separation.
- **M-02** Only `relrowsecurity`/`relforcerowsecurity` are read (`:43-45`); nothing reads `pg_policies`, so a later migration that drops or mis-scopes a policy is not frozen. My offline cross-check shows 15 policies complete today; the suite does not.
- **M-03** The reconciled "no policy under ENABLE RLS denies rows" is shown only for the migration/owner role on `attempts` (`:77`). No test grants a future table to the learner **and** enables RLS without a policy to freeze default-deny (the `future_private` case at `:99-100` fails on the missing grant, not on policy absence).
- **M-04** `store()`'s ownerId guard (`store.mjs:8`) is untested (empty/non-string owner).
- **M-05** Column-grant denial is proven for `entitlements` (`:105-106`) but not for `jobs.tries`/`jobs.owner_id` or `attempts.owner_id` at privilege level.
- **M-06** Tombstone behaviour is asserted through store/API only (`:138-152`); the documented accepted case ("soft-deleted metadata stays visible in direct owner-scoped SQL") is not frozen by a direct-SQL test.

## Reconciliation of the design-review findings (revision 1)
| Prior | Disposition |
|---|---|
| R-01 `WITH CHECK` pins owner | **Implemented** — `isolation.sql:40-67`; verified statically. |
| R-02 missing policy leaks | **Withdrawn.** Under `ENABLE`/`FORCE RLS` a role with no policy gets **default-deny**; the real risk is a runtime 500, not a leak (owner/`attempts` denial at `:77`). |
| R-03 GUC spoofing | **Retained as a boundary statement only**; fixture roles have `NOBYPASSRLS`, no memberships. Arbitrary-SQL/GUC spoofing is explicitly out of the threat model. |
| R-04 membership / `SET ROLE` | **Implemented** — `NOINHERIT`, zero memberships, asserted (`:30-41`). |
| R-05 pooled context | **Implemented** — LOCAL `set_config` in the same tx as all queries (`store.mjs:14-15`); see I-01/I-05. |
| R-06 / R-20 grants & `reserved` | **Withdrawn.** Future grants are intentionally explicit/fail-closed; `UPDATE(reserved)` on `entitlements` (`isolation.sql:15`) is retained because enqueue, retry and delete are trusted learner transactions. No autogrant demanded. |
| R-07 composite owner FKs | **Implemented** (`schema.sql:24,27,35,40,45`); cross-owner parent rejected as `23503` (`isolation.test.mjs:93-94`). |
| R-08 worker lock scope | **Implemented** — explicit worker policies + `SKIP LOCKED`; lease token, not context, is the fence. |
| R-09 deletion/retry | **Implemented** — 404 tombstones, retry/delete/late-completion cases (`:138-152`). |
| R-10 migration ordering | **Implemented** — `isolation.sql` is separate from the `auth-schema.sql` snapshot, which stays byte-checked by the original suite. |
| R-11…R-21 negative tests | **Mapped** to the shipped suite, with two scope exceptions: R-21 production idempotence is intentionally not claimed (one-time fixture SQL), and R-16 (`row_security=off` → error) is tested (`:96-97`). |

## Required boundary and non-claims
Defence in depth, not resistance to a compromised backend: any role that can run SQL can set its own `hatoove.owner_id`, RI checks run outside RLS, and the trusted worker reads across accounts by design. The fixture's trust authentication, administrator bootstrap and one-time SQL are unsuitable for production. No database, role or policy was executed here; the isolation suite's results are the coordinator's, not mine. Nothing here approves content, exam validity, deployment or production security; the human security review of production sessions, recovery and abuse remains a gate.

## Next action
Coordinator: fold I-01…I-05 into `LOCAL-ISOLATION.md` and the fixture (route `reapExpired` through `tx()`; document/restore the database-level revoke; assert default-privilege state; add the `max>1` concurrency case); the boundary itself is sound for this local scope. Reviewer: PR #15 stays a review record — do not merge; no further implementation checkpoint is needed unless the SQL boundary changes.
