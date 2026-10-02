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

### 2 October 2026 — SPA-RETIRE 2: the two checks that could be retargeted before the modules go

`public/js/**` cannot be deleted in one step: six surviving checks use SPA modules as **fixtures** (the
pin table is in `AUTORUN-QUEUE.md`, measured to the line). Two of those pins are now gone, both by
retargeting rather than by weakening.

| Check | Leg(s) | Property | Decision | Replacement / change | Commit | Slice |
|---|---|---|---|---|---|---|
| `tools/owned-api-check.mjs` leg `content-seed-matches-the-client` | 1 leg, 26 assertions | the seeded writing prompts and rubric are the SAME content as the client module that originated them | **RETARGET** | renamed `content-seed-and-the-seeded-migration-agree`: it now compares the fixture module against **migration 0006**, the artifact that actually seeds the database. This is not self-comparison — two different files, written at different times — and it catches the failure that matters (the database serving one text while the test path exercises another). The comparison against `public/js/ai.js` is void with that module. Green: 27/27 memory | this commit | SPA-RETIRE 2 |
| `tools/design-check.mjs` | rules 1–5 (raw colour, raw face, required tokens, breakpoints, shell/nav pattern) | the design language is consistent: no raw colour in a rule, no un-tokenised face, the tokens exist, the breakpoints exist, one navigation pattern | **RETARGET** (subject changed) | it read `public/styles.css`, the retired client's stylesheet, so the stylesheet could not be deleted while the check lived — an implementation kept alive to feed a check, which this ledger forbids. It now reads the shell's own layer `public/app/app.css` against the pinned `hatoove.css`: D1 raw colour, D2 raw face, **D3 every `var(--token)` used is DEFINED** (silent by nature), D4 the pinned system supplies what the shell uses + still carries dark theme, D5 the shell uses the system's breakpoint, D6 every route has a `#view-*` element, D7 one navigation pattern with `aria-current`. `public/styles.css` is DELETED in the same commit. Discrimination measured, not assumed: D3 goes red when an undefined token is added, D6 goes red when a view id is renamed. 14 passed / 0 failed | this commit | SPA-RETIRE 2 |
| the old design check's form-language advisory | 1 advisory over `public/js/{guides,blueprint}.js` | the explanation-language setting does not translate exam content | **REPLACE** | void as written (both modules go with the SPA); the property now has a browser vehicle that can actually fail — `tools/app-browser-check.mjs` **L32** asserts every nav label is identical before and after a real language change | previous commit | SPA-RETIRE 1 |

**A REAL GAP FOUND BY THE RETARGET, not by reading:** the pinned design system transitions `.btn` in
150 ms and carries **no `prefers-reduced-motion` block at all**. The pinned file is read-only, so the
neutraliser now lives in `public/app/app.css` and D4c fails if it disappears.

### 2 October 2026 — the file-based progress store (PILOT-17a, the stage that fits)

`server.js` carried the single-user store: `PROGRESS_PATH`, a `.rev` marker beside it, an
`x-b1prep-account` HEADER as the account selector, and `/api/progress` GET/POST/DELETE with an atomic
write, a one-generation backup and a revision race guard — about 350 lines, removed in one commit. It was
attributed by a HEADER rather than a session and fell back to ONE SHARED record when the header was
absent, which is why hosted mode answered its own refusal code instead of serving it. A file store also
cannot exist where the filesystem is ephemeral (Ron, 2 October 2026: the operator's provider key comes
from `.env` or the platform's environment variables), so the removal is a portability fix as well.

**The negative check exists now:** `tools/retired-surface-check.mjs` — *"no `/api/progress` route, no
progress file opened"*, promised in this file twice and written at last. It was run BEFORE the removal and
was RED on the three legs that observe it, which is the discrimination this ledger demands. It needs no
database, no browser and no Docker, so it is a CI step on any runner, and it fails if the handler, the
refusal code, the file write, the server-side import or a client path to the store comes back.
`tools/docker-stack-check.mjs` asserts the half that needs a session: an AUTHENTICATED GET/POST/DELETE
`/api/progress` answers **404**, because the auth wrap makes an absent route indistinguishable from a
refused one to an anonymous caller.

| Check | Leg(s) | Property | Decision | Reason | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|---|
| `tools/progress-equal-check.mjs` (+ `.test.mjs`) | all 10 | `progressEqual` compares two progress blobs independent of key order | **DELETE** | its subject is the retired blob: the assertions drive `/api/progress` over HTTP and it went red the moment the route did (measured: 2 of 10 failed). The FUNCTION still exists for the browser-side legacy store and retires with the SPA | `tools/retired-surface-check.mjs` (`R1`–`R4`) for the route and the file; the blob's remaining life is the SPA removal | this commit | PILOT-17a |
| `tools/progress-scope-check.mjs` (+ `.test.mjs`) | all 7 | the blob store is account-scoped | **DELETE** | the store it scopes is gone (measured: 4 of 7 failed after the removal). The heading it belonged to — one learner's records must not reach another's — is now a SERVER property, held by RLS and the owned attempt routes, and a CLIENT property, held by the leg below | **client half:** `tools/app-browser-check.mjs` leg `L30 the client kept NOTHING in web storage across the whole journey` — stronger than the property it replaces: there is no client-side blob left to scope. **server half:** FORCE RLS in `owned-api-check.mjs` and `deletion-check.mjs`, already green | this commit | PILOT-17a |
| `tools/reset-check.mjs` (+ `.test.mjs`) | all 8, incl. the pre-fix discrimination | a delete really deletes, and a late write cannot resurrect it | **DELETE** | measured 6 of 8 failed after the route left. The owned equivalent was written FIRST, as this ledger requires | `tools/owned-api-check.mjs` leg `delete-is-a-tombstone`: delete → tombstone recorded → read, stale `saveDraft`, submit, read-result, retry, re-create and a second delete all answer 404; plus `tools/deletion-check.mjs` lines 359–368 (after account deletion the cookie is 401 and a repeated DELETE changes nothing) | this commit | PILOT-17a |
| `tools/revision-check.mjs` (+ `.test.mjs`) | all 8, incl. the pre-fix discrimination | a reset invalidates writes that left before it | **DELETE** | measured 6 of 8 failed after the route left; same owned replacement as the row above | as above | this commit | PILOT-17a |

**What kept its file on purpose.** `public/js/progress-merge.js` was NOT deleted here, and the check says
so in a NOTE leg rather than pretending: it is imported by the BROWSER-side legacy store
(`public/js/store.js`), which eleven checks still drive, so deleting it now would cascade through the SPA
removal instead of this slice. It has no server-side caller and no route; it goes with the SPA.

**Also changed in the same commit, because the route's absence is documented state:**
`docs/openapi.yaml` no longer documents `/api/progress` (a spec that names a deleted route is how one
comes back), and `tools/api-spec-check.mjs` now asserts its ABSENCE where it used to require its presence.

### 2 October 2026 — the four SPA browser checks, and the CI job that ran them

The **Rendered behaviour (headless Chrome)** job is deleted, not emptied. All four of its steps drove the
retired Certa client, whose page is no longer served at `/` (the front door is the brand site), so the job
could not have passed; and a job whose only remaining step is a checkout would report GREEN for having done
nothing — the failure mode this file already records once, one level up. Their properties did not vanish:
their vehicles did, and every one now has a named home. **Nothing in CI renders the client today** —
`tools/app-browser-check.mjs` needs Docker and a browser and is a developer-run gate; that trade is
recorded here rather than implied.

| Check | Leg(s) | Property | Decision | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|
| `tools/provider-config-browser-check.mjs` | 13 | the Settings view offers no provider field | **REPLACE** | `tools/app-browser-check.mjs` **L31** — enumerates the new settings screen's fields (exam date, explanation language) and its text against provider / key / model, so a field or a label that names one fails the leg. Green and discriminating: it fails if such a field is added | this commit | SPA-RETIRE |
| `tools/account-ui-browser-check.mjs` | 25 | the explanation-language setting does not translate the German menu (also: no learner state in web storage, theme handling) | **REPLACE** | **L32** — reads every nav label before and after a real change through the real form, requires them identical, requires the shell to stay `ltr` when Arabic is chosen, and requires the Arabic option to carry `lang`/`dir`. **L30** covers the web-storage half. L32 found a real defect while being written: the topbar kept saying "Erklärungen: Deutsch" after the change until a navigation, now fixed and asserted | this commit | SPA-RETIRE |
| `tools/session-boundary-browser-check.mjs` | 70 | a second tab cannot re-create the account record | **server half KEEP (new vehicle); client half DELETE (property void)** | **server:** `tools/deletion-check.mjs` — after account deletion the cookie is 401 on account and attempt reads and a repeated DELETE changes nothing (green). **client:** void, because the new client holds no client-side record at all — **L30** asserts exactly that | this commit | SPA-RETIRE |
| `tools/writing-surface-browser-check.mjs` | (a) an account draft restores; (b) the single-user path is untouched | (a) a saved draft comes back; (b) local mode is untouched | **(a) UNPROVEN; (b) DELETE** | (b) the single-user path is gone. **(a) has NO vehicle until the writing surface exists in the new client** — the same honest gap this file already records for MFP-08, and the reason `writing-surface-check.mjs` (node level) is KEPT for now: it holds the draft/revision contract at the API level, which is the half that can still be tested | this commit | SPA-RETIRE |

---

### Earlier retirements

DOCKER-ONLY-01 retires tools/local-bringup-check.mjs with tools/local-bringup.mjs. Its host process/container orchestration is removed, not counted as a pass. The persistent-server properties (migrations, restricted roles, seeded catalogue, idempotency, readiness, worker and account persistence) are retargeted to the isolated Compose acceptance recorded in DOCKER-ONLY-01.md. Full product-journey acceptance remains pending and is not claimed by a server bring-up test.


| Check | Leg(s) | Property | Decision | Reason | Replacement | Commit | Slice |
|---|---|---|---|---|---|---|---|
| `tools/mock-outcome-browser-check.mjs` (**CI step removed**) | `no-fabricated-score-when-unassessed` (P1), `submitted-text-stays-accessible` (P2), `no-pass-or-grade-band-claim` (P3), `no-horizontal-overflow` (P4) | **P1** — when the assessment is unavailable the writing shows as `unbewertet` and never a fabricated score. **P2** — submitted text stays accessible. **P3** — no "Bestanden?"/grade-band/readiness claim. **P4** — the mock layout does not scroll horizontally | **P1–P3 REPLACE; P4 DELETE** | The check spawns `node server.js` as a **local single-user** server (`mock-outcome-browser-check.mjs:115-126`, `B1PREP_PROGRESS_FILE`, no account configuration). The new direction **removes local single-user mode**, so the check cannot boot its server — this is the red `Rendered behaviour` job on PR #82. Keeping local mode alive to feed one check is exactly what the new direction ends | **P1–P3** → `tools/writing-result-browser-check.mjs` leg `failed-or-pending-assessment-renders-unassessed` (**slice MFP-08**, not yet written). **P4** → none; the mock view is deleted in MFP-11a | `MFP-00` (this row's commit) | MFP-00 |
| `tools/mock-outcome-check.mjs` (**KEPT**) | all 19, including discrimination against the pre-fix `exam.js` | `assessMockWriting` never fabricates a score | **KEEP** | It runs at the **node** level with no server and no browser, so removing local mode does not touch it. **It still guards P1–P3's logic** until the mock view itself is deleted | itself — CI step `Mock writing outcomes, discriminated against the pre-fix tree` (`.github/workflows/ci.yml` offline job) | — | — |
| **the remaining four browser checks** — `provider-config-browser-check`, `account-ui-browser-check`, `session-boundary-browser-check`, `writing-surface-browser-check` | all | various: Settings offers no provider field; the language setting does not translate the German menu; a second tab cannot re-create the account record; an account draft restores and local mode is untouched | **KEEP — see the correction below** | **CORRECTION, same day, by re-execution.** An earlier version of this row retired these four on the strength of a single CI failure of `provider-config-browser-check` and a probe showing they exercise the in-process single-user surface. **That conclusion was wrong and is withdrawn.** The probe's premise is right (`tools/coord-inprocess-surface-probe.mjs` does show `/api/ready` → `{ready:true, mode:"local"}`, `/api/config` → 200, `/api/v1/account` → 404), but the inference did not follow: **all four pass**, both locally on `2b0295e` (`provider-config-browser-check` → **13 passed, 0 failed**) and in CI, where the whole `Rendered behaviour` job is **green**. The single failure was a **flake on GitHub's runner**, and the honest reading is that the browser job is **fragile**, not that these checks are invalid. **A claim that four checks are invalid, made from one failure and a probe, is exactly the defect this ledger exists to prevent** — the same "code conditional, check unconditional" shape, one level up: **an inference unconditional in a record, drawn from evidence conditional on an environment.** They retire on the roadmap's schedule — MFP-07 (account-ui, provider-config), MFP-08 (writing-surface), MFP-11a (the rest) — with the negative check that matters being MFP-02b's `retired-surface-check`. **They stay in CI and stay gating until then** | themselves, until their scheduled slice | `MFP-00` (retired the row) / **`2b0295e` (withdrew it)** | MFP-00 |

### What we lose until MFP-08 lands, said plainly

**Rendered** evidence of P1–P3. The logic is still guarded by `mock-outcome-check.mjs` at the node level, but nothing
now proves that the *rendered* writing result refuses to show a fabricated score. That property is not abandoned —
it is **unproven between this commit and MFP-08**, and MFP-08 must write its replacement leg before the writing
result screen ships.

---

## Pending — identified, not yet executed

### MEASURED 2 October 2026: three of these are RED *now*, not "later"

`server-origin-check.mjs` (7 of 16), `keymask-check.mjs` (5 of 12) and `provider-config-check.mjs`
(7 of 11) all fail **on the committed tree**, and they fail for one reason: the auth wrap added to
`server.js` makes `/api/config` answer **401 `unauthenticated`** to an anonymous caller, while these
three still drive `/api/config` anonymously and expect 200/403. Verified against a clean worktree at
`HEAD` before this slice, with the SAME numbers, so this is not a regression from the file-store removal.

**CI shows only one of them.** The contracts job stops at `Same-origin guard on state-changing routes`, so
`keymask`, `provider-config`, `draft-session`, `owned-api` and `owned-client` are **SKIPPED** in the same
job and never report. The visible red is therefore smaller than the real red: a job that stops at its
first failure hides every step behind it. Read the step list, not the conclusion — `gh run view <id>
--json jobs | jq '.jobs[].steps[] | select(.conclusion=="failure" or .conclusion=="skipped")'`.

This makes the RETARGET rows below (server-origin, keymask, provider-config) the next repair after the SPA
removal, not a tidying task.

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
