# LIBRARY-I18N-MARKER — showing where a translation is pending (task-30)

Owner: teammate `library-ui`. Worktree `D:\Hatoove\.worktrees\library-marker`, branch
`codex/library-i18n-marker`, cut from local `main` at `20edd90` (the re-pin and its check fix). Nothing
pushed, nothing merged, no other worktree touched. Found by REVIEW-LIBRARY-I18N-REPIN (task-29) item 5.

## The finding this closes

After the `0043` re-pin the speaking guide serves 66 strings with **0 SP1**: the corrected German Teil 1
renders, no stale translation and no empty slot — and **0 notes**, because the module's note fires only
when a whole `translations` member is `null`. A path the re-pin dropped was therefore indistinguishable
from a path that never had a translation: 33 SP1 paths × 3 locales = **99 strings** were invisible to the
learner and to the UI. The fact lived in `content/library-translations/README.md` instead of on the
screen.

## What shipped

1. **The record became machine-readable.** `content/library-translations/README.md` keeps its prose and
   gains a fenced JSON block between `<!-- library-translation-pending:start -->` and
   `<!-- library-translation-pending:end -->`, in the shape the Lead approved:
   `{ locales, pending: [{ guide_id, section_id, rendered[], removed[] }] }`, paths relative to the
   section id as in the bundle. `rendered` = German still renders, so a marker is owed; `removed` =
   `0043` deleted the field, so nothing can render there — the record still owns those strings.
2. **The client carries a mirror.** A browser cannot read a README, so `public/app/library.js` exports
   `PENDING_TRANSLATIONS`, a structural copy of that block. The record is the source of truth; the
   mirror exists only because the runtime cannot fetch it.
3. **The marker is section-scoped and record-driven.** A guide section the record lists, on a page in a
   recorded language, whose German really renders and whose recorded paths really have no served string,
   shows one note: `libraryPendingSection` — *"Für diesen Abschnitt liegt noch keine Übersetzung vor. Sie
   sehen die deutsche Fassung."* (five locales, formal address). Nothing is inferred from a missing
   string: a section that simply has no translation member stays unmarked, and the whole-book note
   (`shell.m091`) keeps its own, different meaning — the two states coexist and are asserted separately.
4. **A recorded drop cannot drift from the screen.** `tools/library-render-check.mjs` now reads the
   README block and fails when **record, mirror or rendered markers disagree in either direction**,
   naming which side holds what the other lacks:
   * a record entry with no rendered marker → "the pending runner must fail on its own assertion";
   * a rendered marker the record does not list → "the page marks …, which the record does not list";
   * a client mirror that lost a recorded path → "record-only ["payload.watchOut[2]"] …";
   * a recorded path that starts being served a translation again → "remove the record entry", so a
     re-translation must come back **through the record**.
   It also pins the recorded arithmetic (18 + 15 = 33 paths, × 3 locales = 99 strings), checks that the
   served German exists for every `rendered` path and is gone for every `removed` path, and asserts the
   two marker directions plus the "member exists but carries nothing" case (other sections then
   untranslated and still unmarked) and the "no member at all" case (whole-book note **and** the
   section marker).

**Nothing was machine-translated and no dropped path was re-added.** The 99 strings stay a native-review
batch; the marker says so instead of hiding it.

### One prose correction in the record

The README's removed group summed to 16, not the 15 it claimed: `payload.watchOut[3..5]` (3) should be
`payload.watchOut[3..4]` (2). Derived from the source before and after `0043` with the importer's own
field taxonomy (`approach[].step/detail`, `phrases[].group/hint`, `examples[].topic`, `watchOut[]`, plus
`title`/`summary`): pre 33 paths, post 18, removed 15, `18 + 15 = 33` — which is what the section's
headline and the bundle (704 retained, 0 SP1) already said. The structured block is generated from that
derivation, so the record, the prose and the bundle now agree.

## Commands and results

Run from `D:\Hatoove\.worktrees\library-marker`.

```
node tools/library-render-check.mjs
     mutations reproduced: highlight comparison, single-note rule, a record entry with no marker,
     a marker with no record entry, and a client mirror that drifted from the README record
PASS library render: 6 hub areas and their payload counts, 5 library guide pages with a jump chip per section,
     8 case tables marked exactly off the Nominativ reference, Arabic RTL with LTR German islands,
     one German-only note per page, the machine-translated marker, the lexicon filter/search path,
     and the README's recorded pending list driving one section marker in every pending language.

node tools/library-i18n-check.mjs   → 9 passed, 0 failed   (704 guide strings bind, German examples unchanged)
node tools/i18n-register-check.mjs  → 0 findings (R1–R10, 11 shipped files; the new key is formal in all five locales)
node tools/guide-render-check.mjs   → PASS (303 examples, 15 wrong-example labels)
node tools/design-check.mjs         → 14 passed, 0 failed, 2 pre-existing warnings
node tools/repository-check.mjs     → 743 tracked files, 660 text blobs screened
node tools/retired-surface-check.mjs → 10 passed, 0 failed
node tools/seo-check.mjs            → 11/11 passed
node tools/server-origin-check.mjs  → 8 checks passed
node tools/keymask-check.mjs        → 14 checks passed
node tools/owned-api-check.mjs      → 35 passed, 0 failed (backend: memory)
node tools/owned-client-check.mjs   → 32 passed, 0 failed
node tools/readiness-check.mjs      → 8 passed, 0 failed    (D22 absence legs still green)
node tools/practice-locale-check.mjs → 18 checks passed
node tools/shell-locale-check.mjs   → 25 checks passed
node tools/vocab-check.mjs          → PASS (slice G unaffected)
```

## Rendered evidence

`D:\Hatoove\handoff\ron-agent\library-ui-01\` (gitignored shared handoff):

```
pending-uk-1366-light-sp1-marker.png   1366 light: the marker inside "Teil 1 – Sich kennenlernen",
                                       and Teil 2 below with its translated lines + machine marker
pending-uk-1366-dark-sp1-marker.png    same page, dark theme (design tokens, no new colour)
pending-uk-390-light-sp1-marker.png    390 light: marker at the end of the SP1 card, Teil 2 beneath
pending-uk-390-dark-sp1-marker.png     390 dark
```

Measured in the browser on the harness (real bundle served per locale): 1366 and 390, light and dark →
**exactly 1** `data-library-pending`, on `telc-deutsch-b1.speaking-guide.sp1`, inside the article whose
heading is the recorded section's title, **0** whole-book notes (the page's other lines are translated
with `перекладено машинно` markers), no page overflow at any of the four states. A control page that has
no record entry — `cases-guide` in Ukrainian — measures **0** markers, **0** whole-book notes and 40
rendered translated lines at 320 px, with no overflowing element, so an untranslated-or-translated page
without a record entry is provably unmarked.

Reproduce: `node tools/library-render-check.mjs --harness handoff/ron-agent/library-ui-01/library-harness.html --serve 4331`,
then `http://127.0.0.1:4331/handoff/ron-agent/library-ui-01/library-harness.html?route=speaking-guide&locale=uk&theme=dark`.

## What was NOT verified

* **No live database or HTTP.** The check is offline and deterministic; the served member shape is the
  real bundle in the shape `readGuideTranslations` produces, not a live response. The reviewer's own
  measurement (task-29) is what established the served counts.
* **No native review.** Every translated line still carries the machine marker; the 99 pending strings
  are a native-review batch and this slice adds a signpost, not a translation.
* **No real device or screen reader.** The marker is text in the existing `.library-note` idiom, so it
  inherits that element's behaviour, but assistive-tech behaviour was not measured here.

## Residual risk

1. **The mirror is a copy.** Mitigated by the two-way check, which fails and names the drifting side —
   but until someone runs `library-render-check`, a hand edit to only one of the two places is possible.
2. **A new drop is not detected automatically.** The check proves record ↔ mirror ↔ screen, not
   "a drop happened": if the importer drops a path and nobody writes it into the README, the page stays
   silent, which is exactly the original defect. The importer already knows which paths it refused, so
   the durable fix is for the import step to emit this record rather than a human maintaining it.
3. **The marker is per section, not per line.** A recorded section that also has some translated members
   shows one marker for the card, while the translated lines keep their own machine marker. That is the
   approved semantics (the marker marks a recorded section), but a reviewer looking for line-level
   precision should read it as section-level.
4. **One recorded section today.** `pending` has one entry; the legs generalise over the array but have
   never run with two, so a multi-section record is unexercised.
