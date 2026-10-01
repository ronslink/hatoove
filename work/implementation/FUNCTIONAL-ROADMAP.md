# FUNCTIONAL-ROADMAP — the shortest path to a functional product, and what that lets us stop doing

| | |
|---|---|
| Author | Claude, as architect and planner (not implementer). Brief: `BRIEF.md`, round 2 |
| Governing instruction | Ron: *"we need not to stick to the earlier app implementation now we are interested at bringing a product to market which is functional"*. This **supersedes** the framing of `MASTER-PLAN.md`, `DESIGN-WIRE-01.md` and my own round-1 review (`SAAS-MODEL-01-RECOMMENDATIONS-claude.md`) wherever they conflict |
| Evidence checkout | `D:\hatoove-work\claude-align`, detached at `origin/codex/integration-01` = **`08acb21`**. **Read-only: nothing was modified, committed or pushed** |
| Other heads read | PR #82 `origin/codex/saas-model-01` = **`1a5a34c`**; PR #83 `origin/codex/config-anon-01` = **`86eab13`**. **Both are based on `20f8943`, and neither is merged into `08acb21`** (verified: `git merge-base --is-ancestor` fails for both) |
| Environment | Windows, Node, Git Bash. **No PostgreSQL and no browser were available, and none was created.** Every statement below about database behaviour (RLS, grants, triggers, migrations) or rendered behaviour is a **reading** of SQL/JS, and is labelled as one |
| Commands run | Only bounded ones: `git log/show/diff/merge-base`, `grep`, `timeout 60 node tools/content-discovery.mjs`, `timeout 20 node -e` over `data/seed.json`, `timeout 40-60 gh pr list/checks/run view` (read-only) |

**Labels used throughout.** **[V]** = verified here, by a command or by reading the exact lines cited. **[R]** = reasoned from code I read but did not execute. **[G]** = a guess or estimate, said plainly.

---

## 0. The answer in twelve lines

1. **Stop retrofitting the single-user SPA. Build a small new client for the product's journey, then delete the old one.** Most of the programme's recent effort has gone into fencing a localStorage-blob client across identity changes: five SESSION-BOUNDARY/FENCE records, PRs #66, #67, #77 and #79, `progress-merge`, `progress-scope` and `progress-equal`. That whole class of work goes away when there's no blob. **[R]**
2. **The minimum functional product (MFP) is writing-first.** You sign up with an invite, set an exam date and explanation language, pick a writing task, and the draft is saved on the server. You submit and leave. A server worker writes feedback. You come back on another browser to find it, revise, and see a factual history. You can export and delete your account. **Objective practice is a conditional add-on (MFP-13).** Only 15 of the "24 sets" can be served, because the 9 listening sets have no audio. And all of it depends on a rights decision Ron can make in minutes.
3. **Ron's blockers (a), (b) and (c) are real, but they aren't the critical path.** The critical path is **(b) plus a blocker missing from the brief: no learner-facing code submits writing to the server at all.** `draft-session.submit()` has no caller in `public/js/` **[V]**, so the client has to be rebuilt around submission. (a) can run in parallel after a half-day spike. (c) is a **decision**, not a build.
4. **What we can stop doing (§4):** local single-user mode and both flags, `/api/config`, `/api/ai` (**delete it, don't meter it**: AI-METER-01 is dropped), `/api/progress` and its five file stores, `progress-merge` and its checks, the `freshState()` blob, the adaptive engine, SRS, vocab/core trainers, guides, mock exam, listening, speaking, the five-language pipeline, DESIGN-02..07 as fourteen screens, legacy import, practice-event/SRS/plan schema, C-02 generation and about 13 CI steps.
5. **What we can't drop (§4.3):** ownership and FORCE RLS, the origin gate, key non-disclosure, immutable submissions, one debit, hard delete and its completeness, the stale-write fence, honest "unassessed" states, no pass prediction, and the human gates.
6. **Q1's rule in one sentence:** *if a learner of the new product could observe a violation of the property, retarget or replace the check; if they couldn't, delete it **in the same commit that deletes the implementation**, with a ledger row.*
7. **PR #82's red job:** delete the `mock-outcome-browser-check` CI step with a ledger row. The node-level `mock-outcome-check.mjs` keeps guarding the logic until the mock view itself is deleted. The rendered "unassessed" property comes back in MFP-08 against the new writing screen.
8. **Corrections to the brief** are in §0.1. The most material one: #82's "fail-closed entry point" is fail-closed for `node server.js` only. The library `createServer()` still defaults to ready (`server.js:1054` on `1a5a34c`) **[V]**.
9. **Critical path** (§5.2): MFP-00 → 01 → 02a → 02b → 05a → 06a → 06b → 08 → 11a → 12. That's about **13–17 engineer-days of slices [G]** plus human decision time. Auth (03→04a/b) and the client shell (07) run alongside it.
10. **First three dispatches** (§5.3): **MFP-00** integrates #83 and #82 and makes CI green. **MFP-03** is the auth spike in a disposable checkout. **MFP-14** writes the table-class catalogue check before any new owned table exists.
11. **Ron's questions** are consolidated in §6. Five of them (R1, R2, R3, R6, R7) unblock the most work and cost him minutes.
12. **Nothing here closes E-01, C-04, C-06, P-03/X-01 or real-device evidence.** "Functional" means a stranger could complete the journey on a staging-equivalent install with provider, email and payment stubs. It doesn't mean launched. Deployment, live AI, email, DNS and payments stay with Ron.

### 0.1 Where the brief is wrong or incomplete, with the evidence that settles it

| Brief says | What the code says | Label | Evidence that would settle it fully |
|---|---|---|---|
| "PR #82 fails CI on exactly one job" | True as a job count, but **4 of the 5 browser steps never ran**: the job stops at the first failing step (`ci.yml:188-197`, sequential steps). Separately, **PR #83 also fails that job**, for an unrelated reason: `FAIL Timed out waiting for http://127.0.0.1:4342/json/version` (Chrome's DevTools port never opened; run `36829834111`). So the browser job is fragile as well as asserting the removed mode | [V] logs via `gh run view --log-failed` | Re-run #83's browser job. A pass on re-run means a flake, a second failure means an environment defect |
| "The fail-closed entry point means the server no longer runs without account/database configuration" | Only for **`node server.js`** (`server.js:1111` on `1a5a34c` sets `saasReadiness = {ready:false}`). **`createServer()` used in-process still defaults to ready**: `const readiness = (serverRef && serverRef.saasReadiness) \|\| { ready: true, reason: 'unset' }` (`server.js:1054` on `1a5a34c`). Four browser checks and several Node checks build the server that way (`provider-config-browser-check.mjs:92` `mod.createServer()`), so they still exercise single-user behaviour. Also, "no longer runs" is inexact: the process **listens and answers 503** (`/api/ready` → `503 mode:'unconfigured'`). It doesn't exit. `waitForHttp` requires `res.ok` (`tools/cdp.js:37-49`), which is why the wait on `/api/config` timed out | [V] by reading the PR diff | MFP-02b's check: `createServer()` with no readiness → `/api/v1/account` 503 |
| "`public/js/ai.js:28,141` still call it, so on a hosted runtime the learner's exam date neither loads nor saves" | **Probably wrong for a signed-in learner.** The date loads from `/api/v1/settings` ("server settings win", `account.js:182-200`) and saves through `session().saveSettings` (`ui.js:1003-1008`). `saveExamDate` (`/api/config`) is called **only** in the `single-user` phase (`ui.js:989-995`), and so is the seed from `/api/config` (`app.js:306`). On a hosted runtime `refreshStatus()` gets a 404 body, keeps its previous `examDate`, and is otherwise harmless (`ai.js:26-40`). What *is* true: a signed-out or never-signed-in visitor has no date, and the dead call remains | [R] (no browser run) | One rendered check: sign in, set the date, reload in a fresh profile, assert the date shows. That becomes a leg of MFP-07's browser check |
| "24 objective sets" | 24 sets exist, but **9 are listening** (`HV1`–`HV3`, 3 each). With 0 tracked audio (`content-discovery.mjs` §[10]) and browser TTS ruled out as a substitute (`IMPLEMENTATION_PLAN.md:234`), **15 sets are servable at most** (LV1–3, SB1–2). `seed.json` also has `declaredSource=false` | [V] `node -e` over `seed.json`; content-discovery output | — |
| "(b) submission creates a job but completion is a fixture hook and writing still grades in the browser" | Correct, and **worse**. **No learner-facing code path submits at all.** `draft-session.js:272-285`'s `submit()` has no caller in `public/js/` (grep for `\.submit(` finds only the internal `client.submit`). The writing view grades through `ai.gradeWriting` → `/api/ai` (`exam.js:825`) and records the result only in the local blob (`exam.js:829-857`, `store.recordAttempt`/`addError`). So the server's submission/job/assessment/debit machinery is reachable **only from checks** | [V] grep + read | — |
| (implicit) the fixture worker is a template for the real one | `fixture.mjs:109-113` `claim()` sets `status='running'` but **no `lease_token`/`lease_until`**, and `complete()` (`:115-133`) has **no lease fence**. A crashed worker's job stays `running` forever. The real runner has to add lease issue, lease fencing and expired-lease reclaim | [V] read | MFP-06a's crash leg |
| (implicit) #82 and #83 merge cleanly | **They conflict.** Both edit `server.js` and `tools/saas-runtime-check.mjs`. `tools/coord-config-anon-probe.mjs` is an **add/add conflict**: `df1924a` on integration-01 adds a 134-line version and `433a73f` on #83 adds a 285-line one | [V] `git diff --name-only` and `git show --stat` | MFP-00 step 1 |
| "~15 tool files calling `/api/config`" | **16** files in `tools/` reference it, including the anon probe. Two client call sites (`ai.js:28,141`). Handlers at `server.js:922-948` | [V] grep | — |

---

## 1. Q1 — a RULE for retiring checks

### 1.1 The rule

A check exists to guard a **property**. Before touching a check that fails because its implementation is being removed, write down the property in one sentence, in terms of what a learner or operator could observe. Then ask one question:

> **Could a learner, attacker or operator of the *new* product observe a violation of this property?**

| Answer | Action | Conditions that must hold, or it's "deleting a failing check to declare victory" |
|---|---|---|
| **Yes, and only the vehicle changed** (same property, different route/module/screen) | **RETARGET.** Keep the assertion and change what it drives | The retargeted check **fails on a tree where the property is broken** (a discrimination leg is recorded), and the retarget lands **in the same PR** as the vehicle change |
| **Yes, but the mechanism can't exist in the new architecture** (e.g. a client-blob fence becomes server ownership) | **REPLACE.** Write a new check for the same property against the new mechanism | The replacement is **green and discriminating on `origin` before or in the same PR** as the old check's deletion. The ledger row names the replacement file and leg |
| **No.** The property belongs only to the removed implementation (blob key order, local-install unchanged, file revision markers) | **DELETE WITH A RECORDED REASON** | Deletion happens **in the commit that deletes the implementation** (never earlier: a check deleted before its code is an unguarded live path). Where the removal itself is a safety property (e.g. "no progress file is written"), add a **negative check** proving the implementation is actually gone |
| **Unclear** | Treat it as **Yes**, then REPLACE | — |

Three prohibitions:

- **No `skip`, `continue-on-error`, `|| true` or commented-out CI steps.** A step is either present and gating, or deleted with a ledger row.
- **No deleting a check whose implementation is still reachable.** (The exception is §1.2's mock step, whose logic stays guarded by a sibling check.)
- **No counting retirements as progress.** The ledger is a cost record, not a scoreboard.

**The ledger.** A new file, `work/implementation/RETIRED-CHECKS.md`, gets one row per retired check or leg. Columns: `check | leg(s) | property (one sentence) | decision (retarget/replace/delete) | reason | replacement file:leg or "none - property void" | commit that removed the implementation | slice`. The coordinator reviews it at every merge. This rule is how AGENTS.md:9 ("old single-user compatibility assertions are superseded") gets applied without falling foul of DESIGN-WIRE-01:45 ("do not delete failing tests just to label the migration complete").

### 1.2 The rule applied to the three named cases

**`mock-outcome-browser-check.mjs` (the red job on PR #82).**
- What it does: it spawns `node server.js` as a **local single-user** server with `B1PREP_PROGRESS_FILE` and no account configuration (`mock-outcome-browser-check.mjs:115-126`), then drives the **mock exam** view.
- Its properties: (P1) when the assessment is unavailable, the writing shows as `unbewertet`, never a fabricated score. (P2) The submitted text stays accessible. (P3) There's no "Bestanden?"/grade-band/readiness claim. (P4) Mock layout has no horizontal overflow.
- The decision differs by property:
  - **P1–P3 → REPLACE.** A learner of the new product *could* see a fabricated score on the writing-result screen. The replacement is MFP-08's `writing-result-browser-check` leg `failed-or-pending-assessment-renders-unassessed`, which stubs the provider to fail and checks the result view shows no score.
  - **P4 → DELETE.** The mock view isn't in the MFP and is deleted in MFP-11a.
- **What to do now (MFP-00):** delete the CI step `ci.yml:188-189` with a ledger row. This is the one permitted exception to "replacement first", for three reasons:
  - The node-level `tools/mock-outcome-check.mjs` stays in the offline job (`ci.yml:49-50`) and still guards P1–P3's **logic** (`assessMockWriting`) until the mock view is deleted.
  - The browser check **can't** run without local mode, which is the thing being removed.
  - Keeping local mode alive to feed one check is exactly what Ron's instruction ends.
- What we lose until MFP-08: rendered evidence of P1–P3. Said plainly in the ledger.

**`progress-equal-check.mjs` (+ `.test.mjs`).**
- Property: "`progressEqual` compares two progress blobs independent of key order" (`MASTER-PLAN.md:81,86`).
- No learner of the new product can observe it, because there's no blob, no `mergeProgress` and no `/api/progress`.
- → **DELETE** in **MFP-11a**, the commit that deletes `public/js/progress-merge.js` and `store.js`. Not before: until then the module still ships.
- Replacement: none, property void.
- The **negative check** that matters is MFP-02b's `retired-surface-check` leg: no `/api/progress` route, no progress file opened.

**Checks asserting local single-user mode.**

| Check (leg) | Property | Decision | Replacement / when |
|---|---|---|---|
| `saas-runtime-check` `legacy-progress-local-install-unchanged` | local app unchanged | DELETE | Already retired by #82 (`SAAS-MODEL-01.md` §3) and replaced by `entry-point-fails-closed-when-the-mode-flag-is-omitted`. Ledger row added in MFP-00 |
| `saas-runtime-check` flag-matrix legs (`B1PREP_SAAS` on/off) | two modes behave differently | DELETE in MFP-02b | Replaced by `startup-refuses-removed-flags` + `missing-config-exits-before-listen` (MFP-02b) |
| `accounts-http-check` `accounts-are-off-by-default` (renamed to `unconfigured-entry-point-fails-closed` by #82) | absent config is safe | RETARGET in MFP-02b | Absent config → process exits non-zero before `listen()` |
| `session-boundary-check` legs that run "accounts off" | single-user server path | DELETE in MFP-11a | Server-side legs (ordering, response fencing) stay. Client-boundary legs die with `account.js`'s single-user phase |
| `server-origin-check` (16) | non-GET `/api/*` needs same origin | **RETARGET** in MFP-02b | Drive `PUT /api/v1/settings` and `POST /api/auth/sign-in/email` instead of `POST /api/config` |
| `provider-config-check` (11) | a learner can't set the provider/model | **RETARGET** in MFP-02b | `/api/config` → 404. `PUT /api/v1/settings {"model":…}` → 422 (a new leg: `model` is still accepted today, `owned-api.mjs:117,142-145` per round-1 V9) |
| `keymask-check` (12, + pre-fix discrimination) | no route discloses any 3-char run of the key | **RETARGET** in MFP-02b | Route list becomes `/api/health`, `/api/ready`, `/api/auth/*`, `/api/v1/*`, static. The pre-fix discrimination commit `8a71f71` stays valid as a historical leg |
| `reset-check` (9), `revision-check` (8) | delete really deletes; a late write can't resurrect | **REPLACE**, then DELETE in MFP-02b | Owned equivalent: `DELETE /api/v1/attempts/:id` then a stale `PUT` → 404, never a recreate. Account deletion then a late write → 401. Write the missing leg in `owned-api-check` **first** (MFP-02b step 1) |
| `writing-surface-browser-check` | (a) an account draft restores; (b) "leaves the single-user path alone" | (a) RETARGET in MFP-08; (b) DELETE in MFP-11a | (a) becomes MFP-08's fresh-browser draft restore |
| `account-ui-browser-check` | language setting doesn't translate the German menu | RETARGET in MFP-07 | The new shell: nav strings identical before and after a language change (Ron decision 4, `RON-DECISIONS-20261001.md` §4.1) |
| `provider-config-browser-check` | Settings offers no provider field | RETARGET in MFP-07 | The new settings screen |
| `session-boundary-browser-check` | a second tab can't re-create the account record | REPLACE in MFP-07 + `deletion-check` | New client holds no learner state in `localStorage`. Server: late write after deletion → 401 |
| `progress-scope-check` | the blob store is account-scoped | DELETE in MFP-11a | Replaced by MFP-07's `no-learner-state-in-web-storage` leg |

---

## 2. Q2 — the MINIMUM FUNCTIONAL PRODUCT

### 2.1 Challenging the assumption

Ron's sketch: sign up → set exam date → practise a reviewed task → server-marked answer with explanation → write with durable feedback → resume on another browser → factual progress. Whole-exam simulation, speaking/STT, five languages, checkout and legacy import are out.

**The exclusions are right.** Three things in the sketch are off.

1. **"Practise a reviewed task → server-marked answer" is not the spine, writing is.** Here's what the code shows:
   - Everything the server already proves is built around **writing**: drafts, immutable submissions, jobs, assessments, `usage_ledger`, one debit (`spikes/auth-runtime/schema.sql`) **[V]**.
   - The paid unit the plan designs for is a successful writing assessment (`IMPLEMENTATION_PLAN.md:220`).
   - The only evidence-backed AI use is formative writing feedback (`IMPLEMENTATION_PLAN.md:224`).
   - Objective practice has **no** server path today: no task route, no key table, no marking function. The content is **15 servable sets of unknown rights**, about 3 per part, which a learner works through in an afternoon **[G]**.

   **Recommendation:** the MFP is **writing-first**. Objective Lesen/Sprachbausteine practice is **MFP-13**, conditional on Ron's rights answer (R1). It's cheap once that answer exists: about 2 days **[G]**. But it shouldn't sit on the critical path, and it shouldn't hold launch.
2. **"Set exam date" doesn't do anything on its own.** Issue #63's principle (quoted in `RON-DECISIONS-20261001.md` §4.3) is that a stored field that changes nothing isn't a feature. Without the study plan (dropped, §4), the date drives only a countdown. Keep it: it's already built (`/api/v1/settings`) and costs nothing. But don't build a plan engine to justify it.
3. **The sketch leaves out four things a stranger needs**, and they're cheap next to what it includes:
   - **Account recovery.** Without password reset, a stranger who forgets a password is locked out. This needs an email port, which means a Ron decision (R5).
   - **Export and delete.** Hard delete is a confirmed Ron decision and is built and wired (`DELETION-WIRE-01`). Owned export has **no route** (`GET /api/v1/export`, round-1 §3) **[V]** by grep on `owned-api.mjs`.
   - **An allowance** (how many feedbacks a learner gets) without checkout. This is a config number per invite (R9). `entitlements.allowance` already exists.
   - **The legal minimum before a stranger signs up**: privacy notice, AI disclosure, telc non-affiliation (P-03). The text is human-gated. The app needs a place to put it.

### 2.2 The MFP, precisely

**Journey (each step has to work for a stranger, on desktop and phone viewports, with the server as the only authority):**

| # | Step | Capability it needs | Exists today? |
|---|---|---|---|
| J1 | Open the invite link, sign up with email + password (+ invite code) | production auth: `Secure`/`__Host-` cookie, throttles, enumeration-safe errors, invite gate | Partly. Synthetic `sessions.mjs`. No `Secure` (`sessions.mjs:82`), no throttle (`:111-114`, `:141-148`) **[V]** |
| J2 | First-run setup: exam date, explanation language (de/en/uk/ar/tr) | `GET/PUT /api/v1/settings` with constrained `language` | Yes, the route exists. `language` is unconstrained free text (round-1 §7) |
| J3 | Dashboard: "continue your draft", "your feedback is ready", countdown | `GET /api/v1/attempts?status=` list route | **No list route** **[V]** (routes in `owned-api.mjs:1-11`) |
| J4 | Choose a writing task (only servable versions) | `GET /api/v1/tasks?family=SA1`, serving policy from config, attempt binds `(task_id, version)` | Tables yes (#82 migration `0006`), route no, binding defaulted (`adapter.mjs:29-30,93`) |
| J5 | Write; autosave with visible state; conflicts explicit | drafts + revision fence | **Yes** (`draft-session.js`, `owned-client.js`, 17/17 + 31/31) |
| J6 | Submit; see "pending"; leave | immutable submission + job + reservation | **Yes, server side.** No UI caller (§0.1) |
| J7 | Worker produces feedback in the chosen explanation language, with a server-owned prompt/rubric version; failures are recoverable and don't consume allowance | worker runner, lease, provider port (stub here), output validation, one debit | **No.** Fixture hook only (`fixture.mjs:108-145`) |
| J8 | Return on a **fresh browser**, see the exact text, submission and feedback; revise (new attempt with `parent_submission_id`) | list + lookup routes, no local pointers needed | Lookup yes, list no |
| J9 | Progress: a factual list and simple counts of own submissions and assessments by date and criterion. No forecast, no pass claim | `GET /api/v1/progress` (bounded) | No |
| J10 | Settings: change language/date, sign out, **export**, **hard delete** | export route; delete is wired | Export **no**; delete yes |
| J11 | Forgot password → reset via email (stub port in this programme) | reset tokens in `verification`, email port | No |

**What must hold across the journey:**
- two-account isolation by UUID guessing, lists and late callbacks
- deletion beats late jobs
- duplicate clicks and reloads are idempotent
- a provider failure leaves the writing "unassessed", never scored
- German chrome and exam content never change with the language setting

### 2.3 Not in the MFP, and why each exclusion is acceptable

| Excluded | Why it's acceptable | Ron's sketch? |
|---|---|---|
| Whole-exam simulation (mock) | Needs complete reviewed content and audio for all parts, which doesn't exist (0 audio) | agreed |
| Speaking / STT | Already outside the pilot (AGENTS.md:5) | agreed |
| Listening practice | 0 tracked audio, and TTS substitution is forbidden (`IMPLEMENTATION_PLAN.md:234`). It only comes back with C-04 | **new** |
| Objective practice (Lesen/SB) | Conditional, MFP-13. Not on the critical path (§2.1) | **changed** |
| Five-language **reviewed** explanation corpus and pipeline | The language **setting** stays (Ron decision 4) and is honoured where text is generated on the server: the writing feedback prompt carries it. Static explanation translations, the RTL corpus and native review are C-06 and post-MFP. Output gets labelled "not reviewed" until C-06 (R12) | agreed, narrowed |
| Commercial checkout (DESIGN-07, P-01/P-02) | Invite-only free pilot with a configured allowance | agreed |
| Legacy `progress.json` / blob import | No defensible automatic attribution (round-1 §4.2). Pending R7/R8, possibly no real accounts at all | agreed |
| Adaptive engine, SRS, vocab/core trainers, Satzbau, gender drills, dictation | They depend on client-generated items and keys that the server never sees. That makes them unmarkable, so they'd need the `self_reported` authority decision (ALIGNMENT §3.2). Dropping them makes that decision moot | **new** |
| Reference guides (grammar, cases, writing, gender) | Not assessed content and not needed for the journey. Easy to bring back later as static pages in the new shell | agreed |
| Study plan / calendar, mistake notebook (review queue) | Need E-04 and progress semantics. Not needed to complete a writing loop | **new** |
| The 14-screen design build-out | The MFP needs about 7 screens (§5, MFP-07/08/09). The others wait for content | **new** |

---

## 3. Q3 — the real blockers

### 3.1 Ron's three, assessed

| # | Ron's blocker | Correct? | Build / buy / decide | Work **[G]** |
|---|---|---|---|---|
| (a) | Production auth has no design. `sessions.mjs` is synthetic: no `Secure`, rotation, recovery or abuse controls | **Right but incomplete.** It's also a **runtime-composition** problem. The production server is built from the test fixture (`accounts.mjs:73-94` → `createPostgresWorld`, `fixture.mjs:35-45`), keeps a superuser `admin` pool open, and uses it **per sign-up** (`sessions.mjs:128-132`). Migrations run at every start from `spikes/` with no checksums (`provision.mjs:58-78`) **[V]** | **Decide** library vs. harden (R4, after the spike), then **buy** (Better Auth 1.7.6 is already pinned in `spikes/auth-runtime/package.json:7` **[V]**, and migration `0001` *is* its schema) **or build**. Composition is **build** (MFP-01, MFP-02a) | Spike 0.5 d. Composition 2 d. Auth hardening 2–3 d with the library, 3–4 d without |
| (b) | No production worker; completion is a fixture hook; writing grades in the browser | **Right, and worse** (§0.1): no UI submits at all, and the fixture worker has no lease fence | **Build.** Runner, lease, provider port with a stub, server-owned prompt/rubric/language, validation. Real-provider wiring stays a **decide** (R10: live AI isn't authorized) | 2.5–3 d server, plus 1.5–2 d client writing flow |
| (c) | Almost no reviewed content (24 objective sets, 6 writing prompts, rights `unknown`) | **Right on numbers (15 servable objective sets, §0.1), wrong on type.** This isn't an engineering blocker. For an invite pilot it's a **decision**: (i) Ron attests provenance/rights (the prompts are JS constants the project authored, `ai.js:837`; `seed.json` has no declared source), (ii) Ron decides whether an invite pilot may serve `unreviewed` content with a visible label (round-1 §2.1 serving rule as config). For **market**, it's a **human-throughput** problem, E-01/C-03, which no agent can close. Writing prompts are the cheapest content in the product: a qualified author can write and review 20 in a day **[G]**. The C-02 generation pipeline is slower to trust than a human author | **Decide** (R1, R2, R3) + **human authoring/review** | Ron: minutes. Authoring 20 prompts: about 1 expert-day **[G]**. Loader for new prompts: 0.5 d |

### 3.2 Missing from the brief's list

| # | Blocker | Evidence | Build / buy / decide | Work **[G]** |
|---|---|---|---|---|
| (d) | **The client.** The shipped SPA is about 12k lines built on `freshState()`/localStorage. The one part that touches the server (drafts) never submits. Retrofitting it is what produced the session-fence series | `wc -l public/js/*.js` = 12,035 total **[V]**. `exam.js:825-857` **[V]** | **Build new, small** (MFP-07/08/09), reusing `owned-client.js` and `draft-session.js` (both proven) | About 5 d across 3–4 slices |
| (e) | **The generic LLM proxy `/api/ai`** is the content generator *and* the grader. It's unmetered and session-gated, with open sign-up (ALIGNMENT §1) | `server.js:950-986` **[V]** | **Delete** (MFP-02b), don't meter. Its replacement is the worker (J7) | Included in MFP-02b |
| (f) | **Recovery needs email**, and email is a processor decision (P-03) | J11 | **Decide** (R5). Build against a stub port | 1 d with the stub |
| (g) | **Rubric disagreement.** The code has 4 criteria summing to 45 (`ai.js:760-765`). E-01 says three criteria (`IMPLEMENTATION_PLAN.md:151`) | round-1 V12 | **Decide** (R11): ship as "formative feedback, internal criteria, not a telc score", seeded as `unreviewed` | 0 d engineering |
| (h) | **No CI job runs the new journey.** The browser job has no PostgreSQL, and the PG job has no browser | `ci.yml:102-197` **[V]** | **Build**: one CI job with both a `postgres` service and Chrome (MFP-07 step 1) | 0.5 d |
| (i) | **Operational path to a stranger**: hosting, TLS, backups, secrets, a bind address that isn't hard-coded `127.0.0.1` (`server.js:1159`) | — | Bind address: **build** (MFP-02b). Everything else is **decide** and human-gated (F-02, L-01). Not authorized here | — |

### 3.3 The true critical path

**(b) plus (d), sequenced behind composition, is the critical path.**
- **(a)** auth can be developed in parallel because the journey runs on the synthetic port until MFP-04 lands. It must land before MFP-12.
- **(c)** is resolved by Ron in minutes for the pilot. It stays the critical path **to market**, because human review throughput is unknown and isn't engineering.

Stated plainly: **the engineering path to "functional" is about 3 weeks of serial slices [G]. The path to "market" is whichever is longer of that and the human content/legal/device gates. Nobody has measured those gates.**

---

## 4. Q4 — WHAT CAN WE STOP DOING?

### 4.1 Drop: in flight, planned or maintained

| # | Stop doing | What we lose | Why that's acceptable |
|---|---|---|---|
| D1 | **Local single-user mode, entirely**, including `B1PREP_SAAS` and `B1PREP_ACCOUNTS` (their presence becomes a startup refusal) and the "local install still works" property | Running the app with no database; zero-dependency local use | Ron's instruction. The live install `D:\B1_Prep` is a separate copy and isn't touched. Developers use a disposable PG (already how 3 CI jobs run) |
| D2 | **`/api/config`**, `saveEnv`'s request path, machine-global `EXAM_DATE`, and the ~15 tool files' use of it | Nothing a learner of the new product sees: `/api/v1/settings` already holds the date per account | Live-defect class (an anonymous global write). #83 removes it for hosted only. MFP-02b removes it unconditionally |
| D3 | **`/api/ai` and `AI-METER-01`**: delete the proxy, don't meter it. Also `/api/ai/test` over HTTP (it becomes an operator CLI, or is deleted) | Client-side generation of exam sets, drills, explanations, speaking grading. The old SPA's AI writing correction (the new worker replaces it) | Metering a route that's going to be deleted is wasted work. The proxy's every use is either replaced (writing → worker) or dropped (generation, speaking) |
| D4 | **`/api/progress`**, the progress file, backups, revision markers, `x-b1prep-account` selection | The old persistence | No defensible owner attribution (round-1 §4.2). Ron decision 5: sync is no longer needed |
| D5 | **`progress-merge.js`** and `progress-equal-check`, plus `check.js`'s "progress merging" section (`check.js:765-863`) | The conflict policy for two writers of one blob | There's no blob. §1.2 |
| D6 | **The `freshState()` blob and `store.js` as the learner authority**, `progress-scope-check`, and the client parts of SESSION-BOUNDARY/FENCE | Offline-first behaviour of the old SPA | The new client keeps no learner state in web storage. It holds identity-scoped memory only and recovers from the server |
| D7 | **Retrofitting `exam.js`/`ui.js`/`app.js`.** The "one owner of `exam.js`" choke point goes with them | Incremental continuity of the old UI | They're deleted at MFP-11a, so there's nothing left to own |
| D8 | **Reference-guide views** (`guides.js`, 1,031 lines) and their data files from serving | Grammar/cases/gender/writing guides | Not part of the learner loop. They can come back later as static pages in the new shell (the data files remain in git) |
| D9 | **Speaking/STT**: `speech.js`'s STT parts, `speaking-guide.json` serving, `genSpeakingTask`/`gradeSpeaking` | — | Already outside the pilot |
| D10 | **Listening and the TTS-as-listening path** | — | No audio. C-04 brings it back |
| D11 | **Adaptive engine, SRS, vocab/core trainers, Satzbau, gender drills, dictation** (`engine.js`, `generators.js`, `satzbau.js`, parts of `ui.js`), and the `practice_event`/`srs_card`/`plan_mark` schema and its Ron decision (ALIGNMENT §3.2) | The highest-volume activity in the old app | Unmarkable by the server. Keeping them forces either forgeable progress figures or a new authority model. Removing them deletes the question |
| D12 | **The five-language pipeline before launch** (static explanation translations, the RTL corpus, the review workflow) | Reviewed non-German explanations | The setting still works for server-generated feedback. C-06 stays open and is labelled |
| D13 | **DESIGN-02..07 as a 14-screen build-out**, and **DESIGN-07 commercial** entirely | Upgrade screen, plan, review, listening, mock and language screens | About 7 screens cover the MFP. Checkout is replaced by an invite allowance |
| D14 | **Legacy import** (`POST /api/v1/imports`) | Carrying any old history | Pending R7/R8. The plan already makes it optional |
| D15 | **C-02 server-side generation into a review queue** before launch | Content volume | Human-authored prompts are faster to get approved (§3.1 c) |
| D16 | **SAAS-MODEL-01b's `content_review` append-only log, `prompt_version` table, `task_key` table**, until a consumer exists | Structural completeness | Build each with its consumer: `prompt_version` with the worker (MFP-06b), `task_key` with MFP-13. #82's columns suffice for the pilot |
| D17 | **Finishing the #82 removal matrix as a document** | A planning artefact | MFP-02b/11a/11b *are* the removal. Their `retired-surface-check` plus the RETIRED-CHECKS ledger replace the matrix. Close the skeleton with a pointer |
| D18 | **About 13 CI steps** (§1.2): `progress-equal` ×1, `reset`, `revision`, `progress-scope`, `writing-check`, `writing-surface-check` (+test, retarget), `feedback-check`, the 5 legacy browser steps (retarget or replace into 3 new ones), and `check.js` sections for deleted modules | Regression cover of code that no longer exists | The rule in §1 |
| D19 | **Untracked-by-CI legacy tools**: `e2e.js`, `e2e-ai.js`, `ai-live.js`, `mock-deepseek.js`, `writing-browser-check.js`, `feedback-browser-check.js`, `tts-check.js`, `install-academy.ps1`, `make-icon.js`, `wo02-verify-probe.mjs` | Ad-hoc legacy tooling | No gate depends on them. Delete with the old client (MFP-11b) |
| D20 | **Open PRs #74–#79, #66, #67** as review queues | — | Every head except #74's is already an ancestor of `08acb21` (verified for `writing-surface-01b`, `deletion-wire-01`, `session-fence-02/03`, `coord-verify-e126d8c`, `session-boundary-03`) **[V]**. Close them as merged-via-#81. #74 (review coverage) covers code that's being deleted. Close it with a pointer |
| D21 | **"Root app is dependency-free"** as a design value (`package.json` `"dependencies": {}`) | Zero-install local run | Pending R4. It only mattered for the local install, and D1 removes that |
| D22 | **Pass/readiness/forecast UI from the mockups**, the "two-model" claims, the sample prices | — | Already forbidden. Nothing to build |

### 4.2 What these drops buy

**[R]** They remove the reason for about **9 of the 21 CI suites** and about **8,000 of the 12,035 client lines**. That's my estimate from file sizes, counting `store.js` 1325, `exam.js` 1752, `ui.js` 1067, `guides.js` 1031, `engine.js` 586, `generators.js` 518, `speech.js` 396, `satzbau.js` 334, `progress-merge.js` 210, `mock-outcome.js` 198, `dashboard.js` 164, most of `ai.js` 1257 and `app.js` 348. They also remove **every** open product question that doesn't block the MFP: §3.2 authority, import, the 5-language pipeline and commercial.

### 4.3 What CANNOT be dropped, because a defect would reach a real learner

| Keep | The defect it prevents | Guard |
|---|---|---|
| Session-derived ownership + FORCE RLS on every owned table, with `NOBYPASSRLS` roles | Learner A reads or writes B's drafts, feedback or settings | `owned-api-pg-check` RLS discrimination, `isolation.test.mjs`, and **MFP-14 table-class check** (new) |
| Hard-delete completeness, and deletion winning against late jobs | Deleted learner's data survives, or a late worker re-creates it | `deletion-check` (extended per new table), MFP-06a `late-completion-after-delete` leg |
| The origin gate on non-GET `/api/*`, and JSON-only bodies | CSRF / DNS-rebinding writes | `server-origin-check` (retargeted) |
| The provider key never disclosed; no learner-controlled provider/model/prompt | Key leak, cost abuse, prompt control | `keymask-check` (retargeted), `retired-surface-check` (`/api/ai` 404), settings `model` → 422 |
| Immutable submissions, idempotent submit (`event_id`), **one successful debit**, no debit on failure | Lost or altered submitted text; charging for failures | `owned-api-check` (submit/retry legs), MFP-06a debit legs |
| The draft revision fence (`409 stale_revision`), explicit conflicts | Silent loss of a learner's text across devices | `draft-session-check` 17, `owned-client-check` 31 |
| Honest states: missing or failed assessment = "unbewertet", never a heuristic score; no pass/readiness prediction | Misleading a learner about exam readiness | MFP-08 `failed-or-pending-assessment-renders-unassessed`, copy review |
| German chrome and content invariant under the language setting (Ron decision 4) | Translated exam material = a wrong exam | MFP-07 `nav-identical-across-language` |
| Answer keys never served before submission (when MFP-13 lands) | Trivial cheating; worthless marks | MFP-13 `no-key-in-task-payload` + E1 (round-1 §8) |
| Fail-closed startup | An unconfigured deploy serving an anonymous app | MFP-02b `missing-config-exits-before-listen` |
| Human gates E-01, C-04, C-06, P-03/X-01, real devices | Unreviewed claims presented as approved | `review_status`/`rights_status` round-trip (#82 step 4); serving policy as config |

---

## 5. Q5 — THE TASK LIST

### 5.0 Conventions for every slice

- **Branch naming:** `codex/mfp-NN-<slug>`. PR target: `codex/integration-01`. Never `main`.
- **Exact base:** the SHA stated below. If a later slice says "head of integration-01 after MFP-xx merges", the dispatcher writes that SHA into the dispatch at dispatch time. A slice never starts on an unrecorded base.
- **Push after every step.** Each step is one commit that leaves its checks green, **or** is a "checker first (failing on base)" commit whose failure is the expected, recorded one, which is this programme's established pattern (`433a73f`, `8e5b478`). A dying run must leave a green or explained head on `origin`.
- **Shared-file ownership (one writer at a time):** `server.js`, `.github/workflows/ci.yml`, `server/owned-api.mjs`, `server/owned-postgres/provisioning-sql.mjs`, `server/owned-postgres/provision.mjs`, `server/migrations/**`, `public/js/owned-client.js`, `public/index.html`. Each slice's ALLOWED PATHS names which of these it holds, and **no two concurrently dispatched slices hold the same one.**
- **Every slice record** (`work/implementation/MFP-NN.md`) contains: base, verbatim check output, the discrimination leg's output, RETIRED-CHECKS rows touched, and LIMITS.
- **No slice:** deploys, sends email, calls a live model, uses live payments, reads or writes `D:\B1_Prep` (except its `design/` folder, read-only, by MFP-07 only), or uses non-synthetic data.
- **Effort figures are guesses [G].** Every slice has been kept to about a day or less.

---

### MFP-00 — Integrate #83 and #82 on one head and make CI green honestly

| | |
|---|---|
| Purpose | `codex/integration-01` contains both PR #83 and PR #82 and **all 8 CI jobs pass**, with the one browser step that needs local mode deleted under the §1 rule and recorded |
| Base | `codex/integration-01` @ **`08acb21`**. Merges `86eab13` (#83) and `1a5a34c` (#82) |
| Owner | Coordinator (merge authority on integration-01) |
| ALLOWED PATHS | `server.js` (conflict resolution only), `tools/coord-config-anon-probe.mjs`, `tools/saas-runtime-check.mjs`, `.github/workflows/ci.yml` (**holds ci.yml**), `work/implementation/RETIRED-CHECKS.md` (new), `work/implementation/MFP-00.md` (new). Plus whatever files #82/#83 bring **verbatim** through the merge, with no edits beyond conflict hunks |
| Effort | 0.5–1 d **[G]** |

Steps:
1. `git merge --no-ff 86eab13`. Resolve the **add/add** on `tools/coord-config-anon-probe.mjs` by taking #83's version (the CI-gated 4-leg probe, recorded in `CONFIG-ANON-01.md` §5), and record why. Run the offline, server and PG suites locally on a disposable PG. Push. *Proven: #83's fix sits on the integration head, and the probe passes 4/4.*
2. `git merge --no-ff 1a5a34c`. Resolve `server.js` by keeping #82's unconditional readiness gate **and** #83's early return. Leave the early return as `saas && pathname === '/api/config'` **for now**: making it unconditional is MFP-02b's, because it changes the local-mode checks. Resolve `saas-runtime-check.mjs` as the union of #82's retired/added legs and #83's inverted assertion. Push. *Proven: both slices on one head. PG job green on CI.*
3. Delete the CI step `Honest mock writing outcomes in a real page` (`ci.yml:188-189`) and add RETIRED-CHECKS rows: (i) that step (§1.2), (ii) `saas-runtime-check legacy-progress-local-install-unchanged` (retired by #82). Push. *Proven: the browser job runs its remaining 4 steps.*
4. If any of the 4 remaining browser steps fails **because of #82's change** (expected: none, since they use in-process `createServer()` [R]), apply §1 to it with a ledger row. If a step fails on the Chrome DevTools port as #83's did, **re-run once**. A second failure is an environment defect: record it and escalate, and don't retire the step. Push. *Proven: 8/8 jobs green on the integration head.*
5. Write `MFP-00.md` with counters. Push.

| | |
|---|---|
| Executable check | GitHub CI on the integration head: 8/8 jobs. `node tools/coord-config-anon-probe.mjs` 4/4. `node tools/saas-runtime-check.mjs` 11/11 (#82's count) |
| Discrimination leg | `node tools/coord-config-anon-probe.mjs --server <worktree of 20f8943>/server.js` → **3/4 legs fail** (as `CONFIG-ANON-01.md` §6). Revert #82's gate to `if (saas && !readiness.ready …)` in a scratch worktree → `saas-runtime-check` `fail-closed-no-longer-depends-on-the-mode-flag` must fail |
| Dependencies | None. Blocks everything except MFP-03 and MFP-14 |
| Acceptance counters | CI jobs 8/8; RETIRED-CHECKS rows = 2 (+ any from step 4, each justified); `owned-api-check` 27/27 memory + 27/27 persistent; `owned-api-pg-check` leg count 9 (#82's) |
| Must NOT | Edit `public/**`; add features; touch `createServer()`'s default (that's MFP-02b); delete any other check; merge to `main` |
| Needs Ron? | **No.** (FYI: it closes PR #81's successors #82 and #83 into integration-01.) |

---

### MFP-01 — MIGRATE-01: migrations out of `spikes/`, checksummed, applied by a command, never by the runtime

| | |
|---|---|
| Purpose | `node server/migrate.mjs` is the only thing that changes the schema. The ledger stores a sha256 per migration and refuses a mismatch. A runtime started against a database behind the expected head reports `ready:false reason:'schema_behind'` and never migrates |
| Base | head of `codex/integration-01` after MFP-00 merges (dispatcher records the SHA) |
| ALLOWED PATHS | `server/migrations/**` (new; **holds**), `server/migrate.mjs` (new), `server/owned-postgres/provision.mjs` (**holds**), `server/owned-postgres/provisioning-sql.mjs` (**holds**), `server/owned-postgres/bootstrap.mjs`, `server/accounts.mjs`, `tools/migrate-check.mjs` (new), `tools/postgres-provision-check.mjs`, `work/implementation/MFP-01.md` |
| Effort | 1 d **[G]** |

Steps:
1. **Checker first:** `tools/migrate-check.mjs` with legs `ledger-has-checksums`, `tampered-migration-refused`, `runtime-never-migrates`, `schema-behind-not-ready`. Commit while it fails on the base (expected: 4/4 fail). Push.
2. Copy `0001`–`0003` **byte-for-byte** from `spikes/auth-runtime/` into `server/migrations/`, plus `0004`–`0006` rendered to SQL files. Add a `MANIFEST.json` with sha256 values. `spikes/` stays untouched, because the spike tests read it. Push. *Proven: sha256 of the copies equals the originals (a check leg).*
3. Forward migration `0007-ledger-checksum` adds `checksum text` to the ledger, backfills from the manifest, and refuses on mismatch. Push. *Proven: `ledger-has-checksums`, `tampered-migration-refused`.*
4. `server/migrate.mjs` (migration credentials only). `provisionPersistent` becomes verify-only for the runtime, and `accounts.mjs` maps "behind" to `ready:false reason:'schema_behind'`. Retarget `postgres-provision-check` to call the command (ledger row: retarget). Push. *Proven: all 4 legs pass.*
5. Record. Push.

| | |
|---|---|
| Executable check | `node tools/migrate-check.mjs` (disposable PG) 4/4; `postgres-provision-check`; `owned-api-check --backend=postgres-persistent` unchanged |
| Discrimination | Flip one byte in `server/migrations/0002-*.sql` → `tampered-migration-refused` passes only because the command **refuses**. With the refusal code removed, the leg fails. Point the runtime at a DB migrated only to `0005` → `schema-behind-not-ready` |
| Dependencies | MFP-00. Blocks MFP-02a, MFP-05a and every later migration |
| Parallel | MFP-03, MFP-07 (step 1 only, CI job), MFP-14 |
| Acceptance | 4/4 new legs; no change in `owned-api-check` counts; `git diff --stat spikes/` empty |
| Must NOT | Edit `spikes/**`; rewrite applied migration content; add domain tables; touch `ci.yml` (the coordinator adds the step at merge, or MFP-07 adds it if it holds ci.yml then) |
| Needs Ron? | No |

---

### MFP-02a — RUNTIME-COMPOSE: the production server isn't built from the test fixture

| | |
|---|---|
| Purpose | The running server opens **no** `admin` or `migration` pool and builds its API from `server/runtime.mjs`, which has no `inspect`/`worker` test hooks. Sign-up provisions `entitlements`/`learner_settings` through a `SECURITY DEFINER` function the auth role may execute |
| Base | integration-01 head after MFP-01 |
| ALLOWED PATHS | `server/runtime.mjs` (new), `server/accounts.mjs`, `server/owned-postgres/sessions.mjs`, `server/migrations/0008-*.sql` (new; **holds `server/migrations/**`**), `server/owned-postgres/provision.mjs` (pool construction only), `tools/runtime-composition-check.mjs` (new), `work/implementation/MFP-02a.md` |
| Effort | 1 d **[G]** |

Steps:
1. **Checker first:** `runtime-composition-check` with legs `no-admin-or-migration-pool-in-runtime` (counts the pools `loadOwnedApi` returns and asserts the roles connected via `pg_stat_activity` on a disposable PG), `no-test-hooks-on-runtime-api`, and `sign-up-provisions-allowance-without-admin`. Fails on the base. Push.
2. Migration `0008-provision-learner`: `provision_learner(user_id text, allowance int)` as `SECURITY DEFINER`, owned by the migration role, `SET search_path`, `EXECUTE` granted to the auth role only. Push. *Proven by a leg: the auth role can't `INSERT` into `entitlements` directly, but can through the function* [R → executed in the check].
3. `server/runtime.mjs` `createRuntimeWorld({pools})` wires datastore, sessions, settings and deletion with no admin. `sessions.mjs` calls `provision_learner` and drops `adminPool` from its runtime path (the fixture keeps its own). `accounts.mjs` uses `createRuntimeWorld`. Push. *Proven: 3/3 legs, and `accounts-http-check` unchanged.*
4. Record. Push.

| | |
|---|---|
| Discrimination | Pass `admin` back into `createRuntimeWorld` in a scratch tree → `no-admin-or-migration-pool-in-runtime` fails. Revoke `EXECUTE` → sign-up leg fails |
| Dependencies | MFP-01. Blocks MFP-02b, MFP-04a, MFP-06a |
| Acceptance | 3/3 new legs; `accounts-http-check` 6/6; `deletion-check` unchanged; `owned-api-check` (fixture world) unchanged |
| Must NOT | Change auth semantics (cookies, throttles: MFP-04a); change `fixture.mjs` behaviour used by checks |
| Needs Ron? | No |

---

### MFP-02b — ONE-MODE: delete local mode and the legacy server surface

Two days of work, split into two pushable halves (b1, b2). One dispatch, with the record updated at each step.

| | |
|---|---|
| Purpose | There is one runtime. Either removed flag present → refuse to start. Required config missing → exit non-zero before `listen()`. `createServer()` defaults to not-ready. `/api/config`, `/api/progress`, `/api/ai` and `/api/ai/test` answer 404 and no progress/env file is opened. The bind host comes from config |
| Base | integration-01 head after MFP-02a |
| ALLOWED PATHS | `server.js` (**holds**), `server/accounts.mjs`, `tools/retired-surface-check.mjs` (new; written in MFP-14's sibling dispatch if already present, otherwise here), `tools/saas-runtime-check.mjs`, `tools/accounts-http-check.mjs`, `tools/server-origin-check.mjs` (+`.test.mjs`), `tools/provider-config-check.mjs`, `tools/keymask-check.mjs` (+`.test.mjs`), `tools/owned-api-check.mjs` (one new leg only), `server/owned-api.mjs` (**holds**; settings `model` → 422 only), `tools/reset-check.mjs`, `tools/reset-check.test.mjs`, `tools/revision-check.mjs`, `tools/revision-check.test.mjs` (deletion), `tools/coord-config-anon-probe.mjs` (folded and deleted), `tools/coord-readiness-origin-probe.mjs`, `.github/workflows/ci.yml` (**holds**), `work/implementation/RETIRED-CHECKS.md`, `work/implementation/MFP-02b.md` |
| Effort | 2 d **[G]**: b1 about 1 d, b2 about 1 d |

Steps:
- **b1.1 Checker first:** `retired-surface-check` legs:
  - `config-404`, `progress-404`, `ai-404`, `ai-test-404`
  - `no-progress-or-env-file-touched` (temp root listed before and after a scripted session; no `progress*.json`, no `.env` write)
  - `startup-refuses-removed-flags` (`B1PREP_ACCOUNTS=0` present → non-zero exit + message)
  - `missing-config-exits-before-listen` (each required var removed in turn → non-zero exit, port never bound)
  - `library-default-not-ready`

  Plus an `owned-api-check` leg `stale-put-after-delete-is-404-not-recreate`. Commit failing. Push.
- **b1.2** Startup: required-config validation before `listen()`; the flags become refusals; `createServer()` readiness default `{ready:false, reason:'unset'}` (replacing `server.js:1054` on `1a5a34c`); bind host from `B1PREP_BIND_HOST` (default `127.0.0.1`). In-process checks that need a ready server set `server.saasReadiness` explicitly. Push. *Proven: the startup legs pass.*
- **b1.3** Delete the `/api/config` handlers and `saveEnv`'s write path. Settings `model` → `422 invalid_settings`. Retarget `server-origin-check` and `provider-config-check` (§1.2) with discrimination re-run. Push. *Proven: `config-404`; origin 16 legs retargeted.*
- **b2.1** Delete `/api/progress` handlers, `LEGACY_PATHS`, `accountPaths`, the file IO and revision markers (`server.js:35-80`, `:412-511`, `:776-920`). Delete `reset-check` and `revision-check` after the replacement leg from b1.1 is green (ledger rows: REPLACE). Push. *Proven: `progress-404`, `no-progress-or-env-file-touched`.*
- **b2.2** Delete `/api/ai` and `/api/ai/test` over HTTP. Keep `callDeepSeek` **unexported but present** for MFP-06b to move. Retarget `keymask-check`'s route list. Fold `coord-config-anon-probe` into `retired-surface-check` (ledger: retarget). Update `ci.yml` steps. Push. *Proven: all `retired-surface-check` legs; CI green.*
- **b2.3** Record. Push.

| | |
|---|---|
| Discrimination | Each retired-surface leg run against the MFP-00 head with `--server` must fail (route present / file written / process listens). Restoring `{ready:true}` as the library default → `library-default-not-ready` fails |
| Dependencies | MFP-02a. Blocks MFP-05a, MFP-07 step 3+, MFP-11a |
| Acceptance | `retired-surface-check` 9/9; `server-origin-check` and `provider-config-check` green retargeted; `keymask-check` green with the pre-fix discrimination still failing on `8a71f71`; RETIRED-CHECKS rows +5 or more; **CI green** |
| Must NOT | Touch `public/**` (the old SPA will lose AI and progress; that's accepted under D3/D4, and its own checks are retired in MFP-11); delete `callDeepSeek`'s body; change auth |
| Needs Ron? | **Yes, FYI-level:** "After this slice the repository's old single-user app no longer runs without a database, and its AI generation/correction stops. Your live install at `D:\B1_Prep` isn't affected. OK?" (R0) |

---

### MFP-03 — AUTH-SPIKE: three facts before the auth decision (disposable, no repository writes)

| | |
|---|---|
| Purpose | Answer, with executed evidence: (1) can Better Auth 1.7.6 verify a `sessions.mjs` `scrypt:` hash, or take a custom `password.verify`? (2) does its handler mount on bare `node:http` behind our origin gate, with **database-backed** rate-limit storage? (3) does it support custom sign-up hooks that run as a non-admin role (`provision_learner`)? |
| Base | `codex/integration-01` @ **`08acb21`**, checked out into a **disposable** directory outside any repository worktree |
| ALLOWED PATHS | In the repository: **only** `work/implementation/AUTH-SPIKE-01.md` (new), committed on branch `codex/mfp-03-auth-spike`. Everything else lives in a temp directory and is deleted afterwards |
| Effort | 0.5 d **[G]** |

Steps:
1. Record skeleton. Push.
2. `npm ci` in a disposable copy of `spikes/auth-runtime`, then run `probe/hash-probe` (round-1 E3) → fact 1. Update the record. Push.
3. Mount the handler in a 40-line `node:http` server with the origin check in front, and configure DB rate-limit storage against a disposable PG → fact 2. Push.
4. Sign-up hook calling a stub `provision_learner` → fact 3. Plus the Node engine floor actually required. Push.

| | |
|---|---|
| Executable check | The spike's own scripts, output verbatim in the record |
| Discrimination | Fact 1: a wrong password must fail verification (otherwise "verifies" means nothing). Fact 2: an 11th sign-in in the window must be refused, and must **still** be refused after restarting the process (proves DB storage, not memory) |
| Dependencies | None. **Parallel with MFP-00, MFP-01 and MFP-14** |
| Must NOT | Install anything into the repository tree; add dependencies to root `package.json`; contact any email/OAuth provider |
| Needs Ron? | **Yes, after it:** R4 (library vs harden, i.e. giving up "root app dependency-free"), R5 (email processor), R6 (invite-only), R7 (real accounts count) |

---

### MFP-04a — AUTH-01a: production session hardening and abuse controls

| | |
|---|---|
| Purpose | A stranger's session is `__Host-` + `Secure` + `HttpOnly` + `SameSite=Lax`, rotated on sign-in, revoked on password change and deletion, swept on expiry. Sign-up and sign-in are throttled per IP and per email using DB-backed counters, with enumeration-safe errors. Sign-up requires a valid invite code |
| Base | integration-01 head after MFP-02a **and** Ron's R4/R6 answers |
| ALLOWED PATHS | If R4 = adopt: `server/auth/**` (new), root `package.json` + lockfile (**holds**), `server/runtime.mjs`, `server/owned-api.mjs` (**holds**; the auth allowlist block `:268-291` only), `server/migrations/0009-*.sql` (**holds**), `tools/auth-check.mjs` (new), `work/implementation/MFP-04a.md`. If R4 = harden: the same, but `server/owned-postgres/sessions.mjs` replaces `server/auth/**` and there's no package change |
| Effort | 1.5 d (adopt) / 2 d (harden) **[G]** |

Steps:
1. **Checker first:** `auth-check` legs: `cookie-attributes`, `session-rotates-on-sign-in`, `throttle-sign-in-per-email`, `throttle-sign-up-per-ip`, `throttle-survives-restart`, `enumeration-safe-sign-up`, `invite-required`, `sessions-revoked-on-delete`, `expired-session-swept`. Fails on the base. Push.
2. Migration `0009` adds the rate-limit and invite tables (auth class, no RLS, auth role only). Push.
3. Implement per R4. Push per leg group (cookie/rotation; throttles; invite; sweep).
4. Record. Push.

| | |
|---|---|
| Discrimination | Remove the throttle → `throttle-*` fail. Store throttle state in memory → `throttle-survives-restart` fails. Drop `Secure` → `cookie-attributes` fails |
| Dependencies | MFP-02a, MFP-03, R4, R6. Blocks MFP-04b and MFP-12 |
| Parallel | MFP-05a/05b/06a: they share no paths, **provided** MFP-04a holds `server/owned-api.mjs` only for the auth block and MFP-05a's owned-api edit is sequenced after it. **The coordinator must serialise the two owned-api edits** |
| Must NOT | Add magic-link/Google; send email; change owned learner routes |
| Needs Ron? | R4, R6 before dispatch |

### MFP-04b — AUTH-01b: password reset and email verification through an email **port** (stub only)

| | |
|---|---|
| Purpose | A learner who forgets a password can reset it through a token delivered by the email port. In this programme the port is a stub that records the message. Responses are identical for known and unknown emails |
| Base | after MFP-04a |
| ALLOWED PATHS | `server/auth/**` or `sessions.mjs` (per R4), `server/email/port.mjs` + `server/email/stub.mjs` (new), `server/owned-api.mjs` (auth allowlist only; **holds**), `tools/auth-check.mjs`, `work/implementation/MFP-04b.md` |
| Effort | 1 d **[G]** |

Steps: checker legs `reset-flow-via-stub`, `reset-token-single-use`, `reset-token-expires`, `reset-revokes-sessions`, `unknown-email-indistinguishable` → implement → record, pushing at each step.

| | |
|---|---|
| Discrimination | Reuse a token → must fail. Compare response bodies and timings within tolerance for known and unknown emails |
| Dependencies | MFP-04a, R5 (the real provider can come later; the port shape doesn't depend on it) |
| Must NOT | Configure or call any real email provider |
| Needs Ron? | **R5** (which processor, eventually). Not needed to build the stub |

---

### MFP-05a — TASKS-01: serve writing tasks and bind attempts to them

| | |
|---|---|
| Purpose | `GET /api/v1/tasks?family=SA1` lists only versions allowed by the deployment's serving policy (`B1PREP_SERVE_REVIEW` ∈ {`approved`, `approved+unreviewed`}, plus a `rights` allow-list), each carrying its `review_status`. `POST /api/v1/attempts` **requires** `{taskId, version}` and refuses an unservable one. The synthetic `TASK_VERSION` constant is no longer reachable from the runtime |
| Base | integration-01 head after MFP-02b |
| ALLOWED PATHS | `server/owned-api.mjs` (**holds**), `server/owned-postgres/adapter.mjs`, `server/owned-postgres/content-seed.mjs`, `server/migrations/0010-*.sql` (**holds**; `attempts.created_at`, servable view), `public/js/owned-client.js` (**holds**; two new methods only), `tools/owned-api-check.mjs`, `tools/owned-api-pg-check.mjs`, `tools/owned-client-check.mjs`, `work/implementation/MFP-05a.md` |
| Effort | 1 d **[G]** |

Steps:
1. **Checker first:** legs `tasks-list-respects-policy`, `task-payload-has-review-status`, `attempt-requires-binding`, `unservable-binding-refused`, `no-synthetic-binding-in-runtime`. Push.
2. Migration `0010`: `attempts.created_at` (default `now()`, nullable for old rows) + `servable_task_version` view over #82's tables. Push.
3. Routes + adapter binding (the default is removed outside `fixture.mjs`). Push.
4. `owned-client` `listTasks`/`createAttempt({taskId,version})`. Push.
5. Record. Push.

| | |
|---|---|
| Discrimination | Serve with policy `approved` while all rows are `unreviewed` → the list must be empty (a check that always returns 6 would fail). Remove the binding requirement → `attempt-requires-binding` fails |
| Dependencies | MFP-02b. Blocks MFP-05b, MFP-06b, MFP-08 |
| Must NOT | Build `task_key`/objective marking (MFP-13); add `content_review` log (D16); serve `seed.json` families |
| Needs Ron? | **R2** decides the **production** policy value. The slice builds both values and defaults to `approved` (fail-closed) |

### MFP-05b — RESUME-01: owned list routes for fresh-browser resume

| | |
|---|---|
| Purpose | A fresh browser with only a session cookie can list the learner's attempts (draft / submitted / assessed / failed) newest-first with cursor pagination, and open each one with its exact task version, text, submission and assessment. Nothing is needed from local storage |
| Base | after MFP-05a |
| ALLOWED PATHS | `server/owned-api.mjs` (**holds**), `server/owned-postgres/adapter.mjs`, `public/js/owned-client.js` (**holds**), `tools/owned-api-check.mjs`, `tools/owned-api-pg-check.mjs`, `tools/owned-client-check.mjs`, `work/implementation/MFP-05b.md` |
| Effort | 1 d **[G]** |

Steps: checker legs `list-own-attempts-only`, `list-status-filter`, `cursor-stable-under-insert`, `fresh-client-resumes-exact-text`, `other-account-list-empty` → implement → record.

| | |
|---|---|
| Discrimination | Drop the `owner_id` predicate in a scratch adapter → RLS still hides rows (prove FORCE RLS alone holds), **and** drop the RLS policy with the predicate in place → the predicate alone holds. That's DESIGN-WIRE-01:79's "tested separately and together" |
| Dependencies | MFP-05a. Blocks MFP-08 and MFP-09 |
| Needs Ron? | No |

---

### MFP-06a — WORKER-01a: a production runner with leases, crash recovery and one debit (provider stubbed)

| | |
|---|---|
| Purpose | `node server/worker.mjs` claims queued jobs with a lease (`FOR UPDATE SKIP LOCKED`), reclaims expired leases, completes **only under its own lease token**, writes assessment + ledger + entitlement in one transaction, classifies failures, releases reservations on failure, and never completes a job whose attempt or account was deleted |
| Base | integration-01 head after MFP-02a (can start before MFP-05a; it doesn't read task tables) |
| ALLOWED PATHS | `server/worker.mjs` (new), `server/worker/**` (new), `server/provider/port.mjs` + `server/provider/stub.mjs` (new), `tools/worker-check.mjs` (new), `work/implementation/MFP-06a.md` |
| Effort | 1.5 d **[G]** |

Steps:
1. **Checker first:** legs:
   - `claim-sets-lease`, `two-workers-one-claim`, `expired-lease-reclaimed`, `stale-lease-cannot-complete`
   - `one-debit-on-success`, `no-debit-on-failure`, `reservation-released-on-failure`
   - `retry-bounded-3`, `late-completion-after-attempt-delete-writes-nothing`, `late-completion-after-account-delete-writes-nothing`
   - `malformed-provider-output-is-failure-not-assessment`
   
   Run against a disposable PG with the stub provider (modes: ok / slow / error / malformed). Push.
2. Claim/lease/reclaim. Push.
3. Complete/fail transactions with the lease fence. Push.
4. Retry and deletion legs. Push.
5. Record. Push.

| | |
|---|---|
| Discrimination | Remove the lease-token predicate from `complete` → `stale-lease-cannot-complete` fails (this is exactly `fixture.mjs:115-133`'s gap). Remove `SKIP LOCKED` → `two-workers-one-claim` fails under 2 concurrent workers |
| Dependencies | MFP-02a. Blocks MFP-06b |
| Parallel | MFP-05a/05b (different paths), MFP-04a, MFP-07 |
| Must NOT | Call any real provider; read learner text into logs; add an HTTP route |
| Needs Ron? | No |

### MFP-06b — WORKER-01b: server-owned prompt, rubric and explanation language; validated feedback

| | |
|---|---|
| Purpose | The worker builds the assessment request **only** from server records: the bound task version, the rubric version, a `prompt_version` row and the learner's explanation language **snapshotted on the job at submit**. It validates the structured output against a schema, and stores the feedback with `model_version`, `prompt_version`, `rubric_version` and language. The DeepSeek adapter exists behind the port but is **never exercised** in checks |
| Base | after MFP-05a and MFP-06a |
| ALLOWED PATHS | `server/worker/**`, `server/provider/**` (`deepseek.mjs` moved from `server.js`'s `callDeepSeek`), `server.js` (**holds**; deletes `callDeepSeek` only), `server/migrations/0011-*.sql` (**holds**; `prompt_version` table + `jobs.explanation_language`), `server/owned-postgres/adapter.mjs` (submit snapshots the language), `server/owned-postgres/content-seed.mjs` (one `prompt_version` row, `unreviewed`), `tools/worker-check.mjs`, `tools/feedback-case-check.mjs` (reuse its 14 synthetic cases as validator fixtures), `work/implementation/MFP-06b.md` |
| Effort | 1.5 d **[G]** |

Steps:
1. **Checker first:** legs `request-built-only-from-server-records` (the stub records the request; no learner-controlled field other than the submitted text is present), `language-from-job-snapshot`, `language-change-after-submit-does-not-regrade`, `feedback-schema-validated`, `injection-text-stays-data` (a submission containing "ignore previous instructions…" yields schema-valid feedback or a classified failure, never a changed rubric), `versions-recorded`. Push.
2. Migration `0011`. Push.
3. Prompt assembly + validation + adapter move. Push.
4. Record. Push.

| | |
|---|---|
| Discrimination | Let the job read the language from current settings instead of the snapshot → `language-change-after-submit-does-not-regrade` fails |
| Dependencies | MFP-05a, MFP-06a. Blocks MFP-08 |
| Must NOT | Make a live model call; claim feedback quality; seed the rubric as anything but `unreviewed` (R11) |
| Needs Ron? | **R10** (when may the worker use the live provider: a human gate, not needed for this slice) and **R11** (rubric labelling) |

---

### MFP-07 — CLIENT-SHELL: a new, small learner client (account, setup, settings, dashboard)

Split into 07a (CI job + shell + auth screens) and 07b (setup/settings/dashboard).

| | |
|---|---|
| Purpose | A new client under `public/app/` (served at `/app/` until MFP-11a swaps the entry) lets a stranger sign up, sign in, sign out, complete setup (exam date + explanation language) and change settings, using only `owned-client.js`. It holds **no learner state in `localStorage`/`sessionStorage`/IndexedDB**, keeps German chrome invariant under the language setting, and uses the design tokens |
| Base | integration-01 head after MFP-02b |
| ALLOWED PATHS | `public/app/**` (new), `public/assets/design/**` (new: curated fonts/logos with licence files copied from `D:\B1_Prep\design`, **read-only source**), `.github/workflows/ci.yml` (**holds**; a new job `Journey (PostgreSQL + headless Chrome)`), `tools/app-browser-check.mjs` (new), `tools/design-check.mjs` (retarget to `public/app/**` tokens), `work/implementation/MFP-07.md` |
| Effort | 07a 1 d, 07b 1 d **[G]** |

Steps:
- **07a.1** CI job with a `postgres` service + Chrome, running `migrate` → server → `tools/app-browser-check.mjs`. The checker first, with legs:
  - `sign-up-sign-in-sign-out`
  - `no-learner-state-in-web-storage` (after a full session, every web-storage key is identity-free and contains no learner text)
  - `nav-identical-across-language`
  - `settings-has-no-provider-field`
  - `exam-date-survives-fresh-profile` (the §0.1 correction's test)
  - `refusal-states-render` (401/expired/offline)
  
  Failing. Push.
- **07a.2** Shell + auth screens. Push. *Proven: the auth legs.*
- **07b.1** Setup + settings (+ conflict state on `409`). Push.
- **07b.2** Dashboard reading MFP-05b's list (until it lands: an empty state with the route marked pending; the leg counts only once 05b is merged). Push.
- **07b.3** Retire `provider-config-browser-check` and `account-ui-browser-check` (ledger: RETARGET → this check's legs). Push. *Proven: CI green.*

| | |
|---|---|
| Discrimination | Write the learner's draft text to `localStorage` in a scratch build → `no-learner-state-in-web-storage` fails. Translate one nav label when `language=en` → `nav-identical-across-language` fails |
| Dependencies | MFP-02b (configured runtime only). The dashboard leg depends on MFP-05b |
| Parallel | MFP-05a/05b, MFP-06a/06b, MFP-04a. **Disjoint paths**, except `owned-client.js`, which this slice does **not** edit |
| Must NOT | Import `store.js`, `account.js`, `exam.js`, `ui.js` or `app.js`; build plan/review/progress/mock/listening/upgrade screens; show sample data; add a framework |
| Needs Ron? | **R13 (light):** "Fonts/logos from `D:\B1_Prep\design` get copied into the repository with their licence files. Confirm you hold the right to the logo artwork." |

### MFP-08 — CLIENT-WRITING: the writing journey end to end

| | |
|---|---|
| Purpose | In the new client a learner picks a servable task, writes with visible autosave and conflict handling, submits, sees pending, leaves, and later (on a **fresh browser profile**) sees the exact text and saved feedback, or an explicit "unbewertet"/retry state on failure. They can then revise into a new attempt |
| Base | after MFP-05b, MFP-06b and MFP-07a |
| ALLOWED PATHS | `public/app/**`, `public/js/draft-session.js` (only if a defect is found; record it), `tools/app-browser-check.mjs`, `tools/journey-api-check.mjs` (from MFP-14; extend), `work/implementation/MFP-08.md` |
| Effort | 2 d **[G]**, split: 08a (task list + draft + submit + pending), 08b (result + failure + retry + revise + fresh-browser) |

Steps:
- **08a.1** Checker legs `pick-task-draft-autosave`, `submit-once-under-double-click`, `pending-survives-reload`. Push.
- **08a.2** Implement. Push.
- **08b.1** Checker legs:
  - `fresh-profile-sees-exact-text-and-feedback`
  - `failed-or-pending-assessment-renders-unassessed` (replaces §1.2 P1–P3)
  - `retry-after-failure-one-debit`
  - `revise-creates-linked-attempt`
  - `account-switch-shows-none-of-A`
  
  The worker runs with the stub provider in the CI job. Push.
- **08b.2** Implement. Push.
- **08b.3** Retire `writing-surface-browser-check` half (a) (ledger: RETARGET). Push.

| | |
|---|---|
| Discrimination | Render a heuristic score when `assessment === null` → `failed-or-pending-assessment-renders-unassessed` fails. Cache the attempt id only in memory and open a fresh profile → `fresh-profile-sees-exact-text-and-feedback` must still pass (it uses the list route). Then break the list route → the leg fails |
| Dependencies | MFP-05b, MFP-06b, MFP-07a. Blocks MFP-11a |
| Must NOT | Grade in the browser; call any `/api/ai`; store text in web storage; claim a telc score |
| Needs Ron? | No |

### MFP-09 — PROGRESS-LITE + EXPORT

| | |
|---|---|
| Purpose | `GET /api/v1/progress?from=&to=` returns bounded, factual counts of the learner's own attempts, submissions, assessed submissions and per-criterion feedback history (no averages presented as a score, no forecast). `GET /api/v1/export` returns all of the learner's owned rows as JSON. Both have screens in the new client |
| Base | after MFP-05b and MFP-07b |
| ALLOWED PATHS | `server/owned-api.mjs` (**holds**), `server/owned-postgres/adapter.mjs`, `public/js/owned-client.js` (**holds**), `public/app/**`, `tools/owned-api-check.mjs`, `tools/owned-api-pg-check.mjs`, `tools/app-browser-check.mjs`, `work/implementation/MFP-09.md` |
| Effort | 1 d **[G]** |

Steps: checker legs:
- `progress-own-only`
- `progress-bounded-range` (a range of more than 366 days → 422)
- `progress-index-range-scan` (`EXPLAIN` at 50k synthetic rows uses `(owner_id, created_at)`, round-1 §7.3)
- `export-contains-every-owned-table` (driven by MFP-14's catalogue, so a new owned table missing from export fails)
- `export-other-account-empty`

Then implement and record.

| | |
|---|---|
| Discrimination | Add a synthetic owned table in a scratch migration and don't add it to export → `export-contains-every-owned-table` fails |
| Dependencies | MFP-05b, MFP-07b, MFP-14 |
| Needs Ron? | No |

---

### MFP-11a — CUTOVER: the new client becomes the app; the old SPA is deleted

| | |
|---|---|
| Purpose | `/` serves the new client. The old SPA modules, their data serving and their checks are deleted in the same commits, each with a ledger row. A reachable-code inventory shows no import of a deleted module |
| Base | after MFP-08 and MFP-09 |
| ALLOWED PATHS | `public/index.html` (**holds**), `public/js/**` (deletions; `owned-client.js` and `draft-session.js` kept), `public/css/**` (deletions), `data/**` (stop serving: move to `content/source/` or leave unserved by static filter; **no content deleted from git history**), `server.js` (**holds**; static allow-list), `tools/check.js`, `tools/writing-check.js`, `tools/feedback-check.js`, `tools/progress-equal-check.mjs` (+test), `tools/progress-scope-check.mjs` (+test), `tools/mock-outcome-check.mjs` (+test), `tools/writing-surface-check.mjs` (+test), `tools/session-boundary-check.mjs`, `tools/session-boundary-browser-check.mjs`, `tools/writing-surface-browser-check.mjs`, `.github/workflows/ci.yml` (**holds**), `work/implementation/RETIRED-CHECKS.md`, `work/implementation/MFP-11.md` |
| Effort | 1 d **[G]** |

Steps:
1. **Checker first:** `retired-surface-check` gains `static-serves-only-allowlist` (`/data/seed.json`, `/js/store.js`, `/js/ai.js` → 404) and `no-import-of-deleted-modules` (parses `public/app/**` imports). Push.
2. Swap the entry. Push. *Proven: MFP-07/08/09 browser legs green at `/`.*
3. Delete the old modules + `progress-equal`/`progress-scope`/`mock-outcome`/`writing-check`/`feedback-check`/`writing-surface-check`, the legacy browser steps, and the `check.js` sections for deleted modules. Keep the `blueprint` section if `blueprint.js` is retained for `exam-blueprint-check`; otherwise delete it. One commit per group, each with ledger rows. Push each.
4. Record. Push.

| | |
|---|---|
| Discrimination | Restore `public/js/store.js` and import it from `public/app/` → `no-import-of-deleted-modules` fails. Request `/js/store.js` → must be 404 |
| Dependencies | MFP-08, MFP-09. Blocks MFP-12 |
| Must NOT | Delete learner records; delete `data/**` from history; delete `exam-blueprint-check`, `objective-fixture-check` or `feedback-case-check` (content fixtures keep their value for MFP-13 and C-05) |
| Needs Ron? | **R0 confirmation** that the old SPA's features in §4.1 D8–D11 disappear from the product at this point |

### MFP-11b — tooling cleanup (parallel-safe, small)

| | |
|---|---|
| Purpose | Delete the untracked-by-CI legacy tools in D19, each with a ledger row, and close PR #74's scope with a pointer |
| Base | after MFP-11a |
| ALLOWED PATHS | the D19 files only; `package.json` scripts block (**holds**); `work/implementation/RETIRED-CHECKS.md` |
| Effort | 0.25 d **[G]** |
| Check | CI green; `grep` for each deleted script name in `package.json`/`ci.yml` → only ledger matches |
| Needs Ron? | No |

---

### MFP-12 — JOURNEY: two strangers, the whole MFP, failures included

| | |
|---|---|
| Purpose | On a fresh disposable PG with only `migrate` + server + worker (stub provider) + email stub, two invited strangers complete J1–J11 on desktop (1440) and phone (390) viewports. The run includes slow, failed and malformed provider output, a duplicate click, a reload during pending, an account switch, a reset, export and hard delete with a late job. Recorded counters; no fallback paths exist |
| Base | after MFP-04b and MFP-11a |
| ALLOWED PATHS | `tools/journey-api-check.mjs`, `tools/app-browser-check.mjs`, `.github/workflows/ci.yml` (**holds**), `work/implementation/MFP-12.md` |
| Effort | 1 d **[G]** |

Steps: extend MFP-14's journey harness to all legs → browser legs at 2 viewports → record (screenshots, exact commit, counts, **explicitly open gates**).

| | |
|---|---|
| Discrimination | Each leg's broken variant comes from the earlier slices' discrimination legs, replayed against this head |
| Acceptance | All legs green in CI; `retired-surface-check` green; RETIRED-CHECKS complete. The record lists as **open**: E-01, C-03/C-04/C-06, P-03/X-01, real iPhone/Android, live provider, email provider, hosting |
| Needs Ron? | **Yes, at the end:** "The MFP runs end to end on stubs. Which of R5, R10 and hosting do you want to authorize next?" |

---

### MFP-13 — OBJECTIVE-LITE (conditional on R1/R3): Lesen + Sprachbausteine, server-marked

13a is server, 13b is client. About 1 d each **[G]**.

| | |
|---|---|
| Purpose | The 15 LV/SB sets load as task versions, with keys in `task_key` (no grant to any runtime role). `POST /api/v1/attempts/:id/mark` marks through a `SECURITY DEFINER` function, revealing the correct answer and the German `why` only after submission. The new client renders runners for LV1–3 and SB1–2, and shows "Erklärung nur auf Deutsch" when the chosen language isn't German |
| Base | after MFP-11a (it needs the new client) and **R1 + R3** |
| ALLOWED PATHS | 13a: `server/migrations/0012-*.sql` (**holds**), `server/owned-postgres/content-seed.mjs`, `server/owned-api.mjs` (**holds**), `server/owned-postgres/adapter.mjs`, `tools/objective-check.mjs` (new), `tools/objective-fixture-check.mjs` (reuse fixtures). 13b: `public/app/**`, `public/js/owned-client.js` (**holds**), `tools/app-browser-check.mjs` |
| Checks | `no-key-in-task-payload`, `learner-role-cannot-select-task-key` (round-1 E1), `mark-is-deterministic` (against `objective-fixture-check`'s hand-reviewed fixtures), `answer-revealed-only-after-submit`, `listening-families-not-servable` |
| Discrimination | Grant `SELECT` on `task_key` to the learner role → `learner-role-cannot-select-task-key` **and** MFP-14's table-class check both fail |
| Needs Ron? | **R1, R3** before dispatch |

### MFP-14 — CHECKS-NOW: the table-class catalogue check and the journey harness skeleton

Details are in §5.3, dispatch 3.

---

### 5.1 Dependency graph and parallelism

```
MFP-00 ──► MFP-01 ──► MFP-02a ──► MFP-02b ──► MFP-05a ──► MFP-05b ──┬─► MFP-08 ──► MFP-11a ──► MFP-12
   │                    │  │                       │                 │      ▲           │
   │                    │  └──► MFP-06a ──► MFP-06b ◄┘                 │      │           ├─► MFP-11b
   │                    │                    └──────────────────────────┼──────┘           └─► MFP-13 (R1,R3)
   │                    └──► MFP-04a (R4,R6) ──► MFP-04b (R5 port) ─────┼──────────────────────► MFP-12
   │                                  MFP-02b ──► MFP-07a ──► MFP-07b ──┴─► MFP-09 ──► MFP-11a
MFP-03 (spike, parallel from t=0) ──► Ron R4..R7
MFP-14 (parallel from t=0; catalogue check gates MFP-09 export leg and every later migration)
```

**Can run at the same time (disjoint ALLOWED PATHS, verified against the "holds" lists):**
- {MFP-00, MFP-03, MFP-14}
- {MFP-01, MFP-03, MFP-14}
- {MFP-05a, MFP-06a, MFP-07a}, but MFP-07a holds `ci.yml`, so MFP-06a/05a add no CI step until it merges
- {MFP-05b, MFP-06b, MFP-07b}
- MFP-04a and MFP-04b alongside the 05/06/07 group, **except** that `server/owned-api.mjs` is serialised: 04a's auth-block edit merges before 05a's route edit is dispatched, or 05a is dispatched first and 04a rebases. The coordinator picks one and writes it into both dispatches.

### 5.2 The critical path

**MFP-00 (0.5–1) → MFP-01 (1) → MFP-02a (1) → MFP-02b (2) → MFP-05a (1) → MFP-06a (1.5, can overlap 05a) → MFP-06b (1.5) → MFP-08 (2) → MFP-11a (1) → MFP-12 (1).**

That's about 12–13 serial days with ideal overlap, and **about 15–17 days [G]** with review and merge latency at this programme's observed pace. Auth (MFP-03 → R4 → 04a → 04b, about 3 days of work plus Ron's response time) runs alongside and must finish before MFP-12. **If Ron's R4–R6 answers take longer than about 8 working days, auth becomes the critical path.** The content decision (R1/R2) must be answered before MFP-12 can show a servable task under the production policy. Until then MFP-12 runs with `approved+unreviewed` and says so.

### 5.3 The first three dispatches — dispatch-ready

**Dispatch 1 — MFP-00 (coordinator)**, exactly as specified above.
- Base `codex/integration-01` @ `08acb21`; merges `86eab13`, then `1a5a34c`.
- Branch: `codex/mfp-00-integrate`.
- **ALLOWED PATHS:** `server.js` (conflict hunks only), `tools/coord-config-anon-probe.mjs`, `tools/saas-runtime-check.mjs`, `.github/workflows/ci.yml`, `work/implementation/RETIRED-CHECKS.md` (new), `work/implementation/MFP-00.md` (new), plus the files #82/#83 introduce, verbatim.
- Checkpoint after each of the 5 steps (push). Expiry: 1 day.

**Dispatch 2 — MFP-03 AUTH-SPIKE (any worker; no shared files).**
- Base `08acb21`, into a **disposable directory outside every worktree**.
- Branch: `codex/mfp-03-auth-spike`.
- **ALLOWED PATHS (in the repository): `work/implementation/AUTH-SPIKE-01.md` only.**
- Disposable: `%TEMP%\mfp03-*\**` (deleted on completion; the record states it was).
- Disposable PG: allowed, synthetic data, refuses `postgres`/`template*` databases.
- Must NOT: modify root `package.json`, `spikes/**` or any `server/**`.
- Output: the three facts with verbatim command output and each discrimination leg. Then it stops, because R4 is Ron's.
- Expiry: 0.5 day.

**Dispatch 3 — MFP-14 CHECKS-NOW (any worker).**
- Base `codex/integration-01` @ `08acb21`. It must also pass on the MFP-00 head: the dispatcher re-runs it there before merge.
- Branch: `codex/mfp-14-checks-now`.
- **ALLOWED PATHS:**
  - `tools/table-class-check.mjs` (new), `tools/table-class-check.test.mjs` (new)
  - `tools/journey-api-check.mjs` (new)
  - `tools/lib/catalogue.mjs` (new; shared catalogue reader used by MFP-09's export leg)
  - `work/implementation/MFP-14.md` (new)
- **No `ci.yml`** (MFP-00 holds it; the coordinator adds the steps after MFP-00 merges). **No `server/**`.**

Steps:
1. Record skeleton. Push.
2. `table-class-check` (round-1 C3), on a disposable PG provisioned by the existing `provision.mjs`. It classifies every table in the app schema as **auth** (Better Auth tables: no RLS, auth role only), **owned** (has `owner_id`/`user_id`: FORCE RLS, an owner policy for the learner role, an FK to `"user"`, and present in `ACCOUNT_TABLES` at `adapter.mjs:243-250`) or **shared content** (#82's `content_version`/`task_version`/`rubric_version`: no runtime INSERT/UPDATE/DELETE grant, immutability trigger present). **An unclassified table fails.** Push.
3. The `.test.mjs` mutation proof, in a scratch schema:
   - drop one owner policy
   - remove one table from a copy of `ACCOUNT_TABLES`
   - grant INSERT on `task_version` to the learner role
   - add an unclassified table

   Each must fail the check. Push.
4. `journey-api-check` skeleton: J1–J11 as HTTP-level legs against a configured runtime. Legs whose route doesn't exist yet report `PENDING <slice-id>` and **don't count as passes**, so the summary prints `n passed, m pending, 0 failed`. A leg reports FAIL only on a wrong answer from an existing route. Push.
5. Record: a verbatim run on `08acb21` and, if available, on the MFP-00 head. **If the table-class check finds a real violation on the current head, record it as a defect with its fix owner (MFP-02a or MFP-05a) and don't weaken the check.** Push.

| | |
|---|---|
| Discrimination | Step 3's four mutations |
| Acceptance | table-class: 0 failures on the base (or recorded defects); mutation test 4/4 detect; journey: 0 failed, PENDING legs named per slice |
| Expiry | 1 day |
| Needs Ron? | No |

### 5.4 What must NOT be started yet, and its specific blocker

| Don't start | Specific blocker |
|---|---|
| AI-METER-01 | **Superseded:** `/api/ai` is deleted in MFP-02b (D3). Metering it is wasted work |
| SAAS-MODEL-01b (`content_review` log, `prompt_version`/`task_key` tables as a schema slice), TABLE-CLASS as part of it, ROUTES-01's ~20 routes | Superseded by MFP-05/06/09/13, each of which builds the table with its consumer (D16). TABLE-CLASS is MFP-14 |
| SAAS-RETIRE-01 as a separate cutover | Replaced by MFP-02b + MFP-11a/b, which remove as they replace |
| Finishing #82's removal-matrix document | D17. MFP-02b/11's checks plus the ledger are the matrix |
| MFP-04a/04b (auth build) | **MFP-03's facts + Ron R4 (dependency), R6 (invite-only)**. MFP-04b's real provider waits on R5 (the stub doesn't) |
| MFP-13 objective practice | **R1 (rights) and R3 (in or out of MFP)** |
| Any live-provider evaluation or C-05 run | **R10:** live AI is not authorized |
| DESIGN-02..07 beyond MFP-07/08/09's screens; the 5-language pipeline; RTL corpus | Not in the MFP (D12, D13). Restart after MFP-12 with a content plan |
| Legacy import | R7/R8 |
| practice_event / SRS / plan schema, the "self_reported authority" decision | D11. The features are dropped, so the decision is moot |
| Any deployment, DNS, email or payment configuration | Not authorized (brief). Human gate |
| Changes in `public/js/` old modules (except deletion in MFP-11a) | D7. Any edit there is work thrown away within about 2 weeks |
| A replacement for `mock-outcome-browser-check` against the mock view | The mock view is dropped. The replacement targets the writing result (MFP-08) |

### 5.5 Checks to write now, before their slices

Each is cheap, fails before the harm, and none needs a decision:

1. **`table-class-check` + mutation test** (MFP-14). It must exist before migration `0008` adds anything. It guards the round-1 "most dangerous #2" (deletion/RLS drift).
2. **`journey-api-check` skeleton with PENDING legs** (MFP-14). It turns "functional" into a counter that moves.
3. **`retired-surface-check`** (written at MFP-02b step b1.1, but it can be authored now inside MFP-14's dispatch if capacity allows; add `tools/retired-surface-check.mjs` to dispatch 3's ALLOWED PATHS only if so). Its legs are listed in MFP-02b. On `08acb21` it fails, which is the point: it measures the removal.
4. **`migrate-check`** (MFP-01 step 1). It fails on the base, by design.
5. **`worker-check`'s lease legs** against the existing fixture worker. `stale-lease-cannot-complete` **fails today** (`fixture.mjs:115-133` has no lease predicate) and documents the gap before MFP-06a closes it.
6. **The `exam-date-survives-fresh-profile` leg** (MFP-07a). It settles the §0.1 disagreement with the brief by execution rather than by my reading.

---

## 6. Questions for Ron, in priority order

| # | Question | Why it matters | Default if unanswered |
|---|---|---|---|
| **R1** | The 6 writing prompts (`public/js/ai.js:837`, `OFFLINE_WRITING_TASKS`) and the 15 Lesen/Sprachbausteine sets in `data/seed.json`: **who wrote them, and does Hatoove own the rights?** (One line per source is enough. It becomes `rights_status`.) | Without it, nothing is servable under any honest production policy | Everything stays `rights_status='unknown'`; production policy serves nothing |
| **R2** | For an **invite-only pilot**, may learners see content marked `unreviewed` with a visible label, while E-01/C-03 review stays open? Or must a qualified reviewer approve each prompt first? | Decides whether MFP-12 is "functional" with today's content or waits for human review | `approved` only (fail-closed) |
| **R3** | Should objective practice (Lesen + Sprachbausteine only, 15 sets, explanations in German only) be **in** the first product, or should we launch **writing-only**? | MFP-13 is 2 d of work off the critical path | Writing-only; MFP-13 after MFP-12 |
| **R6** | Is the pilot **invite-only**? How many invites, and how many feedbacks each (**R9**)? | Abuse control and allowance without checkout | Invite-only; 10 feedbacks per learner (the existing synthetic default, `fixture.mjs:35`) |
| **R7** | Does **any** persistent installation have **real** (non-test) accounts today? | If zero: no password-hash migration, no import question, simpler auth swap | Treat as zero, and say so in MFP-04a |
| **R8** | Must any learner's old history (the `progress.json` or browser data) survive? | If no, legacy import is dropped for good | Dropped |
| **R4** | (after MFP-03) Adopt Better Auth, ending "the root app has no dependencies", or harden our own session code (about 0.5–1 d more, and more security-sensitive)? | Auth build path | Wait. MFP-04 doesn't start |
| **R5** | Which email provider will eventually send reset/verification mail? (It's a data processor for P-03.) Or will the pilot use operator-assisted resets? | J11 | Build against the stub; no real provider |
| **R10** | When may the worker call the live model (DeepSeek via GreenPT, per `IMPLEMENTATION_PLAN.md:224`) for real learners? | Without it, feedback is a stub | Stubs only |
| **R11** | Ship writing feedback labelled "formative feedback, not a telc score", using the current 4 internal criteria marked `unreviewed`, until E-01 settles the official 3 criteria? | Avoids blocking on E-01 while staying honest | Yes, labelled |
| **R12** | Explanation-language setting: offer all five (de/en/uk/ar/tr) for model-written feedback, labelled "not natively reviewed" until C-06? Or only de + en at first? | Ron decision 4 says the setting must work. C-06 gates the wording | All five, labelled |
| **R0 / R13** | Confirmations: the repository's old single-user app stops working at MFP-02b and its features (§4.1 D8–D11) leave the product at MFP-11a. The logo/font assets from `D:\B1_Prep\design` are ours to copy with their licences | Acknowledging the drops | Proceed, recorded as acknowledged-by-instruction |

---

## 7. LIMITS

- **No PostgreSQL and no browser were used.** Every statement about RLS, grants, `SECURITY DEFINER`, migrations, triggers, the worker's transactions and rendered client behaviour is a **reading**. In particular, the claims that (i) the four remaining browser steps pass under #82 and (ii) a signed-in learner's exam date loads on a hosted runtime are **[R]**, each with a named check that would settle it (§0.1, MFP-00 step 4, MFP-07a).
- **CI facts come from `gh` read-only queries on 2026-10-01** (runs `36828539892`, `36829834111`). One failing run of #83's browser job doesn't distinguish a flake from an environment defect.
- **All effort figures are guesses**, calibrated only on this programme's visible slice sizes, not on measured throughput. The total (about 15–17 engineer-days to MFP-12) excludes human review time, which nobody has measured.
- **"About 8,000 client lines removable" and "about 9 of 21 suites"** are estimates from file sizes and the CI step list, not a reachability analysis. MFP-11a's `no-import-of-deleted-modules` leg is the real measurement.
- **I didn't open `D:\B1_Prep`** (design or otherwise), PR #74's content, or the `CURRENT.md`/`BOARD.md` lease state. Dispatch bases must be re-checked against live heads, and the "holds" assignments against live leases.
- **Better Auth behaviour** (hash compatibility, `node:http` mounting, DB rate-limit storage, hooks) isn't asserted here. That's MFP-03's job.
- **Recommending a new client over retrofitting** is a judgement. It rests on the volume of fence/boundary work recorded in this repository and on Ron's instruction, not on a measured comparison. The evidence that would overturn it: if MFP-07a takes more than about 2× its estimate, re-evaluate before MFP-08.
- **This plan closes no gate.** E-01, C-03/C-04/C-06, P-03/X-01, real-device evidence, live AI, email, hosting and payments remain open and human-owned.
