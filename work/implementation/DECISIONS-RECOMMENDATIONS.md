# Decision recommendations — Hatoove

**What this is.** A recommendation for every open decision, each with **how to implement it in this
repository**. Prepared 2 October 2026 by the local agent, with an independent second pass on the
product/content decisions (recorded below where it changed or sharpened the recommendation).

**What this is not.** A decision. Two classes of item cannot be settled here at all: (a) anything needing a
qualified telc-B1 reviewer or a lawyer, and (b) commercial judgements (price, market, budget). Those are
marked **HUMAN** in every row, and a recommendation is not a substitute for them.

**Reading order.** §1 is the answered decision and its implementation recipe. §2 blocks the most. §3 is
everything with a working default. §4 is engineering hygiene. There is a suggested running order at the end.

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

### D5 — Auth library — **Recommendation: adopt Better Auth.**
**The schema is already Better Auth's**: `user`/`session`/`account`/`verification` with camelCase columns
and `emailVerified` (migration `0001-auth-schema.sql`). So this is **wiring, not migration** — the spike
already measured it workable, and the current port has no rotation, expiry sweep, revocation or recovery.
**How to implement.** Keep `server/owned-postgres/sessions.mjs` behind its port interface (that is why the
port exists): replace its internals with Better Auth's session operations, keep `createOwnedApi`'s contract
(`{ id, email }` or null) unchanged, and let the existing `accounts-http-check` + `entry-point-fails-closed`
legs prove the boundary did not move. Add legs for the four missing behaviours *first* (rotate on sign-in,
expire by sweep, revoke one session, revoke all on password change).
**Trade away:** "the root app is dependency-free" for the server scope. That property is worth naming in the
commit message rather than losing silently.

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

### `journey-api-check` — **Recommendation: retire it, with a ledger row.**
It spawns a **host** `server.js` (a retired runtime) and cites withdrawn roadmap ids; it is red by design.
Everything it asserted that still matters is covered by `owned-api-check` on two backends,
`docker-stack-check`, and `app-browser-check`. **How:** delete it and its CI step, record the row in
`RETIRED-CHECKS.md` naming the surviving vehicles — the same treatment as the other retirements, not a
silent removal.

### Family naming (the measured J4 defect) — **Recommendation: one lowercase convention, with the objective
codes as *values*, not as family names.** `writing` is a family; `LV1`/`SB1`/`HV3` are **parts**.
**How:** add `part` (already on `objective_set`) as the authoritative sub-identifier, keep `family` lowercase
everywhere, accept the uppercase legacy spelling **on the read route only** for one release with a
deprecation note in `docs/openapi.yaml`, and migrate the stored bindings by inserting new catalogue rows —
never by rewriting attempts, which carry their own version binding. **Trade away:** a temporary
accept-both window, which is cheaper than breaking stored bindings.

### `table-class-check` — **Recommendation: move it into the PostgreSQL CI job.**
It needs a live database, so it cannot be an offline gate; that is an argument for moving it, not for
leaving it developer-only. **How:** relocate the step into the `postgres` job where a database already
exists, which also makes it a required check again.

---

## 5. Suggested running order

| # | Item | Why now |
|---|---|---|
| 1 | **D4/R11 implementation** (§1) | Answered; unblocks PILOT-06's schema, the validator and PILOT-08's screen |
| 2 | **D13 numbers** as configuration + the retro-correction query | The only thing actually blocking pool filling |
| 3 | **D1 provenance table** | Smallest artefact that unblocks serving anything in production |
| 4 | **Landing language + nine titles** | Content tasks, near-zero engineering, visible quality |
| 5 | **Docker-in-CI** | Makes everything above verifiable by someone other than me |
| 6 | **D5 wiring** (legs first) | The fourth missing session behaviour is a security gap, not a nicety |
| 7 | Everything else | Fine to defer: D6, D8 audio, D9 ADR, D10 gates, D12, D14, tabbar, J4, check hygiene |

**The one thing I would not defer:** the four missing session behaviours in D5 — rotation, expiry sweep,
revocation, and revoke-all-on-password-change. They are the only items on this list where the current state
is a security property rather than a product choice.
