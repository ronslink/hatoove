# LIBRARY-I18N-REPIN (task-27) — the bundle re-pin after `0043`

**Status: DONE. `library-i18n-check` is green offline AND `--postgres` (8/0 and 20/0), and the mirror gate is
3/4 with the one failure attributed to another slice's pre-fix check (see LEASE 2 below).** Branch
`codex/library-i18n-repin` (base local main `1e9188f`). Nothing pushed, nothing merged.

## What changed

| Artifact | Change |
|---|---|
| `content/library-translations/hatoove-library-translations-uk-ar-tr.json` | **33 speaking-guide paths dropped**, 4 noun fields regenerated. Diff: **4 insertions, 202 deletions** (surgical — the file was NOT reformatted). 531 902 bytes, LF-only. |
| `content/library-translations/README.md` | New pin `f9dd7991350adfad9905acd64e932a4d2a66742cc22fd86ab9289c7ac0d780fa` (was `f916bc94…`), counts restated, and the dropped-for-re-translation list recorded. |
| `server/library-translations.mjs` (**outside my listed scope — announcing**) | `EXPECTED_GUIDE_STRINGS` 737 → **704**; `EXPECTED_STRINGS_PER_GUIDE['speaking-guide']` 99 → **66**. `EXPECTED_NOUNS` stays 240. The module's own count assertions are part of "restate the counts". |

## The 33 dropped paths, by reason (all under `speaking-guide/telc-deutsch-b1.speaking-guide.sp1.*`)

- **15 — the field no longer exists** (the correction removed it): `payload.approach[3..5].step|detail`,
  `payload.phrases[3..5].group|hint`, `payload.examples[1].topic`, `payload.watchOut[3..5]`.
- **18 — the field survives but its German changed**: `title`, `summary`,
  `payload.approach[0..2].step|detail`, `payload.phrases[0..2].group|hint`, `payload.examples[0].topic`,
  `payload.watchOut[0..2]`.

Keeping the second group would have served uk/ar/tr text about the **old presentation task** beneath German
that now describes the getting-to-know task, so they are German-only until a human re-translates them: **33
paths × 3 locales = 99 strings**, and the speaking guide keeps **66 of its 99** paths. Every other guide is
untouched (61/80/132/125/130/110 retained of the same).

**Nouns — re-bound, not dropped.** `…das-familiemitglied` (`de`, `example_de` regenerated; a spelling fix, so
uk/ar/tr still describe the same thing) and `…die-moebel` (`en` `piece of furniture` → `furniture`,
`example_de` regenerated with `Möbelstück`). For both, no locale member quotes the replaced German example or
the misspelling (`Familiemitglied`), so all 240 entries keep their translations. Evidence: the regeneration
report's `localeIssues: []` for both entries, computed byte-wise, no language model involved.

## How it was produced

A throwaway probe (`tools/_repin.mjs`, **deleted before the commit**) used the importer's OWN helpers —
`readFrozenSource`, `englishSibling`, `alteredGermanFragments` — against a disposable PostgreSQL, so the new
bundle satisfies the rule rather than a copy of it. It asserted **every retained path's `en` equals the
source's English sibling** before writing (704 asserted, 0 mismatches), and the surgical applier then proved
the edited text parses to exactly the regenerated object.

## Proof status — **the guide side is fixed; the noun side is now the only mismatch**

`npm run check:mirror:db` → **2/4 passed**: `part-index-check --postgres` PASS, `practice-selection-check
--postgres` PASS, `library-i18n-check --postgres` **FAIL**, `practice-media-check` FAIL (the nine WAVs are not
in git — the known media bind-mount debt, not this task).

The important movement: the failure is no longer `bundle_source_mismatch: 33 problem(s)` (every speaking-guide
path) but `bundle_noun_mismatch: 4 problem(s)`:

```
telc-deutsch-b1.noun.das-familiemitglied: de is not the seeded de
telc-deutsch-b1.noun.das-familiemitglied: example_de is not the seeded example
telc-deutsch-b1.noun.die-moebel: en is not the seeded en
telc-deutsch-b1.noun.die-moebel: example_de is not the seeded example
```

**Unresolved, and reported rather than papered over:** two fixtures disagree about the noun source. The probe's
own `createFixture()` run read the **corrected** rows (`newExample: "Jedes Familienmitglied bringt etwas zum
Buffet mit."`, `en: furniture`), which is why the bundle now carries them; the check's freshly created fixture
reports the **pre-`0043`** rows as "the seeded" values. Both used the same helper from the same worktree, so one
of them is not reading the schema it appears to read — most likely `createFixture()` stops before the newest
migration (it exposes `applyRemaining()`) and one path applies it while the other does not. **Next step: read
`server/owned-postgres/bootstrap.mjs` `createFixture`/`applyRemaining` and establish which source the importer
actually reads at import time.** Only then is the noun decision decidable:

- if the importer's source is the **corrected** rows, the check's fixture is stale and the check needs the fix;
- if it is the **pre-`0043`** rows, the two noun entries must be handled like the 33 SP1 paths — regenerating
  `en` cannot bind them — and `EXPECTED_NOUNS` drops to 238.

**Do not integrate this branch until `library-i18n-check --postgres` is green.** The bundle, README pin and
constants are internally consistent and ready for review; the gate is not.

## Delivered evidence in this lease

- `git diff --stat` for the bundle: **4 insertions, 202 deletions** (not a reformat).
- Regeneration report: 737 → 704 paths (33 removed, 0 added), retained `en` changed 0, retained uk/ar/tr text
  changed 0, noun field changes 4 across 2 entries.
- `en` assertion over all 704 retained paths, run with the importer's own `englishSibling`: **0 mismatches**.
- Tally: `2/4` (above), with the two failures attributed.

## Not done

- The database proof is incomplete: the importer/check were not observed green, and `--dry-run`/idempotence were
  not re-measured on a clean database (my first attempt reused a database whose schema the fixture tears down,
  so the counts I read were meaningless — that measurement is discarded, not reported as evidence).
- No `.gitattributes` change was needed (the bundle keeps its `-text` rule and stayed LF-only: 0 CR bytes).

---

# LEASE 2 (task-28) — the noun-source disagreement RESOLVED, and the gate is green

## The measurement, not the inference

`tools/lib/bootstrap.mjs` (named in the lease) **does not exist**; the fixture is
`server/owned-postgres/bootstrap.mjs`. Its `createFixture()` called with **no options** applies every migration
from `0010` onward — `0043` included — and only `stopBefore` holds files back. Printed side by side:

```text
createFixture()                     -> das-familiemitglied de="das Familienmitglied"
                                       example="Jedes Familienmitglied bringt etwas zum Buffet mit."
                                       die-moebel en="furniture"  example="Dieses Möbelstück passt überhaupt nicht in unser Wohnzimmer."
createFixture({stopBefore:'0043-'}) -> de="das Familiemitglied" (misspelled), en="piece of furniture",
                                       example="Dieses Möbel passt überhaupt nicht in unser Wohnzimmer."
bundle                              -> the CORRECTED values
readFrozenSource(migrated schema)   -> the CORRECTED values
```

So **the importer's source is the corrected one.** The check was the stale side — but not where the hypothesis
guessed, and the guess is worth correcting: **the failure was never in the check's database fixture.**
`tools/library-i18n-check.mjs` calls `createFixture()` with no options too, so its `--postgres` schema was
always post-`0043`. The stale fixture is its **offline** one: `frozenSource()` parsed the raw SQL of the SEED
migrations `0012`/`0013`/`0014` and never applied `0043`'s UPDATEs, and it is that source — built ~100 lines
*before* any database exists — that `planNounRows` compares the bundle against. That is why the check failed at
line 132 while its own probe (and the importer) read corrected rows.

## The decision: fix the fixture, keep the two nouns RE-BOUND

`EXPECTED_NOUNS` stays **240**; nothing was dropped and the README's drop list is unchanged. `0043` UPDATEs
`noun_entry` in place, so any migrated database serves the corrected rows, and the regenerated `en`/`de`/
`example_de` bind them. The alternative (treating them like the 33 SP1 paths) would have dropped two correct
translations to satisfy a stale fixture.

## The fix

`frozenSource()` now applies every later migration's corrections to the parsed seed rows, with a small, strict,
quote-aware reader for `UPDATE "<schema>".<table> SET col = 'v', … WHERE col = 'v' [AND …];`. It ignores `--`
comments, semicolons inside literals and `::jsonb` casts, and it finds `WHERE` **outside** string literals — the
corrected English text contains the word "where" ("… for example about where they live …"), which a
case-insensitive text search finds as a keyword. A correction it cannot understand **throws**, so a future
correction can never be silently ignored here. Two stale literals in the same file were also fixed, by
derivation rather than by retyping: the hardcoded bundle length `546584` → `531902`, and the import row-count
assertion `2211` → `EXPECTED_GUIDE_STRINGS × TRANSLATION_LOCALES.length` (it had drifted the moment the
constants were re-pinned). The three "737" labels became "704".

## The new legs (the guard that would have caught this)

- **offline** — the offline frozen source carries `0043`'s corrections (both noun rows and the SP1 section) and
  all 240 nouns still bind;
- **postgres** — the offline source and `readFrozenSource` on the migrated schema **agree**, printing both
  sides (`de="das Familienmitglied"`, `en="furniture"`), plus the SP1 title/summary/payload and both row counts.

## Evidence — fresh container, fresh `node server/migrate.mjs` (`applied=43 skipped=0`)

```text
after migrate        rows guide=0   noun=0   digest=d41d8cd98f00b204e9800998ecf8427e   (migrate does NOT import)
--dry-run            inserted 2112 + 720, boundEnglish 704   -> fingerprint UNCHANGED (0/0, same digest)
first import         inserted 2112 + 720                     -> 2112/720 digest=2675124423657b58308b0120892063c0
second import        inserted 0, unchanged 2112 + 720        -> digest IDENTICAL

node tools/library-i18n-check.mjs             8 passed,  0 failed
node tools/library-i18n-check.mjs --postgres  20 passed, 0 failed   (was 19 passed / 1 failed on bundle_noun_mismatch)

npm run check:mirror:db  ->  3/4
  PASS  library-i18n-check --postgres      (10.3s)
  PASS  part-index-check --postgres        (1.7s)
  PASS  practice-selection-check --postgres (3.1s)
  FAIL  practice-media-check               (3.2s)   <- NOT this slice; see below
```

**The one failing gate is not a library regression.** `tools/practice-media-check.mjs` on THIS branch is the
pre-fix copy: it builds a multi-line mutation pattern with `\n` and compares it against the CRLF working copy, so
`assert.notEqual(mutated, source)` (line 643) fails and the check aborts before its tally. The Lead fixed exactly
that at `252e20f`, which `git branch --contains` shows on `main`; this branch's base `1e9188f` predates it. I did
not touch that file (outside this lease's scope and another slice's artefact) — it is green on any tree carrying
that fix.

Also honest: my FIRST import sequence ran against a schema my own earlier `node -e` probe had already populated,
so its "before" fingerprint was not empty. That measurement is discarded, not reported; the numbers above are
from the fresh `DROP DATABASE` / `CREATE DATABASE` / `migrate` run.
