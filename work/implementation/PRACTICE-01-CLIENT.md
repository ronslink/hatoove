# PRACTICE-01-CLIENT (slice C, client half) — the part runner

**Status: delivered + revised after REVIEW-PRACTICE-01-CLIENT (task-22), not independently re-reviewed, not
merged.** Author: teammate `practice-client`. Worktree `D:\Hatoove\.worktrees\practice-client`, branch
`codex/practice-01-client`, cut from `codex/practice-01-runner` @ **`c839079`**. First delivery `779bdbf`,
this revision on top of it. Nothing pushed, nothing merged, no other agent's worktree written to.

**THE ONE THING TO KNOW ABOUT THIS CHECK ON THIS BRANCH.** `tools/practice-runner-check.mjs` runs its
server cross-check (leg 12d) BY DEFAULT against the repository's own `server/practice-sets.mjs`. On this
branch that file is still the PRE-FIX copy, so a bare run reports `36 passed, 1 failed` — **and that failure
is the guard telling the truth** (review F2: it used to go silent and print a green summary). With the fixed
normaliser it is `37 passed, 0 failed`, and after integration the default is the fixed file, so no flag is
needed. All four ways of running it are in §5.

## 1. What this is

One part of the written examination, practised as a whole on **one page, untimed, with a single
"Auswerten"**. The result is the **full review** — the prompt, every option, the learner's own pick marked,
the key marked, and the explanation in the chosen language. After the review there are exactly **three
actions**: **Noch ein Satz · Fehler üben · Zur Auswahl**, and the exhausted part is announced with
**„Alle Sätze dieses Teils geübt — von vorn"** instead of silently restarting set one. **The tap is not fixed
at four**: the count comes from the served `round` (`setCount`/`checkedSets`/`wrapped`), so a three-set part
wraps on the fourth tap and **SB1, whose fourth set is the migration-`0022` grammar drill (contract A9),
wraps on the FIFTH**. Listening renders the player and the **exam** play rule from `/api/v1/exam-parts`
(`playback.mock`), disables playback, and says which path is missing.

## 2. Files

| File | Change |
|---|---|
| `public/app/part-runner.js` | **new** — `createPartRunnerView(ctx)` → `{ mount, unmount }` (§4.2), the pure model/markup the check drives, the check-failure classifier, the drill-disclosure echo |
| `public/app/part-runner.css` | **new** — module-owned styles, tokens only, only the system's 860 px step |
| `public/app/part-index.js` | tile open control `[data-part-open]` → dynamic `import('./part-runner.js')` mounted into the **same** host; "Zur Auswahl" re-mounts the index. §4.2's return shape is unchanged |
| `public/app/api.js` | **announced, scope granted by the Lead** — `PATHS.practiceCheck` and the two additive methods `practice.next(family)` / `practice.check(payload)`. `next()` with no argument is byte-identical to before |
| `public/assets/i18n/practice-messages.js` | **shared file, announced** — 43 new keys (38 `partRunner*` + `practiceAllSets` + 4 added in task-22), all five locales. **Additions only: 51 added lines, 0 deletions** vs the branch point, so no existing key was touched |
| `tools/practice-runner-check.mjs` | **new** — 37 offline legs + the automated mutation proof (`--mutations`) |
| `work/implementation/PRACTICE-01-CLIENT.md` | this note |

No shell change (`index.html`, `app.js` untouched), no new ctx member, no new route, no migration, no
`MANIFEST.json` line. No server file was edited.

## 3. The DTO the client consumes

The client consumes the settled DTO `server/practice-sets.mjs#normalisePracticeSet` emits
(@`905cc89` on `codex/practice-01-pg`):

```js
set   = { set_id, version, title, family, section, part, item_count, media_required, playback,
          material: { text?, letter?, headlines?, ads?, bank?, practice_kind?, instruction? }, items: [...] }
item  = { item_id, ordinal, prompt, prompt_en, answer_kind: 'choice'|'judgement', options: [{ id, text, value }] }
review item = { item_id, correct, chosen, expected, answer_kind, evidence_id, explanation }
```

- `value` is the JSON value that is POSTed and it is **typed** — a boolean for a richtig/falsch item. The
  client posts the option's `value`, never its `id`; `mark_objective_item` compares JSONB, so a stringified
  `"true"` is marked wrong for every learner (pinned by mutation M4).
- `answer_kind` decides the control; the client never infers it from the family.
- `material.text` (LV2) and `material.letter` (SB1/SB2, and the drill) are rendered as the passage the tasks
  are worked from. The option banks (`headlines`/`ads`/`bank`) are deliberately **not** re-rendered, because
  every item already carries them as its own option list.
- `material.practice_kind` / `material.instruction` are the **drill disclosure** (A9(c): labelled, not
  filtered). The client echoes them when served and invents nothing when not; a top-level
  `practice_kind`/`instruction` is also accepted, as the pre-`905cc89` bridge.
- A **judgement** option is served with an EMPTY `text`, so the exam's own `richtig`/`falsch` fills it.
- A reviewed item's `explanation` is **`null`** for a judgement item and for any item of a media-required
  set. That is the honest value, and the review says so (§6).
- LV3's no-match sentinel (`id:"x"`, empty text, value `"x"`) is labelled with its id plus
  `partRunnerNoMatch` („Keine Anzeige passt").

### 3.1 The server-side gap found while doing this (reported, not patched around)

`PROMPT_FIELDS = ['question','statement','text']` does not include **`prompt`**, and the migration-`0022`
drill's twelve items carry their sentence in exactly that field. So the served drill has `prompt: ''` on
every item (the letter material still carries the twelve sentences, so the page is usable, but each task is
prose-less). Measured in the live harness: `tasks=12, emptyPrompts=12`. The client reads `prompt` FIRST, so
the sentences appear the moment the server serves them; leg **12e** pins the gap (12 authored, 0 served) so
it cannot grow silently. **Owed to the server half.**

## 4. The rendering bridge, and which legs pass only because of it

[bridge] legs exist because the settlement arrived after the runner was written: `readServedItems` also
accepts the authored per-item shapes (item id from `id`/`n`, prompt from `question`/`statement`/`text`,
options from an object, the set-level `headlines`/`ads`/`bank` lists, and the truth pair for a bare
`statement`). **The normalised DTO is the contract; the bridge is not.** The split the Lead asked for:

| Leg | Depends on the bridge? |
|---|---|
| 1, 1b, 2, 3, 3b, 4, 4b, 4c, 5, 6, 6b, 7, 7b, 7c, 7d, 8, 8b, 9, 9b, 9c, 10 | **no** — driven with the served DTO |
| 12, 12b, 12c, 12d, 12e, 12f | **no** — the served DTO built over the real 25-set corpus |
| 14, 14b–14f | **no** — the check-failure classification and its markup |
| 13, 13b | **yes — [bridge] only** |

When the DTO legs carry the slice on both sides, legs 13/13b can be deleted, and with them `readOptions`'
authored-object/`word` branches, `readSetOptions`, the `statement` truth-pair fallback, `readMaterial`'s
`payload` fallback and the top-level disclosure fallback. **12e's bridge half** (the client reading the
authored `prompt`) is what lets the drill render its sentences the day the server serves them.

## 5. Commands and results

Run from `D:\Hatoove\.worktrees\practice-client`:

```text
node tools/practice-runner-check.mjs
  36 passed, 1 failed   <- leg 12d fails BY DESIGN on this branch: the repository normaliser is the pre-fix copy
node tools/practice-runner-check.mjs --server=D:\Hatoove\.worktrees\practice-server\server\practice-sets.mjs
  37 passed, 0 failed   <- the fixed normaliser (@905cc89)
node tools/practice-runner-check.mjs --sets=D:\Hatoove\.worktrees\practice-server\server\practice-sets.mjs
  37 passed, 0 failed   <- DEFAULT cross-check active, simulating the integrated repository (no flag needed)
node tools/practice-runner-check.mjs --server=… --mutations
  37 passed, 0 failed ; 4/4 mutations failed exactly the intended leg
```

Every other gate, at this head:

```text
node tools/part-index-check.mjs            11 passed, 0 failed
node tools/design-check.mjs                14 passed, 0 failed, 2 pre-existing warnings
node tools/i18n-register-check.mjs         0 findings, 11 shipped files
node tools/practice-locale-check.mjs       18 checks passed
node tools/practice-selection-check.mjs    11 legs, 0 failed (incl. its 5 mutation proofs)
node tools/repository-check.mjs            732 tracked files, 649 text blobs   (review F5: 732/649 at this head)
node tools/retired-surface-check.mjs       10 passed, 0 failed
node tools/seo-check.mjs                   11/11 checks passed
node tools/server-origin-check.mjs         8 checks passed
node tools/keymask-check.mjs               14 checks passed
node tools/owned-api-check.mjs             34 passed, 0 failed (backend: memory)
node tools/owned-client-check.mjs          32 passed, 0 failed
```

**Not run, and why:** `migrate-check.mjs`, `table-class-check.mjs` and `migration-eol-check.mjs` abort with
`ERR_MODULE_NOT_FOUND: Cannot find package 'pg'` — this worktree has no `node_modules` (there are no npm
dependencies at the repository root). None of them touches a file this slice changed; the server-side review
ran them on `codex/practice-01-pg`.

### 5.1 The mutation proof, now IN the check (review F4)

`node tools/practice-runner-check.mjs --mutations` copies `public/` per mutation into `%TEMP%`, verifies the
copy's hash CHANGED before running it, re-runs this check as a child (with `--no-mutations` so the proof
cannot recurse), and requires **exactly one** leg to fail:

| Mutation | Intended leg | Result |
|---|---|---|
| M1 the review drops the key marker (`data-option-marker="key"` → `"key-disabled"`) | 2 | PASS — leg 2 only |
| M2 the exhausted part gets the silent restart label (`key: wrapped ? WRAP_KEY : …` → `key: ACTION_KEYS.next`) | 6 | PASS — leg 6 only |
| M3 replay offered before "Auswerten" (`const reviewed = state.phase === 'review'` → `true`) | 7 | PASS — leg 7 only |
| M4 the served option `value` is stringified | 7 | PASS — leg 7 only (the boolean assertion) |

The reviewer reproduced the same four legs by hand (M1→2, M2→6, M3→7, M4→7); the check's header now says so.
The earlier header's "M3 → leg 8" was wrong and is corrected.

**The cross-slice guard discriminates too.** A copy of the FIXED normaliser with `optionEntry`'s typed
`value` stringified (sha `B2BBE31B`→`2B5E3A2B`, verified changed) makes the check report
`36 passed, 1 failed` — **leg 12d only**. `12d` is therefore live evidence about the server, not a
formality.

## 6. What changed in task-22, and why

**F2 — the guard cannot go dark.** Leg 12d's `--server` default is now the repository's own
`server/practice-sets.mjs`; the skip-and-print-a-NOTE path is gone; the summary line names the file it drove
(`server cross-check (leg 12d): …`); a run with no flag also asserts the resolved path IS the repository
file, so a future refactor cannot repoint the guard at a copy. When that file cannot serve the corpus the
leg FAILS with a message that says what to do (integrate the server branch, or `--server=<fixed>` meanwhile).
Proved in all four states: pre-fix default **fails 12d**, fixed `--server` **37/0**, fixed-as-repository
(`--sets`) **37/0 with the default active**, mutated normaliser **12d only**.

**F3 — the corpus leg is the A9 corpus.** Leg 12 now parses **both** migrations and asserts **25 sets with
SB1 at four**, the drill's id/kind/instruction/12 items, and prints the drill line. **12b now checks key
reachability per ITEM** (it sampled `items[0]` before, which for LV2/SB1 judged one item out of five or ten).
New legs: **12c** renders all 25 sets, **12e** renders the drill (12 tasks, 36 options, the letter, the
pinned `prompt` gap), **12f** echoes the disclosure from `material` and invents nothing when it is absent.

**F1 — a refused "Auswerten" is an ERROR, not a notice.** `checkFailureOf` classifies every refusal and the
answer is rendered with `role="alert"` (`data-runner-check-error`), never as the muted line it used to be:

| kind | when | what the learner gets |
|---|---|---|
| `retryable` | transport failure, 5xx | the alert with `partRunnerCheckFailed` (whose retry promise is true here) and the still-enabled "Auswerten" as the retry |
| `recover-review` | 409 `attempt_already_checked` **and this view holds the review** | the review, plus "Dieser Satz wurde bereits ausgewertet. Die Auswertung wird erneut angezeigt." |
| `closed` | 409 `attempt_already_checked` and **no** review ever arrived | `partRunnerCheckClosed` — true, no retry promise, "Auswerten" disabled, and two ways forward |
| `archived` | 409 `preparation_archived` (refused by the transport before the request is sent) | `partRunnerCheckArchived`, "Auswerten" disabled, two ways forward |
| `blocked` | everything else (400/401/403/404/415/422/428, other 409s) | `partRunnerCheckBlocked`, "Auswerten" disabled, two ways forward |

The two ways forward are `data-runner-recover="next"` ("Noch ein Satz") and `="index"` ("Zur Auswahl"),
deliberately NOT `data-runner-action`, so "exactly three actions" stays reserved for the post-review row.
The retry loop is closed at both ends: `evaluate()` refuses locally once the failure is non-retryable, and
the control is disabled, so the measured 404→409→409 loop cannot happen. Six legs cover it (14–14f).

**A9 / explanation honesty.** A reviewed item whose explanation is `null` renders
`partRunnerExplanationUnavailable` ("Für diese Aufgabe ist keine Erklärung verfügbar.") — never the
"noch nicht geladen" copy, which promised something that is not coming — with
`data-explanation-status="unavailable"`, and the language control is offered only when at least one item
actually has an explanation to re-read.

**Documentation (F4/F5/F6).** The check's header mutation table is corrected and the proof is automated;
`repository-check` is recorded at this head (**732/649**, not the base's 728/645); the stale "FOURTH tap of a
three-set part" prose in `part-runner.js` and in §1 is corrected to the per-part count (SB1 wraps on the
fifth tap).

**Catalogue.** Four keys were genuinely missing and are added (announced): `partRunnerCheckClosed`,
`partRunnerCheckArchived`, `partRunnerCheckBlocked`, `partRunnerExplanationUnavailable`. No existing key was
changed — the diff is **51 added lines, 0 deletions** — so `partRunnerCheckFailed` keeps its original copy
and is simply no longer rendered where its promise would be false.

## 7. Rendered evidence

Untracked and **gitignored** (`/handoff/`), in `D:\Hatoove\.worktrees\practice-client\handoff\ron-agent\`:
`practice-runner-harness.html` (standalone; loads the pinned stylesheets, the module's own CSS, a
`section.view` + host, and mounts the REAL module with a stub transport; the wrap scenario drives the REAL
`server/practice-sets.mjs#practiceRoundState`), `static-server.mjs` (read-only GET on `127.0.0.1:4191`,
**killed after the run, port verified free**), and 14 screenshots.

Refreshed for this revision (the two states the fixes changed):

| Screenshot | Measurement in the live DOM |
|---|---|
| `practice-runner-listening-review-390-light.png` | a judgement review with **`explanation: null`**: 3 items, `data-explanation-status="unavailable"` ×3, the honest copy, **0** language controls, **0** explanation slots, 1 replay control (after Auswerten), 3 actions, overflow **0** |
| `practice-runner-drill-390-light.png` | the migration-`0022` drill read from the SHIPPED migration text: `data-runner-practice-kind="grammar-drill"`, the authored instruction as an `ltr` island, `material.letter`, **12** tasks, **36** options, 1 "Auswerten", overflow **0** — and **12 empty item prompts**, the server-side gap of §3.1 made visible |

The other twelve are unchanged from `779bdbf` and still match the committed code: the task-22 changes touch
the check-failure states (no screenshot is in one), the judgement review (refreshed above) and the disclosure
(new drill screenshot). The answering, review, wrap, theme, 320 px and Arabic states are unaffected by them,
and their measured numbers (tasks/options/markers/actions/overflow) are unchanged.

**The harness caveat, stated plainly:** every screenshot is **stub-driven**. The two practice routes were not
executed against a database by this lease; these images prove layout, theme, wrapping, the control set and
the copy, not that a real server serves the payload. Leg 12d is what ties the fixture to the real normaliser.

**Known cosmetic defect (left in, so the evidence matches the committed code):** in the review, an option
that is both the learner's pick and the key shows two chips on one row; at 320 px the row wraps below the
option text. Legible at every width (`data-option-state="key-chosen"` is the marked state).

## 8. What was NOT verified

1. **The routes against a database.** Every network interaction here is a stub; the server-side review
   (task-19/task-20) is where the routes were driven over HTTP against PostgreSQL.
2. **The real shell in a browser.** No browser has ever loaded `#/pruefungsteile` from a running server, so
   the shell's dynamic `import()` + stylesheet-injection path is exercised only by the shell's own checks.
3. **`pg`-dependent checks** (§5) and any progress/history read.
4. **Real learner evidence.** The stub derives verdicts from what the client POSTed, so the rendering of the
   server's verdicts is proved and the server's marking is not.
5. **Device behaviour.** No real phone, screen reader or keyboard pass. Audio was never played.
6. **Native review of the 43 new strings** in uk/ar/tr, owed as for every other slice.

## 9. Residual risk

- **The default run is red until the server branch integrates** (§5). That is F2 working, not a regression,
  and the failure message says so — but an integrator who reads only the summary line needs this paragraph.
- **`Fehler üben` needs a second sitting.** "Auswerten" on an already-checked attempt is
  `409 attempt_already_checked`; the mistake round opens a FRESH sitting through `?family=` and narrows it to
  the wrong item ids. When the rule serves a different set, none of those ids exist and the whole new set is
  shown with an honest note.
- **The bridge can mask a server regression**; leg 12d (now always active) is the guard, and 12e's bridge
  half is what renders the drill's sentences when the server starts serving `prompt`.
- **The drill's per-item prompt is empty today** (§3.1) — a server-side gap, pinned by 12e.
- **`material` paragraphs** are split on blank lines; a passage with a single `\n` renders as one paragraph.
- **The judgement labels** (`richtig`/`falsch`) and the LV3 no-match hint are client copy for a server that
  serves empty option text.
- **`api.js` was outside the original write scope**; the Lead granted it for exactly these two additive
  methods, and no other lease touches the file.
- **Attempt reuse is one-way.** A review is re-readable only from the state the runner holds; a reload loses
  it (no "read my last attempt" route for practice, by design).

## 10. Next action

1. Independent re-review of this revision (the four must-fix items), then integration by the Lead on top of
   the server branch; at that point the default `practice-runner-check.mjs` is green because the
   repository's own normaliser is the fixed one.
2. `practice-server` owns the drill `prompt` gap (§3.1) and the media-aware explanation reader (listening
   explanations stay `null` until then; the review now says so).
3. The **practice playback path** is a separate slice (PRACTICE-MEDIA, `task-17`, server-only): the
   recordings exist, and the runner says so and disables playback rather than faking it.
