# HARD-DELETE-01 — D3: what a learner deletion must actually remove, in what order

| | |
|---|---|
| Authority | **Ron, 2026-10-01: "delete is a hard delete."** Recorded in `RON-DECISIONS-20261001.md` §3 |
| Why it is not a one-liner | the owned schema has **no `ON DELETE CASCADE` on the ownership keys** and contains a **foreign-key cycle**. `DELETE FROM "user"` fails today |
| Read from | `spikes/auth-runtime/schema.sql` and `server/owned-postgres/provision.mjs` at `31f85f3` |
| Status | **specification complete, implementation NOT started** — no code has been changed for D3 |

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
