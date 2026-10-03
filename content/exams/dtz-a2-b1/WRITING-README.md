# DTZ A2–B1 — original internal writing draft (`dtz-a2-b1`, part `SA`)

This directory holds the **original, generated, internal** writing practice input for the
EXAM-S4 slice (issue 113, execution `EXAM-S4-HERMES-20261003-A`). It is a package input
document in the same family as the S3 reading `manifest.json`; the S3 file is **not** changed
by this slice. Nothing here is runtime, client, migration or publication code, nothing here
publishes anything, and nothing here grants a learner any access.

- File: `writing-manifest.json` — `schemaVersion: 1`, exam id `dtz-a2-b1`, title
  `Deutsch-Test für Zuwanderer (DTZ), A2–B1`, `language: "de"`,
  `levelModel: {type: "cefr-range", levels: ["A2", "B1"]}` (reused unchanged from S3).
- Blueprint and release are both `v3`, continuing past the S3 `v2` identity.
  `release.state` is `internal`, `release.resumeBlockedReleases` is `[]`.
- The reused `LV` section (Leseverstehen) keeps its S3 parts `LV1`–`LV5`. A second section
  `SA` (title `Schreiben`, own time block, `timeGroup: null`) is added with one part
  `{family: "writing", itemCount: 1, interaction: "writing_choice", mediaRequired: false}`.
- `blueprint.assessment` stays `objective-count-v1` with `correct: 1` / `incorrect: 0`; it
  marks the objective reading part only. The writing task is **not** scored by this scale.
- `sets: []` — this file adds no question sets. The five reading sets already live in the S3
  `manifest.json` and are imported there first.

## Forms

Both forms are `scope: "section"`, `mode: "untimed"`, `timeLimitSeconds: null`, feedback only
at `finalise`. Neither title claims a complete examination.

- `dtz-a2-b1.writing.original01@v1` — section `SA`, `members: []` (the writing part is offered
  through `writingChoices`, not a question set).
- `dtz-a2-b1.reading-writing.internal01@v1` — sections `LV` and `SA`. Its five members are the
  exact S3 reading references `dtz-a2-b1.lv1.original01` … `dtz-a2-b1.lv5.original01`, all
  `v1`, at 5/5/6/3/6 items. No copy of any reading question is made.

Both forms carry the same `writingChoices`:

```text
writingChoices: [{ id: "SA1", section: "SA",
  options: [ {id:"A", taskId:"dtz-a2-b1.writing.original01.a", taskVersion:"v1"},
             {id:"B", taskId:"dtz-a2-b1.writing.original01.b", taskVersion:"v1"} ] }]
```

## Writing tasks (two distinct originals)

Each entry in `writingTasks` is `family: "writing"`, `section: "SA"`, `version: "v1"`,
`reviewStatus: "unreviewed"`, `rightsStatus: "generated"`, `rubricId: "writing.dtz-a2-b1"`,
`rubricVersion: "v1"`, and is **not** a copy of any official task.

- **A — `dtz-a2-b1.writing.original01.a`**, register **`Sie`**: a formal letter to a transport
  company's customer service (`Kundenservice`) about a monthly pass that failed a check,
  requesting a replacement and a refund of the single ticket.
- **B — `dtz-a2-b1.writing.original01.b`**, register **`du`**: a short note to a known
  neighbour who is travelling, reserving the cover she was already offered (plants, post,
  airing) and asking for what is needed.

Both are plausible everyday, non-intimate correspondence. Each has a German topic, an original
German situation, a named addressee and **four neutral content points** (`leitpunkte`) that
say what to cover without dictating wording. There is **no minimum word count**, no forced
`Sie` everywhere (informal address is appropriate if used consistently), no model answer and no
automatic content ticking.

## Rubric `writing.dtz-a2-b1@v1`

`policy: "dtz-writing-practice-v1"`, `feedbackKind: "dtz-writing-bands"`,
`reviewStatus: "unreviewed"`, `rightsStatus: "generated"`. Four criteria, each with the same
six band positions (`bands` `B1_PLUS:5 … ZERO:0`, `bandLabels` `B1 gut erfüllt … Nicht erfüllt`)
and six original German `descriptors`:

- `dtz_aufgabe` / Aufgabenbewältigung — how many of the four content points are met, using the
  five-to-zero content-point distribution (5 = all four precise; 4 = all four only
  partly inferential, or three adequate; 3 = three partly inferential, or two adequate;
  2 = two partly inferential, or one adequate; 1 = one partly inferential; 0 = no relevant
  point / wrong situation).
- `dtz_kommunikation` / Kommunikative Gestaltung — appropriate everyday purpose/register and a
  connected sequence.
- `dtz_korrektheit` / Korrektheit — intelligibility despite errors; **no mechanical error
  quota**.
- `dtz_wortschatz` / Wortschatz — appropriate everyday range/control, including paraphrase.

The language criteria split B1 and A2 into good/fulfilled, then A1 and 0. A text with no
meaningful relation to the writing occasion takes ZERO in all four criteria. There is **no**
`maxTotal`, and no total / pass / readiness output.

## Provenance and review status

- **Originality.** Every German topic, situation, addressee, content point and rubric
  descriptor here was independently authored for this slice, as a paraphrase in our own words.
  No official DTZ, telc or g.a.s.t. task text, rubric sentence, model answer or scale wording
  was copied, translated or reproduced.
- **Format source (structure only).** The writing task shape, its four content points and the
  band-scale skeleton were noted from the official g.a.s.t. **practice set 2 (June 2024)**,
  `https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/PDF/gast_DTZ_UEbungssatz_2.pdf`,
  **rendered pages 42, 43 and 47**, and from the current **DTZ FAQ**,
  `https://www.gast.de/de/forschung-entwicklung/entwicklung/auftraege/deutsch-test-fuer-zuwanderer-dtz/faq`,
  both read and verified on **3 October 2026**. That citation establishes structure only; it is
  **not** a content licence and confers no rights to any official material.
- **Rights/review.** Everything is `reviewStatus: "unreviewed"`, `rightsStatus: "generated"`.
  This is source provenance only. Human educational review, rights review and translation
  review are all **pending**, and **no agent, importer or test can grant them**. The release
  stays `internal`; availability requires separate, qualified, exact-version approval that this
  file does not and cannot assert.

## Limitations

- The rubric descriptors are **original provisional paraphrases**, an internal
  **mechanical simulation** of the band structure — not the licensed assessment, not a
  validated CEFR calibration, and not an official scoring key. No educational calibration is
  invented or claimed.
- No fixed minimum word count is set, and there is no automatic penalty for a missing date,
  address or subject line. Informal address can be fully appropriate when it stays consistent.
- Mechanical shape checks (below) prove structure, identity and absence of prohibited claims;
  they cannot prove pedagogical quality, difficulty or fairness.
- The backend is adding validator/importer support for the writing fields **concurrently**, so
  the current base `server/package-contract.mjs` is expected to **reject** the new fields
  (`writingTasks`, `rubrics`, `writingChoices` and the `writing_choice` interaction). This slice
  does not change validator code and does **not** claim a contract pass. Acceptance must be
  re-confirmed by the coordinator's real contract once registered.

## Checking

`node tools/repository-check.mjs` screens the staged snapshot for leaked secrets and stale
references; it is **not** a content or correctness proof. The author's own structural
self-check verifies JSON parsing, exact refs, the four content points, the six band positions
and provenance, but is a self-check and **not** a substitute for qualified human review.
