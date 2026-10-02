# HARD-DELETE-01 — D3: what a learner deletion must actually remove, in what order

| | |
|---|---|
| Authority | **Ron, 2026-10-01: "delete is a hard delete."** Recorded in `RON-DECISIONS-20261001.md` §3 |
| Why it is not a one-liner | the owned schema has **no `ON DELETE CASCADE` on the ownership keys** and contains a **foreign-key cycle**. `DELETE FROM "user"` fails today |
| Read from | `spikes/auth-runtime/schema.sql` and `server/owned-postgres/provision.mjs` at `31f85f3` |
| Status | **specification complete; implemented** — the deletion port, its role/migration and its wiring are in `server/owned-postgres/`, `server/accounts.mjs` and `server/owned-api.mjs`. See §6 |

## 1. The deletion graph, as the schema actually declares it

From `schema.sql`, every table that belongs to an account and how it points at its parent:

| Table | Ownership column | Points at | `ON DELETE` |
|---|---|---|---|
| `learner_settings` | `user_id` (PK) | `"user"(id)` | **`CASCADE`** — the only cascading key in the schema |
| `attempts` | `owner_id` NOT NULL | `"user"(id)` | none — **defaults to `NO ACTION`** |
| `drafts` | via `attempt_id` (PK) | `attempts(id)` | none |
| `entitlements` | `owner_id` (PK) | `"user"(id)` | none |
| `submissions` | `owner_id` NOT NULL | `(attempt_id, owner_id)` → `attempts` | none |
| `jobs` | `owner_id` NOT NULL | `(submission_id, owner_id)` → `submissions` | none |
| `assessments` | `owner_id` NOT NULL | `(submission_id, owner_id)` → `submissions` | none |
| `usage_ledger` | `owner_id` NOT NULL | `submission_id` → `assessments(submission_id)` **and** `(submission_id, owner_id)` → `submissions` | none |
| `session` | auth `user_id` | `"user"(id)` | none |

**The cycle, and it is the whole difficulty:** `submissions` references `attempts`, and then
`schema.sql:27` adds `attempts.parent_submission_id → submissions(id, owner_id)`. **`attempts` and `submissions`
reference each other.** A naive ordered delete deadlocks against itself; a `DELETE FROM "user"` fails outright
because of the `NO ACTION` keys.

## 2. The order that actually works

Written as the sequence an implementation must perform **inside one transaction**, so a partial deletion cannot
leave an account half-removed:

1. **`UPDATE attempts SET parent_submission_id = NULL WHERE owner_id = $1`** — break the cycle *first*. This is the
   step that is not obvious and the one an implementation is most likely to miss.
2. `DELETE FROM usage_ledger WHERE owner_id = $1` — it depends on both `assessments` and `submissions`.
3. `DELETE FROM assessments WHERE owner_id = $1`
4. `DELETE FROM jobs WHERE owner_id = $1`
5. `DELETE FROM drafts WHERE attempt_id IN (SELECT id FROM attempts WHERE owner_id = $1)`
6. `DELETE FROM submissions WHERE owner_id = $1`
7. `DELETE FROM attempts WHERE owner_id = $1`
8. `DELETE FROM entitlements WHERE owner_id = $1`
9. `DELETE FROM learner_settings WHERE user_id = $1` (would cascade, but doing it explicitly keeps the order
   readable and the row count assertable)
10. `DELETE FROM session WHERE "userId" = $1` — **and this must be part of the same transaction**, not a sign-out
    afterwards, or a deletion can leave a live session behind.
11. `DELETE FROM "user" WHERE id = $1` — **last**, because everything above points at it.

**A safer formulation, for whoever implements it:** rather than trusting this list, add `ON DELETE CASCADE` to the
ownership keys in a migration and let the database do the ordering. That is a schema change with its own risk
(it weakens the guarantee that a mistaken `DELETE` is caught), so **the explicit ordered transaction is the
recommended implementation** and the cascade should be considered only if the list proves unmaintainable.

## 3. What deletion CANNOT reach, and why the app must say so

This is the SEC-02 property the programme already committed to: **"deletion is not total, and saying so is part of
the fix."** Stated here so an implementation cannot quietly claim completeness:

| Outside the application's reach | Why | What to do |
|---|---|---|
| **The operator's PostgreSQL backups** | a restore reinstates deleted rows until the backup ages out | **a retention window is a product decision Ron has not given.** Until he does, the deletion response must not claim total erasure |
| **A write-ahead log / replica** | same class of problem | state it; do not imply otherwise |
| **The legacy `progress.json`** | the file-based record still exists for local installs | on a hosted deployment it is not used at all — verify that, do not assume it |
| **Any copy the app did not create** — a learner's export, a browser download | physically unreachable | already documented as out of scope by the F-5 re-scope |
| **The model provider that processed the account's text** | submitted text is sent to the configured provider for assessment; what that provider retains, and for how long, is outside the application's reach — exactly like a backup | state it; **no retention period is known or stated.** Until Ron gives one, the deletion response may not imply the provider's copies are gone |

## 4. Acceptance criteria

1. `DELETE /api/v1/account` (or the equivalent route) removes **every** row in §1 for **that account only**.
2. **Another account's rows are provably untouched** — counted before and after, not asserted by inspection.
3. **No live session survives** the deletion: the same cookie is refused immediately afterwards.
4. **Read-back proves absence**, per table, rather than trusting the delete's row counts.
5. **Deleting a non-existent or already-deleted account is not an error** — it is idempotent and reports honestly.
6. The response **states what was not removed** (backups, if the retention policy is still undefined) rather than
   implying total erasure.
7. A checker with **discrimination**: against the pre-fix tree, the read-back must find rows and the check must fail.
8. The deletion runs **in one transaction**: a forced error part-way leaves the account **intact**, not half-deleted.
   This is testable by injecting a failure after step 5 and asserting the rows are all still there.

## 5. What is explicitly NOT decided here

**The operator-backup retention window.** An application cannot delete from a backup that has already been taken;
only a retention policy can bound that, and it is a product and possibly legal decision rather than an engineering
one. This record therefore does not invent one, and criterion 6 exists so the application tells the truth until Ron
gives it.

## 6. The deletion role, and how the port reaches a running server (HARD-DELETE-02)

§2's transaction needs DELETE rights the restricted learner role does not have. Two things were missing, and both
are recorded here because for a while the only two places that admitted "this cannot run in an installation" pointed
at this section, which did not exist.

**The role.** A provisioned installation now creates a fifth least-privilege role, `<prefix>_deletion`
(`provision.mjs`, `ROLES`), `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
`CONNECTION LIMIT 10` — the same shape as the other four. **Migration `0005-account-deletion`** grants it:

- `USAGE` on the schema;
- `SELECT, DELETE` on `"user"`, `session`, `account`, `attempts`, `drafts`, `submissions`, `jobs`, `assessments`,
  `usage_ledger`, `entitlements`, `learner_settings`;
- `UPDATE(parent_submission_id)` on `attempts` (step 1 of §2 decides the cycle);
- `UPDATE(reserved)` on `entitlements` and `UPDATE("updatedAt")` on `"user"` — not to change a value, but because
  PostgreSQL requires UPDATE on at least one column for the `FOR UPDATE` row locks the port takes (`SELECT 1 FROM
  entitlements … FOR UPDATE`, and the `"user"` lock). The writer paths (`submit`, `retry`) take the entitlements
  lock first, so the deletion takes it first too and the order is entitlements → attempts on both sides;
- an owner-scoped policy (`USING (owner_id = nullif(current_setting('hatoove.owner_id', true), ''))`) for each of the
  seven FORCE-RLS tables, a `user_id` policy for `learner_settings`, and a `drafts` policy that admits a row when its
  attempt is the owner's **or** the attempt id was pinned transaction-locally for this deletion (drafts has no owner
  column, so the port captures the account's attempt ids before deleting them). `"user"`, `session` and `account`
  carry no RLS, so the grants above are the whole boundary there.

The SQL lives in `server/owned-postgres/provisioning-sql.mjs` (`deletionRoleSql`), and the **same builder** is used by
`bootstrap.mjs`: the disposable fixture a checker builds is therefore an installation's schema and grants, not an
approximation. Before this, the only role with those rights was one `tools/deletion-check.mjs` invented for itself,
so acceptance criterion 1 of §4 was not demonstrated for any installation that existed.

**The wiring.** `createPostgresWorld()` — the function `server/accounts.mjs` calls to obtain the api `server.js`
mounts — accepted `{ allowance, fixture }` and had no seam for a deletion port, so every `DELETE /api/v1/account` a
provisioned server could serve answered `503 deletion_unavailable` (`owned-api.mjs`, `deletionWired === false`), in
every configuration this repository can ship. It now takes a `deletion` pool (or a fixture that carries one) and
builds the port with `createPostgresAccountDeletion`; `accounts.mjs` passes the pool `provisionPersistent()` built for
`<prefix>_deletion`. `tools/coord-deletion-mount-probe.mjs` is the acceptance check: a real server process over real
HTTP, which returned `503` before the fix and `200 {"deleted":true,…}` after.

**What the read-back is, and is not.** The port reads `ACCOUNT_TABLES` back before COMMIT and refuses a deletion that
left a row. In the current schema this is defensive and cannot trigger: every owned table either cascades from
`"user"` (so the row is gone) or has a `NO ACTION` key that makes a later step fail with `23503` first (so the
transaction throws before the read-back). The guarantee against a silent partial delete is the step order plus those
foreign keys; the read-back is there for a future table that has neither. `drafts` was added to the list so the
account's own drafts are counted too.
