# OWNAPI-02 — PostgreSQL datastore adapter, so the owned API carries real RLS evidence

Execution `ownapi-02-openclaw-20260930-a`, worker OpenClaw on Hetzner, slot 3, coordinator `COORD-TAKEOVER-20260930`.
Branch `codex/ownapi-02-postgres`. Base used: `origin/main` **258f2000b8fed1a30677937ad5464c3d0599b43a**
(re-checked with `git rev-parse HEAD` / `git rev-parse origin/main`; both matched the assignment).

## What was built

`server/owned-api.mjs` was merged with an **in-memory, test-only** datastore, so the shipped API carried none of
the ownership evidence the programme relies on. This task adds the PostgreSQL adapter for the same port and makes
the shipped API carry that evidence.

| Path | Content |
|---|---|
| `server/owned-postgres/package.json` | Own package scope; `dependencies: { "pg": "8.23.1" }`. Root `package.json` untouched. |
| `server/owned-postgres/package-lock.json` | Tracked lock, as `spikes/auth-runtime/` does. |
| `server/owned-postgres/adapter.mjs` | `createPostgresDatastore({pool, onCall})` → the seven-method datastore port. |
| `server/owned-postgres/sessions.mjs` | pg-backed session port for the fixture (synthetic accounts; **not** Better Auth). |
| `server/owned-postgres/bootstrap.mjs` | Disposable random schema + four LOGIN roles + the tracked spike SQL. |
| `server/owned-postgres/fixture.mjs` | `createPostgresWorld()` producing the `{store, sessions, api}` shape the shared suite builds. |
| `server/owned-postgres/README.md` | Install, `OWNAPI_PG_*`, disposable container, limits. |
| `tools/owned-api-check.mjs` | **Backend switch only**: `--backend=postgres`, `await world(...)`, awaited inspect/worker hooks, per-check teardown. |
| `tools/owned-api-pg-check.mjs` + `.test.mjs` | New API-layer isolation + RLS-discrimination proof. |
| `.github/workflows/pilot-contracts.yml` | **Touched** to install the package and run both PostgreSQL proofs (see below). |

The adapter reuses `spikes/auth-runtime/{auth-schema,schema,isolation}.sql` verbatim; the SQL is not re-derived.
`server/owned-api.mjs`, `public/js/owned-client.js`, `public/js/exam.js`, the root `package.json`,
`IMPLEMENTATION_PLAN.md` and `work/BOARD.md` are unchanged.

### Why the backend switch also touched the check call sites

The shared suite reads test hooks synchronously (`inspect.fingerprint()`, `worker.claim()`, `liveSessions()`).
A real database cannot answer those synchronously, so those calls are now `await`ed. `await` on a plain value is
a no-op, so the memory backend is behaviourally unchanged (still 24/24). This is the minimum change that lets the
**same** suite run on both backends rather than a duplicated one.

## Requirements → evidence

1. **Least privilege.** Learner paths use `ownapi_<hex>_learner`, created `LOGIN NOINHERIT NOSUPERUSER
   NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. No superuser/BYPASSRLS connection is used for a learner
   path. Verified by direct SQL assertions, not by the HTTP tests alone.
2. **Ownership by the database.** Two layers: the transaction binds the verified owner to the transaction-local
   `hatoove.owner_id` (FORCE RLS policies), and each statement also carries `owner_id = $2`. Another owner's
   record is the same `404 not_found` as an absent one (`e1.detail === e2.detail`).
3. **Revisions + idempotency on real storage.** `draft-revision-checked-and-increments-once` (stale save writes
   nothing, checked by a full-table fingerprint) and `submission-idempotent-on-owner-and-event` (same `(owner,
   eventId)` returns the original id; the `UNIQUE(owner_id, event_id)` constraint is real).
4. **Deletion.** `delete-is-a-tombstone`: `deleted_at` set, draft deleted, job cancelled, reservation released,
   every owned route then 404, and a late completion cannot recreate it.
5. **Fail closed.** Unwired ports still answer `503` (`fail-closed-without-ports`); a database failure answers
   `500 {"error":"internal_error"}`, never a 2xx (`pg-datastore-failure-is-500-never-success` closes the learner
   pool mid-run).

## Results (real counts, both backends)

| Suite | Result |
|---|---|
| `node tools/owned-api-check.mjs` (memory) | **24 passed, 0 failed** |
| `node tools/owned-api-check.mjs --backend=postgres` | **24 passed, 0 failed** |
| `node --test tools/owned-api-check.test.mjs` | **25/25** |
| `node tools/owned-api-pg-check.mjs` | **5 passed, 0 failed** |
| `node --test tools/owned-api-pg-check.test.mjs` | **6/6** |
| `node tools/check.js` | 101 passed, 0 failed |
| `node tools/writing-check.js` | 9 passed, 0 failed |
| `node tools/feedback-check.js` | 14 passed, 0 failed |
| `node tools/server-origin-check.mjs` | 16/16 |
| `node tools/reset-check.mjs` | 9/9 |
| `node tools/revision-check.mjs` | 8/8, incl. discrimination |
| `node tools/owned-client-check.mjs` | 31 passed, 0 failed |
| `node tools/keymask-check.mjs` | 12/12 |
| `node tools/repository-check.mjs` | passes |

Database: disposable `postgres:17-alpine` container `hatoove-ownapi02-db` on `127.0.0.1:55436`, database
`hatoove_ownapi02`, trust auth, synthetic records only. After every run the fixture leaves **0** `ownapi_%`
schemas and **0** `ownapi_%` roles behind. In CI the same checks target the workflow's existing 55435
`hatoove_spike` service (the default `OWNAPI_PG_*`), so no CI env change is needed.

## RLS discrimination (acceptance 3)

`pg-rls-discrimination-superuser-and-disabled-policy` builds a scratch fixture and runs the *same* cross-owner
query four ways:

| Configuration | Cross-owner `SELECT` of A's attempt, as B | Meaning |
|---|---|---|
| learner role, FORCE RLS on | **0 rows** | the policy hides it |
| superuser (admin pool) | **1 row** | the row exists; the empty read is the policy, not an empty table |
| learner role, `ALTER TABLE attempts DISABLE ROW LEVEL SECURITY` | **1 row** | a test that passed here too would prove nothing |
| learner role, policy restored (`ENABLE` + `FORCE`) | **0 rows** | the restore is proven, and A's own row is intact |

`pg-learner-runs-as-a-restricted-role-with-forced-rls` asserts the learner connection's `current_user`, that
`rolsuper`/`rolbypassrls`/`rolcreatedb`/`rolcreaterole` are false, that DDL, `ALTER TABLE … DISABLE ROW LEVEL
SECURITY` and `SET ROLE` are denied (`42501`), that all seven owned tables have `relrowsecurity` **and**
`relforcerowsecurity` true, and that a direct cross-owner `SELECT` under the learner role returns no rows.

### Falsification note (why requirement 1 matters, and why it is not enough)

A scratch experiment ran the learner port on the **superuser** pool. The HTTP cross-owner check still returned
`404` (the JS `owner_id = $2` predicate held) — *so an API-only test cannot detect the voided guarantee* — while
a direct cross-owner `SELECT` under that connection returned A's row (`current_user = postgres`,
`rolsuper = true`, `rolbypassrls = true`). That is exactly why the RLS proof uses direct SQL and why learner
paths must not use a privileged connection. The experiment was run in a scratch fixture and discarded.

## Changed paths

New: `server/owned-postgres/{package.json,package-lock.json,adapter.mjs,sessions.mjs,bootstrap.mjs,fixture.mjs,README.md}`,
`tools/owned-api-pg-check.mjs`, `tools/owned-api-pg-check.test.mjs`, this record.
Modified: `tools/owned-api-check.mjs` (backend switch), `.github/workflows/pilot-contracts.yml`.

## CI workflow change (explicit)

`.github/workflows/pilot-contracts.yml` **was touched**, only because the PostgreSQL job genuinely needs the new
package installed to run the proofs. Added steps after the existing spike tests:
`npm ci --prefix server/owned-postgres`, `node tools/owned-api-check.mjs --backend=postgres`,
`node --test tools/owned-api-pg-check.test.mjs`. No other step changed; the root package stays dependency-free.

## Not verified / limits

- **No production auth.** The session port is a synthetic pg-backed fixture, not Better Auth, so nothing here
  speaks to cookie security, expiry, abuse controls or recovery. Real auth remains A-01/F-02 work.
- **No migration history, credentials or deployment.** Roles/schemas are created ad hoc by the fixture. A
  production adapter needs reviewed SQL migration history, least-privilege credentials and a deployment path
  (this repository has none).
- **No independent review yet** (batched at the end per Ron's instruction), and no browser/device evidence.
- The `--backend=postgres` mode requires the package installed and a disposable database; without them the
  memory default still runs offline. If a check could not run against PostgreSQL it is recorded as such rather
  than claimed: all listed PostgreSQL checks were executed.
- The legacy `server.js` mount is still programmatic only; `node server.js` does not wire an owned API.
- This closes no security, privacy or educational gate. Human `P-03` review remains required.

## Independent re-verification (same execution id, this session)

The prior run's disposable container was gone when re-checked, so a fresh one was created
(`docker run … postgres:17-alpine`, `127.0.0.1:55436` → database `hatoove_ownapi02`, trust
auth, synthetic records only) and **every** check was re-executed against it, not taken on
trust from the record:

| Suite | Re-run result |
|---|---|
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |
| `node tools/server-origin-check.mjs` | **16/16** |
| `node tools/reset-check.mjs` | **9/9** |
| `node tools/revision-check.mjs` | **8/8** |
| `node tools/owned-client-check.mjs` | **31 passed, 0 failed** |
| `node tools/keymask-check.mjs` | **12/12** |
| `node tools/owned-api-check.mjs` (memory) | **24 passed, 0 failed** |
| `node tools/owned-api-check.mjs --backend=postgres` | **24 passed, 0 failed** |
| `node --test tools/owned-api-check.test.mjs` | **25/25** |
| `node tools/owned-api-pg-check.mjs` | **5 passed, 0 failed** |
| `node --test tools/owned-api-pg-check.test.mjs` | **6/6** |

After the runs the disposable database held **0** `ownapi_%` schemas and **0** `ownapi_%`
roles (checked directly). `node tools/repository-check.mjs` passed and
`git diff --cached --check` was clean. The lockfile is consistent
(`npm ci --dry-run` → up to date; resolved `pg` **8.23.1**); the root `package.json` still
has `"dependencies": {}`. Changed paths re-checked: `public/js/exam.js`,
`public/js/owned-client.js`, `server/owned-api.mjs`, the root `package.json`,
`IMPLEMENTATION_PLAN.md` and `work/BOARD.md` are untouched.
