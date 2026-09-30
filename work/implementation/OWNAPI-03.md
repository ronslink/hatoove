# OWNAPI-03 — persistent PostgreSQL installation

| | |
|---|---|
| Task / execution | OWNAPI-03, implemented by the coordinator (`COORD-TAKEOVER-20260930`) |
| Base | `origin/main` @ `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e` |
| Branch | `codex/ownapi-03-persistent` |
| Changed paths | `server/owned-postgres/provision.mjs` (new), `tools/postgres-provision-check.mjs` (new), `server/owned-postgres/bootstrap.mjs`, `server/owned-postgres/fixture.mjs`, `server/owned-postgres/sessions.mjs`, `tools/owned-api-check.mjs`, `server/owned-postgres/README.md`, this record |
| Status | Provisioning and persistence proved against a real PostgreSQL 17; the same 24-check owned API suite passes on the persistent installation |

## Why this slice exists

The programme's target changed on 2026-10-01: the app was built **local, single-user** and is moving to a
**server serving multiple users**. Under that target, `server/owned-postgres/bootstrap.mjs` stopped being
sufficient, and not because of a bug:

> it creates a **random `ownapi_<hex>` schema and four random roles** and drops them all in `cleanup()`.

That is exactly right for an isolated checker and fatal for an installation. Every restart would have built a
**new, empty schema** and orphaned the learners' rows in a schema nothing points at any more. Nothing in the
repository could provision a durable schema, so accounts could not be mounted in `server.js` at all — which is
also why the account-scoped progress store (F-4) and the recoverable-draft service (DRAFT-SESSION-01) have had no
production caller.

## What was built

`server/owned-postgres/provision.mjs` is the durable counterpart to the fixture. It is **idempotent**:

- `persistentConfig()` reads `OWNAPI_PG_*` plus `OWNAPI_PG_SCHEMA` (default `hatoove`) and
  `OWNAPI_PG_ROLE_PREFIX` (default `hatoove`), validating every identifier before it is interpolated.
- `ensureRolesAndSchema()` creates the schema only when absent (so its owner is never changed) and each of the
  four roles only when missing — a `DO` block guarded on `pg_roles`, because PostgreSQL has no
  `CREATE ROLE IF NOT EXISTS`. Roles are created `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS`, i.e. row-level security genuinely applies to them.
- `applyMigrations()` applies the tracked SQL in order — `0001-auth-schema`, `0002-owned-schema`,
  `0003-isolation` — **once each**, recorded in `<schema>.hatoove_migrations`, each in one transaction together
  with its ledger row, so a failure leaves neither a half-applied schema nor a recorded-but-unapplied migration.
- `provisionPersistent()` returns pools for the runtime roles; calling it on every server start is safe.

**The tracked SQL is reused verbatim** from `spikes/auth-runtime/`, the same files the isolation spike and the
disposable fixture use. No SQL was forked.

## Evidence — executed against real PostgreSQL 17 (disposable container, synthetic rows)

`node tools/postgres-provision-check.mjs` → **5 passed, 0 failed**:

| Check | What it proves |
|---|---|
| `provision-check-refuses-a-default-database` | it refuses `postgres`/`template0`/`template1` and requires `OWNAPI_PG_ALLOW=1`, because it creates objects it deliberately never drops |
| `fresh-database-is-provisioned-once` | every migration accounted for exactly once; the learner role is `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`; all seven owned tables have RLS **enabled and forced** |
| `second-run-applies-nothing-and-changes-no-role` | a second run applies **no** migration and every role row is **byte-identical before/after** |
| `a-fresh-world-still-sees-the-rows-and-the-policy` | **the durability proof**: a draft written through the restricted learner role is still readable after **every pool is closed and the installation is re-provisioned** (the restart analogue) — and another owner still sees nothing, while a superuser does. Discrimination: the empty read is the policy, not an empty table |
| `a-missing-admin-credential-fails-closed` | bad credentials reject rather than provision partially |

`node tools/owned-api-check.mjs --backend=postgres-persistent` → **24 passed, 0 failed**. That is the **same**
suite, with no check disabled, driving the real `public/js/owned-client.js` through the real `server/owned-api.mjs`
over a **persistent** installation instead of a throwaway one.

Baseline unchanged on this branch: `check.js` 101/0 · `writing-check.js` 9/0 · `feedback-check.js` 14/0 ·
`server-origin` 16 · `reset` 9 · `revision` 8 · `keymask` 12 · `progress-equal` 10 · `owned-client` 31 ·
`owned-api` 24 (memory) · `draft-session` 17 · `mock-outcome` 19 · `progress-scope` 7 · `repository-check` passes.

## Three real defects this work found and fixed

1. **The privileged pool had no `search_path`.** `provisionPersistent()` built the admin pool without one, so
   every unqualified table name in `sessions.mjs` failed with `42P01 relation "session" does not exist` while
   every restricted role pool worked. Found by reproducing a `500 internal_error` from sign-up and reading the
   driver error, not by guessing.
2. **`rolePool()` rejected a legitimate schema name.** Its validators only accepted the fixture's random
   `ownapi_<hex>` shape, so a persistent schema named `hatoove` was refused as "unsafe". They now accept any safe
   identifier — the safety property is the identifier check, not the naming pattern.
3. **The shared suite assumed a throwaway database.** Three checks asserted *absolute* row counts
   (`submissionCount() === 1`, `liveSessions() === 1`, `liveSessions() === 0`), which can only hold in a database
   that starts empty. A durable installation keeps every earlier run's rows. The counts are now scoped to the
   owner under test, and the checker's synthetic addresses carry a per-run id so repeat runs do not collide with
   `user_exists`. **No assertion was weakened:** the checks still prove exactly one submission per
   `(owner, eventId)`, exactly one live session for the account that signed in, and zero sessions for a
   rejected cross-origin sign-up.

## What this does NOT establish

- **No deployment.** It provisions into an existing database the operator supplies; it does not create the
  database, does not manage secrets, and applies no production migration policy beyond "tracked SQL, applied
  once". Whether the app owns its migrations or the operator applies reviewed SQL remains **Ron's decision**.
- **No auth hardening.** The session port in `owned-postgres/sessions.mjs` remains a synthetic, small session
  implementation, **not Better Auth**. Nothing here claims cookie security, expiry, rotation, recovery, email
  verification or abuse controls; those are `A-01`/`A-03` and the human `P-03` gate. A hosted deployment also
  needs `Secure` cookies, which loopback testing cannot exercise.
- **`server.js` still does not mount the owned API.** This slice makes the durable installation possible; wiring
  it into the running server, with the account surface that reaches it, is the next slice.
- **Not independently reviewed yet.** It was implemented by the coordinator, so per the programme's own rule it
  needs a reviewer who is not its author before it can be treated as accepted.
- It closes no security, privacy or educational gate.

## The Redis question, recorded

Ron asked whether Redis should be used instead. **PostgreSQL remains the owned-state store, and the reasoning is
in `MULTI-USER-TRANSITION.md` §5**: the isolation guarantee is database-enforced (`FORCE ROW LEVEL SECURITY` plus
restricted login roles) and is already proven, whereas Redis isolation would live in application code. Redis is a
good candidate for the assessment **job queue** and for rate-limit counters — ephemeral, high-churn data — and
that is the only place it should appear.
