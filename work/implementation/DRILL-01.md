# DRILL-01 — Einzelübungen: one item at a time from the released pool, weighted to the weak part (slice H)

**Task:** task-26 (DRILL-01, MIRROR-B1PREP-01 §5 H). **Branch:** `codex/drill-01-einzeluebungen`, cut from
local main at `eef15ca` and rebased onto `03d6cc2`; the branch carries the slice as one code commit plus this
note. **Worktree:** `D:\Hatoove\.worktrees\drill-01`. Nothing pushed, nothing merged, no other worktree
touched.

§5 H: *"One item at a time from the released pool, weighted to the learner's weak parts, with instant
feedback."* This note records what ships, **exactly what "weak" means as implemented**, the commands with
their results, what is NOT verified, and the residual risk.

---

## 1. What ships

### 1.1 The weighting rule, as implemented (`server/drill-sets.mjs`, pure)

A part is measured by the learner's OWN recorded answers for THIS preparation: `item_evidence` grouped by
`family` — the same rows the `parts[]` member of `GET /api/v1/practice/progress` already aggregates.

```
attempts = count of that learner's evidence rows in the part
correct  = count of those rows whose correct is true
accuracy = correct / attempts, and NULL when attempts is 0
```

`null` is not zero: a part the learner has never answered has no accuracy, and calling it 0 % would invent
evidence. The three tiers, in the order the rule prefers them (`DRILL_TIERS`):

| Tier | Definition | Why |
|---|---|---|
| **`weak`** | `attempts > 0` **and** `accuracy < 1` | there is recorded evidence of a weakness. A part with ANY wrong answer outranks every unseen and every strong part. |
| **`unseen`** | `attempts === 0` | no evidence either way: it outranks a strong part (nothing proven) and yields to a weak one (something proven wrong). |
| **`strong`** | `attempts > 0` **and** `accuracy === 1` | nothing recorded wrong yet. Last. |

Tie-breaks inside a tier, in this order — the full comparator, and a **total** order:

1. **accuracy ascending** — the weakest part wins. `null` sorts as `1`, which only ever compares two unseen
   parts (all equal), so it can never decide a cross-tier choice.
2. **`attempts` DESCENDING** — the same accuracy from MORE recorded answers is the stronger evidence of the
   same weakness. (Slice C's `nextPractice` breaks its *section* ties the other way, with attempts
   ascending, because it chooses breadth of coverage; the drill chooses where the weakness is, so it reads
   the same evidence the other way round. Both directions are named; neither is accidental.)
3. **`family` ascending** — so identical evidence always yields the identical part. A choice that changes
   between two identical requests is a bug, not personalisation.

**Consequence, stated honestly:** a learner who keeps one part weak keeps drilling it, and the drill rotates
only when that part's recorded accuracy stops being the lowest (or a part becomes weaker still). That is what
"weighted to the weak parts" means here; the part index and the part runner remain the breadth-first path.
Slice C puts *unseen sections first*; the drill deliberately does not, because the whole point of slice H is
the part the learner is getting wrong.

Set choice inside the chosen part is **slice C's rule unchanged** (`selectPracticeSet`: unseen set → most
wrong items → oldest → set id) — one implementation, not a second opinion.

### 1.2 The sitting, and the per-item check

* `practice_attempt` (0044/0045) is the sitting. Migration **0046** adds `mode text NOT NULL DEFAULT 'part'`
  with `CHECK (mode IN ('part','drill'))`, joins `mode` to the trigger's immutable identity row and to the
  learner's `GRANT INSERT` column list. Existing rows keep their exact meaning (`part`); nothing is backfilled
  and nothing is rewritten.
* `GET /api/v1/practice/drill/next` → `drillNext`: ranks the parts, continues the drill's own open sitting for
  the chosen part (another open sitting is created only when there is none), and serves **ONE** item — never a
  key. The response carries the tier, the numbers behind it, the sitting, the part's round state and a
  one-item progress count.
* `POST /api/v1/practice/drill/check` → `drillCheckItem`: marks that ONE item with the existing
  `mark_objective_item` (0015), writes the `item_evidence` row, **then** reads the key with
  `reveal_objective_answer` (0041) — which returns a key only because the learner's own evidence now exists.
  The route enriches the review with the explanation through the SAME context-authorized reader the whole-set
  review uses, behind the same two guards (`media_required` set or `judgement` item → asked for nothing; ANY
  reader failure → `explanation: null`, never a lost verdict).
* **Order is what makes the counters exact.** The drill answers a sitting strictly in the served order and
  `drillCheckItem` refuses anything that is not the next item (`409 item_out_of_order`); so
  `practice_attempt.answered_count` IS "items answered in this sitting" — no position column, no second table,
  and an interrupted drill resumes where it stopped instead of starting the set again.
* The sitting **closes itself** on its last item (`state='checked'`, counts frozen, `checked_at`), which is the
  same shape slice C's wrap rule and the part index's rounds read. A checked sitting cannot be reopened or
  recounted (the trigger refuses).
* **The two paths cannot adopt each other's sitting**, in both directions: `checkPracticeAttempt` now refuses
  `mode = 'drill'` (`409 not_a_part_sitting`) and `drillCheckItem` refuses anything else
  (`409 not_a_drill_sitting`). That is the one change to slice C's method, and it is 8 lines including the
  comment: without it a runner check could mark a whole set into a partly-answered drill row and double the
  evidence and the counts.

### 1.3 The client

`public/app/drill.js` + `public/app/drill.css` implement the frozen §4.2 interface
`createDrillView(ctx)` → `{ mount(host), unmount() }`, mounted by the shell into `#drill-host` (the Lead's
commit `75ef73a`). One item at a time, instant feedback, honest states for the empty pool, a missing
transport, a failed load, an unrenderable item and a refused check. **The DTO readers are imported from
`part-runner.js`** — `readServedItems`, `optionLabel`, `readMaterial`, `materialBlocks`, `readDisclosure`,
`readExamRule`, `explanationBlocks`, `checkFailureOf` — so there is one reader for the served shape, not two.

A **listening** item shows the EXAM play rule from `/api/v1/exam-parts` and names the missing practice
playback path, in slice C's own words (`partRunnerAudioRule` / `partRunnerAudioUnavailable`): the recordings
exist, the client has no transport for practice playback (the runner disables it too), and the drill must not
serve an unplayable item silently. No second claim about the same missing piece.

No URL literal and no `fetch` in the module: it goes through `ctx.api.practice.drillNext/drillCheck`. Those
two members are the **additive** api.js change the Lead authorised (`practiceDrillNext`, `practiceDrillCheck`,
both `scopedCall`); nothing existing was touched.

### 1.4 Files

| File | Change |
|---|---|
| `server/drill-sets.mjs` | new — the pure rule: part ranking, sitting pick, next item, progress |
| `server/drill-pg.mjs` | new — `drillNext` / `drillCheckItem` over `practice_attempt` + `item_evidence` |
| `server/owned-api.mjs` | +63 — the two routes, the body allowlist, the guarded explanation enrichment |
| `server/owned-postgres/adapter.mjs` | +14/−2 — the drill port spread, `mode` in the attempt read, the `not_a_part_sitting` guard |
| `server/migrations/0046-drill-mode.sql` | new — `mode`, its constraint, the trigger and the grant |
| `server/migrations/MANIFEST.json` | +1 line — the sha256 of 0046's bytes |
| `public/app/drill.js`, `public/app/drill.css` | new — the view and its tokens-only layer |
| `public/app/api.js` | +17 — the two additive transport members (authorised by the Lead) |
| `public/assets/i18n/practice-messages.js` | +27 — 25 `drill*` keys in all five locales |
| `tools/drill-check.mjs` | new — 22 offline legs, 10 PostgreSQL legs, 7 migration legs, 6 mutations |
| `work/implementation/DRILL-01.md` | this note |

---

## 2. Evidence

Disposable PostgreSQL only: `docker run -d --name drill-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e
POSTGRES_DB=drill_pg -p 127.0.0.1:55497:5432 postgres:17-alpine`, then `OWNAPI_PG_*` pointed at it. The live
app and learner data were never touched.

| Command | Result |
|---|---|
| `node tools/drill-check.mjs --postgres` | **39 legs, 0 failed** (22 offline + 10 PostgreSQL + 7 migration) plus the 6 mutations below |
| `node tools/run-gates.mjs mirror` | **9/9 passed** (`practice-runner-check` and `practice-selection-check` included) |
| `node tools/run-gates.mjs baseline` | **9/9 passed** (`repository-check` 744 tracked files; `i18n-register-check` 0 findings; `design-check` 0) |
| `node tools/owned-api-check.mjs` | **35 passed, 0 failed** (memory) |
| `node tools/owned-api-check.mjs --backend=postgres` | **35 passed, 0 failed** |
| `node tools/migrate-check.mjs` | **6 passed, 0 failed** (applies all 44 migrations to a fresh schema; tamper refused; ledger digests match) |
| `node tools/table-class-check.mjs` | **90 table rows; 0 failures; 0 findings** |
| `node tools/practice-selection-check.mjs --postgres` | **44 legs, 0 failed** + 6 mutations (slice C's own gate, after the `mode` guard) |
| `node tools/practice-media-check.mjs --postgres` | **19 legs, 0 failed** + 4 mutations |
| `node tools/design-check.mjs`, `retired-surface-check.mjs`, `seo-check.mjs`, `server-origin-check.mjs`, `keymask-check.mjs`, `owned-client-check.mjs` | exit 0 each |

### 2.1 What the PostgreSQL legs prove, in the shipped SQL

* **P1/P2** the weakest part is served with its own numbers (`reason: 'weak'`, `attempts 4 / correct 1`), an
  unseen part yields to it and outranks a strong one, and the sitting is written with `mode='drill'`.
* **P3** the served `item_id` IS a key in `objective_key.answers`, and the response carries **no** key;
  `reveal_objective_answer` returns `NULL` in the owner's own transaction **before** the answer is committed.
* **P4** a CHOICE item posts the option's typed value → `correct: true`, `expected` returned, the evidence row
  carries the right item/family/latency with `mock_run_id IS NULL`, and the next call continues the SAME
  sitting at `answered_count 1` with the NEXT item.
* **P5** a JUDGEMENT (HV) item keys by a JSON **boolean**: posting `true` marks right; posting the STRING
  `"true"` is marked **wrong** — the trap `mark_objective_item`'s jsonb comparison creates.
* **P6** an out-of-order item and an unknown item are refused (409 / 422), a foreign attempt is 404, and the
  sitting's counts do not move.
* **P7** the sitting closes on its LAST item (`state='checked'`, counts frozen, timestamp), every item was
  served exactly once, reopen and recount are refused by the trigger, and the next task opens a NEW sitting.
* **P8** `mode` keeps the two paths apart in BOTH directions (drill never adopts a `part` row and refuses to
  check it; the runner refuses a `drill` row; the runner's own path opens its own sitting), and `mode` is
  immutable.
* **P9/P10** the drill's answers reach the `parts[]` DTO the tiles read and the mistakes list, and the part's
  round state is the SAME counter the runner's wrap rule uses.
* **M1–M7** (migration 0046, applied the hard way): a scratch schema is migrated to the **0045 head**, a
  RUNNER sitting is inserted while the table has **no `mode` column**, and only then is 0046 applied —
  asserting it applies **alone** (1 migration), that the pre-existing row reads **`part`**, that the new
  column **defaults** to `part`, that `mode='drill'` is insertable, that a third mode is refused by
  `practice_attempt_mode_check`, that the trigger refuses to re-label a sitting, and that the MANIFEST entry
  is the migrator's own sha256 of the reviewed bytes.

### 2.2 Mutation proof (6 mutations, all must bite — `MUTATION` lines in the run output)

| Mutation | Legs that fail |
|---|---|
| M1 the weak tier no longer outranks unseen and strong | 2 |
| M2 the drill serves the FIRST item instead of the next | 1 |
| M3 the OLDEST sitting wins instead of the newest | 1 |
| M4 an unseen part is called weak | 3 |
| M5 the client posts the option ID instead of its typed value | 1 |
| M6 the client marks its own answer instead of reading the server verdict | 1 |

The pristine copies pass every leg before and after (the control run is part of the gate). Mutations are
compared on LF, because the Windows working copy is CRLF and a mutation written with `\n` would otherwise
match nothing and "pass" without changing the module.

### 2.3 Rendered evidence

**Scope, stated plainly:** this is MODULE-level evidence. A harness page in `%TEMP%\drill-render\` loads the
**real** `public/app/drill.js`, the **real** `drill.css` and the shell's own stylesheets
(`hatoove.css`, `fonts-coverage.css`, `common.css`, `app.css`) with a **stubbed** transport, served over an
isolated local port. It proves layout, overflow, theme, RTL and every state; it does NOT prove the
shell-integrated `#/ueben` route with a signed-in learner and a real preparation — that render is the
integration step the Lead owns (the hook is in `75ef73a`, the transport is in this commit).

16 screenshots, all with **horizontal overflow 0** (measured as `scrollWidth − clientWidth`):

| Shot | File |
|---|---|
| answering 1366 light / dark | `dsh-browser-shot-1791217698407-0.png`, `…698808-0.png` |
| feedback correct 1366 light / feedback wrong 1366 dark | `…699209-0.png`, `…699611-0.png` |
| answering 390 light, feedback correct 390 light / dark, feedback wrong 390 dark | `…699995-0.png`, `…700409-0.png`, `…700794-0.png`, `…701176-0.png` |
| answering 320 dark, feedback correct 320 light | `…701557-0.png`, `…701939-0.png` |
| feedback 390 Arabic RTL, feedback 390 Ukrainian | `…702325-0.png`, `…702711-0.png` |
| empty pool 390, failed load 390 | `…703091-0.png`, `…703474-0.png` |
| listening item: play rule + honest missing path, 390 light and 1366 dark feedback | `…892101-0.png`, `…892602-0.png` |

All are under `C:\Users\ronon\AppData\Local\Temp\` (prefix `dsh-browser-shot-`). They are deliberately NOT
committed (AGENTS.md keeps render evidence out of commits; slice evidence lives in the handoff).

Observed in the measurements, not only in the pictures: one task per screen, its exact option count, **no key
while answering** (`data-drill-key-line` absent), the server verdict rendered after the commit
(`data-verdict="correct"`/`"wrong"`), the key and the learner's own pick both printed, the explanation block
rendered, the disabled check control until an option is chosen, the mobile breakpoint making the check button
full width, and the Arabic interface RTL with the German task/options still LTR.

---

## 3. Not verified

1. **The shell-integrated render** (real `#/ueben`, signed-in learner, real preparation, real server) — see
   §2.3. Module-level evidence only.
2. **Real devices.** No iPhone/Android keyboard or audio check was made (AGENTS.md: emulation does not replace
   them). This slice has no keyboard-only or audio interaction of its own.
3. **Audio playback in the drill is not wired** — deliberately: the client has no transport for the practice
   playback path (`api.js` carries only mock playback, and `part-runner.js` disables audio for the same
   reason). A listening item therefore shows the exam play rule and the honest missing-path sentence. If the
   practice playback transport is added to `api.js`, the drill's audio block is the one place to change.
4. **Native review of the 25 new uk/ar/tr strings is owed**, like every other new interface string in this
   program (§4.6, amendment "Native review … is owed").
5. **`moded` sittings created before 0046 in production**: none can exist (the column did not exist), and the
   migration leg proves the default labels every pre-existing row `part`.
6. **Load**: the drill reads the exam's whole objective set inventory once per `drill/next` (25 rows locally).
   Not measured against a much larger catalogue.
7. `drill-check.mjs` is **not yet registered** in `tools/run-gates.mjs` (that file is the Lead's): the two
   lines owed are `gate('drill-check')` in `mirror` and `gate('drill-check', '--postgres')` in `mirror-db`.

## 4. Residual risk

* **Two sittings for one set.** A runner sitting left open and a drill sitting for the same set can coexist,
  because neither path adopts the other's row. Each is independent and evidence is append-only, so nothing is
  corrupted; the learner could meet the same item twice. The same situation already existed with two runner
  tabs before this slice. Closing it properly means one-sitting-per-(learner, set, mode) in the schema, which
  is not this slice.
* **The `mode` column is a new invariant slice C does not assert itself.** If a future change makes the runner
  save progress per item into an open attempt, `not_a_part_sitting` still protects the drill row, and
  `tools/drill-check.mjs` P8 pins both directions — but the guard now lives in the adapter's whole-set method,
  so its review belongs with any future change to that method.
* **`answered_count` is the drill's position.** It is exact because the check refuses an out-of-order item, and
  that refusal is a `409` the client recovers from by re-reading the next item. A client that ignores the
  refusal cannot corrupt the sitting (nothing is written), but it will loop; the shipped client does not.
* **The weighting rule is deterministic, not adaptive in any stronger sense.** It reads only this
  learner's recorded right/wrong counts for this preparation. It cannot see time-since-practice (the drill
  deliberately does not add a scheduler) and it has no notion of item difficulty.
* **D22 is guarded by a curated word list** in `tools/drill-check.mjs` leg 15 (readiness, streak, study plan,
  forecast, prediction, pass, percentage, `/45`), in all five locales, plus a source assertion that slice C's
  wrap copy is reused. Amendment A5(b) records the same honest limit for the shell's wording gate: a crafted
  sentence outside the list would pass. No prediction, streak, readiness or plan surface ships.
* **Content risk that is not this slice's to fix**: an item whose authored options are empty is refused by the
  normaliser (500) rather than served, and a set whose declared count disagrees with its rows throws. Both are
  loud by design (slice C's rule) and are proven for all 25 sets by `practice-selection-check`'s corpus legs.

## 5. Defects in slice C found while building on it

**None blocking.** Two observations, recorded rather than changed:

1. `checkPracticeAttempt` did not distinguish the two sitting kinds, which is not a defect in slice C (the
   distinction did not exist until this slice) but WOULD have become one: the 8-line guard is part of this
   change, and `practice-selection-check --postgres` (44/0) confirms slice C's behaviour is otherwise
   untouched.
2. `practice-media-check` was red on every Windows tree before this slice — its multi-line mutation pattern
   joins with LF against a CRLF working copy and aborted before its tally. The Lead's `252e20f` fixes it; this
   branch is rebased onto that commit (and onto `5c352c6`), and the gate now reads 19 legs, 0 failed with
   M1–M4 firing. No change of mine was involved, and no workaround was written here.

## 6. Next actions for the Lead

1. Register `tools/drill-check.mjs` in `tools/run-gates.mjs`: `mirror` (offline) and `mirror-db`
   (`--postgres`).
2. Independent review (a reviewer who is not the author), then integration.
3. The shell-integrated render of `#/ueben` with the real transport, as the integration evidence.
4. Native review of the 25 `drill*` strings (de authored, en/uk/ar/tr translated) — no string is marked
   approved by an agent.
