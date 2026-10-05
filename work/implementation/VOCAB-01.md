# VOCAB-01 — Wortschatz: the Prüfungskern and the word deck (MIRROR-B1PREP-01 slice G)

Owner: teammate `library-ui`. Worktree `D:\Hatoove\.worktrees\vocab-01`, branch
`codex/vocab-01-wortschatz`, cut from local `main` at `ddc25d8` (`88f18e1` + the POOL-01 proposal).
Nothing pushed, nothing merged, no other worktree touched. Contract: `docs/contracts/MIRROR-B1PREP-01.md`
§4.2, §5 E/F (the line that moves these corpora here) and the lease's slice-G brief.

> One documentation note first: the lease quotes contract §5 G as *"Prüfungskern first, then the general
> 300-word deck. Ship browse-by-block first. Spaced-repetition drill comes later"*. The frozen contract's
> §5 G is a one-line stub (`G · VOCAB-01 and H · DRILL-01 follow C.`); that sentence is not in it. The
> slice was built to the lease and to §5 E/F line "Kerngrammatik and core phrases leave this hub for
> Wortschatz (slice G)". Recorded for the board/contract, not treated as a blocker.

## Scope delivered

1. **Prüfungskern first.** `core-grammar` (4 blocks, 125 items) and `core-phrases` (3 blocks, 130 items)
   are fetched through `GET /api/v1/guides/:id?locale=` and rendered as reference blocks: a chip per
   block with **its own item count**, one card per block with the tier title, the tier's `why`, and every
   item (German headword, part-of-speech tag, the authored English gloss on the English page, the German
   example with the existing read-aloud control, the translated example when the bundle carries one, and
   the German note). Choosing a block shows exactly that block; "Alle" restores the corpus.
2. **The word deck second**: the 300-entry list from `GET /api/v1/vocab`, browsable by part of speech and
   searchable, German first, the authored English gloss on the English page only, plural and example per
   word, read-aloud on the German example.
3. **No spaced repetition, no streak, no readiness, no study plan, no per-item state** — the lease puts
   spaced repetition out of scope, D22 forbids the rest, and the server serves no per-item state to
   invent from. The check enforces it and `tools/readiness-check.mjs` passes (8/8).

## Files

| File | Change |
|---|---|
| `public/app/vocab.js` | new — `createVocabView(ctx)` → `{ mount(host), unmount() }`; exports `CORE_CORPORA`, `POS_FILTERS` |
| `public/app/vocab.css` | new — the module's own layer, design tokens only, no dependency on `library.css` |
| `public/app/library.js` | the two corpora leave the library: `WORTSCHATZ_GUIDE_IDS` exported, a deep link to them now renders a hand-over card linking to `#/wortschatz` instead of the document |
| `public/assets/i18n/practice-messages.js` | **shared catalogue — announced.** 14 new `vocab*` keys + 1 `libraryMovedToVocab`, all five locales, formal address |
| `tools/vocab-check.mjs` | new — the focused check, root-parameterised, with three mutation legs and a harness/`--serve` |
| `tools/library-render-check.mjs` | updated for the ownership move (5 library guides + 2 hand-overs instead of 7 documents) |
| `work/implementation/VOCAB-01.md` | this note |

### The shared catalogue file

`public/assets/i18n/practice-messages.js` gained 15 keys, each in all five locales: `vocabIntro`,
`vocabCore`, `vocabCoreDesc`, `vocabDeck`, `vocabDeckDesc`, `vocabBlocks`, `vocabPos`, `vocabAll`,
`vocabPartial`, `vocabPosNoun`, `vocabPosVerb`, `vocabPosAdj`, `vocabPosAdv`, `vocabPosPhrase`, and
`libraryMovedToVocab`. Everything else is reused: `shell.m395` (Wortschatz), `m337` (Suche), `m385`
(placeholder), `m068` (two-character minimum), `m057`, `m070`, `m071`, `m087`, `m091`, `m278`, `m283`,
`m339`, and this catalogue's `libraryCountEntries` / `libraryShown` / `libraryMachineTranslated` /
`libraryPill`. `i18n-register-check` R1–R10 pass (0 findings).

## The two measurements the lease asked for (measured, not assumed)

Reproduction: disposable `postgres:17-alpine` (`hatoove-vocab-pg`, `127.0.0.1:55481`, database
`vocab_measure`), the real migrator (`node server/migrate.mjs` → `applied=41`, head
`0043-content-corrections`), then the real adapter called with **the route's own arguments** read from
`server/owned-api.mjs` (`/api/v1/vocab` passes `examId, pos, q, serveReview` and **no `limit`**;
`/api/v1/guides` passes `examId, serveReview`). `B1PREP_CONTENT_MODE=internal-preview` is required or the
pilot content is filtered out (0 rows) — that is the same mode the PostgreSQL checks set.

**1. `/api/v1/vocab` truncates exactly like the noun route did.**

| call | rows |
|---|---|
| route arguments (no limit) | **50 of 300** |
| same call with `limit: 1000` | 300 (the corpus is 300) |
| `pos=noun` via the route | **50 of 233** (truncated) |
| `pos=verb` | 41 of 41 |
| `pos=adj` | 19 of 19 |
| `pos=adv` | 7 of 7 |
| `pos=phrase` | 0 of 0 (the route accepts the value; the corpus has no phrases) |
| `q=Arbeit` | 4 (below the cap, exact) |

`adapter.listVocab` defaults to `limit = 50` and the route passes none, so the deck can never show more
than 50 entries in one response. **`GET /api/v1/guides` is NOT capped**: it returns 7 rows
(`cases-guide:20 core-grammar:4 core-phrases:3 gender-rules:60 grammar-guide:14 speaking-guide:3
writing-guide:19`), so the Prüfungskern needs no server change. The deck's fix is one route line (pass a
bounded limit and/or accept a bounded `limit` override, exactly as the noun route was fixed in
`3be374a`); that file is outside this lease, so the page states the truth instead: with 50 rows it shows
"50 angezeigt" plus *"Nicht alle Einträge passen in eine Liste. Grenzen Sie mit Wortart und Suche ein."*,
and `tools/vocab-check.mjs` proves the same page renders "300 Einträge" with no note when the server can
serve the whole corpus.

**2. The core payloads carry what a browse-by-block view needs — with two gaps.**

`readGuide('core-grammar')` → 4 sections (`kind: tier`), 125 items; `readGuide('core-phrases')` → 3
sections, 130 items. Item fields: `id, de, en, pos, note, example, exampleEn`, and each section carries
`title` + `summary` (the tier's `why`) — so block title, block explanation, headword, part of speech,
German example and note all come from the payload. What the payload does **not** answer:

* **no uk/ar/tr translation for the headwords, the notes or the tier titles.** The F2 bundle covers only
  `payload.items[i].example` for these two corpora (125 + 130 paths, verified). The module therefore
  renders the German headword/note always, the authored English gloss only on the English page, and the
  real bundle's translated example sentence beneath the German one with its machine marker. Nothing is
  invented to fill the gap.
* **no per-item state at all** (no "known", no progress, no schedule). The view is browse-only by design;
  a drill would need server-side evidence, which is slice H's problem, not this slice's.

## Commands and results

Run from `D:\Hatoove\.worktrees\vocab-01`.

```
node tools/vocab-check.mjs
     page scan excludes 1 term(s) the corpus itself quotes: Wiederholung
     mutation M1 the deck before the Prüfungskern: failed as required
     mutation M2 a block chip that ignores the chosen block: failed as required
     mutation M3 a streak surface in the header: failed as required
PASS vocab render: Prüfungskern before the deck, block browsing and deck browse/search exact against the payload,
     counts from the payload on both halves, the real bundle's example translations with their marker, and no
     spaced-repetition, streak, readiness or study-plan surface. root=.

node tools/library-render-check.mjs   → PASS (6 hub areas, 5 library guides + the 2 hand-overs, 8 case tables, 240 nouns)
node tools/guide-render-check.mjs     → PASS (303 examples, 15 wrong-example labels)
node tools/i18n-register-check.mjs    → 0 findings (R1–R10, 11 shipped files)
node tools/design-check.mjs           → 14 passed, 0 failed, 2 warnings (D2b/D2c, pre-existing in app.css)
node tools/repository-check.mjs       → 724 tracked files, 641 text blobs screened
node tools/retired-surface-check.mjs  → 10 passed, 0 failed
node tools/seo-check.mjs              → 11/11 passed
node tools/server-origin-check.mjs    → 8 checks passed
node tools/keymask-check.mjs          → 14 checks passed
node tools/owned-api-check.mjs        → 34 passed, 0 failed (backend: memory)
node tools/owned-client-check.mjs     → 32 passed, 0 failed
node tools/readiness-check.mjs        → 8 passed, 0 failed            (D22: no readiness surface)
node tools/practice-locale-check.mjs  → 18 checks passed
node tools/shell-locale-check.mjs     → 25 checks passed
```

### What `tools/vocab-check.mjs` asserts

Fixtures come from the payload the server serves: the two corpora are mapped tier→section the way
`tools/build-guide-migration.mjs` maps them (stored section ids included, which is what the translation
keys are built from), the deck rows are mapped the way `tools/build-vocab-migration.mjs` maps them
(`telc-deutsch-b1.vocab.<slug>`), and the `translations` member is built from the **real** bundle in the
shape `readGuideTranslations` produces — with its own rule that `de`/`en` answer `null`.

1. **Order and counts**: `#vocab-core` before `#vocab-deck`, the corpora in order, every block chip
   carrying its own payload count, every corpus chip its payload total, every payload item rendered in
   payload order; the deck's count and truncation note come from the served rows (and the page must not
   claim the full 300 while the route caps at 50); the part-of-speech chips are the values the payload
   carries.
2. **Block browsing exact**: choosing a block renders exactly that tier's items in order, hides the other
   tiers, leaves the other corpus untouched, and "Alle" restores everything.
3. **Deck browse/search exact**: the part-of-speech filter renders exactly the rows the route returns
   (capped at 50 for nouns, complete for the 41 verbs with no truncation note); search composes with the
   active filter, keeps the term when the filter is cleared, renders exactly the matches, and a
   one-character search queries nothing and explains the minimum.
4. **Complete deck**: with a server that can serve all 300 rows the page counts 300 and drops the
   truncation note.
5. **Translations and language purity**: the real bundle's example translation for a named stored path
   renders with the marker, an `approved` member renders without one, a Ukrainian page shows exactly one
   "not yet available" note (in the deck) and **no** `lang="en"` line at all, the English page shows the
   authored gloss and no marker, and the German page shows no note.
6. **No drill surface**: the module source (comments stripped) and all five rendered pages carry none of
   the banned terms, there is no checkbox/drill/review control, and the corpus-quoted terms that cannot
   discriminate (today: `Wiederholung`, an exam word) are excluded **and printed**, so a shrinking scan
   is visible.

**Mutation proof** — the whole check is parameterised by `--root=<dir>`, so each mutation is a real run
against a copied tree in `%TEMP%`, and each must fail on its own leg: M1 moves the deck before the
Prüfungskern (order leg), M2 makes a block chip ignore the chosen block (block leg), M3 puts "Streak: 3"
in the header (D22 leg). All three failed as required on this run.

## Rendered evidence

`D:\Hatoove\handoff\ron-agent\vocab-01\` (gitignored shared handoff):

```
vocab-de-1366-light-kern-and-deck.png        Prüfungskern (125/130 counts, 4+3 blocks) then the deck
vocab-uk-1366-dark-deck-translated.png       dark theme, 255 real example translations with the marker
vocab-en-1366-light-deck-gloss.png           the authored English gloss on the English page
vocab-de-390-light-kern.png                  390 px, single column, Kern first
vocab-ar-390-dark-deck-rtl.png               390 px dark RTL: 925 explicit LTR German islands, no wrong-direction node
vocab-de-320-light.png                       320 px: no page overflow, no overflowing element, long words break
```

Measured in the browser: 1366 de → 0 page overflow, 9 block chips, 4 payload-derived pos chips, deck
"50 angezeigt" with the truncation note, no drill term; uk dark → 255 translated blocks with 255 markers,
exactly 1 note, 0 authored English lines; ar dark RTL → 925 LTR German islands, 0 mis-flagged; 320 px →
`document.scrollWidth === clientWidth` on de and ar, and no element wider than its box.

**Standalone harness** (no server, no database): `node tools/vocab-check.mjs --harness
handoff/ron-agent/vocab-01/vocab-harness.html --serve 4324`, then
`http://127.0.0.1:4324/handoff/ron-agent/vocab-01/vocab-harness.html?locale=uk&limit=50&theme=dark`. The
harness inlines the real corpora, the 300 deck rows and the served uk/ar/tr members, so it renders real
translations and markers; `?limit=1000` shows the complete-deck state.

## What was NOT verified

* **No HTTP request was made.** The truncation measurement calls the real datastore with the route's own
  arguments (the route is a thin wrapper over it), but the session/route layer was not exercised; the
  route could change its argument list without this measurement noticing.
* **No live app, no `index.html` run.** The module was mounted into my own harness host, not into the
  shell's `#vocab-host`. The shell hook (`MODULE_VIEWS.wortschatz`) was read, not run.
* **No real device, no screen reader, no keyboard pass.** Touch targets and RTL reading order come from
  rendered screenshots at three widths.
* **Native review of the translations is still owed** (unchanged from F2): every translated line carries
  the machine marker until a person approves it.

## Residual risk and integration notes

1. **The deck is capped at 50 by the route** (measured above). The page states it and the check proves the
   uncapped path; the one-line fix belongs to whoever owns `server/owned-api.mjs`.
2. **The shell's `covers` list is incomplete for this view.** `MODULE_VIEWS.wortschatz` covers
   `['dict-results']`, but the interim dictionary also puts an unlabelled `.page-head` and a search
   `.card` in `#view-wortschatz`. My module hides those two superseded siblings on mount and restores
   them on unmount (so a failed import still shows the interim view), and this is reported rather than
   left: at integration the shell should give them ids and extend `covers`, or delete the legacy
   dictionary block outright. `public/app/app.js` / `index.html` are not mine to edit.
3. **Ownership moved for the two corpora.** `library.js` no longer renders `core-grammar`/`core-phrases`:
   a deep link hands over to `#/wortschatz`, and `tools/library-render-check.mjs` now asserts the
   hand-over and that the library does not even fetch them. `library-render-check`'s summary therefore
   reads "5 library guide pages" + "the 2 Wortschatz corpora hand over" where it used to read "7 guide
   pages" — a reviewer should read that as the contract's §5 E/F line being enforced, not as a lost leg.
4. **The deck has no uk/ar/tr translation at all** and the core corpora only translate their item
   examples (measured). A learner in uk/ar/tr sees German plus one note in the deck; a future slice that
   wants translated headwords needs new bundle coverage, not a client change.
5. **`pos=phrase` is accepted by the route and empty in the corpus.** The chips are built from the served
   payload, so no dead chip appears today and a corpus with phrases would grow one automatically.
6. **The module hides two shell nodes at runtime.** That is the one place it reaches outside its own host,
   and it is reversible and documented above; if the shell would rather own it, removing the three lines
   in `mount`/`unmount` is enough.

## Review response — REVIEW-VOCAB-01 (`reviewer`), 5 October 2026, applied at integration

Verdict CLEAR WITH NOTES, no blocking defect. The reviewer reproduced every browser number in its own
harness, re-derived the two route measurements on a disposable PostgreSQL, verified the A7 ownership move
with its own recording fake (a deep link fetches nothing but `guides.list` and hands over to
`#/wortschatz`), proved the fixture is the served shape by resolving **125/125** and **130/130** client
paths against a real `readGuideTranslations` member, and confirmed the 15 catalogue keys as additive in
all five locales. What the Lead did with each finding at integration:

| Finding | Disposition |
|---|---|
| **G2** `main:756e27a` already gave the interim dictionary nodes ids and put them in the shell's `covers`, so this module duplicated the shell's ownership and its `unmount` un-hid every `.page-head`/`.card` sibling, including ones the shell still owned. | **Fixed**: the module no longer hides or restores anything; the shell's `covers` owns it. Item 6 above is superseded. |
| **G1** the "Alle" chip carried a **block** count (4 / 3) beside chips carrying **item** counts (45/17/37/26), and it was the one chip count the check never asserted. | **Fixed**: "Alle" is a selector and carries no number. |
| **G5** this note quoted `repository-check` 724/641, the **base** commit's figures. | Corrected: at `945f0e0` the artefact reports **728/645**, and on the integrated tree the number grows again with the merge — treat every figure here as of-its-head, as the reviewer asked. |
| **G4** this note annotated `readiness-check` as a D22 gate. | Corrected: `readiness-check` is the HTTP `/api/ready` probe and contains no D22 term. **D22 is enforced by `vocab-check`'s banned-term legs**; `readiness-check` is run for what it actually proves. |
| **G6/G7** `vocab-uk-1366-dark-deck-translated.png` shows the **deck**, the half that by design carries no translation and no marker, so it cannot evidence "255 translated lines with markers"; and the `-1366-` PNG widths show two device pixel ratios. | Corrected: the 255-line/255-marker figure is evidenced by the **Kern** render the reviewer independently reproduced (255 lines, 255 markers, 1 note, 0 authored-English lines), not by that filename. The screenshots are emulated-harness captures; their pixel widths are not a viewport claim. The measured viewport facts (no overflow at 320/390/1366, correct LTR islands) stand as measurements, not as screenshot evidence. |
| **G3 omission** the F2 import currently fails at this head (`bundle_source_mismatch`, 33 speaking-guide bindings; the core corpora are clean at 255/255), so the Kern's translations cannot be served from a real database until F2's bundle is re-pinned. | Recorded. It is the tracked consequence of migration `0043` (`CONTENT-CORRECTIONS.md` §5.1), not a slice-G defect; the re-pin belongs to the translation review pass. |

The reviewer's honest limits are accepted unchanged: no live app server was started, so the HTTP body for
`/api/v1/vocab` was narrowed rather than closed (the Lead's route fix is measured at the datastore
boundary); no `/index.html` run; no real device, screen reader or native translation review. The Lead
adds one: the reviewer's `owned-api-check --backend=postgres` 34/34 is the strongest HTTP-layer evidence
this slice has.

