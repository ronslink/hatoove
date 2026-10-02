# SAAS-MODEL-01 ALIGNMENT — the coordinator's response to the architect review

| | |
|---|---|
| Why | Ron: *"ask claude to help recommend changes to get this aligned with the master plan."* Claude produced an independent architect review of the API strategy and schema. **This is my response to it: what I accept, what I reject, what changed, and what now needs Ron.** |
| Review | [`SAAS-MODEL-01-RECOMMENDATIONS-claude.md`](SAAS-MODEL-01-RECOMMENDATIONS-claude.md) — 244 lines, base `20f8943`, repository left byte-identical |
| Gap doc it critiques | [`SAAS-MODEL-01-GAP.md`](SAAS-MODEL-01-GAP.md) |
| Base | `codex/integration-01` @ `df1924a` |
| Status | **Four of my claims were wrong. Two live defects were found. Neither is a documentation problem.** |

---

## 1. The review earned its place: it measured, and it disagreed

It found **four material errors in my gap analysis**, and it did not stop at reading — it wrote probes and ran them.
Two of its findings are **live defects in the hosted runtime that were on nobody's queue.**

**I reproduced the most serious one myself before acting on it**, because a claim in a review is not evidence on
this programme. `tools/coord-config-anon-probe.mjs`, a real server process over real HTTP with `B1PREP_SAAS=1` and
**no cookie at all**:

```
POST /api/config {"examDate":"2099-01-01"}
  -> 200 {"ok":true,"examDate":"2099-01-01","saved":["EXAM_DATE"]}
the env file was rewritten:            EXAM_DATE=2099-01-01
GET /api/config (still anonymous)
  -> 200 {"examDate":"2099-01-01"}
control, GET /api/v1/account anonymous -> 401
```

**An anonymous same-origin caller rewrites the machine-global `EXAM_DATE`, and every visitor to the installation
then reads it.** The learner route one line away refuses correctly; this one never consults identity.

Two things make it worse than it looks, and both are verified, not reasoned:

- **`saveEnv` writes any key it is handed** (`server.js:220-244`, including `process.env[k] = v` at `:239-242`), and
  the D1 provider refusal at `:933` blocks only three **field names** — `['apiKey','baseUrl','model']`. So the control
  that closed the key disclosure is a name check on an unauthenticated route, one careless edit from being lost.
- **A check asserts the defect as a pass:** `tools/saas-runtime-check.mjs:676-680` expects `200` from
  `POST /api/config` in a ready hosted runtime.

**The second live defect: open sign-up plus a session-gated but unmetered LLM proxy.** I verified the halves
separately: `/api/ai` requires a session in hosted mode (`server.js:749,954`), sign-up needs no verification or
throttle (`owned-api.mjs:271-275`), and **`grep` finds no rate limit, quota or throttle anywhere in `server.js`**.
So anyone can create an account and send arbitrary prompts up to 256 KB to the operator's key, outside
`usage_ledger` because it is not a submission.

**Both are hours of work and depend on nothing.** They are dispatched as `CONFIG-ANON-01` (running) and `AI-METER-01`
(next), **before** any further schema work.

---

## 2. Where my gap analysis was wrong — recorded, not quietly edited

| My claim | The correction | Consequence |
|---|---|---|
| *"Seed the content/task records from `data/seed.json`'s writing prompts"* | **`seed.json` has no writing prompts.** It holds 8 objective families (24 sets, 180 keyed slots). The 6 writing prompts are JS constants in `public/js/ai.js` (`OFFLINE_WRITING_TASKS`) | The seed source changes. **`SAAS-MODEL-01a` found this independently and seeded from the real source, with a drift check that re-imports `ai.js` and fails on divergence** |
| *"Content is client-loaded, unversioned files"* | **Worse: the primary path is runtime LLM generation in the browser**, and the seed files are only the *fallback* (`ai.js:669-699`, `:786`) | **A product consequence nobody had put in front of Ron** — see §3 |
| *"Option A: the 554 KB becomes rows"* | **Only `seed.json` is assessed content.** The eight reference guides are not tasks and gain nothing from task versioning | Scope the migration to assessed families |
| *"~12 owned routes vs 14 screens"* | **~20 owned routes.** Practice, review, plan and progress each need two or three, and `GET /api/v1/export` has no route at all despite the plan requiring owned export | The route contract is roughly twice the work I sized |

**And one of its findings is a defect in the deployed server that I had not noticed at all:** the *production*
runtime is assembled from the **test fixture module** (`accounts.mjs:73-94` → `createPostgresWorld`), which keeps a
**superuser `admin` pool open at runtime** and runs migrations **at every server start** from the runtime process.
Migrations `0001`–`0003` are read from `spikes/`, whose own header says *"Synthetic spike records only"* and
*"No production runner"*, and the ledger records **id only — no checksum**. So **"production auth" is a
runtime-composition problem as well as a library choice.**

---

## 3. THE THREE THINGS THAT NEED RON — and the first one is urgent

### 3.1 After retirement, how much objective practice is left? *(product decision)*

Once the generic LLM proxy is gone — which the plan requires — and tasks must be **reviewed and versioned**, the
objective practice available is **the human-reviewed subset of 24 sets** (8 parts × 3), because that is the only
content with keys that exist outside the browser. **C-01 already recorded that rights and review status are
`unknown` for most of the corpus.**

Either the pilot accepts a **small reviewed bank**, or **server-side generation into a review queue**
(`content_review` status `unreviewed`, served only where deployment policy allows) becomes a dependency of
`DESIGN-04`. **This is the single most consequential open question, and it is not an implementation detail.**

### 3.2 Do client-computed drill results count toward displayed progress? *(product decision)*

The plan says *"do not trust browser-computed grades."* Applied literally, the adaptive engine, the SRS and the
streaks lose their input, because drills from `generators.js`, vocabulary cards and self-graded review **cannot be
server-marked — the server never saw the item.**

The review's proposal, which I accept and am putting to Ron: record them with an explicit
`authority: 'self_reported'`; let them drive **personal scheduling** (weak-tag priority, SRS due dates); **exclude
them from every displayed score and denominator.** Only `server_marked` rows produce accuracy figures. That keeps
the behaviour learners rely on without turning a client-forgeable number into a claim. **If Ron disagrees, the
alternative is losing the adaptive engine's input, and that should be a decision rather than an accident.**

### 3.3 Production auth: three facts before choosing *(needs a spike and then Ron)*

The review's key insight changes the shape of this: **the schema already IS Better Auth's**
(`auth-schema.sql`, migration `0001`), and Better Auth 1.7.6 was pinned and exercised in the PR #11 spike. So the
real fork is **adopt the library we already modelled** versus **harden the stand-in** — not library versus bespoke.

I accept its recommendation of **adopt, conditional on three facts** that a disposable spike can settle cheaply:
does Better Auth 1.7.6 verify a `sessions.mjs`-format `scrypt:` hash or accept a custom verify; does its handler
mount on a bare `node:http` server behind our origin gate with database-backed rate-limit storage; and **how many
real (non-test) accounts exist on any persistent installation** — if zero, the hash question is moot.

**Then Ron must decide, and the review is right that he does not yet have the information:** (a) is ending the
"root app is dependency-free" property acceptable, since it is a stated design value; (b) which email provider
serves check-email and reset, because it determines the data-processor and privacy review (`P-03`); (c) is sign-up
open, invite-only or waitlist-gated for the pilot. **Given the unmetered proxy, I recommend invite-only until
`/api/ai` is metered or gone.**

---

## 4. What I accept, and what I am changing

**Accepted in full:**

1. **Delete `/api/config` now**, not at retirement. Dispatched as `CONFIG-ANON-01`. `/api/v1/settings` already
   serves the same data per account under the session-derived owner.
2. **Meter `/api/ai` immediately**, and delete it once `DESIGN-03` grades server-side. Dispatched as the next slice.
3. **Three table classes with a mechanically checked rule** — *auth* (no RLS, auth role only), *owned* (`owner_id`,
   FORCE RLS, in the deletion list), *shared content* (no owner, immutable, no runtime write grant) — and a
   **catalog-driven check** that enforces the class of every table, with a mutation proof. This is the single best
   structural idea in the review: it turns "growing from 13 to ~22 tables can't silently weaken a class" into a check.
4. **Answer keys never leave the database to a learner-facing role**, via a `SECURITY DEFINER` marking function and
   no `SELECT` grant on the key table — rather than a policy promise.
5. **Review status as an append-only decision log**, not a column, so a version row never needs an `UPDATE`.
6. **Do not add binding columns to `submissions`** — its immutability trigger would refuse the backfill, and the
   attempt binding is already immutable.
7. **Audio: no table now** (C-01 found zero tracked audio); a listening version is not servable without an audio
   binding, and adding a recording produces a **new version** because a different recording is a different task.
8. **`MIGRATE-01` before further schema work** — freeze migrations out of `spikes/` with checksums, add a separate
   `migrate` command, strip the runtime of `admin`/`migration` pools, and stop building the production API through
   `fixture.mjs`. **Every later slice adds migrations, so doing this after them compounds the problem.**
9. **The removal matrix is not independent** — each row needs a named replacement, so it cannot finish before the
   routes exist. It becomes an output of the route work, not a step before it.
10. **The screen map has a gap**: the vocabulary/core trainers, SRS and adaptive drills produce most of `history` by
    volume and have **no mockup and no contract row**. Without a slice, `SAAS-RETIRE-01` either cannot complete or
    deletes them by accident.
11. **`progress-equal-check` dies with the blob** — no property survives it — while `reset-check`/`revision-check`
    survive re-expressed against owned records. Deleting a check *with its reason recorded* is right; deleting a
    failing check to declare victory is not.
12. **Add to `SAAS-RETIRE-01`'s acceptance the populated case**: an upgrade of an installation with rows from
    migration `0005` passes and owned-table row counts are unchanged except the documented backfill. The plan's
    current acceptance only tests the empty database.

**Rejected, or held:**

- **Nothing is rejected outright.** Two items I am **not** acting on yet, deliberately: the `practice_event`/`srs_card`
  /`plan_mark` schema (§3.2 needs Ron first, and building it before that decision risks building the wrong shape),
  and the `POST /api/v1/imports` legacy import (**the review's own suggestion is right — ask Ron whether any learner's
  history must survive before building it**, since the plan makes it optional and the only known store is his live
  install).

---

## 5. The revised dispatch order

| # | Slice | State | Why here |
|---|---|---|---|
| 1 | **CONFIG-ANON-01** | **running** | live defect, hours, depends on nothing |
| 2 | **AI-METER-01** | next | live defect (unmetered proxy), and it gates §3.3(c) |
| 3 | **MIGRATE-01** | next | every later slice adds migrations; fix the ledger, the runtime pools and the fixture-built production API **first** |
| 4 | **SAAS-MODEL-01b** | after MIGRATE-01 | finish the binding (`attempts.task_version_id`), add `task_key`/`prompt_version`, the table-class catalogue check, and the review-decision log |
| 5 | **TABLE-CLASS-CHECK** | with 4 | the check is the deliverable, not the tables |
| 6 | **ROUTES-01** | after 4 | the ~20-route contract, including `GET /api/v1/export`, which nothing serves today |
| 7 | **SAAS-RETIRE-01** | after 6 | matrix completed from the routes that now exist; populated-install acceptance added |
| 8 | **AUTH-01-spike** | parallel | the three facts in §3.3; then Ron decides |

**`SAAS-MODEL-01a` (PR #82) is not reverted.** It landed steps 1, 2 and 4 with a green pushed milestone, it found the
`seed.json` error independently, and it touched **no shared client file**. Its step 3 (the removal matrix) is a
skeleton, and it stops there because the review is right that it cannot finish earlier.

---

## 6. The three most dangerous things, as the review sees them — and I agree

1. **Open sign-up + session-gated generic LLM proxy = unbounded operator spend, live today.** Early warning: a
   per-account counter with an alert, and **reconcile the provider dashboard's daily spend against `usage_ledger`
   debits — any gap is proxy traffic.**
2. **Deletion completeness and RLS coverage drift as owned tables grow from 7 to ~14.** The deletion read-back is a
   hand-maintained list (`adapter.mjs:243-250`); a new table is checked only if someone remembers to add it, and
   `deletion-check` 18/18 would still pass. Early warning: the table-class catalogue check with a mutation proof.
3. **The progress/plan/dashboard views cannot be rebuilt from server-marked rows without changing what learners
   see** — §3.2's decision. Early warning: a **fixture-replay check** feeding a recorded synthetic history through
   both today's `mleAbility`/`studyPlan` and the server aggregation, diffing per source; and an `EXPLAIN` on the
   progress query at 50k events showing an index range scan.

**These early warnings are the most valuable part of the review**, because each one is a check that can be written
now and would fail *before* the harm, rather than a report after it.

---

## 7. The review's own limits, restated so they are not lost

No PostgreSQL and no browser were used, so every statement about RLS, grants, triggers, migrations and the deletion
transaction is a **reading**. Its V2 proof used a **stub** owned API and forced readiness — which is exactly why I
re-ran it against a real provisioned database with a real server, where it reproduced. Better Auth facts beyond what
the repository pins are from its own knowledge and are labelled as readings. **Three of its recommendations
(§3.3's facts, the `SECURITY DEFINER` key hiding, and the backfill of `attempts.task_version_id`) need execution to
settle**, and it says so with a bounded check for each.
