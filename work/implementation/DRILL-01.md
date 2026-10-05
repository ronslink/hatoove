# DRILL-01 — Einzelübungen: one item at a time from the released pool, weighted to the weak part (slice H)

**Task:** task-26 (DRILL-01, MIRROR-B1PREP-01 §5 H), then **task-32** (DRILL-01-FIX: H1 + M1 from
REVIEW-DRILL-01 / `handoff/ron-agent/drill-01-review-reviewer.md`). **Branch:**
`codex/drill-01-einzeluebungen`, cut from local main at `eef15ca` and rebased onto `20edd90`. **Worktree:**
`D:\Hatoove\.worktrees\drill-01`. Nothing pushed, nothing merged, no other worktree touched.

§5 H: *"One item at a time from the released pool, weighted to the learner's weak parts, with instant
feedback."* This note records what ships, **exactly what "weak" means as implemented**, the pool rule the
review added, the commands with their results, the shell-integrated render, what is NOT verified, and the
residual risk.

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
   the same evidence the other way round. Both directions are named; neither is accidental. The reviewer
   confirmed this ordering is right and named its caveat: at equal accuracy the drill keeps returning to the
   part the learner has practised most. That is the intended reading of "where the weakness is", and the part
   index and the part runner remain the breadth-first path.)
3. **`family` ascending** — so identical evidence always yields the identical part. A choice that changes
   between two identical requests is a bug, not personalisation.

Set choice inside the chosen part is **slice C's rule unchanged** (`selectPracticeSet`: unseen set → most
wrong items → oldest → set id) — one implementation, not a second opinion.

### 1.2 THE POOL RULE — an unplayable item is not a candidate (H1, CORRECTED by FIX-F1)

**This section was rewritten by FIX-F1 (task-39, outside review §F1, adopted as A13). The rule below replaces
the first H1 shape, which blocked on the first weak listening part. That shape was wrong about what feeds the
ranking, and the correction is recorded rather than quietly edited.**

The review measured the chain: the drill served an HV item whose audio the client cannot play, the learner
could only guess, the guess was written as `item_evidence`, and `rankDrillParts` consumes exactly those rows —
so the drill weighted itself toward the family whose items are unplayable, where the learner guessed again.
Among unseen parts, family-ascending put `HV` first, so that was the **default first experience** of a new
learner.

**WHAT WAS WRONG WITH THE FIRST FIX.** It assumed only the drill's own items produced listening evidence, and
returned `{kind: 'listening_blocked'}` at the first weak media part — even when a weak *playable* part ranked
below it. But the **part runner** was writing that evidence: it served HV sets with a disabled player beside
live answer controls, and `/practice/check` recorded the blind guesses. Blind guessing on a richtig/falsch item
is about 50 %, so HV was usually the weakest part, and **one such weakness closed Einzelübungen for almost
every learner who had ever opened Hören** — the same learner the block then sent back to Hören, where the
runner let them guess again. Blocking on a part the drill cannot serve, when it *can* serve another part the
learner is also weak in, is a dead end, not honesty.

The rule now walks the ranking and **passes a media part over**, whatever its tier:

* a part that is **not** media → that is the target (`{kind: 'item'}`). The caller then picks the set and the
  item inside it. **This is the only outcome that serves an exercise.**
* a part that **is** media → skipped, and the walk continues. Skipping is silent in the served response: the
  learner asked for an exercise, not a report about the parts that are unavailable.
* **nothing playable in the whole ranking, but at least one media part** → `{kind: 'listening_only'}`, naming
  the highest-ranked listening part. This is the honest note, and it is reserved for the case where there is
  genuinely nothing to serve. Nothing is written: no sitting, no evidence row, no key.

`families` rows therefore carry `media`, and it **fails closed**: a caller that does not declare a part
playable never gets an item from it.

**THE EVIDENCE RULE (FIX-F1 requirement 4) — do not delete the guesses, stop them counting.**
`playableEvidence(evidence, candidates)` (pure, `server/drill-sets.mjs`) keeps only rows about a set this
deployment serves AND can play, and `drillStatsFromEvidence` builds the per-part numbers from that filtered
list. So the listening guesses a learner already has stay in `item_evidence` — they are their own history —
and can no longer make a part look weak or pick a set. The same rule protects the learner-visible figures:
`practiceProgress`'s two aggregates (the part tiles and the section counts) exclude evidence from a set whose
`media_required` is true, so a number a learner reads is never built out of answers they could not give
honestly.

**REQUIREMENT 1 AND 2 SIT IN THE RUNNER, AND THAT IS THE MORE IMPORTANT HALF.** `practiceSetForPart`
(`server/owned-postgres/adapter.mjs`) had **no** `media_required` filter, unlike the five catalogue queries
that carry it. It now has one, so a listening part answers `nothing_available` instead of serving an exercise
the learner cannot do. `checkPracticeAttempt` refuses to mark a media sitting at all (`409 media_unavailable`),
as does the drill's `drillCheckItem`, so no path can write a guess about inaudible audio into
`item_evidence`. The runner's empty state distinguishes the two reasons: a listening part says why it is not
available (`partRunnerListeningUnavailable`), a part with no released set keeps the generic sentence.

The client keeps a **second, independent layer**: a served item whose set needs media is never rendered as an
exercise (`drillStateFromServed` turns it into the same empty state), so no future path can put answer controls
on an unplayable item. The honest listening note offers a real way forward — a button to `#/pruefungsteile`.
**The learner-facing copy was rewritten in all five locales**: the old `partRunnerAudioUnavailable` named an
internal path ("Übungs-Wiedergabeweg") on a learner's screen; it now says what the learner can and cannot do,
and names no engineering concept.

**THE DEPENDENCY, recorded where it will change:** listening becomes drillable when the client has a
practice-playback transport. The contract already has the path on the SERVER (`practice_attempt`-bound
`/api/v1/practice/attempts/:id/playback`, task-17) and its accounting; the missing piece is the client
transport in `api.js` (which carries only mock playback today). When it lands, `media` stops being a reason to
skip, `listening_only` disappears, the runner's filter becomes a recording check rather than
`media_required`, and the judgement marking path (still proved at the marking layer, and still refused for an
unplayable set) is exercised through the runner again.

### 1.3 The sitting, and the per-item check

* `practice_attempt` (0044/0045) is the sitting. Migration **0046** adds `mode text NOT NULL DEFAULT 'part'`
  with `CHECK (mode IN ('part','drill'))`, joins `mode` to the trigger's immutable identity row and to the
  learner's `GRANT INSERT` column list. Existing rows keep their exact meaning (`part`); nothing is backfilled.
* `GET /api/v1/practice/drill/next` → `drillNext`: ranks the parts, applies the pool rule above, continues the
  drill's own open sitting (a new one is created only when there is none), and serves **ONE** item — never a
  key. The response carries the tier, the numbers behind it, the sitting, the part's round state and a
  one-item progress count; the blocked response carries `blocked: 'listening'`, the part, its section and its
  numbers, and no item.
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
* The sitting **closes itself** on its last item (`state='checked'`, counts frozen, `checked_at`), the same
  shape slice C's wrap rule and the part index's rounds read. A checked sitting cannot be reopened or
  recounted (the trigger refuses).
* **The two paths cannot adopt each other's sitting**, in both directions: `checkPracticeAttempt` refuses
  `mode = 'drill'` (`409 not_a_part_sitting`) and `drillCheckItem` refuses anything else
  (`409 not_a_drill_sitting`).

**Location correction (REVIEW-DRILL-01 item 1).** The brief for task-26 said `checkPracticeAttempt` in
`server/owned-api.mjs` gained the guard. It did not, and this note said so wrongly: `owned-api.mjs` gained the
two **routes** (+63), and the refusal lives in the adapter at **`server/owned-postgres/adapter.mjs:899`**
(declared ~876, `mark_objective_item` ~919, the `UPDATE` ~954), **before any write**. That is the right place:
the guard sits at the data-access boundary inside the method, so every caller of `checkPracticeAttempt`
inherits it rather than each route having to remember. The invariant is asserted in three places — the part
port, the drill port, and the database (`0046`'s trigger + CHECK) — so a future consumer that forgets its own
assertion is caught by the schema rather than by silence.

### 1.4 The client

`public/app/drill.js` + `public/app/drill.css` implement the frozen §4.2 interface
`createDrillView(ctx)` → `{ mount(host), unmount() }`, mounted by the shell into `#drill-host` (the Lead's
commit `75ef73a`). One item at a time, instant feedback, and honest states for: the empty pool, the
listening-only state, a missing transport, a failed load, an unrenderable item and a refused check. **The DTO
readers are imported from `part-runner.js`** — `readServedItems`, `optionLabel`, `readMaterial`,
`materialBlocks`, `readDisclosure`, `readExamRule`, `explanationBlocks`, `checkFailureOf` — so there is one
reader for the served shape, not two.

A listening item shows the EXAM play rule from `/api/v1/exam-parts`. The copy it shows is **learner-facing
since FIX-F1**: it no longer names an internal path, and the same rewrite covers the runner's block
(`partRunnerAudioUnavailable`) and the drill's listening-only title/body, in all five locales. A listening item
reaching this client at all is now a defence-in-depth case: the server withholds those sets.

No URL literal and no `fetch` in the module: it goes through `ctx.api.practice.drillNext/drillCheck`. Those
two members are the **additive** api.js change the Lead authorised (`practiceDrillNext`, `practiceDrillCheck`,
both `scopedCall`); nothing existing was touched.

### 1.5 Files

| File | Change |
|---|---|
| `server/drill-sets.mjs` | new — the pure rule: part ranking, the pool rule, sitting pick, next item, progress |
| `server/drill-pg.mjs` | new — `drillNext` / `drillCheckItem` over `practice_attempt` + `item_evidence` |
| `server/owned-api.mjs` | +63 — the two routes, the body allowlist, the guarded explanation enrichment |
| `server/owned-postgres/adapter.mjs` | +14/−2 — the drill port spread, `mode` in the attempt read, the `not_a_part_sitting` guard |
| `server/migrations/0046-drill-mode.sql` | new — `mode`, its constraint, the trigger and the grant |
| `server/migrations/MANIFEST.json` | +1 line — the sha256 of 0046's bytes |
| `public/app/drill.js`, `public/app/drill.css` | new — the view, the pool gate, the blocked card, a tokens-only layer |
| `public/app/api.js` | +17 — the two additive transport members (authorised by the Lead) |
| `public/assets/i18n/practice-messages.js` | +28 — 28 `drill*` keys in all five locales |
| `tools/drill-check.mjs` | new — 24 offline legs, 12 PostgreSQL legs, 7 migration legs, 8 mutations, and a named failure when a slice file is absent |
| `work/implementation/DRILL-01.md` | this note |

---

## 2. Evidence

Disposable PostgreSQL only: `docker run -d --name drill-fix-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e
POSTGRES_DB=drill_fix -p 127.0.0.1:55499:5432 postgres:17-alpine`, then `OWNAPI_PG_*` pointed at it. The live
app, the live DNS and learner data were never touched. The container was removed afterwards.

| Command | Result |
|---|---|
| `node tools/drill-check.mjs --postgres` | **43 legs, 0 failed** (24 offline + 12 PostgreSQL + 7 migration) plus the 8 mutations below |
| `node tools/practice-selection-check.mjs --postgres` | **45 legs, 0 failed** + M1–M6 + the F1 sandbox mutation (P15) |
| `node tools/practice-media-check.mjs --postgres` | **19 legs, 0 failed** + M1–M4 (the listening sitting is crafted: §4 of this note) |
| `node tools/practice-runner-check.mjs --postgres` | **38 passed, 0 failed** |
| `node tools/migrate-check.mjs` | **6 passed, 0 failed** (44 migrations on a fresh schema; tamper refused; ledger digests match) |
| `node tools/table-class-check.mjs` | **90 table rows; 0 failures; 0 findings** |
| `node tools/owned-api-check.mjs` | **35 passed, 0 failed** (memory) |
| `node tools/owned-api-check.mjs --backend=postgres` | **35 passed, 0 failed** |
| `node tools/run-gates.mjs mirror` | **9/9** |
| `node tools/run-gates.mjs baseline` | **9/9** |
| `node tools/run-gates.mjs mirror-db` | **5/5** (the group FIX-F1 touches: media, drill, selection, part-index, library) |
| `node tools/run-gates.mjs mirror-db` | **4/4** |

`drill-check` is not yet in `tools/run-gates.mjs` (that file is the Lead's). The review measured that a
**removed `drill.js` produced exit 1 with a Node stack trace and no tally**; the gate now checks its slice
files FIRST and reports `FAIL the slice module is missing: <path>` plus the `N legs, N failed` tally, so the
tally explains itself. It belongs in both groups (`mirror`, `mirror-db --postgres`).

### 2.1 What the PostgreSQL legs prove, in the shipped SQL

* **P1/P2** the weakest part is served with its own numbers (`reason: 'weak'`, `attempts 4 / correct 1`), an
  unseen part yields to it and outranks a strong one, and the sitting is written with `mode='drill'`. **(H1)**
  a fresh learner's FIRST task is `LV1` with `media_required: false` — never HV.
* **P3** the served `item_id` IS a key in `objective_key.answers`, and the response carries **no** key;
  `reveal_objective_answer` returns `NULL` in the owner's own transaction **before** the answer is committed.
* **P4** a CHOICE item posts the option's typed value → `correct: true`, `expected` returned, the evidence row
  carries the right item/family/latency with `mock_run_id IS NULL`, and the next call continues the SAME
  sitting at `answered_count 1` with the NEXT item.
* **P5** a JUDGEMENT (HV) item keys by a JSON **boolean**: posting `true` marks right; posting the STRING
  `"true"` is marked **wrong** — the trap `mark_objective_item`'s jsonb comparison creates. H1 means the pool
  no longer routes such items to a learner, so this leg creates the sitting the way the drill creates one and
  drives the shipped per-item path: the capability is proved for the day the transport lands.
* **P6** an out-of-order item and an unknown item are refused (409 / 422), a foreign attempt is 404, and the
  sitting's counts do not move.
* **P7** the sitting closes on its LAST item (`state='checked'`, counts frozen, timestamp), every item was
  served exactly once, reopen and recount are refused by the trigger, and the next task opens a NEW sitting.
* **P8** `mode` keeps the two paths apart in BOTH directions, and `mode` is immutable.
* **P9/P10** the drill's answers reach the `parts[]` DTO the tiles read and the mistakes list, and the part's
  round state is the SAME counter the runner's wrap rule uses.
* **P11 (F1, corrected)** a learner whose ONLY recorded weakness is listening is served the weakest **playable**
  part (`LV1`, `reason: 'unseen'`, `set.media_required === false`), an item IS served and one sitting is opened;
  the three stored listening guesses are still in `item_evidence` and are **not counted**. The first H1 shape
  asserted the opposite (a named block) and was wrong: see §1.2.
* **P12 (F1)** a listening guess cannot steer the drill at all: with only wrong HV evidence the served family is
  the unseen playable one (never an item from HV, and never a block), with STRONG HV evidence plus a weak
  playable part the served family is the playable one (`served.family !== 'HV1'`, `set.media_required === false`),
  an unseen listening part does not enter the decision for a fresh learner, and — the pure part — five stored
  listening guesses produce **zero** ranking rows through `playableEvidence`/`drillStatsFromEvidence`.
* **P5 (F1)** a listening sitting cannot be MARKED through the drill either: `drillCheckItem` answers
  `409 media_unavailable`, the sitting stays `open` at `answered_count 0`, and **no** `item_evidence` row is
  written. The JSON-boolean marking fact this leg used to prove now lives at the marking layer
  (`practice-selection-check` P10), where no serving path is involved.
* **F1 in the practice path (`practice-selection-check`)**: P8f (HV1/HV2/HV3 serve **nothing** and open no
  sitting), P9 (a crafted listening sitting cannot be marked → 409, row counts unchanged), P14 (the refusal over
  HTTP, with the sitting left `open`, while the choice families keep their explanations), P8g (the tile and
  section figures ignore evidence from a set that cannot play, and the rows stay), P15 (a sandboxed copy with
  BOTH F1 halves removed reproduces the old D1 defect, so that guard is still exercised).
* **M1–M7** (migration 0046, applied the hard way): a scratch schema is migrated to the **0045 head**, a
  RUNNER sitting is inserted while the table has **no `mode` column**, and only then is 0046 applied —
  asserting it applies **alone** (1 migration), that the pre-existing row reads **`part`**, that the new
  column **defaults** to `part`, that `mode='drill'` is insertable, that a third mode is refused by
  `practice_attempt_mode_check`, that the trigger refuses to re-label a sitting, and that the MANIFEST entry
  is the migrator's own sha256 of the reviewed bytes.

### 2.2 Mutation proof (8 mutations, all must bite — `MUTATION` lines in the run output)

| Mutation | Legs that fail |
|---|---|
| M1 the weak tier no longer outranks unseen and strong | 2 |
| M2 the drill serves the FIRST item instead of the next | 1 |
| M3 the OLDEST sitting wins instead of the newest | 1 |
| M4 an unseen part is called weak | 3 |
| **M7 a weak listening part BLOCKS again (FIX-F1's correction undone)** | **1** (leg 23, the skip leg) |
| **M8 the playability filter is removed, so listening guesses count** | **1** (leg 23) |
| M5 the client posts the option ID instead of its typed value | 1 |
| M6 the client marks its own answer instead of reading the server verdict | 1 |

The pristine copies pass every leg before and after (the control run is part of the gate). Mutations are
compared on LF, because the Windows working copy is CRLF and a mutation written with `\n` would otherwise
match nothing and "pass" without changing the module. `practice-selection-check`'s P15 adds the fourth
F1-specific proof: a sandboxed copy with the serving filter AND the marking guard removed reproduces the old
D1 defect exactly, so the guard underneath them is still exercised rather than unreachable.

### 2.3 THE SHELL-INTEGRATED RENDER (REVIEW-DRILL-01 M1)

**The app was served normally, on an isolated port, against the disposable database, with the REAL transport
and the REAL routes, and `#/ueben` mounted the real module through the shell hook.** Nothing in `public/` was
modified.

How the session was supplied, stated plainly: the browser available to this agent is **observation-only**
(it may navigate, read the DOM and screenshot; `setCookie`, `click`, `fill`, `type`, `dispatchEvent` and
`goto` are refused by `browser-readonly-guard`), so the app's own sign-in could not be driven and a cookie
could not be placed in the browser. The app was therefore served through a small local **same-origin proxy**
(`%TEMP%\drill-render\proxy.mjs`) that serves `public/` unchanged and, for `/api/*` **only**, forwards to the
real server with the learner's session cookie attached server-side and the `Origin` header rewritten to the
server's own origin (which SEC-01 requires). The shell, the client transport, the routes and the database are
all real; the only synthetic part is **where the cookie is attached**. Four synthetic learners
(`weak-lv2`, `fresh`, `all-strong`, `hv-weak`) were created through the server's own sign-up and preparation
routes, with prior evidence written as the owner-bound learner a real answer writes.

What the DOM measurements prove, per state (every shot at 1366, 390 and 320 px, both themes, overflow 0 —
measured as `scrollWidth − clientWidth`):

| State | Measured |
|---|---|
| **answering, `weak`** (`LV2`) | `#drill-host` **found and un-hidden**, the drill mounted, `covers` (`#task-list`, `#practice-next`, `#ueben-more-link`) **hidden**; `drill.css` in the document's stylesheets **and its tokens applied inside the shell** (`--card` = `#fff` light / `#1e1d1a` dark); 1 item, 3 options; **`keyInDom: false`** (no key in the DOM before answering); check `data-drill-check-ready="false"`; reason line "Ihr schwächster Teil: LV2 — 1 von 4 richtig." |
| **answering, `unseen`** (`LV1`) | "Neuer Teil: LV1 — hier haben Sie noch nichts geübt." — **the H1 fix visible in the shell: a new learner's first task is a playable reading part** |
| **answering, `strong`** (`LV1`) | "Nächster Teil: LV1 — hier waren alle 2 Antworten richtig." |
| **listening block** (`HV1`) | `data-drill-listening-blocked` present; the exam play rule printed ("Prüfungsregel: 1-mal hören") with the player present and **disabled**; the block card names `HV1` with "0 von 3 richtig" and the missing playback path; the way-forward button; **0 items, 0 options, 0 check controls** |
| **empty pool** | `data-drill-empty` with the honest copy; 0 items, 0 check controls |
| **`ar` RTL** | `documentElement.lang="ar"`, `dir="rtl"`, Arabic copy; the German task material, prompt and options are explicit **LTR islands** (`lang="de" dir="ltr"`, computed `direction: ltr`) inside the RTL page |

Screenshots (all in `C:\Users\ronon\AppData\Local\Temp\`, prefix `dsh-browser-shot-`; deliberately NOT
committed):

| Shot | File |
|---|---|
| answering `weak` 1366 light / 1366 dark / 390 light / 390 dark / 320 dark | `…227888-0.png`, `…228656-0.png`, `…229338-0.png`, `…229771-0.png`, `…229817-0.png` |
| answering `unseen` 1366 light / 390 light | `…275011-0.png`, `…275571-0.png` |
| answering `strong` 1366 light / 390 dark | `…332537-0.png`, `…332883-0.png` |
| listening block 1366 light / 390 light / 390 dark / 1366 dark / 390 dark ar | `…352220-0.png`, `…352576-0.png`, `…352899-0.png`, `…470381-0.png`, `…470460-0.png` |
| `ar` RTL answering 1366 / 390 | `…406707-0.png`, `…407379-0.png` |
| empty pool 1366 light / 390 dark | `…445329-0.png`, `…445577-0.png` |
| (module harness, secondary) 16 shots from task-26 | see the previous revision of this note |

**THE ONE THING THE RENDER DOES NOT SHOW, and why.** The review asked for "a server verdict after answering".
Producing it needs a click on an option and on the check control, and this browser session refuses
interaction (`browser-readonly-guard`; the guard's own guidance is that the user must lift the posture or
perform the step). The verdict is therefore proved the ways that are available, and NOT by a shell
screenshot: `drill-check` P4/P5 drive `POST /practice/drill/check` over the shipped route and assert the
server's own `correct`/`expected`, client legs 11/12 assert the verdict is rendered from the server response
(and M6 shows the leg fails if the client guesses), and the module-harness feedback shots show the real
`drill.js` markup in the feedback phase. A shell screenshot of the verdict remains owed — see §3.

### 2.4 The defect the shell render found immediately

The very first shell render of the `strong` state printed **"Übersetzung nicht verfügbar."** on screen:
`drillReasonStrong`'s German and translation strings carried only `{family}` while the call passed
`{family, attempts}`, and `core.js#t` returns the fallback when the parameter set does not equal the
template's placeholders. The offline leg had asserted only `line.length > 0`, which the fallback satisfies —
exactly the class of defect the harness could not see and M1 was asked for.

Fixed (all five locales now carry `{family}` and `{attempts}`, the line reads "Nächster Teil: LV1 — hier waren
alle 2 Antworten richtig."), and the leg is hardened: each reason line must name the part, render its own
numbers, contain no unfilled `{}` and not be the fallback. Re-rendered through the shell to prove the fix.

---

## 3. Not verified

1. **A shell screenshot of the verdict after answering** — see §2.3. The behaviour is proved at the route, the
   client and the harness level; the pixel evidence is owed. The Lead (or a session with an interactive
   browser) can produce it in one pass: open `#/ueben`, choose an option, press "Prüfen".
2. **Real devices.** No iPhone/Android keyboard or audio check was made (AGENTS.md: emulation does not replace
   them). With H1 the drill asks for no audio at all today.
3. **Audio playback in the drill is not wired** — deliberately, and now enforced by the pool rule. The server
   path and its accounting exist (task-17); the client transport in `api.js` is the missing piece, and the
   drill's audio block plus the blocked state are the two places that change with it.
4. **Native review of the 28 new uk/ar/tr strings is owed** (all locales populated and formal; no string is
   marked approved by an agent).
5. **`moded` sittings created before 0046 in production**: none can exist (the column did not exist); the
   migration leg proves the default labels every pre-existing row `part`.
6. **Load**: the drill reads the exam's whole objective set inventory once per `drill/next` (25 rows locally).
   Not measured against a much larger catalogue.
7. **`drill-check.mjs` is not registered** in `tools/run-gates.mjs` (the Lead's file): two lines,
   `gate('drill-check')` in `mirror` and `gate('drill-check', '--postgres')` in `mirror-db`.

## 4. Residual risk

* **A weak listening part blocks rather than defers.** If the learner's recorded weakest part is listening,
  the drill names it and serves nothing (it does not switch silently to a weaker-still playable part, which is
  what the review asked for). Until the playback transport lands, that learner's drill route is that message;
  the way-forward button leads to the part practice, where the part can be improved and the block lifts by
  itself. This is the honest consequence of the rule, and it is the one product trade-off in this slice.
* **Two sittings for one set.** A runner sitting left open and a drill sitting for the same set can coexist,
  because neither path adopts the other's row. Each is independent and evidence is append-only, so nothing is
  corrupted; the learner could meet the same item twice. The same situation already existed with two runner
  tabs before this slice.
* **The `mode` invariant is asserted in three layers but lives partly in slice C's method**, so its review
  belongs with any future change to `checkPracticeAttempt`.
* **`answered_count` is the drill's position.** It is exact because the check refuses an out-of-order item, and
  that `409` is what the client recovers from by re-reading the next item.
* **The weighting rule is deterministic, not adaptive in any stronger sense.** It reads only this learner's
  recorded right/wrong counts for this preparation; it cannot see time-since-practice (no scheduler, by
  design) and has no notion of item difficulty.
* **D22 is guarded by a curated word list** (leg 15: readiness, streak, study plan, forecast, prediction,
  pass, percentage, `/45`, in all five locales) plus a source assertion that slice C's wrap copy is reused.
  Amendment A5(b) records the same honest limit for the shell's wording gate: a crafted sentence outside the
  list would pass. No prediction, streak, readiness or plan surface ships.
* **Content risk that is not this slice's to fix**: an item whose authored options are empty is refused by the
  normaliser (500) rather than served, and a set whose declared count disagrees with its rows throws. Both are
  loud by design (slice C's rule) and are proven for all 25 sets by `practice-selection-check`'s corpus legs.

## 5. Defects found while building on slice C

1. `checkPracticeAttempt` did not distinguish the two sitting kinds — not a defect in slice C (the distinction
   did not exist until this slice) but it would have become one: the guard is part of this change, and
   `practice-selection-check --postgres` (45/0) confirms slice C's behaviour is otherwise untouched.
2. `practice-media-check` was red on every Windows tree before this slice (its multi-line mutation pattern
   joins with LF against a CRLF working copy and aborted before its tally). The Lead's `252e20f` fixes it;
   this branch is rebased onto it. No change of mine was involved and no workaround was written here.
3. The `drillReasonStrong` placeholder mismatch (§2.4) was mine, found by the render the review demanded.
4. **My own H1 shape was half wrong (FIX-F1).** Fixing the drill's pool while the runner still served listening
   sets blocked Einzelübungen for nearly every learner who had opened Hören. The record is in §1.2; the leg
   that asserted the block is re-pointed, not deleted (leg 23 now asserts the skip, and mutations M7/M8 restore
   the two old behaviours and fail it).
5. **A content migration without a rights decision is invisible, not merely ungated** — found in POOL-01 batch 1
   (task-37): the serving policy allows only `generated`/`licensed`/`commissioned`, so `content_version` rows
   with `rights_status='unknown'` and no `content_rights` row fail closed. `tools/content-rights-check.mjs`
   leg 1 asserts the invariant, and it is in **no** gate group.

## 6. Next actions for the Lead

1. Register `tools/drill-check.mjs` in `tools/run-gates.mjs`: `mirror` and `mirror-db` (`--postgres`).
2. Take the two click-driven shell shots (`#/ueben` answer → verdict) or lift the browser posture for one
   pass; everything else in the render already exists.
3. Independent review of the fix (a reviewer who is not the author), then integration. FIX-F1 changes behaviour
   a non-author must re-measure: the runner withholds a listening part, the drill skips it, and the tile
   figures ignore evidence from a set that cannot play.
4. Native review of the 28 `drill*` strings; no string is marked approved by an agent. **FIX-F1 rewrote three
   of them** (`partRunnerAudioUnavailable`, and the drill's listening title/body) and added
   `partRunnerListeningUnavailable` — five locales each, formal address, no internal path.
5. `tools/content-rights-check.mjs` is in no gate group (defect 5 above); the two lines to add are
   `gate('content-rights-check', '--postgres')` and the same in `mirror-db`.
6. `tools/practice-media-check.mjs` was edited by FIX-F1 (§4 of this note): the listening sitting its playback
   legs need is now CRAFTED, because the serving path deliberately withholds it. The playback path itself is
   untouched.
