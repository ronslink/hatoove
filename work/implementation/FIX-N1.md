# FIX-N1 — keep Probeprüfung listening results, exclude only blind guesses (task-52)

**Task:** task-52 (FIX-N1, Claude's second-pass review `handoff/ron-agent/CLAUDE-REVIEW-2-OUTPUT.md` §N1).
**Branch:** `codex/fix-n1-mock-evidence`, from local main `ac3d281`. Nothing pushed, nothing merged.

---

## 1. THE DEFECT

FIX-F1 (A13) was right about the principle and too broad about it. The principle: **a practice answer to a
listening set the app cannot play is a guess about audio nobody heard**, so it must not become a number a
learner reads nor a signal that steers the drill. The implementation was `media_required = true` — a fact about
the **set**:

```sql
-- before (FIX-F1), applied to BOTH progress aggregates
EXISTS (SELECT 1 FROM objective_set ps WHERE ps.set_id = e.set_id AND ps.version = e.version
          AND ps.media_required = false)
```

But the **mock exam writes evidence for those same sets** — `finalise_mock_run`
(`server/migrations/0030-listening-playback.sql:286-290`) inserts one `item_evidence` row per answered item with
**`mock_run_id` set**, and in the mock **the recording really plays** (the packaged listening form carries
`fixed_audio` members whose keys are `richtig`/`falsch`, checked in the packaged source while writing this note).
So the filter threw away real Probeprüfung listening results: after a full mock, the Hören tiles said
**"nicht geübt"** and the HV section card lost its count — while the same query's `sections` aggregate was
documented as *"unchanged, member for member"*.

**Why every leg missed it, stated so the fix does not repeat it: not one leg anywhere had
`mock_run_id IS NOT NULL`.** The F1 review judged the lost history "a false signal … nothing they could act
on", which is true of a blind guess and false of a mock result — and the evidence rule could not tell them
apart because it never looked at the row.

## 2. THE FIX

**2.1 The rule is about the ROW, not the set** (`adapter.mjs`, `COUNTED_EVIDENCE`):

```sql
(e.mock_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM objective_set ps
   WHERE ps.set_id = e.set_id AND ps.version = e.version AND ps.media_required = false))
```

An answer counts when it came from a run in which the recording PLAYED; otherwise its set must be one this
deployment can play. Only a **blind practice guess about an unplayable set** is dropped, which is exactly what
F1 meant.

**2.2 The `sections` aggregate is REVERTED to its pre-fix query** — no filter at all — so the "unchanged,
member for member" sentence is true again. Only `parts` carries the rule. The asymmetry is deliberate and
documented in place: the **section** figure is a historical count of answered items (it is what it always was);
the **part** figure is what a tile shows and what the drill ranks by, so it is the one that must not be built
out of guesses.

**2.3 The drill's twin rule follows the same sentence** (`drill-sets.mjs` `playableEvidence`, with the drill's
evidence query now selecting `mock_run_id`, `drill-pg.mjs`). The drill therefore sees a REAL listening weakness
from a Probeprüfung again — and still does not serve a listening item, because it cannot play one: it passes
that part over and serves the weakest part the learner can practise.

**2.4 The duplication, named rather than hidden.** The lease asked for a single shared predicate where that is
clean. It is not clean inside this lease, so here is exactly what exists and why:

| Where | Form | What it decides |
|---|---|---|
| `adapter.mjs` `COUNTED_EVIDENCE` | SQL fragment, used by the `parts` aggregate | which evidence may become a number |
| `drill-sets.mjs` `playableEvidence` | pure JS, used by the drill's in-memory ranking | the same sentence, for a surface that aggregates in memory |
| `practiceSetForPart`, `checkPracticeAttempt` (`adapter.mjs`), `CANDIDATE_SQL`/`readSet` (`drill-pg.mjs`) | `s.media_required = false` | a DIFFERENT rule: a set with no playable recording must not be SERVED or MARKED |

The first two are the same rule in two languages and each names the other in its comment. Unifying them would
mean exporting the SQL fragment from a module the adapter and the drill both import without a cycle
(`owned-postgres/packages.mjs` is that module — it already exports `importedSetGate`) — **outside this lease's
file list**, so it is named here instead of half-done. The third group is deliberately NOT unified: mock
evidence does not make a set servable, and the real fix when recordings land is for "playable" to mean "has a
recording" (`exam_media`), which is a slice of its own.

**2.5 The two small items, both in the same files**

* `practice-messages.js`: the shipped German read **„Hörtelle"**; it now reads **„Hörteile"**. The F1 review
  quoted and passed the typo, which is why it is now asserted (`/nur Hörteile/` and `!/Hörtelle/`).
* The `listening_only` card printed **"0 von 0 richtig"** while calling the part "the weakest of them" — it was
  counting evidence the filter had removed. Its numbers now come from the same `drillStatsFromEvidence` output
  the filter feeds, and when there is **no counted result** the client switches to a new key
  (`drillListeningBlockedNoCount`, five locales) that says there is no counted result yet instead of
  contradicting itself. The card also carries `data-drill-listening-counted="true|false"` so the state is
  observable.

## 3. THE LEGS — the missing one is the deliverable

* **P18 (new, `practice-selection-check --postgres`) — the leg that was missing.** It runs a **real mock exam**
  over listening sets through the shipped path (`startMockRun` → `saveMockRun` → `finaliseMockRun`, which is
  what writes the rows) and asserts the learner's own figures reflect them: each listening part's tile figure
  exists and moved by exactly the mock's answers, with the correct count, and the HV section figure reflects
  them. It uses the packaged listening fixture (`tools/exam-s5-fixture.mjs`) because the standard fixture ships
  a reading form only, and `protect_mock_evidence` (0025) refuses fabricated rows — so the leg cannot be faked
  into passing.
* **P19 (new) — the mutation, by name.** It copies `server/` to a throwaway tree, removes the
  `e.mock_run_id IS NOT NULL OR` clause from the copied adapter, and asserts the defect **returns** for exactly
  those families (the tile figures vanish again), while asserting in the same breath that the shipped rule
  counts them. Nothing in the repository is modified.
* **P8g (updated).** It still proves a blind practice guess never reaches the tile figure, and now also asserts
  the **restored** section behaviour (the section figure counts every answered item, as it did before F1) — so
  neither half can drift into the other.
* **`drill-check` leg 23 (extended).** The pure twin now asserts that a `mock_run_id` row on a media-bound set
  is KEPT while blind guesses are dropped, that the resulting ranking shows the listening part again, that a
  mock row on a playable set counts once, and the two copy/card states (counted vs no-count). **Mutation M9**
  removes the `mock_run_id` clause and makes **leg 23 fail by name**; M8 still removes the playability filter.
  A `P10` lookup was narrowed to the seeded corpus (`set_id LIKE 'telc-deutsch-b1.%'`) because the new mock leg
  imports a packaged form whose family names collide with it.

## 4. EVIDENCE

Disposable PostgreSQL only (`postgres:17-alpine`, local port, removed afterwards); no live app or learner data.

| Command | Result |
|---|---|
| `node tools/practice-selection-check.mjs --postgres` | **47 legs, 0 failed** (P18 counts the mock; P19 reproduces the defect when the clause is removed) + M1–M6 |
| `node tools/drill-check.mjs` / `--postgres` | **24 legs 0 failed** / **43 legs 0 failed**, with **M8** and **M9** both failing **leg 23 by name** |
| `node tools/practice-runner-check.mjs` / `--postgres` | **38 passed, 0 failed** each |
| `node tools/part-index-check.mjs` / `--postgres` | **11 passed** / **16 passed**, 0 failed |
| `node tools/owned-api-check.mjs` / `--backend=postgres` | **35 passed, 0 failed** each |
| `node tools/migrate-check.mjs` | **6 passed, 0 failed** |
| `node tools/table-class-check.mjs` | **90 table rows; 0 failures; 0 findings** |
| `node tools/i18n-register-check.mjs` | **0 findings** (11 shipped files) |
| `node tools/run-gates.mjs mirror` / `baseline` / `mirror-db` | **all gates passed** / **all gates passed** / **all gates passed** |

**The two directions the task asked for, both proved on a database:** a finalised Probeprüfung over listening
sets is **counted** in the part and section figures (P18), and a blind practice guess about a set this
deployment cannot play is **ignored** by the part figure while still counted by the section figure as it always
was (P8g).

## 5. RESIDUAL RISK / NOT DONE

1. **Two implementations of the counting rule** (§2.4). Named, each pointing at the other, with the exact
   refactor (the SQL fragment into `owned-postgres/packages.mjs`) recorded for whoever holds that file.
2. **"Playable" still means `media_required = false`** for the *serving* rules. The honest fix is
   `exam_media`-based (a set is playable when it has a recording this deployment can read); until then the
   asymmetry between serving and counting is documented rather than hidden.
3. **The section/part asymmetry is deliberate but visible**: a learner who guessed through a listening part
   before F1 sees those guesses in the section figure and not on the tile. That is the pre-F1 contract for the
   section figure; changing it is a product decision, not this defect.
4. **`practice-media-check` was not re-run as part of this lease** (it is not in this task's list and it is in
   `mirror-db`, which is green): its playback legs are unaffected by the counting rule.
5. Nothing in this change touches the audio, the transport, the drill's serving rules or the learner's stored
   rows: the fix makes MORE evidence count, never less, apart from the blind-guess case that F1 intended.
