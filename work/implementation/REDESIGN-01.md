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

**Structure delivered** (commits `a0765cd`, `c3c4f49`, `7b02825`). Detail and measurements:
`work/implementation/REDESIGN-01-SLICE-B.md`.

- The eleven sidebar icons are vendored Lucide paths (lucide-static 1.52.0, ISC) — no dependency, no CDN,
  works offline.
- **The sidebar is a named navy**, `#1e2a3a` light and `#141d29` dark, derived by the Lead because the
  studio-look list did not arrive after two requests. It is ONE token pair to replace: change `--nav-bg` and
  `--nav-ink-muted` in `app.css` and nothing else moves. All twelve measured pairs pass in both themes (idle
  label 7.52:1, group label 7.85:1, full label 13.78:1, white logo 14.51:1, hover surface 1.44:1, active item
  4.95:1; dark 8.44 / 16.12 / 1.41 / 6.98).
- **The exam card carries a large level mark**, read from `exam_package.level` — authored since migration
  0009, already returned by `listExams`. Nothing is parsed out of an exam id; the badge hides when the server
  supplies no level. Pinned by `.qa/redesign-01/exam-level-contract.mjs` (8/8).
- Menu type is 16 px, and the orange "Weiter üben" action is on the next-task card (`shell.m389`).
- Three defects were found by rendering, not by reading: an unguarded dark-theme block that made the sidebar
  light on a light device, an idle label at 1.51:1, and an ink logo at 1.13:1 on the navy.

## 4. Slice C/D — answer feedback

**Answer tiles, verdict and the reveal are delivered** (`f9e51fa`, `af57d29`):

- Each option is a tile with a letter badge, the full authored label and a verdict slot. `data-state` comes
  only from the server's response — `correct`, `wrong`, or `was-correct` for the key when the learner got it
  wrong — and every state carries a glyph (✓/✗) as well as a colour. An unanswered tile has no state at all.
- The Fehlerheft rows and the practice verdict both name the correct answer, in the selected interface
  language.
- Contrast is measured in both themes for tile text, glyph and border; every pair passes (the table is in
  `work/implementation/REDESIGN-01-SLICE-B.md`).
- The tile-state rule is pinned by `.qa/redesign-01/tile-state-contract.mjs` (16/16), because the rendered
  harness cannot drive practice to a verdict on this machine: nine `(picked, correct, key)` combinations,
  including a pick that is also the key and a backend with no `correct_answer`, plus a source check that
  `answerItem` still contains the branch order. The file is a contract harness, not a unit test of the
  imported module — `public/app/app.js` is a DOM-bound entry point that Node cannot import.

A check had to change with the markup and did: `tools/shell-locale-check.mjs:224` used to pin
`data-answer="a">a) Original English answer` literally. It now parses the tile and asserts the invariant
instead — the bare option id in `data-answer`, the letter visible and unescaped, the authored label in full.

**Run navigator and part result delivered** (`slice D`, this round):

- The open set's head carries a live progress line — `shell.m390`, "3 von 5 beantwortet" — updated after
  every response the **server accepted**, so a request that fails or never returns counts nothing.
- When the last item of the set is answered, a part-result card appears (`shell.m392` + `shell.m391`,
  correct/total) with the orange "Weiter üben" action. It is shown once: answering the last item again does
  not stack a second summary.
- A response that arrives after the learner opened a **different** set is ignored, and closing the run
  resets the counter, so a reopened set starts at zero.
- Pinned by `.qa/redesign-01/run-progress-contract.mjs` (19/19): seven state transitions including a failed
  request, a foreign set, a one-item set and a zero-item set, plus a source check that the gates are still
  in `app.js` and that both new keys carry one placeholder shape in all five dictionaries.

`app-browser-check` cannot prove these legs (it cannot drive practice to a verdict on this machine), which is
exactly why the contract harness exists.

**Mock result per-part line delivered** (`169a73a`): the mock result now names each part's count — "Teil 1:
4 von 5 richtig" — counted from the learner's own recorded responses against each part's item count. A count,
not a score: no percentage, no pass line, and nothing claimed about parts the learner never saw. The key
`partResult` carries one placeholder shape in all five languages.

**Still owed:** nothing on this slice. The exam card with the large B1 and the navy were delivered in slice B;
the Fehlerheft styling and the copy audit in slice E/F; the landing page in slice G.

## 5. Slice E/F — Fehlerheft and copy cleanup

**Delivered** (`f2172b2`):

- The Fehlerheft row separates the learner's own answer from the correct one, with the design system's own
  success pair on the correct chip. The data was already there after slice A; the screen did not use it.
- The five-language copy was **audited as code**, not by eye: 438 shell keys and 303 practice rows are
  identical across de/en/uk/ar/tr, every row carries exactly five values, and every key's placeholder shape
  agrees. The audit found and fixed one untranslated string (Turkish `form` read the English word "Form").
- Full detail, including the six strings this slice added that need native review:
  `work/implementation/REDESIGN-01-COPY-AUDIT.md`.

**The uk/ar/tr wording is NOT reviewed.** The audit is structural: it cannot tell whether a translated string
is right, only that it exists and carries the same placeholders. `AGENTS.md` stands — Ron's native reviewers
decide the six new strings.

## 6. Slice G — landing page, sitemap, OG card

**The artwork and the social card are landed** (`c31d08d`, `adabb59`, `fc98e3e`, `3424425`).

- The front door now shows one telc B1 Sprachbausteine question — the learner's wrong pick red, the keyed
  answer green, the explanation in Ukrainian beside it — instead of the orange paper strip. The strip was
  also redundant: the page already renders a working interactive preview (`#practice`) two sections above.
- One source, two crops: 960×640 above a 1199 px breakpoint, 720×480 below it. Both are SVG, so the four
  replaced rasters (1.63 MB) are gone and nothing is fetched from a third-party origin.
- **The breakpoint is 1199 px, not the page's 900 px layout breakpoint**, because the wide crop's smallest
  style needs a ~512 px slot. Serving it in the 901–1199 band left text at 12.6–16.0 px, which is exactly the
  failure Ron rejected. Three browser legs now assert which crop each width is *served*.
- **The social card was in English** while the page is German-first (`og:locale` is `de_DE`, and both the
  title and description a crawler reads are German), so the one image a share displayed contradicted the
  share. The replacement is built from the same design tokens in a browser — real Bricolage Grotesque and
  Source Sans, the page's own H1, the current pilot wording — at exactly 1200×630, with `og:image:alt`
  updated to describe what ships.
- An independent verification of the landed page caught four defects, three of them the Lead's: an alt text
  that described the wrong section and inverted the answers, the wrong breakpoint, a "fix" that shrank the
  exam kicker to 11.5–13.2 px at real slots, and a comment claiming font behaviour that does not happen (an
  SVG loaded via `<img>` may not load its own `@font-face`). All four are corrected.

**Still owed:** the OG card swap needs Ron's approval — `seo-check` S4 pins its dimensions and its alt text,
so it is a public-facing asset rather than an implementation detail.

**Known limitation, measured and not hidden:** below a viewport of about 354 px the slot is too narrow for
the artwork's smallest style to reach 16 px (at 320 px it measures 14.4 px). The artwork cannot exceed the
viewport, and a third crop would have to drop the two answer tiles or the question itself — so below that
width the graphic is a glanceable illustration and the meaning is carried by the alt text and the copy
beside it. That is a deliberate trade, recorded rather than papered over.

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
