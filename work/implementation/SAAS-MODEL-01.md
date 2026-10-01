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

_(flag table)_

## 4. Step 3 — the removal matrix

See [`SAAS-MODEL-01-REMOVAL-MATRIX.md`](SAAS-MODEL-01-REMOVAL-MATRIX.md).

## 5. Step 4 — the checker

_(each check's verbatim output + a discrimination leg per check)_

## 6. Baseline re-run at the new head

_(observed counters)_

## 7. LIMITS

_(unhedged)_
