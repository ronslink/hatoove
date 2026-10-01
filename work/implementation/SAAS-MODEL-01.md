# SAAS-MODEL-01 — the owned domain contracts, and the first retirement

| | |
|---|---|
| Dispatch | `SAAS-MODEL-01a` (Ron, 2026-10-01), after the master plan changed to *"change the api strategy and database schema"* |
| Gap measured by | [`SAAS-MODEL-01-GAP.md`](SAAS-MODEL-01-GAP.md) |
| Base | `codex/integration-01` @ **`20f89433dfa22d3d9135d833232d32236466b739`** |
| Branch | `codex/saas-model-01` |
| Status | **IN PROGRESS** — skeleton committed first, then the checker, then the change (dispatch rule 1/2) |

> This file is the task record. It is written as the slice proceeds and pushed at every step.
> A partial pushed slice is worth more than a complete unpushed one (dispatch §6).

## 1. What a task is, server-side

**A task is a stable identity plus an immutable, versioned payload, with a governance record.**
Concretely, for the writing family (the one family with a real end-to-end path today):

| Field | Server-side meaning | Where |
|---|---|---|
| **identity** | `task_id` — stable, human-readable, never a clock or a random (the client's `sa_off_<Date.now()>` id is explicitly **not** used) | `task_version.task_id` |
| **version** | `version` — what an attempt binds; a correction is a new version, never an edit | `task_version.version` |
| **prompt** | `situation` (the instruction the learner answers) | `task_version.situation` |
| **Leitpunkte** | the four required content points, `jsonb` array | `task_version.leitpunkte` |
| **rubric** | `(rubric_id, rubric_version)` → `rubric_version.criteria` | `rubric_version` |
| **answer key** | **not yet** — writing is formative; objective families (`DESIGN-04`) will add a key that stays server-side | _deferred_ |
| **audio** | **not yet** — no tracked audio exists (C-01: `0` fixed audio files); browser TTS only | _deferred_ |
| **rights/review** | `review_status`, `rights_status` on the content-version row | `content_version` |

Everything else binds to that answer: the resume route's stable identity is `task_id`; an
attempt's version columns are a composite foreign key to `(task_id, version)`; objective marking
will read the same shape. The full record set is in `server/owned-postgres/content-seed.mjs`.

**Provenance, stated plainly:** the dispatch said to seed *"`data/seed.json`'s writing
prompts"*. They are not there. `tools/content-discovery.mjs` shows `data/seed.json` holds the
**8 reading/listening/Sprachbausteine families** (24 sets, 180 keyed answer slots) and the **6
writing prompts live in `public/js/ai.js`** (`OFFLINE_WRITING_TASKS`, 3 `du` + 3 `Sie`, 4
Leitpunkte each; rubric `WRITING_CRITERIA`, 4 criteria, max 45). The seed is taken from the real
source and a **drift check** (`owned-api-check.mjs` check `content-seed-matches-the-client`)
re-imports `public/js/ai.js` and fails if the two diverge.

## 2. Step 1 — content and task records

**Migration id: `0006-content-and-catalogue`** (`server/owned-postgres/provisioning-sql.mjs`,
function `contentCatalogueSql`). It is additive and non-destructive; it runs on a fresh
installation through `MIGRATIONS` in `provision.mjs` and in the disposable fixture through
`bootstrap.mjs`, so the two cannot drift.

**What it creates** — three immutable, versioned, shared (no owner, no RLS) tables:

- `content_version` — the **content-version record carrying rights/review status**: `kind`,
  `family`, `source_path`, `review_status`, `rights_status`, `content_sha256`. One row per
  versioned artefact (7 rows seeded: 6 tasks + 1 rubric).
- `rubric_version` — `(rubric_id, version)` PK, `criteria` jsonb, `max_total`.
- `task_version` — `(task_id, version)` PK, `register`, `topic`, `situation`, `adressat`,
  `leitpunkte` jsonb, its rubric reference, and a `content_version_id` reference.

**Immutability:** a `BEFORE UPDATE OR DELETE` trigger on all three tables raises, so a version
is append-only. (This is *stronger* than "immutable once referenced": every record is
immutable from creation. A correction is a new version.)

**Seeded values are truthful.** C-01 measured that review/rights status is `unknown` for most
of the corpus and that **no human review of these six prompts has happened**, so every seeded
row carries `review_status = 'unreviewed'`, `rights_status = 'unknown'`. The value round-trips
verbatim (Step 4), so a later UI cannot silently present an unreviewed prompt as reviewed.

**What it does to existing rows — exactly, and why.** It changes **no existing row**. Two
nullable columns are added to `attempts` (`task_id`, `rubric_id`) and two composite foreign
keys: `(task_id, task_version) → task_version(task_id, version)` and
`(rubric_id, rubric_version) → rubric_version(rubric_id, version)`. PostgreSQL foreign keys
default to `MATCH SIMPLE`, so a row whose `task_id`/`rubric_id` is NULL is **not checked at
all**. An already-stored attempt therefore keeps its literal
`task_version = 'synthetic-writing-v1'` / `rubric_version = 'formative-fixture-v1'` and stays
readable; the migration never rewrites it into a claim about content that was never reviewed.
Observed on the measured database after migration:

```
-- new attempts (written by the datastore)
task_id = writing.du.besuch-einer-freundin  task_version = v1  rubric_id = writing.formative  rubric_version = v1
task_version = synthetic-writing-v1  rubric_version = formative-fixture-v1  task_id = NULL  rubric_id = NULL
```

New writes bind real versions through `adapter.mjs`'s `create(owner, parent, binding)`, whose
default binding is the canonical writing task in `content-seed.mjs`.

**Serving is NOT this slice.** No route serves these records; `public/js/` is untouched. The
records and their integrity are the deliverable; serving them is `SAAS-RESUME-01`/`DESIGN-04`.

## 3. Step 2 — the entry point fails closed

**Change.** `node server.js` now starts **not ready** in every mode
(`server.saasReadiness = { ready:false, reason:'starting' }`), and the account/database
configuration is **required**. The request-path gate is no longer conditioned on `B1PREP_SAAS`:
while the runtime is not ready, every `/api/*` route except `/api/health` and `/api/ready`
answers `503 {code:'not_ready'}`. `/api/ready` answers `503 {ready:false, mode:'unconfigured',
reason:'<the missing configuration>'}`. When the configuration loads, the runtime becomes ready
and the owned routes mount.

Observed, no configuration at all (`node server.js`, `B1PREP_ACCOUNTS` unset):

```
GET /api/ready   503 {"ok":false,"ready":false,"mode":"unconfigured","reason":"B1PREP_ACCOUNTS is not set"}
GET /api/v1/account  503 {"ok":false,"code":"not_ready","error":"The hosted runtime is not ready (B1PREP_ACCOUNTS is not set)."}
GET /api/progress    503 {"ok":false,"code":"not_ready",...}
GET /api/health      200 {"ok":true,"node":"v22.23.2"}
```

**The banner says so in one line, naming the missing configuration and printing no credential:**

```
  Accounts: accounts: off (B1PREP_ACCOUNTS is not set) - the runtime refuses learner routes (503)
  Readiness: NOT READY (B1PREP_ACCOUNTS is not set)
  Progress: file record disabled (account-scoped attempts)
```

**What each flag now means.**

| Flag / setting | Before this slice | After this slice |
|---|---|---|
| `B1PREP_ACCOUNTS=1` | opt-in that mounted accounts; absent ⇒ a working single-user app | **required**. Absent ⇒ the entry point is NOT READY and refuses learner routes. Still the flag that enables the owned API wiring. |
| `OWNAPI_PG_*` (e.g. `OWNAPI_PG_DATABASE`) | needed only once accounts were on | **required** alongside the flag; absent ⇒ NOT READY, reason names the missing setting |
| `B1PREP_SAAS=1` | **the switch that decided whether learner data was protected**: the legacy file route was refused only when it was set, and the fail-closed gate ran only when it was set | **a distinction only.** It selects the trusted-origin policy (`B1PREP_PUBLIC_ORIGIN` vs loopback) and the banner line. It **no longer** decides whether learner data is protected; the fail-closed gate now runs in every mode. |

**Which checks the change broke, and how they were updated (not deleted).**

- `saas-runtime-check`: the check whose whole purpose was *"the local install is unchanged"*
  (`legacy-progress-local-install-unchanged`) is **retired** — that mode no longer exists. It is
  replaced by `entry-point-fails-closed-when-the-mode-flag-is-omitted` (the refusal, with the
  negative control that the single-user write is not served). A new
  `fail-closed-no-longer-depends-on-the-mode-flag` proves the gate no longer keys off
  `B1PREP_SAAS`. **10 → 11 checks.**
- `accounts-http-check`: `accounts-are-off-by-default` asserted `404` for the owned routes; the
  new contract is `503`. Updated to `unconfigured-entry-point-fails-closed`. **6 → 6** (renamed,
  not removed).
- `session-boundary-check`: two checks asserted the single-user server path with accounts off.
  Updated: `accounts off` now proves the **server refuses** (`/api/progress` GET/POST `503`); a
  browser keeps only its **local** copy, and the tab-return check now runs on a configured
  runtime. **19 → 19** (no check removed).
- `B1PREP_SAAS`-gated `/api/progress` refusal is **unchanged** in this slice. Removing the route
  (and its header selector, file, backups and revision handling) is `SAAS-RETIRE-01`; see the
  matrix. This slice changes only the entry point.

**A client fact this exposed (recorded in LIMITS):** `public/js/store.js`'s `/api/progress`
reader does not check the HTTP status, so it misreads a `503` refusal as an **empty** server
record and reports `reachable: true`. A refusal alone is therefore not enough — the route must
be removed, which is exactly why the removal matrix exists.

## 4. Step 3 — the removal matrix

See [`SAAS-MODEL-01-REMOVAL-MATRIX.md`](SAAS-MODEL-01-REMOVAL-MATRIX.md).

## 5. Step 4 — the checker

_(each check's verbatim output + a discrimination leg per check)_

## 6. Baseline re-run at the new head

_(observed counters)_

## 7. LIMITS

_(unhedged)_
