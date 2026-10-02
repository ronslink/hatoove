# SAAS-MODEL-01 — recommendations for the API strategy and schema

| | |
|---|---|
| Author | Claude (architect review, not implementer). Brief: `CLAUDE-BRIEF-SAAS-MODEL-01-ALIGNMENT.md` |
| Base | detached `origin/codex/integration-01` @ `20f89433dfa22d3d9135d833232d32236466b739`. **Checkout unmodified**: `git status --porcelain --ignored` is empty after all work |
| Environment | Node 24.4.1, Windows. **No PostgreSQL and no browser** were used or created. Everything about runtime database behaviour below is a **reading** and is labelled as such |
| Probes | Two scratch scripts in `D:\hatoove-work\claude-align-recommendations\probe\`, writing only to `%TEMP%` |

**Summary.** I agree with the gap doc's overall direction: keep the ownership model, use contracts before removal, and keep content in the DB. It has four material errors. (1) `seed.json` contains **no writing prompts**, so "seed writing first from seed.json" can't be executed as written. (2) Content is not "client-loaded files". When AI is reachable, **the default runtime path generates exam sets and their answer keys in the browser through the LLM**, and files are only the fallback. Removing the generic proxy therefore cuts objective practice to **24 sets of unknown rights**, and nobody has put that product consequence in front of Ron. (3) Two live hosted-mode defects are worse than anything in the retirement list: an anonymous **write of a machine-global setting**, and open sign-up feeding an **unmetered LLM proxy**. (4) The *production* server is assembled from the **test fixture module** and keeps a **superuser pool** open at runtime. That makes "production auth" a runtime-composition problem as well as a library choice.

---

## §1 What I verified (commands and output)

| # | Claim | How | Result |
|---|---|---|---|
| V1 | Baseline unchanged on this head | `node tools/check.js`, `writing-check.js`, `feedback-check.js`, `owned-api-check.mjs`, `progress-scope-check.mjs`, each under `timeout 180` | **101/0**, **9/0**, **14/0**, **24/0 (memory backend only)**, **7 + pre-fix discrimination**. No PG backend run |
| V2 | **Hosted mode lets an anonymous caller rewrite the server's `EXAM_DATE`** | `probe/config-probe.mjs`: `B1PREP_SAAS=1`, readiness forced `ready`, stub owned API whose `get-session` returns no user, temp `B1PREP_ENV_FILE`; same-origin POST with **no cookie** | `anonymous POST /api/config -> 200 {"ok":true,"examDate":"2099-01-01","saved":["EXAM_DATE"]}`; env file now contains `EXAM_DATE=2099-01-01`; `anonymous GET /api/config -> 200 {"examDate":"2099-01-01"}` — **every visitor now reads that date**. Control: `anonymous POST /api/ai -> 401` |
| V3 | The existing check **asserts** that behaviour | read `tools/saas-runtime-check.mjs:676-680` | `assert.equal(allowed.status, 200, 'the deployment origin must be accepted')` on `POST /api/config` in a ready hosted runtime. The test enshrines the defect as a pass |
| V4 | `seed.json` has no writing family | `node -e` over `data/seed.json` | keys `LV1 LV2 LV3 SB1 SB2 HV1 HV2 HV3`, **3 sets each = 24**, **no `id` field** on a set (only `title`). The 6 writing prompts are JS constants: `public/js/ai.js:837` `OFFLINE_WRITING_TASKS` |
| V5 | The default practice path is LLM generation in the browser | read `public/js/ai.js:52-54` (`isConfigured()` returns `status.configured !== false`, and `/api/config` no longer sends `configured`, so it is **true by default**); `:669-699` `genSet` calls `callAI` at `temperature: 1.0` and uses the seed **only on failure**; `:786` `genWritingTask` likewise | Exam sets, items and **answer keys are created client-side**. History entries carry `source: 'ai' | 'offline' | 'seed' | 'vocab' | 'review' | 'mock' | 'writing' | 'speaking'` (grep of `public/js/*.js`) |
| V6 | `/api/ai` has no usage limit | read `server.js:950-986`; grep for rate/quota/throttle in `server.js` | session required in hosted mode, model ignored, body capped at 256 KB — **no per-account rate, quota or debit**. Sign-up `owned-api.mjs:271-275` has **no verification or rate limit** |
| V7 | Production runtime is built from the test fixture | read `server/accounts.mjs:73-94` → `createPostgresWorld` in `server/owned-postgres/fixture.mjs:35-45` → `createPostgresSessions({ pool: db.auth, adminPool: db.admin })` | Running server = fixture world, synthetic session port, and a privileged `admin` pool used **per sign-up** (`sessions.mjs:129-131`). `provision.mjs:218-238` keeps `admin` open (default user `postgres`). Migrations run **at every server start** from the runtime process |
| V8 | Migrations 0001–0003 are read from `spikes/` and recorded by id only | read `provision.mjs:65-78`, `:152-157` | ledger is `(id, applied_at)`: **no checksum**. `spikes/auth-runtime/schema.sql:1` says "*Synthetic spike records only*", and `isolation.sql:2` says "*No production runner*" — yet both are production migrations |
| V9 | Settings still accept a learner-chosen model | read `owned-api.mjs:117,142-145`; `provisioning-sql.mjs:36` | `PUT /api/v1/settings {"model": "..."}` is accepted and stored (`model text DEFAULT 'deepseek-chat'`). `/api/ai` ignores it, so it is dead today. It is a provider-selection field on a learner record, which the plan forbids |
| V10 | Deletion read-back is a hand list | read `adapter.mjs:243-250` | `ACCOUNT_TABLES` names 11 tables. A new owned table is checked only if someone remembers to add it |
| V11 | Legacy coupling of the suite | `grep -lE "/api/progress|progress-merge|B1PREP_PROGRESS_FILE|b1prep\.state\.v1|adoptLegacy|single-user" tools/*` | **28 checker files**; CI (`.github/workflows/*.yml`) runs ~38 distinct node steps. Retirement touches most of the suite, not a corner of it |
| V12 | Rubric is unreviewed and disputed | read `ai.js:760-765` vs `IMPLEMENTATION_PLAN.md:151` | code: **4 criteria** summing 45 (15/10/12/8); E-01 acceptance: "*four writing points, three criteria*". A `rubric_version` row seeded from code would version a rubric the plan says is wrong |

Not verified: anything on PostgreSQL (RLS, grants, migrations, the deletion), anything in a browser, and Better Auth behaviour (not installed in this checkout; installing would write into it).

---

## §2 Recommended target schema

Principle: **three table classes, each with a mechanically checked rule.** *Auth* tables (library-shaped, no RLS, auth role only). *Owned* tables (`owner_id` FK to `"user"`, FORCE RLS, owner policy, listed in deletion). *Shared content* tables (no owner, immutable, no runtime write grant). A catalog-driven check (§4, C3) enforces the class of every table so that growing from 13 to ~22 tables can't silently weaken a class.

### 2.1 Shared content — immutability is structural, not promised

```
content_source   (id uuid PK, name, licence_text, rights_status  -- unknown|owned|licensed|restricted
                  evidence_ref, recorded_by, recorded_at)                       -- append-only
task             (id uuid PK, family text CHECK (family IN ('LV1',…,'HV3','SA1')),
                  slug text UNIQUE, created_at)                                 -- stable identity
task_version     (id uuid PK, task_id FK, version int, UNIQUE(task_id, version),
                  payload jsonb NOT NULL,          -- learner-visible ONLY; no keys
                  payload_sha256 text NOT NULL, payload_schema int NOT NULL,
                  source_id FK content_source, created_at, created_by)
task_key         (task_version_id PK FK, key jsonb NOT NULL)                    -- objective families only
rubric_version   (id uuid PK, rubric_slug, version, criteria jsonb, sha256, UNIQUE(rubric_slug, version))
prompt_version   (id uuid PK, purpose, version, template text, sha256)          -- assessment prompts, server-only
content_review   (id uuid PK, subject_kind, subject_id, status  -- unreviewed|in_review|approved|rejected|retired
                  reviewer, decided_at, note)                                   -- append-only
```

- **Immutability**: a `BEFORE UPDATE OR DELETE` trigger on `task_version`, `task_key`, `rubric_version`, `prompt_version`, `content_source` and `content_review`, the same pattern as `schema.sql:28-30`. Review status is **not a column** on the version. It is the latest `content_review` row, so a version row never needs an UPDATE. "Preserve each historical attempt's original rubric" then follows from: immutable row + `ON DELETE RESTRICT` FK from the attempt + no runtime role holding DELETE.
- **Binding** (owned side): `attempts.task_version_id uuid NOT NULL REFERENCES task_version`, `attempts.rubric_version_id uuid NULL REFERENCES rubric_version` (writing only), `assessments.prompt_version_id`. The learner role already lacks UPDATE on these columns (`isolation.sql:12` grants only `UPDATE(deleted_at)`), so the binding is immutable after insert. **Don't add binding columns to `submissions`.** Its immutability trigger would refuse the backfill, and the attempt binding is already immutable. Treat the existing `submissions.task_version/rubric_version` text columns as historical snapshots.
- **Answer keys**: no grant on `task_key` to `learner`, `auth` or `worker`. Marking runs through a `SECURITY DEFINER` function `mark_objective(task_version_id, answers jsonb) RETURNS jsonb` (per-slot correct/incorrect only). It is owned by the migration role, with `SET search_path = <schema>, pg_catalog` and `EXECUTE` granted to the learner role. Then even an injected learner-role query cannot select a key. The plan's "keys remain server-side" becomes "keys never leave the database to a learner-facing role." Feedback that shows the correct answer after submission is returned by the same function, and only for a submitted attempt.
- **Serving rule** as a view, `servable_task_version`: latest review `approved` **and** the source's `rights_status` in an allowed set. **The allowed set is deployment configuration.** Development/staging may serve `unreviewed`+`unknown` with a visible "unreviewed" label. Production serves `approved` only. The plan's gates then become data, not code branches.
- **Audio**: **no table now.** `C01` found 0 tracked fixed audio. Rule: a listening `task_version` is not servable unless it has an audio binding. When C-04 delivers, a forward migration adds `audio_asset(id, sha256, duration_ms, mime, storage_key, source_id)` and `task_version_audio(task_version_id, slot, audio_asset_id)`. Because versions are immutable, adding a recording produces a **new task version**, which is correct: a different recording is a different task.

**The harder question: is migrating content premature while rights are `unknown`?** **No. Building the tables and loader is not premature. Treating loaded rows as servable in production would be.** The database is where `rights_status` and review decisions get *recorded*. C-03's review queue needs exactly these tables, and leaving content in files defers the review workflow, not the risk. What would be premature is (a) a production serving policy that admits `unknown`, and (b) seeding a rubric version from `ai.js:760-765` and calling it the rubric. Seed it as `rubric_slug='sa1-formative-draft'` with status `unreviewed`, so E-01 produces version 2 rather than an in-place edit.

### 2.2 Owned learning records — replacing `freshState()`

`freshState()` (`public/js/store.js:48-73`) is mostly **derived data**. `mleAbility` (`store.js:970-1003`) already recomputes ability from `history`, and `nodes` is a cache of it. So the blob can be replaced by **one append-only event table plus three small state tables**, not a re-shaped document:

```
practice_event (id uuid PK, owner_id FK, client_event_id uuid, UNIQUE(owner_id, client_event_id),
                occurred_at, part_id, tags text[], difficulty smallint, correct bool, duration_ms int,
                task_version_id uuid NULL FK, item_ref text NULL,
                authority text CHECK (authority IN ('server_marked','self_reported','imported')),
                source text)                                         -- append-only, FORCE RLS
review_item    (id, owner_id, origin_event_id FK, task_version_id NULL, slot NULL,
                prompt/your/correct/explanation text (bounded as addError does today),
                status open|resolved, reviewed int, revision int, updated_at)
srs_card       (owner_id, card_key, box, due_at, reps, lapses, revision, PRIMARY KEY(owner_id, card_key))
plan_mark      (owner_id, day date, task_key, PRIMARY KEY(owner_id, day, task_key))
```

plus `learner_settings`: add `timezone`, `explanation_language CHECK IN ('de','en','uk','ar','tr')`, `onboarding_completed_at`, `tts_rate`, `auto_play`; change `exam_date` to `date`; **drop `model`** (V9). Add `created_at`/`updated_at` to `attempts` and `drafts`, plus `attempts.kind` (`writing` | `objective`), and `objective_response(attempt_id, slot, answer, revision)` / `objective_result(attempt_id PK, marked_at, per_slot jsonb, score)`.

**`authority` is the decision the plan hasn't made, and it matters most.** Drills from `generators.js` (`source:'offline'`), vocab flashcards (`ui.js:291-317`) and self-graded review can't be marked by the server, because the server never saw the item. The plan says "*do not trust browser-computed grades*". If that is applied literally, the adaptive engine, SRS and streaks lose their input. My recommendation: record them as `self_reported`. Let them drive *personal scheduling* (weak-tag priority, SRS due dates). **Exclude them from every displayed score and denominator** on the progress screen. Only `server_marked` rows produce accuracy figures. That keeps the behaviour learners rely on without turning a client-forgeable number into a claim. It needs Ron's sign-off because it's a product rule, not an implementation detail.

### 2.3 Auth and commercial

Keep `user`, `session`, `account`, `verification` exactly as Better Auth's shape (`auth-schema.sql`). §5 explains why that shape is an asset. Leave `entitlements` as is. Catalogue/order/price snapshot tables belong to DESIGN-07. **Don't design them in SAAS-MODEL-01.**

---

## §3 Recommended route surface

| Route | Fate | Notes |
|---|---|---|
| `GET /api/health` | **keep** | liveness only |
| `GET /api/ready` | **keep, change** | `mode` field removed (only one mode). Reasons add `schema_behind` (§3.1) |
| `GET/POST /api/config` | **delete now** (not at retirement) | V2 is a live defect. Replacement already exists: `GET/PUT /api/v1/settings` |
| `POST /api/ai` | **delete** once DESIGN-03's worker grades server-side; **meter immediately** | generic prompt proxy; V6. Until deleted, add a per-account daily cap at least (§7 risk 1) |
| `POST /api/ai/test` | **move** to an operator CLI | operator diagnostics don't belong in the learner HTTP surface |
| `GET/POST/DELETE /api/progress` | **delete** at SAAS-RETIRE-01 | keep the negative check (§4) |
| static `/data/*.json` | **split** | assessed families (`seed.json`) leave static serving. Pure reference (`grammar-guide`, `cases-guide`, `gender-rules`, `noun-lexicon`, `writing-guide`, `vocab`, `core-*`) may stay static. `speaking-guide.json` should stop being served (speaking is out of the pilot) |
| `/api/auth/*` | **replace** with the auth adapter's handler behind the same exact allowlist (`owned-api.mjs:269-291`) | add `request-password-reset`, `reset-password`, `verify-email`, `send-verification-email` |
| `GET/DELETE /api/v1/account`, `GET/PUT /api/v1/settings` | **keep**; settings drops `model`, adds the §2.2 fields | |
| `POST /api/v1/attempts`, `GET/PUT/DELETE /api/v1/attempts/:id`, `…/submissions`, `GET /api/v1/submissions/:id`, `…/retry` | **keep, change**: `POST` body gains `{taskVersionId}` (required) | `adapter.mjs:29-30,92-93` constants removed outside fixtures |

**Missing routes implied by the 14-screen map** (each needs a contract row before its screen is "wired"):

| Route | Screen(s) |
|---|---|
| `GET /api/v1/tasks?family=&cursor=` (servable list; payload without keys) and `GET /api/v1/tasks/:versionId` | practice, language, listening, writing, mock |
| `GET /api/v1/attempts?status=&kind=&cursor=` (SAAS-RESUME-01 / S6) | dashboard, writing, fresh-browser resume |
| `PUT /api/v1/attempts/:id/responses` and `POST /api/v1/attempts/:id/mark` (objective) | practice, language, listening, mock |
| `POST /api/v1/events` (batched `practice_event`, idempotent on `client_event_id`) | every drill/vocab view |
| `GET /api/v1/review`, `PATCH /api/v1/review/:id` | review |
| `GET/PUT /api/v1/srs/:cardKey` (or batch) | vocab/core trainers (not in the 14, see §6) |
| `GET /api/v1/progress?from=&to=` (bounded server aggregation, `server_marked` only) | dashboard, progress |
| `GET /api/v1/plan?from=&to=`, `PUT /api/v1/plan/:day/:taskKey` | plan |
| `GET /api/v1/export` | settings (the plan requires owned export; nothing serves it) |
| `GET /api/v1/explanations/:taskVersionId/:slot?lang=` | language, review (five languages) |
| `GET /api/v1/catalogue`, `GET /api/v1/entitlement` | upgrade (DESIGN-07) |

That makes roughly **20 owned routes**, up from 12. The coordinator's count of "~12 vs 14 screens" undercounts because practice, review, plan and progress each need two.

### 3.1 The fail-closed startup contract (deliberate breaking change)

1. **Delete both flags.** `B1PREP_SAAS` and `B1PREP_ACCOUNTS` stop existing. If either is *present* with any value, refuse to start and print "this flag was removed". An old launch script that sets `B1PREP_ACCOUNTS=0` must not believe it got a local app.
2. **Configuration missing → exit non-zero before `listen()`.** Required: database host/name, the three runtime role credentials, `B1PREP_PUBLIC_ORIGIN`, the auth secret. A misconfiguration should fail the platform's deploy health check, not produce a running 503 server (`server.js:1146-1151` does the latter today).
3. **Database unreachable or slow → listen, `ready:false`, retry with backoff.** This keeps the A3 design (`server.js:1105-1157`) for transient faults only.
4. **Schema behind expected head → `ready:false reason:'schema_behind'`, never migrate.** Migrations move to a separate `node server/migrate.mjs` run with migration credentials. The runtime gets **no** `admin` or `migration` pool (fixes V7).
5. Bind address comes from config (`server.js:1159` hard-codes `127.0.0.1`, which only suits a reverse proxy on the same host).

Checks that **change rather than disappear**: `saas-runtime-check` (drop the flag matrix, keep fail-closed/interruption/readiness, and invert V3 to *anonymous `/api/config` → 404*), `server-origin-check` and `provider-config-check` (retarget from `/api/config` to `PUT /api/v1/settings`; add "`model` → 422 `invalid_settings`"), `accounts-http-check` (no "off" mode to test, so test "absent config → process exits"). Tests that assert the *local* app still runs with flags unset are **superseded** and should be deleted with a recorded reason, as AGENTS.md permits.

---

## §4 Retirement sequence and what must not break

### 4.1 Safe as soon as the replacement exists vs. irreversible

| Removal | Class | Condition |
|---|---|---|
| `/api/config` + `EXAM_DATE` in `.env` | **safe now** | `/api/v1/settings` already serves `examDate`. Only consumer is `ai.js:28,141` and `app.js:306` (single-user branch) |
| `learner_settings.model` column | **safe now**, forward `ALTER TABLE DROP COLUMN` | no reader (V9) |
| `/api/progress`, `progress-merge.js`, `B1PREP_PROGRESS_FILE` reader/writer | safe once `/api/v1/events`, review, SRS and plan routes have consumers | the server **stops reading** `progress.json`; it never deletes it |
| `b1prep.state.v1` as runtime authority | safe once the same replacements exist | **irreversible if the new client *deletes* the key.** First release: stop reading and writing, leave the key in place, and offer "export / discard local data" in-app. Delete the key only on explicit learner action. (Leaving learner data on a shared device is a real privacy cost. It's the lesser harm for one release. The deletion response's `copies_outside_the_service` already discloses it.) |
| synthetic `TASK_VERSION` constants | safe after a forward migration inserts one `task`/`task_version` row (family `SA1`, slug `legacy-synthetic-writing`, status `retired`) and backfills `attempts.task_version_id` from the text | **no row is deleted or re-attributed**. Rows exist on any installation that ran `--backend=postgres-persistent` |
| `spikes/` as migration source | safe now, with a hash check (§8) | freeze 0001–0003 byte-for-byte under `server/migrations/`. Add a `checksum` column to the ledger (forward migration). Refuse to run on mismatch |
| old schema objects | **only** after a consumer map shows zero runtime readers | nothing in the current 13 tables is obsolete except `model`. **The "old single-user schema" is files and browser storage, not PostgreSQL tables**, which makes the DB side of retirement small |

### 4.2 Old data: is any automatic design defensible?

**No.** `progress.json` and account-selected files are attributed by an unauthenticated header (`x-b1prep-account`), and the browser blob by possession of a device. Neither identifies an account. The defensible design is the one the brief suggests, with one addition. **Old data stays untouched and is never read by the SaaS runtime. A learner can make an explicit, owner-verified import of a file they hold** (`exportJSON` already exists at `store.js:891`). It goes to `POST /api/v1/imports?dryRun=1`, the session is the owner, history becomes `practice_event` rows with `authority='imported'`, and **nothing imported counts as `server_marked`**. My addition: **don't build it unless Ron names a learner whose history must survive.** The plan makes it optional, and the only known store is Ron's live install. Ask him first; it may save a slice.

### 4.3 Properties that must survive (re-expressed, not deleted)

| Today's check | Property it guards | Survives as |
|---|---|---|
| `saas-runtime-check` legacy refusal | no anonymous/foreign progress read or write | **C1**: `/api/progress` → 404, *and* a dynamic probe that no file is created or read at the old default path or `B1PREP_PROGRESS_FILE` (watch the temp dir before/after) |
| `reset-check`, `revision-check` | delete really deletes; a late write cannot resurrect | owned equivalents: `DELETE /api/v1/attempts/:id` then a stale `PUT` → 404, never a recreate; account deletion then a late event → 401/404 (partly in `deletion-check` today) |
| `progress-scope-check`, `session-boundary-*` | no cross-account bleed through the client cache | keep the browser checks, retargeted to owned caches. The fence logic in `owned-client.js` survives the blob |
| `progress-equal-check` | blob equality | **delete with the blob.** No property survives it |
| `keymask-check`, `server-origin-check` | key never disclosed; origin gate | unchanged in substance |
| (new) **C2** | no generic prompt proxy | `POST /api/ai` → 404; client bundle contains no `callAI` |
| (new) **C3** catalog check, on PG | table-class rules | every table with `owner_id`/`user_id` has FORCE RLS, an owner policy, an FK to `"user"`, and appears in `ACCOUNT_TABLES`; shared tables have no runtime INSERT/UPDATE/DELETE grant; `task_key` has no SELECT grant to any runtime role. Discriminating: drop one policy or one grant and it must fail |

---

## §5 Production auth

**What already exists changes the decision.** The schema *is* Better Auth's (migration `0001` = `auth-schema.sql`). Better Auth 1.7.6 was pinned and exercised in the PR #11 spike (`spikes/auth-runtime/package.json`, `auth.mjs:13-20`: rate limit on, cookie cache off, min password 12). `sessions.mjs` is a stand-in writing into that schema. So the realistic fork is **"swap in the library we already modelled"** vs **"harden the stand-in"**, not "library vs bespoke".

| | A. Adopt Better Auth over the existing tables | B. Harden `sessions.mjs` into a bounded adapter |
|---|---|---|
| Schema | none new; `verification` is already there for email/reset tokens | add reset/verification token handling, rate-limit storage; risk of drifting from a shape we chose *because* it was Better Auth's |
| Ownership/RLS | unchanged: `owner_id` = `user.id` (text). Auth tables stay non-RLS, auth role only. **Sign-up hooks** must create `entitlements`/`learner_settings` through a grant or `SECURITY DEFINER` function, **not** the admin pool (V7) | same hook requirement |
| Existing accounts | **password hashes likely incompatible**: `sessions.mjs:27-31` writes `scrypt:<salt>:<hash>` with Node default scrypt params. *Reading, not verified* (§8 E3): Better Auth uses its own `salt:hash` format and parameters. Needs a verify-old-then-rehash shim or forced reset | none |
| Dependencies | root app is dependency-free today (`package.json` `"dependencies": {}`, `"node": ">=20"`). Better Auth needs a bundled or installed dependency tree and Node ≥ 22.16 | stays dependency-free |
| What you must build yourself | email transport adapter (stubbed in tests), CSRF/Origin alignment with `isSameOriginRequest` | `Secure`/`__Host-` cookies, rotation, revocation on password change, reset, email verification, enumeration-safe responses, per-IP and per-account throttles, session sweep — i.e. the parts that are easy to get subtly wrong |

**Recommendation: A, conditional on three facts before it's chosen** (gathering them is a ~half-day spike in a disposable checkout):
1. **E3**: does Better Auth 1.7.6 verify a `sessions.mjs` hash, or accept a custom `password.verify`? This decides whether a rehash shim is needed.
2. Whether Better Auth's handler mounts on a **bare `node:http`** server behind our origin gate without a framework, and whether its rate-limit storage can be the database rather than memory (memory is wrong for more than one instance).
3. How many real (non-test) accounts exist on any persistent installation. If zero, the hash question is moot.

**Information Ron doesn't yet have, and must decide on:** (a) whether ending the "root app is dependency-free" property is acceptable; it's a stated design value (`owned-postgres/package.json` description). (b) Which email provider is used for check-email and reset (it determines data-processor and privacy review, P-03). (c) Whether sign-up is open, invite-only or waitlist-gated for the pilot. Given V6, **I would recommend invite-only until the AI proxy is metered or gone.** `check-email` exists in the design. Magic-link and Google should stay absent until (b) is decided, per the plan.

---

## §6 Where the coordinator's plan is wrong

1. **"Seed from `data/seed.json`'s writing prompts first."** There are none (V4). Writing-first is still right because it's the family with a built end-to-end path. The seed source is `ai.js:837` (6 prompts, 3 du + 3 Sie), and the rubric is unreviewed and contradicts E-01 (V12). Seed both with status `unreviewed`.
2. **"Content is client-loaded, unversioned."** It's worse than that. The **primary** path is runtime LLM generation with browser-side keys (V5), and files are only the fallback. Under the plan's rules (no generic proxy, reviewed versioned tasks, server-side keys), **objective practice volume after retirement = the human-reviewed subset of 24 sets** (8 parts × 3). That's a product decision, not a migration detail. Ron needs to see it now: either accept a small reviewed bank for the pilot, or approve C-02 (server-side generation into `content_review` status `unreviewed`, served only where policy allows) as a dependency of DESIGN-04.
3. **"Option A: the 554 KB becomes rows."** Only `seed.json` is assessed content. The reference guides aren't tasks and gain nothing from task versioning. Don't drag them into `task_version`.
4. **Step order inside SAAS-MODEL-01a.** "Fail-closed entry point" is listed as step 2 of four. Deleting `/api/config` and metering or capping `/api/ai` are **hours of work closing live defects** (V2, V6) and depend on nothing. They should be a separate slice dispatched **before** the content migration. Likewise the "removal matrix" is not independent: it can't be finished until the routes in §3 exist, because each matrix row needs a named replacement.
5. **A smaller first slice that de-risks more: "MIGRATE-01".** Freeze migrations out of `spikes/` with checksums, add the separate `migrate` command, strip the runtime of `admin`/`migration` pools, and stop building the production API through `fixture.mjs` (introduce a `createRuntimeWorld` that shares ports but has no `inspect`/`worker.complete`). Every later schema slice adds migrations. Doing them on a ledger without checksums, from a runtime with superuser credentials, compounds the problem.
6. **Indivisible pair.** A `task_version` table without `GET /api/v1/tasks` and `attempts.task_version_id` is unverifiable. Don't split "content table" from "attempt binds it". The list route (S6) *can* be separate: it reads attempts, not tasks.
7. **The screen map has a gap.** The vocab/core trainers, the SRS, the adaptive drills (`generators.js`) and the reference guides have **no mockup and no contract row**. Yet they produce most of `history` by volume (sources `offline`, `vocab`, `review`). DESIGN-WIRE-01's closing paragraph keeps them but assigns no slice. Without a slice, SAAS-RETIRE-01 either can't complete or deletes them by accident. Add a row (owned SRS/events, same shell).
8. **"Planning authorizes no live data migration."** Correct. But SAAS-RETIRE-01's acceptance ("*Empty-database SaaS install and two-account journey pass*") only tests the empty case. Add: "upgrade of an installation with rows from migration 0005 passes, and the row counts of owned tables are unchanged except the documented backfill."

---

## §7 The three most dangerous things

**1. Open sign-up + session-gated generic LLM proxy = unbounded operator spend and abuse, live today.**
Attaches to `server.js:950-986`, `owned-api.mjs:271-275`, `ai.js:669-699`. Anyone can sign up with no verification or throttle, then send arbitrary prompts up to 256 KB to the operator's key. It sits outside `usage_ledger` because it isn't a submission. Nothing in the retirement plan touches it before DESIGN-03.
*Early warning:* add a per-account counter on `/api/ai` now and alert on >N calls/hour/account or >M new accounts/hour. Independently, check the provider dashboard's daily spend against `usage_ledger` debits: any gap is proxy traffic.

**2. Deletion completeness and RLS coverage drift as owned tables grow from 7 to ~14.**
Attaches to `adapter.mjs:220-250` (hand-listed steps and read-back) and the absence of a catalog check. The read-back comment (`adapter.mjs:268-271`) says it is "meant to catch" new tables. It can only catch tables someone added to the list. If a new `practice_event` gets `ON DELETE CASCADE` or no FK at all, deletion either silently cascades outside the reported counts or leaves orphans. `deletion-check` 18/18 would still pass, because it tests the listed tables. The shared content tables add the mirror risk: someone "makes it consistent" by enabling FORCE RLS with no policy (learners see no tasks), or gives the learner role SELECT on `task_key`.
*Early warning:* C3 (§4.3) run against every migration PR, with a mutation proof (drop a policy, remove a list entry, grant `task_key` SELECT) showing it fails.

**3. The progress/plan/dashboard views can't be rebuilt from server-marked rows without changing what learners see, and the plan doesn't say which change is acceptable.**
Attaches to `store.js:1045-1085` (`recordAttempt` funnels every source, including writing heuristics at `exam.js:834-841` that mark `correct` from word counts and connector counts) and DESIGN-WIRE-01's "*do not trust browser-computed grades*". Applying the rule strictly empties the adaptive engine's input. Ignoring it keeps client-forgeable accuracy figures on the progress screen. Either choice made silently by an implementer is wrong. A third failure mode: server aggregation over an append-only table without bounded queries (`MAX_HISTORY = 4000` today is a client cap, `store.js:42`) becomes a per-request full scan.
*Early warning:* before DESIGN-05 starts, run a fixture-replay check that feeds a recorded synthetic history through both today's `mleAbility`/`studyPlan` and the server aggregation, and diffs the outputs per source. Any difference should be explained by the `authority` rule and nothing else. Also: `EXPLAIN` on the progress query at 50k events/account must show an index range scan on `(owner_id, occurred_at)`.

Real, but smaller: the immutable-submission trigger blocks any migration that touches `submissions` (§2.1 avoids it); `attempts` lacks `created_at`, so the S6 list sort needs it *in the same migration* as the route; `learner_settings.language` is free text today and must be constrained before five-language work writes to it.

---

## §8 What needs execution to settle

| ID | Question | Check (bounded, disposable PG/browser, synthetic data) |
|---|---|---|
| E1 | Does the `SECURITY DEFINER` marking function actually hide keys from the learner role under FORCE RLS? | learner-role `SELECT * FROM task_key` → permission denied; `mark_objective()` returns per-slot results; mutation: grant SELECT and C3 must fail |
| E2 | Backfill of `attempts.task_version_id` on a populated install | provision at ledger 0005, run `owned-api-check --backend=postgres-persistent` to populate, apply the new migrations, assert row counts unchanged and `NOT NULL` holds |
| E3 | Better Auth hash compatibility and bare `node:http` mounting | `npm ci` in a disposable copy of `spikes/auth-runtime`, call its `verifyPassword` on a `sessions.mjs`-format hash (my probe script is at `probe/hash-probe.mjs` and was not run: library not installed) |
| E4 | Fail-closed startup | each required variable removed in turn → non-zero exit before listen; `B1PREP_ACCOUNTS=0` present → refusal; DB down → listen + `ready:false` |
| E5 | No legacy file I/O | filesystem watch on a temp root during the full two-account journey: zero opens of `progress*.json` / `.env` writes |
| E6 | Deletion covers new tables | `deletion-check` extended with one row in every owned table, including `practice_event`, `review_item`, `srs_card`, `plan_mark`, `objective_*` |
| E7 | View parity under the authority rule | §7 risk 3's replay diff |
| E8 | V2 against a real ready runtime | rerun `probe/config-probe.mjs`'s request against `saas-runtime-check`'s real PG-backed server without a cookie; expected (defect) 200, expected (fixed) 404 |

---

## §9 LIMITS

- No PostgreSQL. Every statement about RLS, grants, trigger behaviour, migration application and the deletion transaction comes from reading SQL and JS. In particular, I didn't verify that `SECURITY DEFINER` + FORCE RLS behaves as §2.1 assumes (E1).
- No browser. Nothing about client behaviour, caches or the session fence was exercised.
- V2 used a **stub** owned API (the session lookup returns no user) and forced readiness. It proves the route's handler doesn't consult identity. It doesn't prove anything about a PG-backed runtime beyond that (E8).
- Better Auth facts beyond what the repository pins are from my knowledge of the library and are labelled as readings (E3).
- I read the design screens only through DESIGN-WIRE-01's map, not `D:\B1_Prep\design` (not needed and not opened).
- I didn't review open PRs #74–#79 individually. Statements about them come from MASTER-PLAN/BOARD.
- The route count (~20) and the table list are a recommendation for SAAS-MODEL-01's contract, not a frozen schema. IMPLEMENTATION_PLAN §115 applies to this document too.
