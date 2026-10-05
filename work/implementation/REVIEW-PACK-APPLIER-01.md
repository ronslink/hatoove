# REVIEW-PACK-APPLIER-01 (task-49, extended by task-53) — attacking the applier, and closing four open gaps

**Status: delivered, not independently reviewed, not merged.** Author: teammate `practice-client`.
Worktree `D:\Hatoove\.worktrees\review-pack-applier`, branch **`codex/review-pack-applier`**, cut from
`codex/review-pack-01` @ **`a9051e1`**. Nothing pushed, nothing merged; no other worktree written to.

**task-53 follow-up (N2 of Claude's second pass): the guard on the OTHER axis.** The task-49 guard compared
`current` (the translation) and not the German, so a translation approval survived a correction to its German
source. That is fixed on branch `codex/fix-n2-n5` (cut from main `d5bee34`), mutation-proved, and recorded in
§10 below. Everything above §10 is the task-49 revision.

Files: `tools/apply-review-decisions.mjs`, `tools/review-pack-check.mjs`, `tools/build-review-pack.mjs`
(the applier's requirement had to reach the generated README and the JSON template), and this note.

## 1. THE CLAIM, AND THE VERDICT

> "No script can mark anything approved" — the applier refuses to record an approval no human made.

**VERDICT: TRUE across every attempt I could construct, with ONE real hole found and fixed (a stale-text
approval), and one honest limit recorded (the ledger is a file, not a signature).**

Before this lease the claim was unverified in both reviews and the cross-check said so. It is now tested by
twelve attempts (A1–A12 below), each asserting three things: the exit status, the message, and that the
applier wrote **nothing** (no ledger, no corrections file). Two of the twelve are **mutations of the guard
itself**: remove the guard and the refusal disappears — which is what makes the guard load-bearing rather
than decorative.

### 1.1 The hole: a decision was recorded against text the human never read

The applier read the reviewer's decision and then took `text_at_review` from the **freshly enumerated**
source. So this sequence silently forged an approval:

```text
1. the pack is generated; row ui/shell.conflict carries text A
2. the reviewer reads A and writes `ok`
3. the source changes to text B (any later content fix)
4. the reviewer sends the CSV back
   BEFORE: the ledger recorded `text_at_review: B` and the human's `approved` — an approval of B that no
           human ever made, and the pack then showed B as approved
   NOW:    refused — "the text changed since this pack was generated (the reviewer judged a different
           sentence); re-generate the pack with `node tools/build-review-pack.mjs` and re-review"
```

This is exactly the failure mode the pack exists to prevent, and the reviewer's own M6 only covered the
other direction (a ledger entry whose text no longer matches the pack). Fixed by comparing the text the
reviewer judged — the CSV's `current` column, or `text_at_review` in a decision file — against the freshly
enumerated text, for **every** decision kind, before anything is written. A decision file entry with no
quoted text is refused too, so an approval must say what it approved. The generated README, the JSON
template and the tool header were updated in the same commit: a template that the applier rejects would
have been a trap.

## 2. THE TWELVE ATTEMPTS (all in `tools/review-pack-check.mjs`, offline)

| # | attempt | result |
|---|---|---|
| A1 | named reviewer + a real, current decision (**positive control**) | **accepted**: exit 0, ledger `decided_by="A Named Human"` and `text_at_review` equal to the row's current text, corrections CSV written |
| A2 | `fix` with no replacement text | refused: `"fix" needs the replacement text in the correction column` |
| A3 | `reject` with no reason / `na` with no reason | refused, each with its own message |
| A4 | an unknown id; and a real id that is in **another language's** pack (`lib/noun/…/german-headword`, German-only) | refused: `no such string in the uk pack` |
| A5 | ragged CSV: too many cells, too few cells | refused: `do not match the 17-column header` — and a **quoted comma is NOT** treated as corruption (it survives to the corrections file) |
| A6 | truncated file: mid-row; at a row boundary; JSON cut in half | mid-row and truncated-JSON refused with nothing written; **row-boundary truncation applies exactly the rows present and invents no partial entry** |
| A7 | a decision whose text no longer matches the source (CSV **and** JSON) | refused: the message above — the hole of §1.1 |
| A8 | a decision-file entry with no quoted text | refused: `carries no text_at_review, so there is no way to tell which text was judged` |
| A9 | does it edit a catalogue or the bundle? | **no**: 6 catalogue/bundle files fingerprinted before and after both an accepted and a refused run — byte-identical |
| A10 | a hand-written ledger entry (the limit) | **accepted by the next build**: the pack shows `approved` with the fabricated name, and `inspectPackDir` cannot tell it from a real one — recorded, not hidden |
| A11 | **mutation**: remove the reviewer guard | the shipped applier refuses (exit 1); the mutated copy exits **0 and writes an approval with no reviewer** — the guard is what refuses |
| A12 | **mutation**: remove the text guard | the shipped applier refuses; the mutated copy exits **0 and records the decision against the NEW text** — the guard is load-bearing |

Exact refusals, quoted:

```text
$ node tools/apply-review-decisions.mjs --csv uk-rows.csv                       # no --reviewer
apply-review-decisions: 1 problem(s), nothing written
  no reviewer: pass --reviewer "<the human who made these decisions>" (a script may not approve anything)

$ node tools/apply-review-decisions.mjs --csv uk-rows.csv --reviewer "A Named Human"   # stale text
apply-review-decisions: 1 problem(s), nothing written
  ui/shell.conflict: the text changed since this pack was generated (the reviewer judged a different
  sentence); re-generate the pack with `node tools/build-review-pack.mjs` and re-review — nothing written
ledger written? false   corrections written? false
```

### 2.1 The limit, stated plainly

- The ledger **is the trust anchor**. A10 shows that a hand-written `<language>-ledger.json` produces
  `approved` rows with whatever reviewer name it carries, and the whole check (including the pack
  inspection) passes. The toolchain proves **an evidence chain**, not a signature: it can prove that no
  *shipped script* writes an approval without a named human and a matching text, and it can drop a stale
  approval, but anyone with write access to a ledger and the repository can fabricate one. That is why the
  ledger lives in a handoff directory, is derived output, and is named in the record as such.
- A bad actor with **both** the CSV and the ledger can do anything those files permit: approve text they
  never read (the ledger is unchecked by construction beyond `text_at_review`), name a reviewer who never
  existed, or delete a decision. What the *scripts* cannot do is approve without a name, approve a number
  the text never had, apply a stale decision, or half-apply a malformed file.
- `--ledger-dir` is unvalidated, so the operator can direct the two output files anywhere (including into
  `public/assets/i18n/`). The applier cannot write a catalogue or the bundle itself — it only ever writes
  `<language>-ledger.json` and `<language>-corrections.csv` — and A9 pins that.

## 3. GAP 2 — the check's own mutations, reproduced independently

The check claimed M1–M8 and a 17/17 headline; nobody had reproduced them. I corrupted a fresh pack with
**my own code** and used the shipped check only as the **detector**, reading the pack-inspection leg's
failure block specifically (a loose grep would have proved nothing: the check's own M-legs print the same
code names).

```text
PASS  R1 a deleted row (the check calls it M1)  -> exit 1; pack-inspection leg named: missing_from_pack, …
PASS  R2 an approval with no reviewer (M3)      -> exit 1; pack-inspection leg named: approval_without_reviewer, …
PASS  R3 an invented row (M5)                   -> exit 1; pack-inspection leg named: no_source_accounts_for_row, …
PASS  R4 a stale approval (M6)                  -> exit 1; pack-inspection leg named: stale_approval, …
4/4 independent corruptions detected by the shipped check
```

**Does 17/17 (now 28/28) reflect real coverage?** Partly, and the headline must not be read as more than it
is:

- Each M-leg asserts a **specific failure code by name** (`assertFailure(...)`), and the corrupted pack is
  built through the same reader/writer the applier uses — so the LF-vs-CRLF class that silently killed
  `practice-media-check`'s M3 **does not apply** to M1–M6: there is no multi-line search string anywhere in
  them. (The working tree here is CRLF; `mutate()` rewrites through `packCsvRows`/`packCsv`, which normalise
  line endings, and my independent corruptions are the proof that the path bites.)
- **But the headline is a statement about what the legs inspect, not total coverage.** An undetected
  corruption proves it: I changed a row's **`where`** column ("where this string appears") to a place the
  key does not appear → the check reports **29/29 passed, exit 0**. The check validates
  `source_file`/`source_locator`/`source_de`/`status`; it does not validate the `where` claim.
- That is also why the twelve A-legs assert **exit status AND that nothing was written**, rather than only
  that "a leg failed".

**Two defects fixed in the check while doing this:**

1. `--pack-dir <dir>` on another drive (a `%TEMP%` pack) always failed the "derived output and kept out of
   git" leg: `path.relative(ROOT, 'C:\…')` returns an absolute path, which does not start with `..`, so the
   "outside the repository" guard missed it and `git check-ignore` failed. Now `path.isAbsolute(relative)` is
   treated as outside. Its own usage line advertises `--pack-dir <dir>`, so this was reachable.
2. The A-legs had to be made independent of the input directory's history (a pack dir that already contains
   a ledger looked like the applier had written one); `applierCase` now starts each case clean.

## 4. GAP 3 — the three figures, reconciled and labelled

| figure | label (exactly what it is) | arithmetic, recomputed here |
|---|---|---|
| **11,531** | **POPULATION** — every learner-facing string the pack pipeline counts, across all locales: the denominator if the question is "how much copy is there" | catalogues 1,101 keys × 5 = 5,505; guides 704 × (en,uk,ar,tr) = 2,816; nouns 240 × 13 = 3,120; instructions 14 × 5 = 70; fallbacks 3 × 5 = 15; `<noscript>` 1 × 5 = 5 |
| **432** | **DELTA** — the program's NEWLY ADDED, machine-translated interface subset only: 144 keys × 3 non-German locales (uk/ar/tr) | 144 × 3 = 432; inside the population, not a rival to it |
| **127** | **BATCH** — one recorded native-review batch: 33 SP1 paths × 3 locales = 99, plus 28 elsewhere | 99 + 28 = 127; a unit of work already recorded, never a population |

**The record's figure is wrong, and I can now say why.** `work/implementation/REVIEW-PACK-01.md:50` prints
"Total learner-facing strings found: **11,563**". Recomputed from the same sources, the consistent sum is
**11,531** — a 32-string difference that no component I can reconstruct explains (adding the 15 removed or
18 rendered guide paths overshoots; counting German a second time overshoots by hundreds). Until someone
reconciles those 32 strings, the board should quote **11,531 as the population** (or "≈11.5k"), **432 as the
new subset** and **127 as one batch** — and should not quote 11,563, which does not reproduce. This is the
same figure-drift class the cross-check recorded as its finding 5; it is its third appearance.

## 5. GAP 4 — the 15 duplicated German strings, by path (and the OTHER 15)

15 German strings sit on more than one catalogue key: 4 in `shell`, 11 in `practice`. Full list, key by key:

```text
shell.m008 = shell.m062                        "Üben"
shell.m080 = shell.topic = shell.theme         "Thema"
shell.m230 = shell.m317                        "Wird geladen …"
shell.m338 = shell.m395                        "Wortschatz"
practice.text = practice.partRunnerMaterial    "Text"
practice.listening = practice.partRunnerListening   "Hören"
practice.taskNumber = practice.partRunnerItem  "Aufgabe {id}"
practice.correct = practice.partRunnerCorrect  "Richtig"
practice.mockScope = practice.mockIntroTitle   "Schriftliche Probeprüfung"
practice.audioPlay = practice.partRunnerPlay   "Abspielen"
practice.ui01 = practice.mockIntroBlockWriting "Schreiben"
practice.mockIntroColPoints = practice.partIndexPoints      "Punkte"
practice.mockIntroBlockListening = practice.partIndexListeningTitle  "Hörverstehen"
practice.libraryAllGenders = practice.vocabAll "Alle"
practice.partRunnerRetry = practice.drillRetry "Erneut laden"
```

Verdict: **not a defect**. Each pair is shared copy that two surfaces legitimately show (the shell's
"Wortschatz" appears in a menu and a heading; the practice pairs are two features that chose the same
German word). It matters for review in exactly one way: a native reviewer fixing the wording of one key
does not fix the other, and nothing in the pack tells them the twins exist. That is a note for the
reviewer's instructions, not a code change.

**The collision the cross-check warned about is now impossible to make.** The other "15" is
`pendingRecord.removed` — **15 guide paths deleted from the German source by migration `0043`**, which must
NOT be approved by translation:

```text
pendingRecord: rendered = 18, removed = 15   (both in one SP1 entry)
rendered (18): title, summary, payload.approach[0..2].step, payload.approach[0..2].detail,
               payload.phrases[0..2].group, payload.phrases[0..2].hint, payload.examples[0].topic,
               payload.watchOut[0..2]
removed  (15): payload.approach[3..5].step, payload.approach[3..5].detail,
               payload.phrases[3..5].group, payload.phrases[3..5].hint,
               payload.examples[1].topic, payload.watchOut[3..4]
```

Same number, different universe: the duplicates are **strings that exist twice**; the removed are **paths
that no longer exist**. The pack carries the removed paths as their own rows (status `not-applicable`,
`needs_translation=no`) precisely so a reviewer does not translate them.

## 6. GAP 5 — five of the 35 "unlocated" keys, spot-checked

Method: search the whole shipped client for the key, for the bare suffix, and for a construction that could
build the key at runtime (`+ index`, template literals, `data-i18n` built by concatenation, catalogue
iteration). **Verdicts:**

| key(s) | verdict | evidence |
|---|---|---|
| `public.reading0Explanation`, `reading0Tip`, `reading1Explanation`, `reading1Tip`, `grammar0Explanation`, `grammar0Tip`, `grammar1Explanation`, `grammar1Tip` (8 keys) | **REACHABLE — live learner-facing copy** | `public/site.js:149-152`: `const itemKey = state.skill + state.indices[state.skill]` then `label(itemKey + 'Explanation')` and `label(itemKey + 'Tip','p')`, and `label()` (line 94) emits `data-i18n="public.' + key`. `bank.reading` and `bank.grammar` each hold **2** items, so the reachable keys are exactly `reading0/1`, `grammar0/1` — the 8 in the catalogue. The static scan cannot follow `skill + index` |
| `public.checklist0` … `checklist4` (5 keys) | **DEAD in the shipped client** | nothing in `public/**` builds or mentions them, and **no `'checklist' + index` construction exists anywhere** (the only repo hits are `hatoove-site/dist/site.js:59`, a different `checklist` data field in the marketing site, and `public/app/library.js:124`'s `checklist: 'm089'`, a guide-content label map). The implementation note's claim that this family is built that way is **wrong** — it describes the reading/grammar family above |
| `shell.m001`, `m008`, `m012`, `m100`, `m113`, `m193`, `m194`, `m234`, `m297`, `m303`, `m304`, `m305`, `m307`, `m383`, `m386` (15 keys) | **dead by scan, no dynamic path found** | m-numbered keys are addressed as literals (`uiText("m079")`, `uiText("m266")`); a search for `'m' +`, `` `m${…}` `` and `messageMarkup('m' + …)` finds none. Sampled keys have no call site at all |
| `shell.correctCount`, `shell.failedRequest`, `shell.since` (3 keys) | **dead by scan** | only the catalogue definitions exist; the only `since` hits in `public/app` are the English word in comments |
| `practice.scopeComplete`, `practice.finishScope` (2 keys) | **dead by scan** | only the catalogue definitions; `public/app/drill.js` (slice H, present on this branch) does not use them |
| `common.originalInstruction`, `common.translatedInstruction` (2 keys) | **dead by scan** | the namespace is registered (`public/auth/entry.js` imports `assets/i18n/common.js`) and its CSS is linked, but no file reads `common.<key>` — the bilingual-instruction chrome that would use them lives in the `instructions` namespace |

**Conclusion for gap 5:** at least **8 of the 35 are live** and must be reviewed; **24 are dead-by-scan with
no mechanism found** (the remaining 3 are `shell.failedRequest`/`correctCount`/`since` counted above). The
note's single caveat — "the `public.checklistN` family is built as `'checklist' + index`" — names the one
family that is *not* built dynamically and misses the family that is. This is worth correcting in
`work/implementation/REVIEW-PACK-01.md` before the list is used to skip copy.

## 7. Gates and registration

```text
node tools/run-gates.mjs mirror      ---- mirror: 10/10 passed ----   (review-pack-check is NOT in it)
node tools/run-gates.mjs baseline    ---- baseline: 9/9 passed ----
node tools/review-pack-check.mjs     28/28 checks passed  (12.2 s, offline, no database)
node tools/review-pack-check.mjs --pack-dir handoff/ron-agent/review-packs   29/29 checks passed
```

**Recommendation: register `review-pack-check` in the `mirror` group.** It is offline, needs no database,
no Docker and no browser, its inputs are the shipped catalogues and the bundle (which the mirror gates
already police), and it is the only gate that would fail if an approval appeared with no reviewer, no ledger
entry or a stale text. It is the slowest leg in the group at 12.2 s (two full pack builds plus four
sub-process applier probes), against `repository-check`'s 37 s in `baseline` — so the cost is in line. It
belongs to `mirror`, not `baseline`: it is MIRROR-program copy review, not the AGENTS.md baseline set that CI
currently runs.

## 8. What was NOT verified, and residual risk

1. **No human reviewer has ever run this applier.** Every decision file here is synthetic; the flows are
   proved, the ergonomics are not (a real reviewer's spreadsheet may re-export the CSV with reformatted
   columns, which the header check catches, or reorder columns, which it does **not** catch — see below).
2. **Column ORDER is not validated**, only the count. A CSV whose columns were reordered but kept 17 wide
   would be parsed with the wrong values (e.g. `correction` in the `note` position). The `current` column
   would then wrongly mismatch and most files would be refused loudly, but a reorder that happens to leave
   `current` correct could mis-file a correction. Cheap fix if wanted: assert the header equals
   `CSV_COLUMNS` exactly.
3. **`--ledger-dir` is unvalidated** (see §2.1), and the ledger is trusted by construction.
4. **The 32-string discrepancy in the population figure** (§4) is unresolved.
5. **`where` is not validated** by the pack check (§3) — the pack can claim a wrong location for a string
   and still be 29/29.
6. **The 24 dead-by-scan keys** are dead *by scan*: a future module could start rendering them, and the
   `en` locale is deliberately not part of the packs.
7. **The three figures and the duplicate list are reported here, not in the artefacts the board reads**
   (`CENSUS.md`/`census.json` still carry the old numbers where they carry any). Correcting the record is the
   Lead's call; this note is the measured source.

## 9. Next action

1. Independent review of this revision (the applier guard, the twelve legs, the two guard mutations).
2. Lead: register `review-pack-check` in `run-gates.mjs`'s `mirror` group, and decide whether to correct
   `REVIEW-PACK-01.md`'s 11,563 and its `checklistN` caveat (this note has the measurements).
3. Before native review is commissioned: the 8 live reading/grammar keys are part of the job, and the
   reviewer's instructions should say that a duplicated German string has twins (the 15 pairs in §5) and that
   the 15 `removed` paths are deliberately `not-applicable`.
4. Optional follow-ups, both cheap and both named above: exact CSV header validation, and validating the
   `where` column against the scan.

## 10. N2 (task-53) — the German-source half of the guard

**The hole, confirmed.** The applier compared `current`, the TRANSLATED text, against the freshly enumerated
row, and `applyLedger` did the same; the CSV carried `source_de` and the ledger did not store it at all. So:
German is corrected IN PLACE — migration `0043` did exactly that, under an unchanged `content_version` — the
uk string is untouched, and the row stays `approved` as a translation **of German that no longer exists**. A
reviewer reading the pack would have no way to see it. Same failure as task-49, on the axis that was not
covered.

**The fix (four files).**

- `tools/build-review-pack.mjs`: `CSV_COLUMNS` gains **`source_de_at_review`** beside `source_de`;
  `applyLedger` requires it and compares it with the fresh `row.source_de`, reporting
  **`stale_approval_source`** when the German moved and **`ledger_entry_without_source_text`** when an entry
  (any ledger written before this change) records none — such an entry no longer approves anything. The
  generated README, the help table and the JSON template now say both texts are required.
- `tools/apply-review-decisions.mjs`: the CSV carries `source_de` as `sourceQuoted`; a decision file carries
  `source_de_at_review`; **both** must be present and match the fresh row or the whole file is refused, in the
  same all-or-nothing way as before. The ledger entry gains `source_de_at_review`, taken from the fresh source
  the guard has just proved equal.
- `tools/review-pack-check.mjs`: the approved-row inspection checks the German as well
  (`stale_approval_source`, `approval_without_source_text`), and the ledger scan reports
  `ledger_entry_without_source_text`.

**The mutations (the deliverable).** `node tools/review-pack-check.mjs` is one command; the relevant output:

```text
PASS M6 a stale TRANSLATION approval fails as stale_approval
     uk: [stale_approval] ui/shell.conflict was approved against a translation the pack no longer carries
PASS M9 a stale GERMAN approval fails as stale_approval_source (the axis N2 found open)
     uk: [stale_approval_source] ui/shell.conflict was approved against German the pack no longer carries
PASS M10 a ledger entry that records no German fails as approval_without_source_text
     uk: [ledger_entry_without_source_text] ledger entry ui/shell.conflict records no source_de_at_review
PASS A7 a decision whose text no longer matches the source is REFUSED (both axes)
PASS A7d a spreadsheet that re-saves multi-line cells as CRLF is ACCEPTED (line endings are not text)
     row #9 re-saved with CRLF inside a multi-line cell: accepted, ledger records the canonical text
PASS A12 removing the translation guard makes the stale-text refusal disappear
     guard removed -> the stale decision is accepted and recorded against the NEW text: the guard is load-bearing
PASS A13 removing the GERMAN guard makes the stale-source refusal disappear (N2)
     guard removed -> a translation approval survives a change to its German source: that is exactly N2, and the guard is what closes it
32/32 checks passed
```

A13 is the proof N2 needed: **remove the new guard and the German-stale approval is written** (exit 0, and the
ledger records the new German the human never read); the shipped applier refuses the same input with
`the German source changed since this pack was generated (the reviewer judged this translation against
different German); re-generate the pack … — nothing written`.

**The all-or-nothing question, answered.** One mismatched row still refuses the whole file — that is the
integrity rule and it stays. Two things are true about the ergonomics:

1. **The refusal names every offending row**, not just the first: the applier prints
   `N problem(s), nothing written` followed by one `id: reason` line per row (no truncation), so a reviewer
   can fix the file rather than guess. That is the part worth having, and it is already there.
2. **Line endings are not text, so they no longer reject the file.** A spreadsheet that re-saves a multi-line
   cell as CRLF used to make the whole pack unreviewable through the easiest return path. Both sides are now
   compared with CRLF normalised to LF (`sameText`), which preserves the rule — any real character change
   still fails, as A7e asserts — while an encoding artefact no longer does. The ledger records the CANONICAL
   text, not the spreadsheet's line-ending form (asserted in A7d).
   Recommendation: keep it that way, and do **not** weaken the all-or-nothing rule further. If a reviewer ever
   needs a partial apply, that is a different, explicitly-named tool — not a relaxation of this one.

**Evidence for this section** (worktree `D:\Hatoove\.worktrees\fix-n2-n5`, branch `codex/fix-n2-n5`):

```text
node tools/review-pack-check.mjs                                        32/32 checks passed
node tools/review-pack-check.mjs --pack-dir handoff/ron-agent/review-packs-fresh     33/33 checks passed
node tools/review-pack-check.mjs --pack-dir handoff/ron-agent/review-packs-delivered 32/33 — ONE expected
    failure: ui/practice.partRunnerListeningUnavailable is missing from those packs. They are DERIVED output
    generated at a9051e1, when `practice` had 447 keys; main now has 448, so the delivered packs are stale by
    exactly that one key. Regenerating them is owed (they are gitignored, and I did not touch the shared copy).
node tools/run-gates.mjs mirror        all gates passed (13, review-pack-check included)
node tools/run-gates.mjs baseline      all gates passed (9)
node tools/run-gates.mjs mirror-db     all gates passed (7, pool-01-check --postgres included)
```

The cross-check's own reading of the older delivered packs is unaffected: those packs carry **0 approved
rows**, so the new German checks cannot fire on them.
