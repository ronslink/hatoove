# Library translations — uk / ar / tr

Offline batch generated on 5 October 2026 for MIRROR-B1PREP-01 slice **F2** (LIBRARY-I18N-01).
No learner data was involved and no live provider call happens per learner (D10: no live AI
generation).

## Files

| File | Purpose |
|---|---|
| `hatoove-library-translations-uk-ar-tr.json` | Import bundle: 737 guide strings across the seven guides, plus 240 nouns. |

- `sha256` of the ingested bundle: `f916bc94853f87b723f7b29542554bd4a4194330406f2b1d385efcee2d23776d`
  (546 584 bytes). Verified against the delivered copy in `C:\Users\ronon\Downloads`.
- Bundle header: `status=machine-unreviewed`, `languages=[uk,ar,tr]`,
  `source=hatoove guide_section + noun_entry @v1 (local scratch DB at main f3d0000)`.
- Every locale member is present for every string; no `status` field is set per string — the whole
  bundle is unreviewed.

## Shape

- `guides["<guide>"]["<path>"] = { en, uk, ar, tr }`, where `<path>` is the `guide_section` id path
  (for example `cases-guide/telc-deutsch-b1.cases-guide.bestimmter-artikel.title`). Guide counts:
  cases-guide 61, gender-rules 80, grammar-guide 132, core-grammar 125, core-phrases 130,
  writing-guide 110, speaking-guide 99.
- `nouns["<entry_id>"] = { de, en, example_de, example_en, uk:{meaning,example,rule},
  ar:{…}, tr:{…} }` — 240 entries, rule labels drawn from 31 unique rules.

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
