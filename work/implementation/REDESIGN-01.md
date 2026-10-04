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

### Independent review of slice A

A reviewer who did not write the change reviewed commit `0858196` and re-ran the evidence itself:
`objective-key-access-check` 8/8, `owned-api-check --backend=postgres` 34/34, the other seven PG checks green,
and the offline baseline 8/8. Verdict **PASS WITH NOTES**; the report is `.qa/redesign-01/SLICE-A-REVIEW.md`.

It found one weakness worth acting on and one coverage hole that is now fixed:

- **F2 (fixed in this branch).** No leg pinned the `(set, version, item)` exactness: a mutant that dropped
  `e.item_id = p_item_id` returned the key for an *unanswered sibling item* while all eight legs kept their
  values. `objective-key-access-check` now has a fourth REDESIGN-01 A leg asking for an unanswered sibling and
  for a version the learner did not answer; the count is 9. The leg was checked against deliberate mutants
  (`.qa/redesign-01/mutant-probe-exactness.mjs`) rather than assumed to be load-bearing.
- **F1 (open, needs the security review).** The guard is a predicate the caller's own role can satisfy:
  `__LEARNER__` holds `INSERT` on `item_evidence` (`0015:62`) under only the owner RLS policy (`0015:56-58`), so
  a caller with raw learner-role SQL can write the evidence row the reveal demands and then read that item's
  key. No shipped route does this — practice reveals only the item just answered, and mock answers go to
  `mock_run.responses` — so it is not API-reachable today, but it falsifies the invariant written in
  `0015:8-9`. Dropping the runtime `INSERT` is not a local edit: `finalise_mock_run` is definer-rights, so a
  follow-up migration can move the practice evidence write into one definer operation and then revoke INSERT.
  That is a security-boundary change and is recorded here as the recommended follow-up, not smuggled into a
  restyle branch.
- **F3 (clarified).** "A mock run in progress reveals nothing" holds because nothing writes `item_evidence`
  mid-mock, but it is a workflow fact, not a confidentiality property: `finalise_mock_run` already returns
  `correct_answer` for every item, answered or not.

## 3. Slice B — palette, navigation and the exam card

**Structure delivered** (commit `a0765cd`); colours are still the pinned values by Ron's decision of
5 October 2026, so the studio-look list is a values-only change. Detail and measurements:
`work/implementation/REDESIGN-01-SLICE-B.md`.

- The eleven sidebar icons are vendored Lucide paths (lucide-static 1.52.0, ISC) — no dependency, no CDN,
  works offline.
- The sidebar is a dark surface in both themes, driven by new tokens in `app.css`; menu type is 16 px.
- Three defects were found by rendering, not by reading: an unguarded dark-theme block that made the sidebar
  light on a light device, an idle label at 1.51:1, and an ink logo at 1.05:1 on the dark surface.
- Still owed: the exam card with the large B1, the orange "Weiter üben" button (its key `shell.m389` exists
  in all five dictionaries; the button does not), the navy itself, and the colour values.

## 4. Slice C/D — answer feedback

**Partly delivered** (commit `a0765cd`): the Fehlerheft rows and the practice verdict now show
`correct_answer`, in the selected interface language, and `tools/app-browser-check.mjs` L19 asserts the reveal
instead of the behaviour slice A replaced. Still owed: the answer tiles, the full verdict box, the question
navigator, and the part-result screen — they need the studio-look values to be designed objects.

A check had to change with the markup and did: `tools/shell-locale-check.mjs:224` pins
`data-answer="a">a) Original English answer` in `app.js`, which is unaffected so far because the tiles are
not built yet.

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

## 8. Known state of the rendered check, so no one re-learns it

`tools/app-browser-check.mjs` is **not** a CI gate (`AGENTS.md`), and on the unchanged tree it already fails
38 legs: several catalogue views render "Loading…" on that harness (L12, L14, L16, L20.woerterbuch) and the
settings, session and mock legs time out. Those are pre-existing and are not slice B's. `L20.nachschlagen`
is flaky — it passed in one run and failed in the next two on identical code for that view.

The working method for this branch is therefore a **stashed baseline**: stash the slice, run the harness, run
it again with the slice, and compare failing leg names. Slice B has zero regressions by that comparison, and
the logs are in `.qa/redesign-01/` (`baseline-browser.log` against `slice-b-final2-browser.log`).

One useful instrument to keep: `.qa/redesign-01/cascade-probe.html` loads the pinned stylesheet and `app.css`
in the shell's order on a bare page, so a cascade question can be answered in one browser load without a
signed-in session.
