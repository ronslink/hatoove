# D1 — Content provenance: where each source came from, and who made it

**Implementation update, COMPLETE-20261002-A:** migrations 0011–0014 already store the word lists and guides. Migration 0020 records Ron's generated-content declaration; the rights policy now gates new writing and objective practice as well as catalogue selection. The exact served task and rubric must both pass the policy. Existing owned work stays readable after withdrawal. Migration 0022 adds 12 generated, unreviewed word-order questions from the recovered 240-item source; 228 remain unserved. None of these states means qualified educational approval. The original source inventory below is historical and its "not yet in the database" statements are superseded by this update. See [completion evidence](COMPLETE-20261002-RESULT.md).

**Answered by Ron, 2 October 2026: the content is AI-generated.** This file records what the repository can
actually establish about each source, so the rights position rests on evidence rather than on assertion — and
so the gaps are visible to whoever signs it off.

The one thing this file will NOT do is claim a human author where the tree records none. `docs/content/DISCOVERY.md:121`
already states the rule this follows: *"A declared `source` string is a self-description by the corpus, not
proof of provenance; it is weaker evidence than a named rights holder or a human review record."* No file in
this repository carries `reviewedBy`, `approvedBy`, an author field or a date field.

## The four sources

| Source | Where the bytes are recorded as coming from | Author recorded? | Rights recorded today |
|---|---|---|---|
| **6 writing prompts** (3 du / 3 Sie) | `content_seed.mjs:54` → `public/js/ai.js#OFFLINE_WRITING_TASKS` — the retired client's offline task array, **deleted in `39125a9` (SPA-RETIRE 4)**, still in git history | **No** | `review_status='unreviewed'`, `rights_status='unknown'` on every row |
| **24 reading / grammar / listening sets** (LV1–LV3, SB1–SB2, HV1–HV3) | `data/seed.json`, generated into migration `0010` by `tools/build-objective-migration.mjs`; the migration header records the source digest `sha256 ef26279d…` | **No** — `seed.json` has no meta or author field | same: every `objective_set` row is `unreviewed` / `unknown` |
| **Word lists and grammar guides, ~483 KB** | Nine files in `data/`: `vocab.json`, `noun-lexicon.json`, `grammar-guide.json`, `core-phrases.json`, `core-grammar.json`, `speaking-guide.json`, `writing-guide.json`, `gender-rules.json`, `cases-guide.json` | **No** — every file carries only a SUBJECT description in `"source"` (e.g. `"telc Deutsch B1 - Grammatik zum Nachschlagen"`), which names a topic, not a rights holder | not yet in the database; `docs/content/DISCOVERY.md` records no rights field |
| **The old app's grammar drills** | `public/js/satzbau.js` and `public/js/generators.js`, **deleted in `39125a9` (SPA-RETIRE 4)**, introduced in the baseline `2feaba6`; recoverable from git history | **No** | not in the database at all |

## What this means for the rights position

`work/implementation/CONTENT-POOL-01.md:183-186` already worked out the consequence, before Ron's answer:
*"AI-generated items are original. The 6 writing prompts and the 15 objective sets currently seeded are
`rights_status='unknown'`, and that is why production serves nothing. Generated content can carry an honest
`rights_status='generated'` — which means the pool does not merely respect the content-rights gate, it shrinks
it, leaving only the hand-authored material."*

So the decision to record is **`rights_status='generated'`** for these rows, with the honest consequence that
the remaining rights risk is not the wording but the **exam-model fidelity** question that D9 answers
separately (original items, never a board's item bank) and that **E-01** verifies for the rubric.

## What the repository CANNOT establish, and what the rights review must therefore ask

1. **Whether any of it derives from a third-party source.** The corpus's `source` strings name telc *topics*;
   they do not establish that no published course book, past paper or item bank was consulted while writing
   it. Nothing in the tree can settle that — it is a question for the person who generated it (Ron, 2 October
   2026: AI-generated).
2. **Whether the German is correct and exam-faithful.** Structural completeness was measured (180 of 180 slots
   carry a key and an explanation, `docs/content/DISCOVERY.md`); **the explanation text was never read for
   quality**, and its own record says so.
3. **The 15-vs-24 set count in older records.** `MASTER-PLAN.md:294` (D1's original wording) and
   `CONTENT-POOL-01.md` speak of **15** sets; `data/seed.json` holds **24** across eight families, of which
   **15 are served** and the 9 listening sets are held back by `media_required` because the audio does not
   exist. Both numbers are right about different things, and the older records should be read as "the 15
   servable sets".

## What changes in the schema when this is implemented

`content_version.rights_status` and the `objective_set`/`rubric_version` rows need the value `generated`
(plus the licence text for the two FONT families, which is a separate, already-curated question). The serving
policy's `rights_status` gate then admits generated content while still refusing hand-authored material with
no basis. That is a small migration plus a serving-policy value — not a re-authoring — and it is the first
work item this answer unblocks.
