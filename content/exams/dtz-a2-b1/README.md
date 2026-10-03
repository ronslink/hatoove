# DTZ A2–B1 — original internal reading draft (`dtz-a2-b1`)

This directory holds the **original, generated, internal** reading practice input for the
EXAM-S3 slice (issue 110, execution `EXAM-S3-HERMES-20261003-A`). It is a package input
document read by the coordinator-owned importer and contract (`server/package-contract.mjs`);
nothing here is runtime, client, migration or publication code, and nothing here publishes
anything or grants a learner any access.

- File: `manifest.json` — `schemaVersion: 1`, exam id `dtz-a2-b1`, title
  `Deutsch-Test für Zuwanderer (DTZ), A2–B1`, `language: "de"`,
  `levelModel: {type: "cefr-range", levels: ["A2", "B1"]}`.
- Blueprint and release are both `v2`, deliberately **not** reusing the S2 synthetic fixture's
  `v1` identity. `release.state` is `internal`.
- One untimed section form `dtz-a2-b1.reading.original01@v1` (Leseverstehen, section `LV`, no
  countdown; the 45-minute reading reference is recorded only as a declared time group, not a
  timer). Its five members are `dtz-a2-b1.lv1.original01` … `dtz-a2-b1.lv5.original01`, all `v1`,
  families `LV1`–`LV5`.

## Content shape (25 items, IDs 21–45)

| Family | Part | Interaction | Items | IDs |
| ------ | ---- | ----------- | ----- | --- |
| LV1 | 1 | `single_choice` (three-floor directory) | 5 | 21–25 |
| LV2 | 2 | `matching_ads` (8 ads `a`–`h`, `x` = no match) | 5 | 26–30 |
| LV3 | 3 | `grouped_choice` (3 passages × 1 true/false + 1 three-option) | 6 | 31–36 |
| LV4 | 4 | `single_choice` with `richtig`/`falsch` options (brochure) | 3 | 37–39 |
| LV5 | 5 | `gap_choice` (letter with explicit `[40]`–`[45]` gaps) | 6 | 40–45 |

Every item carries exactly one correct private answer and one German, evidence-based explanation,
kept in the separate `answers` / `explanations` fields — never inside the learner-visible `payload`.
All of part 5 belongs to reading; it is not a DTZ Sprachbausteine section. There is no
listening, writing, speaking or UI content here, no full written mock and no pass/fail score.

### `grouped_choice` payload

`payload = { groups: [ { id, text, questions: [ { n, question, options } ] } ] }`.

Group ids (`g1`, `g2`, `g3`) and item ids are stable, unique scalar tokens; all item ids are
unique across the whole set. A true/false question uses option ids `richtig` / `falsch`; a
multiple-choice question uses `a` / `b` / `c`. Group order then question order defines flattened
position, so each of the 31–36 questions renders its own group's passage.

The registered validator and renderer follow [the S3 contract](../../../docs/contracts/EXAM-S3.md).
Item IDs remain unique across all groups, including when another question has a different answer type.

## Provenance and review status

- **Originality.** All reading texts, advertisements, situations, statements, questions, options,
  answers and explanations in `manifest.json` were independently authored for this slice. No
  official DTZ, telc or g.a.s.t. exam text was copied, translated or reproduced.
  The coordinator corrected the directory shape and language issues before the first import;
  this remains an unreviewed draft, with no published version replaced.
- **Format source (counts/shape only).** The reading item counts and structural shape follow the
  official g.a.s.t. DTZ practice-set PDF,
  `https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/PDF/gast_DTZ_UEbungssatz_1.pdf` (page 6),
  retrieved by the coordinator on 2026-10-03. That citation establishes item counts and layout
  **only**; it is **not** a content licence and confers no rights to any official material.
- **Rights/review.** Every set is `reviewStatus: "unreviewed"` and `rightsStatus: "generated"`.
  This is source provenance only. Human educational review, rights review and translation review
  are all **pending**, and **no agent, importer or test can grant them**. The release stays
  `internal`; availability requires separate, qualified, exact-version approval that this file
  does not and cannot assert.
- **Selection.** The user explicitly selected original generated internal drafts on 3 October 2026;
  all human approval remains pending.

## Checking

Run `node tools/exam-s3-check.mjs` for the registered package contract and original source shape,
and `node tools/exam-s3-pg-check.mjs` against a disposable database for exact-version marking and
access boundaries. The isolated `tools/exam-s3-browser-check.mjs` proves the internal two-exam
journey. The author's structural self-check is not a substitute for these checks or qualified review.
