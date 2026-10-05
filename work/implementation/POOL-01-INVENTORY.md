# POOL-01 — released objective sets per part (inventory)

**Status: inventory only. No batch was generated and none may be generated without Ron's go-ahead
(contract §5, POOL-01).**

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
