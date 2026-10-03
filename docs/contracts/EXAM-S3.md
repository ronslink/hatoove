# EXAM-S3: internal DTZ reading

Execution EXAM-S3-20261003-A, [issue 110](https://github.com/ronslink/hatoove/issues/110), base `470d428`. Ron authorised original draft content on 3 October 2026, with qualified human approval pending. This slice implements internal reading acceptance; it does not complete the DTZ release gate.

## Content and interaction

The original package lives at `content/exams/dtz-a2-b1/manifest.json`. Exam identity is `dtz-a2-b1`, title `Deutsch-Test für Zuwanderer (DTZ), A2–B1`, language `de`, range A2/B1. Blueprint/release use `v2` to avoid reusing the S2 synthetic fixture's v1 identity. The original form is `dtz-a2-b1.reading.original01@v1`; its five original sets are `dtz-a2-b1.lv1.original01` through `dtz-a2-b1.lv5.original01`, each `v1`, families LV1–LV5, section LV. All are generated/unreviewed and the release is internal. Keys and explanations remain private import inputs. The source is independently authored, not copied from official examples.

The reading form is untimed section practice with 25 items and feedback only at finalisation. Blueprint source records cite the [official g.a.s.t. format, page 6](https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/PDF/gast_DTZ_UEbungssatz_1.pdf), retrieved 3 October 2026; the reference reading time is 45 minutes but this form has no countdown. Reading counts are 5/5/6/3/6. Parts use single_choice (directory), matching_ads, grouped_choice (three passages, each one true/false and one three-option question), single_choice (brochure, true/false), and gap_choice (letter). Part 5 stays reading, never a DTZ Sprachbausteine section. Item IDs are 21–45 to match the format's reading numbering, without claiming an official test.

`grouped_choice` is a registered generic interaction. Its public payload is `{groups:[{id,text,questions:[{n,question,options}]}]}`. Group IDs and item IDs are stable scalar tokens; group IDs are unique and item IDs are unique across the entire set. Each group has nonempty passage text and questions; each question has nonempty text and at least two labelled options. For true/false questions option IDs are `richtig` and `falsch`; multiple choice uses `a`, `b`, `c`. Answer storage and marking use the same scalar option contract. Group order then question order defines flattened position. Every question renders its own group's passage, including after resume and in review. Unknown/malformed groups, duplicate identities, invalid keys/options and protected public fields are refused before import. No exam-specific executable code.

Existing immutable migrations stay unchanged. A forward migration extends protected SQL validation/marking for the new shape while retaining ownership, exact versions, release policy, finalisation boundary and key-role isolation. API/client adapters use interaction metadata rather than assuming all LV3 are telc matching ads or that cloze is always SB.

## Availability and preparation

The default catalogue remains telc-only; no new runtime environment or browser flag enables DTZ. The original package is not added to default startup imports. Disposable PostgreSQL and source-only browser fixtures explicitly import it and inject the existing server-side test catalogue seam. Public mode, default catalogue, direct IDs and incomplete publication must all refuse access. The fixture must not read a local `.env`, call providers or use learner ports/data.

S3 proves two-exam choice, preparation-specific date/history/results, autosave before switching, retained context/local answers when save fails or conflicts, late-response fencing and two independent tabs. Empty multi-exam accounts choose explicitly; existing telc-only accounts keep the one-option bypass. No DTZ credit allowance is invented, transferred or refilled. Human content/device acceptance remains open and is not represented by mechanical tests.

## Evidence

Focused offline/SQL checks cover grouped/mixed shapes, exact-version keys, cloze section identity, publication/owner negatives and unchanged telc contracts. Isolated browser evidence covers login → choose → start → resume → submit → review, switching/recovery, desktop, 390px and 320px, light/dark and keyboard focus. Independent review and applicable CI precede integration. Physical iPhone/Android checks, educational approval, complete listening/writing and product release remain separate.
