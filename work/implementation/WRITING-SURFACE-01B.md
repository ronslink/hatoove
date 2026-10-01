# WRITING-SURFACE-01B — task record

**Branch:** `codex/writing-surface-01b`
**Base SHA:** `e126d8c4b18a2beaf58eca2d279fe8d191e825ae` (`origin/codex/ownapi-03-persistent`, verified)
**PR target:** `codex/ownapi-03-persistent`

Status: IN PROGRESS (skeleton committed first, per §0 rule 1).

## Step 1 — the writing entry point, found by reading

Grep of `public/js/exam.js` for `saveNow`, `recordAttempt`, `draft`, `textarea`, `writing` (1648 lines) gives the finding plainly.

**The standalone Schreiben view — this slice's target**

| What | Line |
|---|---|
| `writingView(el, params)` — the writing screen | `public/js/exam.js:603` |
| `renderWritingTask(el)` — builds the screen | `:621` |
| the learner's text lives at `textarea#writing-text` | `:656` |
| text read for the word count | `:683` |
| text read for the offline check | `:725` |
| text read for AI grading | `:737` |
| grading records weakness **tags** via `store.recordAttempt(...)` | `:771`, `:775`, `:777`, `:778`, `:789` |
| view teardown (stops the timer only) | `:1638` `teardownExamViews()` |

**Finding (the plan's assumption is wrong, so it is recorded rather than worked around):** the plan
allows that the writing text "may go through `store.saveNow()` or a direct `store.recordAttempt`".
It does **not**. There is **no persistence of the writing text at all today** — no `store.saveNow()`
call on `#writing-text`, and no `store.recordAttempt` carrying the text. `store.recordAttempt` is
called only for *weakness tags* computed from a completed grading (`:771`–`:789`). Leaving the
Schreiben view therefore discards whatever the learner typed, and re-entering starts from an empty
textarea. This is the gap objective item (3) closes.

**The mock exam's writing block is a second, separate path — deliberately NOT wired here.**
`renderMockWriting` (`:1427`) keeps its text in the in-memory mock session (`session.writingText`,
written at `:1337` and `:1385`, read at `:1317`); the whole mock session is in-memory and persists
nothing. Wiring it would widen the diff and is a different screen. Recorded in LIMITS.

**What `session().openDraft(taskId)` needs from a caller** (`public/js/account.js:376`, `async`):
throws `OwnedClientError('unauthenticated')` unless `phase === 'signed-in'`. Its own `session.open()`
can also reject with `DraftSessionError('unauthenticated')` and re-enters signed-out. A view must
catch both and render a *view state*, not log to the console.

## Sections (to be filled)

- [x] Base SHA + entry point (line numbers)
- [ ] The check and its output, verbatim
- [ ] Acceptance-set-A properties: proven / not proven
- [ ] Discrimination leg and its result
- [ ] Baseline suites re-run with counts
- [ ] LIMITS

## LIMITS

(Pending.)
