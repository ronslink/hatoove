# USER04-R2 — independent corrected-head fixture acceptance

Execution `user04r2-20260930-a` (OpenClaw/Hetzner slot3, no children) · Issue [#24](https://github.com/ronslink/hatoove/issues/24)
Base `074aebf9697d9a2b047a59b993a3178d94f1fb9f` · Branch `codex/user04-r2-review`
Candidate (read-only, PR #21): `codex/user04-source-fixtures` @ `562902bf6885c2e5c15933039eb9d6943b1fdfb6`, compared to `7030a66`.
Status: **independent review, unreviewed by a human — no content, exam, human or security approval.**

## Method

Candidate extracted with `git archive 562902b` into ignored `.qa/` (never checked out over the report
branch). Three pure checkers + their test files run offline on Node v22.23.2; no browser/server/DB/`.env`/
provider. Each PR #21 remaining finding reproduced with a minimal mutation probe against the exact head
(`.qa/probe-*.mjs`, not committed). Prior review head was `d58e774`.

## Test results (executed, candidate @ 562902b)

| Suite | Command | Result |
|---|---|---|
| Blueprint | `node tools/exam-blueprint-check.mjs` | OK, 0 warning(s) |
| Blueprint tests | `node tools/exam-blueprint-check.test.mjs` | **50/50 pass** |
| Feedback | `node tools/feedback-case-check.mjs` | OK, 5 warning(s) |
| Feedback tests | `node tools/feedback-case-check.test.mjs` | **40/40 pass** |
| Objective | `node tools/objective-fixture-check.mjs` | OK, 0 warning(s) |
| Objective tests | `node tools/objective-fixture-check.test.mjs` | **28/28 pass** |

118/118 committed tests pass — all defects below are gaps the suite does not probe, or rules the suite
codifies incorrectly. Passing tests prove internal shape only, never exam validity.

## Finding status

| # | Finding (PR #21) | Status | Exact anchor |
|---|---|---|---|
| F1 | WFC-04 zeroes content credit for three addressed Leitpunkte | **Present** | `tests/fixtures/writing-feedback-cases.json` WFC-04 |
| F2 | Retry requires a live lease, but failure clears it | **Present** | WFC-10/11/12/15 `expected.retryConditions` |
| F3 | `allowance_exhausted`/`submission_superseded` terminal policy not in contract | **Present** | `tools/feedback-case-check.mjs` `TERMINAL_ERRORS`; WFC-17/20 |
| F4 | Objective accepts missing `expectedCorrectCount` with 999 points | **Present** | `tools/objective-fixture-check.mjs` score block |
| F5 | Objective accepts string `expectedPoints` | **Present** | same block |
| F6 | Objective accepts aggregate learner-score claims | **Present** | same block; `OMC-AGG-01` |
| F7 | Exempts all duplicated LV3 keys, not only `x` | **Present** | `family.key-reuse` guard |
| F8 | Objective crashes on a null item | **Present** | `fam.items.map((i) => i.key)` |
| F9 | Criterion/aggregate `sources` may be absent or a string | **Present** | `walkSourceRefs`; `writtenExam.sources` |
| F10 | Recovery R8 expects the debit at enqueue, not a reservation | **Present** | `docs/qa/DRAFT-RECOVERY-MATRIX.md` R8 |
| F11 | Gap map G2 misstates the grade-band denominator | **Present** | `docs/exam/LEGACY-GAP-MAP.md` G2 |
| F12 | Gap map G4 files the speaking `/25` card as a writing defect | **Present** | G4 vs `public/js/exam.js:1153` |
| F13 | U7 falsely rules out half-point totals | **Fixed** | `TELC-B1-SOURCES.md` U7; JSON `unresolved[U7]` |

## Actionable blockers (minimal failing input)

**F1 — WFC-04.** Three of four Leitpunkte handled must keep content credit: source rule `docs/exam/TELC-B1-SOURCES.md:243-244` (Kriterium I: B = three, D = only one/none) and `:253-254` (only one/no → only I = D). Fixture declares `"leitpunktShortfall": true` and `expected.contentScoreCreditPreserved: false`; `tools/feedback-case-check.mjs` then enforces `[case.leitpunkt-credit]`. Probe: set `WFC-04.expected.contentScoreCreditPreserved = true` → checker fails `case.leitpunkt-credit`. The three-point case cannot be expressed. (The audit trail for this defect is the fixture's own contradiction: `expected.invariants` carries `content-credit-withdrawn-for-leitpunkt-shortfall` while the section-3 row says "the other three keep credit".)

**F2 — retry/lease.** `failJob` (`spikes/auth-runtime/store.mjs`) sets `lease_token=NULL, lease_until=NULL`, and `retry()` never reads a lease; `docs/contracts/PILOT-V0.1.md:57`/`:61` makes retry a fresh re-enqueue. So `liveLease` is not a retry precondition, yet WFC-10/11/12/15 list it and `retryNote` says "the lease is live"; `FEEDBACK-CASES.md` §3.1 too. Minimal failing input: any case whose job state is `failed` with `lease_token IS NULL` still satisfies the fixture expectation.

**F3 — terminal codes.** Contract names only `provider_unavailable`/`malformed_feedback` (retryable) and `retry_exhausted` (never), `PILOT-V0.1.md:61`; `allowance_exhausted` appears only as an HTTP 409 at enqueue (`:34`, `:55`). WFC-17/20 assign job-level `allowance_exhausted`/`submission_superseded`, and §3.2 admits they are "the state outcomes the contract already implies".

**F4/F5/F6 — objective arithmetic.** Guard `if (Number.isInteger(c.expectedCorrectCount))` and `typeof c.expectedPoints === 'number'` skip all checks when either is missing/typed wrong. Probes: `OMC-LV1-01` without `expectedCorrectCount`, `expectedPoints=999` → `ok=true`; `expectedPoints="999"` → `ok=true`; `OMC-AGG-01` with `expectedCorrectCount=42, expectedPoints=150` → `ok=true`. No test deletes `expectedCorrectCount`.

**F7 — LV3 duplicates.** Guard `if (dupes.length && fam.noMatchSupported !== true)` exempts every duplicate once the family supports no-match. Probe: `LV3.items[1].key = items[0].key` (a real option) emits no `family.key-reuse`; the same mutation on `LV1` does emit it.

**F8 — null item.** Probe: `LV1.items[0] = null` → `TypeError: Cannot read properties of null (reading 'key')` instead of a validation error.

**F9 — sources.** `walkSourceRefs` calls `checkSources(..., { optional: true })` only when the value `Array.isArray`. Probes all return `ok=true`: criterion `sources` deleted; criterion `sources="S1"`; `writtenExam.sources` deleted; `writtenExam.sources="S1"`; `writtenExam.sources=[]`. Arrays with a bogus ref *are* caught (`S999` → `sources.ref-unknown`), so the gap is absence/type, not the recursive walk.

**F10 — R8.** R8 invariant/observation read "One submission and one debit … Exactly one submission; one job; one debit", but the contract reserves one allowance at enqueue (`PILOT-V0.1.md:55`) and debits a unit only at a saved assessment (`:52`); at double-click time the debit is 0.

**F11 — G2.** Finding text says the band uses "the written percentage `(written / 225) × 100`", while its own anchor and `public/js/exam.js:1484` use `gradeBand((scored.total / 300) * 100)` (oral 0). The stated denominator (225) is wrong.

**F12 — G4.** G4 lists "the writing subtest result … `g.points / 25`"; `public/js/exam.js:1153` is `renderSpeakingFeedback` (`/ 25`), and the document's own "Not reported as conflicts" says the `/25` card is the speaking grader. It is not a writing defect.

## Not reproduced (do not re-report)

**F13 — U7 (fixed).** Both `docs/exam/TELC-B1-SOURCES.md` U7 and `telc-b1-written-draft.json`
`unresolved[U7]` now state that partial credit *is* genuinely fractional (1.5 per SB item; 2.5 per item in
the 10-item 25-point parts; `.5` aggregates reachable) and explicitly withdraw the earlier
"integer section totals" derivation; `writtenExam.itemWeightsNote` agrees.

## Evidence classes (kept separate)

- **Passed tests:** 50 + 40 + 28 = 118/118 candidate callbacks (listing above); plus each negative probe is a
  reproduced failure.
- **Static source review:** F1–F3 source semantics (`SOURCES.md:243-254`, `PILOT-V0.1.md:52-61`,
  `spikes/auth-runtime/store.mjs`), F10–F11 contract/code anchors, F12 `exam.js:1153`.
- **Unverified official/expert meaning:** whether telc weights a 3-of-4 response as B versus C/D, and any
  publisher rounding rule, remain human/expert questions (U7 narrowed, not settled). No reviewer here
  certifies exam meaning.

## Next action

Coordinator-owned. Suggested triage for the candidate branch, smallest first: F9 (make criterion +
`writtenExam` sources required, non-optional), F4–F6 (require integer `expectedCorrectCount` and numeric
`expectedPoints` before any marked-case arithmetic), F7–F8 (restrict the no-match exemption to the marker;
guard null items), then F1–F3 fixtures/doc semantics and F10–F12 wording. Each needs a failing-before/
passing-after regression, not a raised count. Re-check the corrected head at a coordinator checkpoint; no
merge from this review.

Pinned to `562902bf6885c2e5c15933039eb9d6943b1fdfb6`. If the branch advances, these results stay as the
pinned set and only the relevant delta is inspected.
