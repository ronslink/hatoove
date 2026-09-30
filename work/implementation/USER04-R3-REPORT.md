# USER04-R3 — independent delta recheck of the USER04 correction commits

Execution `user04-r3-clawd-20260930-a` · Coordinator `COORD-TAKEOVER-20260930` · Issue [#19](https://github.com/ronslink/hatoove/issues/19)
Reviewer branch `codex/user04-r3-review-clawd` · Report base `origin/main` @ `074aebf9697d9a2b047a59b993a3178d94f1fb9f`

- Candidate (read-only, PR #21, stacked on #17): `origin/codex/user04-source-fixtures` @ **`c8c86dc94e97a0760e6c5216da47198021a29a39`**
- Stacked base: `7030a6653d4e54bd1ec8febf0ab13c71af5c27df` · Integration base: `074aebf`
- **Delta under review: `cba0f0c..c8c86dc` (one commit, `c8c86dc`)**
- Prior pinned review (OpenClaw, PR #28): `work/implementation/USER04-R2B-REPORT.md` @ `codex/user04-r2b-review` `f6a6223` (candidate `cba0f0c`)

Status: **independent review, unreviewed by a human — no content, exam, examination-validity, human or security approval.**
Structural consistency is never exam validity. This reviewer is independent of the candidate's author but is **not** an
educational, content, exam-validity or security approver.

## Head confirmation

`git rev-parse origin/codex/user04-source-fixtures` → `c8c86dc94e97a0760e6c5216da47198021a29a39` (exact match; branch has **not**
advanced). Candidate extracted with `git archive c8c86dc | tar -x` into a scratch path (`D:\clawdbot\candidate-c8c86dc`), never
checked out over this report branch. Pre-fix `cba0f0c` also extracted for before/after comparison. The candidate was inspected
**read-only**; no `tools/**`, `tests/**` or `docs/**` file was edited.

## Method

Pure Node v24.4.1, offline, dependency-free. The three checkers + their three `*.test.mjs` suites + the offline baseline run on
the extracted candidate. Each claimed fix (N1–N5) re-verified by a **minimal mutation probe**: mutate one field of the checked-in
fixture / blueprint on a deep clone, run the exported validator, record `ok` and error codes (probes in `D:\clawdbot\probes\`, not
committed; they import the candidate validator by `file://` URL). No browser/server/DB/`.env`/provider/live-AI/device run. Doc-text
finding N4 reproduced by assertion on the corrected prose.

## Test results (executed, candidate @ c8c86dc)

| Suite | Command | Actual result |
|---|---|---|
| Blueprint checker | `node tools/exam-blueprint-check.mjs` | OK, **0 warning(s)** (sections=4 parts=9 items=61 objectiveItems=1-60 writtenPoints=225 minutes=150) |
| Blueprint tests | `node --test tools/exam-blueprint-check.test.mjs` | **52/52 pass** |
| Feedback checker | `node tools/feedback-case-check.mjs` | OK, **6 warning(s)** (cases=21 scenarios=19/19 invariantsUsed=38) |
| Feedback tests | `node --test tools/feedback-case-check.test.mjs` | **43/43 pass** |
| Objective checker | `node tools/objective-fixture-check.mjs` | OK, **0 warning(s)** (families=8 cases=36 scenarios=14 objectiveItems=1-60 objectivePoints=180) |
| Objective tests | `node --test tools/objective-fixture-check.test.mjs` | **35/35 pass** |
| Offline baseline | `node tools/check.js` | **101 passed, 0 failed** |
| Offline baseline | `node tools/writing-check.js` | **9 passed, 0 failed** |
| Offline baseline | `node tools/feedback-check.js` | **14 passed, 0 failed** |

**130/130 committed checker tests pass** (52+43+35); offline baseline **124/124** (101+9+14), matching the recorded baseline. The
commit message states the suite total 127 → 130; the measured total is 130, so the **total** agrees, though the per-suite split it
quotes (51→51 / 42→44 / 34→35) does not match the counts observed here (52 / 43 / 35). That is a bookkeeping discrepancy only. A
passing count is not evidence for any finding; the probes below are.

## Finding verdicts (N1–N5)

Probe = exact mutation on a deep clone of the candidate's own fixture/blueprint; observed = validator output.

| # | Claimed fix | Verdict | Probe → observed result |
|---|---|---|---|
| **N1** | Top-level learner-score guard is presence-based; non-string claims rejected while legitimate outcomes pass | **FIXED for the stated claim — but a fix-introduced regression (see NEW-1)** | On `OMC-LV1-01` (a plain marked case): `learnerScore=42` → `[case.prohibited-learner-claim]`; `passed=false` → flagged; `readiness=0.9` → flagged; `percentage=55` → flagged; `overallPassed=true` → flagged; `certificate='B1'` → flagged; `finalGrade='gut'` → flagged; `expectedGrade='sehr gut'` → flagged. All eight rejected (were accepted at `cba0f0c`). Legitimate outcomes on the real fixture (`marked`, `marked-or-flagged`, `rejected-or-flagged`, `aggregate`, `unassessed`) all → **0** claim errors. Real fixture `ok=true`, 0 errors. |
| **N2** | Terminal classifications must **require** `permanentlyTerminal === true` | **FIXED** | Delete `expected.permanentlyTerminal` on `WFC-14` (retry_exhausted), `WFC-16` (attempt_deleted), `WFC-18` (stale_lease), `WFC-19` (retry_exhausted) → each `[case.terminal-flag]` (was `ok=true` at `cba0f0c`). Extra: `WFC-14.expected.permanentlyTerminal=false` → `[case.terminal-contradiction]`. Break attempt — move the flag to the case top level (delete it from `expected`, set `case.permanentlyTerminal=true`): still `[case.terminal-flag]`; the required flag cannot be relocated away. |
| **N3** | `classificationSemantics` validated against the checker's own constants | **FIXED** | `classificationSemantics.permanentFailure=['retry_exhausted']` → `[semantics.drift]`; `currentlyIneligible=['allowance_exhausted','retry_exhausted']` → `[semantics.drift]`; delete the block → `[semantics.missing]`; delete `.note` → `[semantics.note]`; blank `.note` → `[semantics.note]`. All were `ok=true` at `cba0f0c`. |
| **N4** | `FEEDBACK-CASES.md` §3.2 contains the contract-classification paragraph **once** | **FIXED** | `grep -c "three classifications defined by the pilot contract"` → candidate **1** (line 130, inside §3.2 heading block 113–144); pre-fix `cba0f0c` → **2**. |
| **N5** | One bad `sources` field reported once; nested-only paths still caught exactly once | **FIXED** | `writtenExam.sources='S2-p41-p39'` → exactly **1** `[sources.refs-type]` (was 2 at `cba0f0c`); delete `writtenExam.sources` → exactly **1** `[sources.field-missing]`; add nested-only `writtenExam.timing.sources=['S9']` → exactly **1** `[sources.ref-unknown]`. Break attempts: nested `timing.sources='S9'` (string) → 1 `[sources.refs-type]`; deep `timing.nested.deep.sources=['S9']` → 1 `[sources.ref-unknown]`; `writtenExam.sources=['S9-p1-p1']` → 1 `[sources.ref-unknown]`; `sections[0].sources='bad'` → 1 `[sources.refs-type]`. The dedupe skips only paths the schema pass already validated; no genuinely-bad nested field is skipped, and no path is double-reported. |

**N2, N3, N4, N5 are FIXED as claimed. N1 is fixed for the exact claim it makes (top-level guard now presence-based), but the
rewrite that implemented it introduced a new regression (NEW-1).**

## New defects introduced by the corrections

**NEW-1 — the N1 rewrite silently dropped `grade` from the nested `expected.*` guard (low–medium).**
At `cba0f0c` the nested expectation block iterated its own literal list that **included `'grade'`**:
`['grade','gradeBand','readiness','passed','overallResult','learnerScore','percentage']`. The `c8c86dc` fix replaced that literal
with the new shared `claimFields = ['expectedGrade','gradeBand','readiness','overallResult','passed','learnerScore','percentage',
'overallPassed','certificate','finalGrade']`, which **does not contain `'grade'`**. `'grade'` was also never in the top-level list,
so the field is now unguarded at both levels.

Reproduced:
- `cba0f0c`: `OMC-LV1-01.expected.grade = 'sehr gut'` → **REJECTED**
- `c8c86dc`: `OMC-LV1-01.expected.grade = 'sehr gut'` → **ACCEPTED (undetected)**

So a nested `expected.grade` carrying a learner grade claim — exactly what the guard exists to prohibit — now passes where it was
previously caught. The shipped fixture does not contain such a field, so the candidate's own checkers/tests stay green; this is a
defense-in-depth regression, not a live false-negative on the checked-in data. Fix: keep `'grade'` in the nested list, or use one
shared list for both the top-level and nested passes and add a failing-before/passing-after regression.

**NEW-2 — the guard remains a fixed name allowlist; a renamed field still carries a claim undetected (low, residual/bilateral).**
Break probes on `OMC-LV1-01` (all `ACCEPTED`, no `prohibited-learner-claim`):
`grade='sehr gut'`, `score=42`, `result='pass'`, `outcome='bestanden'`, `band='B1'` at the top level; and `expected.score=42`,
`expected.result='pass'` nested. This is inherent to a name-list guard and also held at `cba0f0c` for the top-level fields; it is
noted so the guard is not mistaken for a general "no learner-result claim anywhere" check. The `expectedOutcome` check was also
narrowed from substring to exact match, but since `expectedOutcome` must anyway be one of the five `ALLOWED_OUTCOMES`, that change
neither loosens nor tightens the live surface (no `ALLOWED_OUTCOMES` value is a prohibited word).

Nothing else new: N2's added requirement does not over-reject the shipped fixture; N3's new `semantics.*` errors are all satisfied
by the shipped fixture; N5's dedupe was stress-tested above with no false skip and no duplicate.

## Evidence classes (kept separate)

- **Executed:** checker + suite counts, and every probe above, are reproduced validator results on the extracted candidate
  (`c8c86dc`) and, for the N1 regression, the extracted pre-fix `cba0f0c`.
- **Static source review:** `tools/objective-fixture-check.mjs` (claimFields / `PROHIBITED_LEARNER_CLAIMS` / `isNonEmptyString`,
  the N1 diff), `tools/feedback-case-check.mjs` (`TERMINAL_ERRORS`/`INELIGIBLE_ERRORS`, `classificationSemantics` block, terminal
  branch), `tools/exam-blueprint-check.mjs` (`requiredSourceFields`, `checkedSourcePaths`, `walkSourceRefs`),
  `docs/assessment/FEEDBACK-CASES.md` §3.2.
- **Unverified official/expert meaning:** whether telc weights and grading semantics match the fixtures, and structural
  consistency generally, remain human/expert questions. This review certifies **structural consistency only**, never exam meaning.

## Independent verdict

**accept-with-notes.** Four of the five claimed fixes (N2, N3, N4, N5) reproduce cleanly and hold under break attempts; N1's stated
claim (top-level presence-based guard) reproduces as claimed. The corrections do introduce one new defect, **NEW-1**: the N1 rewrite
dropped `'grade'` from the nested `expected.*` guard, so `expected.grade='sehr gut'` is now undetected where `cba0f0c` caught it,
plus the residual **NEW-2** allowlist limitation. Both are low-severity (the shipped fixtures remain green; no live false-negative
on the checked-in data), so this is a note rather than a reject. Recommended, smallest first, for the candidate branch: NEW-1 (keep
`'grade'` in the nested guard / share one list, with a failing-before-passing-after regression); NEW-2 (accept the allowlist limit
or widen it consciously). No merge, force-push, rebase or candidate edit was performed by this review. Pinned to
`c8c86dc94e97a0760e6c5216da47198021a29a39`; if the branch advances, these results stand as the pinned set and only the new delta
should be inspected.
