# WRITING-OUTCOMES-02 — the mock must stop claiming writing outcomes it cannot support

| | |
|---|---|
| Task / execution | WRITING-OUTCOMES-02 / `writing-outcomes-02-openclaw-20260930-a` |
| Worker | OpenClaw/Hetzner, slot 3 (coordinator `COORD-TAKEOVER-20260930`) |
| Base | `origin/main` @ `41b5efb3b967dc529b6a05c4ff47d99fb757fb94` (re-checked with `git rev-parse origin/main`; matches the base in the assignment) |
| Branch | `codex/writing-outcomes-02` |
| Commits | `ef888ff222ff92c590df92b7f2b9ba4c1149d003` (code + tools), plus the commit that adds this file |
| Pull request | [draft PR #53](https://github.com/ronslink/hatoove/pull/53) (base `main`) |
| Allowed paths | `public/js/exam.js`, `public/js/mock-outcome.js`, `tools/mock-outcome-check.mjs`, `tools/mock-outcome-check.test.mjs`, `tools/mock-outcome-browser-check.mjs`, `work/implementation/WRITING-OUTCOMES-02.md` |
| Status | Fix + focused tests + discrimination + browser evidence done. **No educational, security or privacy gate is closed.** Independent review is batched per Ron's instruction. |

## The defect

The mock exam claimed things the pilot cannot support:

- `gradeMockWriting` scored the writing block with an **offline heuristic**
  (`Math.round(analysis.heuristic * 45 * 0.82)`) whenever the model was unavailable **or the
  call threw**, and recorded those heuristic checks with `store.recordAttempt` as if they were
  assessed writing outcomes.
- `renderMockResult` showed **`Bestanden?` Ja/Nein** derived from the written points alone,
  plus a whole-exam **grade band** from `engine.gradeBand((scored.total / 300) * 100)` — while
  the oral part is never assessed in the pilot.
- `renderMockIntro` printed an **`Aktuelle Prognose`** line straight from `engine.readiness()`.
- Nothing distinguished a **missing** writing result from a **legitimate zero**, and there was
  no guard on block completion, so a timer expiry racing a click could push a block's result
  twice or attach an old result to a new mock.

## The fix

**`public/js/mock-outcome.js` (new, dependency-light: blueprint data only)**

- `assessMockWriting({ text, task, analysis, configured, grade })` returns an entry with
  `status: 'unassessed'` and `points: null` for every non-assessed case — `unavailable`
  (no provider), `too_short` (< 40 words), `feedback_failed` (provider threw) and
  `malformed_feedback` (reply failed validation) — always preserving the submitted `text`.
  A validated model reply becomes `status: 'provisional'` with `points =
  Math.round(feedback.total)`; it never carries a right/wrong verdict (`correct: null`).
- `validFeedback` accepts a reply only when it is internally consistent (four known criteria
  within their maxima, total equal to their sum, the string/array fields the UI renders).
- `buildMockSummary(blockResults)` aggregates **objective** parts with their own denominator
  (180 points across the eight objectively scored parts; per part `correct/total`,
  `points/max`, `percent`), reports Schreiben **separately**, and returns
  `pass: null`, `band: null`, `readinessPercent: null` — the pilot cannot compute them.
  A genuine `points: 0` stays `provisional`/assessed; `points: null` stays unassessed.
- `createCompletionGate()` runs `collect` and `commit` at most once and drops a completion
  whose `isCurrent()` is false, so a stale or duplicate completion cannot record twice or
  land on a later mock.

**`public/js/exam.js`**

- The mock intro no longer shows the readiness prognosis.
- `startMock` and `renderMockBlock` carry a preparation token and a cleanup, and block
  completion goes through the gate; the writing text is carried on the session so it survives
  a re-render; the writing textarea is frozen while feedback is requested.
- `renderMockResult` was rebuilt on `buildMockSummary`: objective points with the 180
  denominator, a Schreiben card that shows either "vorläufig · kein Prüfungsergebnis" with the
  provisional points or "nicht bewertet" with a stable reason, the automatic text check
  labelled "Hinweise, keine Bewertung", and the submitted text kept under
  "Antworten durchsehen" in both the successful and the failed/unassessed case. No
  `Bestanden?`, no grade band, no `/ 225` whole-exam denominator.
- Only confident, model-provided corrections are stored as learner errors
  (`recordMockWritingNotes`); the offline heuristic is no longer recorded as an outcome.

## The seeded patch was a draft and was changed

The adopted `codex/writing-outcomes-01` patch + `mock-outcome.js` were an **untested draft**.
Applying them shows: `mock-outcome.js` kept `points: null` even for the provisional case and
exposed only `validFeedback`/`createCompletionGate`, and the patch **did not touch
`renderMockResult` at all** — so the `Bestanden?`/band view and the `/ 225` denominator
survived, and an unassessed writing entry (`points: null`) was dropped from the "Schreiben im
Detail" card, hiding the very text the fix must preserve. `createCompletionGate` also relied on
`renderMockBlock` wiring that counted as "implemented" only after this change. I kept the seed's
structure where it was right (unassessed/provisional split, `validFeedback`, the gate shape,
the intro and `endBlock` rewiring) and replaced it where it was incomplete or wrong.

## Tests and discrimination

- `node tools/mock-outcome-check.mjs` → **16/16** fixed-tree checks pass.
- `node --test tools/mock-outcome-check.test.mjs` → **20/20**.
- Coverage: missing writing, too-short writing, unavailable writing, malformed reply,
  successful (provisional) writing, legitimate zero vs missing, text preservation, objective
  aggregation and denominator, writing reported separately, no pass/band/readiness, the result
  view (no pass claim, no band, objective-only denominator, unassessed text visible), and three
  completion-gate checks (single commit under concurrency, stale completion dropped, completion
  from a new mock rejected).

**Discrimination (the point of the suite).** The same 16 checks are also run against the
pre-fix `public/js/exam.js`, materialized byte-for-byte from git at `41b5efb` and verified by
sha256 `a4ae5192a133d4373e142ee6e90ddb0805befb6358650730071b7d584a27704e`. On that tree exactly
the recorded **15** checks fail, and the literal pre-fix values are asserted by strict equality:

```
missingWritingPoints          = 0        (absent writing was silently scored as zero)
missingWritingHasNoStatus     = true     (no unassessed/provisional distinction existed)
successfulWritingHasNoStatus  = true
resultViewClaimsPass          = true     ("Bestanden?" was rendered)
resultViewWholeExamDenominator= '/ 225'
```

`exam.js` is a browser view module, so its internal `gradeMockWriting`/`renderMockResult` are
reached by a mechanical transform (strip ESM imports/exports, inject an explicit dependency
map, expose `mockState` through a small accessor) and evaluated in `node:vm`. The transform is
identical for both trees; the model is a stub, so no provider call, credential or learner
record is involved.

## Baselines (unchanged)

| Command | Result |
|---|---|
| `node tools/check.js` | 101 passed, 0 failed |
| `node tools/writing-check.js` | 9 passed, 0 failed |
| `node tools/feedback-check.js` | 14 passed, 0 failed |
| `node tools/server-origin-check.mjs` | 16/16 |
| `node tools/reset-check.mjs` | 9/9 |
| `node tools/revision-check.mjs` | 8/8 (incl. pre-fix discrimination) |
| `node tools/owned-client-check.mjs` | 31/31 |
| `node tools/owned-api-check.mjs` | 24/24 |
| `node tools/keymask-check.mjs` | 12/12 |
| `node tools/progress-equal-check.mjs` | 10 checks (incl. pre-fix discrimination) |
| `node tools/repository-check.mjs` | passed — 276 tracked files, 205 text blobs screened |
| `git diff --cached --check` | clean |

## UI evidence

`tools/mock-outcome-browser-check.mjs` drives the real mock flow in headless Chromium against
an **isolated, offline** server (`B1PREP_FORCE_OFFLINE=1`, `B1PREP_PORT=46131`,
throwaway `B1PREP_ENV_FILE`/`B1PREP_PROGRESS_FILE`, synthetic writing text only): **11/11**
checks pass. It confirms the intro shows no readiness prognosis, both prior blocks advance
once, and the result view shows `Objektive Aufgaben 0 / 180` and `Richtige Antworten 0 / 60`
with **no** `Bestanden` claim and no grade band, keeps the submitted text visible under
"Antworten durchsehen" with `keine KI-Bewertung verfügbar` (the offline/"unavailable" case),
and has no console errors and no horizontal overflow at 1280×900 and at an **emulated**
390×844 viewport (`scrollWidth − innerWidth = 0`).

This is emulated viewport geometry, **not** iPhone/Android hardware: it exercises no real soft
keyboard, touch or audio. Screenshots were captured to `/tmp` during the run but are **not**
committed because the task's allowed paths do not include an evidence directory.

## Coordination incident (please resolve)

A **second, concurrent writer** modified `public/js/exam.js` and `public/js/mock-outcome.js` in
the shared workspace `/root/workspaces/hatoove-writing02` while this task was running: the files
changed under me (e.g. an import line gained `summarizeMockOutcome, WRITING_MAX, WRITING_REASONS`
that this execution did not write), `SEED-exam.patch` was renamed to `SEED-exam-lf.patch`, and
`git worktree list` showed a second worktree at `.openclaw/tmp/wt`. Two `openclaw` sessions had
`cwd = /root/workspaces/hatoove-writing02`. To avoid overwriting that unknown work, this
execution did **not** edit the shared checkout: it worked in a separate clean clone of
`origin/main` and pushed from there. The coordinator should decide which implementation is the
one to keep; the shared checkout's uncommitted changes were left untouched.

## Not verified / boundaries

- No live AI or provider call, no credential, no deployment; all learner text is synthetic.
- Rubric migration and educational approval are out of scope. `E-01` remains a draft and
  unreviewed; nothing here asserts exam fidelity or that any item matches telc standards.
- Browser evidence is emulated viewport geometry only (no real device, keyboard or audio) and
  was not committed (see above). Durable browser recovery is a separate task (`draft-session-01`).
- The result view was checked against a run where every objective answer was left blank; the
  aggregation arithmetic is additionally unit-tested with a mixed-correctness fixture.
- Independent review is batched at the end per Ron's instruction; this PR is a draft and is not
  merged.
