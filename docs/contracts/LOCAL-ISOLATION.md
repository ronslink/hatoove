# Local SQL isolation experiment

F-02/A-01, execution `f02-20260930-a`, layered on contract 0.1.0. This experiment exercises actual PostgreSQL 17 login roles and the local HTTP journey with synthetic accounts. It is not a production migration or a completed authentication rollout. The learner app in `public/` is unchanged.

## Trust boundary

The server verifies the Better Auth session before constructing a learner store. Each store transaction obtains one pool client, begins a transaction and sets `hatoove.owner_id` with `set_config(..., true)` on that client. All learner queries use that transaction. COMMIT/ROLLBACK removes the transaction-local value; an unscoped call explicitly sets an empty value and fails closed. The owner never comes from a request body.

This protects against missing ownership predicates and some accidental joins. It does **not** protect against a compromised backend or a person with database credentials who can choose another owner's custom setting. The trusted worker can read submitted work across accounts. This fixture's loopback trust authentication and administrator bootstrap are unsuitable for production. Runtime pools use separate real logins; the administrator only creates fixtures, seeds synthetic allowances, inspects assertions and cleans up.

PostgreSQL table owners normally bypass row security, so every application table uses both ENABLE and FORCE ROW LEVEL SECURITY. All four fixture roles lack superuser/BYPASSRLS and role memberships. FORCE still does not constrain an administrator. Referential-integrity checks bypass RLS; composite foreign keys carry the owner and reject a cross-owner parent. TRUNCATE is not governed by RLS and is not granted. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) and [transaction-local settings](https://www.postgresql.org/docs/current/sql-set.html).

## Explicit role grants

| Login | Scope |
|---|---|
| migration | Owns its random fixture schema, creates auth/application tables and policies; no row policy, so FORCE denies application rows; never used by HTTP or jobs |
| auth | CRUD on the four generated Better Auth tables only; credentials and sessions remain confined to this trusted component |
| learner | Owned attempts, drafts, submissions and jobs; reads own entitlements/results/usage; updates only entitlement `reserved`, attempt `deleted_at`, and specified job columns |
| worker | Cross-owner submitted work, jobs, attempts, entitlements, assessments and usage; selected column updates plus assessment/usage inserts; cannot read drafts or auth tables |

`FOR UPDATE` requires an UPDATE privilege even for a read that locks a row. The learner/worker therefore receive `UPDATE(deleted_at)` on attempts; the worker is trusted not to delete an attempt independently. Learner reservation updates are needed for atomic enqueue, explicit retry and cancellation. Learners cannot update allowance/used, insert results/debits, manufacture a successful job or edit immutable submissions. Reservation arithmetic and job transitions still depend on trusted store code and database constraints, not solely on RLS. This is a deliberate boundary, not protection from arbitrary SQL issued with the runtime credential.

All seven application tables have explicit policies: attempts, drafts, entitlements, submissions, jobs, assessments and usage_ledger. Draft policy looks up an owned attempt without recursion. Missing policies deny access. Worker policies explicitly allow the processing role across owners; they do not use BYPASSRLS. Soft-deleted metadata can remain visible in direct owner-scoped SQL; API/store operations enforce the tombstone, remove draft text, reject saves/retries/replays and fence late completion. This is not erasure or retention compliance.

PUBLIC schema/table/function rights are revoked. Future tables deliberately receive **no automatic runtime grant**: each migration must review grants and policies. Future functions revoke global default PUBLIC EXECUTE for the fixture migration role. A per-schema REVOKE cannot subtract that global default; a negative test exposed and corrected this during implementation. No SECURITY DEFINER helper or automatic privilege expansion is introduced.

## Fixture and migration limits

`isolation-fixture.mjs` only connects to `127.0.0.1:55435/hatoove_spike`. It creates random schema/role identifiers, four non-admin login roles, the pinned library schema, app schema, then isolation SQL. It also revokes PUBLIC CREATE/TEMPORARY on this dedicated fixture database. Finally it closes pools and removes only the generated schema/roles and their function defaults. Do not run it on a shared database.

`isolation.sql` is a one-time fixture layer, not an idempotent production migration. A second application is intentionally not claimed. The generated auth-schema snapshot remains unchanged; the existing suite verifies library snapshot equality and an empty second auth migration. Production needs versioned migration history, authenticated credentials, deployment separation, review of all default privileges and human security review.

The local server helper preserves its one-pool defaults for the original contract test only. The isolation suite explicitly supplies separate auth/learner/worker pools and verifies their actual `session_user`/`current_user`; there is no production entrypoint relying on defaults.

## Evidence and review disposition

Locally: 9 isolation scenarios (10 Node runner checks), 12 original contract scenarios (13 runner checks), and legacy 101 + 9 + 14 checks pass. The isolation suite checks actual login attributes, denied DDL/SET ROLE/RLS disabling, no-context reads/writes, cross-owner HTTP/SQL and joins, owner-carrying FKs, commit/rollback reuse of a one-connection pool, default grants, credential isolation, restricted completion/exactly-one debit, retry and deletion. CI runs both PostgreSQL suites against a disposable service.

OpenClaw design review PR #15 informed these checks. Several recommendations are scoped differently here: R-02's missing-policy risk fails closed with ENABLE RLS; R-06/R-20 use explicit future grants rather than automatic privileges; `reserved` remains a trusted learner-transaction column; R-19 returns 404 after a tombstone; R-21 production migration idempotence is outside this fixture. No untested expectation from that report is presented as evidence. Final implementation review is recorded on the implementation PR before integration.

No live provider calls, production credentials, browser/device acceptance, content approval, production security signoff or complete learner journey are established by these tests.
