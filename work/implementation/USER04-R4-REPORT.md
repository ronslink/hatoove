# USER04-R4 — independent verification of the NEW-1 fix, re-run on `5b4f08e`

- Reviewer: Claude Code (local, Windows) — independent, not the author
- Execution: `user04-r4-claude-20260930-a` · Coordinator: `COORD-TAKEOVER-20260930` · Issue #19
- Candidate: `origin/codex/user04-source-fixtures` = `5b4f08e4a90fb911ff13f64ff6a5de0c5f03ffbe` (PR #21)
- Delta reviewed: `9b54628` + `5b4f08e` on base `c8c86dc` (only `tools/objective-fixture-check.mjs` and
  `tools/objective-fixture-check.test.mjs` change; the fixture JSON is unchanged)
- Environment: Node v24.4.1, Windows 11, offline. All commands and probes ran in the read-only checkout
  `..\candidate` (detached at `5b4f08e`, left unmodified — `git status` clean). Older revisions and mutants
  were extracted with `git archive` into a scratch directory outside the repository.
- No server, browser, DB, `.env`, provider, live AI or device run.

## Verdict: **accept-with-notes**

NEW-1 is fixed, and both points from my earlier read-only pass on `9b54628` are fixed as executed:
top-level `band` is no longer reported as a learner claim, and renamed claim fields at the case top level
are now rejected by the key allowlist. The regression tests are real: all three new/changed tests fail on
both `9b54628` and `c8c86dc`, and each targeted mutant of the new code is killed.

One thing is still wrong, and I recommend fixing it before merge because it is a one-line change and the
commit message's headline claim is otherwise inaccurate:

- **F1 — the renamed-claim class is closed at the case top level only, not inside `expected`.**
  `expected` is on the allowlist, but its contents are only checked against the name list, so
  `expected.score`, `expected.total`, `expected.result` and `expected.Grade` are all accepted, as is an
  `expected` that is not an object at all (`"bestanden"`, `42`, `["sehr gut"]`). That is exactly the class
  `5b4f08e` says it has "now closed", one level down, in the block the code comment calls "the only place a
  band-shaped claim could hide".

Two minor notes (N1, N2) and pre-existing observations outside the delta are listed below. None of them
blocks merge.

## Probe 3 — the nine commands (actual results at `5b4f08e`)

| Command | Result | Exit |
|---|---|---|
| `node tools/objective-fixture-check.mjs` | OK, families=8 cases=36 scenarios=14 items 1-60 points=180, 0 warnings | 0 |
| `node tools/exam-blueprint-check.mjs` | OK, sections=4 parts=9 items=61 writtenPoints=225 minutes=150, 0 warnings | 0 |
| `node tools/feedback-case-check.mjs` | OK, 6 warnings (e.g. duplicate scenario `provider-unavailable`); WFC-03/05/06 routed to human review | 0 |
| `node --test tools/exam-blueprint-check.test.mjs` | 52 tests, 52 pass, 0 fail | 0 |
| `node --test tools/feedback-case-check.test.mjs` | 43 tests, 43 pass, 0 fail | 0 |
| `node --test tools/objective-fixture-check.test.mjs` | 38 tests, 38 pass, 0 fail | 0 |
| `node tools/check.js` | 101 passed, 0 failed | 0 |
| `node tools/writing-check.js` | 9 passed, 0 failed | 0 |
| `node tools/feedback-check.js` | 14 passed, 0 failed | 0 |

**Bookkeeping check.** Total 52 + 43 + 38 = **133**, matching the `5b4f08e` commit message ("133/133 ...
52 + 43 + 38"). The split is correct: blueprint 52, feedback-case 43, objective 38 (the objective suite grew
by two tests, O8 and O9). Baseline 101 + 9 + 14 is unchanged. The `9b54628` message's "52 + 43 + 36 = 131"
is superseded and I did not re-audit it. The commit message is accurate on counts.

## Probe 1 — is NEW-1 fixed, and does the shipped fixture still pass?

Harness: `probe.mjs` imports `validateObjectiveCases` from each tree, `structuredClone`s the shipped
`tests/fixtures/objective-marking-cases.json`, applies one mutation and records `ok` and the error codes.

Unmodified shipped fixture: **ok === true** on `5b4f08e`, `9b54628` and `c8c86dc`.

All 36 shipped cases use exactly the same 11 keys (`id, family, scenario, answers, expectedOutcome,
expectedError, expectedCorrectCount, expectedPoints, unassessed, synthetic, rationale`). No case carries
`band`, `note`, `expected` or any banned name, so the fix cannot be rejecting shipped content. (The
risk flagged in the brief, a banned name used innocently, is covered under N1 for `note`.)

Top level, mutation `cases[OMC-LV1-01][field] = value`:

| Field = value | `c8c86dc` | `9b54628` | `5b4f08e` |
|---|---|---|---|
| `grade = "sehr gut"` | **ACCEPT** (NEW-1) | reject: claim | reject: unknown-key + claim |
| `band = "B1"` | ACCEPT | reject: claim (over-correction) | reject: **unknown-key only** |
| `gradeBand`, `readiness`, `learnerScore = 42`, `passed = false`, `percentage = 55`, `expectedGrade`, `overallPassed`, `certificate`, `finalGrade`, `overallResult` | reject: claim | reject: claim | reject: unknown-key + claim |
| `note = "gut"` | ACCEPT | ACCEPT | reject: claim (only) |

Nested, mutation `cases[id].expected = { [field]: value }`, run on both `OMC-LV1-01` and `OMC-AGG-02`:

| Field | `c8c86dc` | `9b54628` | `5b4f08e` |
|---|---|---|---|
| `expected.grade = "sehr gut"` | **ACCEPT** (NEW-1) | reject: claim | reject: claim |
| `expected.band = "B1"` | **ACCEPT** | reject: claim | reject: claim |
| `expected.learnerScore = 42` | reject: claim | reject: claim | reject: claim |
| `expected.note`, `expected.bandName` | ACCEPT | ACCEPT | reject: claim |

**Result: NEW-1 is fixed at both levels.** The band over-correction is fixed. At `5b4f08e`, a top-level
`band` is rejected only as `case.unknown-key` and never as `case.prohibited-learner-claim`. That is the
right outcome: an objective case has no `band` key, so rejecting it is correct, but reporting it as a learner
claim was not. `band` remains a claim inside `expected`.

## Probe 2 — is the class closed?

Top-level, names not on any banned list (all at `OMC-LV1-01`, all at `5b4f08e`):

| Field | `9b54628` | `5b4f08e` |
|---|---|---|
| `total`, `score`, `result`, `outcomeScore`, `points`, `mark`, `bandToTotal`, `BandToTotal`, `Grade`, `Note`, `learner_score`, `comment` | ACCEPT (all) | reject: unknown-key (all) |
| `grade = null` | ACCEPT | reject: unknown-key |

At the case top level, the class is closed by construction. That was the argument of my previous pass, and
it now holds when run. The contract backs this: `docs/exam/TELC-B1-SOURCES.md` §212–215 says no overall
pass/fail and no overall grade band may be computed or displayed, and the fixture's own `scopeNotes` says so
too. `score`, `total` and `result` on a case would all be claims under that contract, and an allowlist catches
them without deciding which names count as claims.

### F1 — the same class remains inside `expected` (recommend fixing before merge)

| Mutation (`5b4f08e`, both `OMC-LV1-01` and `OMC-AGG-02`) | Result |
|---|---|
| `expected = { score: 42 }` | **ACCEPT** |
| `expected = { total: 180 }` | **ACCEPT** |
| `expected = { result: "bestanden" }` | **ACCEPT** |
| `expected = { Grade: "gut" }` | **ACCEPT** |
| `expected = "bestanden"` / `42` / `["sehr gut"]` (not an object) | **ACCEPT** |

`OBJECTIVE_CASE_KEYS` admits `expected`, but nothing defines its shape: no shipped case uses it, and no doc
defines it. `nestedClaimFields` is still a name list, so the renamed-claim hole remains inside `expected`,
along with a new one: a non-object `expected` is not checked at all. The `5b4f08e` message says "the
renamed-claim class is now closed". That is true at the top level and false for `expected`.

Smallest fix, verified in a scratch mutant: remove `'expected'` from `OBJECTIVE_CASE_KEYS`. Because no
shipped case uses it, the result was:
- shipped fixture `ok === true`;
- `expected = { score: 42 }` → rejected (`case.unknown-key`);
- all 38 objective tests still pass. The nested-guard tests still pass because the `nestedClaimFields` scan
  runs whenever `expected` is an object, so `expected.grade` still reports `case.prohibited-learner-claim`.

If `expected` is meant to become real case data later, give it its own key allowlist then. Either way, add a
test for `expected.score` and for a non-object `expected`. **None of the 38 tests fails when `expected` is
removed from the allowlist, so the current suite leaves this behaviour completely unpinned.**

### Is "NEW-2 accepted" still the right call?

The coordinator changed position in `5b4f08e`, and I agree with the change. NEW-2 should not be an accepted
limitation for the case top level, and it no longer is. For `expected` it is still effectively accepted, and
I disagree with that for the reason above: the same allowlist argument applies, and the fix costs one line.

## Probe 4 — do the regression tests discriminate?

Candidate test file `5b4f08e:tools/objective-fixture-check.test.mjs` run against older validators
(copied into scratch extracts; the fixture is identical across all three):

| Validator | Result | Failing tests |
|---|---|---|
| `9b54628` | 35 pass / 3 fail | O7 (NEW-1), O8 (NEW-2), O9 (NEW-1b) |
| `c8c86dc` | 35 pass / 3 fail | O7, O8, O9 |
| `5b4f08e` | 38 pass / 0 fail | — |

Targeted mutants of the `5b4f08e` validator (scratch copy; the candidate tree was not edited):

| Mutant | Killed by |
|---|---|
| drop `'grade'` from `claimFields` (so from both levels) | O7 |
| disable the unknown-key loop | O7, O8 |
| drop `'note'` from `claimFields` | O7, O8 |
| drop `'band'` from `nestedClaimFields` | O7, O9 |
| remove `'expected'` from `OBJECTIVE_CASE_KEYS` | **nothing** (see F1; this mutant is the proposed fix, and nothing pins current behaviour) |

The tests are not vacuous. O7 fails on `c8c86dc` for the original NEW-1 reason (`grade` accepted at both
levels). O9 fails on `9b54628` because of the top-level `band` claim, and on `c8c86dc` because
`expected.band` was unguarded.

## Minor notes (non-blocking)

- **N1 — `note` repeats the `band` over-correction on a smaller scale.** `note` is Hatoove's standard
  explanatory-comment field (dozens of uses in `data/cases-guide.json` and `data/core-grammar.json`). On
  an objective case, `note: "Why this distractor is wrong"` is now reported as
  `case.prohibited-learner-claim` ("asserts a learner result"). It is still correctly rejected, since
  `note` is not case data, but the diagnosis is wrong and misleading to a content author. `note` is also
  listed in `OBJECTIVE_CASE_KEYS` ("permitted keys") although any non-null value is always an error, and
  `note: null` passes. A simpler option is to drop `note` from both lists: unknown-key already rejects it
  with an accurate message. I would not block on this. The German "Note" rationale is defensible, but it
  goes against the stated principle of not guessing names.
- **N2 — test comment count.** The O8 comment says "the case shape is fixed at 11 keys". The shipped
  cases do use 11 keys, but `OBJECTIVE_CASE_KEYS` lists 13 (with `expected` and `note`). The comment
  should say which of the two it means.

## Pre-existing, outside this delta (same result on `c8c86dc`, `9b54628` and `5b4f08e`)

These are recorded for the coordinator's backlog, not as findings against this fix:

- Claims at other levels are unguarded: fixture root `grade = "gut"` and `overallScore = 42`, and
  `families[0].learnerScore = 42`, are all accepted. The case-level guard does not reach the root or the
  family objects.
- Free text is not scanned: `rationale = "Learner passed with sehr gut."` is accepted. That is expected
  for a key-based check, and I note it only so the guard is not described as "no learner claim anywhere".
- `expectedOutcome = "Bestanden"` is correctly rejected (`case.outcome` + claim) on all three.

## Scope reminder

This is structural verification of a fixture validator. It is not exam validity, linguistic correctness,
educational approval or security approval, and the passing counts above are not evidence for any finding.
The probe tables are.

## Next action

The coordinator should decide whether to apply F1 (remove `expected` from `OBJECTIVE_CASE_KEYS`, and add
tests for `expected.score` and non-object `expected`) on PR #21 before merge. N1 and N2 are optional. I
made no edits to the candidate.
