# PRACTICE-01-CLIENT (slice C, client half) — the part runner

**Status: delivered, not independently reviewed, not merged.** Author: teammate `practice-client`
(task-16). Worktree `D:\Hatoove\.worktrees\practice-client`, branch `codex/practice-01-client`, cut from
`codex/practice-01-runner` @ **`c839079`**. Nothing was pushed, nothing was merged, no other agent's
worktree was written to. These changes are relative to the branch point (which already carries slice C's
server half from the earlier lease).

The runner is built, its check is green, and the rendered evidence exists. **The two practice routes were
not executed against a database by this lease** — that is `practice-server`'s task-15 lease, and the
server half's own shape defect (below) is fixed on that branch, not on this one.

## 1. What this is

One part of the written examination, practised as a whole on **one page, untimed, with a single
"Auswerten"**. The result is the **full review** — the prompt, every option, the learner's own pick marked,
the key marked, and the explanation in the chosen language. After the review there are exactly **three
actions**: **Noch ein Satz · Fehler üben · Zur Auswahl**, and the fourth tap of a three-set part is
announced with **„Alle Sätze dieses Teils geübt — von vorn"** instead of silently restarting set one
(amendment A1). Listening renders the player and the **exam** play rule from `/api/v1/exam-parts`
(`playback.mock`), disables playback, and says which path is missing.

## 2. Files

| File | Change |
|---|---|
| `public/app/part-runner.js` | **new** — `createPartRunnerView(ctx)` → `{ mount, unmount }` (§4.2), plus the pure model/markup the check drives |
| `public/app/part-runner.css` | **new** — module-owned styles, tokens only, only the system's 860 px step |
| `public/app/part-index.js` | tile open control `[data-part-open]` → dynamic `import('./part-runner.js')` mounted into the **same** host; "Zur Auswahl" re-mounts the index. §4.2's return shape is unchanged |
| `public/app/api.js` | **announced, scope granted by the Lead** — `PATHS.practiceCheck` and the two additive methods `practice.next(family)` / `practice.check(payload)`. `next()` with no argument is byte-identical to before |
| `public/assets/i18n/practice-messages.js` | **shared file, announced** — 39 new keys (38 `partRunner*` + `practiceAllSets`), all five locales, **additive only**; no existing key changed |
| `tools/practice-runner-check.mjs` | **new** — 29 offline legs + 4 mutation proofs |
| `work/implementation/PRACTICE-01-CLIENT.md` | this note |

No shell change (`public/app/index.html`, `public/app/app.js` untouched), no new ctx member, no new route,
no migration, no `MANIFEST.json` line.

## 3. The DTO the client consumes (and the server-side gap that was found first)

**FOUND BY THIS LEASE, FIXED BY `practice-server` (task-15), NOT HERE.** Reading
`normalisePracticeSet` against the corpus that is actually in the database showed that the server half could
not serve 7 of the 8 families: the stored payload is the AUTHORED shape (LV2 `questions` with an options
OBJECT, LV3 `situations` + `ads`, SB1/SB2 `gaps` + `letter`, HV `items` + `statement` with BOOLEAN keys),
while the normaliser accepted `items`/`texts`/`questions`, read `item_id`/`options` as an array, and threw
`practice_set_invalid` or `practice_set_items_unknown` otherwise. Evidence (extracted from
`server/migrations/0010-objective-catalogue.sql`, the file the database is seeded from):

```text
family  item member   item 0                              options                key values
LV1     texts         {id:"1",text}                       set-level headlines    b,c,f,g,d
LV2     questions     {n:6,question,options:{a,b,c}}      per item, OBJECT       letters
LV3     situations    {n:11,text}                         set-level ads          letters a-j AND "x"
SB1     gaps          {n:21,options:{a,b,c}}              per item, object       letters
SB2     gaps          {n:31} only                         set-level bank{id,word} letters a-j
HV1-3   items         {n:41,statement}                    none (richtig/falsch)  BOOLEANS
```

Reported to the Lead with the table and the two hard constraints (`mark_objective_item` compares JSONB with
`expected = p_answer`, so HV answers must be posted as booleans; the `objective_key.answers` keys are
`String(item.id ?? item.n)`). The Lead assigned the fix to `practice-server`, which has since rewritten
`normalisePracticeSet` on `codex/practice-01-pg`. **This client now consumes that settled DTO:**

```js
set   = { set_id, version, title, family, section, part, item_count, media_required, playback,
          material: { text?, letter?, headlines?, ads?, bank? }, items: [...] }
item  = { item_id, ordinal, prompt, prompt_en, answer_kind: 'choice'|'judgement', options: [{ id, text, value }] }
```

`value` is the JSON value that is POSTed and it is **typed** — a boolean for a richtig/falsch item. The
client posts the option's `value`, never its `id`, and `answer_kind` decides the control (a judgement item
offers exactly two). `material.text` (LV2) and `material.letter` (SB1/SB2) are rendered as the passage the
tasks are worked from; the option banks (`headlines`/`ads`/`bank`) are deliberately **not** re-rendered,
because every item already carries them as its own option list.

Two consequences the server leaves to the client, both handled here:

- a **judgement** option is served with an EMPTY `text`, so the exam's own `richtig`/`falsch` fills it (exam
  language, not interface copy);
- LV3's no-match sentinel (`id:"x"`, empty text, value `"x"`) is labelled with its id plus
  `partRunnerNoMatch` („Keine Anzeige passt").

## 4. The rendering bridge, and which legs pass only because of it

[bridge] legs exist because the settlement arrived after the runner was written: `readServedItems` also
accepts the authored per-item shapes (item id from `id`/`n`, prompt from `question`/`statement`/`text`,
options from an object, the set-level `headlines`/`ads`/`bank` lists, and the truth pair for a bare
`statement`). **The normalised DTO is the contract; the bridge is not.** The split the Lead asked for:

| Leg | Depends on the bridge? |
|---|---|
| 1, 1b, 2, 3, 3b, 4, 4b, 4c, 5, 6, 6b, 7, 7b, 7c, 7d, 8, 8b, 9, 9b, 9c, 10 | **no** — driven with the served DTO |
| 12, 12b, 12c, 12d | **no** — the served DTO built over the real 24-set corpus |
| 13, 13b | **yes — [bridge] only** |

When the DTO legs carry the slice on both sides (they now do: see 12d), legs 13/13b can be deleted, and
with them `readOptions`' authored-object branch, `readSetOptions`, the `statement` truth-pair fallback and
the `payload` fallback in `readMaterial`. Until then they are what keeps a page from rendering blank if the
server half regresses to the authored shape.

**The strongest leg is 12d**: with `--server=<path to server/practice-sets.mjs>` the check drives the
SERVER's own normaliser over all 24 stored payloads and deep-compares its output with the client's expected
DTO. That is a real contract proof, and it passes against `practice-server`'s rewritten file (§6).

## 5. Commands and results

Run from `D:\Hatoove\.worktrees\practice-client`:

```text
node tools/practice-runner-check.mjs                                     29 passed, 0 failed
node tools/practice-runner-check.mjs --server=D:\Hatoove\.worktrees\practice-server\server\practice-sets.mjs
                                                                         29 passed, 0 failed  (12d compares against the SERVER)
node tools/part-index-check.mjs                                          11 passed, 0 failed
node tools/design-check.mjs                                              14 passed, 0 failed, 2 pre-existing warnings
node tools/i18n-register-check.mjs                                       0 findings, 11 shipped files
node tools/practice-locale-check.mjs                                     18 checks passed
node tools/practice-selection-check.mjs                                  green (incl. its 5 mutation proofs)
node tools/repository-check.mjs                                          728 tracked files, 645 text blobs
node tools/retired-surface-check.mjs                                     10 passed
node tools/seo-check.mjs                                                 11/11 passed
node tools/server-origin-check.mjs                                       8 passed
node tools/keymask-check.mjs                                             14 passed
node tools/owned-api-check.mjs                                           34 passed (backend: memory)
node tools/owned-client-check.mjs                                        32 passed
```

**Not run, and why:** `migrate-check.mjs`, `table-class-check.mjs` and `migration-eol-check.mjs` all abort
with `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'` — this worktree has no `node_modules` (there are no
npm dependencies at the repository root; the earlier lease copied `pg` read-only into its own worktree).
They are outside the AGENTS.md offline baseline and none of them touches a file this slice changed.

### 5.1 Mutation proof (`%TEMP%` copies, each hash-verified as changed before it ran)

| Mutation | Result |
|---|---|
| M1 the review drops the key marker (`data-option-marker="key"` → `"key-disabled"`) | FAIL leg 2 — `28 passed, 1 failed` |
| M2 the fourth tap gets the silent label (`key: wrapped ? WRAP_KEY : …` → `key: ACTION_KEYS.next`) | FAIL leg 6 — `28 passed, 1 failed` |
| M3 replay offered before "Auswerten" (`const reviewed = state.phase === 'review'` → `true`) | FAIL leg 7 — `28 passed, 1 failed` |
| M4 the served option `value` is stringified | FAIL leg 7 (the boolean assertion) — `28 passed, 1 failed` |

M4 is the mutation the typed-value contract needs: it is the difference between an HV item being marked
correctly and being marked wrong for every learner.

## 6. Rendered evidence

Untracked and **gitignored** (`/handoff/`), in
`D:\Hatoove\.worktrees\practice-client\handoff\ron-agent\`:

- `practice-runner-harness.html` — a standalone page that loads the pinned stylesheets, `app.css` and the
  module's own `part-runner.css`, provides the `section.view` + host the shell provides, and mounts the REAL
  `public/app/part-runner.js` with a **stub transport** for the two practice routes, `/api/v1/exam-parts` and
  the per-evidence explanation read. The wrap scenario drives the REAL
  `server/practice-sets.mjs#practiceRoundState`.
- `static-server.mjs` — read-only GET server, `127.0.0.1:4191` (non-default), **killed after the run**
  (verified: no listener on 4191).
- 13 screenshots at 1366/390 px in both themes, a 320 px overflow check, the listening states, the wrap
  state and an Arabic RTL render.

| Screenshot | Viewport | State measured in the live DOM |
|---|---|---|
| `practice-runner-answering-1366-light.png` | 1366×900 | 3 tasks, 9 options, 1 "Auswerten" (disabled), 0 actions, material kind `text`, overflow 0 |
| `practice-runner-answering-390-light.png` | 390×844 | same, overflow 0 |
| `practice-runner-answering-1366-dark.png` | 1366×900 | dark theme, overflow 0 |
| `practice-runner-answering-390-dark.png` | 390×844 | dark theme, overflow 0 |
| `practice-runner-review-1366-light.png` | 1366×900 | 3 reviewed tasks, 9 options, 3 key markers, 3 pick markers, 3 explanation blocks, actions `next/mistakes/index`, overflow 0 |
| `practice-runner-review-390-light.png` | 390×844 | same, overflow 0 |
| `practice-runner-review-320-light.png` | **320×720** | same, `scrollWidth − innerWidth = 0`, page 2785 px tall |
| `practice-runner-review-1366-dark.png` | 1366×900 | dark theme, 3 key markers, 3 actions, overflow 0 |
| `practice-runner-review-390-dark.png` | 390×844 | dark theme, overflow 0 |
| `practice-runner-listening-390-dark.png` | 390×844 | audio block, `data-playback-mock="2"`, "Prüfungsregel: 2-mal hören", play **disabled**, **0** replay controls, labels `richtig`/`falsch` from the empty served text, overflow 0 |
| `practice-runner-listening-review-390-light.png` | 390×844 | review, verdicts `correct/wrong/correct`, 1 replay control (after Auswerten), overflow 0 |
| `practice-runner-wrap-390-light.png` | 390×844 | wrap notice + first action = „Alle Sätze dieses Teils geübt — von vorn", overflow 0 |
| `practice-runner-review-390-dark-ar.png` | 390×844 | `dir=rtl` on the runner, the German exam island stays `ltr`, 3 actions, overflow 0 |

**The harness caveat, stated plainly:** every screenshot is **stub-driven**. The two practice routes were not
executed against a database by this lease, so these images prove layout, theme, wrapping, the control set and
the copy — not that a real server serves the payload. §12d is what ties the fixture to the real normaliser.

**Known cosmetic defect (left in, so the evidence matches the committed code):** in the review, a task whose
answer was correct shows the option with two chips ("Ihre Wahl" and "Lösung") on one row; at 320 px the row
wraps below the option text. It is legible at every width (`data-option-state="key-chosen"` is the marked
state) and a 320 px fix would need another screenshot pass.

## 7. What was NOT verified

1. **The routes against a database.** `GET /api/v1/practice/next?family=` and `POST /api/v1/practice/check`
   were never executed by this lease; that is task-15's lease. Every network interaction here is a stub.
2. **The real shell in a browser.** The module was driven through its own harness; no browser ever loaded
   `#/pruefungsteile` from a running server, so the shell's dynamic `import()` + stylesheet-injection path is
   exercised only by the shell's own checks. The runner's own stylesheet injection (§ `ensureStylesheet`) is
   driven in Node and in the harness, not by `app.js`.
3. **PostgreSQL**, `pg`-dependent checks (§5), and any progress/history read.
4. **Real learner evidence.** The review is driven by a stub that derives its verdicts from what the client
   POSTed, so the client's rendering of the server's verdicts is proved; the server's marking is not.
5. **Device behaviour.** No real phone, screen reader or keyboard pass. Audio was never played (the practice
   playback path does not exist).
6. **Native review of the 39 new strings** in uk/ar/tr, owed as for every other slice.

## 8. Residual risk

- **`Fehler üben` needs a second sitting.** "Auswerten" on an already-checked attempt is
  `409 attempt_already_checked`; the runner shows the review it already holds plus a note rather than an
  error. The mistake round therefore opens a **fresh** sitting through the same `?family=` route and narrows
  it to the wrong item ids. When the newly served set is a different set, none of those ids exist and the
  whole new set is shown with an honest note — the mistake round cannot reconstruct another set's items.
- **The bridge can mask a server regression.** If `normalisePracticeSet` regressed to serving the authored
  shape, legs 1-12 would still pass because the bridge renders it. Leg 12d (with `--server`) is the guard
  that fails in that case.
- **`material` paragraphs** are split on blank lines; a passage with a single `\n` renders as one paragraph.
- **The judgement labels** (`richtig`/`falsch`) and the LV3 no-match hint are client-side copy for a server
  that serves empty option text. If the server later carries that text, the client's fill is skipped
  automatically; if the exam's wording differs, the client's labels are wrong for every judgement item.
- **`api.js` was outside the original write scope.** The Lead granted it for exactly these two additive
  methods (task-16, revision 3) and no other lease touches the file; `owned-client-check` has no practice
  leg, so the new methods are pinned by leg 9 of this check instead.
- **Attempt reuse is one-way.** A review is re-readable only from the state the runner holds; a page reload
  loses it (there is no "read my last attempt" route for practice, by design — the sitting is closed).

## 9. Blocked on the server half / next action

1. `practice-server` (task-15) owns the `normalisePracticeSet` rewrite and the PostgreSQL verification of
   both routes. **Nothing on this branch blocks it.** When its branch lands, re-run
   `node tools/practice-runner-check.mjs --server=<that file>` — it must stay green.
2. The **practice playback path** is a separate slice (PRACTICE-MEDIA): a practice-bound media route reusing
   the server's `plays_used`/`max_plays` accounting. The recordings exist; the runner says so and disables
   playback rather than faking it.
3. Independent reviewer (not the author) verifies the diff, the four mutation proofs and the rendered
   evidence; the Lead integrates the seven files and the 39 catalogue keys.
