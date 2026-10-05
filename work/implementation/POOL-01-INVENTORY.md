# POOL-01 — released objective sets per part (inventory)

**Status: the pre-batch tables below are historical. POOL-01 batch 1 (task-37) is RELEASED and carries the
current figures — see "POOL-01 batch 1" at the end of this file, which is the table to read for today's
pool. Ron's go-ahead was given on 5 October 2026 (contract A11).**

Measured on 5 October 2026 from the source of truth `data/seed.json` (sha256
`ef26279dfaf3399de1039e0528f385465a5c1a2bc414f0bd0b5c270df2023bac`, recorded in the header of the
generated `server/migrations/0010-objective-catalogue.sql`), not from a running database.

| Part | Released sets | Items per set (authored shape) |
|---|---|---|
| LV1 | 3 | 5 texts |
| LV2 | 3 | 3 |
| LV3 | 3 | 2 |
| SB1 | 3 | 2 |
| SB2 | 3 | 3 |
| HV1 | 3 | 5 items (audio) |
| HV2 | 3 | 10 items (audio) |
| HV3 | 3 | 5 items (audio) |
| **Total** | **24 sets over 8 parts** | |

## Correction (5 October 2026, slice-C server review): 25 sets, SB1 has four

A running-database tap sequence corrected this table once more: **SB1 has four** released sets, not three.
The fourth is `telc-deutsch-b1.sb1.grammar-wortstellung-v1`, a 12-item grammar drill seeded by migration
`0022` from `content/drills/recovered-grammar.json#banks.wortstellung_nebensatz` — released practice
content with `practice_kind="grammar-drill"` and an instruction stating it is not a telc examination set.
It is **labelled, not filtered**, per contract amendment A9.

| Part | Released sets | Items per set (authored shape) |
|---|---|---|
| LV1 / LV2 / LV3 | 3 each | 5 / 5 / 10 |
| SB1 | **4** (3 exam sets + 1 disclosed grammar drill) | 10 / 10 / 10 / 12 |
| SB2 | 3 | 10 |
| HV1 / HV2 / HV3 | 3 each | 5 / 10 / 5 |
| **Total** | **25 sets over 8 parts** | |

The wrap rule is therefore per-part **set count**, never a hard-coded three: for SB1 it fires on the fifth
tap, for every other part on the fourth. A POOL-01 batch that brings each part to six still means 24 new
sets if SB1's drill counts toward the six; if the drill is to remain supplementary, SB1 needs five.

## What this means for the slices

- **B (PRACTICE-UI-01)** — every one of the eight parts has released content, so all eight get a tile.
  The tile's "x Aufgaben geübt · y richtig" count comes from the practice evidence, not from this table.
- **C (PRACTICE-01)** — three sets per part is exactly the wrap problem the contract records: "Noch ein
  Satz" fills the part three times and then must say "Alle Sätze dieses Teils geübt — von vorn".
- **POOL-01 proposal (needs Ron)** — bringing every part to at least six sets means at least three new
  sets per part, i.e. 24 new sets, authored from the released pool's format and then reviewed. That is
  content authoring plus review, not a code slice, and it is the reason the contract gates it on Ron.

## Corrections to the contract's figures

- The contract's evidence table said "Objective sets (telc B1): 25". The measured telc B1 count in
  `data/seed.json` is **24** (8 parts × 3). The figure came from the earlier draft and is corrected here.
- The contract also said "there are 3 sets per part locally (SB1 has 4)". Measured: **3 per part,
  including SB1**. The "SB1 has 4" note came from the same draft; it is not what the repository holds.
- `CURRENT.md` records `objective_set` = 34 rows in production with release head `v2`. That is a row
  count across exam packages (DTZ material is seeded too), not the telc B1 per-part set count, and it
  must not be used as the tile count. A production recount with database access is owed before any batch
  is proposed.

## POOL-01 batch 1 (task-37; hold lifted by task-43; both keys confirmed by task-47, 5 October 2026) — THE CURRENT FIGURES

**Status: ready to apply, with nothing waiting on Ron.** He has read the three LV1 sets and lifted the apply
hold (task-43), and he has answered both content questions (task-47): `lv1.06` text 4 stays keyed to headline
**e**, which was **reworded** from „Umzugshilfe mit Transporter zu vermieten" to „Umzugshilfe: zwei Helfer mit
Transporter", and `lv1.06` text 5 stays keyed to **g** with the near-tie against `b` closed. The applied
decisions, the reasoning and the mechanical checks are in `POOL-01-BATCH-1.md`; `0047` records the
confirmations, carries **no** pending marker, and `tools/pool-01-check.mjs` asserts the confirmed values.

Ron's decision (contract A11(a), option B of `POOL-01-PROPOSAL.md`): six authored sets across the parts a
learner meets earliest. Measured from a **migrated database** after
`server/migrations/0047-pool-01-batch-1.sql`, and from the same three content migrations the runner's corpus
legs now discover (`0010`, `0022`, `0047`):

| Part | Before | After batch 1 (released) | Authored and HELD | Items per set |
|---|---|---|---|---|
| LV1 | 3 | **6** (+`lv1.04`, `lv1.05`, `lv1.06`) | — | 5 |
| LV2 | 3 | 3 | — | 5 |
| LV3 | 3 | 3 | — | 10 |
| SB1 | 4 (3 exam + the `0022` drill) | 4 | — | 10 / 10 / 10 / 12 |
| SB2 | 3 | 3 | — | 10 |
| HV1 | 3 | 3 | **1** (`hv1.04`) | 5 |
| HV2 | 3 | 3 | **1** (`hv2.04`) | 10 |
| HV3 | 3 | 3 | **1** (`hv3.04`) | 5 |
| **Total** | **25** | **28** | **3** | |

**Why the three listening sets are held, not released.** Contract A11(b) and the POOL-01 lease fix the media
bind-mount **before any new audio**, and a listening set whose audio does not exist must not enter the pool:
the runner would print "Die Aufnahmen sind vorhanden" over recordings that are not there, and the drill
already refuses to serve an unplayable item. They are authored, shape-validated and disclosed in the
migration's own header; releasing them is a one-word change of their `release` marker in
`content/pool-01/batch-1.json` plus a new forward migration from the same command. **The pool reaches 31 sets
(LV1 6, LV2 3, LV3 3, SB1 4, SB2 3, HV1 4, HV2 4, HV3 4) when that happens.**

The wrap rule follows the per-part set count it always followed: LV1 now wraps on the **seventh** tap
(`practiceRoundState({setCount: 6, checkedSets: 6})`), every other part is unchanged.

Downstream figures this batch touched: this file; `tools/practice-runner-check.mjs` (legs 12/12b/12c/12d now
discover every content migration and assert the figures above instead of the retired "25"); the contract's
§3/A9 pool line (the Lead's to edit). `tools/practice-selection-check.mjs` needed **no** change — its corpus
and wrap legs read the counts from the served pool.

## POOL-01 batch 1, listening half (task-48, 5 October 2026) — THE CURRENT FIGURES

The paragraph above said releasing the held three was "a one-word change of their `release` marker … plus a new
forward migration". It was that plus the audio, and it has happened: Ron authorised AI synthesis of the three
recordings and their release, so `hv1.04`, `hv2.04` and `hv3.04` are released by
`server/migrations/0048-pool-01-listening-release.sql`, which also carries the three `exam_media` rows their
`recordings[]` bindings resolve against. Measured from a migrated database after `0048` (and asserted by
`tools/pool-01-check.mjs --postgres` P2 and `tools/practice-runner-check.mjs` leg 12):

| Part | Before batch 1 | After batch 1, listening half released | Items per set |
|---|---|---|---|
| LV1 | 3 | **6** | 5 |
| LV2 | 3 | 3 | 5 |
| LV3 | 3 | 3 | 10 |
| SB1 | 4 | 4 | 10 / 10 / 10 / 12 |
| SB2 | 3 | 3 | 10 |
| HV1 | 3 | **4** (+`hv1.04`) | 5 |
| HV2 | 3 | **4** (+`hv2.04`) | 10 |
| HV3 | 3 | **4** (+`hv3.04`) | 5 |
| **Total** | **25** | **31** | 227 items |

Every one of the six batch sets stays **`unreviewed`** (rights basis `generated`), and the three recordings are
machine speech from machine-drafted scripts: the pool figure is complete, the content review is not. The audio
facts, the change set, the gate results and the mutation evidence are in
[POOL-01-LISTENING-RELEASE.md](POOL-01-LISTENING-RELEASE.md); the contract's §3/A9 pool line remains the Lead's
to edit, and `tools/docker-stack-check.mjs`'s pre-batch corpus totals remain the stale line the Lead ruled out
of scope in task-37.
