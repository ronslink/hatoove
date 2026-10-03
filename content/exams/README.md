# Exam packages and fixtures (EXAM-S2)

This directory holds the version-controlled **package input** documents that the EXAM-S2
importer reads. The importer, the publisher CLI and the validator (`server/package-contract.mjs`,
`validatePackage` / `canonicalJson` / `packageHash`) are owned by the coordinator; nothing in this
directory is runtime, client or migration code, and nothing here publishes anything.

## Package input shape

One JSON document per exam package:

```text
{ schemaVersion: 1,
  exam:      { id, title, language, levelModel },
  blueprint: { version, sections: [{ id, title, parts: [{ family, itemCount, interaction, mediaRequired }], timeGroup }],
               assessment: { policy, correct, incorrect }, sources: [...] },
  release:   { version, state, resumeBlockedReleases: [] },
  forms:     [ { id, version, title, scope, sections, mode, timeLimitSeconds, feedback, members: [{ setId, version, interaction, itemCount }] } ],
  sets:      [ { setId, version, examId, family, section, part, title, payload, itemCount, interaction, answers, explanations, reviewStatus, rightsStatus, source } ] }
```

Rules that this data obeys:

- **Exam language, level model and the objective assessment scale are data, not German constants.**
  `exam.language` is a BCP-47-style tag, `exam.levelModel` is one of `{type:'cefr', levels:[…]}`,
  `{type:'cefr-range', levels:[…]}` or `{type:'band', min, max}`, and
  `blueprint.assessment` carries its own `correct` / `incorrect` values (which need not be
  integers — the alternative-scale fixture uses 2.5).
- `release.state` is one of `hidden` / `internal` / `available` / `withdrawn`. **Everything in this
  directory is `internal`.** No import of this content grants learner availability or credits.
- Supported S2 interactions are `matching_headlines`, `single_choice`, `matching_ads`, `gap_choice`
  and `gap_bank`. A blueprint may *document* a family whose interaction is not supported (listening
  audio is `fixed_audio`, writing is `extended_writing`) but **no form may reference it**; such
  shapes fail closed. A form is only "complete" when its members cover every declared part of
  every section it claims, with reviewed media; otherwise it stays a partial, internal fixture.
- Answer keys and explanations never travel inside `payload`. The payload is what a learner may
  see; `answers` / `explanations` stay separate source fields and land only in the protected
  objective-key side. A `payload` that carries a secret field is rejected.
- Sections that share one timing block declare the same `timeGroup` (Leseverstehen and
  Sprachbausteine share `lv-sb-90`). Sections with their own timing block declare `timeGroup: null`;
  no separate reading-only timing is invented for the shared block.

## `exams/telc-deutsch-b1/manifest.json`

The first telc Deutsch B1 package: schemaVersion 1, `language: 'de'`,
`levelModel: {type:'cefr', levels:['B1']}`, objective assessment `correct: 1` / `incorrect: 0`.

- The blueprint records **all four written sections** (LV, SB, HV, SA) with the historical family
  item counts taken from `docs/exam/telc-b1-written-draft.json` — LV 5/5/10, SB 10/10, HV 5/10/5,
  writing 1 — because a form may not claim coverage the blueprint does not declare.
- `LV` and `SB` share the `lv-sb-90` time group. `HV` and `SA` are own-block sections and therefore
  carry `timeGroup: null`; their own-block minutes stay with the historical draft, which is a
  recovery artefact, not a publication source.
- The HV parts are documented as `fixed_audio` and the writing part as `extended_writing`. Both are
  documented-only: no form in this package references them.
- `sets: []` — the form's three members reference the **existing** DB content
  (`telc-deutsch-b1.lv1.01`, `telc-deutsch-b1.lv2.01`, `telc-deutsch-b1.lv3.01`, all `v1`) instead
  of copying questions into new versions.
- The only form is `telc-deutsch-b1.reading.01` v1, "Leseverstehen – Abschnittsübung", scope
  `section`, sections `['LV']`, mode `untimed`, `timeLimitSeconds: null`, feedback `finalise`, with
  the three reading members and interactions `matching_headlines` / `single_choice` / `matching_ads`
  at 5 / 5 / 10 items.
- **No human or educational approval is granted by this file.** It is `internal`; availability
  requires qualified, exact-version review and rights approval that this manifest does not and
  cannot assert. Recorded fidelity gaps (`docs/exam/telc-b1-written-draft.json` §unresolved,
  §gates) stay open.

## `fixtures/exams/`

Offline, synthetic, generated, unreviewed test doubles for the importer contract. They carry a
top-level `fixture` marker (`synthetic` / `generated` / `unreviewed` / `notForPublication`) and are
**not** content: no third product, no runtime publication, no equivalence to any real examination's
authoring.

- `dtz-internal.json` — exam `dtz-a2-b1`, `language: 'de'`,
  `levelModel: {type:'cefr-range', levels:['A2','B1']}`. A tiny synthetic reading section whose one
  single-choice question is generated, not real DTZ authoring. The blueprint declares `LV`, `HV`
  and `SA`, so the fixture is deliberately **partial**: it stays `internal`, and marking a partial
  fixture `available` is a rejection case.
- `english-scale.json` — exam `contract-english`, `language: 'en'`,
  `levelModel: {type:'band', min:0, max:9}`, assessment `correct: 2.5` / `incorrect: 0`. One
  synthetic single-choice question, proving the scale and level model are data.

Both fixtures use the LV2 payload naming from `data/seed.json`: `payload.text` plus
`payload.questions[]` entries with `id`, `question` and an `options` object. Private keys
(`answers`, `explanations`) stay in these non-public source files and are never copied into
`payload`.

## Checking

`tools/exam-s2-package-check.mjs` is the scoped offline check:

```text
node tools/exam-s2-package-check.mjs                    # structural check of the three documents
node tools/exam-s2-package-check.mjs --source-root <dir> # also locate server/package-contract.mjs
node tools/exam-s2-package-check.mjs --self-test         # local negative cases (non-vacuous)
```

The contract-level cases (`validatePackage`, `canonicalJson`, `packageHash` — accepted telc
manifest, accepted DTZ fixture, accepted English alternative scale, changed exam reference,
missing version, duplicate form/member, unsupported interaction, pre-feedback secret in payload,
bad answer option, incomplete DTZ marked available, complete written form without coverage,
non-destructive deterministic canonical hash) require the root-owned module. Until it lands they
are reported **PENDING**, not passed. Existing-DB reference validity is a root PostgreSQL-test
concern and is not claimed offline.
