# WORKER-RUNNER-01 — a real job runner, so "durable feedback" stops being a fixture

| | |
|---|---|
| Authority | `DISPATCH — WORKER-RUNNER-01` (dispatch text in the branch workspace) |
| Base | **`08acb21`** (`codex/integration-01`, `SAAS-MODEL-01 ALIGNMENT`; printed above) |
| Branch | `codex/worker-runner-01` |
| PR | https://github.com/ronslink/hatoove/pull/84 (against `codex/integration-01`) |
| Status | **complete and green for the pipeline this slice owns.** The runner, the CLI and the checker are pushed (steps 1–3); the baseline re-run is green; every suite named in the dispatch was run here and held its count. The real grader is the *next* slice and is not wired. |

Commits (each names the base):

| SHA | Step |
|---|---|
| `34ef8ed` | step 1+2 — `server/owned-postgres/worker.mjs` + `server/worker.mjs` |
| `edab248` | step 3 — `tools/worker-runner-check.mjs` + the CI step |
| (this commit) | step 4 — this record |

---

## 1. What shipped

### 1.1 `server/owned-postgres/worker.mjs` — the bounded step function

`createWorker({ pool, grade, now = () => new Date(), leaseMs = 60000, maxTries = 3 })` returns
`Object.freeze({ runOnce, reclaimExpired })`.

* **`runOnce()`** claims **at most one** job, does one unit of work, and returns
  `{claimed:false}` or `{claimed:true, submissionId, outcome, code?}`. There is **no loop inside
  the module**; the caller loops it with a bounded count. A stall therefore cannot masquerade as
  progress — this is the dispatch's rule 2 made structural.
* **`grade` is injected** and defaults to `stubGrade()` — a fixed synthetic assessment. **This
  slice makes no provider call at all.**
* **`now` is injected** so the lease can be advanced in a check instead of slept on.

#### The claim query, and why it is safe under concurrency

```sql
UPDATE jobs SET status = 'running', lease_token = $1, lease_until = $2, tries = tries + 1, failure_code = NULL
WHERE id = (
  SELECT j.id FROM jobs j JOIN submissions s ON s.id = j.submission_id
  WHERE j.status = 'queued'
  ORDER BY s.created_at, j.id
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1
)
RETURNING id, submission_id, owner_id, tries
```

* The sub-select takes the **oldest queued submission first** (`ORDER BY s.created_at, j.id` — a
  real FIFO; `jobs` itself has no timestamp column, so the order comes from its submission).
* **`FOR UPDATE OF j`** row-locks the chosen job, and **`SKIP LOCKED`** makes a second worker's
  sub-select skip that locked row instead of blocking on it. Two workers racing one queued job
  therefore cannot both claim it: the loser finds no unlocked queued row and its `UPDATE` matches
  nothing (`claimed:false`). This is exactly leg 7, and the dispatch's prescribed mutation of it
  (M2) makes the leg fail.
* The claim is a **single statement**, so it is atomic; `tries` is incremented **at claim time**,
  so a worker that dies mid-grade still consumes a try and the job is not retried forever.
* Only one queued job is claimed per call, so the ordering matters only for fairness.

#### The lease fence

Claiming writes a random `lease_token`. The assessment is committed in **one transaction** that
re-reads the job `FOR UPDATE` and requires the **same token and `status='running'`**:

```js
const job = first(await client.query(
  'SELECT id, owner_id, status, lease_token FROM jobs WHERE submission_id = $1 FOR UPDATE', [submissionId]));
if (!job || job.status !== 'running' || job.lease_token !== token) return { … outcome: 'stale' };
```

A worker whose lease lapsed, was reclaimed and re-claimed by someone else holds a stale token, its
commit matches no row, and it writes nothing — leg 5 shows B's assessment surviving and exactly
one assessment existing.

#### `reclaimExpired()`

One transaction, `FOR UPDATE SKIP LOCKED` over
`status='running' AND lease_until IS NOT NULL AND lease_until <= $1` (the injected clock):

* each lapsed job with `tries < maxTries` → back to `queued` (`failure_code`, token and lease
  cleared) — the reservation is **kept**, because the submission is still owed a grade;
* each lapsed job with `tries >= maxTries` → `failed` with `failure_code = 'retry_exhausted'`,
  and its owner's `entitlements.reserved` is **decremented** (grouped per owner), so an abandoned
  submission does not hold an allowance forever.

### 1.2 `server/worker.mjs` — the CLI (Step 2)

A thin entry point that connects with the **restricted `<prefix>_worker` role** (via
`persistentRolePool(config, 'worker')`), loops `reclaimExpired()` → `runOnce()` with a bounded
sleep, and exits cleanly on `SIGINT`/`SIGTERM`. It **refuses to start without database
configuration** (naming the missing variables, never their values) and **prints no credential**.
`--once` runs exactly one bounded iteration. It is **not** started by `server.js`.

### 1.3 `tools/worker-runner-check.mjs` and CI (Step 3)

Eleven legs (the dispatch's 1–8 plus two for the CLI) against **real PostgreSQL through the real
adapter and the real owned API**. It creates a **disposable** `ownapi_<hex>` schema and roles via
`bootstrap.mjs` (the same schema and grants an installation provisions) and drops them. Added to
the existing CI `postgres` job.

---

## 2. Grants: what the worker role had, and whether a migration was required

`spikes/auth-runtime/isolation.sql` grants the worker role (`isolation.sql:19-24`):

```sql
GRANT SELECT ON attempts, submissions, jobs, entitlements, assessments, usage_ledger TO __WORKER__;
GRANT UPDATE(deleted_at) ON attempts TO __WORKER__;
GRANT UPDATE(used,reserved) ON entitlements TO __WORKER__;
GRANT UPDATE(status,lease_token,lease_until,tries,failure_code) ON jobs TO __WORKER__;
GRANT INSERT ON assessments, usage_ledger TO __WORKER__;
```

plus `worker_*` policies `USING(true)` on those tables (an explicit role policy, not `BYPASSRLS`).

Statement-by-statement, every column this module writes is already granted:

| Operation | Needs | Granted |
|---|---|---|
| claim `jobs` (`status, lease_token, lease_until, tries`) + `FOR UPDATE OF j` | `UPDATE` on ≥1 `jobs` column | ✅ `UPDATE(status,…)` |
| order by `submissions.created_at` | `SELECT` on `submissions` | ✅ |
| read `submissions`/`attempts.deleted_at` | `SELECT` | ✅ |
| `INSERT assessments`, `INSERT usage_ledger` | `INSERT` | ✅ |
| `UPDATE entitlements(reserved, used)` | `UPDATE(reserved, used)` | ✅ |
| `reclaimExpired` on `jobs` / `entitlements` | as above | ✅ |

**No migration was required, and none was added.** (The dispatch says a needed migration would be
`0007-…`, never an edit to `0006`. On this base the highest tracked migration is **`0005-account-deletion`**
— `provision.mjs:MIGRATIONS` — so there is no `0006` here to avoid editing; the point is moot
because nothing needed granting.) If a later slice's statement needs a grant the worker lacks, it
belongs in a new `0007-…`, not in an edit to `0005`.

---

## 3. Verbatim checker output (`node tools/worker-runner-check.mjs`)

```
PASS 1. full pipeline: submit debits once, runOnce grades, result() returns the assessment
     queued->succeeded; reserved=1->0, used=0->1; assessment rows=1; result() served the stub assessment
PASS 2. idempotency: a replayed event_id creates no second job and no second debit
     replay:true; jobs for owner stayed 1; reserved stayed 1
PASS 3. retry path: a throwing grader fails with a stable code, releases the reservation, and retry() re-queues
     failed(grader_unavailable) then re-queued with tries=1, reserved refunded then re-reserved
PASS 4. retry limit: retry() works at tries=2 and is refused at tries=3 (the boundary, not just the far side)
     retry at tries=1 -> 202, tries=2 -> 202 (near side), tries=3 -> 409 retry_unavailable (far side)
PASS 5. lease fence: a worker whose lease lapsed cannot commit; the assessment is B's and there is exactly one
     A stale (refused); B succeeded; assessments=1 (B's); reserved=0 used=1
PASS 6. reclaimExpired(): lapsed -> queued, and lapsed past maxTries -> failed retry_exhausted with reserved released
     (a) lapsed -> queued, reserved kept=1; (b) tries=3 -> failed retry_exhausted, reserved released=0
PASS 7. concurrency: two runOnce() against one queued job — exactly one claims, exactly one assessment
     claims=1 (succeeded), idle=1; assessments=1; jobs unchanged
PASS 8. control: with nothing queued, runOnce() returns {claimed:false} and writes nothing
     claimed:false; jobs/assessments/ledger/used/reserved unchanged
PASS X1. server/worker.mjs --once is a real process that drains one queued job as the worker role
     child exit 0; stdout: worker: succeeded submission=a6ec2c1d-990c-436a-a5f8-b046bf7d25d1
PASS X2. the CLI refuses to start without database configuration and prints no credential
     child exit 2; refused naming the missing variables, no credential printed

10 passed, 0 failed
NOTE disposable PostgreSQL, real adapter and API; the grader is a deterministic stub (no provider call).
```

Run twice more with the same result (a fresh random schema each run). **The default grader is the
stub, so no provider was contacted in any of these runs.**

---

## 4. Discrimination — one mutation per leg

Driver: a scratch clone only (`/root/workspaces/hatoove-worker01-discrim`), one file patched, the
**single named leg** run, then reverted. Every mutation was caught.

| # | Mutation (scratch only) | Leg that must catch it | Result |
|---|---|---|---|
| M1 | remove the token/status check from the commit path (and the `UPDATE` guard) | 5 | **FAIL** |
| M2 | remove `status='queued'` **and** `SKIP LOCKED` from the claim | 7 | **FAIL** |
| M3 | widen the retry limit `tries >= 3` → `tries >= 99` (in `adapter.retry`) | 4 | **FAIL** |
| M4 | stop refunding `reserved` on a failed grade | 3 | **FAIL** |
| M5 | neuter the `submit()` event-id replay branch | 2 | **FAIL** |
| M6 | stop refunding `reserved` when a job is abandoned past `maxTries` | 6 | **FAIL** |
| M7 | make `runOnce()` never claim (nothing ever runs) | 1 | **FAIL** (and leg 8 still passes — see below) |

Verbatim (`>>> leg failed as required` after each):

**M1 → leg 5** (lease fence removed):
```
FAIL 5. lease fence: a worker whose lease lapsed cannot commit; the assessment is B's and there is exactly one
     duplicate key value violates unique constraint "assessments_pkey"

0 passed, 1 failed
```
Without the fence, worker A's commit proceeds and collides with B's assessment on the
`assessments` primary key; the transaction rolls back and the leg fails. The fence is what turns
that would-be collision into A's clean `outcome:'stale'`.

**M2 → leg 7** (claim predicate + `SKIP LOCKED` removed):
```
FAIL 7. concurrency: two runOnce() against one queued job — exactly one claims, exactly one assessment
     duplicate key value violates unique constraint "assessments_pkey"

0 passed, 1 failed
```

**M3 → leg 4** (retry limit widened):
```
FAIL 4. retry limit: retry() works at tries=2 and is refused at tries=3 (the boundary, not just the far side)
     tries>=3 must be refused

202 !== 409

0 passed, 1 failed
```

**M4 → leg 3** (failure no longer refunds):
```
FAIL 3. retry path: a throwing grader fails with a stable code, releases the reservation, and retry() re-queues
     a failure refunds the reservation

1 !== 0

0 passed, 1 failed
```

**M5 → leg 2** (replay branch neutered):
```
FAIL 2. idempotency: a replayed event_id creates no second job and no second debit
     Expected values to be strictly equal:
409 !== 202

1 passed, 1 failed
```
(The stray pass is `X2.` — the `--only=2.` filter also matches the substring in `X2.`; leg 2 itself failed.)

**M6 → leg 6** (abandonment no longer refunds):
```
FAIL 6. reclaimExpired(): lapsed -> queued, and lapsed past maxTries -> failed retry_exhausted with reserved released
     abandonment releases the reservation

1 !== 0

0 passed, 1 failed
```

**M7 → leg 1** (`runOnce` never claims):
```
FAIL 1. full pipeline: submit debits once, runOnce grades, result() returns the assessment
     Expected values to be strictly deep-equal:
+ actual - expected …
FAIL X1. server/worker.mjs --once is a real process that drains one queued job as the worker role

0 passed, 2 failed
```
Leg 8 (control) still passes under M7 — which is the point of the control: a suite that only ever
ran nothing would be all-green, so leg 1 failing while leg 8 passes shows the control is not the
only evidence.

**A caution from this very exercise (dispatch rule 3).** My first M1 mutation removed the `$2`
parameter from the `UPDATE` but left the parameter array alone, so leg 5 failed with
`bind message supplies 2 parameters…` — a failure of the *mutation*, not of the fence. I suspected
the mutation, kept the parameter arity consistent, and re-ran; the corrected M1 above is the
result. The first attempt is recorded here rather than quietly deleted.

---

## 5. Baseline re-run (after the change) with observed counters

Disposable PostgreSQL 17 (`postgres:17-alpine`, `127.0.0.1:55445`, database `hatoove_worker01`).
`OWNAPI_PG_ALLOW=1` and the `OWNAPI_PG_*` variables set for the PostgreSQL suites.

| Suite | Command | Observed | Expected |
|---|---|---|---|
| baseline | `node tools/check.js` | **101 passed, 0 failed** | 101/0 |
| design | `node tools/design-check.mjs` | **11 passed, 0 failed** | 11/11 |
| repository | `node tools/repository-check.mjs` | **passed** (349 tracked files; 278 text blobs) | passed |
| provision | `node tools/postgres-provision-check.mjs` | **5 passed, 0 failed** | 5/5 |
| owned API (memory) | `node tools/owned-api-check.mjs` | **24 passed, 0 failed (memory)** | 24/24 |
| owned API (durable) | `node tools/owned-api-check.mjs --backend=postgres-persistent` | **24 passed, 0 failed** | 24/24 |
| owned client | `node tools/owned-client-check.mjs` | **31 passed, 0 failed** | 31/31 |
| accounts HTTP | `node tools/accounts-http-check.mjs` | **6 passed, 0 failed** | 6/6 |
| deletion | `node tools/deletion-check.mjs` | **18 passed, 0 failed** | 18/18 |
| session boundary | `node tools/session-boundary-check.mjs` | **19 passed, 0 failed** | 19/19 |
| **worker runner (new)** | `node tools/worker-runner-check.mjs` | **10 passed, 0 failed** | new |

`repository-check` reports **349** tracked files where the dispatch's baseline said 346 — the three
new files (`worker.mjs`, `server/worker.mjs`, `worker-runner-check.mjs`). The check **passed**; the
count is a file count, not a suite count. `draft-session-check.mjs` was also run (**18 passed, 0
failed**) because it exercises the fixture worker hooks.

### The fixture worker hooks (dispatch Step 4)

I read `server/owned-postgres/fixture.mjs:108-136` and every caller before touching anything.
`store.worker.claim/complete/fail` are used by:

* `tools/owned-api-check.mjs` (memory datastore's own hooks, and the postgres world's),
* `tools/deletion-check.mjs:159-167`,
* `tools/draft-session-check.mjs:455-473`.

They are **test hooks**, and the suites above depend on them. **I did not remove or re-point them**
— doing so would move counts the dispatch told me to hold. The new module is **additive**; the
fixture is byte-identical. `git diff` over `fixture.mjs`, `adapter.mjs` and `bootstrap.mjs` is
empty on this branch, which is why the 24/24, 18/18 and 18/18 counts are unchanged.

---

## 6. What this slice deliberately did NOT do

* **No provider call, no prompt change, no `ai.gradeWriting` change.** The grader is injected and
  defaults to a stub. Wiring the real grader is the next slice.
* **No `server.js` change**; the runner is **not** started by the web process.
* **No client change** (`public/js/` untouched).
* **No superuser or migration pool in the runner** — `server/worker.mjs` connects only as the
  `<prefix>_worker` role.
* **No change to the deletion transaction's step order or locks** — `adapter.mjs` is untouched.

---

## 7. LIMITS (unhedged)

* **Was a real worker process ever started?** For the pipeline legs (1–8) **no** — the checker calls
  the **step function** (`runOnce`/`reclaimExpired`) directly, which is what the dispatch requires
  so a stall cannot look like progress. One real process **was** started: leg X1 spawns
  `node server/worker.mjs --once` as a child and asserts it exits 0 and graded the job as the
  worker role; leg X2 spawns it with no configuration and asserts it refuses. **The long-running
  daemon loop and its `SIGINT`/`SIGTERM` shutdown were never exercised end to end** — the signal
  handler is written but unproven. That is a real gap.
* **The lease fence checks `lease_token` and `status='running'` only**, exactly as specified. It
  does **not** re-check `lease_until > now()` at commit. A worker whose lease has lapsed but whose
  job has **not yet been reclaimed** can therefore still commit. This is standard lease-token
  semantics (the token is the fence; expiry only enables reclamation) but it is a real boundary,
  stated rather than hidden.
* **Clock skew is unmeasured.** `lease_until` is written from the worker's `now()` and
  `reclaimExpired` compares against it. In production both are the worker process clock; a skew
  between that host and another worker host shifts the effective lease by the skew.
* **The `attempt_deleted` branch of `runOnce` is defensive and not covered by its own leg.** A
  concurrent tombstone is covered only indirectly, by the commit fence (a `remove()`-cancelled job
  fails the fence). It is not separately demonstrated.
* **Discrimination covers one property per leg, not every assertion.** M1–M7 each break the
  property the corresponding leg names and are all caught. Individual assertions inside a leg
  (e.g. "lease released on commit") were not each given their own mutation.
* **The concurrency leg is not a stress test.** It proves two `runOnce()` calls on one row cannot
  both claim, asserting the job and assessment **counts** (not merely that both calls returned). It
  does not prove behaviour under a write-write deadlock, at the pool-size limit, or across
  processes.
* **CI was not run here.** The new check is wired into the existing `postgres` job in
  `.github/workflows/ci.yml`, but this environment has no GitHub Actions runner; the evidence above
  is a **local** run against `postgres:17-alpine`. A branch with a PR gets CI (the PR is open), but
  a green local run is not a green CI run.
* **No migration was added** because none was needed (§2). If a future statement needs a grant the
  worker role lacks, it must ship as a new migration `0007-…`.
