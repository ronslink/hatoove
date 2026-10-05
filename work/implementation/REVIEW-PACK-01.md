# REVIEW-PACK-01 — the wholesale native-review format

**Task:** task-38. **Branch:** `codex/review-pack-01` (cut from local `main` at `1f82edf`).
**Deliverables:** `tools/build-review-pack.mjs`, `tools/review-pack-check.mjs`,
`tools/apply-review-decisions.mjs`, and the derived packs in `handoff/ron-agent/review-packs/`
(gitignored).

## Why this exists

Ron asked for "an easy format to review it wholesale" before handing copy to named native speakers
(uk, ar, tr) plus a German reviewer for the interface copy. Before this slice the learner-facing
copy lived in five interface catalogues, one instructions catalogue, three unexported fallback maps,
four `<noscript>` blocks and a 531 KB translation bundle. A reviewer working that way hunts keys
instead of reading sentences, and a review done that way cannot be shown to be complete, because
nobody can say what "all of it" was.

This slice makes the whole set reviewable in one pass per language, and makes "is this string
reviewed?" a question with an answer that only a human can change.

## What was built

| file | what it does |
|---|---|
| `tools/build-review-pack.mjs` (new) | Enumerates every learner-facing string from its real source, prints the census, writes one review document + one machine-readable companion per language, and applies any existing human decision ledger so the pack reports the live review status. |
| `tools/review-pack-check.mjs` (new) | Checks completeness in both directions, that every row has a real source, that nothing is approved without a recorded reviewer, that no source byte moved during the build, that two builds are byte-identical, and six named mutations. 17 legs. |
| `tools/apply-review-decisions.mjs` (new) | Reads a reviewer's filled-in CSV or decision JSON, validates every decision against a freshly enumerated pack, and writes `<lang>-ledger.json` (who decided what, against which text) and `<lang>-corrections.csv` (the exact edit owed, with file and address). It never edits a catalogue or the bundle, and refuses to run without a named reviewer. |
| `handoff/ron-agent/review-packs/` (derived, gitignored) | `README.md`, `CENSUS.md`, `census.json`, `FINDINGS.md`, and per language `de|uk|ar|tr-review.md`, `-rows.csv`, `-decisions.template.json`. |

Nothing in this slice modifies a catalogue, the bundle, a migration or a database row. The check
proves that: it fingerprints every source file before and after a build and fails if a byte moves.

## The census, per source, read from the source

Printed by the build before anything is written, and written to `CENSUS.md` / `census.json`.

| source | what it is | strings |
|---|---|---|
| `public/assets/i18n/shell-messages.js` (`shell`) | app shell, menus, account, history, vocabulary search | 447 keys × 5 locales |
| `public/assets/i18n/practice-messages.js` (`practice`) | practice runner, drill, listening, writing feedback, explanations | 447 keys × 5 locales |
| `public/assets/i18n/public-messages.js` (`public`) | public front door `/`, pre-auth pages | 119 keys × 5 locales |
| `public/assets/i18n/auth-messages.js` (`auth`) | sign in, registration, password, email verification | 78 keys × 5 locales |
| `public/assets/i18n/common.js` (`common`) | shared bilingual-instruction chrome | 10 keys × 5 locales |
| `public/assets/i18n/instructions.js` (`INSTRUCTIONS`) | curated exam directions, German original + 4 translations | 14 ids |
| fallback maps: `core.unavailable`, `instructions.unavailable`, `instructions.originalUnavailable` | shown when a key or a translation does not resolve; not reachable through a catalogue export | 3 × 5 locales |
| `<noscript>` blocks in `public/index.html`, `signin.html`, `reset-password.html`, `verify-email.html` | pre-JavaScript German + 4 translations, identical in all four shells | 1 × 5 locales |
| `content/library-translations/hatoove-library-translations-uk-ar-tr.json` → guides | guide strings bound to the frozen German source | 704 paths × (en, uk, ar, tr) |
| the same bundle → nouns | lexicon: headword, English, German example, English example, then meaning/example/rule per locale | 240 entries × 13 strings |
| `content/library-translations/README.md` pending block | guide paths migration `0043` left German-only | 18 rendered, 15 removed from the source |

**Total learner-facing strings found: 11,563** (including the four English columns and the German
originals). There is no hand-written list anywhere in the pipeline: the catalogues are imported (so
they cannot drift from what the app ships), the bundle is parsed and bound through the importer's own
`planGuideStrings`/`planNounRows`, the frozen German is parsed out of the seed migrations with the
later corrections applied, and the fallback maps and `<noscript>` are statically extracted with the
extraction throwing if a block moves or loses a locale.

**Cross-source disagreements: none.** The five catalogues agree with each other about their key sets
and their placeholders; the bundle agrees with the frozen German source on all 704 paths (every `en`
member equals the source's own English field, no German fragment was altered); the pending record
agrees with both; and all 14 instruction `sourceSha256` values verify when recomputed. A disagreement
is a build-stopping finding, not something the tool smooths over — the mechanism was exercised, see
the mutation legs below.

Two source-side observations, reported rather than fixed (nothing here was changed):

- **35 catalogue keys are mentioned nowhere in the shipped client** (28 `shell`, 2 `practice`, 8
  `public` reading/grammar explanation and checklist keys, 2 `common`) — candidate dead copy, listed
  in full in `CENSUS.md`. A key can also be rendered by a mechanism no static scan can follow (the
  `public.checklistN` family is built as `'checklist' + index`), so this is a list to look at, not a
  defect claim.
- **15 German strings are duplicated across keys** within one catalogue (e.g. `shell.m008`/`m062` =
  "Üben"). Normal shared copy; recorded so nobody treats it as a translation bug.

## Pack sizes and the reading order

| pack | rows | owing a decision | `-rows.csv` | `-review.md` | a realistic reading time |
|---|---|---|---|---|---|
| `de` | 2,321 | 0 (German is the source language) | 1.06 MB | 595 KB | 3–5 h |
| `uk` | 2,561 | 2,561 | 1.23 MB | 698 KB | 6–11 h |
| `ar` | 2,561 | 2,561 | 1.19 MB | 664 KB | 6–11 h |
| `tr` | 2,561 | 2,561 | 1.15 MB | 619 KB | 6–11 h |

The time column is arithmetic, not a measurement: 2,561 rows at a realistic 8–15 seconds per row to
read a German sentence, read the translation and judge it. Break it up the way the pack is already
grouped — the 1,119 interface rows are one sitting (2.5–4.5 h), the 722 guide strings another, the 720
lexicon rows a third. The German pack is faster per row because there is no comparison to make.

Each row carries: a stable id, the place it appears (`where`), the German source, the current text,
its status, and an **empty decision column**. Lines differ by pack:

- `de` = 1,119 interface rows (447 shell + 447 practice + 119 public + 78 auth + 10 common + 14
  instructions + 3 fallbacks + 1 `<noscript>`), 722 guide rows and 480 lexicon rows
  (`german-headword` + `german-example`, status `not-applicable`, exam-language German that is never
  translated).
- `uk`/`ar`/`tr` = the same 1,119 interface rows and 722 guide rows, plus 720 lexicon rows
  (`meaning` + `example` + `rule`). 18 of the guide rows are `pending`: `0043` changed the German and
  the old translation was refused, so nothing is served and a re-translation is owed.

The `-review.md` document is meant to be read top to bottom; the `.csv` is meant to be opened in a
spreadsheet. They carry the same rows; the CSV additionally carries `source_file`, `source_locator`,
`source_note`, `correction` and `note`.

## The exact commands

Regenerate the packs (derived, gitignored):

```text
node tools/build-review-pack.mjs --out D:\Hatoove\handoff\ron-agent\review-packs
```

Check them (this is the gate; it also builds its own copy into %TEMP% and mutates it):

```text
node tools/review-pack-check.mjs
node tools/review-pack-check.mjs --pack-dir D:\Hatoove\handoff\ron-agent\review-packs
```

A reviewer does one of these two, once they have filled in decisions:

```text
node tools/apply-review-decisions.mjs --csv D:\Hatoove\handoff\ron-agent\review-packs\uk-rows.csv --reviewer "Oksana K."
node tools/apply-review-decisions.mjs --json <decisions.json>
```

To cover English as well (it ships, but Ron named uk/ar/tr + de for this round):

```text
node tools/build-review-pack.mjs --languages en --out <dir>
```

## The return path

Two accepted input shapes, both documented inside each `-review.md` and in the `-decisions.template.json`:

1. **Spreadsheet.** Fill `decision` (and `correction` for a fix, `note` for a reject or an `na`) in
   `<lang>-rows.csv`. The short spellings are `ok`, `fix`, `reject`, `na`. Leave a row empty and it
   stays unreviewed.
2. **Decision file.** `hatoove-review-decisions/v1`: `{ reviewer, reviewed_at, decisions: [{ id,
   decision, correction, note }] }` with the long spellings `approved` / `fix` / `reject` /
   `not-applicable`.

The applier writes:

- `<lang>-ledger.json` — `hatoove-review-ledger/v1`, one entry per decided string:
  `{ id, decision, decided_by, decided_at, note, correction, text_at_review, source_file,
  source_locator, section, where }`. `text_at_review` is the text the reviewer judged, so a later
  change to that string invalidates the decision instead of silently inheriting it.
- `<lang>-corrections.csv` — the edits still owed, with `action` (`replace` / `remove` /
  `mark-no-translation-owed`), the owning file and the exact address (`source_locator`), the text at
  review and the reviewer's replacement.

**No script approves anything.** `approved` reaches a pack row only when a ledger entry names
`decided_by` and carries the same text as the row; the applier refuses to run at all without a
reviewer name, and `review-pack-check` fails if an approved row has no reviewer or no ledger entry.
Landing a correction in a catalogue or the bundle is deliberately **not** done here: those files have
owners (`public/assets/i18n/**`, `content/library-translations/**`) and the library side also has to
reach the database through the importer before a learner sees corrected text. The applier prints the
exact proposed edit and stops.

## Completeness: checked, not claimed

`tools/review-pack-check.mjs` — 17 legs, all green.

| leg group | what fails |
|---|---|
| source integrity | a catalogue whose locales disagree about the key set or the placeholders; an empty string; an instruction whose `sourceSha256` does not match its own original; a bundle that is not the pinned artifact or has the wrong counts; a frozen source that lost a `0043` correction; a registered catalogue namespace that has no rows in the pack |
| completeness, both directions | a string in the sources that is missing from the pack; a pack row that no source can account for |
| every row has a source | no `source_de` (unless the row declares itself a translator-authored label and explains why), no `source_file`, no `source_locator`, or a guide `source_de` that the frozen German source does not carry |
| approval is a human act | `approved` with no reviewer; `approved` with no ledger entry; an approval the ledger contradicts; a stale approval whose `text_at_review` differs from the row; a reviewer name that differs from the ledger's |
| the build is inert and deterministic | a source byte that moved during a build; two builds that differ |
| derived output | a pack directory that is not gitignored |
| mutations | see below |

Mutation proofs (each corrupts a copy in %TEMP% and must fail, by name):

| mutation | expected failure | observed |
|---|---|---|
| M1 delete one row | `missing_from_pack` | `lib/guide/cases-guide/…adjektivendungen-bestimmt.payload.note is in the sources but not in the pack` |
| M2 blank the German source | `row_without_source` | `…payload.note has no source_de (source_kind=frozen-german)` |
| M3 approve with no reviewer | `approval_without_reviewer` | `…payload.note is approved with no reviewer on the row` |
| M4 approve with a reviewer but no ledger entry | `approval_without_ledger_entry` | `…payload.note is approved but the ledger has no entry for it` |
| M5 add a row no source knows | `no_source_accounts_for_row` | `ui/shell.m999 is in the pack but no source accounts for it` |
| M6 approve against text the pack no longer carries | `stale_approval` | `…payload.note was approved against text the pack no longer carries` |
| M7 move a CSV column | the applier refuses | `1 row(s) … do not match the 17-column header` |
| M8 decide without a reviewer | the applier refuses | `no reviewer: pass --reviewer "<the human who made these decisions>"` |

The round trip was exercised end to end on a copy: three decisions (approve, fix with a replacement,
`na` with a reason) produced a ledger and a corrections file, and rebuilding with `--ledger-dir`
pointed at that ledger made the pack report `1 approved`, `1 not-applicable`, `19 pending`, `2540
machine_unreviewed` — i.e. only what the human wrote. The delivered packs contain no ledger and no
non-empty decision, so nothing in them is approved.

## What is deliberately NOT in the packs

- **Exam-language content.** Exam sets, passages, items, keys and writing tasks stay German and are
  not translated, so they are not rows. The lexicon's German headwords and example sentences are the
  same case: in the German pack they are rows with status `not-applicable` (German reference language,
  never translated), and in the uk/ar/tr packs they appear as the German source column of the
  `meaning`/`example` rows rather than as 480 rows of untranslated German each.
- **The held HV scripts (POOL-01 batch 1).** Authored, but their audio is held until the media mount
  and Ron's ruling on the recording files. Nothing outside the repository can be reviewed here.
- **The 15 guide fields `0043` removed.** They no longer exist in the source, so nothing renders and
  nothing can be reviewed. The 18 that survived with changed German *are* present, as `pending` rows.
- **English.** It ships as a fifth interface language and the same builder covers it
  (`--languages en`), but Ron named uk, ar and tr for native review plus de for the interface copy.
  The check treats an `en-rows.csv` in the pack directory as a failure, so the exclusion cannot
  silently reverse.
- **Pixels and audio.** The pack proves the text, not what a browser paints or what a recording
  sounds like. Layout, RTL mirroring, overflow and playback have their own checks and evidence.
- **Content that is not authored yet.** The pack lists what ships today, not what is planned.

## What a machine cannot verify

- Whether a translation is natural, correct and exam-appropriate in uk, ar or tr. That is the whole
  point of the pack; no leg can stand in for the native speaker.
- Whether the German interface copy is clear, formal and consistent. The existing
  `i18n-register-check` legs prove formality mechanically; judgement is the German reviewer's.
- That the person named in the ledger is the person who really filled the file, or that a decision
  file was not filled in bulk. The record proves *what was decided against which text and by which
  name*; it cannot prove the name.
- **Which German counts as exam language.** The row `kind` (`interface` / `guidance` /
  `exam-language`) is a curated classification encoded in the builder, not a provable property of the
  text.
- **What renders where, exactly.** The `where` column comes from a static scan: 750 of 1,101 keys are
  bound exactly (a `uiText("…")`, `data-i18n="ns.key"`, `pt/pl/pa("…")` or `data-practice-key="…"`
  position), 316 are only mentioned as a literal in a file (the pack says which file and says the
  binding was not proven), and 35 are mentioned nowhere.
- **Inline-default agreement.** I deliberately did **not** re-implement that cross-check: my first
  attempt produced eight false findings (HTML entities such as `&mdash;`/`&hellip;`, and a JS
  expression mistaken for a literal default). `tools/i18n-register-check.mjs` already owns that
  comparison with the right entity table, the `isLiteral` guard and nine register legs, and it is in
  the baseline gate.
- The library half's approval does not write `review_status` into the database. A reviewer's
  `approved` lives in the ledger; the DB column is the importer's business.

## Commands run, with results

```text
node tools/build-review-pack.mjs --out D:\Hatoove\handoff\ron-agent\review-packs
  census: 1101 catalogue keys, 14 instructions, 3 fallback maps, 1 <noscript> string,
          704 guide paths x 3 locales, 240 nouns, 2112 guide strings + 720 noun rows bound
          with 0 problems; corrections applied: 0043 (2 noun sections + 1 guide section)
  key locations: 750 exactly bound, 316 mentioned only, 35 mentioned nowhere
  cross-source findings: 0
  de 2321 rows; uk/ar/tr 2561 rows each; 4 packs + CENSUS.md + census.json + FINDINGS.md + README.md

node tools/review-pack-check.mjs
  16/16 checks passed

node tools/review-pack-check.mjs --pack-dir D:\Hatoove\handoff\ron-agent\review-packs
  17/17 checks passed

node tools/run-gates.mjs baseline      -> 9/9 passed (repository, design, retired-surface, seo,
                                          server-origin, keymask, owned-api, owned-client, i18n-register)
node tools/run-gates.mjs mirror        -> 10/10 passed (nav-ia, mock-intro, part-index, practice-runner,
                                          practice-selection, drill, library-render, vocab,
                                          library-i18n, content-corrections)
```

The applier's four behaviours were demonstrated directly: refusal without a reviewer, refusal of a
`fix` with no replacement, refusal of an unknown id, and one accepted round trip of three decisions.

## Residual risk

1. **A duplicating tool, held honest by a stronger check.** The insert-row tokenizer and the
   correction pass in `build-review-pack.mjs` are a copy of the ones inside
   `tools/library-i18n-check.mjs` (that module runs its whole suite on import, so it cannot be
   reused as a library). A wrong copy would not pass silently: `planGuideStrings` refuses the bundle
   unless the parse produced the frozen source the bundle was generated from, and the check pins the
   corrected values (240 nouns, 123 sections, 7 guides, the three `0043` statements, the corrected
   `sp1` title) independently. Still, one of the two copies should adopt the other next time either
   is touched.
2. **The ledger is derived-side and out of git.** `handoff/` is gitignored, so "string X was approved
   by Y" is durable on this machine but not in the repository. If Ron wants the approvals versioned,
   the Lead should pick the tracked home and a lease that owns it; `--ledger-dir` is the switch.
3. **The ledger is not signed.** It records a name the reviewer typed. Nothing prevents someone
   filling a decision file with `approved` in bulk; the only structural protections are that a human
   name must be supplied, that each approval is bound to the exact text, and that the applier prints
   everything it accepted.
4. **The 35 unlocated keys** need a human decision (dead copy, or rendered by something the scan
   cannot follow) before the catalogue should be called clean.
5. **The existing library workbooks are not machine-readable here.**
   `handoff/ron-agent/library-review/hatoove-library-{uk,ar,tr}-review.xlsx` (1,248 rows each, German
   · English · translation · verdict · correction) predate this format. If those reviews hold real
   verdicts, they have to be transcribed into the pack CSV by id; I did not attempt to parse xlsx, and
   this pack does not claim their content.
6. **`tools/review-pack-check.mjs` is not registered in `tools/run-gates.mjs`.** That file is the
   Lead's; I ran both gate groups green but did not add a leg. Registration is needed for the check to
   run on every slice.
7. **Pack generation is O(sources) on every run** and writes ~4.9 MB across four languages. Acceptable
   for a derived artifact; if it becomes a gate it should build only into %TEMP% (which the check
   already does).

## Next action

- Lead: create/own whatever lease applies the reviewers' corrections (the catalogues and the bundle
  each have an owner) and decide the tracked home for the ledger.
- Lead: register `node tools/review-pack-check.mjs` in `tools/run-gates.mjs` if it should be a gate.
- Ron: name the four reviewers; each gets one `.md` and one `.csv` and returns the `.csv`.
