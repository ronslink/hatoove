# PILOT-01 — the local bring-up: one command, one working installation

| | |
|---|---|
| Slice | PILOT-01 (MASTER-PLAN §7, first dispatch) |
| Base | `6aebeb4` (the plan commits), first implementation commit `a6203d5`, final `860341a` |
| Branch | `codex/pilot-01-local-bringup` |
| Governing plan | [PILOT_BUILD_PLAN.md](../../PILOT_BUILD_PLAN.md); delivery order in [MASTER-PLAN.md](../../MASTER-PLAN.md) |
| Milestone | LM-1 — "the product works locally" |
| Status | **Delivered, check green (10/10). Not independently reviewed, and not merged.** |

---

## 1. Purpose

LM-1 says a working local installation is produced by **one documented sequence**, not by a list a
human retypes from a README. Before this slice the sequence existed only as folklore: start a
container by hand, export six `OWNAPI_PG_*` variables, run provisioning, then start the server and
the worker separately. Nothing measured whether that was true or complete.

This slice makes the sequence a tool and gives it a check.

---

## 2. What was built

**`tools/local-bringup.mjs`** — the whole sequence, as callable exports and as a CLI:

| Step | Export | What it does |
|---|---|---|
| 1 | `ensureDatabase(cfg)` | creates, starts or reuses a local PostgreSQL container and waits until it **answers a query** (not merely "docker says running") |
| 2 | `provisionLocal(cfg)` | applies the tracked migrations through the single provisioning path, then closes every pool it opened |
| 3 | `catalogueCounts(cfg)` | reports the catalogue the runtime will serve |
| 4 | `startRuntime(cfg)` | starts the API **and** the worker as real child processes, restricted roles, stub grader |
| 5 | `stopDatabase(cfg, {wipe})` | stops the container, optionally removing its volume |

CLI: no flag serves; `--no-serve` provisions and reports; `--status` changes nothing; `--down`
stops; `--wipe` also removes the data volume.

**Two deliberate choices.**

- **The local database is persistent, not disposable.** It has its own named volume, so an account
  created locally survives a restart. That is what makes this a local *product* rather than a
  fixture. The check uses its **own** disposable container on its own port and never touches it.
- **The worker is a separate process.** The runtime must not carry the worker's privileges; the
  worker connects as `<prefix>_worker`, which the activity query below confirms.

**`tools/local-bringup-check.mjs`** — ten legs plus one discrimination leg. It asserts against the
**database and over HTTP**, never from stdout: `server/worker.mjs:100` prints nothing when there is
nothing to claim, so silence must never be read as success.

---

## 3. Verbatim check output — final

```
=== PILOT-01 local bring-up check ===

PASS L1-sequence-exists             tools/local-bringup.mjs exports the documented sequence
     5 documented step(s); 7 exports
PASS L2-database-comes-up           the local PostgreSQL comes up and answers
     hatoove-pilot01-check-db on 127.0.0.1:55441; PostgreSQL 17.7
PASS L3-migrations-recorded         every tracked migration is applied and recorded
     6 applied, 0 skipped; every checksum matches the file on disk
PASS L4-roles-least-privilege       the six roles exist and none is superuser or BYPASSRLS
     hatoove_auth, hatoove_deletion, hatoove_learner, hatoove_migration, hatoove_provisioner, hatoove_worker
PASS L5-content-seeded              the writing catalogue is seeded
     content_version=7 rubric_version=1 task_version=6
PASS L6-provision-idempotent        a second provision applies nothing
     applied=0, skipped=6
PASS L7-runtime-answers-ready       the runtime answers ready in SaaS mode
     http://127.0.0.1:4398 health 200; ready 200 mode=saas reason=ready
PASS L8-counter-runs                the product journey counter runs at zero failures
     5 passed, 6 pending, 0 failed
PASS D1-fails-loudly                a stopped database makes bring-up fail rather than report success
     provisioning against the removed database threw: connect ECONNREFUSED 127.0.0.1:55441
PASS L9-teardown                    teardown removes the disposable container
     container hatoove-pilot01-check-db removed; port 55441 closed

10 passed, 0 skipped, 0 failed
```

Exit code 0.

### Discrimination legs

- **D1** removes the container and then points the **same** provisioning path at it. It threw
  `connect ECONNREFUSED 127.0.0.1:55441`. Without this leg, L2–L7 could pass against a runtime that
  was never really there.
- **L1 on the base** (`a6203d5`, the checker-first commit) produced the expected red:

```
FAIL L1-sequence-exists             tools/local-bringup.mjs exists and exports the documented sequence
     NOT IMPLEMENTED: tools/local-bringup.mjs is missing. PILOT-01 is the slice that creates it.
SKIP L2-database-comes-up           the local PostgreSQL comes up and answers
     depends on L1
...
0 passed, 9 skipped, 1 failed
```

Nine legs were **skipped, not passed**. That is the property that makes this check worth having: a
missing implementation cannot read as progress.

---

## 4. The CLI, executed

```
$ node tools/local-bringup.mjs --no-serve
local bring-up: container=hatoove-local-db port=55440 database=hatoove schema=hatoove volume=hatoove-local-db-data
step 1/4 database: created; PostgreSQL 17.7
step 2/4 provision: applied=6 skipped=0 schema=hatoove
step 3/4 catalogue: content_version=7 rubric_version=1 task_version=6
step 4/4 runtime: not started (--no-serve)

$ node tools/local-bringup.mjs --status
container: running
catalogue: content_version=7 rubric_version=1 task_version=6
```

Serving mode, probed while running:

| Request | Result |
|---|---|
| `GET /` | **200** — the application |
| `GET /api/health` | 200 `{"ok":true,"node":"v24.4.1"}` |
| `GET /api/ready` | 200 `{"ok":true,"ready":true,"mode":"saas","reason":"ready"}` |
| `GET /api/v1/account` | 401 `{"error":"unauthenticated"}` — correct |
| `GET /api/config` | **404** — retired route |

Connections held, from `pg_stat_activity` inside the container:

```
hatoove:learner|hatoove_learner|1
hatoove:worker |hatoove_worker |1
```

**No superuser or migration pool is held at runtime**, which is the property the whole role model
exists to protect.

---

## 5. A defect found in the check, and fixed there

The first green attempt was **not** green. L8 reported `4 passed, 6 pending, 1 failed` — while the
same harness, run alone against a fresh database, reported `5 passed, 6 pending, 0 failed`.

The cause was the check itself: it left its own runtime running (API **and worker**) against the
same database while `journey-api-check` started a second worker. Two workers raced for one job, so
the harness's `submit must reserve exactly one` assertion — which reads the entitlement immediately
after submit — observed the other worker's completion instead of its own reservation.

The fix is to stop the runtime before L8, and the reason is recorded in the check's source rather
than in this document alone. **The product was never at fault.** This is the programme's rule
applied literally: *when a check fails, suspect the check first.*

It is written down here because a check that was almost weakened to make a race disappear is exactly
the kind of change that should be visible.

---

## 6. LIMITS — what this does not establish

- **Not independently reviewed, and not merged.** `delivered ≠ reviewed ≠ merged`.
- **Nothing about production.** The container uses `POSTGRES_HOST_AUTH_METHOD=trust` on loopback and
  hosts no password. This is a local development installation and must never be pointed anywhere real.
- **The grader is the deterministic stub.** Every byte of feedback produced locally is
  `stub-grader-v1`; no provider was called and none is authorized (R10).
- **Local mode still exists.** `/api/progress` answers 403 `legacy_progress_disabled` rather than
  404, and the single-user paths remain when `B1PREP_SAAS` is unset. Making those refusals
  unconditional is PILOT-03, and `createServer()` still defaults to ready (`server.js:1079`).
- **There is still no task list, no objective marking route and no new client.** `GET /api/v1/tasks`
  and `GET /api/v1/attempts` do not exist, so journey legs J3, J4, J8, J9, J10 and J11 remain
  `PENDING` and are **not** counted as passes. `/` still serves the old SPA.
- **The CRLF checksum trap is confirmed, not fixed.** L3 proves the ledger's checksums match the
  files on disk — the ledger hashes **raw bytes** (`464552a5…` for `0001`) while
  `server/migrations/MANIFEST.json` holds **LF-normalised** digests (`b529a5b9…`). The manifest is
  read by no code. Anyone who compares the two will see all six differ.
- **The local database is not backed up, not tuned and not durable beyond this machine.**
- **No browser or device evidence.** Serving `/` returned 200; no rendered check was run.
- **Two pre-existing hatoove containers were left running by earlier work** (`hatoove-ci` on 55469,
  `hd02-deletion-pg` on 55435). This slice did not touch them, and does not claim they are harmless.

---

## 7. Next

1. **PILOT-02** — re-run PR #89's own checker against `74fb158` and establish what is actually true.
   That commit is `ARCHIVED UNVERIFIED`; nothing in it may be trusted yet.
2. **PILOT-03** — one runtime: `/api/progress` becomes 404, the single-user paths go, and
   `createServer()` stops defaulting to ready.
3. **PILOT-04** — exam-scoped identity and `GET /api/v1/tasks`, which unblocks J4 and, with it,
   the whole client path.

Run locally with:

```
node tools/local-bringup.mjs          # serve at http://127.0.0.1:4300
node tools/local-bringup.mjs --down   # stop it
node tools/local-bringup-check.mjs    # 10 legs, disposable, ~2 minutes
```
