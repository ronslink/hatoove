# SAAS-MODEL-01 GAP — the API strategy and schema change the new master plan requires

| | |
|---|---|
| Why | Ron, 2026-10-01: *"we need to change the api strategy and database schema to meet our new master plan"*, after the plan in **PR #80** (`2e656fa`) replaced the earlier visual-preservation and single-user direction |
| Authority | [`MASTER-PLAN.md`](../../MASTER-PLAN.md) §"Direction now in force" and §"Delivery order" row **1 — SAAS-MODEL-01**; the domain model in [`DESIGN-WIRE-01.md`](DESIGN-WIRE-01.md) §"Target data model and retirement contract"; [`IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md) §115 — *"F-03 is a small integration spike followed by versioned contracts, **not an attempt to freeze an assumed 13-table schema**"* |
| Base measured | `codex/integration-01` @ **`eed04a3`** — the four reviewed fix branches merged into `e126d8c` with **zero conflicts** (writing-surface-01b, deletion-wire-01, session-fence-03, coord-verify). Built and measured in the coordinator's integration worktree at `D:\hatoove-work\integration-01` |
| Method | the live schema and route table read from a **freshly provisioned database** on that head, not from memory |
| Status | **gap analysis + dispatch.** No runtime file is changed by this document |

---

## 1. What exists today, measured

**13 tables** in schema `hatoove` on a fresh provisioned database:

```
account  assessments  attempts  drafts  entitlements  hatoove_migrations
jobs     learner_settings  session  submissions  usage_ledger  user  verification
```

**The API surface**, split across two layers that must not be confused:

| Layer | Routes |
|---|---|
| `server.js` (legacy / single-user) | `/api/health`, `/api/ready`, `/api/config`, `/api/ai`, `/api/ai/test`, `/api/progress` |
| `server/owned-api.mjs` (owned, session-derived) | `/api/v1/account` (GET, DELETE), `/api/v1/settings`, `/api/v1/attempts` (POST), `/api/v1/attempts/:id` (GET/PUT/DELETE), `/api/v1/attempts/:id/submissions`, `/api/v1/submissions/:id`, `/api/v1/submissions/:id/retry`, `/api/auth/*` |

**And one fact that decides half the work:** content is **not in the database at all**. It is 10 JSON files in
`data/` (554 KB total) served as **static files** (`server.js:25,511,522` `ALLOWED_STATIC_ROOTS`), and the browser
fetches them directly:

```
public/js/ai.js:515   fetch('/data/seed.json')
public/js/ai.js:530   fetch('/data/core-grammar.json', '/data/core-phrases.json')
public/js/ai.js:646   fetch('/data/vocab.json')
```

**So the content is client-loaded, unversioned, and has no rights or review record.** The plan's
*"immutable versioned shared records with rights/review status; answer keys remain server-side"* has **no
implementation at all**, and neither does the catalogue/entitlement pair.

---

## 2. The gap, table by table

| Plan domain | Today | Verdict |
|---|---|---|
| **Identity / session** | `user`, `session`, `account`, `verification`, four restricted roles, FORCE RLS | **Present** — but `server/owned-postgres/sessions.mjs` is the **synthetic** port, not a maintained auth adapter. That is the plan's `SAAS-MODEL-01` auth half, and it is the largest single unknown |
| **Profile / preferences** | `learner_settings` per user (migration `0004`) **plus** a machine-global `EXAM_DATE` env var and a shared `.env` written by `POST /api/config` | **Half.** Per-account record exists; **the machine-global path must go** — the plan names *"no machine-global EXAM_DATE or shared settings file"* explicitly |
| **Task / content / audio / rubric** | **No table.** `data/*.json` served statically; `adapter.mjs:29-30` binds every attempt to the constants `TASK_VERSION = 'synthetic-writing-v1'` and `RUBRIC_VERSION = 'formative-fixture-v1'` | **MISSING — the largest schema gap.** Needs versioned task/rubric records with rights and review status, and the attempt must bind a **real** task id and version |
| **Attempt / draft / submission / revision** | `attempts`, `drafts`, `submissions` with revision, immutable-submission trigger, revision lineage via `parent_submission_id`; `read(owner,id)` exists | **Mostly present.** Missing only the **list/discovery** capability (`SAAS-RESUME-01`), which is the S6 slice already dispatched as `S6-LIST-01`. **Ordering must change with the schema**: `attempts` has **no `created_at`** (`spikes/auth-runtime/schema.sql:2-7`), so a chronological list needs a column, not just a query |
| **Assessment / job / usage** | `assessments`, `jobs` with lease/status/tries, `usage_ledger`, `entitlements` with reservation and single debit | **Present as records.** But completion is a **fixture hook** (`fixture.mjs:106-123` `worker.complete`) and there is **no production worker runner**; writing still grades in the browser via `ai.gradeWriting` |
| **Progress / review / study plan** | The whole `freshState()` document is stored as one blob: `b1prep.state.v1` in the browser and `progress.json` on the server, merged by `progress-merge.js`, served by `/api/progress` | **WRONG SHAPE and must be replaced, not renamed.** The plan is explicit: *"do not store the entire old `freshState()` document as the new account schema"*, and *"do not retain an offline full application or file-sync engine to satisfy old tests"* |
| **Catalogue / order / entitlement** | `entitlements` (allowance/used/reserved) exists | **Missing the catalogue, order and price-snapshot records.** `DESIGN-07`, a separate commercial track |

---

## 3. The API strategy change, stated in five sentences

1. **One entry point, not two.** The app becomes a multi-user service that **fails closed** without its account and
   database configuration — *"including when a mode flag is omitted"*. Today, omitting `B1PREP_ACCOUNTS` silently
   starts a working single-user app, which is the behaviour the plan removes.
2. **Every learner record is reached through an owned, session-derived route.** Identity never comes from a body, a
   path or a query string; `ownable` is always the verified session user. That is already true of `/api/v1/*`.
3. **The header-attributed and file-based routes are removed, not gated.** `/api/progress` (with its
   `x-b1prep-account` owner selector and unscoped fallback), the progress file, its backups and its revision
   handling all go. `saas-runtime-check` currently proves they are **refused under `B1PREP_SAAS=1`** — the target is
   that they **do not exist**.
4. **Content moves behind owned, versioned server routes.** The client stops fetching `/data/*.json` directly for
   anything that is assessed, and receives versioned task records through the API, with **answer keys staying
   server-side**.
5. **Grading, prompts and provider selection stop being browser-controlled.** The client keeps renderers and
   educational utilities; it loses authority over scores, quotas and the provider.

---

## 4. What is NOT in question, so the change does not overreach

- **The ownership model stays.** Session-derived `owner_id`, `FORCE ROW LEVEL SECURITY`, the four restricted
  `NOBYPASSRLS` roles and the reviewer-verified deletion transaction are the part of this schema the plan tells us to
  *preserve*, and `deletion-check` is **18/18** on the integration head. **No migration may weaken them.**
- **No per-account DDL.** *"Adding a learner creates rows, not a schema/database/role."*
- **No live data migration or deletion is authorised.** *"Planning authorizes no live data migration or deletion."*
  Obsolete objects are removed by **forward migrations after** their consumers are mapped, applied migration history
  stays intact, and **no migration may silently assign ambiguous old data to an account or destroy existing learner
  records**.
- **Existing learner records are preserved.** The one requested import is a separate, explicit, dry-run-capable
  operation with owner/provenance checks — **not a permanent compatibility path and not a prerequisite**.
- **The vanilla client stays.** The plan says so twice; a mockup's "React app" label is reference copy.
- **`D:\B1_Prep` remains a read-only reference.**

---

## 5. The ordering, and the one thing it means for the queue

The plan's delivery order puts **`DESIGN-01` + `SAAS-MODEL-01`** at step 1 and marks them **parallel**. Everything
else depends on them: `DESIGN-02` and `SAAS-RESUME-01` on the contracts, `SAAS-RETIRE-01` on *"replacement consumers
verified"*.

**So the sequence is: contracts first, then removal, and removal only after each old writer/reader has a verified
replacement.**

**`SAAS-RETIRE-01` is a required cutover, and it changes what the current queue is worth.** Four things in flight or
recently landed are correct today and **strategically superseded** by it. Recording that plainly, because the
alternative is spending the next slice preserving something the plan removes:

| Work | Verdict under the new plan |
|---|---|
| The N-1 cross-tab fence, F-C and F-A (`session-fence-02`/`-03`) | **Worth doing.** The leak is live now, these are small and verified (`session-boundary-check` 19/19, browser 70/70 on the integration head), and they protect **today's** users |
| The writing-surface slice (`writing-surface-01b`) | **Worth keeping, but it wires the local-store path.** `DESIGN-03` says *"adopt existing reviewed writing work"* — so it is an input, not wasted, and its `close()`/flush/flush-before-close findings carry over |
| `S6-LIST-01` (the list route) | **Becomes `SAAS-RESUME-01`.** Still needed, and its plan now has a **harder** requirement than my dispatch gave it: task identity must be **stable and server-sourced**, so it depends on the content/task records in §2 |
| `progress-merge.js` and every `/api/progress` test | **Becomes removal work.** Do not extend them. The plan: *"do not delete failing tests just to label the migration complete"* — update them to the SaaS contract instead |

---

## 6. Immediate decision this document forces

**The content/task table cannot be designed until we know what a task *is* server-side**, because everything else
binds to it: the attempt's version columns, the answer keys, the rubric, the audio, and the resume route's stable
identity. The three candidates, with what each costs:

- **A — versioned task records seeded from `data/seed.json` plus a content-version table.** Cheapest real option:
  the 554 KB of JSON becomes rows with an explicit version, `attempts.task_version` becomes a foreign key to a real
  record, and answer keys move server-side. **This is the option §2's gap points at.**
- **B — keep the files, add a version manifest.** Fastest, and it does **not** satisfy *"answer keys remain
  server-side"* or *"immutable versioned shared records"*; it defers the whole gap.
- **C — a content service with an authoring/review workflow.** Correct long-term, and **C-01's rights/review status
  is still `unknown`** for most of the corpus (only `seed.json`'s 24 sets are inventoried), so parts of it would be
  building on unreviewed content.

**Recommendation: A, bounded to the writing task family first** — because writing is the one family with a real
submission, job, assessment, rubric and revision path already built and verified, so a task record there can be
bound end to end and proved. Objective marking (`DESIGN-04`) then reuses the same shape.
