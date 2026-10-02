# SAAS-MODEL-01 — legacy → replacement removal matrix

| | |
|---|---|
| Dispatch | `SAAS-MODEL-01a` (Ron, 2026-10-01), Step 3 |
| Authority | [`DESIGN-WIRE-01.md`](DESIGN-WIRE-01.md) — *"an explicit legacy-to-replacement removal matrix"*; [`IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md) — SAAS-MODEL-01 defines *"owned domain contracts plus an explicit single-user removal matrix"* |
| Base | `codex/integration-01` @ `20f89433dfa22d3d9135d833232d32236466b739` |
| Status | **SKELETON** — one row per legacy writer/reader; filled in Step 3 |

This is a document, not code. **Nothing here is removed in this slice except what Step 2
requires** (the fail-closed entry point). The matrix is the map for `SAAS-RETIRE-01`, gated on
*"replacement consumers verified"*.

## Method

- **Reachability** is established by reading the code path from `server.js`, not by grepping
  for a string: a route is reachable in the SaaS runtime when a request can reach it after the
  fail-closed gate and the origin gate, and when `public/js/` still calls it.
- **Negative check** is the thing that will prove the legacy path is gone. A zero-string grep
  is *not* a negative check (a comment or another project's copy matches); each row names the
  reachable-code and dependency inventory plus the dynamic check that must fail once the path
  is removed. Matches are classified, not required to be a meaningless zero.

## Matrix

_(rows added in Step 3)_
