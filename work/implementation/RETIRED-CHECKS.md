# RETIRED CHECKS — the ledger

A check guards a **property**. When its implementation is removed, the property is either moved to a new vehicle or
it is void, and this file records which — so that a deleted check is never mistaken for a passing one.

**The rule** (an architect review of the functional-product direction, 2026-10-01). Write the property in one
sentence, in terms of what a learner, attacker or operator could observe, then ask one question:

> **Could a learner, attacker or operator of the *new* product observe a violation of this property?**

| Answer | Action | Conditions that must hold, or it is "deleting a failing check to declare victory" |
|---|---|---|
| **Yes, and only the vehicle changed** | **RETARGET** — keep the assertion, change what it drives | The retargeted check **fails on a tree where the property is broken** (discrimination leg recorded), and the retarget lands **in the same PR** as the vehicle change |
| **Yes, but the mechanism cannot exist in the new architecture** | **REPLACE** — new check, same property, new mechanism | The replacement is **green and discriminating on `origin` in or before the same PR** as the deletion; the ledger names the replacement file and leg |
| **No** — the property belongs only to the removed implementation | **DELETE WITH A RECORDED REASON** | Deletion happens **in the commit that deletes the implementation**, never earlier. Where the removal is itself a safety property, add a **negative check** proving the implementation is gone |
| **Unclear** | Treat it as **Yes**, then REPLACE | — |

**Three prohibitions.** No `skip`, `continue-on-error`, `|| true` or commented-out CI steps — a step is either
present and gating, or deleted with a row here. Never delete a check whose implementation is still reachable. And
**do not count retirements as progress**: this is a cost record, not a scoreboard.

**Columns:** `check | leg(s) | property | decision | reason | replacement file:leg, or "none — property void" |
commit that removed the implementation | slice`

---

## Retired

| Check | Leg(s) | Property | Decision | Reason | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|---|
| `tools/mock-outcome-browser-check.mjs` (**CI step removed**) | `no-fabricated-score-when-unassessed` (P1), `submitted-text-stays-accessible` (P2), `no-pass-or-grade-band-claim` (P3), `no-horizontal-overflow` (P4) | **P1** — when the assessment is unavailable the writing shows as `unbewertet` and never a fabricated score. **P2** — submitted text stays accessible. **P3** — no "Bestanden?"/grade-band/readiness claim. **P4** — the mock layout does not scroll horizontally | **P1–P3 REPLACE; P4 DELETE** | The check spawns `node server.js` as a **local single-user** server (`mock-outcome-browser-check.mjs:115-126`, `B1PREP_PROGRESS_FILE`, no account configuration). The new direction **removes local single-user mode**, so the check cannot boot its server — this is the red `Rendered behaviour` job on PR #82. Keeping local mode alive to feed one check is exactly what the new direction ends | **P1–P3** → `tools/writing-result-browser-check.mjs` leg `failed-or-pending-assessment-renders-unassessed` (**slice MFP-08**, not yet written). **P4** → none; the mock view is deleted in MFP-11a | `MFP-00` (this row's commit) | MFP-00 |
| `tools/mock-outcome-check.mjs` (**KEPT**) | all 19, including discrimination against the pre-fix `exam.js` | `assessMockWriting` never fabricates a score | **KEEP** | It runs at the **node** level with no server and no browser, so removing local mode does not touch it. **It still guards P1–P3's logic** until the mock view itself is deleted | itself — CI step `Mock writing outcomes, discriminated against the pre-fix tree` (`.github/workflows/ci.yml` offline job) | — | — |

### What we lose until MFP-08 lands, said plainly

**Rendered** evidence of P1–P3. The logic is still guarded by `mock-outcome-check.mjs` at the node level, but nothing
now proves that the *rendered* writing result refuses to show a fabricated score. That property is not abandoned —
it is **unproven between this commit and MFP-08**, and MFP-08 must write its replacement leg before the writing
result screen ships.

---

## Pending — identified, not yet executed

These were identified by the same review and are **not** retired yet, because their implementations are still
reachable. Each names the slice that retires it.

| Check | Leg(s) | Property | Decision | When | Replacement |
|---|---|---|---|---|---|
| `progress-equal-check.mjs` (+ `.test.mjs`) | all 10, incl. pre-fix discrimination | `progressEqual` compares two progress blobs independent of key order | **DELETE** | MFP-11a — the commit that deletes `public/js/progress-merge.js` and the blob | none — property void. The negative check that matters is MFP-02b's `retired-surface-check`: no `/api/progress` route, no progress file opened |
| `progress-scope-check.mjs` | all 7 | the blob store is account-scoped | **DELETE** | MFP-11a | MFP-07's `no-learner-state-in-web-storage` leg |
| `saas-runtime-check.mjs` | `legacy-progress-local-install-unchanged` | the local app is unchanged | **DELETE** | already retired by `SAAS-MODEL-01a` | `entry-point-fails-closed-when-the-mode-flag-is-omitted` |
| `saas-runtime-check.mjs` | flag-matrix legs (`B1PREP_SAAS` on/off) | two modes behave differently | **DELETE** | MFP-02b | `startup-refuses-removed-flags` + `missing-config-exits-before-listen` |
| `accounts-http-check.mjs` | `accounts-are-off-by-default` | absent config is safe | **RETARGET** | MFP-02b | absent config → process exits non-zero **before `listen()`** |
| `session-boundary-check.mjs` | legs that run "accounts off" | the single-user server path | **DELETE** | MFP-11a | the server-side legs (ordering, response fencing) stay; the client-boundary legs die with `account.js`'s single-user phase |
| `server-origin-check.mjs` | all 16 | a non-GET `/api/*` needs the same origin | **RETARGET** | MFP-02b | drive `PUT /api/v1/settings` and `POST /api/auth/sign-in/email` instead of `POST /api/config` |
| `provider-config-check.mjs` | all 11 | a learner cannot set the provider or model | **RETARGET** | MFP-02b | `/api/config` → 404; `PUT /api/v1/settings {"model":…}` → **422** (a new leg: `model` is still accepted today) |
| `keymask-check.mjs` | all 12 + pre-fix discrimination | no route discloses any 3-character run of the key | **RETARGET** | MFP-02b | route list becomes `/api/health`, `/api/ready`, `/api/auth/*`, `/api/v1/*`, static. The pre-fix discrimination commit `8a71f71` stays valid as a historical leg |
| `reset-check.mjs` (9), `revision-check.mjs` (8) | all | a delete really deletes, and a late write cannot resurrect it | **REPLACE**, then DELETE | MFP-02b | owned equivalent: `DELETE /api/v1/attempts/:id` then a stale `PUT` → 404, never a recreate; account deletion then a late write → 401. **Write the owned leg first**, in `owned-api-check` |
| `writing-surface-browser-check.mjs` | (a) an account draft restores; (b) "leaves the single-user path alone" | (a) a saved draft comes back; (b) local mode is untouched | **(a) RETARGET; (b) DELETE** | MFP-08 / MFP-11a | (a) becomes MFP-08's fresh-browser draft restore |
| `account-ui-browser-check.mjs` | 25 | the explanation-language setting does not translate the German menu | **RETARGET** | MFP-07 | the new shell: navigation strings identical before and after a language change (`RON-DECISIONS-20261001.md` §4.1) |
| `provider-config-browser-check.mjs` | 13 | Settings offers no provider field | **RETARGET** | MFP-07 | the new settings screen |
| `session-boundary-browser-check.mjs` | 70 | a second tab cannot re-create the account record | **REPLACE** | MFP-07 + `deletion-check` | the new client holds no learner state in `localStorage`; server-side, a late write after deletion → 401 |
