# INTEG-R2 — Independent review of the corrected integration candidate @ `467247a`

- **Reviewer:** Clawdbot (local, this machine) — independent reviewer, **not** the author
- **Execution id:** `integ-r2-clawd-20260930-a`
- **Coordinator:** `COORD-TAKEOVER-20260930`
- **Candidate under review:** `origin/codex/integ-stack-02` = `467247a2a8f373e76f2108374918bfd44e6b3d74` (PR #35)
- **Baselines:** `origin/main` = `074aebf9697d9a2b047a59b993a3178d94f1fb9f`; PR #21 head = `2bcf749`
- **Superseded (rejected):** PR #33 `codex/integ-stack-01` @ `7f1ffd7`; **Rejection record:** PR #34
- **Mode:** read-only on the candidate; pure Node, offline; no browser, no server, no Postgres, no `.env`, no provider/live-AI call.

## Verdict

**ACCEPT-WITH-NOTES.**

The claim is **not falsified**. The candidate is a genuine two-parent three-way merge of PR #21 into current `main`. It adds **exactly 13 files, +6589, −0**, deletes nothing, and reverts nothing. All seven files clobbered by the earlier hand-built attempt are **byte-identical to `main`**. All runnable checks were re-executed on an extracted copy of `467247a` and **all pass: 134/134** across the three new suites, with the claimed per-suite split confirmed, plus the baseline project checks.

The notes below record precisely what "green" does and does not cover. This review verifies **structural integration integrity only** — not exam validity, content correctness, language quality, or security approval.

---

## Check 1 — Is anything silently reverted?

### 1a. The seven files the previous attempt clobbered — byte-identical to `main`?

Command (PowerShell, per file): compare `git rev-parse origin/main:<path>` vs `git rev-parse origin/codex/integ-stack-02:<path>`.

| File | blob on `main` | blob on candidate | Result |
| --- | --- | --- | --- |
| `spikes/auth-runtime/auth.mjs` | `defeb9e9…` | `defeb9e9…` | **IDENTICAL** |
| `spikes/auth-runtime/store.mjs` | `3cfee608…` | `3cfee608…` | **IDENTICAL** |
| `spikes/auth-runtime/server.mjs` | `e07a7dfa…` | `e07a7dfa…` | **IDENTICAL** |
| `spikes/auth-runtime/README.md` | `1f1f8080…` | `1f1f8080…` | **IDENTICAL** |
| `.github/workflows/pilot-contracts.yml` | `85fed400…` | `85fed400…` | **IDENTICAL** |
| `public/styles.css` | `41b0384d…` | `41b0384d…` | **IDENTICAL** |
| `public/studio.css` | `bd3cddb3…` | `bd3cddb3…` | **IDENTICAL** |

All seven are unchanged. **No revert of the PR #18 / PR #12 work.**

### 1b. Any other file that differs from `main`?

Command: `git diff --name-status origin/main origin/codex/integ-stack-02`

```
A  docs/assessment/FEEDBACK-CASES.md
A  docs/exam/LEGACY-GAP-MAP.md
A  docs/exam/TELC-B1-SOURCES.md
A  docs/exam/telc-b1-written-draft.json
A  docs/qa/DRAFT-RECOVERY-MATRIX.md
A  tests/fixtures/objective-marking-cases.json
A  tests/fixtures/writing-feedback-cases.json
A  tools/exam-blueprint-check.mjs
A  tools/exam-blueprint-check.test.mjs
A  tools/feedback-case-check.mjs
A  tools/feedback-case-check.test.mjs
A  tools/objective-fixture-check.mjs
A  tools/objective-fixture-check.test.mjs
```

Every entry is status `A` (added). There is **no** `M`, `D`, `R`, or `T` entry. Therefore no pre-existing file differs from `main` in any direction — there is no file that the merge "did not plausibly need to touch" and no file changed toward an older state. **Falsification attempt: failed; the merge is clean.**

## Check 2 — Is it a genuine merge?

- `git rev-list --parents -n 1 origin/codex/integ-stack-02` →
  `467247a… 074aebf9697d9a2b047a59b993a3178d94f1fb9f 2bcf7490b3459c0501db854d4fe2591007f531bf`
  → a **real merge commit with two parents**: `main` (`074aebf`) and PR #21's head (`2bcf749`). Not a fabricated single-parent commit.
- `git merge-base --is-ancestor origin/main origin/codex/integ-stack-02` → exit 0 → **main is an ancestor** (full main history present).
- `git merge-base --is-ancestor 2bcf749 origin/codex/integ-stack-02` → exit 0 → **PR #21's history is present**.
- Reachable merge commits include `a9ed166 Merge pull request #20` (c01-discovery), `a58f6fb Merge pull request #18` (f02-a01-local-isolation), and `bb30267 Merge pull request #12` (pilot-01-css-user02). PR #18, #20 and #12 are all in the candidate's ancestry.

A genuine three-way merge, consistent with the coordinator's description.

## Check 3 — Deletions and stated diff size

- `git diff --diff-filter=D --name-only origin/main origin/codex/integ-stack-02` → **empty** (no deletions).
- `git diff --stat origin/main origin/codex/integ-stack-02` → `13 files changed, 6589 insertions(+)`.

Stated `13 files, +6589, −0` **verified exactly**.

## Check 4 — Is the work of PR #17 / #21 present in PR #21's exact form?

Command: `git diff --name-status origin/codex/integ-stack-02 2bcf749 -- <the 13 paths>` → **empty output**.

All 13 files are **byte-identical to PR #21's head `2bcf749`**. The merge did not quietly substitute a different version of any of them. (PR #17 work is incorporated through PR #21's branch; the add-set matches PR #21 unchanged.)

## Check 5 — Re-run on an extracted copy of `467247a` — ACTUAL counts

Extraction: `git archive --format=tar -o cand-467247a.tar 467247a… && tar -xf … -C integ-review-scratch`. Node `v24.4.1`. `package.json` has **no dependencies** (`"dependencies": {}`), so no install is needed and the run is fully offline.

### New suites (`node --test`)

| Suite | Command | tests | pass | fail |
| --- | --- | --- | --- | --- |
| exam-blueprint | `node --test tools/exam-blueprint-check.test.mjs` | **52** | 52 | 0 |
| feedback-case | `node --test tools/feedback-case-check.test.mjs` | **43** | 43 | 0 |
| objective-fixture | `node --test tools/objective-fixture-check.test.mjs` | **39** | 39 | 0 |
| **Total** | | **134** | **134** | **0** |

**Independent actual count: 134/134 (52 + 43 + 39).** The per-suite split the coordinator quoted is **correct** — no wrong split here.

### Tool self-checks (all exit 0)

- `node tools/exam-blueprint-check.mjs` → `sections=4 parts=9 items=61 objectiveItems=1-60 writtenPoints=225 minutes=150`, `OK blueprint is internally consistent (0 warning(s))`.
- `node tools/feedback-case-check.mjs` → `cases=21 scenarios=19/19 invariantsUsed=38 … OK fixtures are structurally sound (6 warning(s))` (6 warnings are the tool's own known-conditional/duplicate-scenario advisories, not failures).
- `node tools/objective-fixture-check.mjs` → `families=8 cases=36 scenarios=14 objectiveItems=1-60 objectivePoints=180`, `OK fixtures are structurally sound (0 warning(s))`.

### Baseline project checks — re-verified

| Command | Result | Count |
| --- | --- | --- |
| `node tools/check.js` | `101 passed, 0 failed` | **101** |
| `node tools/writing-check.js` | `9 passed, 0 failed` | **9** |
| `node tools/feedback-check.js` | `14 passed, 0 failed` | **14** |
| `node tools/content-discovery.mjs` | exit 0 (runs; see note) | — |

Baseline claim `101 + 9 + 14` **verified exactly** (101 + 9 + 14 = 124).

> **Note on `content-discovery.mjs`:** it runs to completion and exits 0. In the extracted scratch dir it is *not* a git work tree, so its `git ls-files -z` inventory reports `0 tracked files` (an empty inventory) — this is a property of the scratch extraction, not of the candidate. The meaningful, offline-verifiable result is that the script **executes without error** on `467247a`'s copy (PR #20's tooling is intact). A full inventory would require running it inside the git work tree.

## Check 6 — State plainly what green does NOT prove

**None of the three new suites exercise the auth spike, the CSS, or the CI workflow.** Specifically:

- The 134 new tests and the tool self-checks read only `docs/**`, `tests/fixtures/**` and `tools/**` (data/fixture/blueprint consistency). They do **not** import, load, or touch `spikes/auth-runtime/*`, `public/*.css`, or `.github/workflows/*`.
- The seven files verified byte-identical to `main` in Check 1 are verified by **git object identity only** — the green suites would stay green even if those files had been clobbered, exactly as happened in PR #33. Green here is **not** coverage of those areas.
- Therefore, for the auth spike, CSS and CI workflow, the only assurance this review provides is **byte-identity to `main`** (Check 1), which is the relevant guarantee given the failure mode.

### Auth-spike isolation test (`spikes/auth-runtime/isolation.test.mjs`) — static note

Not executed (needs a live Postgres on `:55435` plus `better-auth`/`pg`; out of scope per the task). Static inspection: the test imports `{isolatedFixture}` (isolation-fixture.mjs), `{store}` (store.mjs), `{start}` (server.mjs), `{localPool}` (auth.mjs) — **all four exist in the kept code**, and every method it uses is present (`f.admin/auth/learner/worker/migration`, `f.roles`, `f.schema`, `f.cleanup`; `api.records.claim/complete/failJob`, `api.close`; `store(...).read/save/create/submit/retry/remove`). Crucially, `isolation.test.mjs` and the four source files it exercises are **all unchanged from `main`** (they are not among the 13 additions), so the test still targets exactly the code it was authored against. **Mutual consistency with the candidate is verifiable statically; whether the suite passes is not — that requires the database and was not attempted.**

## Falsification summary (the specific thing I tried to break)

Hypothesis: *the merge silently reverts files while tests stay green, as in PR #33.*

- Seven known-clobbered files → **still `main`'s bytes.** ✗ reverted
- Full `name-status` diff → **13 adds, nothing else, no deletes/modifies/renames.** ✗ reverted
- Any file changed toward an older state → **none exists** (no `M`/`D`/`R`/`T` entries at all). ✗
- Version substitution of the added files vs PR #21 → **byte-identical.** ✗
- Fabricated single-parent commit → **two real parents, main + PR21, both ancestors.** ✗

The hypothesis is falsified; the candidate does not repeat the PR #33 failure mode.

---

## Bottom line

**ACCEPT-WITH-NOTES.** Genuine merge; 13 files added; +6589/−0; zero deletions; no reverts; added files identical to PR #21; **134/134** new tests pass (52 + 43 + 39); baseline **101 + 9 + 14** pass; `content-discovery.mjs` runs. The notes record that green does **not** cover the auth spike, the CSS, or the CI workflow — those are assured only by byte-identity to `main`, which was verified.

*Structural integration integrity only. Not exam validity, content correctness, language quality, or security approval.*
