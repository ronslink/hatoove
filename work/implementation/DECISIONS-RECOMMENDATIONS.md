# Decision recommendations — Hatoove

**What this is.** A recommendation for every open decision, each with **how to implement it in this
repository**. Prepared 2 October 2026 by the local agent, with an independent second pass on the
product/content decisions (recorded below where it changed or sharpened the recommendation).

**What this is not.** A decision. Two classes of item cannot be settled here at all: (a) anything needing a
qualified telc-B1 reviewer or a lawyer, and (b) commercial judgements (price, market, budget). Those are
marked **HUMAN** in every row, and a recommendation is not a substitute for them.

**Reading order.** §0 records three corrections to this document's own premises, found by an independent
runtime review and **verified in the tree**. §1 is the answered decision and its implementation recipe. §2
blocks the most. §3 is everything with a working default. §4 is engineering hygiene. There is a suggested
running order at the end.

---

## 0. Corrections to this document, verified (2 October 2026)

An independent review challenged three claims, and the tree confirms it on all three. They are recorded
first because two of them changed a recommendation.

| Claim in the first draft | What the tree says | Consequence |
|---|---|---|
| "`table-class-check` needs a live PostgreSQL, so move it into the postgres CI job" | **Already there**: `.github/workflows/ci.yml:155` runs it, `:161` runs its four-mutation proof, both inside the `postgres` job with a service container | **No work needed.** The recommendation is withdrawn |
| "`journey-api-check` spawns a *retired host runtime*; retire it" | **Already a CI gate** (`ci.yml:167`), and `node server.js` **is the container entrypoint** (`compose.yaml:65`: `command: ["node", "server.js"]`). The retired thing was the *host launcher* (`npm start` is now `docker compose up -d --build`) | **Recommendation reversed**: rewrite it, do not retire it. It is entrypoint-contract testing, not a second runtime |
| "D5 adopting Better Auth trades away `"dependencies": {}`" | Root `package.json:21` is `{}`, and the platform **already has the pattern that keeps it**: `server/owned-postgres` is an `npm --prefix` sub-package with its own lockfile, and the auth spike kept the same shape (`better-auth` 1.7.6 + `pg` 8.23.1, with a generated `auth-schema.sql`) | **Recommendation strengthened**: adopt it *in a sub-package*, so the root property survives |

**And the finding that matters most, which I verified by running it: the `postgres` CI job is RED today.**
`journey-api-check` fails its single leg **J4** — *"tasks answered 422 for family=SA1, the blueprint's
writing part id"* — 5 passed, 5 pending, **1 failed**. It was previously *masked*: a `session-boundary-check`
step ran before it and failed first, and a step after a failing step is **skipped**. That check was retired in
SPA-RETIRE 4, which **unmasked** this. So the family-naming defect is not hygiene — it is the one thing
standing between the repository and a green CI job, and the family decision below is therefore promoted to
the top of the running order.

**A defect I left behind, now fixed.** Deleting 22 SPA tool files in SPA-RETIRE 4 left six `package.json`
scripts pointing at them: `check`, `test:e2e`, `test:ai`, `tts`, `ai:live`, `mock:ai`. `npm run check` died
with `MODULE_NOT_FOUND`, and **`npm run tts` advertised a speech diagnostic that no longer existed** — a
false signal that a TTS integration is present, which is exactly the wrong thing to leave lying next to the
open **D8** decision. The scripts now name the surviving checks (`check`, `check:db`, `check:docker`), and
`tools/repository-check.mjs` gained a leg that **fails the build when any script names a file that is not
tracked** — proven by pointing one at a missing file and watching it go red. A script name is a claim about
what the project can do; the next deletion will do the same thing.

---

## 1. D4/R11 — ANSWERED (three-criterion telc B1 rubric). How to build it.

Settled by Ron: the writing feedback follows **the exam's own marking structure**. Bands A/B/C/D =
5/3/1/0, ×3, written max 45. The four-criterion rubric is **retired**; the two are never renormalised.

**Implementation recipe, in order. The first three steps are the contract; the fourth is the screen.**

1. **A new rubric as data, not a rewrite.** Add `TELC_B1_WRITING_RUBRIC` to
   `server/owned-postgres/content-seed.mjs`: `rubricId: 'writing.telc-b1'`, `version: 'v1'`,
   `examId: 'telc-deutsch-b1'`, three criteria (`aufgabe`, `kommunikation`, `richtigkeit`) each with
   `bands: { A: 5, B: 3, C: 1, D: 0 }`, `factor: 3`, `max: 15`, and descriptors **written independently**
   (criterion NAMES may be used; telc's published descriptor text may not be copied). Mark the descriptors
   `provisional`, and keep the seeded rows `review_status = 'unreviewed'` until E-01.
2. **Migration `0017-telc-b1-rubric.sql`.** The catalogue is immutable (`content_immutable` trigger refuses
   UPDATE/DELETE), so binding the tasks to the new rubric means **new rows**: one `content_version` per new
   task version plus one for the rubric, the `rubric_version` row
   (`('writing.telc-b1','v1','writing','<criteria with bands>',45,'writing.telc-b1@v1')`, `exam_id =
   'telc-deutsch-b1'`), and six `task_version` rows at **v2** bound to `writing.telc-b1`/`v1`. The prompt
   text and Leitpunkte do not change — this is a re-binding, not new content — so the digest guard in
   `owned-api-check` (`content-seed-and-the-seeded-migration-agree`) must be updated in the same commit.
3. **Serve the newest version of a task.** With v1 and v2 both present and both `unreviewed`, the catalogue
   would show each prompt twice. `listTasks` (adapter **and** the memory fixture) should return
   `DISTINCT ON (task_id) … ORDER BY task_id, created_at DESC`. That is a general rule worth having anyway
   (it is what makes content updates possible at all), and it is asserted by a new
   `owned-api-check` leg: **one entry per task id, and it is the newest**.
4. **The worker contract, validated.** `feedback` becomes
   `{ kind: 'telc-b1-bands', criteria: [{ key, band, evidence, comment }], corrections: [...] }` — **no
   numbers anywhere**, which is how the unresolved R15 (bands only vs total /45) stays unresolved instead of
   being decided by accident. `validateAssessment` becomes rubric-aware: exactly the rubric's criteria, once
   each; `band ∈ {A,B,C,D}`; `evidence` non-empty **and a quoted substring of the learner's text**; `comment`
   non-empty; `corrections` an array of strings. Anything else is the existing classified failure
   (`invalid_assessment`) — "Unbewertet", text preserved, reservation refunded, **never a partial grade**.
   The claim query must also select `attempts.rubric_id` so the validator knows *which* rubric to check
   against.
5. **The snapshot of the explanation language.** "a comment in the job's snapshotted explanation language"
   needs the language fixed at submit time, not read later: migration adds
   `submissions.explanation_language text NOT NULL DEFAULT 'de'`, the submit route stamps the learner's
   current `settings.language`, and the worker passes it to the grader. A leg asserts that changing the
   language afterwards does not rewrite an existing submission's language.
6. **The screen (PILOT-08).** Per criterion: label, band letter, the quoted evidence, the comment; then the
   corrections; the label **"Übungsfeedback nach den telc-Kriterien – keine offizielle Bewertung"**; and
   **no total** (R15 default). An assessment graded under the retired rubric still renders as the comment it
   is — *that is the "never renormalise" rule in the UI*, and it needs a leg.
7. **Human gates that stay open.** **E-01**: a qualified reviewer must confirm the criteria and band values
   against telc's current model exam (the blueprint itself lists the 2020-edition question). Building the
   structure is authorized; calling it accurate is not. **R15** and all descriptor wording likewise.

---

## 2. What blocks the most

### D1 — Content rights (blocks serving anything in production) — **HUMAN**
**Recommendation: decide per row, not once.** (a) AI-generated-in-this-project → record that provenance
honestly; (b) anything traceable to the older prototype → obtain a written assignment/licence; (c) rows
nobody can attribute → stay fail-closed and unserved.

**How to implement.** `source_path` on `content_version` is already the join key. Produce a
one-line-per-source provenance table (source → author → arrangement → resulting `rights_status`), then a
migration that inserts **new content_version rows** with the honest `rights_status` (the table is immutable,
so a corrected status is a new row, and the serving policy reads the newest). Serve the attributable
majority immediately; keep fail-closed only for the blanks.
**Why not the alternatives.** A blanket "AI-generated" claim is only truthful if someone can show which
rows qualify; a blanket licence hunt blocks 100% of content on the hardest 5%.
**Human:** whoever authored the prototype material must confirm or assign it in writing, and a legal read on
format-teaching with original items.

### D13 — Pool target size and who reviews (blocks filling the pool) — **HUMAN on the names, workable now**
**Recommendation: per-family targets as a multiple of measured weekly consumption (~4 weeks of median
learner throughput, floored at 3 independent items per skill), with **one qualified reviewer at 100% for
writing prompts and model answers** and a **blind second-reviewer spot-check of ≥20%** for objective items.

**How to implement.** Publish the numbers as configuration (family → target → review mode), not code. Add
the "what did this learner see" join so a bad pooled item can be corrected retroactively — `item_evidence`
already records `set_id`/`version`/`item_id` per answer, so the correction path is a query plus a status
change, not new plumbing.
**Why.** Pooling makes one bad item universal; writing volumes are tiny (6 prompts) so 100% review is
affordable, while objective items are proportionate to spot-check **only if** correction reaches learners.
**Human:** name the reviewer (telc-B1 competence, near-native German) and the generation budget ceiling.

---

## 3. Decisions with a working default — confirm or adjust

### D5 — Auth library — **Recommendation: adopt Better Auth, in a sub-package, for authentication only.**
**The schema is already Better Auth's**: `user`/`session`/`account`/`verification` with camelCase columns
and `emailVerified` (migration `0001-auth-schema.sql`). So this is **wiring, not migration** — and the root
`"dependencies": {}` property can survive it, because `server/owned-postgres` already demonstrates the
pattern: an `npm --prefix` sub-package with its own lockfile. The spike kept exactly that shape
(`better-auth` 1.7.6 + `pg` 8.23.1, plus a generated `auth-schema.sql`).
**How to implement.** New `server/auth/` sub-package; adopt the spike's generated SQL as a **frozen
migration** applied only by `server/migrate.mjs`; replace the internals of
`server/owned-postgres/sessions.mjs` (the port seam is `getSession`/`signUp`/`signIn`/`signOut`, which is why
this is reversible) while keeping `createOwnedApi`'s contract (`{ id, email }` or null) unchanged. Do **not**
let it own authorization or any learner table. Write the four missing-behaviour legs **first** — rotate the
token on sign-in and 401 the retired cookie (session fixation), expiry sweep, revoke one session, revoke all
on password change — then prove the boundary did not move with `accounts-http-check` and
`owned-api-check` on both backends.
**Existing data.** Session rows are volatile and droppable; map existing `user` rows by email before
switching reads. Learner rows are not touched.
**Trade away:** you inherit a third party's session semantics and migration history, and "rotate" and
"revoke-all" become their semantics rather than yours. Name that in the commit rather than losing it
silently.
**Human:** password-hashing parameters and the RLS grants for Better Auth's tables (a security signoff), and
the recovery-factor policy.

### D6 — Email provider — **Recommendation: operator-assisted resets for the pilot; wire the token path now.**
**How to implement.** The `verification` table already exists. Build reset/verify as
`POST /api/auth/request-password-reset` + `POST /api/auth/reset-password` writing tokens to that table, with
the **delivery step behind one module** (`server/notify.mjs`) whose pilot implementation logs the link to the
operator console. Then adopting a provider later is one file, and the privacy audit gains one processor
instead of a redesign.
**Trade away:** learners cannot self-serve a reset until a provider exists. **HUMAN:** which provider (a data
processor under P-03) and its terms.

### D8 — Speech synthesis — **Recommendation: browser-first, and treat audio as a content problem.**
**How to implement.** Nothing to build for TTS beyond the honest unavailable state the listening view
already shows. The real work is **audio assets for the listening families** (they have transcripts and
`media_required` flags but no audio): add `audio` to the `objective_set` payload contract, serve it from the
API like every other asset, and only then can the Hören view exist. Server-side TTS stays a later option and
would be a paid processor.
**Trade away:** pronunciation quality on odd devices. **HUMAN:** whether to pay for TTS at all, and who
records/voices the audio.

### D9 — First English exam — **Recommendation: telc-B1-only for the pilot; finish the abstraction now.**
Name the candidate in the record (Cambridge B1 Preliminary is the closest learner overlap) so the schema is
not retrofitted, and write the ADR: *we teach an exam's format with originally written items and never a
board's item bank*.
**How to implement.** `exam_package` already exists (`telc-deutsch-b1`), and `exam_id` is already on
`content_version`, `rubric_version` and `task_version`. The work is to make **rubric and family per exam**
rather than per app: the D4 slice above already introduces `exam_id` on the rubric row, which is exactly the
seam. Add a check that no new column hardcodes telc or B1.
**HUMAN:** which English exam, and the legal position on naming a board in marketing.

### D10 — Live model calls — **Recommendation: keep the stub; define the gate before any live call.**
**How to implement.** The contract from D4 is already the gate: a live grader must return the validated band
shape, per criterion, with quoted evidence, in the snapshotted language. Before enabling live calls, add
(a) a per-account and per-day cost ceiling (the entitlement already exists; add a token/cost ledger beside
`usage_ledger`), (b) a recorded evaluation — one fixed sample of learner texts graded by the model and by a
human, with the disagreement rate written down, and (c) a redaction review, because learner text leaves the
system. All three are checks, not policies.
**HUMAN:** authorization for live calls, and the provider/DPA position.

### D12 — Content-pool fill policy — **Recommendation: demand-triggered batch fill.**
Refill when a family's available pool drops below a threshold; starvation jumps the queue **within** that
batch; cap each batch and set a per-period budget.
**How to implement.** Thresholds as configuration, a `pool_state` view over the catalogue (available items
per family net of what learners have seen), and a worker job type that emits a batch for review rather than
publishing. `item_evidence` already carries the consumption signal.
**Trade away:** no coverage guarantee. **HUMAN:** the budget ceiling and the tolerable unreviewed backlog.

### D14 — What is sold — **Recommendation: per-exam pass with a term, prices per market.**
**How to implement.** Today `entitlements` is keyed by `owner_id` alone with an `allowance`. Freeze the key
now as **(account, exam package, term)** — a migration that adds `exam_id`/`term` to the key while keeping a
compatibility default — and hold prices in `market_prices` from day one, so market two is a row, not a
migration. No UI shows a price yet, which is the cheapest possible moment to change the key.
**HUMAN:** price points, market list, VAT, refund policy.

---

## 4. Engineering hygiene surfaced by this run

### Landing page language — **Recommendation: make the front page German now.**
`public/index.html` is `lang="en"` while `public/app/index.html` and `public/signin.html` are `lang="de"`,
so the language changes exactly at conversion. **How:** translate the strings, set `lang="de"`, and leave one
place where a switch would later mount. **HUMAN:** the German marketing copy, native-reviewed.

### Nine seeded set titles — **Recommendation: author them; keep the fallback in code.**
The placeholders (`LV3 1`) are generator artefacts, and hiding them in the UI conceals a content defect.
**How:** add the nine titles to the same source as the other set metadata and route them through the content
review gate. **HUMAN:** a German reviewer signs them off with the sets they name.

### Phone tabbar — **Recommendation: the design's five, with the rest behind "Mehr".**
Ten in a scroll row means the important ones scroll out of sight, and hidden destinations are functionally
absent while claiming to be present. **How:** pick five by journey (Heute → practice → results first),
implement "Mehr" as a sheet, and instrument both. **HUMAN:** evidence on which destinations are used — which
does not exist yet, so this is a product judgement now and a data decision later.

### Docker-in-CI — **Recommendation: yes, as ONE new job on `ubuntu-latest`, non-blocking at first.**
The two strongest checks in the programme (79 rendered legs; 33 Compose legs) run only on a developer
machine, which means the project's best evidence is unverifiable by anyone else. `ubuntu-latest` has Docker;
Chrome must be installed explicitly and `tools/cdp.js` pointed at it.
**How:** add a `rendered` job that installs Chrome, runs `docker-stack-check` then `app-browser-check`, and
uploads the screenshot directory as an artifact; keep it out of the required-checks list until it has run
green ten times (a flaky required check is worse than none), then promote it. Expect it to be the slowest
job — that is the honest price of the evidence.

### `journey-api-check` — **Recommendation: REWRITE it, do not retire it** *(reversed after verification)*.
It is already a CI gate (`ci.yml:167`), and spawning `node server.js` is **not** a second runtime — that
command *is* the container entrypoint (`compose.yaml:65`). So the check is testing the entrypoint contract,
and its single red leg **J4 is the family defect, not the check**. It is also the only functional counter in
the programme: account → draft → submit → worker → feedback → fresh-browser read-back over real HTTP with a
real worker, plus the negative that a failed assessment stays visible and unassessed. Nothing else does that.
**How to implement, in order.** (1) Fix the family convention (below), which turns J4 green; (2) replace the
withdrawn `MFP-*` slice ids in its pending reasons with current PILOT ids or a neutral string; (3) assert the
spawned process receives the same environment contract as `compose.yaml`; (4) keep the honest
route-absence→PENDING protocol, which is the reason the remaining gaps are visible at all.

### Family naming (the measured J4 defect) — **Recommendation: the blueprint's uppercase part ids, one shared
parser, and `writing` becomes a KIND rather than a family.**
This is now the highest-value item on the list: J4 is the only red leg in the only red CI job, and the
masking step that hid it was removed in SPA-RETIRE 4, so **it is visible and it is red**.
**How to implement.** Both `task_version.family` and `objective_set.family` are plain `text NOT NULL`, so
**no schema change is needed**. Add one shared `parseFamily()` beside the two conflicting regexes
(`server/owned-api.mjs:419` lowercase, `:448` uppercase), validate against a **closed set**
(`LV1`–`LV3`, `SB1`–`SB2`, `HV1`–`HV3`, `SA1`), and require uppercase from both routes. Because the routes
enforce opposite conventions today, the change is route-layer only plus its consumers: `SKILL_SECTIONS` in
`public/app/app.js` (which maps views to section codes), `docker-stack-check.mjs:597` (`family=writing`) and
`journey-api-check`'s J4. **Never rewrite a stored binding**: attempts and submissions carry their own
`task_version`/`rubric_version`, and the catalogue is immutable — so a family change is a **new catalogue
row**, not an UPDATE.
**Verify.** A leg asserting `family=sa1` and `family=SA1` return identical payloads, and that `writing` →
422 so the old name cannot silently survive.
**Trade away:** a temporary accept-both window; and a lenient parser would hide typos, so **normalise, do not
silently accept** arbitrary case.
**Human:** exam-model confirmation that `SA1` is the right writing-part id before it is frozen into the wire
contract.

### `table-class-check` — **No change needed.** It already *is* a gate of the `postgres` CI job
(`ci.yml:155` plus its mutation proof at `:161`). It sits before `journey-api-check`, which is the right
order: a weakened class rule fails first. Re-review the class taxonomy when a new table class appears.

---

## 5. Suggested running order

| # | Item | Why now |
|---|---|---|
| 1 | **Family naming + J4** (§4) | The only red leg in the only red CI job, now visible; route-layer only, no schema change |
| 2 | **D4/R11 implementation** (§1) | Answered; unblocks PILOT-06's schema, the validator and PILOT-08's screen |
| 3 | **D13 numbers** as configuration + the retro-correction query | The only thing actually blocking pool filling |
| 4 | **D1 provenance table** | Smallest artefact that unblocks serving anything in production |
| 5 | **Landing language + nine titles** | Content tasks, near-zero engineering, visible quality |
| 6 | **Docker-in-CI** (see §4) | Makes everything above verifiable by someone other than me |
| 7 | **D5 wiring** (legs first) | The four missing session behaviours are a security gap, not a nicety |
| 8 | Everything else | Fine to defer: D6, D8 audio, D9 ADR, D10 gates, D12, D14, tabbar, journey rewrite |

**The one thing I would not defer:** the four missing session behaviours in D5 — rotation, expiry sweep,
revocation, and revoke-all-on-password-change. They are the only items on this list where the current state
is a security property rather than a product choice.

## 6. Evidence to gather before acting — not opinions

Recorded because several recommendations above would be stronger as measurements than as arguments:

1. **Which CI step currently fails before `journey-api-check`** (if any) — inspect the last `postgres` job
   run. If nothing fails before it, J4 *is* the failure and item #1 is unblocked by definition.
2. **A 20-run timing and flake baseline** for `docker-stack-check` and `app-browser-check` before either
   becomes a required check. This repository has already been burned by a gate that was skipped rather than
   fixed, and a flaky required check recreates that.
3. **`SELECT DISTINCT family FROM task_version` and from `objective_set`** before the family rename — if
   only the seeded values exist, the change is wire-only with no data migration at all.
4. **A re-run of the auth spike at current HEAD** (it was measured before SPA-RETIRE and the API deletions).
5. **A recorded cost-per-assessment measurement** before any live-model enablement (D10).
