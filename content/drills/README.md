# Recovered grammar practice

`recovered-grammar.json` preserves all 240 original questions in the 17 `POOLS` banks from
`3a9254ce3905b7d4de430e3d129edf0f62c90962:public/js/generators.js`, the parent of the SPA retirement
commit `39125a9`. The record contains the source SHA-256, original question/option/answer/explanation
strings, source order and original `g_<tag>_<FNV-hash>` item IDs. It contains no retired generator,
browser state, adaptive difficulty scores or single-user persistence code.

Ron instructed recovery on 2 October 2026 and recorded the generated rights basis in D1. The old
file's claims that this was hand-written or authentic exam content are not provenance evidence.
These are generated practice items for Hatoove, not a telc item bank; every item remains unreviewed.

Migration `0022-recovered-grammar-drills.sql` makes the twelve `wortstellung_nebensatz` questions
available as one versioned grammar-practice set using the existing `SB1` multiple-choice shape.
This routing category does not make the separate sentences an official exam-format task. The payload
says `practice_kind: grammar-drill` and explains that distinction. Original item IDs remain marking
identities. Options are rotated deterministically by source ordinal, with the corresponding answer
letters stored only in `objective_key`. Existing session ownership and append-only `item_evidence`
record each answer. No answer, explanation or correct-option field enters the learner payload.

The other 228 items are recovered source, not automatically published content. They need curation:
some connector distractors can also fit their sentence, and some original explanations contain
oversimplifications or errors (for example the description of `vorbereiten` as inseparable). Recovery
preserves those source facts rather than silently claiming human review. Publish corrected items as
new versioned records after the required review.

`server/sentence-building.mjs` recovers the finite-form lexicon and useful clause-order rules from
the same commit's `public/js/satzbau.js`. The old guesses based on word endings and automatic noun
capitalisation after an article are removed: they could misidentify nouns and ordinary adjectives.
The server returns bounded, explicitly heuristic structural hints. It does not grade correctness,
predict exam performance, save the supplied text or call a model.

Validation: `node tools/sentence-building-check.mjs`; append `--backend=postgres` with an explicitly
configured disposable PostgreSQL fixture to verify the migration, key isolation and owned evidence.
