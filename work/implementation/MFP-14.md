# MFP-14 — CHECKS-NOW: the table-class catalogue check and the journey harness skeleton

| | |
|---|---|
| Task / execution | MFP-14 (FUNCTIONAL-ROADMAP §5.3 Dispatch 3, §5.5) |
| Base | `origin/codex/integration-01` @ `36163d8e0a8d8dddbfbb270eb05ddacfa7a3b172` |
| Branch | `codex/mfp-14-checks-now` |
| Allowed paths used | `tools/table-class-check.mjs`, `tools/table-class-check.test.mjs`, `tools/journey-api-check.mjs`, `tools/lib/catalogue.mjs`, `work/implementation/MFP-14.md` |
| Not touched | `.github/workflows/ci.yml`, anything under `server/**`, anything under `public/js/`, `spikes/**` |
| Status | **In progress** — skeleton committed first (rule 1: commit the checker early even failing). |

## What this slice is

A **checks** slice. It adds no feature. It adds:

1. `tools/table-class-check.mjs` — classifies every table in the app schema as **auth**,
   **owned**, or **shared content**, and fails on any unclassified table. Guards the round-1
   "most dangerous #2" (deletion/RLS drift): `ACCOUNT_TABLES` is a hand-maintained list, so a new
   owned table is covered only if someone remembers to add it, and `deletion-check` **18/18**
   would still pass while an account's rows survived in it.
2. `tools/table-class-check.test.mjs` — the **mutation proof**: four mutations in a scratch schema,
   each required to make the check fail.
3. `tools/journey-api-check.mjs` — the journey **skeleton**: J1–J11 as HTTP-level legs against a
   configured runtime, `PENDING <slice-id>` for legs whose route does not exist yet.
4. `tools/lib/catalogue.mjs` — the shared catalogue reader (used here, and later by MFP-09's export leg).

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Record skeleton; commit; push; open PR (a branch with no PR gets no CI) | done |
| 2 | `tools/table-class-check.mjs` | pending |
| 3 | `tools/table-class-check.test.mjs` mutation proof 4/4 | pending |
| 4 | `tools/journey-api-check.mjs` skeleton | pending |
| 5 | Record: verbatim output, findings, LIMITS; baseline re-run | pending |

(Sections below are filled in as each step lands.)
