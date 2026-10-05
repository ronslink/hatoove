# Library translations — uk / ar / tr

Offline batch generated on 5 October 2026 for MIRROR-B1PREP-01 slice **F2** (LIBRARY-I18N-01).
No learner data was involved and no live provider call happens per learner (D10: no live AI
generation).

## Files

| File | Purpose |
|---|---|
| `hatoove-library-translations-uk-ar-tr.json` | Import bundle: 704 guide strings across the seven guides, plus 240 nouns. |

- `sha256` of the ingested bundle: `f9dd7991350adfad9905acd64e932a4d2a66742cc22fd86ab9289c7ac0d780fa`
  (531 902 bytes). **Re-pinned 5 October 2026 by LIBRARY-I18N-REPIN (task-27)** after migration `0043`
  corrected the German source; the previous pin was
  `f916bc94853f87b723f7b29542554bd4a4194330406f2b1d385efcee2d23776d` (546 584 bytes, 737 strings).
- Bundle header: `status=machine-unreviewed`, `languages=[uk,ar,tr]`,
  `source=hatoove guide_section + noun_entry @v1 (local scratch DB at main f3d0000)`.
- Every locale member is present for every string; no `status` field is set per string — the whole
  bundle is unreviewed.

## Shape

- `guides["<guide>"]["<path>"] = { en, uk, ar, tr }`, where `<path>` is the `guide_section` id path
  (for example `cases-guide/telc-deutsch-b1.cases-guide.bestimmter-artikel.title`). Guide counts:
  cases-guide 61, gender-rules 80, grammar-guide 132, core-grammar 125, core-phrases 130,
  writing-guide 110, speaking-guide **66** (99 before `0043`).
- `nouns["<entry_id>"] = { de, en, example_de, example_en, uk:{meaning,example,rule},
  ar:{…}, tr:{…} }` — 240 entries, rule labels drawn from 31 unique rules.

## Dropped by the `0043` re-pin — German-only until a human re-translates them

Migration `0043` replaced the speaking guide's Teil 1 (three-minute presentation → the official
getting-to-know task) and corrected two noun entries. A path whose German changed cannot keep its old
translation: the importer's binding rule refuses it, and serving uk/ar/tr text about a *presentation*
above German that says *sich kennenlernen* would be worse than German alone. So **33 speaking-guide
paths were dropped**, in two groups, and the rest of the bundle is untouched (704 retained, every one
with `en` equal to its source sibling):

- **15 paths** whose field the correction removed: `payload.approach[3..5].step` and `.detail` (6),
  `payload.phrases[3..5].group` and `.hint` (6), `payload.examples[1].topic` (1),
  `payload.watchOut[3..5]` (3).
- **18 paths** that survive with changed German: `title`, `summary`, `payload.approach[0..2].step` and
  `.detail` (6), `payload.phrases[0..2].group` and `.hint` (6), `payload.examples[0].topic` (1),
  `payload.watchOut[0..2]` (3).

All 33 are under `speaking-guide/telc-deutsch-b1.speaking-guide.sp1.*`. **The two noun entries were
re-bound, not dropped**: `…das-familiemitglied` (`de`, `example_de` regenerated; the fix is a spelling
correction, so uk/ar/tr still describe the same thing) and `…die-moebel` (`en` `piece of furniture` →
`furniture`, `example_de` regenerated with `Möbelstück`; no locale quotes the replaced example or the
misspelling, so the translations stand). The re-translation batch is therefore 33 SP1 paths × 3 locales
= 99 strings, and it stays a native-review decision.

## Rules that bind the importer

1. `review_status` defaults to `machine_unreviewed`. No agent marks a string approved.
2. German example sentences inside the translations are kept verbatim. The delivered mechanical
   check found 0 mismatches in the grammar traps; the importer check re-asserts it.
3. Translations attach to the version they were generated from (`…@v1`). A new guide version makes
   them stale and stale bundles are not served as current.
4. The interface shows `machine_unreviewed` lines with **"maschinell übersetzt · Prüfung ausstehend"**
   until a native reviewer approves them.

## Native review (owed)

Reviewer workbooks — 1,248 rows each, columns German · English · translation · verdict (OK/Fix) ·
correction, with an explanatory first sheet — are kept out of commits at
`handoff/ron-agent/library-review/hatoove-library-{uk,ar,tr}-review.xlsx`. Native review must finish
before the "machine-translated" marker is removed.

## Source-data defects found while translating

Recorded in `docs/contracts/MIRROR-B1PREP-01.md` §7; they are corrections to the German source, not to
the translations:

- `das Familiemitglied` → `das Familienmitglied`.
- `die Möbel` glossed as a singular; the singular is `das Möbelstück`.
- The speaking guide still teaches Teil 1 as a three-minute presentation instead of the official
  "getting to know each other" task.
