# PRACTICE-01 (slice C) — part runner, selection rule, practice attempts

**Status: PARTIAL — the server half is delivered and committed; the client half is NOT delivered in this
lease.** Author `library-i18n` (task-9). Branch `codex/practice-01-runner`, worktree
`D:\Hatoove\.worktrees\practice-01`, based on local main **`88f18e1`**. Nothing pushed, nothing merged.

The lease ran out of budget on the client half. Rather than half-write the runner, this note records exactly
what is in, what is not, and the design for the remainder so the next lease starts from a decision instead of
a blank page. **Do not integrate this branch as a finished slice C.**

## 1. Delivered (two commits)

| Commit | Content |
|---|---|
| `e3da490` | `0044-practice-attempts.sql` + its MANIFEST line, `server/practice-sets.mjs` (pure rule), `tools/practice-selection-check.mjs`, the account-deletion registration for the new table |
| `5adc224` | `server/owned-postgres/adapter.mjs` (**outside my listed scope — announced**): `practiceSetForPart`, `checkPracticeAttempt`; `server/owned-api.mjs` (**also announced**): `?family=` on `/api/v1/practice/next` and `POST /api/v1/practice/check` |

**`0044-practice-attempts.sql`** — `practice_attempt`: the sitting, stored apart from mock runs. 5 360 bytes,
LF-only, sha256 `42b48a1b7daef8192608f60d646bdda914056e1bbab58666ffa0ac6ed688131e`, added as one line to
`MANIFEST.json`; `0043`'s line is byte-identical afterwards. RLS + FORCE, owner policy for the learner role and
a deletion policy for `__DELETION__`, SELECT plus **column-level** INSERT/UPDATE (the identity and the set can
never be rewritten from the runtime role), and a trigger pinning the identity and the one-way
`open → checked` state. A practice answer is the `item_evidence` row with `mock_run_id IS NULL`; this table is
the only record that a sitting existed.

**`server/practice-sets.mjs`** — the pure half: `rankPracticeSets` / `selectPracticeSet` (unseen first, then
most wrong, then oldest, total tie-break by set id), `practiceRoundState` (the A1 wrap: with three sets, the
**fourth** "Noch ein Satz" returns `notice: 'practiceAllSets'` instead of silently restarting), and
`normalisePracticeSet`, which serves items without a key, transcript or explanation and **throws
`practice_set_items_unknown`** rather than serving an empty set when it does not recognise the authored item
member.

**`GET /api/v1/practice/next?family=LV2`** — serves ONE released set of that part through the rule, opens the
sitting, returns the rule's own numbers as the reason (`reason: 'unseen' | 'most-wrong' | 'oldest'`) and the
wrap state. **`POST /api/v1/practice/check`** — "Auswerten": marks every answer with
`mark_objective_item` (0015), records the evidence, reveals the key with `reveal_objective_answer` (0041, which
returns it only after the learner's own evidence row exists), closes the sitting, and the route attaches the
explanation through the **existing** `readObjectiveEvidenceExplanation` reader. Both routes gate on the method
being present rather than joining `PRACTICE_METHODS`, so the memory backend's contract is unchanged.

## 2. Evidence

```text
node tools/practice-selection-check.mjs     11 legs, 0 failed + 5 mutation proofs
node tools/migrate-check.mjs                6 passed, 0 failed
node tools/table-class-check.mjs            87 table rows; 0 failures
node tools/migration-eol-check.mjs          5 passed, 0 failed
node tools/owned-api-check.mjs              34 passed, 0 failed (backend: memory)
node tools/repository-check.mjs             726 tracked files; 643 text blobs
```

**The three tiers, proved with crafted evidence rows** (`practice-selection-check.mjs`): tier 1 an unseen set
beats a set with three wrong answers; tier 2 with all sets seen the most wrong wins (4 wrong beats 2 and 1);
tier 3 equal wrong counts fall back to the oldest first touch; a set with zero wrong is the *oldest* tier, not
the wrong tier; foreign evidence for another set is ignored; the order is total.

**Mutation proof** — each rule broken in a `%TEMP%` copy, and each breaks the intended legs:

| mutation | result |
|---|---|
| M1 tier 1 removed | leg 1 fails |
| M2 most-wrong inverted | legs 3 and 5 fail |
| M3 oldest → newest | legs 4 and 5 fail |
| M4 wrap never fires | leg 8 fails |
| M5 the served set carries `answer` | leg 11 fails |

**Disposable PostgreSQL** (`postgres:17-alpine`, `127.0.0.1:55447`, removed afterwards; never the live app):

- a scratch migration set stopping at **0043** → `applied=41 skipped=0`;
- then the real directory → **`applied=1 skipped=41`** — only `0044` applied; `practice_attempt` exists;
- a **fresh** database → `applied=42 skipped=0`.

`table-class-check` first reported one failure — *"owned table is absent from ACCOUNT_TABLES (the deletion
read-back would skip it)"* — which is exactly the gate working: the table is now in `ACCOUNT_DELETION_STEPS`
(removed before `learner_preparation`, the way `item_evidence` is) and in `ACCOUNT_TABLES`, and the check is
green again.

## 3. NOT delivered in this lease

1. **The client half**: `public/app/part-runner.js`, `public/app/part-runner.css`, the tile open action in
   `public/app/part-index.js` (a tile dynamically imports `./part-runner.js` and mounts it into the same host;
   "Zur Auswahl" returns to the index — the Lead's design decision, no shell change needed), and the new
   catalogue keys in `public/assets/i18n/practice-messages.js` (the wrap copy and the three actions).
2. **`tools/practice-runner-check.mjs`**: the check that must pin the wrap message on the fourth tap, the
   three actions, the full review and the replay rule. `practiceRoundState` is already pinned offline by
   `practice-selection-check.mjs` legs 8–10, so the *rule* is proved; the *copy and buttons* are not.
3. **PostgreSQL legs for the two new routes**: `practiceSetForPart` and `checkPracticeAttempt` parse and keep
   the memory contract green, but **they have not been executed against a database**. That is the first thing
   the next lease must do.
4. **Rendered evidence**: no 1366/390 (both themes) and no 320 px run.

## 4. Design for the remainder (decisions already made, so nothing is re-argued)

- **Runner composition.** `part-index.js` stays the index; a tile's open action dynamic-imports
  `./part-runner.js` and mounts it into the *same* host (`#part-index-host` / `#hoeren-host`), passing
  `{ host, family, api, uiText, esc, language }`. `unmount()` restores the index. No shell edit, no new ctx
  member.
- **One page, untimed, one "Auswerten".** Answers are held client-side; "Auswerten" posts
  `{preparationId, attemptId, answers, language}` once to `/api/v1/practice/check` and renders the review.
- **Listening.** The player sits on top, every item below. The **exam** play rule is read from
  `/api/v1/exam-parts` (slice B, integrated: `playback.mock` per family) and enforced in the runner's state
  machine; a replay is offered only after "Auswerten". **HV audio is not delivered** (`0010` records that the
  HV sets' `script` is the transcript of audio that does not exist), so the player must degrade honestly
  ("Audio folgt") instead of pretending to play — and that is a product decision worth confirming.
- **Three actions, exactly**: `Noch ein Satz` (re-fetch `?family=`), `Fehler üben` (re-enter the items the
  learner got wrong), `Zur Auswahl` (back to the index). On the fourth tap, `round.wrapped` is true and the
  button must render the wrap copy — never a silent restart.
- **`empty`/`error` states** for a part with nothing servable (`reason: 'nothing_available'`).

## 5. Unverified and residual risk

1. **The two new server methods are unexecuted against PostgreSQL** (§3.3). Treat the SQL as unverified.
2. **The authored item member name** (`payload.items`, with `texts`/`questions` accepted) is an assumption
   read from the neighbouring DTOs, not from `data/seed.json`. The normaliser now throws rather than serving a
   blank page, so a wrong guess surfaces at the first request.
3. **`ACCOUNT_TABLES`/`ACCOUNT_DELETION_STEPS` are in `adapter.mjs`, outside my listed scope.** I edited them
   because the table-class gate requires it; **the Lead must serialise that edit** with any other adapter writer.
   `owned-api.mjs` is the same situation.
4. **No client at all** yet: slice C's user-visible acceptance is not met, and no screenshot exists.
5. **The wrap copy** is pinned only as a notice key, not as text in five locales.
6. **Attempt reuse**: a second "Auswerten" on the same attempt is `409 attempt_already_checked`
   (`attempt_already_checked`), which the runner must turn into the review it already has, not an error.
7. **`node_modules`** (`pg`) was copied read-only into `server/owned-postgres/node_modules` of this worktree
   for the database legs. It is gitignored; disclose it to the reviewer, as in earlier slices.

## 6. Next action

Extend this lease (or reassign task-9) to complete §3 — the client half, the runner check and the rendered
evidence — starting with the PostgreSQL legs for `practiceSetForPart` and `checkPracticeAttempt`, because those
two methods are the only code here that has never run.
