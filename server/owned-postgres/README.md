# Owned-attempts PostgreSQL adapter (OWNAPI-02)

The datastore port `server/owned-api.mjs` injects, implemented over PostgreSQL.
Its SQL is the same proven SQL as `spikes/auth-runtime/store.mjs`; this package
implements exactly the seven methods the shipped module calls and is designed to
run **as the restricted learner role** so FORCE ROW LEVEL SECURITY is genuinely
in force.

It lives in its own package scope with its own `package.json`/`package-lock.json`
(pinning `pg` to the same **8.23.1** as the spike) because the root app is
**dependency-free**: `"dependencies": {}` and no lockfile. Nothing here may be
added to the root `package.json`.

## Files

| File | Role |
|---|---|
| `adapter.mjs` | `createPostgresDatastore({pool, onCall})` → the owned-attempts port. |
| `sessions.mjs` | pg-backed session port **for the fixture** (synthetic accounts; not Better Auth). |
| `bootstrap.mjs` | Disposable schema + four LOGIN roles + the tracked spike SQL. |
| `fixture.mjs` | `createPostgresWorld()` — the `{store, sessions, api}` shape the shared suite builds. |

It reuses, verbatim, these tracked files:

- `spikes/auth-runtime/auth-schema.sql` (pinned-library auth schema),
- `spikes/auth-runtime/schema.sql` (attempts/drafts/submissions/jobs/…),
- `spikes/auth-runtime/isolation.sql` (grants, ENABLE + FORCE RLS, owner policies).

## Security model (the point of this package)

- **Least privilege.** Learner paths connect as `ownapi_<hex>_learner`, created
  `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
  A superuser or BYPASSRLS connection would void the guarantee while every check
  still passed, so it is never used for learner paths.
- **Two-layer ownership.** Each transaction binds the verified owner to the
  transaction-local `hatoove.owner_id`, and every statement also carries
  `owner_id = $2`. Another owner's record is therefore the same `404 not_found`
  as a record that does not exist — never `403`.
- **Fail closed.** A database error surfaces as `500 {"error":"internal_error"}`;
  a missing port still answers `503`. Never a success.

## Running the checks

Configuration (optional; defaults are the documented disposable fixture):

```text
OWNAPI_PG_HOST=127.0.0.1  OWNAPI_PG_PORT=55435  OWNAPI_PG_DATABASE=hatoove_spike  OWNAPI_PG_USER=postgres
# OWNAPI_PG_PASSWORD only if the fixture needs one; the loopback test fixture uses trust.
```

Install once (its own scope), then run either proof. Synthetic records only.

```text
npm ci --prefix server/owned-postgres --ignore-scripts --no-audit --no-fund
node tools/owned-api-check.mjs --backend=postgres   # the SAME 24-check suite on PostgreSQL
node --test tools/owned-api-pg-check.test.mjs       # isolation + RLS discrimination proof
```

Local disposable database (never point these at anything you may not destroy):

```text
docker run --name hatoove-ownapi02-db --label hatoove.execution=ownapi02-local \
  -e POSTGRES_DB=hatoove_ownapi02 -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55436:5432 -d postgres:17-alpine
OWNAPI_PG_PORT=55436 OWNAPI_PG_DATABASE=hatoove_ownapi02 \
  node --test tools/owned-api-pg-check.test.mjs
```

Every run creates a random `ownapi_<hex>` schema and four random roles, and drops
them again. The fixture never touches another project's database.

## What this does NOT establish

- **No production auth.** `sessions.mjs` is a synthetic pg-backed port for the
  checks; it is not Better Auth, and it proves nothing about cookie security,
  expiry, abuse controls or recovery.
- **No deployment, migration history or credentials.** Roles are created ad hoc
  by the fixture. Production needs reviewed SQL migration history and secrets.
- It closes no security, privacy or educational gate; human review remains required.
