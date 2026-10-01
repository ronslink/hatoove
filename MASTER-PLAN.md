# Hatoove master plan — a working multi-exam preparation SaaS, local first

**Regenerated:** 1 October 2026, after the workspace relocation to `D:\Hatoove` and Ron's direction change.
**Base inspected:** `59b1929` (`codex/workspace-relocation`, pushed to `origin/codex/workspace-relocation`), working tree clean.
**Governing product requirement:** [PILOT_BUILD_PLAN.md](PILOT_BUILD_PLAN.md). This document is its delivery order and progress record.
**Supersedes:** `work/implementation/FUNCTIONAL-ROADMAP.md` — the writing-first minimum functional product. The removal is recorded in §10.

---

## 0. The direction in force

Ron, 1 October 2026, verbatim:

> "we also need to frame this as a saas project that allows students to prepare for different exams online b1 german will be one of the languages but there will be others probably next will be english tests that are recognized and standardized. The feature we are trying to introduce explanations in users language to make understanding concepts easier as our differentiator and perhaps speech synthesis"

> "our goal is to have a saas working application locally"

> "lets stick to the pilot plan and remove the other"

Four consequences:

1. **The pilot plan governs.** `PILOT_BUILD_PLAN.md` is the product requirement again, and the writing-first minimum functional product is withdrawn as a plan. This matters beyond bookkeeping: the MFP deferred objective practice, listening, a study plan and the full written mock to *after* its own end, and it narrowed the client to about seven screens. The pilot plan treats reading, language elements, listening and writing as one written-section product (`PILOT_BUILD_PLAN.md:21`).
2. **The product is multi-exam, not a German app.** telc Deutsch B1 is the **first exam package**, not the product. The pilot plan already states the rule: *"Keep the exam package, exam language, instruction language and purchasing market independent"* (`:58`), and *"Similar proficiency levels do not make telc, DTZ, Goethe and IELTS interchangeable"* (`:35`).
3. **First-language explanation is the differentiator**, and it is a core-offer requirement, not an upsell: *"Native-language instruction belongs in the core offer; it is not a premium surcharge"* (`:62`).
4. **"Working locally" is the acceptance target** — a complete SaaS running on this machine, ahead of any hosting question.

**One assumption, flagged.** The relocation PR records an unresolved question: *"Ron subsequently requested a working local model with all bells and whistles. Clarification is pending whether that means the complete local application, on-device AI or both"* (`handoff/ron-agent/WORKSPACE-RELOCATION-PR.md:11`). This plan assumes **the complete local application with provider stubs**; on-device or live AI is **not** required for the local milestone and remains unauthorized pending R10. If that reading is wrong, §7 reorders.

---

## 1. The product

An online service where a learner preparing for a standardised exam gets the exam's own tasks, server-marked, with every requirement, criterion and mistake explained **in the learner's own language**.

Four axes stay independent (`PILOT_BUILD_PLAN.md:58`):

| Axis | Meaning | First instance |
|---|---|---|
| Exam package | task types, item counts, timing, keys, weights, rubric, thresholds | telc Deutsch B1 written |
| Exam language | the language the learner answers in | German |
| Instruction language | the language explanations are written in | de/en/uk/ar/tr (`:62`) |
| Purchasing market | currency, price, allowance, term | unvalidated (`:74`) |

The commercial hypothesis on record is a direct-to-learner, fixed-duration exam pass initially tested as an eight-week term (`:31`), with a regional price catalogue by market, exam package, pass duration and allowance (`:64`). **None of that is in the local milestone.**

### Architecture now in force

**Docker-only execution (Ron, 1 October 2026):** the server stack is started with Docker Compose. The separate host Node setup and local installer are retired by DOCKER-ONLY-01. This does not delete existing database volumes or authorize deployment. See [DOCKER-ONLY-01.md](work/implementation/DOCKER-ONLY-01.md).

**The API is the product and the whole stack runs in containers.** The client is thin: it holds no
state, no provider key and no grading logic, and it submits a reference and receives a result.

**A single-user app's integrations cannot be adapted, because the assumption they were built on is
gone.** In a single-user app an integration is a convenience the local user configures; in a
multi-user app it is a shared, costed, owner-attributed resource that must be bounded, reviewable and
revocable per account. The full mapping is in [INTEGRATIONS-01.md](work/implementation/INTEGRATIONS-01.md);
the rules that follow are: no integration call without an owner, without an allowance check and a
ledger row, without being asynchronous when it costs money, without pooling its output, and none of
it configurable from a learner session.

**Generated content is pooled, not generated per learner.** Cost scales with pool size instead of
with usage, and a finite set can be reviewed where an infinite stream cannot. See
[CONTENT-POOL-01.md](work/implementation/CONTENT-POOL-01.md).

---

## 2. The immediate objective: a working multi-exam SaaS application locally

There are two local milestones, and the objective needs both. LM-1 makes the **product** work locally; LM-2 makes the **platform** work locally. A single-exam local app would satisfy neither the multi-exam framing nor the claim that a second exam is additive.

**LM-1 — the product works locally.** On this machine, with PostgreSQL available, one documented sequence brings the product up — disposable database, migrations applied by the migration command only, the telc B1 written package seeded, API and worker running, provider/email/payment as stubs — and a learner can:

> register with an invite → sign in → set exam date and explanation language → see the servable task list → answer reading and language-element items marked **on the server** → write and submit a response → leave → return **on a fresh browser profile** to the exact saved text and saved feedback **with a first-language explanation** → revise → see factual history → export → delete the account.

**LM-2 — the platform works locally.** A second exam package (PILOT-11) completes the same journey through the same code, with **no change to application source** and **no migration of learner data**. That is what makes the result multi-exam rather than a German app, and §6 exists to keep this cheap: if the exam-scoping seams land *after* the client is written, LM-2 becomes a rewrite instead of a content pack.

**Evidence standard for LM-1 and LM-2** (executed output, never a claim):

1. `node tools/journey-api-check.mjs` reports **0 failed**, and every leg that is not yet implemented prints `PENDING <slice>` and **does not count as a pass** — the counter already behaves this way, which is why it is the programme's measure of "functional".
2. A browser run of the same journey on a fresh profile, on desktop and a 390 px viewport, with the old client retired from `/`.
3. The bring-up sequence executed from a clean state, including a deliberate failure leg: missing configuration exits non-zero **before** `listen()`.
4. **LM-2 only:** the second exam's legs run the same assertions against the same runtime, and a check proves the first exam's learner records are untouched by the second exam's presence — the pairing that fails if exam identity leaks into global keys (§6).

Both are *functional* milestones on stubs. They close no human gate and establish no exam validity, model quality or production readiness.

---

## 3. What exists today, verified at `59b1929`

The platform substrate is real, and it is why a local milestone is reachable at all.

| Capability | Where | State |
|---|---|---|
| Owned auth: `scrypt:<salt>:<hash>` passwords, `timingSafeEqual`, server-side sessions, cookie | `server/owned-postgres/sessions.mjs:26-39,77-82` | Works. Cookie is `HttpOnly; SameSite=Lax` with **no `Secure`**; no rotation, expiry sweep, verification or recovery (`accounts.mjs:20-22`) |
| Six restricted PostgreSQL roles, `NOINHERIT NOSUPERUSER NOBYPASSRLS`, connection limit 10 | `server/owned-postgres/provision.mjs:88,203` | Works |
| `ENABLE`+`FORCE ROW LEVEL SECURITY` and owner policies on all seven owned tables | `server/migrations/0003-isolation.sql:25-76` | Works |
| Migrations applied only by `server/migrate.mjs`, sha256 ledger, tamper refusal, runtime never migrates | `migrate.mjs:10-12,29-42`; `provision.mjs:216-222,267-305` | Works |
| Worker: `FOR UPDATE SKIP LOCKED` claim with `lease_token`/`lease_until`, lease-fenced completion, expired-lease reclaim, one debit, `tries < 3` | `server/owned-postgres/worker.mjs:107-120,153-191,205-232` | Works. A real child-process worker was proven end to end (journey leg J7) |
| Versioned, immutable, shared-content tables carrying rights/review status | `server/migrations/0006-content-and-catalogue.sql:2-37,86-103` | Exists — **writing-only and not exam-scoped** |
| Journey harness as the functional counter | `tools/journey-api-check.mjs` | **5 passed, 6 pending, 0 failed** |
| Offline regression baseline | `tools/check.js`, `writing-check.js`, `feedback-check.js` | 101 / 9 / 14 |
| Table-class guard: an unclassified table fails | `tools/table-class-check.mjs` + `tools/lib/catalogue.mjs:20,23,30` | Works: 18 tables, 0 failures |

**Content on hand:** 24 objective sets / 180 keyed slots / 6 writing prompts, each slot carrying an inline German `why`; **0 tracked audio files**, so the 9 listening sets are unservable (`docs/content/DISCOVERY.md:89`). No `data/*.json` file carries `rights_status` or `review_status` — governance exists only as database columns, and every seeded row is `unreviewed` / `unknown`.

**What does not exist yet — each of these is on the path to LM-1 and LM-2:**

| Missing | Consequence |
|---|---|
| `server/runtime.mjs` — runtime composition. **PR #89 is unmerged** and its last commit is `ARCHIVED UNVERIFIED` | The server still builds its API through the fixture path |
| Removal of local single-user mode; the legacy routes are still live when accounts/SaaS are off | Two runtimes exist; `/api/config`, `/api/progress`, `/api/ai` still serve the file/env/provider path |
| `GET /api/v1/tasks` | No learner can discover a servable task; the seeded catalogue is unreachable from a client |
| A server-side objective marking route | Reading/language-element answers cannot be marked authoritatively |
| Any audio asset model, and any audio file | Listening cannot be served at all |
| `public/app/` | No new client; the old SPA is still the entry point |
| `SETTINGS_LANGUAGES` is `Object.freeze([])` (`settings.mjs:41`) | Any ≤16-character string is accepted as an explanation language — the "supported enum" the design record assumes does not exist |
| Email port, pricing/entitlements, checkout | Later, and gated |

**Known landmines** — verified, and each could waste a slice:

1. **A CRLF checksum trap.** `server/migrations/MANIFEST.json` digests match **LF-normalised** bytes, but `provision.mjs:120-121` hashes **raw** bytes and every file in this checkout is CRLF. A checksum comparison against the manifest therefore differs for **all six** migrations. `MANIFEST.json` currently has no code reader at all. This is the defect class that once let a discrimination leg silently no-op.
2. **`0004`'s owner policy is missing its `TO` clause** (`0004-account-settings.sql:14-17`), so unlike `0003`/`0005` it applies to `PUBLIC`.
3. **The fixture worker has no lease fence** (`fixture.mjs:110-133`) while the real runner does. A lease leg run against the fixture proves nothing about the runner.
4. **`verification` is touched by no code** (`0001:7`; comments only).
5. **The fixture does not execute the real migration files.** It applies the two spike SQL files, then `0003` rendered, then generated SQL (`bootstrap.mjs:110-121`). A green fixture run is not evidence that `0001`–`0006` apply as written.

---

## 4. The differentiator: explanations in the learner's language

This is the feature Ron named, and the pilot plan already constrains it correctly (`PILOT_BUILD_PLAN.md:52,58,60`): *"Native-language explanations support understanding; the task evidence remains in the exam language"*; *"generate translated explanations from the saved assessment rather than silently regrading an attempt"*; *"Distinguish assisted attempts from mock evidence when reporting readiness."*

**Rules that make it honest and affordable:**

1. **Explanations are derived from the saved assessment, never a second grading pass.** Reopening a result or switching language must not produce a new grade (`:58`).
2. **The language is snapshotted on the job at submit.** Changing the setting later re-renders explanations from stored evidence; it never regrades.
3. **Each explanation is versioned content keyed by (task/rubric version, criterion or item, language)** — not a per-request model call. This is the load-bearing design decision: it makes quality reviewable once per language instead of once per view, makes cost one-time instead of per-render, makes results deterministic, and lets speech synthesis reuse the same bytes.
4. **Review status is per (item, language) and visible.** The ladder is `unreviewed` → natively reviewed, surfaced as a plain label; the MFP's `Übungsfeedback – keine telc-Bewertung` treatment generalises to a "not natively reviewed" label for any language. C-06 stays open until a native speaker signs a language.
5. **A missing or failed explanation is not a grade.** A pending or failed assessment stays explicitly unassessed, with the learner's text preserved.
6. **Exam material is never translated.** Only the explanation layer moves. The retired plan's "German chrome" invariant is superseded by the pilot plan's four-axis rule: the *interface* language may follow the learner, but the **exam text must not**.

**Where it plugs in:** the worker already carries `task_version`/`rubric_version` on the job and stores `model_version`/`prompt_version`/`rubric_version` on the assessment (`worker.mjs:124,138-139,166-168`). The explanation entity is a sibling of `assessments`, not a rewrite of it.

---

## 5. Speech synthesis — the permitted roles, and the one that is forbidden

The repository's rule, stated twice, and both are correct:

- `IMPLEMENTATION_PLAN.md:227` — *"Reading a transcript or playing browser-generated speech is not a substitute for a listening assessment."*
- `IMPLEMENTATION_PLAN.md:148` (gate C-04) — *"no browser-TTS substitution"*, for fixed versioned listening recordings.

**That is an exam-fidelity rule, not a ban on synthesis.** A scored listening item must present native pronunciation, exam pacing and the published play counts (`PILOT_BUILD_PLAN.md:46`); synthetic speech cannot supply those, and pretending otherwise is precisely the dishonesty this programme refuses.

| Use | Verdict |
|---|---|
| Reading an explanation, hint or feedback aloud | **Permitted** — accessibility for the differentiator itself |
| Pronouncing an exam-language word, phrase or example | **Permitted**, as a study aid |
| Guided-practice hints | **Permitted**, labelled as assistance |
| Any scored listening item, diagnostic or mock listening section | **Forbidden** — needs fixed reviewed recordings and C-04 |
| A "generated examiner voice" | **Out of budget** (`PILOT_BUILD_PLAN.md:72`) |

**Implementation constraints to decide.** `public/js/speech.js` already drives the Web Speech API (`:14,175-190`) with a German-only voice filter (`:23`) and a German-only voice picker (`ui.js:892-916`). Browser voices for **uk, ar and tr are uneven or absent**, which would make the differentiator work for German learners and silently fail for exactly the learners it exists to help. Server-side synthesis is consistent but is a paid processor (P-03) with a per-play cost. **Recommendation: browser synthesis first, with an explicit "no voice available for this language" state and never a silent fallback to German** — and decide server TTS only after measuring real voice availability.

---

## 6. Exam packages: lock the seams now, build the second exam later

**Do not build the second exam yet. Do make identity exam-scoped, so adding one is additive rather than a migration of learner data.**

The codebase has **no exam entity at all** — a repo-wide search for `exam_id|examId|exam_slug|examSlug|exam_code` returns **0 matches**, and `learner_settings` carries only a free-text `exam_date` (`0004:4`). The concrete couplings:

1. **Content/rubric/task primary keys are global.** `content_version_id`, `(task_id, version)` and `(rubric_id, version)` cannot hold two exams' `writing.formative@v1` (`0006:2-37`). The `family` column (`:5,15,25`) is unconstrained text that nothing reads as an exam key.
2. **The blueprint is a module singleton** (`public/js/blueprint.js:15-105`): `TOTAL_POINTS`, `WRITTEN`, `ORAL`, `GROUPS`, `PARTS`, `SUBTEST_ORDER` and `NODE_WEIGHTS` are constants consumed directly by `engine.js:16` and `exam.js:22`. Part ids are **global and persisted** in progress keys, so `LV1` in two exams collides.
3. **Scales are hardcoded to telc's**: pass `written ≥ 135 AND oral ≥ 45` (`engine.js:262-266`), grade bands 90/80/70/60 (`:270-276`), `objectiveMax = 180` (`mock-outcome.js:118`).
4. **Client state is exam-branded**: `b1prep.state.v1`, `b1prep.scope.v1`, `X-B1Prep-Account` (`store.js:18,25,30`).
5. **Static identity is not data**: `index.html:6,7,44`; `dashboard.js:94`.

**Minimum additive change for PILOT-04:** an `exam_package` row with a stable id; `exam_id` + `level` + `exam_language` columns on `content_version`, `rubric_version` and `task_version`, with slugs prefixed by exam; the blueprint loaded per exam rather than imported as a singleton; and per-exam namespacing of persisted progress keys. The pilot plan's own target records already name `exam_packages`, `rubric_versions`, `content_versions`, `content_assets`, `products`, `market_prices`, `orders` and `entitlements` (`PILOT_BUILD_PLAN.md:172-177`) — that list plus an audio asset model is the target schema.

**A rights and trademark constraint that is easy to get wrong.** Exam boards own their item banks and their marks. *"Use public or licensed material to understand the blueprint and create original reviewed practice; a public download is not blanket permission to republish a question bank"* (`:54`). Naming a third-party exam and teaching its format is normal; reproducing its items is not. Every exam package needs its own `rights_status` provenance from the first row, and an `unknown` default must keep serving nothing.

---

## 7. Delivery order

Ordered to **LM-1 and LM-2**. The state column is what is true at `59b1929`.

| Slice | Purpose | State | Depends on |
|---|---|---|---|
| **PILOT-01** | Historical host bring-up; launcher and checker retired by DOCKER-ONLY-01 | **Retired** — earlier 10/10 is historical only | — |
| **PILOT-01b / DOCKER-ONLY-01** | Docker Compose is the supported server launcher: db → migrate → app + worker; persistent volume; explicit runtime build context | **Under review** — see DOCKER-ONLY-01 for executed evidence | — |
| **PILOT-01c** | **The page surface is auth-gated.** Before it, `GET /` served the app and `GET /data/seed.json` served **180 answer keys** to anyone. Public is only `/signin`, `/assets/design/**`, `/api/auth/**` and liveness | **Delivered** — 8/8 legs, not reviewed, not merged | PILOT-01b |
| **PILOT-02** | **Runtime composition**: the server builds its API from `server/runtime.mjs`; sign-up provisions entitlements/settings through a `SECURITY DEFINER` function; the runtime opens **no** admin or migration pool. This is the unmerged PR #89 work, which must be re-verified rather than assumed | `74fb158`, **unverified** | PILOT-01 |
| **PILOT-03** | **One runtime**: either removed flag present → refuse to start; required config missing → exit non-zero before `listen()`; `createServer()` defaults to not-ready; `/api/config`, `/api/progress`, `/api/ai`, `/api/ai/test` answer **404**; bind host from config | Planned | PILOT-02 |
| **PILOT-04** | **Exam-scoped identity** (§6) + `GET /api/v1/tasks?exam=&family=` honouring a serving policy (`approved` fail-closed, or `approved+unreviewed`). Every seeded row is `unreviewed`, so serving under `approved` must return an **empty** list — a check that always returned six rows would be wrong | Planned | PILOT-03 |
| **PILOT-05** | **Objective package served and marked on the server**: LV1–3 and SB1–2 (15 sets, 180 keyed slots) as task versions; keys in a table granted to **no** runtime role; marking through `SECURITY DEFINER`; answer and `why` revealed only after submission | Planned | PILOT-04 |
| **PILOT-06** | **Writing → worker → validated feedback**: task binding, server-owned prompt and rubric, structured-output validation, one debit, honest unassessed failure. The substrate already works (leg J7); it needs the catalogue binding and **R11** resolved before the result schema is fixed | Partly built | PILOT-04 |
| **PILOT-07** | **First-language explanations** (§4): the explanation entity, generation from the saved assessment, versioning by (task/rubric, criterion, language), review labels, and the snapshot rule | Planned | PILOT-06 |
| **PILOT-08a** | **The design foundation**: the supplied design curated into the repository — `public/assets/design/` (tokens, fonts, logos, OFL notices) and `work/design-reference/` for reading. `.gitattributes` keeps the pinned bytes intact through a clone. See [PILOT-08A.md](work/implementation/PILOT-08A.md) | **Delivered** — 6/6 legs, not reviewed, not merged | PILOT-01c |
| **PILOT-08** | **The new client** under `public/app/`. **Shell delivered** — it replaces Certa at `/`, on the curated design system, with settings and honest empty states. Still missing: task list, objective runner, writing, result with explanation, history, each blocked on PILOT-04/05/06/07. See [PILOT-08.md](work/implementation/PILOT-08.md) | **Partly delivered** — 5/5 legs, not reviewed, not merged | PILOT-05, 06, 07 |
| **PILOT-09** | **Speech synthesis** for explanations and pronunciation (§5), with a real per-language availability state | Planned | PILOT-07, 08 |
| **PILOT-10** | **Listening package**: audio asset model with rights/checksum/duration, plus fixed reviewed recordings, play counts and failure recovery. **Gated on C-04**; TTS is not a substitute | Blocked | C-04 |
| **PILOT-11** | **Second exam package** — a small English reading pack. Delivers **LM-2**: the same journey through the same code, with no source change and no learner-data migration | Planned | PILOT-05, 08 |
| **PILOT-12** | **Account lifecycle**: export, hard delete, retention, late-job-after-deletion. Largely built (`DELETE /api/v1/account`; `ACCOUNT_DELETION_STEPS` at `adapter.mjs:228-240`) | Mostly built | PILOT-08 |
| **PILOT-13** | **LM-1 + LM-2 acceptance run**: two learners, fresh browser, stale writes, duplicate clicks, account switching, slow/failed/malformed provider output, and a late job after deletion | Planned | PILOT-12 |
| **PILOT-14** | **Canonical, platform-independent migration digests.** `applyMigrations` hashes the working tree's **raw bytes**, so the ledger is a function of the checkout's line endings: a database migrated from a Windows checkout refuses to advance from a Linux clone with *"refusing to apply a migration that is not the one that was reviewed"* — a false tamper alarm. A fix must accept the legacy digest for rows already applied, never rewrite them | **Defect, measured, not fixed** | — |
| **PILOT-15** | **The content pool** ([CONTENT-POOL-01.md](work/implementation/CONTENT-POOL-01.md)): `pool_spec` + the deficit loop, batched generation off the request path, dedup by `content_sha256`, explanations cached per `(item_version, language)`, and generation provenance. Provable against a **stub generator** under R10 | **Proposal — needs two decisions** | PILOT-04 |
| **PILOT-16** | **The multi-user integration layer** ([INTEGRATIONS-01.md](work/implementation/INTEGRATIONS-01.md)): inference, speech, email, payments and object storage behind one port each, owner-attributed, allowance-bounded, ledger-debited, stubbed for development. The data ports already prove the pattern; this is the external half | **Proposal — needs R5/R10 and owner authorization** | PILOT-06 |

**Not yet, and each has a named blocker:** commercial checkout and market pricing (P-01/P-02/P-03 plus owner authorization); any hosting, DNS, TLS, email provider or payment configuration; live model calls (R10); on-device or embedded AI; speaking and STT (outside the pilot); a full written mock (needs reviewed content, timing and playback rules for every included section); institutional or teacher features.

**Next integration order.** Review DOCKER-ONLY-01 and the current shell/auth findings, then re-verify PILOT-02 runtime composition. Complete PILOT-03 before dependent PILOT-04 implementation; exam contract design may proceed independently. The retired host launcher is no longer an acceptance path.

**Conventions carried forward from the retired plan, because they earned their place:** one writer per shared file; a check that fails on the base before the fix; push after every step and commit the checker **early even while it is failing**; a check that never completes is not evidence; when a check fails, suspect the check first; record the discrimination leg and not just the pass; set a record's status to what is true.

---

## 8. Decisions needed

| # | Decision | Blocks | Default if unanswered |
|---|---|---|---|
| **D1** | **Content rights (R1):** who wrote the 6 writing prompts and the 15 Lesen/Sprachbausteine sets, and does Hatoove own them? One line per source is enough; it becomes `rights_status` | Everything servable. Every seeded row is `unknown`, so production serves **nothing** | Fail-closed; nothing servable |
| **D2** | **Review policy (R2):** for an invite-only pilot, may learners see content labelled `unreviewed`, or must a qualified reviewer approve each prompt first? | PILOT-04's policy value, PILOT-13 | `approved` only |
| **D3** | **Is objective practice in the first product (R3)?** The pilot plan says yes and puts reading and language elements in the written offer; the retired plan made them conditional | PILOT-05's priority | In scope, per the pilot plan |
| **D4** | **Rubric contract (R11):** a separately versioned three-criterion contract (Aufgabenbewältigung, Kommunikative Gestaltung, Formale Richtigkeit — bands 5/3/1/0, ×3) or honestly labelled provisional four-criterion internal feedback (15/10/12/8)? Never renormalise between them | PILOT-06's result schema | Blocks the final schema |
| **D5** | **Auth library (R4):** adopt Better Auth (measured workable; ends "the root app is dependency-free" **for the server scope**) or harden the existing session port? The spike recommends adopting; the current port has no rotation, expiry sweep, revocation or recovery | Production auth. Not needed for LM-1 | Hardening only |
| **D6** | **Email provider (R5)** for reset and verification, or operator-assisted resets for the pilot? It is a data processor for P-03 | Recovery flows | Build against the stub |
| **D7** | **Pilot access and allowance (R6):** invite-only, how many invites, how many feedbacks each? `/api/auth/sign-up/email` currently has no verification, no invite check and no throttle | Abuse control | Invite-only |
| **D8** | **Speech-synthesis scope (§5):** browser-only with honest unavailability, or server-side TTS (paid processor, per-play cost)? | PILOT-09 | Browser-first |
| **D9** | **First English exam target**, and confirmation that we teach its *format* with original items rather than reproducing any board's bank | PILOT-11 | telc first only |
| **D10** | **Live model calls (R10):** when may the worker call a live provider for real learners? | Real feedback quality | Stubs only |
| **D11** | **"Working local model"** (`WORKSPACE-RELOCATION-PR.md:11`): the complete local application with stubs, or also on-device AI? | §0's assumption and PILOT-01's definition | Complete local app, stubs |

---

## 9. Release gates still open

Content rights and qualified exam/native-language review, security/privacy/legal review, real iPhone/Android keyboard/touch/recovery evidence, operations and explicit production authorization. Audio-device evidence becomes relevant when listening enters scope (PILOT-10). **No sample design, green CI run or passing stubbed journey approves any of these gates.**

---

## 10. Supersession record

`work/implementation/FUNCTIONAL-ROADMAP.md` — the writing-first minimum functional product — was **removed** in this change at Ron's instruction. It is fully recoverable:

```
git show 626c126:work/implementation/FUNCTIONAL-ROADMAP.md
```

**Removed:** the MFP-00…MFP-14 slice order, and with it the deferral of objective practice, listening, the study plan and the broader client to "after MFP-12".

**Kept, because it is evidence for code still in the tree rather than a plan:**

- `work/implementation/MFP-*.md` — the per-slice records: what was built, its counters, its limits.
- `work/implementation/RETIRED-CHECKS.md` — the retirement ledger.
- `work/implementation/MFP-DESIGN-DECISIONS.md` — the design/state acceptance matrix, R11/R13–R16, the font-coverage and RTL findings, and the 22 verified design hashes. Its findings remain valid; its slice IDs no longer order the work.
- `tools/journey-api-check.mjs`, `table-class-check.mjs`, `migrate-check.mjs`, `worker-wire-check.mjs` — the checks, which measure the product rather than the plan.

**Governing references corrected in this change:** `AGENTS.md`, `PILOT_BUILD_PLAN.md`, `IMPLEMENTATION_PLAN.md`, `docs/AGENT_WORKFLOW.md`, `work/implementation/MFP-DESIGN-DECISIONS.md` and `work/implementation/DESIGN-WIRE-01.md`. Two factually stale lines in `PILOT_BUILD_PLAN.md` were corrected in the same pass: the OneDrive development-checkout path (`:80`) and the claim that the repository has no commits (`:90`).

**Deliberately left alone:** historical records that cite the removed file — slice records, the auth spike, tool comments. They record what governed at the time, and rewriting them would falsify the history.

---

## 11. Boundaries that do not move

No deployment, DNS, live payments, live email, OAuth, invitations, new production access or live AI. **Synthetic data and provider stubs only.** `D:\B1_Prep` remains a live install: only its `design` folder may be **read**, and nothing in that tree may be modified. No live data migration and **no data deletion**; existing learner records are preserved; obsolete objects go by **forward** migrations after their consumers are mapped. Human gates **E-01, C-04, C-06, P-03/X-01** and real-device evidence stay open. Issue #63 is **not** a production-security approval. A 390 px emulated viewport is not a phone.

Additional rules this plan makes load-bearing, because the new direction needs them:

- **An exam's items are not ours to copy.** Blueprint and format, yes; another board's question bank, no.
- **Similar levels are not interchangeable exams.** One exam's tasks, timing and rubric never stand in for another's.
- **Four internal criteria are never relabelled as telc's three**, and no score is ever renormalised between them.
- **Synthetic speech never substitutes for a listening assessment** (§5).
- **No pass prediction, readiness score or whole-exam claim** while any included section is unassessed.

---

## 12. Coordination and evidence

The appointed coordinator owns live dispatch, integration order and CURRENT updates. Preserve the global active-agent slot cap and single-writer boundaries; this plan creates no new worker allocation and renews no lease. Each dispatched slice still needs one owner, an execution ID, an exact base, allowed paths, acceptance evidence, a checkpoint and an expiry. `Planned`, `delivered`, `reviewed`, `CI green`, `integrated`, `merged to main` and `accepted` remain distinct states. [#63](https://github.com/ronslink/hatoove/issues/63) is the SaaS audit **issue**, not a pull request. Integration continues through pull requests; never force-push `main` or rewrite another worker's branch.

---

## 13. Limits of this document

- **Nothing in this plan was executed against PostgreSQL or a browser while it was written.** The substrate claims in §3 rest on the migration SQL, the modules and the checkers as read, plus counters recorded by the previous session. They remain a reading until PILOT-01 and PILOT-02 re-run them.
- **`59b1929` contains no `node_modules`** at any level and no `server/runtime.mjs`; the tree cannot yet be run as it stands.
- **PR #89 (`74fb158`) is `ARCHIVED UNVERIFIED`.** Four files were rescued by hand from an ended run and **no check has ever been run against that state**. Treat every claim in it as unverified.
- **No effort estimates are given, deliberately.** The retired plan's "15–17 engineer-days" was calibrated on a narrower product than the pilot plan describes, and re-using it would be false precision.
- **The relocation is not fully verified either.** It reports 10,311 copied files size/hash-verified, 22 design hashes preserved and seven archive refs, with **no application, browser or device tests** run for it. `.qa/migration/20261001/` is recovery evidence and must stay out of commits.
- **One stale record was found and not fixed:** `docs/exam/LEGACY-GAP-MAP.md:80-82` cites defects G1/G2 at `exam.js:1484` and `:1497-1498`, which the current tree no longer contains. It should be closed or re-anchored.
- **The folder name is fixed.** The canonical workspace is `D:\Hatoove`, matching the website. The 1 October relocation created `D:\Hatoover` (the correct spelling plus a trailing `r`) because an earlier clone of this repository held the right path; that clone was deleted and the workspace renamed on the same day. `D:\Hatoover` no longer exists, and only untracked historical handoff records still carry the old spelling.

---

## Appendix — historical merged-slice evidence (retained)

This table records earlier integration history. It does not restore superseded requirements, close a whole package or certify the current candidate. It is carried forward verbatim from the previous master plan because it is the record of what was actually merged.

| Slice | Merge | Evidence |
|---|---|---|
| F-01 baseline, source guard, Linux/Windows CI | — | 124-check baseline recorded |
| Worker capability: OpenClaw Git handoff, Hermes bundle handoff, one bounded Hermes child | #3, #4, #6 | PRE-02/03/06 exercises |
| F-03 auth/runtime + pilot contracts | #11 `a9a4cfd` | 12 scenarios / 13 runner checks |
| F-02/A-01 local SQL least-privilege isolation | #18 `a58f6fb` | 10 scenarios / 11 runner checks; four runtime/bootstrap roles, immutable submissions, atomic enqueue, one debit after saved assessment, deletion tombstones |
| F-04 / PILOT-01 CSS bounding | #12 `bb30267` | **Only D5/D6 reproduced and changed.** D2/D3/D8 were false positives; 200% zoom filenames unreliable as proof |
| C-01 discovery | #20 `a9ed166` | `7e24229`: 24 sets / 180 slots / 6 writing prompts, **0 tracked fixed audio**, rights/review unknown |
| Master-plan alignment | #22 `074aebf` | plan + board + discovery |
| Integration stack (USER-03 + USER-04) | #35 `82ae9c2` | 13 files added, 6589 insertions, **0 deletions** — a real three-way merge, not a hand rebuild. PR #33 (hand rebuild) rejected by independent review and retained as the rejection record |
| F-1 origin/authorization gate | #38 `9c57ffd` | `server-origin-check.mjs` 16/16; the reviewer's own probe showed pre-fix `82ae9c2` returned 200 **and rewrote the env file**, fixed head returns 403 `origin_rejected`; 14 bypass classes, 78 assertions, zero bypasses |
| Owned client transport | #41 `de4ecb6` | `owned-client-check.mjs` **31/31**; generation fencing holds even when the transport ignores `AbortSignal` |
| F-2 reset actually deletes | #42 `675a3f6` | `reset-check.mjs` 9/9; independent review then found the **in-flight-save race** |
| F-3 AI disclosure | #44 `0ee7e13` | learner-facing copy; flagged for human C-06 review |
| SEC-02 race correction | #45 `258f200`… | `progressEqual` compared `JSON.stringify` against a differently-ordered `mergeProgress` output, so identical records compared unequal and the server shipped a full payload on **every** POST |
| F-2 race: revision fence | #47 `8a71f71` | `revision-check.mjs` **8/8 including pre-fix discrimination**; a `DELETE` now invalidates older in-flight writes with `409 stale_revision` |
| OWNAPI-01 owned API | #48 `2974359` | `owned-api-check.mjs` **24/24** driven by the real client over real HTTP |
| F-7 key exposure | #50 `616e1e5` | `keymask-check.mjs` **12/12**; pre-fix disclosed exactly **5 runs of ≥3 key characters**, fixed discloses none |
| F-8 account name | #46 `fa53e30` | machine paths and OS account name removed from tracked docs |
| PM-01 `progressEqual` | #49 `2f892d2` | `progress-equal-check.mjs` **10/10** with pre-fix discrimination |
| **DRAFT-SESSION-01 draft service** | **#51 `c8bf97a`** | 4 files added, **0 deletions**, `exam.js` byte-identical; checker **17/17**, tests **21/21**; **independent review: accept-with-notes, no blocking defect** |
| **OWNAPI-02 PostgreSQL adapter + RLS evidence** | **#52 `5a63429`** | own package scope (`pg` 8.23.1) so the root app stays dependency-free; coordinator ran the proof on real PostgreSQL — **6/6** isolation tests and **24/24** the same suite on the pg backend; **discrimination proven by mutation** (granting the learner role `BYPASSRLS` makes it fail with "leaked a cross-owner row") |
