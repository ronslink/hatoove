# USER04-R2B — independent review of the USER04 correction delta

Execution `user04r2b-20260930-a` (OpenClaw/Hetzner, slot3, no children) · Issue [#24](https://github.com/ronslink/hatoove/issues/24)
Reviewer branch `codex/user04-r2b-review` · Report base `origin/main` @ `074aebf9697d9a2b047a59b993a3178d94f1fb9f`

- Candidate (read-only, PR-under-review): `codex/user04-source-fixtures` @ **`cba0f0c162af7f2ea384a2e64afa2c10a38d5c31`**
- Stacked base: `codex/e01-sources-user03` @ `7030a6653d4e54bd1ec8febf0ab13c71af5c27df`
- Correlation range: `7030a66..cba0f0c` (10 commits); correction delta `562902b..cba0f0c` (3 commits: `411cb8c`, `fdff718`, `cba0f0c`)
- Prior pinned review (PR #26): `work/implementation/USER04-R2-REPORT.md` @ branch `codex/user04-r2-review` `8843128` (candidate `562902b`)

Status: **independent review, unreviewed by a human — no content, exam, examination-validity, human or security approval.**
Structural consistency is never exam validity. This reviewer is independent of this candidate's author but is **not**
an educational, content, exam-validity or security approver.

## Head confirmation

`git rev-parse origin/codex/user04-source-fixtures` → `cba0f0c162af7f2ea384a2e64afa2c10a38d5c31` (exact match; branch has
**not** advanced). Candidate extracted with `git archive cba0f0c` into an ignored scratch path (`.openclaw/tmp/cand-cba0f0c`),
never checked out over this report branch.

## Method

Pure Node v22.23.2, offline, dependency-free. Three checkers + their three `*.test.mjs` suites + the offline baseline run on
the extracted candidate. Each PR26 finding re-verified by a **minimal mutation probe** against `cba0f0c` (probes in
`.openclaw/tmp/probes/`, not committed): mutate one field of the checked-in fixture, run the validator, record `ok` and the
error codes. No browser/server/DB/`.env`/provider/live-AI/device run. Doc-text findings (F10–F12) are reproduced by assertion
on the corrected prose plus its code anchor.

## Test results (executed, candidate @ cba0f0c)

| Suite | Command | Actual result |
|---|---|---|
| Blueprint checker | `node tools/exam-blueprint-check.mjs` | OK, **0 warning(s)** (sections=4 parts=9 items=61 writtenPoints=225) |
| Blueprint tests | `node --test tools/exam-blueprint-check.test.mjs` | **51/51 pass** (was 50) |
| Feedback checker | `node tools/feedback-case-check.mjs` | OK, **6 warning(s)** (cases=21 scenarios=19/19) |
| Feedback tests | `node --test tools/feedback-case-check.test.mjs` | **42/42 pass** (was 40) |
| Objective checker | `node tools/objective-fixture-check.mjs` | OK, **0 warning(s)** (families=8 cases=36 points=180) |
| Objective tests | `node --test tools/objective-fixture-check.test.mjs` | **34/34 pass** (was 28) |
| Offline baseline | `node tools/check.js` | **101 passed, 0 failed** |
| Offline baseline | `node tools/writing-check.js` | **9 passed, 0 failed** |
| Offline baseline | `node tools/feedback-check.js` | **14 passed, 0 failed** |

**127/127 committed checker tests pass** (+9 over the 118 at `562902b`); offline baseline **124/124** (101+9+14), matching the
recorded baseline. `tools/writing-tool-check.mjs` is **not present** in the candidate (skipped). A passing count is not
evidence for any finding; the probes below are.

## Finding verdicts (PR26 F1–F12)

Probe = exact mutation on a deep clone of the candidate's own fixture; observed = validator output.

| # | PR26 finding | Verdict | Probe → observed result |
|---|---|---|---|
| F1 | WFC-04 zeroed credit for three addressed Leitpunkte | **FIXED** | WFC-04 now carries `pointsHandled: 3`, `expected.contentScoreCreditPreserved: true`. Probe `WFC-04.expected.contentScoreCreditPreserved = false` → `ok=false`, `[case.credit-withdrawn-too-early] 3 of 4 points handled …content credit must be preserved` + `[case.content-credit-unexplained]`. As checked in, WFC-04 → `ok=true`. New WFC-21 is the separate zero-credit branch (`pointsHandled: 1`, credit `false`, language still assessed). |
| F2 | retry required a live lease though failure clears it | **FIXED** | WFC-10/11/15 `retryConditions` no longer contain `liveLease`; WFC-12 (worker completion) still does. WFC-15 now carries invariant `retry-possible-after-failure-clears-lease`, and `FEEDBACK-CASES.md` §3.2 splits the two paths. **Residual (note):** the checker itself does not enforce it — probe `WFC-15.retryConditions.push('liveLease')` → `ok=true`, only a `[case.retry-conditional]` warning. Regression is guarded by the committed test `review F6`, not by the validator. |
| F3 | `allowance_exhausted`/`submission_superseded` frozen as terminal | **FIXED** | `TERMINAL_ERRORS` = {retry_exhausted, attempt_deleted, stale_lease}; new `INELIGIBLE_ERRORS` = {allowance_exhausted, submission_superseded}. Probe `WFC-17.expected.permanentlyTerminal = true` → `[case.ineligibility-permanence]`; delete `WFC-17.currentlyIneligible` → `[case.ineligibility-flag]`; `WFC-20.retryPermitted = true` → `[case.retry-coherence]`. |
| F4 | missing `expectedCorrectCount` accepted with 999 points | **FIXED** | Probe `delete OMC-LV1-01.expectedCorrectCount; expectedPoints = 999` → `ok=false`, `[case.expectation-missing]` + `[case.points]`. Was `ok=true`. |
| F5 | numeric-string `expectedPoints` accepted | **FIXED** | Probe `OMC-LV1-01.expectedPoints = "999"` → `[case.points-type] … must be a finite number`. Was `ok=true`. |
| F6 | aggregate learner-score claims accepted | **FIXED** | Probe `OMC-AGG-01.expectedCorrectCount = 42; expectedPoints = 150` → 2 × `[case.aggregate-learner-score]`. Was `ok=true`. |
| F7 | all LV3 duplicates exempt rather than repeated `x` only | **FIXED** | Probe `LV3.items[1].key := "a"` (real option repeated) → `[family.key-reuse] LV3 … repeats option key(s): a (the no-match marker "x" is exempt)`. Control `LV3.items[1].key := "x"` → **no** `family.key-reuse` (the residual errors are incidental key/answer mismatches). The real fixture legitimately repeats `x` twice (items 14,17) and passes. |
| F8 | null item crash | **FIXED** | Probe `LV1.items[0] = null` → no throw; `ok=false` with `[item.type] LV1.items[0] must be an object` plus downstream item-gap/count errors. Was `TypeError: Cannot read properties of null (reading 'key')`. |
| F9 | missing/string criterion+aggregate `sources` bypass | **FIXED** | `delete …criteria[0].sources` → `[sources.field-missing]`; `…criteria[0].sources = "S2-p40-p38"` → `[sources.refs-type]`; `delete writtenExam.sources` → `[sources.field-missing]`; `writtenExam.sources = "S2-p41-p39"` → `[sources.refs-type]`; `writtenExam.sources = []` → `[sources.empty]`. Control `["S999"]` still → `[sources.ref-unknown]`. All five were `ok=true` before. |
| F10 | R8 debited at enqueue | **FIXED** | `docs/qa/DRAFT-RECOVERY-MATRIX.md:42` R8 now reads “one enqueue and **one allowance reservation**… `reservations = 1`, `usage debits = 0` immediately after the enqueue; the single debit appears only once a worker has **saved an assessment**”, matching `PILOT-V0.1.md:52/55`. |
| F11 | G2 wrong denominator prose | **FIXED** | `docs/exam/LEGACY-GAP-MAP.md:81` G2 now states the band is derived from `written / 300` and anchored to `exam.js:1484` `gradeBand((scored.total / 300) * 100)`; the anchor matches the code. The prior “(written / 225) × 100” prose is gone. |
| F12 | G4 speaking card confused with writing | **FIXED** | The G4 table row is withdrawn and replaced by a bullet (`LEGACY-GAP-MAP.md:84-86`) stating the `/ 25` card is the **speaking** grader (`exam.js:1153`), consistent with a 25-point speaking subtest, not a writing defect. G1/G2/G3 are re-labelled “observed defects”. |

F13/U7 remains fixed as recorded at `562902b` (not re-opened).

**All twelve PR26 findings are FIXED at `cba0f0c`.** None are carried over as current.

## New defects introduced by the corrections

None of these break the current fixture (all checkers/tests pass); each is a real gap or inconsistency in the *new* logic.

- **N1 — the new learner-score guard is porous (low–medium).** The top-level guard scans
  `String(c[field]).toLowerCase()` against a word list, so it only catches *string* values that contain a listed word.
  Probes: `OMC-AGG-01.learnerScore = 42` → `ok=true`; `.passed = false` → `ok=true`; `.readiness = 0.9` → `ok=true`;
  `OMC-LV1-01.percentage = 55` (marked case) → `ok=true`; only `.expectedGrade = "sehr gut"` → flagged. The nested
  `c.expected.*` block errors on mere *presence*, so the two halves of the same guard behave differently: a numeric/boolean
  overall-result claim escapes. (`String.prototype.includes` is also brittle — any value that merely contains
  `gut/band/pass/fail/grade` as a substring is flagged.)
- **N2 — terminal/ineligible symmetry (low).** `INELIGIBLE_ERRORS` require `currentlyIneligible === true`, but the
  `TERMINAL_ERRORS` branch only rejects `permanentlyTerminal === false` and never *requires* `=== true`. Probe
  `delete WFC-14.expected.permanentlyTerminal` → `ok=true`. A terminal case can therefore omit the permanence flag
  entirely, while the analogous ineligible case cannot.
- **N3 — `classificationSemantics` is inert (low).** The fixture gains a `classificationSemantics`
  (`permanentFailure`/`currentlyIneligible`/`note`) block, but `grep -rn classificationSemantics tools/ public/ server.js`
  finds **no reader**. It can silently drift from the code's `TERMINAL_ERRORS`/`INELIGIBLE_ERRORS` arrays; no test binds them.
- **N4 — duplicated paragraph in `FEEDBACK-CASES.md` §3.2 (low).** “The three classifications defined by the pilot contract
  (`malformed_feedback`, `provider_unavailable`, `retry_exhausted`) remain unchanged; …” appears **twice** (lines 130–132 and
  144–146), the second retaining the older “the four added codes …” wording. The reworded paragraph was added without
  removing the original.
- **N5 — cosmetic double-reporting (low).** A string `sources` field is reported twice by the blueprint validator
  (the new `requiredSourceFields` pass *and* the recursive walk): e.g. `writtenExam.sources = "S2-p41-p39"` emits two
  identical `[sources.refs-type]` errors.

Confirmed not regressed: the new `pointsHandled` range guard works (`WFC-04.pointsHandled = 5` → `[case.points-handled-range]`);
the marked-case answers guard works (`OMC-LV1-01.answers = null` → `[case.answers-required]`); correct-count/wrong-points
arithmetic is still enforced (`cc=5, ep=999` → `[case.points]`). The prior F1 audit-trail contradiction
(`content-credit-withdrawn-for-leitpunkt-shortfall` on a three-point case) is resolved — WFC-04 now carries
`content-credit-preserved-for-partial-coverage`.

## Evidence classes (kept separate)

- **Executed:** checker + suite counts above; every probe is a reproduced validator result on the extracted candidate.
- **Static source review:** `tools/feedback-case-check.mjs` (TERMINAL/INELIGIBLE branches, `pointsHandled` logic),
  `tools/objective-fixture-check.mjs` (aggregate guard, `PROHIBITED_LEARNER_CLAIMS`, key-reuse), `tools/exam-blueprint-check.mjs`
  (`requiredSourceFields`, `checkSources`), `docs/qa/DRAFT-RECOVERY-MATRIX.md:42`, `docs/exam/LEGACY-GAP-MAP.md:81/84-86`,
  `docs/assessment/FEEDBACK-CASES.md` §3.2, `public/js/exam.js:1484/1153`.
- **Unverified official/expert meaning:** whether telc weights 3-of-4 and 1-of-4 responses as the fixtures assert, and any
  publisher rounding, remain human/expert questions. This review certifies **structural consistency only**, never exam meaning.
  No reviewer here is an educational, content or exam-validity approver.

## Independent verdict

**accept-with-notes.** The three correction commits close all twelve PR26 findings with reproduced probes, and the candidate
adds genuine regression tests (+9). The residual items are the low-severity new gaps N1–N5 and the F2 note that the retry/lease
distinction lives in the fixture + committed test rather than in the validator. None of these blocks the candidate's stated
scope; none is an exam-validity or security judgement, which this review cannot and does not give.

Suggested, smallest first, for the candidate branch: N1 (make the learner-claim guard presence/type-based like the nested
block), N2 (require `permanentlyTerminal === true` on terminal cases), N3 (validate `classificationSemantics` against the code
constants or drop it), N4 (remove the duplicated §3.2 paragraph), N5 (dedupe the source-field pass). Each wants a
failing-before/passing-after regression, not a raised count.

No merge, force-push, rebase or candidate edit was performed by this review. Pinned to `cba0f0c162af7f2ea384a2e64afa2c10a38d5c31`;
if the branch advances, these results stand as the pinned set and only the new delta should be inspected.
