# POOL-01 — proposal for the released-set pool (needs Ron's go-ahead)

**Status: proposal only. No set has been authored, generated or imported. POOL-01 §5 of
`docs/contracts/MIRROR-B1PREP-01.md` gates the batch on Ron's explicit go-ahead.**

## What the pool is today

Measured from the source of truth `data/seed.json` (sha256 `ef26279d…`, recorded in the header of
`server/migrations/0010-objective-catalogue.sql`), not from a running database — see
`work/implementation/POOL-01-INVENTORY.md`:

| Part | Sets today | Items per set (official shape) |
|---|---|---|
| LV1 / LV2 / LV3 | 3 each | 5 / 5 / 10 |
| SB1 / SB2 | 3 each | 10 / 10 |
| HV1 / HV2 / HV3 | 3 each | 5 / 10 / 5 |
| **Total** | **24 sets over 8 parts** | |

**Why it matters now, not later.** Slice C's runner serves one released set per part and "Noch ein
Satz" walks the pool. At three sets per part the fourth tap already has to say *"Alle Sätze dieses
Teils geübt — von vorn"*. A learner who practises a part twice in a week meets a repeat. The
contract's target is **at least six sets per part**, which is 24 new sets.

## What "one new set" costs

A set is authored and reviewed content, not a generation job — Hatoove has no live AI generation
(D10), and the objective key is served only to the worker. Per set it is:

1. **Authoring** the passage(s) or recording script in the exam's own shape and length, with the
   items, the key and the explanations.
2. **Review** — a qualified human check of the German, the key and the task fidelity. The existing
   pool is `unreviewed` in the content ledger; new sets should not be born reviewed by an agent.
3. **Media** for HV: a recording per set, with the play rule the blueprint declares (HV3 twice
   each). The nine WAVs currently live only in the deployed image, not in git — a bind-mount fix is
   already owed, and 24 more sets multiply that exposure.
4. **Import**: `data/seed.json` → `tools/build-objective-migration.mjs` → a new forward migration
   (never a rewrite of the applied `0010`), with its `MANIFEST.json` line.

## Options, with what each costs

| Option | Scope | What it buys | Cost/risk |
|---|---|---|---|
| **A. Leave the pool at 3** | nothing | No content risk, no new media | The wrap message is the normal experience for a part after two sessions; the runner meets the same three sets repeatedly |
| **B. Prioritised top-up** (recommended) | 6 new sets first: HV1–HV3 and LV1 (the parts a learner meets earliest), then the rest in a second batch | Six sets on the parts that carry most practice time, for a quarter of the full batch | Two authoring/review cycles instead of one; uneven pool for a while |
| **C. Full batch to 6 per part** | 24 new sets, 8 parts | The contract's target everywhere at once | The largest content commitment, and the media debt lands in one go |
| **D. Reduce the promise instead** | change §5 C's wrap wording | Nothing to author | Contradicts Ron's "you select a section and what we have in the database for that lesson is presented" — the thin pool stays thin |

## What I need from Ron

1. **Go / no-go on authoring new sets at all**, and if go, whether B (prioritised) or C (full).
2. **Who authors and who reviews.** I can prepare the authoring brief and the import path; I will not
   mark content reviewed, and an agent should not author exam validity claims on its own.
3. **Whether the HV media debt is fixed before or after the batch.** Adding 24 recordings to a pool
   whose audio is not in version control compounds a known problem.

Until that answer, nothing in this slice moves, and slice C ships with the honest wrap message for a
three-set pool.
