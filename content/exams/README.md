# Exam packages and fixtures (EXAM-S2)

This directory holds the version-controlled **package input** documents that the EXAM-S2
importer reads. The importer, the publisher CLI and the validator (`server/package-contract.mjs`,
`validatePackage` / `canonicalJson` / `packageHash`) are owned by the coordinator; nothing in this
directory is runtime, client or migration code, and nothing here publishes anything.

## Package input shape

One JSON document per exam package, with **exactly** these top-level keys (the contract rejects any
other):

```text
{ schemaVersion: 1,
  exam:      { id, title, language, levelModel },
  blueprint: { version, timeGroups: [{ id, seconds, sections }],
               sections:   [{ id, title, parts: [{ family, itemCount, interaction, mediaRequired }], timeGroup }],
               assessment: { policy, correct, incorrect }, sources: [...] },
  release:   { version, state, resumeBlockedReleases: [] },
  forms:     [ { id, version, title, scope, sections, mode, timeLimitSeconds, feedback, members: [{ setId, version, interaction, itemCount }] } ],
  sets:      [ { setId, version, examId, family, section, part, title, payload, itemCount, interaction, answers, explanations, reviewStatus, rightsStatus, source } ] }
```

There is no top-level `fixture` (or other marker) key: the shape above is the whole contract, and an
unknown top-level key is a rejection case.

Rules that this data obeys:

- **Exam language, level model and the objective assessment scale are data, not German constants.**
  `exam.language` is a BCP-47-style tag, `exam.levelModel` is one of `{type:'cefr', levels:[…]}`,
  `{type:'cefr-range', levels:[…]}` or `{type:'band', min, max}`, and
  `blueprint.assessment` carries its own `correct` / `incorrect` values (which need not be
  integers — the alternative-scale fixture uses 2.5).
- **Blueprint part `family` values are the exact existing content ids.** For an objective set that is
  the stored `objective_set.family` part id, which is uppercase — `LV1`/`LV2`/`LV3`, `SB1`/`SB2`,
  `HV1`/`HV2`/`HV3` — while a set's own id (`setId`) stays lowercase, e.g. `telc-deutsch-b1.lv1.01`.
  The writing family is `writing` (the writing section is `id: 'writing'`, `family: 'writing'`).
  A document may still *document* a non-objective shape (listening audio is `fixed_audio`, writing is
  `extended_writing`) but no form here references one.
- **A section `timeGroup` must be declared in `blueprint.timeGroups`.** The shared reading +
  language block is `{ id: 'lv-sb-90', seconds: 5400, sections: ['LV', 'SB'] }`; a section with its
  own timing block carries `timeGroup: null`. A bare identifier is not an executable timing
  definition, so no naked `lv-sb-90` string is left undefined.
- `release.state` is one of `hidden` / `internal` / `available` / `withdrawn`. **Everything in this
  directory is `internal`.** An `internal` (or `available`) release must carry at least one form,
  which is why each fixture, like the telc manifest, declares one internal section form. No import of
  this content grants learner availability or credits.
- Supported S2 interactions are `matching_headlines`, `single_choice`, `matching_ads`, `gap_choice`
  and `gap_bank`. `SB1` is `gap_choice` (per-gap options) and `SB2` is `gap_bank`. A form is only
  "complete" when its members cover every declared part of every section it claims, with reviewed
  media; S2 ships no complete-written capability, so any `complete_supported_written` form is
  rejected and partial fixtures stay internal.
- Answer keys and explanations never travel inside `payload`. The payload is what a learner may
  see; `answers` / `explanations` stay separate source fields and land only in the protected
  objective-key side. A `payload` that carries a secret field is rejected.
- An objective payload uses the LV2 naming from `data/seed.json`: `payload.questions[]` entries are
  keyed by **`n`** (not `id`), which is what the renderer and backend read.

## `exams/telc-deutsch-b1/manifest.json`

The first telc Deutsch B1 package: schemaVersion 1, `language: 'de'`,
`levelModel: {type:'cefr', levels:['B1']}`, objective assessment `correct: 1` / `incorrect: 0`.

- The blueprint records **all four written sections** (LV, SB, HV, writing) with the historical family
  item counts taken from `docs/exam/telc-b1-written-draft.json` — LV 5/5/10, SB 10/10, HV 5/10/5,
  writing 1 — because a form may not claim coverage the blueprint does not declare. Families are the
  exact stored part ids `LV1`–`LV3`, `SB1`–`SB2`, `HV1`–`HV3`; the writing section is
  `id: 'writing'`, `family: 'writing'`.
- `LV` and `SB` share the declared `lv-sb-90` time group (5400 seconds). `HV` and `writing` are
  own-block sections and therefore carry `timeGroup: null`; their own-block minutes stay with the
  historical draft, which is a recovery artefact, not a publication source.
- The HV parts are documented as `fixed_audio` and the writing part as `extended_writing`. Both are
  documented-only: the single form references neither.
- `sets: []` — the form's three members reference the **existing** DB content
  (`telc-deutsch-b1.lv1.01`, `telc-deutsch-b1.lv2.01`, `telc-deutsch-b1.lv3.01`, all `v1`) instead
  of copying questions into new versions.
- The only form is `telc-deutsch-b1.reading.01` v1, "Leseverstehen – Abschnittsübung", scope
  `section`, sections `['LV']`, mode `untimed`, `timeLimitSeconds: null`, feedback `finalise`, with
  the three reading members and interactions `matching_headlines` / `single_choice` / `matching_ads`
  at 5 / 5 / 10 items.
- **Source provenance is historical.** `S1`–`S4` keep their original 2026-09-30 retrieval records.
  `S5` records a 2026-10-03 *metadata re-check only* — the current official page confirms the shared
  90-minute reading + language block and the three reading parts — and explicitly asserts that no
  document was downloaded. There is no fabricated current-day PDF download.
- **No human or educational approval is granted by this file.** It is `internal`; availability
  requires qualified, exact-version review and rights approval that this manifest does not and
  cannot assert. Recorded fidelity gaps (`docs/exam/telc-b1-written-draft.json` §unresolved,
  §gates) stay open.

## `fixtures/exams/`

Offline, synthetic, generated, unreviewed test doubles for the importer contract. They are
**not** content: no third product, no runtime publication, no equivalence to any real examination's
authoring. They carry no `fixture` marker key (the contract forbids unknown top-level fields);
they are fixture-only by construction and provenance:

- they live under `content/fixtures/exams/`, not `content/exams/`;
- their `exam.title` says "Synthetic … (not real … authoring)";
- `release.state` is `internal` (never `available`);
- every set is `reviewStatus: 'unreviewed'` / `rightsStatus: 'generated'` — source provenance only,
  never a licensed/approved educational claim;
- the source record is kind `synthetic-fixture` and states nothing external was retrieved or copied.

- `dtz-internal.json` — exam `dtz-a2-b1`, `language: 'de'`,
  `levelModel: {type:'cefr-range', levels:['A2','B1']}`. A tiny synthetic reading section whose one
  single-choice question is generated, not real DTZ authoring. The blueprint declares `LV`, `HV`
  and `writing`, so the fixture is deliberately **partial**: it stays `internal`, ships one internal
  section form over the reading set, and marking it `available` is a rejection case.
- `english-scale.json` — exam `contract-english`, `language: 'en'`,
  `levelModel: {type:'band', min:0, max:9}`, assessment `correct: 2.5` / `incorrect: 0`. One
  synthetic single-choice question, proving the scale and level model are data.

Both fixtures use the LV2 payload naming from `data/seed.json`: `payload.text` plus
`payload.questions[]` entries with `n`, `question` and an `options` object. Private keys
(`answers`, `explanations`) stay in these non-public source files and are never copied into
`payload`.

## Checking

`tools/exam-s2-package-check.mjs` is the scoped offline test harness. It imports the root-owned
contract (`validatePackage` / `canonicalJson` / `packageHash`) and runs the three documents above
through it:

```text
node tools/exam-s2-package-check.mjs                       # uses server/package-contract.mjs, else $EXAM_S2_PACKAGE_CONTRACT
node tools/exam-s2-package-check.mjs --source-root <dir>   # dir that holds server/package-contract.mjs
EXAM_S2_PACKAGE_CONTRACT=/abs/server/package-contract.mjs node tools/exam-s2-package-check.mjs
```

The exact tested boundaries — positives must be **accepted**, negatives must be rejected with
`code = 'invalid_package'`:

```text
accept  valid telc manifest · internal DTZ fixture · English fractional scale
reject  duplicate form · duplicate member · missing version · protected field in payload ·
        invalid answer option · unsupported interaction (renderer) · unknown top-level field ·
        set examId mismatch · incomplete DTZ marked available · complete-written form
hash    canonicalJson / packageHash deterministic, key-order independent, non-mutating
```

The tool **fails (exit 2)** when the contract module is absent: there is no PENDING mode that lets a
missing contract pass CI silently, and the harness never re-implements the contract with a
different shape. A legacy "changed exam reference" is a database-reference concern, not something a
pure validator can decide from general identity parsing, so the pure case tested here is a set whose
own `examId` disagrees with the package. Existing-DB reference validity and atomic import are
checked by the root on PostgreSQL and are not claimed offline.
