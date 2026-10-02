# FEATURE PARITY — porting the single-user app to multi-user, function by function

| | |
|---|---|
| Asked by | Ron, 2026-10-01 |
| The requirement, verbatim | *"we need to maintain the functionality but port it to a saas implementation same functions as there were for one user now for multiple users"* |
| Method | the left column below is read out of the code at `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e`; every "where it lives" and "what it assumes" cell was checked in the source, not recalled |
| Rule this document exists to enforce | **no function may be dropped in the port, and no function may be marked ported without a checker that runs it as a signed-in account** |

## 1. The app's functions, as they exist today

| Function | Where it lives | What it does for one user | What it assumes |
|---|---|---|---|
| Onboarding / exam date | `app.js`, `settings` view | sets exam date, daily goal, model, theme | one learner, one browser |
| Dashboard | `dashboard.js` | countdown, today's plan, stats | the single progress record is *the* learner |
| Adaptive practice (drills) | `generators.js`, `engine.js` | generates items from the learner's weak tags | the ability model belongs to one learner |
| Objective practice + marking | `exam.js`, `engine.js` | per-part scoring, immediate feedback | answers are the single learner's |
| Mock exam | `exam.js` | timed blocks, completion gate, results view | one in-flight mock |
| Writing feedback | `ai.js` | sends the text to the provider, renders formative feedback | the provider key is local, the learner owns the machine |
| Writing outcomes | `mock-outcome.js`, `exam.js` (WRITING-OUTCOMES-02) | unassessed stays unassessed; no pass/grade claim | unchanged by tenancy |
| Error notebook | `store.js` (`addError`), a view in `app.js` | collects mistakes for review | single unscoped notebook |
| Progress + history | `store.js`, `progress-merge.js`, `server.js` progress routes | one merged record: counters, nodes, history, srs, days, planDone | one record, one file |
| Study plan | `engine.js` (`studyPlan`, `planHorizon`) | dated plan to the exam | one exam date |
| Settings | `app.js` settings view, `server.js` `/api/config` | exam date, model, key, theme | the browser may set the provider key |
| Export / recovery | `tools/recover-progress.js`, portable build | backup and move the record | the files are the learner's own |
| Practice audio / speech | `speech.js`, `tts-check.js` | browser TTS for listening and speaking | outside the pilot scope for speaking |

## 2. The same functions, as a multi-user port

| Function | Multi-user form | Status | Evidence, or what is missing |
|---|---|---|---|
| Account identity | sign-up, sign-in, sign-out, session | **mounted and proven at the API and server level** | `tools/accounts-http-check.mjs` drives real server processes over real HTTP: sign-up, session resolve, sign-out invalidating the old cookie, cross-owner 404, origin gate. **The UI surface does not exist yet** |
| Owned attempts / drafts / submissions | per-account rows, FORCE RLS, restricted roles | **built and proven** | `owned-api-check` 24/24 on memory **and 24/24 on a persistent PostgreSQL installation**; `postgres-provision-check` 5/5 |
| Dashboard | rendered from the **signed-in account's** record | **not ported** | needs (a) the settings/progress record to be account-scoped in the running app and (b) the account UI |
| Adaptive practice | ability model per account | **not ported** | `ability` sits inside the single progress record; F-4's account scoping is the seam and has no production caller yet |
| Objective practice + marking | per-account attempts and scoring | **not ported** | marking is client-side over the account's own items; content is shared, results must be private |
| Mock exam | one in-flight mock **per account** | **not ported** | `session` state is browser memory; the completion gate must key on the account |
| Writing feedback | provider call **via the server**, key server-side | **not ported, and blocked on a decision** | today the browser writes `DEEPSEEK_BASE_URL` into a server `.env`. On a shared server the key must be operator-only, so this needs Ron's decision before it can be ported honestly |
| Writing outcomes | unchanged behaviour | **ported already** | `mock-outcome-check` 19/19 with pre-fix discrimination; the honest-outcome rules are tenancy-independent |
| Error notebook | per-account notebook | **not ported** | part of the progress record; same seam as the dashboard |
| Progress + history | per-account record, one authoritative store | **store ported, app not wired** | `progress-scope-check` 7/7 proves isolation, the one-time legacy adoption and fail-closed sign-out — **with no production caller**. The open design question is which store owns "performance" (see `AUTH-USER-AUDIT.md` §3.3) |
| Study plan | per-account exam date | **not ported** | needs the account-scoped settings record |
| Settings | account-scoped server record | **not built** | there is no settings table and no route; today `settings` is inside the unscoped progress blob |
| Language | account-scoped, and it is **not a feature yet** | **not built** | no language setting exists in the code, and reviewed native-language explanations are the open human gate `C-06` |
| Export / recovery | per-account export and deletion | **partially ported** | `DELETE` semantics proven (`reset-check` 9/9, `revision-check` 8/8); F-5 (app-created backups inside the deletion path) is in PR #59 |
| Practice audio | shared content, per-account progress | **not ported** | `C-04` (rights) is a human gate; the porting itself is trivial once content exists |

## 3. The porting pattern, stated once

Every function above ports by the same three moves, and nothing else about it changes:

1. **The learner's identity stops being implicit.** One `owner_id` comes from the verified session instead of
   being assumed.
2. **The store stops being shared.** The record is selected by that owner — in PostgreSQL through `FORCE ROW
   LEVEL SECURITY`, which is already proven, rather than by application discipline.
3. **The behaviour stays identical.** The same generators, the same scoring, the same formative-feedback rules,
   the same appearance. **A parity regression is a defect, not a redesign opportunity.**

## 4. What "ported" will be allowed to mean

A function is **ported** only when a checker runs it **as a signed-in account** and shows that:

- the same behaviour occurs as for the single user (same outputs for the same inputs);
- a second account cannot see, change or inherit any of it;
- it survives sign-out and sign-in **on a new process** (the restart property, already proven for
  session + draft in `accounts-http-check`);
- and it survives with the **account-scoped store** as the source of truth, not the legacy blob.

A function that merely still works while a single anonymous user is present is **not** ported, and this document
exists so that distinction cannot be quietly blurred.

## 5. What this changes about the order of work

The porting order follows the dependency the app already has, smallest first:

1. **Account surface** (sign-up / sign-in / sign-out in the existing shell) — nothing above can be exercised
   without it; the server side is already proven.
2. **Account-scoped settings** (exam date, daily goal, model, theme) — needed by the dashboard, the study plan and
   the practice engine, so it is the cheapest way to make several functions account-aware at once.
3. **Point the dashboard, notebook and practice at the account-scoped progress record** (F-4), and settle which
   store owns performance.
4. **Objective practice and the mock exam** on per-account attempts.
5. **Writing feedback via the server**, once key custody is decided.
6. **Export and deletion** per account, closing F-5 and F-6 honestly.

**No gate is closed by this document.** `E-01`, `C-04`, `C-06`, `P-03`/`X-01` and real-device evidence all remain
open, and nothing here is an exam-validity, security or privacy approval.
