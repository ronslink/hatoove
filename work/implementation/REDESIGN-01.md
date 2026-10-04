# REDESIGN-01 — studio look for the Hatoove shell

Status: **in progress**. Slice A is landed and verified locally; slices B–G are open.
Owner: coordinator (this session). Branch: `codex/redesign-01-studio-look`.

## 1. Where this plan comes from

This document is the governing slice plan for REDESIGN-01. Ron specified it directly on 4 October 2026;
the repository contained no REDESIGN-01 document, so the plan below is written from his description, the
pinned design system and the shell's actual markup. Nothing here overrides `AGENTS.md`, `PILOT_BUILD_PLAN.md`
or `docs/contracts/PILOT-I18N-INTERFACE.md`.

## 2. Slice A — reveal the correct answer after a recorded practice answer

**Delivered.** One commit on `codex/redesign-01-studio-look`:

    REDESIGN-01 A: reveal the correct answer after a recorded practice answer (migration 0041)

Migration `server/migrations/0041-objective-answer-reveal.sql` adds `reveal_objective_answer(set, version, item)`,
`SECURITY DEFINER`, granted to the learner role only. It returns one item's expected answer **only** to an owner
who already has an `item_evidence` row for that exact `(set, version, item)`; without an owner it raises
`not_found`, and the `objective_key` table stays unreadable by every runtime role (0021).

Evidence written by the answering caller, and by `finalise_mock_run` only at finalisation, is what makes the
reveal possible — so a mock run in progress reveals nothing, and a mock result has shown correct answers since
finalisation existed. `answerObjectiveItem` and `listMistakes` now carry `correct_answer`; item-serving payloads
are unchanged. Supporting updates: the migration manifest digest and the seven checks that list expected
migrations (`exam-s3`, `exam-s4`, `exam-s5-media`, `exam-s5b-backend`, `explanation-review`,
`registration-language`, `payments` pg checks). `objective-key-access-check` gains three legs and a count of 8.

Local evidence (this checkout, `0858196`):

| Check | Result |
| --- | --- |
| Offline baseline (all eight commands in `AGENTS.md`) | 8/8 green — `.qa/redesign-01/offline-baseline-sliceA.log` |
| `objective-key-access-check` (PostgreSQL) | recorded in `.qa/redesign-01/sliceA-postgres.log` |
| `owned-api-check --backend=postgres` and the other PG legs | recorded in `.qa/redesign-01/sliceA-postgres.log` |

The PG legs run against a scratch database (`hatoove_redesign01_check`) on the local compose PostgreSQL, never
the `hatoove` database. Machine-local logs live under `.qa/` and are not committed.

## 3. Slice B — palette, navigation and the exam card

**Open.** Blocked on one input: the studio-look colour list. Ron is sending it; do not invert a palette from
the pinned tokens in the meantime.

Constraints that decide the implementation:

- `public/assets/design/hatoove.css` is the **pinned** design system. Its digest is a reviewed contract
  (`design-assets-check` D2, `app-browser-check` P0b) and it must not be edited.
- `public/app/app.css` is the shell's own layer and the only stylesheet we may edit. It defines **zero**
  custom properties today.
- `design-check` D1 scans `app.css` for raw colour in a *rule* and exempts token-definition lines
  (`design-check.mjs:80`). So the new palette enters as `--token:` definitions in `app.css` and every rule
  refers to it through `var()`. A raw hex in an `app.css` rule fails D1.
- D5b: `app.css` may use only the system breakpoints, 1100 px and 860 px.
- D3: every token used in `app.css` must be defined (pinned file plus `app.css`).

Contrast: every colour pair slice B introduces is measured before it lands, including the one Ron already
measured — unanswered tiles need `#7d8ea6`, 3.3:1 on paper, to reach the non-text minimum.

Shell facts the palette has to fit (from `work/implementation/REDESIGN-01-SHELL-MAP.md`):

- 15 routes. Navigation is **already grouped**: an unlabelled group, `.kicker.nav-label` "Lernen"
  (`shell.m305`, index.html:63) and "Konto" (`shell.m306`, index.html:70).
- Menu type comes from the pinned `.nav a{font-size:15px}` (`hatoove.css:98`); larger type is an `app.css`
  override, not a pinned edit.
- There is **no icon system**: inline hand-authored`<svg class="i">` only, `package.json` dependencies empty,
  no Lucide/Feather/Heroicons anywhere. Slice B vendors a Lucide subset with its ISC licence and provenance.
- "Weiter üben" does not exist in the repo today; the nearest controls are `#preparation-continue`
  (index.html:111) and `#preparation-start`. Orange is the pinned `.btn-primary` pair.

## 4. Slice C/D — answer feedback

**Open.** The server now returns `correct_answer` but `public/app/app.js` does not render it yet
(`answerItem`, app.js:1098-1126 shows only `shell.m137`/`m138` text; `renderMistakes`, app.js:916-970 shows
`your_answer` only). This slice builds the answer tiles, the verdict box, the question navigator, "Weiter",
and the part-result screen over that data.

A check must change with the markup: `tools/shell-locale-check.mjs:224` asserts
`data-answer="a">a) Original English answer`, pinning the current button text in `app.js:1091-1092`.

## 5. Slice E/F — Fehlerheft and copy cleanup

**Open.** Fehlerheft cards over `correct_answer`, plus copy cleanup in all five interface languages
(de/en/uk/ar/tr). New keys must exist in all five dictionaries; `shell-locale-check.mjs:28-36` enforces
identical keys and placeholders. Ron's native reviewers must check the uk/ar/tr strings before they are
called reviewed — machine output is not review.

## 6. Slice G — landing page, sitemap, OG card

**Open.** Includes replacing the front-door graphic, which Ron judges oversimplified and not meaningful:
the orange paper strip folded into steps (`public/assets/orange-path-1400.jpg`, with
`orange-path-900.webp`, `orange-path-1400.webp`, `orange-path.png`). The working direction is a real
screenshot of the redesigned shell cropped to one answered question — wrong pick red, right pick green, the
explanation in the learner's own language beside the German task, navy sidebar with the large B1 — with the
same image cropped as the social preview card. Synthetic content only; no stock or AI imagery, no invented
scores, no claims. Ron approves the graphic before it goes live. Sitemap and OG card follow the existing
`seo-check` contract.

Impressum and Datenschutz stay **blocked** until the operator entity exists.

## 7. Definition of done for the whole slice set

1. Every slice's own focused tests, plus the offline baseline list from `AGENTS.md`, green on the final tree.
2. The PostgreSQL legs run on a disposable database, not on learner data.
3. Desktop and mobile rendered evidence (screenshots); emulation does not replace the real-device
   keyboard/audio gate, which stays open.
4. A saved bundle and patch under `.qa/redesign-01/bundle/` so the work survives a workspace reset.
5. Independent review by someone other than the author before integration; no live DNS, deployment,
   production access or real-money action.
